// Working together on the Noctyl server: conversation links, workspaces and shared projects (tables in db.js).
//
// Conversation links (/share/<uuid>): a copy of one conversation (its images included), opened only by signed-in
//   accounts its owner chose — everyone on the server, chosen people, or the members of chosen workspaces. The owner can
//   update the copy or stop sharing; admins can stop any link.
// Workspaces: a named group of accounts. Anyone can make one and add people; its owner (and admins) manage it.
//   Providers and projects can be shared with a whole workspace.
// Projects: instructions, a default model and their own chats. A project is private (kept in its owner's encrypted
//   files, by the app) until it's shared; then it lives here, and everyone it's shared with can open it and add chats.
//
// What several accounts open together can't be locked with one person's password, so it's sealed with the server's
// key (server.key, the same one shared providers use) — readable by whoever controls the server's disk.
'use strict';
const crypto = require('node:crypto');
const C = require('./crypto');
const { tx } = require('./db');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deny = (msg, status = 403) => Object.assign(new Error(msg), { status });
const now = () => Date.now();

class Collab {
  constructor(db, serverKey) { this.db = db; this.key = serverKey; }
  seal(obj) { return C.seal(this.key, Buffer.from(JSON.stringify(obj))); }
  open(blob) { return JSON.parse(C.open(this.key, Buffer.from(blob)).toString('utf8')); }

  /* ---------- who may open something: 'all' (every signed-in account) or { users: [ids], workspaces: [ids] } ---------- */
  static cleanAudience(a, { userId, workspaceIds }) {
    if (a === 'all' || a?.everyone) return 'all';
    const users = [...new Set((Array.isArray(a?.users) ? a.users : []).map(String))].slice(0, 500);
    const workspaces = [...new Set((Array.isArray(a?.workspaces) ? a.workspaces : []).map(String))].filter(id => workspaceIds.includes(id)).slice(0, 50);
    return { users: users.filter(u => u !== userId), workspaces };
  }
  allowed(audience, user) {
    if (audience === 'all') return true;
    if (audience?.users?.includes(user.id)) return true;
    return (audience?.workspaces || []).some(w => this.isMember(w, user.id));
  }

  /* ---------- workspaces ---------- */
  workspacesOf(userId) {
    return this.db.prepare(`SELECT w.id, w.name, w.owner_id, w.created, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.name`).all(userId);
  }
  allWorkspaces() { return this.db.prepare('SELECT id, name, owner_id, created FROM workspaces ORDER BY name').all(); }
  workspace(id) { return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(String(id)) || null; }
  members(id) { return this.db.prepare('SELECT user_id, role, added FROM workspace_members WHERE workspace_id = ? ORDER BY added').all(String(id)); }
  isMember(id, userId) { return !!this.db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(String(id), userId); }
  canManageWorkspace(ws, user) { return !!ws && (user.admin || ws.owner_id === user.id || this.db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'manager'").get(ws.id, user.id)); }
  createWorkspace(owner, name) {
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw deny('Give the workspace a name', 400);
    const id = 'ws-' + crypto.randomBytes(8).toString('hex');
    tx(this.db, () => {
      this.db.prepare('INSERT INTO workspaces (id, name, owner_id, created) VALUES (?, ?, ?, ?)').run(id, n, owner.id, now());
      this.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, added) VALUES (?, ?, 'manager', ?)").run(id, owner.id, now());
    });
    return id;
  }
  renameWorkspace(id, user, name) {
    const ws = this.workspace(id);
    if (!this.canManageWorkspace(ws, user)) throw deny("You can't manage that workspace");
    this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(String(name || '').trim().slice(0, 60) || ws.name, ws.id);
  }
  setMember(id, actor, target, role) {
    const ws = this.workspace(id);
    if (!this.canManageWorkspace(ws, actor)) throw deny("You can't manage that workspace");
    if (role === null) {
      if (target.id === ws.owner_id) throw deny("The workspace's owner can't be removed", 400);
      this.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(ws.id, target.id);
    } else {
      this.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, added) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role')
        .run(ws.id, target.id, role === 'manager' ? 'manager' : 'member', now());
    }
  }
  leaveWorkspace(id, user) {
    const ws = this.workspace(id);
    if (!ws) return;
    if (ws.owner_id === user.id) throw deny('You own this workspace: delete it instead, or make someone else its owner', 400);
    this.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(ws.id, user.id);
  }
  deleteWorkspace(id, user) {
    const ws = this.workspace(id);
    if (!ws) return;
    if (!(user.admin || ws.owner_id === user.id)) throw deny('Only its owner or an admin can delete a workspace');
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
  }

  /* ---------- conversation links ---------- */
  createShare(owner, { chat, images, audience, title }) {
    const id = crypto.randomUUID();
    const t = now();
    this.db.prepare('INSERT INTO conversation_shares (id, owner_id, chat_id, title, audience, data, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, owner.id, String(chat.id || ''), String(title || chat.title || 'Conversation').slice(0, 120), JSON.stringify(audience), this.seal({ chat, images }), t, t);
    return id;
  }
  shareRow(id) { return UUID.test(String(id)) ? this.db.prepare('SELECT * FROM conversation_shares WHERE id = ?').get(String(id)) || null : null; }
  updateShare(id, owner, { chat, images, audience, title }) {
    const r = this.shareRow(id);
    if (!r || r.owner_id !== owner.id) throw deny("That link isn't yours", 404);
    if (chat) this.db.prepare('UPDATE conversation_shares SET data = ?, title = ?, updated = ? WHERE id = ?').run(this.seal({ chat, images }), String(title || chat.title || r.title).slice(0, 120), now(), r.id);
    if (audience) this.db.prepare('UPDATE conversation_shares SET audience = ? WHERE id = ?').run(JSON.stringify(audience), r.id);
  }
  deleteShare(id, actor) {
    const r = this.shareRow(id);
    if (!r) return;
    if (r.owner_id !== actor.id && !actor.admin) throw deny("That link isn't yours");
    this.db.prepare('DELETE FROM conversation_shares WHERE id = ?').run(r.id);
  }
  sharesOf(ownerId) {
    return this.db.prepare('SELECT id, chat_id, title, audience, created, updated, views FROM conversation_shares WHERE owner_id = ? ORDER BY updated DESC').all(ownerId)
      .map(r => ({ id: r.id, chatId: r.chat_id, title: r.title, audience: JSON.parse(r.audience), created: r.created, updated: r.updated, views: r.views }));
  }
  allShares() {
    return this.db.prepare('SELECT id, owner_id, title, audience, created, updated, views FROM conversation_shares ORDER BY updated DESC').all()
      .map(r => ({ id: r.id, ownerId: r.owner_id, title: r.title, audience: JSON.parse(r.audience), created: r.created, updated: r.updated, views: r.views }));
  }
  /** a viewer opens a link: the copy, if they're allowed (the owner always is) */
  viewShare(id, viewer) {
    const r = this.shareRow(id);
    if (!r) throw deny('This link doesn’t exist anymore. Its owner may have stopped sharing it.', 404);
    const audience = JSON.parse(r.audience);
    if (r.owner_id !== viewer.id && !this.allowed(audience, viewer)) throw deny("This conversation wasn't shared with your account.");
    if (r.owner_id !== viewer.id) this.db.prepare('UPDATE conversation_shares SET views = views + 1 WHERE id = ?').run(r.id);
    const { chat, images } = this.open(r.data);
    return { id: r.id, ownerId: r.owner_id, title: r.title, created: r.created, updated: r.updated, chat, images, mine: r.owner_id === viewer.id };
  }

  /* ---------- shared projects ---------- */
  projectAccess(id) {
    const rows = this.db.prepare('SELECT kind, target_id FROM project_access WHERE project_id = ?').all(String(id));
    if (rows.some(r => r.kind === 'all')) return 'all';
    return { users: rows.filter(r => r.kind === 'user').map(r => r.target_id), workspaces: rows.filter(r => r.kind === 'workspace').map(r => r.target_id) };
  }
  setProjectAccess(id, audience) {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM project_access WHERE project_id = ?').run(id);
      const add = this.db.prepare('INSERT INTO project_access (project_id, kind, target_id) VALUES (?, ?, ?)');
      if (audience === 'all') add.run(id, 'all', '*');
      else { for (const u of audience.users) add.run(id, 'user', u); for (const w of audience.workspaces) add.run(id, 'workspace', w); }
    });
  }
  projectRow(id) { return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(String(id)) || null; }
  canOpenProject(row, user) { return !!row && (row.owner_id === user.id || this.allowed(this.projectAccess(row.id), user)); }
  /** projects an account can open (its own shared ones, and ones shared with it): without their chats */
  projectsFor(user) {
    return this.db.prepare('SELECT id, owner_id, name, updated FROM projects ORDER BY name').all().filter(r => this.canOpenProject(r, user)).map(r => {
      const d = this.open(this.projectRow(r.id).data);
      return { id: r.id, ownerId: r.owner_id, name: r.name, updated: r.updated, instructions: d.instructions || '', model: d.model || '', description: d.description || '',
        chats: (d.chats || []).map(c => ({ id: c.id, title: c.title, updated: c.updated || 0, author: c.author || '' })), access: this.projectAccess(r.id), provider: d.provider || null };
    });
  }
  project(id, user) {
    const r = this.projectRow(id);
    if (!this.canOpenProject(r, user)) throw deny("That project isn't shared with you", 404);
    return { id: r.id, ownerId: r.owner_id, name: r.name, updated: r.updated, access: this.projectAccess(r.id), ...this.open(r.data) };
  }
  /** a private project becomes shared: it (and its chats) move here */
  createProject(owner, p, audience) {
    const id = /^proj-[\w-]{4,40}$/.test(String(p.id || '')) ? p.id : 'proj-' + crypto.randomBytes(8).toString('hex');
    if (this.projectRow(id)) throw deny('That project is already shared', 400);
    const data = { description: String(p.description || '').slice(0, 1000), instructions: String(p.instructions || '').slice(0, 20000), model: String(p.model || '').slice(0, 300),
      chats: (Array.isArray(p.chats) ? p.chats : []).slice(0, 500).map(c => ({ ...c, projectId: id, author: c.author || owner.id })), provider: null, images: p.images || {} };
    tx(this.db, () => {
      this.db.prepare('INSERT INTO projects (id, owner_id, name, data, created, updated) VALUES (?, ?, ?, ?, ?, ?)').run(id, owner.id, String(p.name || 'Project').slice(0, 60), this.seal(data), now(), now());
      this.setProjectAccess(id, audience);
    });
    return id;
  }
  /** change a shared project: its owner changes anything; members add and edit chats */
  updateProject(id, user, patch) {
    const r = this.projectRow(id);
    if (!this.canOpenProject(r, user)) throw deny("That project isn't shared with you", 404);
    const owner = r.owner_id === user.id;
    const d = this.open(r.data);
    let name = r.name;
    if (owner) {
      if (patch.name !== undefined) name = String(patch.name).trim().slice(0, 60) || name;
      for (const k of ['description', 'instructions', 'model']) if (patch[k] !== undefined) d[k] = String(patch[k]).slice(0, k === 'instructions' ? 20000 : 1000);
      if (patch.provider !== undefined) d.provider = patch.provider;
    } else if (['name', 'description', 'instructions', 'model', 'provider'].some(k => patch[k] !== undefined)) throw deny('Only the project’s owner can change its settings');
    if (patch.chat) {
      const c = patch.chat, i = (d.chats ||= []).findIndex(x => x.id === c.id);
      if (i >= 0) d.chats[i] = { ...c, projectId: id, author: d.chats[i].author }; else { if (d.chats.length >= 500) throw deny('This project has all the chats it can hold', 400); d.chats.push({ ...c, projectId: id, author: user.id }); }
    }
    if (patch.images) Object.assign((d.images ||= {}), patch.images);
    if (patch.deleteChat) {
      const c = (d.chats || []).find(x => x.id === patch.deleteChat);
      if (c && !(owner || c.author === user.id)) throw deny('Only the person who started a chat (or the project’s owner) can delete it');
      d.chats = (d.chats || []).filter(x => x.id !== patch.deleteChat);
    }
    this.db.prepare('UPDATE projects SET name = ?, data = ?, updated = ? WHERE id = ?').run(name, this.seal(d), now(), r.id);
    if (owner && patch.audience) this.setProjectAccess(r.id, patch.audience);
    return this.project(id, user);
  }
  /** stop sharing: the owner gets everything back (to keep privately); the shared copy is removed */
  unshareProject(id, user) {
    const r = this.projectRow(id);
    if (!r) throw deny('No such project', 404);
    if (r.owner_id !== user.id && !user.admin) throw deny('Only the project’s owner can stop sharing it');
    const full = { id: r.id, name: r.name, ...this.open(r.data) };
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(r.id);
    return full;
  }
  allProjects() { return this.db.prepare('SELECT id, owner_id, name, updated FROM projects ORDER BY updated DESC').all(); }
}

module.exports = { Collab, UUID };
