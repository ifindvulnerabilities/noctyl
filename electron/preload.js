// Preload: the only bridge between the page and Electron. contextIsolation + sandbox are on, so the page
// never gets Node.js or Electron APIs, just this small frozen object.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// net: outside requests are made by the main process (no browser CORS limits) and streamed back here.
let seq = 0;
const sinks = new Map();   // id → { chunk(Uint8Array), end(error|null) }
ipcRenderer.on('net:chunk', (_e, id, chunk) => sinks.get(id)?.chunk(chunk));
ipcRenderer.on('net:end', (_e, id, error) => { const s = sinks.get(id); sinks.delete(id); s?.end(error); });

// invoke a main-process handler; errors come back without Electron's "Error invoking remote method …" prefix
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)
  .catch(err => { throw new Error(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
const plainCfg = c => ({ baseUrl: String(c?.baseUrl || ''), model: String(c?.model || ''), key: String(c?.key || '') });
const plainCol = c => ({ id: String(c?.id || ''), name: String(c?.name || ''), paths: (Array.isArray(c?.paths) ? c.paths : []).map(String) });

contextBridge.exposeInMainWorld('noctylDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,                  // 'win32' | 'darwin' | 'linux'
  versions: Object.freeze({ electron: process.versions.electron, chrome: process.versions.chrome }),
  /**
   * Start a request. onChunk(Uint8Array) receives the body as it streams; onEnd(null | 'AbortError' | message).
   * Returns { id, head } where head resolves to { status, statusText, headers: [[name, value], …] }.
   */
  netRequest(req, onChunk, onEnd) {
    const id = ++seq;
    sinks.set(id, { chunk: onChunk, end: onEnd });
    const head = ipcRenderer.invoke('net:request', id, {
      url: String(req.url), method: String(req.method || 'GET'),
      headers: Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [String(k), String(v)])),
      body: typeof req.body === 'string' ? req.body : undefined,
    }).catch(err => { sinks.delete(id); throw new Error(String(err?.message || err).replace(/^Error invoking remote method 'net:request': (Error: )?/, '')); });
    return { id, head };
  },
  netAbort(id) { ipcRenderer.send('net:abort', id); },
  /** background color behind the OS window buttons (#rrggbb), e.g. dimmed while a dialog is open */
  setTitleBarColor(color, symbols) { ipcRenderer.send('window:titlebar-color', String(color), String(symbols || '')); },
  /** the window's appearance: 'system' | 'dark' | 'light' */
  setTheme: mode => call('window:theme', ['dark', 'light'].includes(mode) ? mode : 'system'),
  /** render a standalone HTML page (no scripts) to PDF and ask where to save it → { saved: true } | { canceled: true } */
  savePdf: (html, name) => ipcRenderer.invoke('chat:pdf', String(html), String(name || 'conversation')),
  // shell commands for the model's run_command tool: only after you approve each one in the chat,
  // and only while command access is on (switched on through a native dialog in the main process)
  commands: Object.freeze({
    status: () => ipcRenderer.invoke('cmd:status'),            // { enabled, shells, defaultShell, home, platform }
    enable: () => ipcRenderer.invoke('cmd:enable'),            // shows the confirmation dialog → { enabled }
    disable: () => ipcRenderer.invoke('cmd:disable'),
    pickDir: current => ipcRenderer.invoke('cmd:pick-dir', String(current || '')),
    // → { id, done: Promise<{ exitCode, stdout, stderr, ms, timedOut, aborted, truncated, shell, cwd }> }
    // onOutput(text): what the command prints, as it prints it (stdout and stderr together)
    run(req, onOutput) {
      const id = ++seq;
      const listener = (_e, cid, text) => { if (cid === id && typeof onOutput === 'function') onOutput(String(text)); };
      ipcRenderer.on('cmd:out', listener);
      const done = ipcRenderer.invoke('cmd:run', id, { command: String(req.command), cwd: String(req.cwd || ''), shell: String(req.shell || ''), timeout: Number(req.timeout) || 60 })
        .catch(err => { throw new Error(String(err?.message || err).replace(/^Error invoking remote method 'cmd:run': (Error: )?/, '')); })
        .finally(() => ipcRenderer.removeListener('cmd:out', listener));
      return { id, done };
    },
    abort: id => ipcRenderer.send('cmd:abort', id),
  }),
  // local model runtimes: Ollama / llama.cpp detection, start, install; GGUF files you pick
  runtime: Object.freeze({
    status: ollamaUrl => call('rt:status', String(ollamaUrl || '')),          // { ollama: { running, version, exe, local }, llama: { path, managed } | null }
    startOllama: ollamaUrl => call('rt:start-ollama', String(ollamaUrl || '')),
    installLlama: () => call('rt:install-llama'),                             // → { path, tag, asset }
    pickGguf: () => call('gguf:pick'),                                        // file dialog → [{ path, name, size }]
    forgetGguf: p => call('gguf:forget', String(p)),
    listGguf: () => call('gguf:list'),
    ensureModel: (p, opts = {}) => call('gguf:ensure', String(p), { ctx: Number(opts.ctx) || 4096 }),  // → base URL
    onProgress(cb) { const h = (_e, p) => cb(p); ipcRenderer.on('rt:progress', h); return () => ipcRenderer.removeListener('rt:progress', h); },
  }),
  // Noctyl's own data as files in the app data folder (settings, preferences, chats, images); see electron/store.js
  store: Object.freeze({
    loadSync: () => ipcRenderer.sendSync('store:load'),             // { exists, settings, ui, chats, dir, defaults } (read once at start)
    save: data => call('store:save', data),                         // changed files only, atomic
    saveSync: data => ipcRenderer.sendSync('store:save-sync', data), // for the last save before the window closes
    erase: () => call('store:erase'),
    path: () => call('store:path'),
    images: Object.freeze({
      put: (id, rec) => call('img:put', String(id), rec),
      get: id => call('img:get', String(id)),
      keys: () => call('img:keys'),
      del: ids => call('img:del', (ids || []).map(String)),
      clear: () => call('img:clear'),
    }),
  }),
  // the Noctyl folder (skills/, agents/, models/, llama.cpp/) and Hugging Face downloads
  library: Object.freeze({
    info: () => call('appdir:info'),                                   // { path, default }
    open: which => call('appdir:open', String(which || '')),           // opens the folder (or a subfolder) in Explorer
    choose: () => call('appdir:choose'),                               // folder picker → new path | null
    read: () => call('library:read'),                                  // { skills, agents } from the folder
    writeSkills: list => call('library:write-skills', list),
    writeAgents: list => call('library:write-agents', list),
    // Skills: <Noctyl folder>/skills/<name>/SKILL.md (or <name>.md), one at a time
    listSkills: () => call('skills:list'),                                          // → [summary]
    readSkill: name => call('skills:read', String(name || '')),                     // → summary + { body, text }
    readSkillFile: (name, rel) => call('skills:read-file', String(name || ''), String(rel || '')),
    saveSkill: req => call('skills:save', {                                         // → summary
      name: String(req?.name || ''), previousName: String(req?.previousName || ''), body: String(req?.body || ''),
      meta: Object.fromEntries(['title', 'description', 'when_to_use', 'author'].map(k => [k, String(req?.meta?.[k] || '')]).concat([['tags', (Array.isArray(req?.meta?.tags) ? req.meta.tags : []).map(String)]])),
      files: (Array.isArray(req?.files) ? req.files : []).map(f => ({ path: String(f?.path || ''), content: String(f?.content ?? '') })),
    }),
    deleteSkill: name => call('skills:delete', String(name || '')),                 // moves it to the Recycle Bin / Trash
    revealSkill: name => call('skills:reveal', String(name || '')),
    download: req => call('hf:download', { id: String(req.id), repo: String(req.repo), file: String(req.file) }),   // → { paths, main, size }
    cancelDownload: id => ipcRenderer.send('hf:cancel', String(id)),
    onProgress(cb) { const h = (_e, p) => cb(p); ipcRenderer.on('hf:progress', h); return () => ipcRenderer.removeListener('hf:progress', h); },
  }),
  // /nuke-messages: confirm (native dialog) → the page wipes its copy → run (Ollama, llama.cpp, storage) + PowerShell check
  // Knowledge (local RAG): project folders you pick, indexed with your embedding server, searched on this computer
  knowledge: Object.freeze({
    pick: () => call('knowledge:pick'),                                                // folder dialog → [paths] (and allows them)
    index: (col, cfg) => call('knowledge:index', plainCol(col), plainCfg(cfg)),       // → { files, chunks, model, updated, skipped }
    cancel: id => ipcRenderer.send('knowledge:cancel', String(id || '')),
    info: id => call('knowledge:info', String(id || '')),
    remove: id => call('knowledge:remove', String(id || '')),
    search: (ids, query, cfg, k) => call('knowledge:search', (Array.isArray(ids) ? ids : []).map(String), String(query || ''), plainCfg(cfg), Number(k) || 6),
    test: cfg => call('knowledge:test', plainCfg(cfg)),                               // → { dims, model }
    reveal: p => call('knowledge:reveal', String(p || '')),
    onProgress(cb) { const h = (_e, p) => cb(p); ipcRenderer.on('knowledge:progress', h); return () => ipcRenderer.removeListener('knowledge:progress', h); },
  }),
  // a file the model wrote or made: saved to Downloads, then (optionally) opened or shown in its folder
  files: Object.freeze({
    save: req => call('file:save', { name: String(req?.name || ''), data: String(req?.data ?? ''), encoding: req?.encoding === 'base64' ? 'base64' : 'utf8', then: ['open', 'reveal'].includes(req?.then) ? req.then : '' }),
    reveal: p => call('file:reveal', String(p || '')),
  }),
  nuke: Object.freeze({
    confirm: info => call('nuke:confirm', { noctylChats: Number(info?.noctylChats) || 0 }),
    run: opts => call('nuke:run', { ollamaUrl: String(opts?.ollamaUrl || ''), llamaUrls: (opts?.llamaUrls || []).map(String), needles: (opts?.needles || []).map(String) }),
  }),
  // HUD mode: a small always-on-top chat bar window (see openHud in main.js)
  hud: Object.freeze({
    set: (open, opts = {}) => ipcRenderer.send('hud:set', !!open, { settingsTab: String(opts.settingsTab || '') }),
    reportChat: id => ipcRenderer.send('hud:chat', String(id || '')),       // conversation on screen, so the other window opens it
    clickThrough: through => ipcRenderer.send('hud:click-through', !!through),
    drag: phase => ipcRenderer.send('hud:drag', phase === 'start' ? 'start' : 'end'),
    onClosed(cb) {                                                            // main window: the HUD was closed → { chatId, settingsTab }
      const h = (_e, info) => cb(info);
      ipcRenderer.on('hud:closed', h);
      return () => ipcRenderer.removeListener('hud:closed', h);
    },
  }),
  // local Whisper dictation (runs in a separate process; audio never leaves this computer)
  dictation: Object.freeze({
    engine: 'whisper',
    status: () => ipcRenderer.invoke('dictation:status'),                  // { cached, loaded, loading, model, sizeMB }
    prepare: () => ipcRenderer.invoke('dictation:prepare'),                // download (first time) + load the model
    transcribe: audio => ipcRenderer.invoke('dictation:transcribe', audio), // Float32Array, 16 kHz mono → text
    onProgress(cb) {                                                         // download progress per file; returns an unsubscribe
      const h = (_e, p) => cb(p);
      ipcRenderer.on('dictation:progress', h);
      return () => ipcRenderer.removeListener('dictation:progress', h);
    },
  }),
}));
