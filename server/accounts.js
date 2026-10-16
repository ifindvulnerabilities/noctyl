// Accounts, sign-up modes and sessions for the Noctyl server, in its SQLite database (db.js).
//
//   <data>/config.json   server settings, including who can sign up (registration) — a file on purpose, so you can fix it
//                        by hand or with `node server mode …` if you're ever locked out
//   <data>/noctyl.db     accounts (name, role, the account's data key wrapped by its password and recovery code — no
//                        password hashes: a password is checked by whether it unwraps the key) and sessions
//
// Sign-up modes (config.registration), switchable at any time — in Settings → Admin → Access, with
// `node server mode <single|open|admin>`, or by editing config.json — and nothing is lost by switching:
//   single  Just me: one account. Sign-up closes once it exists. Other accounts are kept but paused (can't sign in),
//           and come back when you switch to another mode.
//   open    Anyone who can reach the server can create an account.
//   admin   Only admins create accounts.
// The very first account needs the one-time setup code the server prints when it starts with no accounts, so a server
// that's online before you've set it up can't be claimed by someone else. It becomes the owner and an admin.
//
// Sessions (token based): signing in makes a random token. The browser keeps it in an HttpOnly cookie; other programs get
// one from /api/token and send "Authorization: Bearer <token>". The database stores only a hash of the token, and the
// account's data key sealed with a key derived from the token, so sessions survive a restart while a copy of the
// database can't open (or impersonate) anything. A session ends after config.sessionHours (6 at most, always) or
// config.idleMinutes without use, whichever comes first; you can see and end your sessions in Settings → Account.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./crypto');
const { openDb, tx } = require('./db');

const MODES = ['single', 'open', 'admin'];
const NAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_SESSION_HOURS = 6;
const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  registration: 'single',
  owner: '',                 // the account that can sign in while registration is "single"
  maxUsers: 0,               // 0 = no limit
  sessionHours: 6,           // a session ends this long after signing in, however busy (6 at most)
  idleMinutes: 120,          // …or after this long without use
  trustProxy: false,         // behind a reverse proxy (Caddy, nginx…): read the client address and https from X-Forwarded-*
  secureCookies: 'auto',     // 'auto' (when the request is https) | true | false
  // Who may reach addresses on this computer or its network (Ollama, llama.cpp, ComfyUI…) through the server:
  // 'everyone' | 'admins' | 'nobody'. sharedHosts are always reachable by every account (e.g. the Ollama you share).
  privateNetwork: 'admins',
  sharedHosts: ['localhost:11434', '127.0.0.1:11434'],
  // the Ollama every account uses unless they set their own: '' = this computer (localhost:11434), or another device,
  // e.g. a desktop with a GPU on your tailnet: 'http://100.101.102.103:11434'. Every account can reach it.
  ollamaUrl: '',
  // the agent's run_command tool from the web version: 'off' (default) or 'admins' (on: admins, plus the accounts an admin
  // allows on the Users page, once they switch it on for themselves; it runs on this server's computer, as the account
  // the server runs as). Settings → Admin → Access, or here. See commands.js.
  commands: 'off',
  // the desktop-only features (running commands, project folders) are never available through the server
};

const rowToUser = r => r && ({
  id: r.id, name: r.name, admin: !!r.admin, disabled: !!r.disabled, mustChangePassword: !!r.must_change,
  commands: !!r.commands, commandsOn: !!r.commands_on,
  created: r.created, lastLogin: r.last_login, wrapped: JSON.parse(r.wrapped), recovery: r.recovery ? JSON.parse(r.recovery) : null,
});
/** the key that seals a session's copy of the data key: derived from the token, which only the browser has */
const sessionKey = token => crypto.createHmac('sha256', String(token)).update('noctyl session key v1').digest();

class Accounts {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'users'), { recursive: true, mode: 0o700 });
    this.configFile = path.join(dataDir, 'config.json');
    this.config = { ...DEFAULT_CONFIG, ...readJSON(this.configFile, {}) };
    if (!MODES.includes(this.config.registration)) this.config.registration = 'single';
    delete this.config.sessionDays;   // from before: sessions are counted in hours now (6 at most)
    this.config.sessionHours = Math.min(MAX_SESSION_HOURS, Math.max(0.25, Number(this.config.sessionHours) || MAX_SESSION_HOURS));
    this.config.idleMinutes = Math.min(this.config.sessionHours * 60, Math.max(5, Number(this.config.idleMinutes) || 120));
    this.saveConfig();
    this.db = openDb(dataDir);
    this.importUsersJson();
    this.setupCode = this.count() ? '' : C.recoveryCode().slice(0, 11);   // only while there are no accounts
    this.prune();
    setInterval(() => this.prune(), 10 * 60e3).unref();
  }

  /** Accounts from before the database (users.json) move in once; the file is then deleted (it held old password wraps). */
  importUsersJson() {
    const file = path.join(this.dir, 'users.json');
    if (!fs.existsSync(file)) return;
    const list = readJSON(file, null);
    if (!Array.isArray(list)) return;
    if (!this.count()) {
      tx(this.db, () => { for (const u of list) if (u?.id && u.name && u.wrapped) this.insert({ ...u, recovery: u.recovery || null }); });
      console.log(`[noctyl] moved ${list.length} account${list.length === 1 ? '' : 's'} from users.json into the database`);
    }
    fs.rmSync(file, { force: true });
  }

  saveConfig() { writeJSON(this.configFile, this.config); }
  count() { return this.db.prepare('SELECT COUNT(*) n FROM users').get().n; }
  get users() { return this.db.prepare('SELECT * FROM users ORDER BY created').all().map(rowToUser); }
  find(name) { return rowToUser(this.db.prepare('SELECT * FROM users WHERE name = ?').get(String(name || '').trim().toLowerCase())); }
  byId(id) { return rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(String(id || ''))); }
  userDir(user) { return path.join(this.dir, 'users', user.id); }
  insert(u) {
    this.db.prepare('INSERT INTO users (id, name, admin, disabled, must_change, created, last_login, wrapped, recovery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.id, u.name, u.admin ? 1 : 0, u.disabled ? 1 : 0, u.mustChangePassword ? 1 : 0, u.created || Date.now(), u.lastLogin || 0, JSON.stringify(u.wrapped), u.recovery ? JSON.stringify(u.recovery) : null);
  }
  save(u) {
    this.db.prepare('UPDATE users SET admin = ?, disabled = ?, must_change = ?, last_login = ?, wrapped = ?, recovery = ?, commands = ?, commands_on = ? WHERE id = ?')
      .run(u.admin ? 1 : 0, u.disabled ? 1 : 0, u.mustChangePassword ? 1 : 0, u.lastLogin || 0, JSON.stringify(u.wrapped), u.recovery ? JSON.stringify(u.recovery) : null,
        u.commands ? 1 : 0, u.commandsOn ? 1 : 0, u.id);
  }

  /** Can this account sign in right now? (In "single" mode only the owner can.) */
  canSignIn(user) { return !!user && !user.disabled && (this.config.registration !== 'single' || user.id === this.config.owner); }
  /** Can someone sign up from the sign-in page right now? */
  signUpState() {
    const n = this.count();
    if (!n) return { allowed: true, setup: true };
    if (this.config.maxUsers && n >= this.config.maxUsers) return { allowed: false, why: 'This server has all the accounts it allows.' };
    if (this.config.registration === 'open') return { allowed: true };
    return { allowed: false, why: this.config.registration === 'single' ? 'This server is set to one account.' : 'Ask an admin of this server for an account.' };
  }

  checkName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!NAME.test(n)) throw new UserError('Use 3–32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.');
    if (this.find(n)) throw new UserError('That name is taken.');
    return n;
  }
  static checkPassword(p) {
    if (typeof p !== 'string' || p.length < 10) throw new UserError('Use a password of at least 10 characters.');
    if (p.length > 200) throw new UserError('That password is too long.');
  }

  /** Make an account with a fresh data key. Returns { user, key, recovery } (recovery is shown once, never stored). */
  async create(name, password, { admin = false, mustChangePassword = false } = {}) {
    const n = this.checkName(name);
    Accounts.checkPassword(password);
    const key = crypto.randomBytes(32);
    const recovery = mustChangePassword ? '' : C.recoveryCode();
    const first = this.count() === 0;
    const user = {
      id: C.token(12).replace(/[^A-Za-z0-9]/g, 'x'), name: n, admin: admin || first, disabled: false, created: Date.now(), lastLogin: 0, mustChangePassword,
      wrapped: await C.wrap(key, password), recovery: recovery ? await C.wrap(key, C.normaliseCode(recovery)) : null,
    };
    this.insert(user);
    if (first) { this.config.owner = user.id; this.saveConfig(); this.setupCode = ''; }
    fs.mkdirSync(this.userDir(user), { recursive: true, mode: 0o700 });
    return { user, key, recovery };
  }

  /** Sign up from the sign-in page (first account: needs the setup code). */
  async register(name, password, setupCode) {
    const st = this.signUpState();
    if (!st.allowed) throw new UserError(st.why);
    if (st.setup && !C.sameText(String(setupCode || '').trim().toUpperCase(), this.setupCode)) throw new UserError('That setup code is wrong. It is printed in the server window when it starts.');
    return this.create(name, password);
  }

  /** Check a password: { user, key } or null. Unknown names take as long as wrong passwords. */
  async verify(name, password) {
    const user = this.find(name);
    if (!user) { await C.deriveKey(String(password || ''), Buffer.alloc(16)); return null; }
    const key = await C.unwrap(user.wrapped, String(password || ''));
    return key ? { user, key } : null;
  }

  async setPassword(user, key, password) {
    Accounts.checkPassword(password);
    user.wrapped = await C.wrap(key, password);
    user.mustChangePassword = false;
    this.save(user);
  }
  async newRecovery(user, key) {
    const code = C.recoveryCode();
    user.recovery = await C.wrap(key, C.normaliseCode(code));
    this.save(user);
    return code;
  }
  /** Forgotten password: the recovery code unwraps the data key; set a new password and a new code. */
  async recover(name, code, password) {
    const user = this.find(name);
    const key = user?.recovery ? await C.unwrap(user.recovery, C.normaliseCode(code)) : (await C.deriveKey('x', Buffer.alloc(16)), null);
    if (!key) throw new UserError("That name and recovery code don't match.");
    await this.setPassword(user, key, password);
    const recovery = await this.newRecovery(user, key);
    this.revokeUser(user.id);
    return { user, key, recovery };
  }

  /* ---------- sessions ---------- */
  /** A new session → its token (shown to the browser once, as a cookie, or to a program from /api/token). */
  startSession(user, key, { ip = '', agent = '', kind = 'browser' } = {}) {
    const token = C.token(32), now = Date.now();
    const expires = now + this.config.sessionHours * 3600e3;
    this.db.prepare('INSERT INTO sessions (id, user_id, created, expires, last_seen, ip, agent, kind, key_box) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(C.hash(token), user.id, now, expires, now, String(ip).slice(0, 64), String(agent).slice(0, 200), kind, C.seal(sessionKey(token), key).toString('base64'));
    user.lastLogin = now;
    this.save(user);
    return { token, expires };
  }
  /** The session for a token, or null (unknown, ended, past 6 hours, idle too long, or the account can't sign in). */
  session(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const id = C.hash(token), row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) return null;
    const now = Date.now(), user = this.byId(row.user_id);
    if (!user || !this.canSignIn(user) || now >= row.expires || now - row.last_seen > this.config.idleMinutes * 60e3) { this.endById(id); return null; }
    let key;
    try { key = C.open(sessionKey(token), Buffer.from(row.key_box, 'base64')); } catch { this.endById(id); return null; }
    if (now - row.last_seen > 30e3) this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, id);   // not on every request
    return { id, userId: user.id, user, key, created: row.created, expires: row.expires, kind: row.kind };
  }
  /** is this session (by its id) still good? Doesn't count as use, so an open tab's live connection can't keep an idle
      sign-in going */
  alive(id) {
    const row = this.db.prepare('SELECT user_id, expires, last_seen FROM sessions WHERE id = ?').get(String(id || ''));
    const user = row && this.byId(row.user_id), now = Date.now();
    return !!(row && user && this.canSignIn(user) && now < row.expires && now - row.last_seen <= this.config.idleMinutes * 60e3);
  }
  endSession(token) { if (token) this.endById(C.hash(token)); }
  endById(id) { this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id); }
  revokeUser(userId, keepId = null) { this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keepId); }
  /** an account's sessions, for Settings → Account (ids shortened: enough to tell them apart and end one) */
  sessionsOf(userId) {
    return this.db.prepare('SELECT id, created, expires, last_seen, ip, agent, kind FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId)
      .map(r => ({ id: r.id.slice(0, 16), created: r.created, expires: Math.min(r.expires, r.last_seen + this.config.idleMinutes * 60e3), lastSeen: r.last_seen, ip: r.ip, agent: r.agent, kind: r.kind }));
  }
  endShortId(userId, shortId) {
    const r = this.db.prepare('SELECT id FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?').get(userId, String(shortId || ''));
    if (r) this.endById(r.id);
    return !!r;
  }
  /** ended and idle sessions go */
  prune() { this.db.prepare('DELETE FROM sessions WHERE expires <= ? OR last_seen < ?').run(Date.now(), Date.now() - this.config.idleMinutes * 60e3); }
  /** after a mode change: sign out anyone who may no longer sign in */
  enforce() { for (const u of this.users) if (!this.canSignIn(u)) this.revokeUser(u.id); }

  /* ---------- admin ---------- */
  setMode(mode, by = null) {
    if (!MODES.includes(mode)) throw new UserError('Choose single, open or admin.');
    this.config.registration = mode;
    // going to "just me": the person switching (or the existing owner) is the one account that stays signed in
    if (mode === 'single' && by && by.admin) this.config.owner = by.id;
    if (mode === 'single' && !this.byId(this.config.owner)) { const us = this.users; this.config.owner = (us.find(u => u.admin) || us[0])?.id || ''; }
    this.saveConfig();
    this.enforce();
  }
  setAdmin(user, admin) {
    if (!admin && user.admin && this.users.filter(u => u.admin).length === 1) throw new UserError('Keep at least one admin.');
    user.admin = !!admin;
    this.save(user);
  }
  /** An admin lets an account (not an admin) use commands, or stops it. Taking it away also switches it off. */
  setCommands(user, allowed) {
    user.commands = !!allowed;
    if (!allowed) user.commandsOn = false;
    this.save(user);
  }
  /** The account itself turns commands on or off (only once an admin allowed it). */
  setCommandsOn(user, on) {
    if (on && !user.admin && !user.commands) throw new UserError("An admin of this server hasn't allowed your account to run commands.");
    user.commandsOn = !!on;
    this.save(user);
  }
  /** An admin pauses an account (it keeps everything, but can't sign in) or lets it back in. */
  setDisabled(user, disabled) {
    if (disabled && user.admin && this.users.filter(u => u.admin && !u.disabled).length === 1) throw new UserError("You can't pause the only admin.");
    user.disabled = !!disabled;
    this.save(user);
    if (disabled) this.revokeUser(user.id);
  }
  /** Forgotten password and no recovery code: a fresh start. Nobody can decrypt the old data, so it's erased; the
      account keeps its name and role and gets a temporary password to replace on first sign-in. */
  async reset(user, tempPassword) {
    Accounts.checkPassword(tempPassword);
    const key = crypto.randomBytes(32);
    user.wrapped = await C.wrap(key, tempPassword);
    user.recovery = null;
    user.mustChangePassword = true;
    this.revokeUser(user.id);
    fs.rmSync(this.userDir(user), { recursive: true, force: true });
    fs.mkdirSync(this.userDir(user), { recursive: true, mode: 0o700 });
    this.save(user);
  }
  remove(user) {
    if (user.admin && this.users.filter(u => u.admin).length === 1) throw new UserError("You can't delete the only admin.");
    this.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);   // sessions, shares, workspaces they own go with it
    if (this.config.owner === user.id) { const us = this.users; this.config.owner = (us.find(u => u.admin) || us[0])?.id || ''; this.saveConfig(); }
    fs.rmSync(this.userDir(user), { recursive: true, force: true });
  }
  publicUser(u) {
    return { name: u.name, admin: !!u.admin, owner: u.id === this.config.owner, created: u.created, lastLogin: u.lastLogin, disabled: !!u.disabled,
      paused: !this.canSignIn(u), mustChangePassword: !!u.mustChangePassword, hasRecovery: !!u.recovery,
      commands: !!u.admin || !!u.commands, commandsOn: !!u.commandsOn };
  }
}

class UserError extends Error {}

/** Count attempts per key in a sliding window: hit(key) → true while under the limit */
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < windowMs);
      list.push(now); hits.set(key, list);
      if (hits.size > 10000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
      return list.length <= max;
    },
    clear(key) { hits.delete(key); },
  };
}

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { Accounts, UserError, limiter, MODES, DEFAULT_CONFIG, MAX_SESSION_HOURS, readJSON, writeJSON };
