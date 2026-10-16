// The Noctyl server's database: <data>/noctyl.db (SQLite, built into Node 22.13+; no extra packages).
//
//   users              accounts: name, role, and the account's data key wrapped by its password and recovery code
//   sessions           signed-in sessions: a hash of the session token (never the token), when it ends, the device, and the
//                      account's data key sealed with a key derived from the token (so a copy of this file opens nothing)
//   conversation_shares  conversations shared with a link (/share/<id>): a sealed copy, and who may open it
//   workspaces, workspace_members   groups of accounts; providers and projects can be shared with a whole workspace
//   projects, project_access         projects (instructions, chats) and who they're shared with
//
// Each account's own chats, settings and keys stay in their encrypted files (userdata.js); things several accounts open
// together (shared conversations, shared projects) are sealed with the server's key (server.key).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Node prints an "experimental" note the first time SQLite is used; it's stable enough for this, so keep the console clean
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = [
  // v1
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
     must_change INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_login INTEGER NOT NULL DEFAULT 0,
     wrapped TEXT NOT NULL, recovery TEXT);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL,
     expires INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'browser', key_box TEXT NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE conversation_shares (
     id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, chat_id TEXT NOT NULL,
     title TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all', data BLOB NOT NULL, created INTEGER NOT NULL,
     updated INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX shares_owner ON conversation_shares(owner_id);
   CREATE TABLE workspaces (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
   CREATE TABLE workspace_members (
     workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL DEFAULT 'member', added INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
   CREATE TABLE projects (
     id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
     data BLOB NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
   CREATE TABLE project_access (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, target_id TEXT NOT NULL,
     PRIMARY KEY (project_id, kind, target_id));`,
  // v2: commands for accounts that aren't admins: allowed by an admin (commands), and switched on by the account itself (commands_on)
  `ALTER TABLE users ADD COLUMN commands INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN commands_on INTEGER NOT NULL DEFAULT 0;`,
];

function openDb(dataDir) {
  const file = path.join(dataDir, 'noctyl.db');
  const fresh = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (fresh) try { fs.chmodSync(file, 0o600); } catch { /* not on every system */ }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < SCHEMA.length; v++) {
    db.exec('BEGIN');
    try { db.exec(SCHEMA[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}
/** run fn inside one transaction */
const inTx = new WeakSet();
function tx(db, fn) {
  if (inTx.has(db)) return fn(); // already inside one: join it
  db.exec('BEGIN IMMEDIATE');
  inTx.add(db);
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inTx.delete(db); }
}

module.exports = { openDb, tx };
