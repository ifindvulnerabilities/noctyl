// One account's data on the Noctyl server, every file encrypted with the account's data key (see crypto.js).
//
//   users/<id>/store.bin         settings and view preferences
//   users/<id>/vault.bin         the account's API keys and tokens
//   users/<id>/chats/<id>.bin    one file per chat
//   users/<id>/images/<id>.bin   one file per image (attached or generated)
//
// API keys never go to the browser. When settings are saved, every key (provider keys, custom provider keys and extra
// header values, llama.cpp keys, MCP tokens, Brave / Tavily keys, the embedding key) moves into the vault and the
// settings keep a stand-in, "noctyl-secret:<id>". Each key is tied to the address it was saved with (the provider's
// host). When the app makes a request through the server, a stand-in is swapped for the real key only if the request
// goes to that same host; anything else is refused. Changing a provider's address drops its key (enter it again), so
// a key can't be redirected somewhere else.
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./crypto');

const STAND_IN = /^noctyl-secret:([a-f0-9]{32})$/;
const STAND_INS = /noctyl-secret:([a-f0-9]{32})/g;
const SAFE_ID = /^[\w-]{1,80}$/;
const fileFor = id => (SAFE_ID.test(String(id)) ? String(id) : 'x' + C.hash(id).slice(0, 40)) + '.bin';
const hostOf = u => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.host.toLowerCase() : ''; } catch { return ''; } };

class UserData {
  constructor(dir, key) { this.dir = dir; this.key = key; }
  file(...p) { return path.join(this.dir, ...p); }
  async read(file, fallback) {
    try { return JSON.parse(C.open(this.key, await fsp.readFile(file)).toString('utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Couldn't read ${path.basename(file)} (wrong key or damaged file)`); }
  }
  async write(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, C.seal(this.key, Buffer.from(JSON.stringify(value))), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  /** Everything the app loads at start. Settings carry stand-ins instead of keys. */
  async load() {
    const store = await this.read(this.file('store.bin'), { settings: {}, ui: {} });
    const chats = [];
    let names = [];
    try { names = await fsp.readdir(this.file('chats')); } catch { /* none yet */ }
    for (const n of names.filter(x => x.endsWith('.bin'))) {
      try { const c = await this.read(this.file('chats', n), null); if (c && typeof c === 'object') chats.push(c); } catch { /* skip a damaged chat */ }
    }
    chats.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return { settings: store.settings || {}, ui: store.ui || {}, chats };
  }

  /** Save what changed: { settings?, ui?, chats: [changed chats], deleted: [ids of chats deleted], providerHosts? } → { dropped }
      (older apps send chatIds, every chat id, instead of deleted: anything not in it is removed) */
  async save(p) {
    let dropped = [];
    if (p.settings || p.ui) {
      const store = await this.read(this.file('store.bin'), { settings: {}, ui: {} });
      if (p.settings && typeof p.settings === 'object') {
        const vault = await this.read(this.file('vault.bin'), {});
        dropped = vaultSecrets(p.settings, p.providerHosts || {}, vault);
        await this.write(this.file('vault.bin'), vault);
        store.settings = p.settings;
      }
      if (p.ui && typeof p.ui === 'object') store.ui = p.ui;
      await this.write(this.file('store.bin'), store);
    }
    for (const c of Array.isArray(p.chats) ? p.chats : []) if (c && c.id) await this.write(this.file('chats', fileFor(c.id)), c);
    if (Array.isArray(p.deleted)) {
      // only the chats this device deleted: one with an older list can't remove chats another device just made
      for (const id of p.deleted) if (/^[\w-]{1,80}$/.test(String(id))) await fsp.rm(this.file('chats', fileFor(String(id))), { force: true });
    } else if (Array.isArray(p.chatIds)) {
      const keep = new Set(p.chatIds.map(fileFor));
      let names = [];
      try { names = await fsp.readdir(this.file('chats')); } catch { /* none */ }
      for (const n of names) if (n.endsWith('.bin') && !keep.has(n)) await fsp.rm(this.file('chats', n), { force: true });
    }
    return { dropped };
  }

  /** Swap stand-ins in an outgoing request for the real keys — only for the host each key belongs to. */
  async unseal(url, headers, body) {
    const text = [url, ...Object.values(headers), body || ''].join('\n');
    if (!text.includes('noctyl-secret:')) return { url, headers, body };
    const vault = await this.read(this.file('vault.bin'), {});
    const host = hostOf(url);
    const swap = s => String(s).replace(STAND_INS, (m, id) => {
      const e = vault[id];
      if (!e) throw Object.assign(new Error('An API key for this request was removed. Enter it again in Settings.'), { status: 403 });
      if (e.host !== host) throw Object.assign(new Error(`That key belongs to ${e.host} and can't be sent to ${host || 'that address'}.`), { status: 403 });
      return e.value;
    });
    return { url: swap(url), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, swap(v)])), body: body == null ? body : swap(body) };
  }

  /** settings and the decrypted vault (for sharing one of this account's providers; the caller never sends it out) */
  async secretsView() {
    const store = await this.read(this.file('store.bin'), { settings: {} });
    return { settings: store.settings || {}, vault: await this.read(this.file('vault.bin'), {}) };
  }
  /** disk used and number of chats (Settings → Server → Users) */
  async footprint() {
    let bytes = 0, chats = 0;
    const walk = async d => {
      let list = [];
      try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else { try { bytes += (await fsp.stat(p)).size; } catch { /* gone */ } if (path.basename(d) === 'chats' && e.name.endsWith('.bin')) chats++; }
      }
    };
    await walk(this.dir);
    return { bytes, chats };
  }

  async putImage(id, rec) { await this.write(this.file('images', fileFor(id)), rec); }
  async getImage(id) { return this.read(this.file('images', fileFor(id)), null); }
  async imageKeys() {
    try { return (await fsp.readdir(this.file('images'))).filter(n => n.endsWith('.bin')).map(n => n.slice(0, -4)); } catch { return []; }
  }
  async delImages(ids) { for (const id of ids) await fsp.rm(this.file('images', fileFor(id)), { force: true }); }
  async clearImages() { await fsp.rm(this.file('images'), { recursive: true, force: true }); }
  /** "Erase all data": the account stays, everything in it goes */
  async erase() {
    for (const n of ['store.bin', 'vault.bin']) await fsp.rm(this.file(n), { force: true });
    for (const d of ['chats', 'images']) await fsp.rm(this.file(d), { recursive: true, force: true });
  }
}

/** Move keys out of settings into the vault (in place). Returns the setting paths whose key was dropped. */
function vaultSecrets(s, providerHosts, vault) {
  const used = new Set(), dropped = [];
  const keep = (where, value, url, set) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const host = hostOf(url);
    const m = STAND_IN.exec(value.trim());
    if (m) {
      // a stand-in stays valid only while its setting still points at the host the key was saved for
      if (vault[m[1]] && host && vault[m[1]].host === host) { used.add(m[1]); return; }
      set(''); dropped.push(where); return;
    }
    if (!host) { set(''); dropped.push(where); return; }   // a key with no valid address to go to isn't kept
    const id = crypto.randomBytes(16).toString('hex');
    vault[id] = { value, host };
    used.add(id);
    set('noctyl-secret:' + id);
  };
  const field = (where, obj, k, url) => keep(where, obj[k], url, v => { obj[k] = v; });
  if (s.providers && typeof s.providers === 'object') {
    for (const [id, c] of Object.entries(s.providers)) if (c && typeof c === 'object') field(`providers.${id}.key`, c, 'key', c.baseUrl || providerHosts[id] || '');
  }
  for (const e of Array.isArray(s.customEndpoints) ? s.customEndpoints : []) {
    if (!e || typeof e !== 'object') continue;
    field(`customEndpoints.${e.id}.key`, e, 'key', e.baseUrl);
    // extra headers: each value is kept like a key
    if (typeof e.headers === 'string' && e.headers.trim()) {
      e.headers = e.headers.split(/\r?\n/).map(line => {
        const i = line.indexOf(':');
        if (i < 1) return line;
        let v = line.slice(i + 1).trim();
        keep(`customEndpoints.${e.id}.headers`, v, e.baseUrl, nv => { v = nv; });
        return v ? `${line.slice(0, i).trim()}: ${v}` : '';
      }).filter(Boolean).join('\n');
    }
  }
  for (const l of Array.isArray(s.llamaCppServers) ? s.llamaCppServers : []) if (l && typeof l === 'object') field(`llamaCppServers.${l.id}.key`, l, 'key', l.url);
  for (const m of Array.isArray(s.mcpServers) ? s.mcpServers : []) if (m && typeof m === 'object') field(`mcpServers.${m.id}.token`, m, 'token', m.url);
  field('braveKey', s, 'braveKey', 'https://api.search.brave.com');
  field('tavilyKey', s, 'tavilyKey', 'https://api.tavily.com');
  field('ragEmbedKey', s, 'ragEmbedKey', s.ragEmbedUrl);
  for (const id of Object.keys(vault)) if (!used.has(id)) delete vault[id];
  return dropped;
}

module.exports = { UserData, vaultSecrets, hostOf };
