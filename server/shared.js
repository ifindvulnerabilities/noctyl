// Shared providers (Settings → Server → Shared providers): an admin lets other accounts use one of their providers —
// a cloud provider with its API key, a custom provider, a llama.cpp server or Ollama — without ever giving them the key.
// Local servers without a key get a stand-in too: every request then goes through the checks below (who may use it,
// which models, the daily message limit), and the address alone gets nobody in.
//
//   <data>/server.key    the server's own key (random, made once); only shared providers use it
//   <data>/shared.bin    the shared providers and their keys, encrypted with server.key
//
// Why a server key: an account's own keys are locked with its password (crypto.js), but a shared key has to work while
// its admin is signed out, so it's kept under the server's key instead. Whoever controls the server's disk could read
// shared keys (not anyone's own keys or chats); share only keys you'd trust that server with.
//
// Accounts never get a shared key. They get stand-ins ("noctyl-shared:<id>.key", "…h0" for extra header values) and
// the server swaps in the real value for a request only when:
//   - the account is allowed (everyone, or the accounts the admin chose), and the share is on
//   - the request goes to the provider's own host, to a model endpoint (chat, messages, completions, responses,
//     embeddings, model lists) — never its account, billing or key-management APIs
//   - the model is one the admin allowed (if they limited it), and the account is under its daily request limit
// When the admin changes or removes the provider in their own settings, the share follows (or turns off).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./crypto');

const STAND_INS = /noctyl-shared:(shared-[a-z0-9]{6,24})\.(key|h\d{1,2})/g;
const MODEL_PATH = /\/(chat\/completions|completions|messages(\/count_tokens)?|responses|embeddings|models(\/[^/?]+)?|api\/(chat|generate|embed|embeddings|tags|show))\/?$/i;
const hostOf = u => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.host.toLowerCase() : ''; } catch { return ''; } };

class Shared {
  constructor(dataDir) {
    const keyFile = path.join(dataDir, 'server.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(keyFile);
    this.file = path.join(dataDir, 'shared.bin');
    try { this.entries = JSON.parse(C.open(this.key, fs.readFileSync(this.file)).toString('utf8')); } catch { this.entries = []; }
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, C.seal(this.key, Buffer.from(JSON.stringify(this.entries))), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  find(id) { return this.entries.find(e => e.id === id) || null; }
  /** may this account use it? everyone, chosen accounts, members of chosen workspaces, or of the project it was shared with
      (this.collab is set by index.js: it knows workspaces and projects) */
  allowed(e, user) {
    if (!e || !e.enabled) return false;
    if (e.users === 'all' || (Array.isArray(e.users) && e.users.includes(user.id))) return true;
    if ((e.workspaces || []).some(w => this.collab?.isMember(w, user.id))) return true;
    return (e.projects || []).some(p => this.collab?.canOpenProject(this.collab.projectRow(p), user));
  }

  /** What an account sees: providers it may use, with stand-ins instead of keys (the client treats them as custom providers). */
  forUser(user, nameOf) {
    return this.entries.filter(e => this.allowed(e, user)).map(e => ({
      id: e.id, name: e.name, format: e.format, baseUrl: e.baseUrl, authHeader: e.authHeader || '', llama: !!e.llama,
      key: `noctyl-shared:${e.id}.key`,   // always (even without a real key): it's what lets a request through, and counts it
      headers: (e.headerNames || []).map((n, i) => `${n}: noctyl-shared:${e.id}.h${i}`).join('\n'),
      models: (e.models || []).join('\n'), limitPerDay: e.limitPerDay || 0, sharedBy: nameOf(e.ownerId), project: (e.projects || [])[0] || '',
    }));
  }
  /** What admins see: everything but the key. */
  forAdmin(nameOf) {
    return this.entries.map(({ secrets, ...e }) => ({ ...e, owner: nameOf(e.ownerId), users: e.users === 'all' ? 'all' : e.users.map(nameOf), workspaces: e.workspaces || [], projects: e.projects || [], hasKey: !!secrets.key }));
  }

  /**
   * Read one of the admin's own providers out of their settings and vault (decrypted with their key).
   * source: 'providers.<id>' | 'customEndpoints.<id>' | 'llamaCppServers.<id>' | 'ollama'; catalog: { format, baseUrl } for catalog
   * providers (for Ollama: the address the app uses, when the settings still have the default one).
   * → { name, format, baseUrl, authHeader, llama, secrets, headerNames } or null when it's gone
   */
  static extract(source, settings, vault, catalog = {}) {
    const [kind, id] = String(source).split(/\.(.+)/);
    const secretOf = v => { const m = /^noctyl-secret:([a-f0-9]{32})$/.exec(String(v || '').trim()); return m ? vault[m[1]]?.value || '' : ''; };
    if (kind === 'providers') {
      const c = settings.providers?.[id];
      const baseUrl = String(c?.baseUrl || catalog.baseUrl || '').replace(/\/+$/, '');
      if (!c || !secretOf(c.key) || !hostOf(baseUrl)) return null;
      return { format: catalog.format === 'anthropic' ? 'anthropic' : 'openai', baseUrl, authHeader: '', llama: false, secrets: { key: secretOf(c.key) }, headerNames: [] };
    }
    if (kind === 'customEndpoints') {
      const e = (settings.customEndpoints || []).find(x => x?.id === id);
      if (!e || !hostOf(e.baseUrl)) return null;
      const secrets = { key: secretOf(e.key) }, headerNames = [];
      String(e.headers || '').split(/\r?\n/).forEach(line => {
        const i = line.indexOf(':');
        if (i < 1) return;
        const value = line.slice(i + 1).trim();
        secrets['h' + headerNames.length] = secretOf(value) || value;
        headerNames.push(line.slice(0, i).trim());
      });
      return { format: e.format === 'anthropic' ? 'anthropic' : 'openai', baseUrl: String(e.baseUrl).replace(/\/+$/, ''), authHeader: e.authHeader || '', llama: false, secrets, headerNames };
    }
    if (kind === 'ollama') {
      // its OpenAI-compatible API (/v1): chat, model list; Ollama itself has no key
      const own = String(settings.ollamaUrl || '').trim();
      const stock = !own || /^https?:\/\/(localhost|127\.0\.0\.1):11434\/?$/i.test(own);
      const base = String(stock && catalog.baseUrl ? catalog.baseUrl : own || 'http://127.0.0.1:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
      if (!hostOf(base)) return null;
      return { format: 'openai', baseUrl: base + '/v1', authHeader: '', llama: false, ollama: true, secrets: { key: '' }, headerNames: [] };
    }
    if (kind === 'llamaCppServers') {
      const l = (settings.llamaCppServers || []).find(x => x?.id === id);
      if (!l || !hostOf(l.url)) return null;
      return { format: 'openai', baseUrl: String(l.url).replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1', authHeader: '', llama: true, secrets: { key: secretOf(l.key) }, headerNames: [] };
    }
    return null;
  }

  add(owner, source, found, opts) {
    const e = {
      id: 'shared-' + crypto.randomBytes(6).toString('hex'), ownerId: owner.id, source, name: String(opts.name || 'Shared provider').slice(0, 40),
      ...found, host: hostOf(found.baseUrl), users: opts.users, workspaces: opts.workspaces || [], projects: opts.projects || [], models: opts.models || [], limitPerDay: opts.limitPerDay || 0, enabled: true, created: Date.now(),
    };
    this.entries.push(e);
    this.save();
    return e;
  }
  /** After an admin saves their settings: their shares follow the provider (new key, new address), or turn off if it's gone. */
  syncOwner(owner, settings, vault, catalogs) {
    let changed = false;
    for (const e of this.entries.filter(x => x.ownerId === owner.id)) {
      const found = Shared.extract(e.source, settings, vault, catalogs?.[e.source] || { format: e.format, baseUrl: e.baseUrl });
      if (!found) { if (e.enabled) { e.enabled = false; e.note = 'Turned off: the provider was removed from its owner\'s settings.'; changed = true; } continue; }
      const next = { ...found, host: hostOf(found.baseUrl) };
      if (JSON.stringify([e.baseUrl, e.format, e.authHeader, e.secrets, e.headerNames]) !== JSON.stringify([next.baseUrl, next.format, next.authHeader, next.secrets, next.headerNames])) {
        Object.assign(e, next); changed = true;
      }
    }
    if (changed) this.save();
  }
  forgetUser(userId) {
    const before = JSON.stringify(this.entries);
    this.entries = this.entries.filter(e => e.ownerId !== userId);
    for (const e of this.entries) if (Array.isArray(e.users)) e.users = e.users.filter(u => u !== userId);
    if (JSON.stringify(this.entries) !== before) this.save();
  }

  /**
   * Swap shared stand-ins in a request for the real values, after checking every rule above.
   * → { url, headers, body, sharedId } ; throws { status: 403 } with a plain explanation when a rule says no.
   */
  unseal(user, url, headers, body, stats) {
    const text = [url, ...Object.values(headers), body || ''].join('\n');
    if (!text.includes('noctyl-shared:')) return { url, headers, body, sharedId: null };
    const ids = new Set([...text.matchAll(STAND_INS)].map(m => m[1]));
    if (ids.size !== 1) throw deny('A request can use one shared provider at a time.');
    const [id] = ids, e = this.find(id);
    if (!this.allowed(e, user)) throw deny("That shared provider isn't available to your account anymore.");
    let target; try { target = new URL(url); } catch { throw deny('Invalid address'); }
    if (target.host.toLowerCase() !== e.host) throw deny(`The shared provider "${e.name}" can only be used with ${e.host}.`);
    if (!MODEL_PATH.test(target.pathname)) throw deny(`The shared provider "${e.name}" can only be used for models (chat and model lists), not ${target.pathname}.`);
    if (e.models?.length && body) {
      let model = null; try { model = JSON.parse(body)?.model; } catch { /* not JSON: no model to check */ }
      if (model != null && !e.models.includes(String(model))) throw deny(`The shared provider "${e.name}" only allows ${e.models.join(', ')}.`);
    }
    const isChat = body && !/\/models/.test(target.pathname);
    if (isChat && e.limitPerDay && stats.sharedToday(user.id, e.id) >= e.limitPerDay) throw deny(`You've used "${e.name}" ${e.limitPerDay} times today, its daily limit. It resets at midnight (server time).`);
    const swap = s => String(s).replace(STAND_INS, (m, _id, part) => e.secrets[part] ?? '');
    // a local server shared without a key: its stand-in leaves an empty header behind, which is dropped
    const sent = Object.entries(headers).map(([k, v]) => [k, swap(v)]).filter(([, v]) => !/^\s*(bearer)?\s*$/i.test(v));
    return { url: swap(url), headers: Object.fromEntries(sent), body: body == null ? body : swap(body), sharedId: e.id };
  }
}
const deny = msg => Object.assign(new Error(msg), { status: 403 });

module.exports = { Shared, MODEL_PATH };
