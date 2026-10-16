// The Noctyl folder: one visible place for things that should outlive the app's own storage.
//
//   <Noctyl folder>/            default: your home folder\Noctyl (change it in Settings → Data & Privacy → Storage)
//     skills/   one .md file per quick skill   (synced both ways with the app; you can edit or drop files here)
//     agents/   one .md file per agent         (same)
//     models/   GGUF models downloaded from Hugging Face
//     llama.cpp/ the llama.cpp build Noctyl installs
//
// GGUF files you add yourself (Providers → Local Models) stay where they are; nothing is moved or copied.
'use strict';
const { app, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CFG = () => path.join(app.getPath('userData'), 'appdir.json');
const DEFAULT_DIR = () => path.join(os.homedir(), 'Noctyl');
// before the rename to Noctyl the default folder was ~/Hacky. adoptPreRenameDir() renames it to ~/Noctyl at startup;
// if that can't happen yet (a file in it is open, e.g. a running llama-server), ~/Hacky keeps being used and the
// rename is tried again on the next launch.
const PRE_RENAME_DIR = () => path.join(os.homedir(), 'Hacky');
// Windows and macOS (by default) don't tell "Noctyl" from "noctyl" in a path; Linux does
const pathKey = p => (process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => pathKey(a) === pathKey(b);

function appDir() {
  const env = process.env.NOCTYL_APP_DIR || process.env.HACKY_APP_DIR;   // separate folder (testing)
  if (env && path.isAbsolute(env)) return env;
  try {
    const p = JSON.parse(fs.readFileSync(CFG(), 'utf8')).path;
    if (typeof p === 'string' && path.isAbsolute(p)) return p;
  } catch { /* default */ }
  if (!fs.existsSync(DEFAULT_DIR()) && fs.existsSync(PRE_RENAME_DIR())) return PRE_RENAME_DIR();
  return DEFAULT_DIR();
}
const sub = name => path.join(appDir(), name);

/** Rename ~/Hacky to ~/Noctyl, when it's the folder in use (the default, or chosen by hand) and ~/Noctyl doesn't exist yet.
    A rename on the same drive moves everything at once (no copying), so skills, agents, models and llama.cpp come along. */
function adoptPreRenameDir() {
  if (process.env.NOCTYL_APP_DIR || process.env.HACKY_APP_DIR) return;
  const old = PRE_RENAME_DIR(), now = DEFAULT_DIR();
  let chosen = null;
  try { chosen = JSON.parse(fs.readFileSync(CFG(), 'utf8')).path; } catch { /* none chosen */ }
  if (typeof chosen === 'string' && !samePath(chosen, old)) return;   // a different folder was picked: leave it alone
  if (!fs.existsSync(old) || fs.existsSync(now)) return;
  try {
    fs.renameSync(old, now);
    if (chosen) fs.writeFileSync(CFG(), JSON.stringify({ path: now }));
    refreshReadme(now);
  } catch (e) { console.error('[Noctyl] could not rename ~/Hacky to ~/Noctyl yet; trying again next launch', e.code || e); }
}

const README = `This is your Noctyl folder.

skills\\        Skills: how to do a task, step by step, that Noctyl looks up when it fits.
                One folder per skill with a SKILL.md inside (plus optional scripts\\, references\\ and
                templates\\), or just a .md file. Add, edit or delete them here or in Noctyl.
quick-skills\\  Quick skills: saved prompts you run with /command, one .md file each.
agents\\        Agents, one .md file each.
models\\        GGUF models downloaded from Hugging Face.
llama.cpp\\     The llama.cpp build Noctyl installed.

Models you add from elsewhere on your computer stay where they are.
Your conversations are not stored here; they stay inside Noctyl.
`;

/** Write the folder's README.txt if it's missing or an older version (before the rename, or before quick-skills\). */
function refreshReadme(dir) {
  const readme = path.join(dir, 'README.txt');
  let cur = null;
  try { cur = fs.readFileSync(readme, 'utf8'); } catch { /* missing */ }
  if (cur === null || (/^This is your (Hacky|Noctyl) folder\./.test(cur) && !cur.includes('quick-skills'))) fs.writeFileSync(readme, README);
}

/* Quick skills used to live in skills\ (flat .md files that Noctyl writes with a `command:` line). skills\ now holds
   Skills, so those files move to quick-skills\ once. Anything else in skills\ (a file you added, a folder) stays. */
function migrateQuickSkills() {
  const from = sub('skills'), to = sub('quick-skills');
  if (fs.existsSync(to)) return;
  fs.mkdirSync(to, { recursive: true });
  let names = [];
  try { names = fs.readdirSync(from); } catch { return; }
  for (const n of names.filter(x => x.toLowerCase().endsWith('.md'))) {
    const p = path.join(from, n);
    try {
      if (!fs.statSync(p).isFile()) continue;
      if (!/^command:/m.test(fromFile(fs.readFileSync(p, 'utf8')).raw || '')) continue;
      fs.renameSync(p, path.join(to, n));
    } catch (e) { console.error('[Noctyl] could not move quick skill', n, e.code || e); }
  }
}

function ensure() {
  migrateQuickSkills();
  for (const d of ['skills', 'quick-skills', 'agents', 'models']) fs.mkdirSync(sub(d), { recursive: true });
  refreshReadme(appDir());
  return appDir();
}

function setDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Pick a folder');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CFG(), JSON.stringify({ path: dir }));
  return ensure();
}

/* ---------- front-matter files: ---\nkey: value\n---\nbody ---------- */
function toFile(meta, body) {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) =>
    `${k}: ${typeof v === 'string' && /^[\w .,()/&+-]*$/.test(v) && v.trim() === v && !/^(true|false|\d+(\.\d+)?)$/.test(v) ? v : JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${String(body || '').replace(/\r\n/g, '\n')}${String(body || '').endsWith('\n') ? '' : '\n'}`;
}
function fromFile(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$|^\[.*\]$|^\{.*\}$/.test(v)) { try { v = JSON.parse(v); } catch { /* keep text */ } }
    else if (v === 'true' || v === 'false') v = v === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2].replace(/\n$/, ''), raw: m[1] };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 64);

async function readDir(dir) {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const n of names.filter(x => x.toLowerCase().endsWith('.md')).sort()) {
    try {
      const st = await fsp.stat(path.join(dir, n));
      if (!st.isFile() || st.size > 256 * 1024) continue;
      out.push({ file: n, ...fromFile(await fsp.readFile(path.join(dir, n), 'utf8')) });
    } catch { /* unreadable file: skip */ }
  }
  return out;
}
/** Write files for `items` ({ file, text }); remove other .md files in that folder (they were deleted in the app). */
async function writeDir(dir, items) {
  await fsp.mkdir(dir, { recursive: true });
  const keep = new Set(items.map(i => i.file.toLowerCase()));
  for (const { file, text } of items) {
    const p = path.join(dir, file);
    let old = null;
    try { old = await fsp.readFile(p, 'utf8'); } catch { /* new */ }
    if (old !== text) await fsp.writeFile(p, text, 'utf8');
  }
  for (const n of await fsp.readdir(dir)) if (n.toLowerCase().endsWith('.md') && !keep.has(n.toLowerCase())) await fsp.rm(path.join(dir, n), { force: true });
}

/* ---------- quick skills (quick-skills/*.md) ---------- */
async function readSkills() {
  ensure();
  return (await readDir(sub('quick-skills'))).map(({ file, meta, body }) => {
    const id = slug(meta.command || file.replace(/\.md$/i, ''));
    return SLUG.test(id) && body.trim() ? {
      id, label: String(meta.name || id).slice(0, 60), desc: String(meta.description || '').slice(0, 140),
      category: String(meta.category || 'General').slice(0, 30), pinned: meta.pinned === true, order: Number(meta.order) || 0, prompt: body.slice(0, 4000),
    } : null;
  }).filter(Boolean).sort((a, b) => a.order - b.order);
}
async function writeSkills(list) {
  if (!Array.isArray(list)) throw new Error('Bad skills');
  const items = list.slice(0, 300).map((s, i) => {
    const id = slug(s.id);
    if (!SLUG.test(id)) return null;
    return { file: id + '.md', text: toFile({ name: String(s.label || id), command: id, category: String(s.category || 'General'), description: String(s.desc || ''), pinned: !!s.pinned, order: i + 1 }, String(s.prompt || '')) };
  }).filter(Boolean);
  ensure();
  await writeDir(sub('quick-skills'), items);
  return true;
}

/* ---------- agents ---------- */
async function readAgents() {
  return (await readDir(sub('agents'))).map(({ file, meta, body }) => (body.trim() && meta.name ? {
    id: /^agent-[\w-]{1,40}$/.test(String(meta.id || '')) ? meta.id : 'agent-' + slug(meta.name || file.replace(/\.md$/i, '')),
    name: String(meta.name).slice(0, 40), desc: String(meta.description || '').slice(0, 140), model: String(meta.model || ''),
    maxSteps: Math.min(Math.max(Number(meta.maxSteps) || 8, 1), 20), order: Number(meta.order) || 0,
    tools: { web: meta.web === true, mcp: meta.mcp !== false, commands: meta.commands !== false, subagents: meta.subagents !== false },
    instructions: body.slice(0, 8000),
  } : null)).filter(Boolean).sort((a, b) => a.order - b.order);
}
async function writeAgents(list) {
  if (!Array.isArray(list)) throw new Error('Bad agents');
  const used = new Set();
  const items = list.slice(0, 100).map((a, i) => {
    let base = slug(a.name) || 'agent', name = base, n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    const t = a.tools || {};
    return { file: name + '.md', text: toFile({ id: a.id, name: a.name, description: a.desc || '', model: a.model || '', maxSteps: a.maxSteps, web: !!t.web, mcp: t.mcp !== false, commands: t.commands !== false, subagents: t.subagents !== false, order: i + 1 }, a.instructions || '') };
  });
  await writeDir(sub('agents'), items);
  return true;
}

/* ---------- Skills: skills/<name>/SKILL.md (plus scripts/, references/, templates/, assets/), or skills/<name>.md ----------
   A skill is know-how for one kind of task: when to use it, the steps, the pitfalls, how to check it worked. Noctyl
   lists them for the model, which loads one when it fits; you or the model can add and improve them. The folder is the
   only copy: it's read when needed and written one skill at a time (never the whole folder), so anything you add or
   edit here by hand is left alone. A skill's name is its folder (or file) name, lower-case with dashes. */
const SKILL_MAX = 64 * 1024, SKILL_FILE_MAX = 200 * 1024, SKILL_FILES_MAX = 20;
const SKILL_FILE_PATH = /^(scripts|references|templates|assets)(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,80}){1,3}$/;
const skillsDir = () => sub('skills');
const inside = (parent, child) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** Where a skill is on disk: { name, kind: 'dir' | 'file', dir, file }, or null. Folder and file names are matched by
    their slug, so a folder you named "Deploy Site" is the skill deploy-site. */
function findSkill(name) {
  if (!SLUG.test(String(name || ''))) return null;
  let entries = [];
  try { entries = fs.readdirSync(skillsDir(), { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isDirectory() && slug(e.name) === name) {
      const dir = path.join(skillsDir(), e.name);
      const md = ['SKILL.md', 'skill.md', 'Skill.md'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
      if (md) return { name, kind: 'dir', dir, file: md };
    }
  }
  for (const e of entries) {
    if (e.isFile() && /\.md$/i.test(e.name) && slug(e.name.replace(/\.md$/i, '')) === name) return { name, kind: 'file', dir: null, file: path.join(skillsDir(), e.name) };
  }
  return null;
}

/** Supporting files of a folder skill (relative, forward slashes), not SKILL.md itself. */
function skillFiles(dir) {
  const out = [];
  const walk = (d, rel, depth) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= 50 || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) walk(path.join(d, e.name), r, depth + 1);
      else if (e.isFile() && !(depth === 0 && /^skill\.md$/i.test(e.name))) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out.sort();
}

const today = () => new Date().toISOString().slice(0, 10);
function skillSummary(loc, meta, body, stat) {
  const firstPara = (body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith('#')) || '').replace(/\s+/g, ' ');
  const tags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? meta.tags.split(',') : [];
  return {
    name: loc.name,
    title: String(meta.title || (/^#\s+(.+)$/m.exec(body) || [])[1] || loc.name).trim().slice(0, 80),
    description: String(meta.description || firstPara).trim().slice(0, 300),
    whenToUse: String(meta.when_to_use || meta.whenToUse || '').trim().slice(0, 300),
    tags: tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8),
    author: meta.author === 'noctyl' ? 'noctyl' : 'you',
    created: String(meta.created || ''), updated: String(meta.updated || '') || new Date(stat.mtimeMs).toISOString().slice(0, 10),
    kind: loc.kind, files: loc.kind === 'dir' ? skillFiles(loc.dir) : [], size: stat.size,
  };
}
async function readSkillAt(loc) {
  const stat = await fsp.stat(loc.file);
  if (stat.size > SKILL_MAX) throw new Error(`${loc.name}'s SKILL.md is over 64 KB`);
  const text = await fsp.readFile(loc.file, 'utf8');
  const { meta, body } = fromFile(text);
  return { ...skillSummary(loc, meta, body, stat), body, text };
}

/** Every skill in the folder (summaries only, no bodies). Unreadable or oversized ones are skipped. */
async function listSkillDocs() {
  ensure();
  let entries = [];
  try { entries = await fsp.readdir(skillsDir(), { withFileTypes: true }); } catch { return []; }
  const seen = new Set(), out = [];
  const names = [...entries.filter(e => e.isDirectory()), ...entries.filter(e => e.isFile() && /\.md$/i.test(e.name))]
    .map(e => slug(e.isFile() ? e.name.replace(/\.md$/i, '') : e.name)).filter(n => SLUG.test(n));
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const loc = findSkill(n);
    if (!loc) continue;
    try { const { body, text, ...summary } = await readSkillAt(loc); out.push(summary); } catch { /* skip */ }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** One skill in full: its summary, body (Markdown after the front matter) and the whole file text. */
async function readSkillDoc(name) {
  const loc = findSkill(String(name || ''));
  if (!loc) throw new Error(`There's no skill called ${name}`);
  return readSkillAt(loc);
}

/** A supporting file's text (scripts/…, references/…, templates/…, assets/…), from inside that skill's folder only. */
async function readSkillFile(name, rel) {
  const loc = findSkill(String(name || ''));
  if (!loc || loc.kind !== 'dir') throw new Error(`${name} has no supporting files`);
  if (!SKILL_FILE_PATH.test(String(rel || ''))) throw new Error('Not a skill file path');
  const p = path.join(loc.dir, ...rel.split('/'));
  const real = await fsp.realpath(p).catch(() => null);
  if (!real || !inside(await fsp.realpath(loc.dir), real)) throw new Error(`${name} has no file ${rel}`);
  const st = await fsp.stat(real);
  if (st.size > SKILL_FILE_MAX) throw new Error(`${rel} is too big to read (over 200 KB)`);
  return fsp.readFile(real, 'utf8');
}

/** Create or replace a skill. { name, previousName?, meta: { title, description, when_to_use, tags, author }, body,
    files?: [{ path, content }] }. Supporting files are only written under scripts/, references/, templates/ or assets/
    inside the skill's own folder. Returns the saved skill's summary. */
async function saveSkillDoc(req) {
  ensure();
  const name = slug(req?.name);
  if (!SLUG.test(name)) throw new Error('Give the skill a name (letters, numbers and dashes)');
  const body = String(req?.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('The skill needs some content');
  const files = Array.isArray(req?.files) ? req.files : [];
  if (files.length > SKILL_FILES_MAX) throw new Error(`A skill can have up to ${SKILL_FILES_MAX} supporting files`);
  for (const f of files) {
    if (!SKILL_FILE_PATH.test(String(f?.path || ''))) throw new Error(`Supporting files go in scripts/, references/, templates/ or assets/ (got "${String(f?.path || '').slice(0, 80)}")`);
    if (typeof f.content !== 'string' || Buffer.byteLength(f.content) > SKILL_FILE_MAX) throw new Error(`${f.path} must be text up to 200 KB`);
  }
  // renaming: move the existing skill first (refused if the new name is taken)
  const prev = req?.previousName ? slug(req.previousName) : name;
  let loc = findSkill(prev);
  if (prev !== name) {
    if (findSkill(name)) throw new Error(`There's already a skill called ${name}`);
    if (loc) {
      const to = loc.kind === 'dir' ? path.join(skillsDir(), name) : path.join(skillsDir(), name + '.md');
      await fsp.rename(loc.kind === 'dir' ? loc.dir : loc.file, to);
      loc = findSkill(name);
    }
  }
  let old = {};
  if (loc) { try { old = fromFile(await fsp.readFile(loc.file, 'utf8')).meta; } catch { /* unreadable: start over */ } }
  const m = req?.meta || {};
  const tags = (Array.isArray(m.tags) ? m.tags : String(m.tags || '').split(',')).map(t => slug(t)).filter(Boolean).slice(0, 8);
  const text = toFile({
    name, title: String(m.title || '').trim().slice(0, 80), description: String(m.description || '').trim().slice(0, 300),
    when_to_use: String(m.when_to_use || '').trim().slice(0, 300), tags: tags.length ? tags : undefined,
    author: m.author === 'noctyl' || (!m.author && old.author === 'noctyl') ? 'noctyl' : 'you',
    created: String(old.created || today()), updated: today(),
  }, body);
  if (Buffer.byteLength(text) > SKILL_MAX) throw new Error('A skill can be up to 64 KB');

  const writeAtomic = async (file, content) => {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, file);
  };
  if (loc?.kind === 'file' && !files.length) {
    await writeAtomic(loc.file, text);   // a one-file skill stays one file
  } else {
    const dir = loc?.kind === 'dir' ? loc.dir : path.join(skillsDir(), name);
    await fsp.mkdir(dir, { recursive: true });
    const realDir = await fsp.realpath(dir);
    if (!inside(await fsp.realpath(skillsDir()), realDir)) throw new Error('That skill folder is outside the skills folder');
    await writeAtomic(path.join(dir, loc?.kind === 'dir' ? path.basename(loc.file) : 'SKILL.md'), text);
    for (const f of files) {
      const p = path.join(realDir, ...f.path.split('/'));
      await fsp.mkdir(path.dirname(p), { recursive: true });
      if (!inside(realDir, await fsp.realpath(path.dirname(p)))) throw new Error(`${f.path} is outside the skill's folder`);
      await writeAtomic(p, f.content.replace(/\r\n/g, '\n'));
    }
    if (loc?.kind === 'file') await fsp.rm(loc.file, { force: true });   // now a folder skill: its old one-file copy goes
  }
  const { body: _b, text: _t, ...summary } = await readSkillAt(findSkill(name));
  return summary;
}

/** The path to move to the trash when a skill is deleted (the folder, or the one file). */
function skillDocPath(name) {
  const loc = findSkill(String(name || ''));
  if (!loc) throw new Error(`There's no skill called ${name}`);
  return loc.kind === 'dir' ? loc.dir : loc.file;
}

/* ---------- Hugging Face downloads (public models, no account) ---------- */
const downloads = new Map();   // id → AbortController
const REPO = /^[\w.-]{1,96}\/[\w.-]{1,96}$/;
const FILE = /^(?!\/)(?!.*\.\.)[\w./ +()-]{1,240}\.gguf$/i;

/** Download `file` (and its other parts if it's split) from a public Hugging Face repo into models/. */
async function hfDownload({ id, repo, file }, onProgress) {
  if (!REPO.test(String(repo)) || !FILE.test(String(file))) throw new Error('Not a GGUF file on Hugging Face');
  const split = /^(.*-)(\d{5})-of-(\d{5})\.gguf$/i.exec(file);
  const files = split ? Array.from({ length: Number(split[3]) }, (_, i) => `${split[1]}${String(i + 1).padStart(5, '0')}-of-${split[3]}.gguf`) : [file];
  const dir = path.join(sub('models'), repo.replace('/', '__'));
  const ac = new AbortController();
  downloads.set(id, ac);
  const done = [];
  try {
    await fsp.mkdir(dir, { recursive: true });
    let total = 0, got = 0;
    const sizes = [];
    for (const f of files) {   // sizes first, for one overall progress bar
      const head = await net.fetch(`https://huggingface.co/${repo}/resolve/main/${f.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', redirect: 'follow' });
      if (head.status === 401 || head.status === 403) throw new Error('This model needs a Hugging Face account to download (it is gated). Pick a public one.');
      if (!head.ok) throw new Error(`Hugging Face answered HTTP ${head.status} for ${f}`);
      const n = Number(head.headers.get('x-linked-size') || head.headers.get('content-length')) || 0;
      sizes.push(n); total += n;
    }
    const free = await fsp.statfs?.(dir).then(s => s.bavail * s.bsize).catch(() => null);
    if (free != null && total && free < total + 512 * 1024 * 1024) throw new Error(`Not enough free disk space (needs ${(total / 1e9).toFixed(1)} GB)`);
    for (const [i, f] of files.entries()) {
      const dest = path.join(dir, path.basename(f));
      if (!dest.startsWith(dir + path.sep)) throw new Error('Bad file name');
      if (fs.existsSync(dest) && sizes[i] && fs.statSync(dest).size === sizes[i]) { got += sizes[i]; done.push(dest); continue; }   // already have it
      const res = await net.fetch(`https://huggingface.co/${repo}/resolve/main/${f.split('/').map(encodeURIComponent).join('/')}`, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'This model needs a Hugging Face account to download (it is gated).' : `Download failed: HTTP ${res.status}`);
      const part = dest + '.part';
      const out = fs.createWriteStream(part);
      const reader = res.body.getReader();
      let last = 0;
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          got += value.length;
          if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
          if (Date.now() - last > 200) { last = Date.now(); onProgress?.({ id, fraction: total ? got / total : null, got, total, file: f }); }
        }
      } finally { await new Promise(r => out.end(r)); }
      await fsp.rename(part, dest);
      done.push(dest);
    }
    onProgress?.({ id, fraction: 1, got: total, total });
    return { paths: done, main: done[0], size: total, dir };
  } catch (e) {
    for (const f of files) await fsp.rm(path.join(dir, path.basename(f)) + '.part', { force: true }).catch(() => {});
    if (ac.signal.aborted) throw new Error('Download canceled');
    throw e;
  } finally { downloads.delete(id); }
}
const hfCancel = id => downloads.get(id)?.abort();

module.exports = {
  appDir, adoptPreRenameDir, ensure, setDir, readSkills, writeSkills, readAgents, writeAgents, hfDownload, hfCancel, DEFAULT_DIR,
  listSkillDocs, readSkillDoc, readSkillFile, saveSkillDoc, skillDocPath,
};
