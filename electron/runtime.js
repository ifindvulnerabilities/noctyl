// Local model runtimes for the desktop app: find / start Ollama, install / run llama.cpp, GGUF files,
// and /nuke-messages. Everything here runs in the main process; the page reaches it through preload.js.
//
// - Ollama: detected by asking its HTTP API (fast), else by looking for the executable; started with `ollama serve`.
// - llama.cpp: an existing llama-server on PATH, or a copy Noctyl downloads from the official ggml-org/llama.cpp
//   GitHub releases into userData/llama.cpp. Noctyl runs one llama-server at a time for the GGUF file you pick.
// - GGUF files: only paths you chose in the file dialog (kept in userData/gguf.json) can be loaded.
// - Nuke: deletes conversations stored by Noctyl, the Ollama app and `ollama run`, clears what Ollama /
//   llama.cpp hold in memory, then a PowerShell script checks the files are gone and no message text remains.
'use strict';
const { app, dialog, net, session, BrowserWindow } = require('electron');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const home = () => os.homedir();
const userData = () => app.getPath('userData');
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
// full long path (Windows 8.3 names like CHARLE~1 make process spawning fail with ENOENT)
const real = p => { try { return fs.realpathSync.native(p); } catch { return p; } };

/** GET with a short timeout; resolves to the Response or null */
async function probe(url, ms = 600) {
  try { return await fetch(url, { signal: AbortSignal.timeout(ms) }); } catch { return null; }
}
function which(name) {
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', [name], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null : null;
  } catch { return null; }
}
const isLocalBase = u => { try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(u).hostname); } catch { return false; } };

/* =========================================================
   Ollama
   ========================================================= */
function ollamaExe() {
  const c = IS_WIN
    ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe')]
    : ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama'];
  return c.find(exists) || which('ollama');
}
async function ollamaStatus(base = 'http://127.0.0.1:11434') {
  const res = await probe(base.replace(/\/+$/, '') + '/api/version');
  const running = !!res?.ok;
  let version = '';
  if (running) try { version = (await res.json()).version || ''; } catch { /* ignore */ }
  return { running, version, exe: running ? null : ollamaExe(), local: isLocalBase(base) };
}
/* Starting Ollama.
   If the Ollama desktop app is installed, Noctyl starts (or waits for) that app, which runs its own server, the
   same as starting Ollama from the Start menu / Applications. Starting a bare `ollama serve` instead made the
   Ollama app, launched later at login, fail to start its server about once a second, flashing a console window
   each time. Only without the app (Linux, or command-line installs) does Noctyl run `ollama serve` itself. */
function ollamaAppPath() {
  if (IS_WIN) { const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe'); return exists(p) ? p : null; }
  if (process.platform === 'darwin') return exists('/Applications/Ollama.app') ? '/Applications/Ollama.app' : null;
  return null;
}
function ollamaAppRunning() {
  try {
    if (IS_WIN) return /ollama app\.exe/i.test(spawnSync('tasklist', ['/FI', 'IMAGENAME eq ollama app.exe', '/NH'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).stdout || '');
    if (process.platform === 'darwin') return spawnSync('pgrep', ['-x', 'Ollama'], { timeout: 5000 }).status === 0;
  } catch { /* can't tell */ }
  return false;
}
async function waitForOllama(base, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if ((await probe(base.replace(/\/+$/, '') + '/api/version', 500))?.ok) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}
async function startOllama(base) {
  const u = new URL(base);
  const defaultPort = !u.port || u.port === '11434';
  const app = defaultPort ? ollamaAppPath() : null;   // the app always serves on the default port
  if (app) {
    if (!ollamaAppRunning()) {
      if (IS_WIN) spawn(app, [], { detached: true, stdio: 'ignore' }).unref();
      else spawn('open', ['-a', app], { stdio: 'ignore' }).unref();
    }
    // the app (just started, or already starting at login) brings its server up; give it time
    if (await waitForOllama(base, 30)) return true;
    throw new Error("The Ollama app didn't start its server. Open Ollama and check its tray icon.");
  }
  const exe = ollamaExe();
  if (!exe) throw new Error('Ollama is not installed');
  // Windows: not "detached" (that would give the server no console, and every model runner it starts would then
  // open a visible console window); windowsHide keeps the server's own console hidden, and the runners share it.
  const child = spawn(exe, ['serve'], { detached: !IS_WIN, stdio: 'ignore', windowsHide: true, env: { ...process.env, OLLAMA_HOST: `${u.hostname}:${u.port || 11434}` } });
  child.unref();
  if (await waitForOllama(base, 20)) return true;
  throw new Error("Ollama didn't start");
}

/* =========================================================
   llama.cpp: find, install, run
   ========================================================= */
// llama.cpp lives in the Noctyl folder (…\Noctyl\llama.cpp\current). Paths are kept short on purpose:
// Windows can't start a program whose full path is longer than 260 characters (it reports "not found").
const LLAMA_DIR = () => path.join(require('./appdir').appDir(), 'llama.cpp');
const LEGACY_LLAMA_DIR = () => path.join(userData(), 'llama.cpp');   // where earlier versions installed it
function findFile(dir, name, depth = 4) {
  if (depth < 0 || !exists(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return real(p);
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), name, depth - 1); if (f) return f; }
  return null;
}
function llamaServerPath() {
  const managed = findFile(path.join(LLAMA_DIR(), 'current'), 'llama-server' + EXE) || findFile(path.join(LEGACY_LLAMA_DIR(), 'current'), 'llama-server' + EXE);
  if (managed) return { path: managed, managed: true };
  const onPath = which('llama-server');
  return onPath ? { path: real(onPath), managed: false } : null;
}

/** Release assets to try, best first, for this computer. */
function assetPatterns() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (IS_WIN) return [new RegExp(`bin-win-vulkan-${arch}\\.zip$`), new RegExp(`bin-win-cpu-${arch}\\.zip$`)];
  if (process.platform === 'darwin') return [new RegExp(`bin-macos-${arch}\\.(zip|tar\\.gz)$`)];
  return [new RegExp(`bin-ubuntu-vulkan-${arch}\\.(zip|tar\\.gz)$`), new RegExp(`bin-ubuntu-${arch}\\.(zip|tar\\.gz)$`)];
}

async function download(url, file, onProgress) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Noctyl' } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let got = 0, last = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
      if (total && Date.now() - last > 150) { last = Date.now(); onProgress?.(got / total); }
    }
  } finally { await new Promise(r => out.end(r)); }
  onProgress?.(1);
}

function extract(archive, dir) {
  // Windows 10+ and macOS ship bsdtar, which reads .zip too. Linux's GNU tar doesn't: a .zip there goes through
  // unzip, then bsdtar, then Python's zipfile (whichever this system has; minimal installs often lack unzip).
  const tries = archive.endsWith('.zip') && process.platform === 'linux'
    ? [['unzip', ['-o', '-q', archive, '-d', dir]], ['bsdtar', ['-xf', archive, '-C', dir]], ['python3', ['-m', 'zipfile', '-e', archive, dir]]]
    : [['tar', ['-xf', archive, '-C', dir]]];
  const run = ([cmd, args]) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 120000 }, err => (err ? reject(err) : resolve())));
  return tries.reduce((p, t) => p.catch(() => run(t)), Promise.reject(new Error('start')))
    .catch(err => { throw new Error(process.platform === 'linux' && archive.endsWith('.zip')
      ? `Could not unpack llama.cpp: install unzip (e.g. sudo apt install unzip) and try again (${err.message})`
      : 'Could not unpack llama.cpp: ' + err.message); });
}

/** '' when `llama-server --version` works, otherwise why it doesn't */
function whyNotRunning(exe) {
  try {
    const r = spawnSync(exe, ['--version'], { windowsHide: true, timeout: 30000, cwd: path.dirname(exe), encoding: 'utf8' });
    if (r.status === 0) return '';
    if (r.error) return IS_WIN && exe.length > 240 ? `the folder path is too long for Windows (${exe.length} characters)` : r.error.message;
    return `exit ${r.status ?? r.signal}: ${plainLog(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 200)}`;
  } catch (e) { return e.message; }
}

/** The release to install from. llama.cpp's "latest" release may be a summary that only carries nightly-tag.txt
    naming the build tag (b12345) whose release has the binaries; failing that, use the newest build that has one. */
async function pickRelease() {
  const gh = async u => {
    const r = await net.fetch(u, { headers: { 'User-Agent': 'Noctyl', Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
    return r.json();
  };
  const has = rel => Array.isArray(rel?.assets) && assetPatterns().some(re => rel.assets.some(a => re.test(a.name)));
  const latest = await gh('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  if (has(latest)) return latest;
  const pointer = latest.assets?.find(a => a.name === 'nightly-tag.txt');
  if (pointer) {
    try {
      const tag = (await (await net.fetch(pointer.browser_download_url, { headers: { 'User-Agent': 'Noctyl' } })).text()).trim();
      if (/^[\w.-]{1,40}$/.test(tag)) { const rel = await gh(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`); if (has(rel)) return rel; }
    } catch { /* fall through to the newest build */ }
  }
  const recent = await gh('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15');
  const rel = recent.find(has);
  if (!rel) throw new Error('No llama.cpp build for this computer');
  return rel;
}

let installing = null;
/** Download the latest official llama.cpp build for this computer into userData/llama.cpp/current. */
function installLlama(onProgress) {
  if (installing) return installing;
  installing = (async () => {
    onProgress?.({ phase: 'release' });
    const rel = await pickRelease();
    await fsp.mkdir(LLAMA_DIR(), { recursive: true });
    let lastErr = null;
    for (const re of assetPatterns()) {
      const asset = rel.assets.find(a => re.test(a.name) && /^https:\/\/github\.com\//.test(a.browser_download_url));
      if (!asset) continue;
      const short = crypto.randomBytes(3).toString('hex');
      const tmp = path.join(LLAMA_DIR(), 'dl-' + short + (asset.name.endsWith('.zip') ? '.zip' : '.tar.gz'));
      const stage = path.join(LLAMA_DIR(), 's-' + short);
      if (IS_WIN && path.join(LLAMA_DIR(), 'current', 'llama-server-impl.dll').length > 250) throw new Error(`The Noctyl folder path is too long for Windows to run programs from (${LLAMA_DIR()}). Pick a shorter Noctyl folder in Settings → Data & Privacy → Storage.`);
      try {
        await download(asset.browser_download_url, tmp, f => onProgress?.({ phase: 'download', fraction: f, name: asset.name }));
        onProgress?.({ phase: 'extract' });
        await fsp.mkdir(stage, { recursive: true });
        await extract(tmp, stage);
        const exe = findFile(stage, 'llama-server' + EXE);
        if (!exe) throw new Error('llama-server was not in the download');
        if (!IS_WIN) await fsp.chmod(exe, 0o755);
        const why = whyNotRunning(exe);
        if (why) throw new Error(`${asset.name} doesn't run on this computer (${why})`);   // e.g. no Vulkan driver → try the CPU build
        await fsp.rm(path.join(LLAMA_DIR(), 'current'), { recursive: true, force: true });
        await fsp.rename(stage, path.join(LLAMA_DIR(), 'current'));
        await fsp.writeFile(path.join(LLAMA_DIR(), 'version.json'), JSON.stringify({ tag: rel.tag_name, asset: asset.name, installed: new Date().toISOString() }));
        return { path: findFile(path.join(LLAMA_DIR(), 'current'), 'llama-server' + EXE), tag: rel.tag_name, asset: asset.name };
      } catch (e) {
        lastErr = e;
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    }
    throw lastErr || new Error('No llama.cpp build for this computer');
  })().finally(() => { installing = null; });
  return installing;
}

/* ---------- GGUF files you picked ---------- */
const GGUF_FILE = () => path.join(userData(), 'gguf.json');
const readGguf = () => { try { const l = JSON.parse(fs.readFileSync(GGUF_FILE(), 'utf8')); return Array.isArray(l) ? l.filter(p => typeof p === 'string') : []; } catch { return []; } };
const writeGguf = list => fs.writeFileSync(GGUF_FILE(), JSON.stringify([...new Set(list)]));

async function pickGguf(owner) {
  const r = await dialog.showOpenDialog(owner, { title: 'Add GGUF models', properties: ['openFile', 'multiSelections'], filters: [{ name: 'GGUF models', extensions: ['gguf'] }] });
  if (r.canceled) return [];
  const picked = r.filePaths.filter(p => p.toLowerCase().endsWith('.gguf'));
  writeGguf([...readGguf(), ...picked]);
  return picked.map(p => ({ path: p, name: path.basename(p).replace(/\.gguf$/i, ''), size: fs.statSync(p).size }));
}
/** GGUF files Noctyl downloaded itself (Hugging Face) are allowed to load too. */
function addGguf(paths) { writeGguf([...readGguf(), ...paths.filter(p => typeof p === 'string' && p.toLowerCase().endsWith('.gguf'))]); }
function forgetGguf(p) { writeGguf(readGguf().filter(x => x !== p)); if (server?.model === p) stopServer(); }
function ggufInfo() { return readGguf().map(p => ({ path: p, exists: exists(p) })); }

/* ---------- the one llama-server Noctyl runs for GGUF files ---------- */
let server = null;   // { child, model, port, ready: Promise }
function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('node:net').createServer();
    s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function stopServer() {
  if (!server) return;
  const { child } = server;
  server = null;
  if (child.exitCode === null) {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  }
}
/* llama-server's log has color codes and "0.11.544.760 E srv  load_model:" prefixes; turn it into something readable */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const plainLog = s => String(s || '').replace(ANSI, '').replace(/\r/g, '');
const OUT_OF_MEMORY = /ErrorOutOfDeviceMemory|unable to allocate|failed to allocate|out of memory|cudaMalloc failed|not enough memory/i;
function explainLoadFailure(log, model) {
  const l = plainLog(log);
  const name = path.basename(model);
  if (OUT_OF_MEMORY.test(l)) return `Not enough memory to load ${name}. Close other programs, or pick a smaller model (or a smaller quantization like Q4_K_S / Q3_K_M).`;
  if (/unknown (model )?architecture|unsupported model architecture/i.test(l)) return `This llama.cpp build doesn't support ${name}'s model type yet. Update llama.cpp in Settings → Local Models.`;
  if (/invalid magic|not a gguf|failed to read|tensor .* data is not within|corrupt/i.test(l)) return `${name} looks damaged or incomplete. Download it again.`;
  // otherwise: the error lines themselves, without timestamps / levels
  const errors = l.split('\n').map(x => x.trim()).filter(x => /^\S+\s+E\s/.test(x) || /\berror\b/i.test(x))
    .map(x => x.replace(/^[\d.:]+\s+[EWI]\s+(\w+\s+)?/, '').replace(/^\w+:\s+/, '').trim()).filter(Boolean);
  return errors.length ? [...new Set(errors)].slice(-2).join(' · ') : 'llama-server stopped while loading the model.';
}

/** Make sure llama-server is running `model` (a GGUF you picked); resolves to its base URL once the model is loaded.
    llama.cpp fits the model to your GPU by itself (whatever doesn't fit stays in system memory); if loading still
    runs out of GPU memory, it tries once more on the CPU only. */
async function ensureModel(model, { ctx = 4096, onProgress } = {}) {
  if (!readGguf().includes(model)) throw new Error('That GGUF file was not added through Noctyl');
  if (!exists(model)) throw new Error(`Model file not found: ${model}`);
  if (server?.model === model) { await server.ready; return `http://127.0.0.1:${server.port}`; }
  stopServer();
  const bin = llamaServerPath();
  if (!bin) throw new Error('llama.cpp is not installed');
  try { return await startServer(bin, model, ctx, [], onProgress); }
  catch (e) {
    if (!e.outOfMemory) throw e;
    onProgress?.({ phase: 'loading', note: 'cpu' });
    return startServer(bin, model, ctx, ['-ngl', '0'], onProgress);   // GPU too small even for part of it: CPU only
  }
}
async function startServer(bin, model, ctx, extra, onProgress) {
  const port = await freePort();
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--jinja', '-c', String(Math.max(512, Math.min(Number(ctx) || 4096, 262144))), '--no-webui', ...extra];
  const child = spawn(bin.path, args, { cwd: path.dirname(bin.path), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LLAMA_LOG_COLORS: '0', NO_COLOR: '1' } });
  let log = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { log = (log + d).slice(-16000); });
  const me = { child, model, port };
  me.ready = (async () => {
    onProgress?.({ phase: 'loading' });
    for (let i = 0; i < 2400; i++) {           // up to 10 min for big models on slow disks
      if (child.exitCode !== null) {
        const err = new Error(explainLoadFailure(log, model));
        err.outOfMemory = OUT_OF_MEMORY.test(plainLog(log));
        throw err;
      }
      const r = await probe(`http://127.0.0.1:${port}/health`, 800);
      if (r?.ok) return;
      await new Promise(r2 => setTimeout(r2, 250));
    }
    throw new Error('The model took too long to load');
  })();
  child.on('exit', () => { if (server === me) server = null; });
  server = me;
  try { await me.ready; } catch (e) { stopServer(); throw e; }
  return `http://127.0.0.1:${port}`;
}

/* =========================================================
   /nuke-messages
   ========================================================= */
// NOCTYL_OLLAMA_DB / NOCTYL_OLLAMA_HISTORY point these at other files (used to test against a throwaway copy)
const OLLAMA_DB = () => process.env.NOCTYL_OLLAMA_DB || (IS_WIN ? path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'db.sqlite')
  : process.platform === 'darwin' ? path.join(home(), 'Library', 'Application Support', 'Ollama', 'db.sqlite')
  : path.join(home(), '.local', 'share', 'ollama', 'db.sqlite'));
const OLLAMA_HISTORY = () => process.env.NOCTYL_OLLAMA_HISTORY || path.join(home(), '.ollama', 'history');

/** A few distinctive pieces of message text, used afterwards to prove they no longer exist on disk. */
function snippets(texts, max = 8) {
  const out = [];
  for (const t of texts.filter(s => typeof s === 'string' && s.length >= 24).sort((a, b) => b.length - a.length)) {
    const mid = Math.floor(t.length / 2) - 10;
    const s = t.slice(Math.max(0, mid), Math.max(0, mid) + 20);
    if (/\w{3}/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function ollamaDbCounts() {
  if (!exists(OLLAMA_DB())) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(OLLAMA_DB(), { readOnly: true });
  try {
    const n = t => { try { return db.prepare(`select count(*) c from ${t}`).get().c; } catch { return 0; } };
    let texts = [];
    try { texts = db.prepare('select content from messages order by length(content) desc limit 40').all().map(r => r.content); } catch { /* no table */ }
    return { chats: n('chats'), messages: n('messages'), texts };
  } finally { db.close(); }
}
function wipeOllamaDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(OLLAMA_DB());
  try {
    db.exec('PRAGMA busy_timeout = 8000; PRAGMA secure_delete = ON;');
    db.exec('BEGIN IMMEDIATE');
    for (const t of ['attachments', 'tool_calls', 'messages', 'chats']) { try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist in this version */ } }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');                                   // rewrite the file so deleted text is not left in free pages
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { chats: db.prepare('select count(*) c from chats').get().c, messages: db.prepare('select count(*) c from messages').get().c };
  } finally { db.close(); }
}

async function clearOllamaMemory(base) {
  if (!isLocalBase(base)) return 0;
  const ps = await probe(base.replace(/\/+$/, '') + '/api/ps', 1500);
  if (!ps?.ok) return 0;
  const models = ((await ps.json()).models || []).map(m => m.name || m.model).filter(Boolean);
  for (const model of models) {
    try { await fetch(base.replace(/\/+$/, '') + '/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(8000) }); } catch { /* ignore */ }
  }
  return models.length;
}
async function clearLlamaSlots(urls) {
  let n = 0;
  for (const u of urls.filter(isLocalBase)) {
    const base = u.replace(/\/+$/, '').replace(/\/v1$/, '');
    const r = await probe(base + '/slots', 1500);
    if (!r?.ok) continue;
    let slots = [];
    try { slots = await r.json(); } catch { continue; }
    for (const s of Array.isArray(slots) ? slots : []) {
      try { await fetch(`${base}/slots/${Number(s.id)}?action=erase`, { method: 'POST', signal: AbortSignal.timeout(4000) }); n++; } catch { /* ignore */ }
    }
  }
  return n;
}

/** PowerShell check: listed files must be gone, and none of the snippets may appear in the listed files/folders. */
/** macOS / Linux: the same check as the PowerShell one, in Node. */
function verifyWithNode({ gone, scan, needles }) {
  const forms = needles.flatMap(n => [Buffer.from(n, 'utf8'), Buffer.from(n, 'utf16le')]);
  const files = [];
  const walk = p => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else if (st.isFile() && st.size < 200 * 1024 * 1024) files.push(p);
  };
  scan.forEach(walk);
  const textFoundIn = files.filter(f => { try { const b = fs.readFileSync(f); return forms.some(x => b.includes(x)); } catch { return false; } });
  return { stillExist: gone.filter(exists), filesScanned: files.length, textFoundIn };
}

function verifyWithPowerShell({ gone, scan, needles }) {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve(verifyWithNode({ gone, scan, needles }));
    const job = path.join(os.tmpdir(), `noctyl-nuke-${crypto.randomUUID()}.json`);
    fs.writeFileSync(job, JSON.stringify({ gone, scan, needles }), 'utf8');
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$job = Get-Content -LiteralPath $env:NOCTYL_NUKE_JOB -Raw | ConvertFrom-Json
$latin = [Text.Encoding]::GetEncoding(28591)
$forms = foreach ($n in $job.needles) { @($latin.GetString([Text.Encoding]::UTF8.GetBytes($n)), $latin.GetString([Text.Encoding]::Unicode.GetBytes($n))) }
$files = foreach ($p in $job.scan) { if (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -Recurse -File -Force | Where-Object { $_.Length -lt 200MB } } elseif (Test-Path -LiteralPath $p) { Get-Item -LiteralPath $p -Force } }
$hits = foreach ($f in $files) { $text = $latin.GetString([IO.File]::ReadAllBytes($f.FullName)); foreach ($x in $forms) { if ($x -and $text.Contains($x)) { $f.FullName; break } } }
[pscustomobject]@{
  stillExist = @($job.gone | Where-Object { Test-Path -LiteralPath $_ })
  filesScanned = @($files).Count
  textFoundIn = @($hits | Select-Object -Unique)
} | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 120000, env: { ...process.env, NOCTYL_NUKE_JOB: job }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      fs.rmSync(job, { force: true });
      try { const r = JSON.parse(stdout.trim()); resolve({ stillExist: [].concat(r.stillExist || []), filesScanned: r.filesScanned || 0, textFoundIn: [].concat(r.textFoundIn || []) }); }
      catch { resolve({ error: (err?.message || 'verification failed').slice(0, 300) }); }
    });
  });
}

/** Ask (native dialog), then delete. The page has already wiped its own copy before calling run(). */
async function nukeConfirm(_owner, { noctylChats = 0 } = {}) {
  let o = null;
  try { o = ollamaDbCounts(); } catch { /* unreadable */ }
  const lines = [
    `• ${noctylChats} Noctyl conversation${noctylChats === 1 ? '' : 's'} and their images`,
    o ? `• ${o.chats} Ollama app chat${o.chats === 1 ? '' : 's'} (${o.messages} messages)` : null,
    exists(OLLAMA_HISTORY()) ? '• The `ollama run` prompt history' : null,
    '• Conversations Ollama and llama.cpp are holding in memory (models are unloaded)',
  ].filter(Boolean);
  // Shown as its own window, not attached to (and so not disabling) the app window. This is usually opened by typing
  // /nuke-messages, and Windows hides the pointer while you type until the mouse moves over a window that takes mouse
  // input — a window disabled behind a modal dialog doesn't, so the pointer stayed invisible over the app. It's still
  // the native dialog the page can't fake, and the app waits for the answer either way.
  const r = await dialog.showMessageBox({
    type: 'warning', buttons: ['Delete everything', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'Nuke messages', message: 'Permanently delete all messages?',
    detail: lines.join('\n') + '\n\nThis cannot be undone. Your settings, models and the Ollama app settings are kept.',
  });
  return { ok: r.response === 0, ollamaTexts: o?.texts || [] };
}

async function nukeRun({ ollamaUrl, llamaUrls = [], needles = [] }) {
  const report = { steps: [] };
  const step = (what, ok, detail = '') => report.steps.push({ what, ok, detail });
  let ollamaTexts = [];
  try { ollamaTexts = ollamaDbCounts()?.texts || []; } catch { /* ignore */ }
  const allNeedles = [...new Set([...needles.filter(n => typeof n === 'string' && n.length >= 12).slice(0, 8), ...snippets(ollamaTexts)])];

  // Noctyl: the page already emptied its chats; drop this app's stored data so old copies don't linger in Chromium's files
  try {
    // the current origin, and the pre-rename one (app://hacky) in case anything of it is still on disk
    for (const origin of ['app://noctyl', 'app://hacky']) await session.defaultSession.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql'] });
    await session.defaultSession.clearCache();
    session.defaultSession.flushStorageData();
    step('Noctyl conversations', true);
  } catch (e) { step('Noctyl conversations', false, e.message); }

  if (exists(OLLAMA_DB())) {
    try { const left = wipeOllamaDb(); step('Ollama app chats', left.chats === 0 && left.messages === 0, `${left.chats} chats, ${left.messages} messages left`); }
    catch (e) { step('Ollama app chats', false, e.message); }
  }
  if (exists(OLLAMA_HISTORY())) {
    try { fs.rmSync(OLLAMA_HISTORY(), { force: true }); step('ollama run history', !exists(OLLAMA_HISTORY())); }
    catch (e) { step('ollama run history', false, e.message); }
  }
  try { const n = await clearOllamaMemory(ollamaUrl || 'http://127.0.0.1:11434'); step('Ollama memory', true, `${n} model${n === 1 ? '' : 's'} unloaded`); } catch (e) { step('Ollama memory', false, e.message); }
  try {
    const managed = server ? [`http://127.0.0.1:${server.port}`] : [];
    stopServer();   // Noctyl's own llama-server: restarting it clears every conversation it held
    const n = await clearLlamaSlots(llamaUrls);
    step('llama.cpp memory', true, `${managed.length ? 'Noctyl llama-server restarted, ' : ''}${n} slot${n === 1 ? '' : 's'} erased`);
  } catch (e) { step('llama.cpp memory', false, e.message); }

  await new Promise(r => setTimeout(r, 1500));   // let Chromium finish writing its storage files
  const scan = [path.join(userData(), 'data'), path.join(userData(), 'Local Storage'), path.join(userData(), 'IndexedDB'), path.join(userData(), 'Session Storage'), path.join(userData(), 'Cache')];
  if (exists(OLLAMA_DB())) scan.push(OLLAMA_DB(), OLLAMA_DB() + '-wal');
  report.verify = await verifyWithPowerShell({ gone: [OLLAMA_HISTORY()], scan, needles: allNeedles });
  report.needles = allNeedles.length;
  return report;
}

module.exports = { ollamaStatus, startOllama, ollamaExe, llamaServerPath, installLlama, pickGguf, addGguf, forgetGguf, ggufInfo, ensureModel, stopServer, nukeConfirm, nukeRun };
