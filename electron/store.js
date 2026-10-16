// Noctyl's own data on disk (desktop): settings, preferences, conversations and their images.
//
// Lives in Electron's per-user app data folder, which is the right place on each system:
//   Windows  %APPDATA%\Noctyl\data
//   macOS    ~/Library/Application Support/Noctyl/data
//   Linux    ~/.config/Noctyl/data        ($XDG_CONFIG_HOME if set)
//
//   data/settings.json    your settings
//   data/ui.json          small view preferences (sidebar open, …)
//   data/chats/<id>.json  one file per conversation
//   data/images/<id>.json one file per attached image (re-encoded JPEG as a data URL + size)
//
// Every write goes to a temporary file first and then replaces the real one, so a crash or power cut can't leave
// a half-written file. Only files whose content changed are written. Skills and agents are kept in the Noctyl
// folder instead (see appdir.js), where you can see and edit them.
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = () => path.join(app.getPath('userData'), 'data');
const CHATS = () => path.join(DATA(), 'chats');
const IMAGES = () => path.join(DATA(), 'images');
const SAFE = /^[A-Za-z0-9_-]{1,80}$/;
/** file name for an id; odd ids (from imported files) get a hash so they can never escape the folder */
const fileFor = id => (SAFE.test(String(id)) ? String(id) : 'x' + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 40)) + '.json';

const written = new Map();   // file path → the JSON text last written (or read), to skip unchanged files

/* ---------- atomic writes (temp file + rename), with a short retry for Windows file locks (antivirus, indexer) ---------- */
function writeAtomicSync(file, text) {
  if (written.get(file) === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); break; }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
      const until = Date.now() + 15 * (i + 1); while (Date.now() < until) { /* brief wait */ }
    }
  }
  written.set(file, text);
}
async function writeAtomic(file, text) {
  if (written.get(file) === text) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, file); break; }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
      await new Promise(r => setTimeout(r, 25 * (i + 1)));
    }
  }
  written.set(file, text);
}
function readJsonSync(file) {
  try { const text = fs.readFileSync(file, 'utf8'); written.set(file, text); return JSON.parse(text); }
  catch { return null; }
}
function cleanTmp(dir) {   // leftovers from an interrupted write
  try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.tmp')) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* none */ }
}

/* ---------- settings + preferences + chats ---------- */
/** Everything, read synchronously at start (the page needs it before it draws). exists: false = nothing saved yet. */
function loadSync() {
  const settingsFile = path.join(DATA(), 'settings.json');
  const exists = fs.existsSync(settingsFile);
  cleanTmp(DATA()); cleanTmp(CHATS());
  const chats = [];
  try {
    for (const n of fs.readdirSync(CHATS())) {
      if (!n.endsWith('.json')) continue;
      const c = readJsonSync(path.join(CHATS(), n));
      if (c && typeof c === 'object' && Array.isArray(c.messages)) chats.push(c);
    }
  } catch { /* no chats yet */ }
  return { exists, settings: readJsonSync(settingsFile) || {}, ui: readJsonSync(path.join(DATA(), 'ui.json')) || {}, chats, dir: DATA() };
}

/** Save the whole store; only changed files are written, chats that are gone are removed. */
function plan(data) {
  const files = [
    [path.join(DATA(), 'settings.json'), JSON.stringify(data.settings ?? {}, null, 1)],
    [path.join(DATA(), 'ui.json'), JSON.stringify(data.ui ?? {}, null, 1)],
  ];
  const keep = new Set();
  for (const c of Array.isArray(data.chats) ? data.chats : []) {
    if (!c || typeof c !== 'object') continue;
    const f = path.join(CHATS(), fileFor(c.id));
    keep.add(path.basename(f));
    files.push([f, JSON.stringify(c)]);
  }
  return { files, keep };
}
function removeOtherChatsSync(keep) {
  try { for (const n of fs.readdirSync(CHATS())) if (n.endsWith('.json') && !keep.has(n)) { fs.rmSync(path.join(CHATS(), n), { force: true }); written.delete(path.join(CHATS(), n)); } } catch { /* none */ }
}
let saving = Promise.resolve();
function save(data) {
  // queued, so two saves never interleave
  saving = saving.then(async () => {
    const { files, keep } = plan(data);
    for (const [f, text] of files) await writeAtomic(f, text);
    removeOtherChatsSync(keep);
  }).catch(e => { console.error('[Noctyl] save failed', e); throw e; });
  return saving;
}
function saveSync(data) {
  const { files, keep } = plan(data);
  for (const [f, text] of files) writeAtomicSync(f, text);
  removeOtherChatsSync(keep);
  return true;
}

/* ---------- images ---------- */
const imageFile = id => path.join(IMAGES(), fileFor(id));
async function putImage(id, rec) {
  if (!rec || typeof rec.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(rec.dataUrl) || rec.dataUrl.length > 30 * 1024 * 1024) throw new Error('Bad image');
  await writeAtomic(imageFile(id), JSON.stringify({ dataUrl: rec.dataUrl, mime: String(rec.mime || ''), w: Number(rec.w) || 0, h: Number(rec.h) || 0 }));
  written.delete(imageFile(id));   // don't keep big image text in memory
  return true;
}
async function getImage(id) {
  try { return JSON.parse(await fsp.readFile(imageFile(id), 'utf8')); } catch { return null; }
}
async function imageKeys() {
  try { return (await fsp.readdir(IMAGES())).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)); } catch { return []; }
}
async function delImages(ids) { for (const id of ids) await fsp.rm(imageFile(id), { force: true }); return true; }
async function clearImages() { await fsp.rm(IMAGES(), { recursive: true, force: true }); return true; }

/** Erase everything this file manages (Settings → Erase all data). */
async function erase() {
  await saving.catch(() => {});
  await fsp.rm(DATA(), { recursive: true, force: true });
  written.clear();
  return true;
}

module.exports = { DATA, loadSync, save, saveSync, putImage, getImage, imageKeys, delImages, clearImages, erase };
