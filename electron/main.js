// Noctyl desktop (Electron main process).
//
// Security model
// - The UI is the same index.html / app.js / styles.css as the web version, served from a private
//   app://noctyl origin (never file://), with a strict Content-Security-Policy.
// - The renderer runs sandboxed with contextIsolation and no Node.js. Its only bridge is electron/preload.js.
// - The page cannot reach the network itself (CSP connect-src 'self'). Requests to Ollama, providers and
//   MCP servers go through the "net:" IPC bridge below and are made here with Chromium's network stack,
//   which isn't subject to browser CORS. That's why Ollama no longer needs OLLAMA_ORIGINS and providers
//   that refuse web pages work.
// - Navigation is locked to the app; links open in the user's real browser; only microphone permission
//   (for dictation) and clipboard writes are granted.
'use strict';
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, nativeTheme, net, protocol, screen, session, shell, utilityProcess } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCHEME = 'app';
const HOST = 'noctyl';
const ORIGIN = `${SCHEME}://${HOST}`;
const DEV = process.argv.includes('--dev');
// optional separate profile (chats/settings) for testing: set NOCTYL_USER_DATA (or the pre-rename HACKY_USER_DATA) to a folder
const TEST_PROFILE = process.env.NOCTYL_USER_DATA || process.env.HACKY_USER_DATA;
if (TEST_PROFILE) app.setPath('userData', path.resolve(TEST_PROFILE));
/* Linux AppImage: Ubuntu 23.10+ (and others) block the user namespaces Chromium's sandbox needs, and an AppImage
   can't carry the setuid helper the .deb installs, so the app wouldn't open at all. Only in exactly that case the
   OS-level sandbox is skipped; the page keeps contextIsolation, no Node.js, its strict CSP and locked navigation.
   The .deb, other systems and NOCTYL_FORCE_SANDBOX=1 keep the full sandbox. */
if (process.platform === 'linux' && process.env.APPIMAGE && process.env.NOCTYL_FORCE_SANDBOX !== '1') {
  try {
    if (require('node:fs').readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1') {
      app.commandLine.appendSwitch('no-sandbox');
      console.warn('[Noctyl] AppImage on a system that restricts user namespaces: running without the OS sandbox (install the .deb to keep it).');
    }
  } catch { /* not restricted (no such setting): keep the sandbox */ }
}

/* The app used to be called Hacky, and its data folder was named after it (%APPDATA%\Hacky, ~/Library/Application
   Support/Hacky, ~/.config/Hacky). The first time it starts as Noctyl with no data of its own yet, that folder is copied
   into the new one — settings, chats, images, keys, command access, the GGUF list, the dictation model — so nothing is
   lost. The old folder is left exactly as it was (a backup; delete it whenever you like). Chromium's caches, which
   rebuild themselves, are skipped. */
function adoptPreRenameData() {
  if (TEST_PROFILE) return;
  const fsSync = require('node:fs');
  const now = app.getPath('userData'), old = path.join(app.getPath('appData'), 'Hacky');
  const key = p => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());   // Linux paths are case-sensitive
  if (key(old) === key(now)) return;
  if (!fsSync.existsSync(path.join(old, 'data')) || fsSync.existsSync(path.join(now, 'data'))) return;
  const CACHES = /^[\\/](Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad|blob_storage|Service Worker)([\\/]|$)/i;
  try {
    fsSync.cpSync(old, now, { recursive: true, force: false, errorOnExist: false, filter: src => !CACHES.test(src.slice(old.length)) });
  } catch (e) { console.error('[Noctyl] could not copy data from before the rename', e); }
}
adoptPreRenameData();

// Files the app:// origin may serve (nothing else in the project folder is reachable).
const SERVED = new Set(['index.html', 'app.js', 'early.js', 'styles.css', 'dictation-worklet.js']);
const SERVED_DIR = /^assets\/[\w\- .()/]+$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   // inline style attributes (table alignment etc.)
  "img-src 'self' data: blob:",          // data: for profile pictures and inline images
  "font-src 'self'",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",                  // all outside requests go through the main-process bridge
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;   // the main window
let hud = null;   // the HUD overlay window, while HUD mode is on

function serveApp() {
  protocol.handle(SCHEME, async request => {
    const url = new URL(request.url);
    const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    if (url.host !== HOST) return notFound();
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!(SERVED.has(rel) || (SERVED_DIR.test(rel) && !rel.split('/').includes('..')))) return notFound();
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return notFound();
    // read with Node's fs: it also reads from inside the packaged app.asar archive
    let body;
    try { body = await require('node:fs/promises').readFile(file); } catch { return notFound(); }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      },
    });
  });
}

/* ---------------- network bridge (renderer → main → internet) ---------------- */
const inflight = new Map();   // `${webContentsId}:${id}` → AbortController
const MAX_BODY = 25 * 1024 * 1024;
const appWindows = () => [win, hud].filter(w => w && !w.isDestroyed());
const fromApp = e => appWindows().some(w => e.sender === w.webContents) && (e.senderFrame?.url || '').startsWith(ORIGIN + '/');
const fromHud = e => !!hud && !hud.isDestroyed() && e.sender === hud.webContents && fromApp(e);

ipcMain.handle('net:request', async (e, id, req) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  let target;
  try { target = new URL(String(req?.url)); } catch { throw new Error('Invalid URL'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http(s) requests are allowed');
  const method = String(req.method || 'GET').toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) throw new Error('Method not allowed');
  const body = typeof req.body === 'string' ? req.body : undefined;
  if (body && body.length > MAX_BODY) throw new Error('Request too large');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) if (typeof v === 'string' && !/^(host|origin|cookie|content-length)$/i.test(k)) headers[k] = v;

  const key = `${e.sender.id}:${id}`;
  const ac = new AbortController();
  inflight.set(key, ac);
  let res;
  try {
    res = await net.fetch(target.toString(), { method, headers, body, signal: ac.signal, credentials: 'omit', redirect: 'follow', bypassCustomProtocolHandlers: true });
  } catch (err) {
    inflight.delete(key);
    throw new Error(ac.signal.aborted ? 'AbortError' : (err?.message || 'Network error'));
  }
  // stream the body back in chunks
  const sender = e.sender;
  (async () => {
    try {
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (sender.isDestroyed()) return;
          sender.send('net:chunk', id, value);
        }
      }
      if (!sender.isDestroyed()) sender.send('net:end', id, null);
    } catch (err) {
      if (!sender.isDestroyed()) sender.send('net:end', id, ac.signal.aborted ? 'AbortError' : (err?.message || 'Network error'));
    } finally { inflight.delete(key); }
  })();
  return { status: res.status, statusText: res.statusText, headers: [...res.headers] };
});

ipcMain.on('net:abort', (e, id) => {
  if (!fromApp(e)) return;
  inflight.get(`${e.sender.id}:${id}`)?.abort();
});

/* ---------------- dictation (local Whisper in a utility process) ---------------- */
let dictWorker = null, dictSeq = 0;
const dictPending = new Map();
const MAX_AUDIO_SAMPLES = 16000 * 60;   // one request carries at most 60 s of 16 kHz audio

function dictationWorker() {
  if (dictWorker) return dictWorker;
  dictWorker = utilityProcess.fork(path.join(__dirname, 'dictation-worker.mjs'), [app.getPath('userData')], { serviceName: 'Noctyl Dictation' });
  dictWorker.on('message', m => {
    if (m?.type === 'progress') { appWindows().forEach(w => w.webContents.send('dictation:progress', m)); return; }
    const p = dictPending.get(m?.id);
    if (!p) return;
    dictPending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  dictWorker.on('exit', () => {
    dictWorker = null;
    for (const p of dictPending.values()) p.reject(new Error('The dictation engine stopped'));
    dictPending.clear();
  });
  return dictWorker;
}
const askDictation = (type, extra = {}) => new Promise((resolve, reject) => {
  const id = ++dictSeq;
  dictPending.set(id, { resolve, reject });
  dictationWorker().postMessage({ id, type, ...extra });
});

ipcMain.handle('dictation:status', e => { if (!fromApp(e)) throw new Error('Not allowed'); return askDictation('status'); });
ipcMain.handle('dictation:prepare', e => { if (!fromApp(e)) throw new Error('Not allowed'); return askDictation('load'); });
ipcMain.handle('dictation:transcribe', (e, audio) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  if (!(audio instanceof Float32Array) || audio.length > MAX_AUDIO_SAMPLES) throw new Error('Invalid audio');
  return askDictation('transcribe', { audio });
});
app.on('before-quit', () => { dictWorker?.kill(); });

/* ---------------- title bar overlay color (dims with the page when settings are open) ---------------- */
ipcMain.on('window:titlebar-color', (e, color, symbols) => {
  // color: #rrggbb; symbols: the glyphs' colour (dark in light mode)
  if (!fromApp(e) || !/^#[0-9a-f]{6}$/i.test(String(color)) || !win || win.isDestroyed()) return;
  const symbolColor = /^#[0-9a-f]{6}$/i.test(String(symbols)) ? symbols : '#e8eaed';
  try { win.setTitleBarOverlay({ color, symbolColor, height: 40 }); } catch { /* platform without an overlay */ }
});

/* ---------------- appearance (Customization → Window & HUD → Dark / Light mode) ----------------
   'system' follows the OS; 'dark' / 'light' pin it. This is the window's theme as the OS sees it; the page's "system" mode
   (prefers-color-scheme) follows it, and so do the window buttons. */
ipcMain.handle('window:theme', (e, mode) => {
  if (!fromApp(e)) return false;
  nativeTheme.themeSource = ['dark', 'light'].includes(mode) ? mode : 'system';
  return true;
});

/* ---------------- HUD mode ----------------
   A small always-on-top, transparent, frameless window with just the chat bar (and the conversation under it
   once there is one). The main window hides while it's open; both use the same app:// page and storage.
   Transparent parts of the HUD let clicks through to whatever is underneath: the page reports whether the
   mouse is over its content and the window ignores the mouse everywhere else. */
const HUD_W = 700, HUD_H = 600;
const CHAT_ID = /^[\w-]{1,64}$/;
let hudChatId = '';         // the conversation shown in whichever window is in front
let hudDrag = null;         // interval moving the HUD while it's being dragged
let hudSize = { width: HUD_W, height: HUD_H };   // the HUD's fixed size; re-applied on every move

function lockWebContents(wc) {
  // links (target=_blank, markdown links) open in the default browser; nothing opens inside the app
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN + '/')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  wc.on('will-attach-webview', event => event.preventDefault());
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
  devTools: true,
});

function openHud() {
  if (hud && !hud.isDestroyed()) { hud.show(); hud.focus(); return; }
  // top centre of the screen the mouse is on
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(HUD_W, area.width), height = Math.min(HUD_H, area.height);
  hudSize = { width, height };
  hud = new BrowserWindow({
    width, height, minWidth: width, maxWidth: width, minHeight: height, maxHeight: height,
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + Math.min(120, area.height * .12)),
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, thickFrame: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Noctyl HUD',
    webPreferences: webPreferences(),
  });
  hud.setAlwaysOnTop(true, 'floating');
  hud.setIgnoreMouseEvents(true, { forward: true });   // the page turns this off while the mouse is over its content
  lockWebContents(hud.webContents);
  hud.loadURL(`${ORIGIN}/index.html?hud=1${CHAT_ID.test(hudChatId) ? '&chat=' + hudChatId : ''}`);
  hud.once('ready-to-show', () => { hud.show(); hud.focus(); });
  // however the HUD goes away (shortcut, its menu, Alt+F4), the main window comes back
  hud.on('closed', () => { hud = null; stopHudDrag(); restoreMain(); });
  // belt and braces: if Windows still nudges the size (e.g. crossing to a screen with other scaling), put it back
  hud.on('resize', () => {
    const [w, h] = hud.getSize();
    // tolerate the 1–2px rounding that fractional scaling always leaves; correcting that would just loop
    if (Math.abs(w - hudSize.width) > 2 || Math.abs(h - hudSize.height) > 2) hud.setBounds({ ...hud.getBounds(), ...hudSize });
  });
  if (win && !win.isDestroyed()) win.hide();
}

let pendingSettingsTab = '';
function closeHud(settingsTab = '') {
  pendingSettingsTab = /^[\w-]{1,40}$/.test(settingsTab) ? settingsTab : '';
  if (hud && !hud.isDestroyed()) hud.close(); else restoreMain();
}

function restoreMain() {
  if (quitting) return;
  if (!win || win.isDestroyed()) return createWindow();
  // the main window picks up what happened in the HUD (it shares the same storage)
  win.webContents.send('hud:closed', { chatId: hudChatId, settingsTab: pendingSettingsTab });
  pendingSettingsTab = '';
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
let quitting = false;
app.on('before-quit', () => { quitting = true; });

const toggleHud = () => (hud && !hud.isDestroyed() ? closeHud() : openHud());

function stopHudDrag() { clearInterval(hudDrag); hudDrag = null; }

ipcMain.on('hud:set', (e, open, opts) => {
  if (!fromApp(e)) return;
  if (open) openHud(); else closeHud(String(opts?.settingsTab || ''));
});
ipcMain.on('hud:chat', (e, id) => { if (fromApp(e)) hudChatId = CHAT_ID.test(String(id)) ? String(id) : ''; });
ipcMain.on('hud:click-through', (e, through) => {
  if (fromHud(e)) hud.setIgnoreMouseEvents(!!through, { forward: true });
});
// drag the HUD by its bar: follow the cursor until the page says the button is up
ipcMain.on('hud:drag', (e, phase) => {
  if (!fromHud(e)) return;
  stopHudDrag();
  if (phase !== 'start') return;
  const start = screen.getCursorScreenPoint(), [wx, wy] = hud.getPosition();
  let last = '';
  hudDrag = setInterval(() => {
    if (!hud || hud.isDestroyed()) return stopHudDrag();
    const p = screen.getCursorScreenPoint();
    const x = wx + p.x - start.x, y = wy + p.y - start.y;
    if (`${x},${y}` === last) return;   // cursor hasn't moved: don't touch the window
    last = `${x},${y}`;
    // setBounds with the fixed size, not setPosition: with display scaling (e.g. 150%) Windows rounds the size
    // on every setPosition, so a long drag made the HUD creep larger a pixel at a time
    hud.setBounds({ x, y, ...hudSize });
  }, 12);
});

/* ---------------- Commands (agentic "run_command" tool) ----------------
   The model can ask to run a shell command; the page shows it to you and only calls cmd:run after you
   press Allow. On top of that, this process refuses every command unless you turned command access on
   through a native confirmation dialog (saved in userData/commands.json), so the page alone can never
   switch it on. Commands run non-interactively (no stdin), hidden, with a timeout that kills the whole
   process tree, and output is capped. */
const { spawn, spawnSync } = require('node:child_process');
const fsSync = require('node:fs');
const CMD_FILE = () => path.join(app.getPath('userData'), 'commands.json');
const MAX_CMD_LEN = 8000, MAX_CAPTURE = 1024 * 1024;
const cmdRunning = new Map();   // `${webContentsId}:${id}` → child process
const readCmdState = () => { try { return JSON.parse(fsSync.readFileSync(CMD_FILE(), 'utf8')); } catch { return {}; } };
const cmdEnabled = () => readCmdState().enabled === true;
const onPath = exe => { try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { windowsHide: true, timeout: 3000 }).status === 0; } catch { return false; } };
let shellCache = null;
function availableShells() {
  if (shellCache) return shellCache;
  shellCache = process.platform === 'win32'
    ? ['powershell', ...(onPath('pwsh') ? ['pwsh'] : []), 'cmd', ...(onPath('bash') ? ['bash'] : [])]
    : [...(onPath('bash') ? ['bash'] : []), ...(onPath('zsh') ? ['zsh'] : []), 'sh'];   // Linux/macOS: sh always exists, bash may not
  return shellCache;
}
function shellArgs(shell, command) {
  switch (shell) {
    case 'powershell': return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`]];
    case 'pwsh': return ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]];
    case 'cmd': return ['cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & ${command}`]];
    default: return [shell, ['-lc', command]];
  }
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

ipcMain.handle('cmd:status', e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  return { enabled: cmdEnabled(), shells: availableShells(), defaultShell: availableShells()[0], home: app.getPath('home'), platform: process.platform };
});
ipcMain.handle('cmd:enable', async e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const { dialog } = require('electron');
  const owner = BrowserWindow.fromWebContents(e.sender) || undefined;
  const r = await dialog.showMessageBox(owner, {
    type: 'warning', buttons: ['Allow commands', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'Let Noctyl run commands?',
    message: 'Let models in Noctyl run commands on this computer?',
    detail: 'Each command is shown to you first and only runs after you press Allow. Commands run as you, with your permissions, and can change or delete files. Only allow commands you understand.',
  });
  if (r.response !== 0) return { enabled: cmdEnabled() };
  fsSync.writeFileSync(CMD_FILE(), JSON.stringify({ enabled: true, since: new Date().toISOString() }));
  return { enabled: true };
});
ipcMain.handle('cmd:disable', e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  fsSync.writeFileSync(CMD_FILE(), JSON.stringify({ enabled: false }));
  for (const child of cmdRunning.values()) killTree(child);
  return { enabled: false };
});
ipcMain.handle('cmd:pick-dir', async (e, current) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || undefined, { title: 'Folder commands run in', defaultPath: typeof current === 'string' && current ? current : app.getPath('home'), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('cmd:run', (e, id, req) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  if (!cmdEnabled()) throw new Error('Command access is turned off in Settings → Tools → Commands');
  const command = String(req?.command || '');
  if (!command.trim() || command.length > MAX_CMD_LEN || command.includes('\0')) throw new Error('Invalid command');
  const shell = availableShells().includes(req?.shell) ? req.shell : availableShells()[0];
  const cwd = path.resolve(String(req?.cwd || app.getPath('home')));
  try { if (!fsSync.statSync(cwd).isDirectory()) throw 0; } catch { throw new Error(`Folder not found: ${cwd}`); }
  const timeout = Math.min(Math.max(Number(req?.timeout) || 60, 1), 600) * 1000;
  const [exe, args] = shellArgs(shell, command);
  const key = `${e.sender.id}:${id}`;
  return new Promise(resolve => {
    const started = Date.now();
    let out = '', err = '', truncated = false, timedOut = false;
    const take = (buf, add) => { if (buf.length >= MAX_CAPTURE) { truncated = true; return buf; } return buf + add; };
    let child;
    try { child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: process.env }); }
    catch (ex) { resolve({ exitCode: null, stdout: '', stderr: String(ex.message), ms: 0, shell, cwd }); return; }
    cmdRunning.set(key, child);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    // live output for the page (expand "Running …" to watch it): sent in small batches, at most ~10 times a second
    let pending = '', flushTimer = null;
    const flushLive = () => { flushTimer = null; if (pending && !e.sender.isDestroyed()) e.sender.send('cmd:out', id, pending); pending = ''; };
    const live = d => { if (pending.length < 64 * 1024) pending += d; if (!flushTimer) flushTimer = setTimeout(flushLive, 100); };
    child.stdout.on('data', d => { out = take(out, d); live(d); });
    child.stderr.on('data', d => { err = take(err, d); live(d); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const finish = (code, error) => {
      clearTimeout(timer); cmdRunning.delete(key);
      if (flushTimer) { clearTimeout(flushTimer); flushLive(); }
      resolve({ exitCode: code, stdout: out, stderr: err + (error ? String(error.message) : ''), ms: Date.now() - started, timedOut, aborted: child.killedByUser === true, truncated, shell, cwd });
    };
    child.on('error', ex => finish(null, ex));
    child.on('close', code => finish(code));
  });
});
ipcMain.on('cmd:abort', (e, id) => {
  if (!fromApp(e)) return;
  const child = cmdRunning.get(`${e.sender.id}:${id}`);
  if (child) { child.killedByUser = true; killTree(child); }
});
app.on('before-quit', () => { for (const child of cmdRunning.values()) killTree(child); });

/* ---------------- Local runtimes (Ollama / llama.cpp), GGUF files, /nuke-messages ---------------- */
const runtime = require('./runtime');
const ownerOf = e => BrowserWindow.fromWebContents(e.sender) || undefined;
const sendTo = (e, channel, payload) => { if (!e.sender.isDestroyed()) e.sender.send(channel, payload); };
const urlArg = u => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.toString() : 'http://127.0.0.1:11434'; } catch { return 'http://127.0.0.1:11434'; } };

ipcMain.handle('rt:status', async (e, ollamaUrl) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const [ollama, llama] = [await runtime.ollamaStatus(urlArg(ollamaUrl)), runtime.llamaServerPath()];
  return { ollama, llama, platform: process.platform };
});
ipcMain.handle('rt:start-ollama', async (e, ollamaUrl) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const base = urlArg(ollamaUrl);
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(base).hostname)) throw new Error('Ollama runs on another computer; start it there');
  await runtime.startOllama(base);
  return runtime.ollamaStatus(base);
});
ipcMain.handle('rt:install-llama', async e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  return runtime.installLlama(p => sendTo(e, 'rt:progress', p));
});
ipcMain.handle('gguf:pick', e => { if (!fromApp(e)) throw new Error('Not allowed'); return runtime.pickGguf(ownerOf(e)); });
ipcMain.handle('gguf:forget', (e, p) => { if (!fromApp(e)) throw new Error('Not allowed'); runtime.forgetGguf(String(p)); return true; });
ipcMain.handle('gguf:list', e => { if (!fromApp(e)) throw new Error('Not allowed'); return runtime.ggufInfo(); });
ipcMain.handle('gguf:ensure', async (e, model, opts) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  return runtime.ensureModel(String(model), { ctx: Number(opts?.ctx) || 4096, onProgress: p => sendTo(e, 'rt:progress', p) });
});
let nukeArmed = 0;   // nuke:run only works within a minute of you confirming the native dialog
ipcMain.handle('nuke:confirm', async (e, info) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const r = await runtime.nukeConfirm(ownerOf(e), { noctylChats: Number(info?.noctylChats) || 0 });
  nukeArmed = r.ok ? Date.now() : 0;
  return { ok: r.ok };
});
ipcMain.handle('nuke:run', async (e, opts) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  if (Date.now() - nukeArmed > 60000) throw new Error('Confirm first');
  nukeArmed = 0;
  return runtime.nukeRun({ ollamaUrl: urlArg(opts?.ollamaUrl), llamaUrls: Array.isArray(opts?.llamaUrls) ? opts.llamaUrls.map(String).slice(0, 50) : [], needles: Array.isArray(opts?.needles) ? opts.needles.map(String).slice(0, 8) : [] });
});
app.on('before-quit', () => runtime.stopServer());

/* ---------------- Noctyl's data on disk: settings, preferences, chats, images (see store.js) ---------------- */
const store = require('./store');
/* ---------------- default settings (config/defaults.json) ----------------
   The project ships config/defaults.json: the settings a fresh install starts with (and goes back to on Reset). On first
   launch it's copied into the app's data folder (%APPDATA%\Noctyl\defaults.json on Windows) so each install has its own
   copy to edit; after that, that copy is what's used (the shipped one only fills in if it's missing or unreadable). */
const SHIPPED_DEFAULTS = path.join(ROOT, 'config', 'defaults.json');
const DEFAULTS_FILE = () => path.join(app.getPath('userData'), 'defaults.json');
function loadDefaults() {
  const fsSync = require('node:fs');
  try {
    if (!fsSync.existsSync(DEFAULTS_FILE())) {
      fsSync.mkdirSync(path.dirname(DEFAULTS_FILE()), { recursive: true });
      fsSync.writeFileSync(DEFAULTS_FILE(), fsSync.readFileSync(SHIPPED_DEFAULTS, 'utf8'));   // read+write (works from inside app.asar)
    }
  } catch (e) { console.error('[Noctyl] could not write defaults.json', e); }
  for (const f of [DEFAULTS_FILE(), SHIPPED_DEFAULTS]) {
    try {
      const j = JSON.parse(fsSync.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch { /* try the next one */ }
  }
  return {};
}
ipcMain.on('store:load', e => { e.returnValue = fromApp(e) ? { ...store.loadSync(), defaults: loadDefaults() } : null; });
ipcMain.handle('store:save', (e, data) => { if (!fromApp(e)) throw new Error('Not allowed'); return store.save(data); });
ipcMain.on('store:save-sync', (e, data) => { try { e.returnValue = fromApp(e) ? store.saveSync(data) : false; } catch (err) { e.returnValue = false; console.error(err); } });
ipcMain.handle('store:erase', e => { if (!fromApp(e)) throw new Error('Not allowed'); return store.erase(); });
ipcMain.handle('store:path', e => { if (!fromApp(e)) throw new Error('Not allowed'); return store.DATA(); });
const imgId = id => { const s = String(id); if (!/^[\w-]{1,80}$/.test(s)) throw new Error('Bad image id'); return s; };
ipcMain.handle('img:put', (e, id, rec) => { if (!fromApp(e)) throw new Error('Not allowed'); return store.putImage(imgId(id), rec); });
ipcMain.handle('img:get', (e, id) => { if (!fromApp(e)) throw new Error('Not allowed'); return store.getImage(imgId(id)); });
ipcMain.handle('img:keys', e => { if (!fromApp(e)) throw new Error('Not allowed'); return store.imageKeys(); });
ipcMain.handle('img:del', (e, ids) => { if (!fromApp(e)) throw new Error('Not allowed'); return store.delImages((Array.isArray(ids) ? ids : []).map(imgId)); });
ipcMain.handle('img:clear', e => { if (!fromApp(e)) throw new Error('Not allowed'); return store.clearImages(); });

/* ---------------- The Noctyl folder: skills, agents, downloaded models, llama.cpp ---------------- */
const appdir = require('./appdir');
appdir.adoptPreRenameDir();   // ~/Hacky → ~/Noctyl, before anything reads or starts from the folder
ipcMain.handle('appdir:info', e => { if (!fromApp(e)) throw new Error('Not allowed'); appdir.ensure(); return { path: appdir.appDir(), default: appdir.DEFAULT_DIR() }; });
ipcMain.handle('appdir:open', async (e, which) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const dir = path.join(appdir.ensure(), ['skills', 'quick-skills', 'agents', 'models', 'llama.cpp'].includes(which) ? which : '');
  fsSync.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return true;
});
ipcMain.handle('appdir:choose', async e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(ownerOf(e), { title: 'Choose the Noctyl folder', defaultPath: appdir.appDir(), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return appdir.setDir(r.filePaths[0]);
});
ipcMain.handle('library:read', async e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  appdir.ensure();
  return { skills: await appdir.readSkills(), agents: await appdir.readAgents() };
});
ipcMain.handle('library:write-skills', (e, list) => { if (!fromApp(e)) throw new Error('Not allowed'); return appdir.writeSkills(list); });
ipcMain.handle('library:write-agents', (e, list) => { if (!fromApp(e)) throw new Error('Not allowed'); return appdir.writeAgents(list); });
// Knowledge (local RAG, electron/rag.js): only folders you pick here can be indexed
const rag = require('./rag');
ipcMain.handle('knowledge:pick', async e => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(ownerOf(e), { title: 'Add a project folder', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return [];
  rag.allow(r.filePaths);
  return r.filePaths;
});
ipcMain.handle('knowledge:index', (e, col, cfg) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  return rag.index(col, cfg, p => sendTo(e, 'knowledge:progress', { id: String(col?.id || ''), ...p }));
});
ipcMain.on('knowledge:cancel', (e, id) => { if (fromApp(e)) rag.cancel(String(id)); });
ipcMain.handle('knowledge:info', (e, id) => { if (!fromApp(e)) throw new Error('Not allowed'); return rag.info(String(id)); });
ipcMain.handle('knowledge:remove', (e, id) => { if (!fromApp(e)) throw new Error('Not allowed'); return rag.remove(String(id)); });
ipcMain.handle('knowledge:search', (e, ids, query, cfg, k) => { if (!fromApp(e)) throw new Error('Not allowed'); return rag.search(ids, query, cfg, k); });
ipcMain.handle('knowledge:test', (e, cfg) => { if (!fromApp(e)) throw new Error('Not allowed'); return rag.test(cfg); });
ipcMain.handle('knowledge:reveal', (e, p) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  if (typeof p !== 'string' || !path.isAbsolute(p) || !rag.isAllowed(p)) throw new Error('Not a project file');
  shell.showItemInFolder(p);
  return true;
});

// Files the model wrote or made (file cards, generated images): saved to Downloads, then optionally opened or shown.
// "Open" only for types that open in a viewer or editor: a script or program would run, so those are shown instead.
// a test profile can point Downloads somewhere else (NOCTYL_DOWNLOADS), so tests don't fill your real folder
const downloadsDir = () => (TEST_PROFILE && process.env.NOCTYL_DOWNLOADS) || app.getPath('downloads');
const OPENABLE = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|toml|ini|log|html?|css|svg|png|jpe?g|gif|webp|bmp|pdf|rtf)$/i;
ipcMain.handle('file:save', async (e, req) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const raw = String(req?.name || 'file.txt');
  let name = path.basename(raw.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'file.txt';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = '_' + name;
  const data = req?.encoding === 'base64' ? Buffer.from(String(req?.data || ''), 'base64') : Buffer.from(String(req?.data ?? ''), 'utf8');
  if (data.length > 50 * 1024 * 1024) throw new Error('That file is too big to save (over 50 MB)');
  const dir = downloadsDir();
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let i = 1; fsSync.existsSync(target) && i < 1000; i++) target = path.join(dir, `${stem} (${i})${ext}`);
  await require('node:fs/promises').writeFile(target, data, { flag: 'wx' });
  if (req?.then === 'open') {
    if (!OPENABLE.test(target)) { shell.showItemInFolder(target); return { path: target, opened: false, shown: true }; }
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return { path: target, opened: true };
  }
  if (req?.then === 'reveal') shell.showItemInFolder(target);
  return { path: target, shown: req?.then === 'reveal' };
});
ipcMain.handle('file:reveal', (e, p) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const dir = downloadsDir();
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.relative(dir, p).startsWith('..') || !fsSync.existsSync(p)) throw new Error('That file is no longer in Downloads');
  shell.showItemInFolder(p);
  return true;
});

// Skills (<Noctyl folder>/skills): listed, read and saved one at a time; a deleted skill goes to the Recycle Bin / Trash
ipcMain.handle('skills:list', e => { if (!fromApp(e)) throw new Error('Not allowed'); return appdir.listSkillDocs(); });
ipcMain.handle('skills:read', (e, name) => { if (!fromApp(e)) throw new Error('Not allowed'); return appdir.readSkillDoc(String(name || '')); });
ipcMain.handle('skills:read-file', (e, name, rel) => { if (!fromApp(e)) throw new Error('Not allowed'); return appdir.readSkillFile(String(name || ''), String(rel || '')); });
ipcMain.handle('skills:save', (e, req) => { if (!fromApp(e)) throw new Error('Not allowed'); return appdir.saveSkillDoc(req); });
ipcMain.handle('skills:delete', async (e, name) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  await shell.trashItem(appdir.skillDocPath(String(name || '')));
  return true;
});
ipcMain.handle('skills:reveal', (e, name) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  shell.showItemInFolder(appdir.skillDocPath(String(name || '')));
  return true;
});
ipcMain.handle('hf:download', async (e, req) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const r = await appdir.hfDownload({ id: String(req?.id || ''), repo: String(req?.repo || ''), file: String(req?.file || '') }, p => sendTo(e, 'hf:progress', p));
  runtime.addGguf([r.main]);   // a model you downloaded may be loaded by Noctyl's llama-server
  return r;
});
ipcMain.on('hf:cancel', (e, id) => { if (fromApp(e)) appdir.hfCancel(String(id)); });

/* ---------------- Download PDF ----------------
   The page builds a standalone conversation page (the same one Share uses). It's written to a temp file and
   printed by a hidden window that can't run JavaScript and can't load anything but that file and inline
   data: images, then you pick where the PDF goes. */
const MAX_PDF_HTML = 40 * 1024 * 1024;
ipcMain.handle('chat:pdf', async (e, html, name) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  if (typeof html !== 'string' || html.length > MAX_PDF_HTML) throw new Error('Conversation is too large');
  const safe = String(name).replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'conversation';
  const fs = require('node:fs/promises'), os = require('node:os'), crypto = require('node:crypto');
  const tmp = path.join(os.tmpdir(), `noctyl-pdf-${crypto.randomUUID()}.html`);
  await fs.writeFile(tmp, html, 'utf8');
  const tmpUrl = pathToFileURL(tmp).toString();
  const ses = session.fromPartition('noctyl-pdf');   // in-memory, separate from the app's session
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url === tmpUrl || d.url.startsWith('data:')) }));
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, session: ses, images: true, webgl: false } });
  printer.webContents.on('will-navigate', ev => ev.preventDefault());
  printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await printer.loadURL(tmpUrl);
    const pdf = await printer.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    const { dialog } = require('electron');
    const owner = BrowserWindow.fromWebContents(e.sender) || undefined;
    const r = await dialog.showSaveDialog(owner, { title: 'Save conversation as PDF', defaultPath: path.join(app.getPath('downloads'), safe + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fs.writeFile(r.filePath.toLowerCase().endsWith('.pdf') ? r.filePath : r.filePath + '.pdf', pdf);
    return { saved: true };
  } finally {
    printer.destroy();
    fs.rm(tmp, { force: true }).catch(() => {});
  }
});

/* ---------------- window ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 520,
    backgroundColor: '#0f0f0f',
    title: 'Noctyl',
    show: false,
    autoHideMenuBar: true,
    // custom title bar: the page draws a 40px draggable strip (see .titlebar in styles.css) and the OS
    // draws only the window controls, in Noctyl's colors, over its right end (left end on macOS)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f0f0f', symbolColor: '#e8eaed', height: 40 },
    // macOS: native traffic lights, centred in the 40px bar (the page leaves room for them)
    ...(process.platform === 'darwin' && { trafficLightPosition: { x: 14, y: 13 } }),
    // Linux / Windows taskbar icon when running unpackaged (packaged builds use the app icon)
    ...(process.platform !== 'darwin' && { icon: path.join(ROOT, 'build', 'icon.png') }),
    webPreferences: webPreferences(),
  });
  win.once('ready-to-show', () => { if (!hud) win.show(); });
  win.loadURL(`${ORIGIN}/index.html`);
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  lockWebContents(win.webContents);
  // closing the main window quits, HUD included
  win.on('closed', () => { win = null; quitting = true; if (hud && !hud.isDestroyed()) hud.close(); });
}

function lockPermissions() {
  const ses = session.defaultSession;
  const ok = (wc, permission, details = {}) => {
    const fromUs = (details.requestingUrl || wc?.getURL() || '').startsWith(ORIGIN + '/');
    if (!fromUs) return false;
    if (permission === 'clipboard-sanitized-write') return true;
    if (permission === 'media') return !(details.mediaTypes || []).includes('video');   // microphone only
    return false;
  };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(ok(wc, permission, details)));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => ok(wc, permission, { ...details, requestingUrl: requestingOrigin + '/' }));
}

app.on('second-instance', () => {
  if (hud && !hud.isDestroyed()) { hud.show(); hud.focus(); return; }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  serveApp();
  lockPermissions();
  createWindow();
  // HUD mode works from anywhere; if another app already owns the shortcut, the in-app one still works
  globalShortcut.register('CommandOrControl+Shift+H', toggleHud);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
