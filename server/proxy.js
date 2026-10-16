// /api/net: the app's requests to model servers, providers and web pages, made by the server for a signed-in account.
//
// - API key stand-ins are swapped for the real keys here (userdata.js unseal), only for the host each key belongs to.
// - Addresses on the server's own computer or network (Ollama, llama.cpp, ComfyUI, routers, other machines) are only
//   reachable for accounts allowed by config.privateNetwork, plus the hosts in config.sharedHosts. Cloud metadata and
//   other link-local addresses are never reachable. The check runs on the address actually connected to (also after
//   every redirect), so a name that resolves to an internal address can't sneak past it.
// - The answer streams straight back (status, content type, body), so replies type out as they arrive.
'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { usageOf } = require('./stats');
const safeHostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };

const MAX_BODY = 25 * 1024 * 1024;
const DROP_REQ = /^(host|origin|referer|cookie|cookie2|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|accept-encoding|x-forwarded-.*|forwarded|x-real-ip)$/i;
const PASS_RES = /^(content-type|retry-after|x-ratelimit-.*|ratelimit-.*|x-request-id|openai-.*|anthropic-.*|request-id)$/i;

/** 'blocked' (never), 'private' (this computer / its network), or 'public' */
function classify(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || (a === 169 && b === 254) || a >= 224 || ip === '100.100.100.200') return 'blocked';   // this-network, link-local (cloud metadata), multicast/reserved
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  const x = ip.toLowerCase();
  // IPv6 forms that carry an IPv4 address (mapped ::ffff:a.b.c.d or ::ffff:a9fe:a9fe, compatible ::a.b.c.d, NAT64 64:ff9b::):
  // judged by that IPv4 address, so 169.254.169.254 can't be reached as [::ffff:a9fe:a9fe]
  const embedded = /^(?:::ffff:(?:0:)?|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
  if (embedded) { const hi = parseInt(embedded[1], 16), lo = parseInt(embedded[2], 16); return classify(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  const dotted = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (dotted) return classify(dotted[1]);
  if (x === '::' || /^fe[89ab]/.test(x) || x.startsWith('ff') || x === 'fd00:ec2::254') return 'blocked';
  if (x === '::1' || /^f[cd]/.test(x)) return 'private';
  return 'public';
}

class ProxyError extends Error { constructor(msg, status = 403) { super(msg); this.status = status; } }

/** dns lookup that refuses addresses this account may not reach (used for the actual connection) */
function guardedLookup(mayReachPrivate, hostLabel) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true, family: options?.family || 0 }, (err, list) => {
      if (err) return cb(err);
      const ok = [];
      for (const a of list) {
        const kind = classify(a.address);
        if (kind === 'blocked') return cb(new ProxyError(`${hostLabel} is an address Noctyl never connects to.`));
        if (kind === 'private' && !mayReachPrivate) return cb(new ProxyError(`Your account can't reach ${hostLabel}: it's on the server's own network. Ask an admin to allow it (Settings → Account → Server).`));
        ok.push(a);
      }
      if (!ok.length) return cb(new ProxyError(`Couldn't find ${hostLabel}.`, 502));
      if (options?.all) cb(null, ok); else cb(null, ok[0].address, ok[0].family);
    });
  };
}

/**
 * Make the request and stream the answer into `res`.
 * ctx: { userData, user, config, signal }
 */
async function proxy(reqBody, res, ctx) {
  let { url, method = 'GET', headers = {}, body } = reqBody || {};
  method = String(method).toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) throw new ProxyError('Method not allowed', 400);
  if (body != null && typeof body !== 'string') throw new ProxyError('Bad request body', 400);
  if (body && Buffer.byteLength(body) > MAX_BODY) throw new ProxyError('Request too large', 413);
  const clean = {};
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) if (typeof v === 'string' && !DROP_REQ.test(k) && /^[\w-]{1,100}$/.test(k)) clean[k] = v;
  const sealedNames = Object.keys(clean).filter(k => /noctyl-(secret|shared):/.test(clean[k]) || /^(authorization|x-api-key|api-key)$/i.test(k));
  // which model this is for, and whether it's a model request at all (for the usage numbers)
  let model = null; try { model = body ? JSON.parse(body)?.model ?? null : null; } catch { /* not JSON */ }
  const isModelCall = method === 'POST' && /\/(chat\/completions|completions|messages|responses|api\/chat|api\/generate)\/?$/i.test((() => { try { return new URL(String(url)).pathname; } catch { return ''; } })());
  // shared providers first (their rules and the server's key; shared.js), then the account's own keys (userdata.js)
  let sharedId = null;
  const bodySealed = /noctyl-(secret|shared):/.test(body || '');   // a key inside the body never follows a redirect elsewhere
  ({ url, headers, body, sharedId } = ctx.shared.unseal(ctx.user, String(url || ''), clean, body, ctx.stats));
  ({ url, headers, body } = await ctx.userData.unseal(url, headers, body));
  const record = (ok, text = '') => { if (isModelCall) ctx.stats.request(ctx.user.id, { host: safeHostOf(url), model, ok, shared: sharedId, ...usageOf(text) }); };

  for (let hop = 0; hop < 6; hop++) {
    let target;
    try { target = new URL(url); } catch { throw new ProxyError('Invalid address', 400); }
    if (!/^https?:$/.test(target.protocol)) throw new ProxyError('Only http(s) addresses', 400);
    const hostKey = target.host.toLowerCase();
    // reachable: the server's shared addresses, and a shared provider's own host (sharing it is the admin's say-so)
    // (the server's own Ollama, when it's on another device, counts as shared: the admin chose it for everyone)
    const ollamaHost = (() => { try { return ctx.config.ollamaUrl ? new URL(ctx.config.ollamaUrl).host.toLowerCase() : ''; } catch { return ''; } })();
    const shared = (ctx.config.sharedHosts || []).map(s => String(s).toLowerCase()).includes(hostKey) || (!!ollamaHost && hostKey === ollamaHost) || (!!sharedId && ctx.shared.find(sharedId)?.host === hostKey);
    const pn = ctx.config.privateNetwork;
    const mayReachPrivate = shared || pn === 'everyone' || (pn === 'admins' && ctx.user.admin);
    // a literal IP address is checked here too (the lookup isn't called for those)
    const bare = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) {
      const kind = classify(bare);
      if (kind === 'blocked') throw new ProxyError(`${target.host} is an address Noctyl never connects to.`);
      if (kind === 'private' && !mayReachPrivate) throw new ProxyError(`Your account can't reach ${target.host}: it's on the server's own network. Ask an admin to allow it (Settings → Account → Server).`);
    }
    const lib = target.protocol === 'https:' ? https : http;
    const attempt = () => new Promise((resolve, reject) => {
      const r = lib.request(target, {
        method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
        lookup: guardedLookup(mayReachPrivate, target.host), timeout: 30000, signal: ctx.signal,
        agent: false,   // a fresh connection each time: accounts never share one
      }, resolve);
      r.on('timeout', () => r.destroy(new ProxyError(`${target.host} didn't answer`, 504)));
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
    // connecting can fail now and then (a busy local server, a flaky network): try again, up to twice — only when the
    // connection itself failed, so nothing was sent and a request (say, a message to a model) never goes out twice
    let upstream;
    for (let tries = 0; ; tries++) {
      try { upstream = await attempt(); break; }
      catch (e) {
        if (tries >= 2 || ctx.signal?.aborted || e instanceof ProxyError || e.syscall !== 'connect' || !['ETIMEDOUT', 'ECONNRESET', 'EADDRNOTAVAIL'].includes(e.code)) { if (!ctx.signal?.aborted) record(false); throw e; }
        await new Promise(r => setTimeout(r, 150 * (tries + 1)));
      }
    }
    // follow redirects ourselves, so every hop is checked; keys never follow a redirect to another host
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      upstream.resume();
      const next = new URL(upstream.headers.location, url);
      if (next.host.toLowerCase() !== hostKey) {
        for (const k of sealedNames) delete headers[k];
        if (bodySealed && [307, 308].includes(upstream.statusCode)) throw new ProxyError(`${target.host} redirected a request carrying a key to ${next.host}; Noctyl didn't follow it.`, 502);
      }
      if (upstream.statusCode === 303 || ((upstream.statusCode === 301 || upstream.statusCode === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      url = next.toString();
      continue;
    }
    const out = { 'Cache-Control': 'no-store', 'X-Noctyl-Proxy': '1' };
    for (const [k, v] of Object.entries(upstream.headers)) if (PASS_RES.test(k) && v != null) out[k] = v;
    res.writeHead(upstream.statusCode || 502, out);
    const ok = (upstream.statusCode || 502) < 400;
    if ([101, 204, 205, 304].includes(upstream.statusCode) || method === 'HEAD') { upstream.resume(); res.end(); record(ok); return; }
    // keep the first and last bytes of a model's answer: that's where providers report token counts
    let head = '', tail = '';
    if (isModelCall) upstream.on('data', c => { const s = c.toString('utf8'); if (head.length < 16384) head += s.slice(0, 16384 - head.length); tail = (tail + s).slice(-32768); });
    upstream.pipe(res);
    await new Promise(resolve => { upstream.on('end', resolve); upstream.on('error', resolve); res.on('close', () => { upstream.destroy(); resolve(); }); });
    record(ok, head + '\n' + tail);
    return;
  }
  throw new ProxyError('Too many redirects', 502);
}

module.exports = { proxy, classify, ProxyError };
