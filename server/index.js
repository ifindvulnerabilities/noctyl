#!/usr/bin/env node
// Noctyl server: the web version with accounts, for serving Noctyl to a site.
//
//   npm run serve                     start (http://127.0.0.1:8787 by default)
//   node server --port 8080 --host 0.0.0.0 --data /srv/noctyl
//   node server --host 100.101.102.103   only on that address (e.g. this computer's Tailscale IP: only your tailnet)
//   node server --ollama 100.64.0.5      use the Ollama on another device (kept in config.json; "local" = this computer)
//   node server mode single|open|admin   who can sign up (also in Settings → Account; reversible any time); alone: show it
//   node server --mode single …       set the sign-up mode while starting (what start-server.bat / .sh do)
//   node server accounts              list accounts and the sign-up mode
//   node server admin <name> [off]    make an account an admin (or not)
//   node server owner <name>          the one account that can sign in while the mode is "single"
//   node server remove <name>         delete an account and its data
//
// Data lives in --data, $NOCTYL_SERVER_DATA, or the system's app data folder: %APPDATA%\Noctyl Server (Windows),
// ~/Library/Application Support/Noctyl Server (macOS), ~/.local/share/noctyl-server (Linux; $XDG_DATA_HOME if set).
// That folder holds a .gitignore of its own, so it's never committed even if it's put inside the project.
// Only signed-in accounts get the app. Each account's data is encrypted with a key only its password or recovery code
// unlocks (crypto.js); API keys stay on the server (userdata.js); requests go out through /api/net (proxy.js).
// Run it behind HTTPS (Caddy, nginx, Cloudflare Tunnel…) when it's reachable from other computers.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Accounts, UserError, limiter, MODES, MAX_SESSION_HOURS, readJSON } = require('./accounts');
const { UserData } = require('./userdata');
const { proxy, classify } = require('./proxy');
const commands = require('./commands');
const dnsp = require('node:dns').promises;
const { Shared } = require('./shared');
const { Collab } = require('./collab');
const { Stats, dayKey } = require('./stats');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args.splice(i, 2)[1] : fallback; };
/** Where accounts and their (encrypted) data live by default: each system's usual place for app data, never the project.
    A ~/.noctyl-server folder from earlier versions keeps being used. */
function defaultDataDir() {
  const earlier = path.join(os.homedir(), '.noctyl-server');
  if (fs.existsSync(earlier)) return earlier;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Noctyl Server');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Noctyl Server');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'noctyl-server');   // Linux and others
}
const DATA = path.resolve(flag('data', process.env.NOCTYL_SERVER_DATA || defaultDataDir()));
// whatever the folder is called and wherever it is, git never picks it up: it ignores itself
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
if (!fs.existsSync(path.join(DATA, '.gitignore'))) fs.writeFileSync(path.join(DATA, '.gitignore'), '# Noctyl server data: accounts and encrypted chats and keys. Never commit this folder.\n*\n');
if (!path.relative(ROOT, DATA).startsWith('..') && !path.isAbsolute(path.relative(ROOT, DATA))) console.warn(`  Note: the data folder ${DATA} is inside the project. It ignores itself in git, but keeping it outside is safer.`);
const portFlag = flag('port', process.env.PORT || ''), hostFlag = flag('host', process.env.NOCTYL_HOST || ''), modeFlag = flag('mode', '');
const ollamaFlag = flag('ollama', process.env.NOCTYL_OLLAMA || '');
const { ollamaUrl: cleanOllama, addresses } = require('./ask');
const accounts = new Accounts(DATA);
const config = accounts.config;
const shared = new Shared(DATA);   // providers admins share (shared.js)
const collab = new Collab(accounts.db, shared.key);   // conversation links, workspaces, shared projects (collab.js)
shared.collab = collab;            // shared providers can go to workspaces and projects too
const stats = new Stats(DATA);     // usage numbers (stats.js)
const nameOf = id => accounts.byId(id)?.name || '(deleted account)';

/* ---------- command line ---------- */
const [cmd, ...rest] = args;
if (cmd && cmd !== 'start') {
  const need = n => { const u = accounts.find(n); if (!u) { console.error(`No account called ${n}`); process.exit(1); } return u; };
  try {
    if (cmd === 'mode') {
      if (!rest[0]) { console.log(config.registration); process.exit(0); }   // `node server mode` alone: the current mode
      if (!MODES.includes(rest[0])) { console.error(`Usage: node server mode ${MODES.join('|')}   (now: ${config.registration})`); process.exit(1); }
      accounts.setMode(rest[0]);
      console.log(`Sign-up mode is now "${rest[0]}". Restart the server if it's running.`);
    } else if (cmd === 'accounts') {
      console.log(`Sign-up mode: ${config.registration}${config.maxUsers ? ` · up to ${config.maxUsers} accounts` : ''}`);
      for (const u of accounts.users) { const p = accounts.publicUser(u); console.log(`  ${u.name}${p.admin ? ' (admin)' : ''}${p.owner ? ' (owner)' : ''}${p.paused ? ' — paused while the mode is single' : ''}`); }
      if (!accounts.users.length) console.log('  (no accounts yet)');
    } else if (cmd === 'admin') { const u = need(rest[0]); accounts.setAdmin(u, rest[1] !== 'off'); console.log(`${u.name} is ${u.admin ? 'now' : 'no longer'} an admin.`); }
    else if (cmd === 'owner') { const u = need(rest[0]); config.owner = u.id; accounts.saveConfig(); console.log(`${u.name} is the owner (the account used while the mode is single).`); }
    else if (cmd === 'remove') { const u = need(rest[0]); accounts.remove(u); shared.forgetUser(u.id); console.log(`Removed ${u.name} and its data.`); }
    else { console.error(`Unknown command "${cmd}". See the top of server/index.js.`); process.exit(1); }
  } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}
// --mode single|open|admin when starting (the start scripts ask for it): the same as `node server mode …`, kept afterwards
if (modeFlag) {
  if (!MODES.includes(modeFlag)) { console.error(`--mode must be one of ${MODES.join(', ')}`); process.exit(1); }
  if (modeFlag !== config.registration) { accounts.setMode(modeFlag); console.log(`Sign-up mode set to "${modeFlag}".`); }
}
if (portFlag) config.port = Number(portFlag);
if (hostFlag) config.host = hostFlag;
// --ollama <address> | local: where Ollama runs for everyone (kept, like --mode)
if (ollamaFlag) {
  const u = /^(local|localhost|none)$/i.test(ollamaFlag) ? '' : cleanOllama(ollamaFlag);
  if (u === '' && !/^(local|localhost|none)$/i.test(ollamaFlag)) { console.error(`--ollama: "${ollamaFlag}" isn't an address. Try 100.101.102.103 or http://my-desktop:11434`); process.exit(1); }
  if (u !== config.ollamaUrl) { config.ollamaUrl = u; accounts.saveConfig(); }
}
/** host:port of the server's Ollama when it's on another device ('' for this computer) */
const ollamaHost = () => { try { return config.ollamaUrl ? new URL(config.ollamaUrl).host.toLowerCase() : ''; } catch { return ''; } };

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self'", "media-src 'self' blob: data:", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
const isHttps = req => !!req.socket.encrypted || (config.trustProxy && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()));
const clientIp = req => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
function headers(req, extra = {}) {
  return { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    ...(isHttps(req) && { 'Strict-Transport-Security': 'max-age=31536000' }), ...extra };
}
const json = (req, res, code, obj, extra = {}) => { res.writeHead(code, headers(req, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra })); res.end(JSON.stringify(obj)); };
const fail = (req, res, code, msg) => json(req, res, code, { error: msg });
const COOKIE = 'noctyl_session';
const cookieOf = req => { const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : ''; };
const secureCookie = req => (config.secureCookies === 'auto' ? isHttps(req) : !!config.secureCookies);
const setCookie = (req, token, maxAgeS) => `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secureCookie(req) ? '; Secure' : ''}`;
async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}
// one save at a time per account (the app can send two close together)
const queues = new Map();
const serial = (id, fn) => { const p = (queues.get(id) || Promise.resolve()).then(fn, fn); queues.set(id, p.catch(() => {})); return p; };

/* ---------- static files: only the app's own, and only for signed-in accounts (the sign-in page is public) ---------- */
// Add to Home Screen / install: a square icon (iOS uses apple-touch-icon; others the manifest) and full-screen launch
const APP_HEAD = ['<link rel="manifest" href="/assets/manifest.webmanifest">', '<link rel="apple-touch-icon" href="/assets/icon-180.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">', '<meta name="mobile-web-app-capable" content="yes">', '<meta name="apple-mobile-web-app-title" content="Noctyl">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">', '<meta name="theme-color" content="#0f0f0f">'].join('\n');
const CHAT_PAGE = /^\/chat\/[\w-]{1,80}\/?$/;   // one of your chats: /chat/<its id> (a UUID)
const SHARE_PAGE = /^\/share\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;   // a shared conversation's link
const APP_FILES = new Set(['app.js', 'early.js', 'styles.css', 'dictation-worklet.js', 'config/defaults.json']);
const PUBLIC = { '/login': 'server/login.html', '/login.js': 'server/login.js', '/login.css': 'server/login.css' };
async function sendFile(req, res, rel, { inject = false, within = ROOT } = {}) {
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(within + path.sep)) return fail(req, res, 404, 'Not found');   // never outside the folder it may serve from
  let data;
  try { data = await fsp.readFile(file); } catch { return fail(req, res, 404, 'Not found'); }
  // the page tells the app it's served by this server (app.js: server mode)
  if (inject) data = Buffer.from(data.toString('utf8').replace('<head>', '<head>\n<base href="/">\n<meta name="noctyl-server" content="1">\n' + APP_HEAD));   // base: /share/<id> loads /styles.css, not /share/styles.css
  res.writeHead(200, headers(req, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=3600' : 'no-cache' }));
  res.end(data);
}

/* ---------- live: an account's other devices see changes as they're saved (Server-Sent Events, /api/events) ----------
   Each open app keeps one connection. When one saves (a new message, a reply as it's written, a rename, settings…),
   the others get the saved data straight away. Only the account's own sessions are connected; a connection closes
   when its session ends, and doesn't count as use (an idle sign-in still ends). */
const live = new Map();   // userId → Set<{ res, client, sessionId }>
function broadcast(userId, exceptClient, data) {
  const conns = live.get(userId);
  if (!conns?.size) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of conns) if (c.client !== exceptClient && !c.res.writableEnded) c.res.write(msg);
}
setInterval(() => {
  for (const [userId, conns] of live) for (const c of conns) {
    if (!accounts.alive(c.sessionId)) { c.res.end(); conns.delete(c); continue; }
    c.res.write(': ping\n\n');   // keeps proxies from closing it
  }
  for (const [userId, conns] of live) if (!conns.size) live.delete(userId);
}, 25000).unref();
const clientOf = req => String(req.headers['x-noctyl-client'] || '').slice(0, 40);

/* ---------- the API ---------- */
const loginLimit = limiter(10, 15 * 60e3), signupLimit = limiter(10, 60 * 60e3);
// the shipped defaults, plus this server's Ollama when it's elsewhere (accounts that never set their own use it)
const DEFAULTS = () => { const d = readJSON(path.join(ROOT, 'config', 'defaults.json'), null); return config.ollamaUrl ? { ...(d || {}), ollamaUrl: config.ollamaUrl } : d; };
const userDataOf = s => new UserData(accounts.userDir(s.user), s.key);
function sessionInfo(s) {
  const su = accounts.signUpState();
  return {
    server: true, setup: !accounts.users.length, signUp: su.allowed, signUpNote: su.why || '',
    user: s ? accounts.publicUser(s.user) : null,
    ...(s?.user.admin && { registration: config.registration, privateNetwork: config.privateNetwork, sharedHosts: config.sharedHosts, ollamaUrl: config.ollamaUrl, commands: config.commands === 'admins' ? 'admins' : 'off', maxUsers: config.maxUsers, sessionHours: config.sessionHours, idleMinutes: config.idleMinutes }),
  };
}
function signIn(req, res, user, key, extra = {}) {
  const { token, expires } = accounts.startSession(user, key, { ip: clientIp(req), agent: req.headers['user-agent'] || '' });
  stats.signIn(user.id);   // signing in, signing up and recovering an account all count
  json(req, res, 200, { ok: true, user: accounts.publicUser(user), expires, ...extra }, { 'Set-Cookie': setCookie(req, token, Math.floor((expires - Date.now()) / 1000)) });
}
/** the session token: "Authorization: Bearer <token>" (programs), or the session cookie (the browser) */
const bearerOf = req => { const m = /^Bearer\s+([\w-]{20,100})$/i.exec(String(req.headers.authorization || '')); return m ? m[1] : ''; };
const tokenOf = req => bearerOf(req) || cookieOf(req);

async function api(req, res, url, s) {
  const p = url.pathname, m = req.method;
  const ip = clientIp(req);
  // public
  if (p === '/api/session' && m === 'GET') return json(req, res, 200, sessionInfo(s));
  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req, 10e3);
    const who = String(b.name || '').toLowerCase();
    if (!loginLimit.hit('ip:' + ip) || !loginLimit.hit('name:' + who)) return fail(req, res, 429, 'Too many tries. Wait 15 minutes and try again.');
    const ok = await accounts.verify(b.name, b.password);
    if (!ok) return fail(req, res, 401, "That name and password don't match.");
    if (ok.user.disabled) return fail(req, res, 403, 'An admin has paused this account. Ask them to turn it back on.');
    if (!accounts.canSignIn(ok.user)) return fail(req, res, 403, 'This server is set to one account, so this account is paused. An admin can change that.');
    loginLimit.clear('name:' + who);
    return signIn(req, res, ok.user, ok.key, { mustChangePassword: !!ok.user.mustChangePassword });
  }
  // token-based sign-in for programs (scripts, other tools): the token goes in "Authorization: Bearer <token>".
  // It follows the same rules as a browser session (6 hours at most, ends when idle, can be ended in Settings → Account).
  if (p === '/api/token' && m === 'POST') {
    const b = await readBody(req, 10e3);
    const who = String(b.name || '').toLowerCase();
    if (!loginLimit.hit('ip:' + ip) || !loginLimit.hit('name:' + who)) return fail(req, res, 429, 'Too many tries. Wait 15 minutes and try again.');
    const ok = await accounts.verify(b.name, b.password);
    if (!ok) return fail(req, res, 401, "That name and password don't match.");
    if (!accounts.canSignIn(ok.user)) return fail(req, res, 403, 'This account is paused.');
    if (ok.user.mustChangePassword) return fail(req, res, 403, 'Sign in on the web page first and choose your own password.');
    loginLimit.clear('name:' + who);
    const t = accounts.startSession(ok.user, ok.key, { ip, agent: String(b.label || req.headers['user-agent'] || 'token').slice(0, 120), kind: 'token' });
    stats.signIn(ok.user.id);
    return json(req, res, 200, { token: t.token, expires: t.expires, tokenType: 'Bearer' });
  }
  if (p === '/api/register' && m === 'POST') {
    if (!signupLimit.hit('ip:' + ip)) return fail(req, res, 429, 'Too many new accounts from here. Try again later.');
    const b = await readBody(req, 10e3);
    const r = await accounts.register(b.name, b.password, b.setupCode);
    console.log(`[noctyl] new account: ${r.user.name}${r.user.admin ? ' (admin, owner)' : ''}`);
    return signIn(req, res, r.user, r.key, { recovery: r.recovery });
  }
  if (p === '/api/recover' && m === 'POST') {
    const b = await readBody(req, 10e3);
    if (!loginLimit.hit('ip:' + ip) || !loginLimit.hit('name:' + String(b.name || '').toLowerCase())) return fail(req, res, 429, 'Too many tries. Wait 15 minutes and try again.');
    const r = await accounts.recover(b.name, b.code, b.password);
    if (!accounts.canSignIn(r.user)) return fail(req, res, 403, 'Your password is reset, but this server is set to one account, so this account is paused.');
    return signIn(req, res, r.user, r.key, { recovery: r.recovery });
  }
  if (p === '/api/logout' && m === 'POST') { accounts.endSession(tokenOf(req)); return json(req, res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) }); }

  // everything below needs a signed-in account
  if (!s) return fail(req, res, 401, 'Sign in again.');
  const user = s.user;
  if (p === '/api/password' && m === 'POST') {
    const b = await readBody(req, 10e3);
    if (!loginLimit.hit('pw:' + user.id)) return fail(req, res, 429, 'Too many tries. Wait 15 minutes and try again.');
    const first = !!user.mustChangePassword;
    if (!first && !(await accounts.verify(user.name, b.current))) return fail(req, res, 401, "Your current password isn't right.");
    await accounts.setPassword(user, s.key, b.password);
    accounts.revokeUser(user.id, s.id);   // signed out everywhere else
    const recovery = first || !user.recovery ? await accounts.newRecovery(user, s.key) : undefined;
    return json(req, res, 200, { ok: true, recovery });
  }
  if (user.mustChangePassword) return fail(req, res, 403, 'Choose your own password first.');
  if (p === '/api/recovery-code' && m === 'POST') {
    const b = await readBody(req, 10e3);
    if (!(await accounts.verify(user.name, b.password))) return fail(req, res, 401, "Your password isn't right.");
    return json(req, res, 200, { recovery: await accounts.newRecovery(user, s.key) });
  }
  if (p === '/api/logout-all' && m === 'POST') { accounts.revokeUser(user.id); return json(req, res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) }); }
  // your sessions: where you're signed in, and ending one
  if (p === '/api/sessions' && m === 'GET') return json(req, res, 200, { current: s.id.slice(0, 16), sessionHours: config.sessionHours, idleMinutes: config.idleMinutes, sessions: accounts.sessionsOf(user.id) });
  const sesm = /^\/api\/sessions\/([a-f0-9]{16})$/.exec(p);
  if (sesm && m === 'DELETE') return accounts.endShortId(user.id, sesm[1]) ? json(req, res, 200, { ok: true }) : fail(req, res, 404, 'That session already ended.');

  const ud = userDataOf(s);
  // the app's data, plus who you are and the providers shared with you (stand-ins only, never their keys)
  if (p === '/api/store' && m === 'GET') return json(req, res, 200, { ...(await ud.load()), defaults: DEFAULTS(), ollamaUrl: config.ollamaUrl, me: accounts.publicUser(user), shared: shared.forUser(user, nameOf) });
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, headers(req, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }));
    res.write('retry: 3000\n\n');
    const c = { res, client: String(url.searchParams.get('client') || '').slice(0, 40), sessionId: s.id };
    if (!live.has(user.id)) live.set(user.id, new Set());
    live.get(user.id).add(c);
    req.on('close', () => { live.get(user.id)?.delete(c); });
    return;
  }
  if (p === '/api/store' && m === 'PUT') {
    const b = await readBody(req, 60 * 1024 * 1024);
    return json(req, res, 200, await serial(user.id, async () => {
      const r = await ud.save(b);
      // the account's other devices: what was saved (settings with stand-ins for keys, as stored)
      const ev = {};
      if (Array.isArray(b.chats) && b.chats.length) ev.chats = b.chats.filter(c => c && c.id);
      if (Array.isArray(b.deleted) && b.deleted.length) ev.deleted = b.deleted.map(String);
      if (b.settings && typeof b.settings === 'object') ev.settings = b.settings;
      if (Object.keys(ev).length) broadcast(user.id, clientOf(req), ev);
      // an admin's shares follow their providers: a new key or address is picked up, a removed provider stops being shared
      if (b.settings && shared.entries.some(e => e.ownerId === user.id)) { const v = await ud.secretsView(); shared.syncOwner(user, v.settings, v.vault); }
      return r;
    }));
  }
  if (p === '/api/shared' && m === 'GET') return json(req, res, 200, shared.forUser(user, nameOf));
  // your own usage (Settings → General → Account)
  if (p === '/api/usage' && m === 'GET') {
    const q = url.searchParams;
    return json(req, res, 200, stats.query({ from: q.get('from') || '', to: q.get('to') || '', group: q.get('group') || 'day', userIds: [user.id] }));
  }
  if (p === '/api/store/erase' && m === 'POST') { await serial(user.id, () => ud.erase()); broadcast(user.id, clientOf(req), { erased: true }); return json(req, res, 200, { ok: true }); }
  if (p === '/api/images' && m === 'GET') return json(req, res, 200, await ud.imageKeys());
  if (p === '/api/images/delete' && m === 'POST') { const b = await readBody(req, 1e6); await ud.delImages((b.ids || []).map(String)); return json(req, res, 200, { ok: true }); }
  if (p === '/api/images/clear' && m === 'POST') { await ud.clearImages(); return json(req, res, 200, { ok: true }); }
  const im = /^\/api\/images\/([\w-]{1,80})$/.exec(p);
  if (im && m === 'GET') return json(req, res, 200, await ud.getImage(im[1]));
  if (im && m === 'PUT') {
    const rec = await readBody(req, 32 * 1024 * 1024);
    if (!rec || typeof rec.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(rec.dataUrl)) return fail(req, res, 400, 'Bad image');
    await ud.putImage(im[1], { dataUrl: rec.dataUrl, mime: String(rec.mime || ''), w: Number(rec.w) || 0, h: Number(rec.h) || 0 });
    return json(req, res, 200, { ok: true });
  }
  if (p === '/api/net' && m === 'POST') {
    const b = await readBody(req, 26 * 1024 * 1024);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try { await proxy(b, res, { userData: ud, user, config, shared, stats, signal: ac.signal }); }
    catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      // a refusal (403/400…) reads like a provider error; a network failure becomes a TypeError in the app
      if (e.status) return fail(req, res, e.status, e.message);
      res.writeHead(502, headers(req, { 'X-Noctyl-Proxy-Error': encodeURIComponent(ac.signal.aborted ? 'AbortError' : (e.code === 'ENOTFOUND' ? `Couldn't find ${safeHost(b.url)}` : e.code === 'ECONNREFUSED' ? `Nothing is answering at ${safeHost(b.url)}` : e.message || 'Network error')), 'Content-Type': 'text/plain' }));
      res.end();
    }
    return;
  }

  /** may this account hand others a provider at this address? (a shared provider can reach the server's own network,
      so only someone who could reach it themselves may share one there) */
  const mayShareHost = async u => {
    let host; try { host = new URL(u); } catch { return false; }
    const key = host.host.toLowerCase(), bare = host.hostname.replace(/^\[|\]$/g, '');
    if ((config.sharedHosts || []).map(x => String(x).toLowerCase()).includes(key) || config.privateNetwork === 'everyone') return true;
    let ips; try { ips = require('node:net').isIP(bare) ? [bare] : (await dnsp.lookup(bare, { all: true })).map(a => a.address); } catch { return false; }
    return ips.every(ip => classify(ip) === 'public');
  };
  /* ---------- working together: people, workspaces, conversation links, shared projects (collab.js) ---------- */
  const wsIds = () => (user.admin ? collab.allWorkspaces() : collab.workspacesOf(user.id)).map(w => w.id);
  // the app names people; the database knows ids
  const audienceIn = a => Collab.cleanAudience(a === 'all' ? 'all' : { users: (a?.users || []).map(n => accounts.find(n)?.id).filter(Boolean), workspaces: a?.workspaces || [] }, { userId: user.id, workspaceIds: wsIds() });
  const audienceOut = a => (a === 'all' ? 'all' : { users: (a.users || []).map(nameOf), workspaces: a.workspaces || [] });
  /** images a chat points to, copied out of this account's own (encrypted) store so others can see them; 25 MB at most */
  const imagesOf = async chats => {
    const out = {}; let total = 0;
    for (const id of [...new Set(chats.flatMap(c => (c.messages || []).flatMap(m => m.images || [])))]) {
      const rec = await ud.getImage(id).catch(() => null);
      if (!rec) continue;
      total += rec.dataUrl.length;
      if (total > 25 * 1024 * 1024) break;
      out[id] = rec;
    }
    return out;
  };
  const cleanChat = c => {
    if (!c || typeof c !== 'object' || !/^[\w-]{1,80}$/.test(String(c.id || ''))) throw Object.assign(new Error('Bad conversation'), { status: 400 });
    return { id: c.id, title: String(c.title || 'Conversation').slice(0, 200), created: Number(c.created) || Date.now(), updated: Number(c.updated) || Date.now(), model: String(c.model || '').slice(0, 300),
      messages: (Array.isArray(c.messages) ? c.messages : []).slice(0, 2000).filter(x => x && ['user', 'assistant'].includes(x.role)).map(x => ({ role: x.role, content: String(x.content || '').slice(0, 400000), ...(x.images?.length && { images: x.images.map(String).slice(0, 20) }), ...(x.files?.length && { files: x.files.slice(0, 20) }), ...(x.sources?.length && { sources: x.sources.slice(0, 40) }), ...(x.tools?.length && { tools: x.tools.slice(0, 60) }), ...(x.error && { error: true }) })) };
  };
  /* ---------- commands (the agent's run_command tool): admins only, once an admin turned them on (commands.js) ---------- */
  // who: admins, and accounts an admin allowed (Users page) that switched commands on for themselves
  const mayCommand = user.admin || user.commands;
  const commandsFor = () => config.commands === 'admins' && !bearerOf(req) && (user.admin || (user.commands && user.commandsOn));   // in a browser, not with an API token
  if (p === '/api/commands' && m === 'GET') return json(req, res, 200, mayCommand ? { ...commands.status(commandsFor()), serverOn: config.commands === 'admins', allowed: true } : { enabled: false, allowed: false });
  // an allowed account switches commands on or off for itself (an admin's switch is the server's, in Admin → Access)
  if ((p === '/api/commands/enable' || p === '/api/commands/disable') && m === 'POST') {
    if (!mayCommand) return fail(req, res, 403, "An admin of this server hasn't allowed your account to run commands.");
    if (p.endsWith('/enable') && config.commands !== 'admins') return fail(req, res, 403, 'Commands are turned off on this server. An admin can turn them on in Settings → Admin → Access.');
    accounts.setCommandsOn(user, p.endsWith('/enable'));
    console.log(`[noctyl] ${user.name} turned commands ${user.commandsOn ? 'on' : 'off'} for their account`);
    return json(req, res, 200, { ...commands.status(commandsFor()), serverOn: config.commands === 'admins', allowed: true });
  }
  if (p === '/api/commands/run' && m === 'POST') {
    if (!mayCommand) return fail(req, res, 403, "Your account isn't allowed to run commands. An admin can allow it in Settings → Admin → Users.");
    if (bearerOf(req)) return fail(req, res, 403, 'Commands can only be run from the app, not with an API token.');
    if (config.commands !== 'admins') return fail(req, res, 403, 'Commands are turned off on this server. An admin can turn them on in Settings → Admin → Access.');
    if (!user.admin && !user.commandsOn) return fail(req, res, 403, 'Commands are switched off for your account. Turn them on in Settings → Tools → Commands.');
    const b = await readBody(req, 64e3);
    return commands.run(req, res, user, b, msg => console.log(msg));
  }

  // people you can share with (names only)
  if (p === '/api/people' && m === 'GET') return json(req, res, 200, accounts.users.filter(u => u.id !== user.id && !u.disabled).map(u => ({ name: u.name })));
  // workspaces
  if (p === '/api/workspaces' && m === 'GET') {
    const list = (user.admin && url.searchParams.get('all') ? collab.allWorkspaces() : collab.workspacesOf(user.id));
    return json(req, res, 200, list.map(w => ({ id: w.id, name: w.name, owner: nameOf(w.owner_id), mine: w.owner_id === user.id, canManage: collab.canManageWorkspace(collab.workspace(w.id), user),
      members: collab.members(w.id).map(x => ({ name: nameOf(x.user_id), role: x.role })) })));
  }
  if (p === '/api/workspaces' && m === 'POST') { const b = await readBody(req, 5e3); return json(req, res, 200, { id: collab.createWorkspace(user, b.name) }); }
  const wsm = /^\/api\/workspaces\/(ws-[a-f0-9]{16})(\/members(?:\/([a-z0-9._-]{1,32}))?|\/leave)?$/.exec(p);
  if (wsm) {
    const [, id, sub, who] = wsm;
    if (!sub && m === 'PUT') { const b = await readBody(req, 5e3); collab.renameWorkspace(id, user, b.name); return json(req, res, 200, { ok: true }); }
    if (!sub && m === 'DELETE') { collab.deleteWorkspace(id, user); return json(req, res, 200, { ok: true }); }
    if (sub === '/leave' && m === 'POST') { collab.leaveWorkspace(id, user); return json(req, res, 200, { ok: true }); }
    if (sub?.startsWith('/members') && m === 'POST') { const b = await readBody(req, 5e3); const t = accounts.find(b.name); if (!t) return fail(req, res, 404, 'No account by that name'); collab.setMember(id, user, t, b.role); return json(req, res, 200, { ok: true }); }
    if (sub?.startsWith('/members') && who && m === 'DELETE') { const t = accounts.find(who); if (t) collab.setMember(id, user, t, null); return json(req, res, 200, { ok: true }); }
  }
  // conversation links (/share/<uuid>)
  if (p === '/api/shares' && m === 'GET') return json(req, res, 200, collab.sharesOf(user.id).map(x => ({ ...x, audience: audienceOut(x.audience) })));
  if (p === '/api/shares' && m === 'POST') {
    const b = await readBody(req, 60 * 1024 * 1024), chat = cleanChat(b.chat);
    const id = collab.createShare(user, { chat, images: await imagesOf([chat]), audience: audienceIn(b.audience), title: chat.title });
    return json(req, res, 200, { id, url: `/share/${id}` });
  }
  const shm = /^\/api\/shares\/([0-9a-f-]{36})$/i.exec(p);
  if (shm && m === 'GET') {
    const v = collab.viewShare(shm[1], user);
    return json(req, res, 200, { ...v, owner: nameOf(v.ownerId), ownerId: undefined });
  }
  if (shm && m === 'PUT') {
    const b = await readBody(req, 60 * 1024 * 1024);
    const chat = b.chat ? cleanChat(b.chat) : null;
    collab.updateShare(shm[1], user, { chat, images: chat ? await imagesOf([chat]) : null, audience: b.audience ? audienceIn(b.audience) : null });
    return json(req, res, 200, { ok: true });
  }
  if (shm && m === 'DELETE') { collab.deleteShare(shm[1], user); return json(req, res, 200, { ok: true }); }
  // shared projects
  const projectOut = x => ({ ...x, owner: nameOf(x.ownerId), mine: x.ownerId === user.id, ownerId: undefined, access: x.access ? audienceOut(x.access) : x.access,
    chats: (x.chats || []).map(c => ({ ...c, author: c.author ? nameOf(c.author) : '' })), images: undefined });
  if (p === '/api/projects' && m === 'GET') return json(req, res, 200, collab.projectsFor(user).map(projectOut));
  if (p === '/api/projects' && m === 'POST') {
    // a private project is shared: it moves here with its chats (their images copied in)
    const b = await readBody(req, 60 * 1024 * 1024), pr = b.project || {};
    const chats = (Array.isArray(pr.chats) ? pr.chats : []).map(cleanChat);
    const id = collab.createProject(user, { ...pr, chats, images: await imagesOf(chats) }, audienceIn(b.audience));
    return json(req, res, 200, projectOut(collab.project(id, user)));
  }
  const prm = /^\/api\/projects\/(proj-[\w-]{4,40})(\/unshare|\/provider|\/images\/([\w-]{1,80}))?$/.exec(p);
  if (prm) {
    const [, id, sub, imageId] = prm;
    if (!sub && m === 'GET') return json(req, res, 200, projectOut(collab.project(id, user)));
    if (!sub && m === 'PUT') {
      const b = await readBody(req, 60 * 1024 * 1024);
      const chat = b.chat ? cleanChat(b.chat) : null;
      const r = collab.updateProject(id, user, { name: b.name, description: b.description, instructions: b.instructions, model: b.model, chat, deleteChat: b.deleteChat ? String(b.deleteChat) : undefined,
        audience: b.audience ? audienceIn(b.audience) : undefined, images: chat ? await imagesOf([chat]) : undefined });
      return json(req, res, 200, projectOut(r));
    }
    if (sub?.startsWith('/images/') && m === 'GET') { const pj = collab.project(id, user); return json(req, res, 200, pj.images?.[imageId] || null); }
    if (sub === '/unshare' && m === 'POST') {
      const full = collab.unshareProject(id, user);
      for (const e of shared.entries.filter(x => (x.projects || []).includes(id))) e.projects = e.projects.filter(x => x !== id), e.enabled = e.enabled && !!(e.users === 'all' || e.users.length || e.workspaces?.length || e.projects.length);
      shared.save();
      return json(req, res, 200, { ...full, chats: full.chats || [] });
    }
    if (sub === '/provider' && m === 'POST') {
      // the owner lets everyone in the project use one of their providers, without seeing its key (shared.js)
      const pj = collab.project(id, user);
      if (pj.ownerId !== user.id) return fail(req, res, 403, 'Only the project’s owner can share a provider with it');
      const b = await readBody(req, 20e3);
      const v = await ud.secretsView();
      const found = Shared.extract(String(b.source || ''), v.settings, v.vault, { format: b.format, baseUrl: b.baseUrl });
      if (!found) return fail(req, res, 400, 'That provider has no address or key saved in your settings yet.');
      if (!user.admin && !(await mayShareHost(found.baseUrl))) return fail(req, res, 403, "That provider is on this server's own network, which your account can't reach. Ask an admin to share it.");
      for (const old of shared.entries.filter(x => x.ownerId === user.id && (x.projects || []).includes(id))) shared.entries = shared.entries.filter(x => x !== old);
      const models = (Array.isArray(b.models) ? b.models : String(b.models || '').split(/[\n,]+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 200);
      const e = shared.add(user, String(b.source), found, { name: String(b.name || pj.name).slice(0, 40), users: [], projects: [id], models, limitPerDay: Math.max(0, Math.round(Number(b.limitPerDay) || 0)) });
      collab.updateProject(id, user, { provider: { sharedId: e.id, name: e.name } });
      return json(req, res, 200, { sharedId: e.id });
    }
    if (sub === '/provider' && m === 'DELETE') {
      const pj = collab.project(id, user);
      if (pj.ownerId !== user.id) return fail(req, res, 403, 'Only the project’s owner can do that');
      shared.entries = shared.entries.filter(x => !(x.ownerId === user.id && (x.projects || []).includes(id)));
      shared.save();
      collab.updateProject(id, user, { provider: null });
      return json(req, res, 200, { ok: true });
    }
  }

  // admins
  if (p.startsWith('/api/admin/')) {
    if (!user.admin) return fail(req, res, 403, 'Only admins can do that.');
    // everything shared on the server, to see and stop
    if (p === '/api/admin/collab' && m === 'GET') {
      return json(req, res, 200, {
        shares: collab.allShares().map(x => ({ ...x, owner: nameOf(x.ownerId), ownerId: undefined, audience: audienceOut(x.audience) })),
        workspaces: collab.allWorkspaces().map(w => ({ id: w.id, name: w.name, owner: nameOf(w.owner_id), members: collab.members(w.id).map(x => ({ name: nameOf(x.user_id), role: x.role })) })),
        projects: collab.allProjects().map(x => ({ id: x.id, name: x.name, owner: nameOf(x.owner_id), updated: x.updated, access: audienceOut(collab.projectAccess(x.id)) })),
      });
    }
    // an admin stops a shared project being shared: it stays on the server for its owner only (they can take it back with "Stop sharing")
    const apm = /^\/api\/admin\/projects\/(proj-[\w-]{4,40})\/private$/.exec(p);
    if (apm && m === 'POST') {
      if (!collab.projectRow(apm[1])) return fail(req, res, 404, 'No such project');
      collab.setProjectAccess(apm[1], { users: [], workspaces: [] });
      console.log(`[noctyl] ${user.name} made the project ${apm[1]} private to its owner`);
      return json(req, res, 200, { ok: true });
    }
    if (p === '/api/admin/users' && m === 'GET') {
      // with what each account uses: disk, chats, and when it last used a model
      const list = await Promise.all(accounts.users.map(async u => ({ ...accounts.publicUser(u), ...(await new UserData(accounts.userDir(u), null).footprint()), lastActive: stats.lastActive(u.id) })));
      return json(req, res, 200, list);
    }
    // usage numbers: all accounts or one, any range, by day / month / year
    if (p === '/api/admin/stats' && m === 'GET') {
      const q = url.searchParams, who = q.get('user');
      const ids = who && who !== 'all' ? [accounts.find(who)?.id || '-'] : null;
      const r = stats.query({ from: q.get('from') || '', to: q.get('to') || '', group: q.get('group') || 'day', userIds: ids });
      r.byUser = r.byUser.map(u => ({ ...u, name: nameOf(u.id) }));
      return json(req, res, 200, { ...r, today: dayKey() });
    }
    // shared providers
    const shareOpts = b => ({
      users: b.users === 'all' || !Array.isArray(b.users) ? 'all' : b.users.map(n => accounts.find(n)?.id).filter(Boolean),
      workspaces: (Array.isArray(b.workspaces) ? b.workspaces : []).map(String).filter(id => collab.workspace(id)).slice(0, 50),
      models: (Array.isArray(b.models) ? b.models : String(b.models || '').split(/[\n,]+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 200),
      limitPerDay: Math.max(0, Math.min(1e6, Math.round(Number(b.limitPerDay) || 0))),
    });
    if (p === '/api/admin/shared' && m === 'GET') return json(req, res, 200, shared.forAdmin(nameOf));
    if (p === '/api/admin/shared' && m === 'POST') {
      const b = await readBody(req, 20e3);
      const { settings, vault } = await userDataOf(s).secretsView();
      const found = Shared.extract(String(b.source || ''), settings, vault, { format: b.format, baseUrl: b.baseUrl });
      if (!found) return fail(req, res, 400, "That provider has no address or key saved in your settings yet. Add it in Providers first.");
      const e = shared.add(user, String(b.source), found, { name: String(b.name || '').trim() || 'Shared provider', ...shareOpts(b) });
      console.log(`[noctyl] ${user.name} shared the provider "${e.name}"`);
      return json(req, res, 200, shared.forAdmin(nameOf).find(x => x.id === e.id));
    }
    const sm = /^\/api\/admin\/shared\/(shared-[a-z0-9]{6,24})$/.exec(p);
    if (sm) {
      const e = shared.find(sm[1]);
      if (!e) return fail(req, res, 404, 'No such shared provider');
      if (m === 'PUT') {
        const b = await readBody(req, 20e3), o = shareOpts(b);
        if (b.name !== undefined) e.name = String(b.name).trim().slice(0, 40) || e.name;
        if (b.users !== undefined) e.users = o.users;
        if (b.workspaces !== undefined) e.workspaces = o.workspaces;
        if (b.models !== undefined) e.models = o.models;
        if (b.limitPerDay !== undefined) e.limitPerDay = o.limitPerDay;
        if (b.enabled !== undefined) { e.enabled = !!b.enabled; delete e.note; }
        shared.save();
        return json(req, res, 200, shared.forAdmin(nameOf).find(x => x.id === e.id));
      }
      if (m === 'DELETE') { shared.entries = shared.entries.filter(x => x.id !== e.id); shared.save(); return json(req, res, 200, { ok: true }); }
    }
    if (p === '/api/admin/users' && m === 'POST') {
      const b = await readBody(req, 10e3);
      if (config.maxUsers && accounts.users.length >= config.maxUsers) return fail(req, res, 400, 'This server has all the accounts it allows.');
      const r = await accounts.create(b.name, b.password, { admin: !!b.admin, mustChangePassword: true });
      console.log(`[noctyl] ${user.name} added the account ${r.user.name}`);
      return json(req, res, 200, accounts.publicUser(r.user));
    }
    const um = /^\/api\/admin\/users\/([a-z0-9._-]{1,32})(\/admin|\/pause|\/reset|\/logout|\/commands)?$/.exec(p);
    if (um) {
      const target = accounts.find(um[1]);
      if (!target) return fail(req, res, 404, 'No such account');
      if (um[2] && m === 'POST' && target.id === user.id && um[2] !== '/admin') return fail(req, res, 400, "You can't do that to your own account here.");
      if (um[2] === '/admin' && m === 'POST') { const b = await readBody(req, 1e3); accounts.setAdmin(target, !!b.admin); return json(req, res, 200, accounts.publicUser(target)); }
      if (um[2] === '/commands' && m === 'POST') {
        const b = await readBody(req, 1e3);
        accounts.setCommands(target, !!b.allowed);
        console.log(`[noctyl] ${user.name} ${b.allowed ? 'allowed' : 'stopped'} commands for ${target.name}`);
        return json(req, res, 200, accounts.publicUser(target));
      }
      if (um[2] === '/logout' && m === 'POST') { accounts.revokeUser(target.id); console.log(`[noctyl] ${user.name} signed ${target.name} out everywhere`); return json(req, res, 200, { ok: true }); }
      if (um[2] === '/pause' && m === 'POST') {
        const b = await readBody(req, 1e3);
        accounts.setDisabled(target, !!b.paused);
        console.log(`[noctyl] ${user.name} ${b.paused ? 'paused' : 'turned back on'} the account ${target.name}`);
        return json(req, res, 200, accounts.publicUser(target));
      }
      if (um[2] === '/reset' && m === 'POST') {
        // lost password and recovery code: a fresh start with a temporary password (their old data can't be opened, so it's erased)
        const b = await readBody(req, 1e3);
        await accounts.reset(target, String(b.password || ''));
        console.log(`[noctyl] ${user.name} reset the account ${target.name} (its data was erased)`);
        return json(req, res, 200, accounts.publicUser(target));
      }
      if (!um[2] && m === 'DELETE') {
        if (target.id === user.id) return fail(req, res, 400, "You can't delete your own account here.");
        accounts.remove(target);
        shared.forgetUser(target.id);   // their shares stop; they're taken off others' share lists
        console.log(`[noctyl] ${user.name} removed the account ${target.name}`);
        return json(req, res, 200, { ok: true });
      }
    }
    if (p === '/api/admin/config' && m === 'PUT') {
      const b = await readBody(req, 10e3);
      if (b.registration !== undefined) { accounts.setMode(String(b.registration), user); console.log(`[noctyl] ${user.name} set the sign-up mode to ${config.registration}`); }
      if (b.privateNetwork !== undefined) {
        if (!['everyone', 'admins', 'nobody'].includes(b.privateNetwork)) return fail(req, res, 400, 'Choose everyone, admins or nobody.');
        config.privateNetwork = b.privateNetwork;
      }
      if (b.commands !== undefined) {
        if (!['off', 'admins'].includes(b.commands)) return fail(req, res, 400, 'Choose off or admins.');
        if (b.commands !== config.commands) console.log(`[noctyl] ${user.name} turned commands ${b.commands === 'admins' ? 'on (admins only)' : 'off'}`);
        config.commands = b.commands;
        if (b.commands === 'off') commands.stopAll();
      }
      if (b.ollamaUrl !== undefined) {
        const v = String(b.ollamaUrl || '').trim(), u = !v || /^(local|localhost)$/i.test(v) ? '' : cleanOllama(v);
        if (v && !/^(local|localhost)$/i.test(v) && !u) return fail(req, res, 400, "That isn't an address. Try 100.101.102.103 or http://my-desktop:11434");
        config.ollamaUrl = u;
      }
      if (Array.isArray(b.sharedHosts)) config.sharedHosts = b.sharedHosts.map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z0-9.[\]:-]{1,100}$/.test(x)).slice(0, 50);
      if (b.maxUsers !== undefined) config.maxUsers = Math.max(0, Math.min(100000, Math.round(Number(b.maxUsers) || 0)));
      // how long sessions last: never more than 6 hours, however it's set
      if (b.sessionHours !== undefined) config.sessionHours = Math.min(MAX_SESSION_HOURS, Math.max(0.25, Number(b.sessionHours) || MAX_SESSION_HOURS));
      if (b.idleMinutes !== undefined) config.idleMinutes = Math.min(config.sessionHours * 60, Math.max(5, Math.round(Number(b.idleMinutes) || 120)));
      config.idleMinutes = Math.min(config.idleMinutes, config.sessionHours * 60);
      accounts.saveConfig();
      return json(req, res, 200, sessionInfo(accounts.session(tokenOf(req))));
    }
  }
  return fail(req, res, 404, 'Not found');
}
const safeHost = u => { try { return new URL(u).host; } catch { return 'that address'; } };

/* ---------- the server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const s = accounts.session(tokenOf(req));
    if (url.pathname.startsWith('/api/')) {
      // requests that change something must come from this site's own pages (a Bearer token can't be sent by another
      // site behind your back, so token requests from programs don't need this)
      if (req.method !== 'GET' && !bearerOf(req)) {
        const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
        const originHost = (() => { try { return new URL(origin).host; } catch { return '-'; } })();
        if (req.headers['x-noctyl'] !== '1' || (origin && originHost !== req.headers.host) || (site && !['same-origin', 'none'].includes(site))) return fail(req, res, 403, 'Refused: not from this site.');
      }
      return await api(req, res, url, s);
    }
    if (PUBLIC[url.pathname]) return sendFile(req, res, PUBLIC[url.pathname]);
    if (url.pathname.startsWith('/assets/')) {
      let rel; try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { return fail(req, res, 400, 'Bad path'); }
      return sendFile(req, res, rel, { within: path.join(ROOT, 'assets') });
    }
    const go = to => { res.writeHead(302, headers(req, { Location: to })); res.end(); };
    // pages that open the app: the chat, the admin panel, a shared conversation (/share/<id>)
    const appPage = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/admin' || SHARE_PAGE.test(url.pathname) || CHAT_PAGE.test(url.pathname);
    // not signed in: everything leads to the sign-in page, which comes back to a shared conversation afterwards
    if (!s) return go(SHARE_PAGE.test(url.pathname) || CHAT_PAGE.test(url.pathname) ? `/login?next=${encodeURIComponent(url.pathname)}` : '/login');
    if (s.user.mustChangePassword) return go('/login#password');
    if (url.pathname === '/admin' && !s.user.admin) return go('/');
    if (appPage) return sendFile(req, res, 'index.html', { inject: true });
    const rel = url.pathname.slice(1);
    if (APP_FILES.has(rel)) return sendFile(req, res, rel);
    // anything else (/404, a mistyped address): back to the chat
    return go('/');
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    if (e instanceof UserError) return fail(req, res, 400, e.message);
    if (e.status) return fail(req, res, e.status, e.message);
    console.error('[noctyl]', e);
    fail(req, res, 500, 'Something went wrong on the server.');
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use, maybe by another Noctyl server that's still running.\n  Stop that one, or start this one on another port: npm run serve -- --port 8788  (the start scripts ask for the port).\n`);
  else if (e.code === 'EADDRNOTAVAIL') console.error(`\n  ${config.host} isn't one of this computer's addresses right now${/^100\./.test(config.host) ? ' (is Tailscale connected?)' : ''}.\n  Its addresses: ${addresses().map(x => x.ip).join(', ') || 'none found'}. Start it with --host 0.0.0.0 to answer on all of them.\n`);
  else if (e.code === 'EACCES') console.error(`\n  Not allowed to use port ${config.port}. Pick a port above 1024, like 8787.\n`);
  else console.error('\n  The server could not start:', e.message, '\n');
  process.exit(1);
});
server.requestTimeout = 0;   // replies stream for as long as the model takes
server.headersTimeout = 30000;
server.listen(config.port, config.host, () => {
  // listening on every address (0.0.0.0 / ::): this computer opens it at 127.0.0.1
  const shown = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host;
  const where = `http://${shown.includes(':') ? `[${shown}]` : shown}:${config.port}`;
  console.log(`Noctyl server on ${where}  ·  data in ${DATA}  ·  sign-up mode: ${config.registration}`);
  if (accounts.setupCode) console.log(`\n  No accounts yet. Open ${where}/login and create the first account with this setup code:\n\n      ${accounts.setupCode}\n`);
  if (['0.0.0.0', '::', ''].includes(config.host)) {
    const own = addresses();
    if (own.length) console.log(`  Answering on every address: ${own.map(x => `http://${x.ip}:${config.port}${x.tailscale ? ' (Tailscale)' : ''}`).join('  ')}`);
  } else if (/^100\./.test(config.host) && addresses().some(x => x.ip === config.host && x.tailscale)) console.log('  Only devices on your tailnet can open it. For HTTPS there too: tailscale serve --bg ' + config.port);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.trustProxy) console.log('  Reachable from other computers: put it behind HTTPS (and set "trustProxy": true in config.json if a proxy forwards to it).');
  // Ollama isn't required here: it can be on another device, or not used at all (cloud providers work without it)
  const ol = config.ollamaUrl || 'http://127.0.0.1:11434';
  fetch(ol + '/api/version', { signal: AbortSignal.timeout(3000) }).then(r => r.json())
    .then(j => console.log(`  Ollama: ${ol} (version ${j.version || '?'})`))
    .catch(() => console.log(`  Ollama: none answering at ${ol}${config.ollamaUrl ? '' : ' (this computer)'}. Optional: cloud providers work without it, or point to Ollama on another device with --ollama <address> or Settings → Admin → Access.`));
});
