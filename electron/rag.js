// Knowledge (local RAG): your project folders → text excerpts → embeddings → search, kept on this computer.
//
//   <app data>/knowledge/<id>.json   the project's excerpts (file, lines, text) and which files they came from
//   <app data>/knowledge/<id>.bin    their embeddings (Float32, normalised, one row per excerpt)
//   <app data>/knowledge/allowed.json  folders and files you picked in the folder dialog: the only places indexed
//
// Embeddings come from the server you set in Settings → Knowledge (any OpenAI-compatible /embeddings API: Ollama,
// llama.cpp started with --embeddings, LM Studio, vLLM, …). Re-indexing only re-reads and re-embeds files that
// changed. Excerpts never leave this computer except to that embedding server.
'use strict';
const { app, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = () => path.join(app.getPath('userData'), 'knowledge');
const ALLOWED = () => path.join(DIR(), 'allowed.json');
const ID = /^kb-[\w-]{1,40}$/;
const TEXT_EXT = new Set(('md markdown mdx txt rst adoc org tex csv tsv json jsonc json5 yaml yml toml ini cfg conf env.example xml html htm css scss sass less ' +
  'js mjs cjs jsx ts tsx vue svelte astro py pyi ipynb rb php java kt kts scala go rs c h cc cpp cxx hpp hh cs fs fsx vb swift m mm dart lua r jl ' +
  'pl pm sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto tf hcl dockerfile makefile cmake gradle properties gitignore editorconfig ' +
  'log srt vtt bib').split(' '));
const NAMED = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'jenkinsfile']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.nuxt', '.cache',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.idea', '.vscode', 'coverage', '.terraform', 'vendor', '.gradle']);
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx)|id_(rsa|ed25519|ecdsa)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const MAX_FILE = 1024 * 1024, MAX_FILES = 5000, MAX_CHUNKS = 60000, CHUNK = 1400, OVERLAP = 200, BATCH = 32;

/* ---------- which folders may be read: only ones you picked ---------- */
function allowedList() { try { return JSON.parse(fs.readFileSync(ALLOWED(), 'utf8')).filter(p => typeof p === 'string'); } catch { return []; } }
function allow(paths) {
  fs.mkdirSync(DIR(), { recursive: true });
  const set = new Set(allowedList());
  paths.forEach(p => set.add(path.resolve(p)));
  fs.writeFileSync(ALLOWED(), JSON.stringify([...set]));
}
const isAllowed = p => { const r = path.resolve(p).toLowerCase(); return allowedList().some(a => { const x = a.toLowerCase(); return r === x || r.startsWith(x.endsWith(path.sep) ? x : x + path.sep); }); };

/* ---------- embeddings (OpenAI-compatible POST /embeddings) ---------- */
function cleanCfg(cfg) {
  const baseUrl = String(cfg?.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/embeddings$/i, '');
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new Error('Set the embedding server URL in Settings → Knowledge');
  const model = String(cfg?.model || '').trim();
  if (!model) throw new Error('Set the embedding model in Settings → Knowledge');
  return { baseUrl, model, key: String(cfg?.key || '') };
}
async function embed(cfg, texts, signal) {
  const res = await net.fetch(cfg.baseUrl + '/embeddings', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(cfg.key && { Authorization: 'Bearer ' + cfg.key }) },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || ''; } catch { /* not JSON */ }
    throw new Error(`Embedding server: ${detail || 'HTTP ' + res.status}`);
  }
  const j = await res.json();
  const rows = (Array.isArray(j.data) ? j.data : []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(d => d.embedding);
  if (rows.length !== texts.length || !rows.every(r => Array.isArray(r) && r.length)) throw new Error("The embedding server's answer didn't have one embedding per text");
  return rows.map(normalise);
}
function normalise(v) {
  const out = Float32Array.from(v);
  let n = 0; for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}
async function test(cfg) {
  const c = cleanCfg(cfg);
  const [v] = await embed(c, ['Noctyl embedding test'], AbortSignal.timeout(60000));
  return { dims: v.length, model: c.model };
}

/* ---------- reading a project ---------- */
const isText = name => { const n = name.toLowerCase(); return NAMED.has(n) || TEXT_EXT.has(n.split('.').pop()) || TEXT_EXT.has(n.split('.').slice(-2).join('.')); };
async function listFiles(roots, skipped) {
  const out = [];
  const walk = async (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let list = [];
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= MAX_FILES) { skipped.limit = true; return; }
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(p, depth + 1); }
      else if (e.isFile()) {
        if (SECRET_FILE.test(e.name)) { skipped.secret++; continue; }
        if (isText(e.name)) out.push(p); else skipped.type++;
      }
    }
  };
  for (const r of roots) {
    let st; try { st = await fsp.stat(r); } catch { continue; }
    if (st.isDirectory()) await walk(r, 0);
    else if (st.isFile() && !SECRET_FILE.test(r)) out.push(r);
  }
  return [...new Set(out)];
}
/** Split a file into overlapping excerpts on line boundaries: [{ l (first line, 1-based), e (last line), t }] */
function chunk(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let start = 0;
  while (start < lines.length) {
    let len = 0, end = start;
    while (end < lines.length && (len + lines[end].length + 1 <= CHUNK || end === start)) { len += Math.min(lines[end].length, CHUNK) + 1; end++; }
    const t = lines.slice(start, end).join('\n').slice(0, CHUNK * 2);
    if (t.trim()) out.push({ l: start + 1, e: end, t });
    if (end >= lines.length) break;
    // step back a little so an idea that crosses the cut is in both excerpts
    let back = end, kept = 0;
    while (back > start + 1 && kept < OVERLAP) { back--; kept += lines[back].length + 1; }
    start = Math.max(back, start + 1);
  }
  return out;
}

/* ---------- the index on disk ---------- */
const metaFile = id => path.join(DIR(), id + '.json');
const vecFile = id => path.join(DIR(), id + '.bin');
const cache = new Map();   // id → { mtime, meta, vecs: Float32Array }
async function load(id) {
  let st; try { st = await fsp.stat(metaFile(id)); } catch { return null; }
  const c = cache.get(id);
  if (c && c.mtime === st.mtimeMs) return c;
  const meta = JSON.parse(await fsp.readFile(metaFile(id), 'utf8'));
  const buf = await fsp.readFile(vecFile(id));
  const vecs = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const entry = { mtime: st.mtimeMs, meta, vecs };
  cache.set(id, entry);
  return entry;
}
async function writeIndex(id, meta, vecs) {
  await fsp.mkdir(DIR(), { recursive: true });
  const tmp = `.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(vecFile(id) + tmp, Buffer.from(vecs.buffer, vecs.byteOffset, vecs.byteLength));
  await fsp.rename(vecFile(id) + tmp, vecFile(id));
  await fsp.writeFile(metaFile(id) + tmp, JSON.stringify(meta));
  await fsp.rename(metaFile(id) + tmp, metaFile(id));
  cache.delete(id);
}

const jobs = new Map();   // id → AbortController
/** (Re-)index a project. col: { id, name, paths }. onProgress({ phase, done, total, file }). */
async function index(col, cfgIn, onProgress) {
  const id = String(col?.id || '');
  if (!ID.test(id)) throw new Error('Bad project id');
  const roots = (Array.isArray(col.paths) ? col.paths : []).map(String).filter(p => path.isAbsolute(p));
  if (!roots.length) throw new Error('Add a folder to this project first');
  const notAllowed = roots.find(p => !isAllowed(p));
  if (notAllowed) throw new Error(`Pick ${notAllowed} with Add folder first`);
  const cfg = cleanCfg(cfgIn);
  jobs.get(id)?.abort();
  const ac = new AbortController();
  jobs.set(id, ac);
  try {
    const old = await load(id).catch(() => null);
    const sameModel = old && old.meta.model === cfg.model && old.meta.baseUrl === cfg.baseUrl;
    const skipped = { type: 0, big: 0, secret: 0, unreadable: 0, limit: false };
    onProgress({ phase: 'scan', done: 0, total: 0 });
    const files = await listFiles(roots, skipped);
    const fold = s => (process.platform === 'linux' ? s : s.toLowerCase());   // Linux paths are case-sensitive
    const rootOf = f => roots.filter(r => fold(f).startsWith(fold(r))).sort((a, b) => b.length - a.length)[0] || path.dirname(f);
    const rel = f => { const r = rootOf(f); const base = path.basename(r); return f === r ? path.basename(f) : `${base}/${path.relative(r, f).split(path.sep).join('/')}`; };

    // reuse excerpts (and their embeddings) of files that haven't changed
    const reuse = new Map();
    if (sameModel) {
      old.meta.files.forEach((f, fi) => reuse.set(f.path, { ...f, rows: [] }));
      old.meta.chunks.forEach((c, row) => reuse.get(old.meta.files[c.f].path)?.rows.push(row));
    }
    const dims = sameModel ? old.meta.dims : 0;
    const outFiles = [], outChunks = [], pending = [];   // pending: { chunkIndex, text }
    const keptVecs = [];   // [{ chunkIndex, vec }]
    let n = 0;
    for (const f of files) {
      if (ac.signal.aborted) throw new Error('Stopped');
      onProgress({ phase: 'read', done: n++, total: files.length, file: rel(f) });
      let st; try { st = await fsp.stat(f); } catch { skipped.unreadable++; continue; }
      if (st.size > MAX_FILE) { skipped.big++; continue; }
      const prev = reuse.get(f);
      const fi = outFiles.length;
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
        outFiles.push({ path: f, rel: rel(f), mtime: st.mtimeMs, size: st.size });
        for (const row of prev.rows) {
          const c = old.meta.chunks[row];
          keptVecs.push({ chunkIndex: outChunks.length, vec: old.vecs.subarray(row * dims, row * dims + dims) });
          outChunks.push({ f: fi, l: c.l, e: c.e, t: c.t });
        }
        continue;
      }
      let text;
      try { text = await fsp.readFile(f, 'utf8'); } catch { skipped.unreadable++; continue; }
      if (text.includes('\u0000')) { skipped.type++; continue; }   // binary after all
      outFiles.push({ path: f, rel: rel(f), mtime: st.mtimeMs, size: st.size });
      for (const c of chunk(text)) {
        if (outChunks.length >= MAX_CHUNKS) { skipped.limit = true; break; }
        pending.push({ chunkIndex: outChunks.length, text: `File: ${rel(f)} (lines ${c.l}-${c.e})\n\n${c.t}` });
        outChunks.push({ f: fi, ...c });
      }
    }
    // embed what's new, in batches
    const newVecs = [];
    for (let i = 0; i < pending.length; i += BATCH) {
      if (ac.signal.aborted) throw new Error('Stopped');
      onProgress({ phase: 'embed', done: i, total: pending.length });
      const part = pending.slice(i, i + BATCH);
      const vs = await embed(cfg, part.map(p => p.text), AbortSignal.any([ac.signal, AbortSignal.timeout(180000)]));
      vs.forEach((v, k) => newVecs.push({ chunkIndex: part[k].chunkIndex, vec: v }));
    }
    const d = newVecs[0]?.vec.length || dims || 0;
    if (newVecs.some(v => v.vec.length !== d)) throw new Error('The embedding server returned embeddings of different sizes');
    const vecs = new Float32Array(outChunks.length * d);
    for (const { chunkIndex, vec } of [...keptVecs, ...newVecs]) vecs.set(vec, chunkIndex * d);
    const meta = { version: 1, id, name: String(col.name || ''), model: cfg.model, baseUrl: cfg.baseUrl, dims: d, roots, files: outFiles, chunks: outChunks, updated: Date.now(), skipped };
    await writeIndex(id, meta, vecs);
    onProgress({ phase: 'done', done: outChunks.length, total: outChunks.length });
    return summary(meta, pending.length);
  } finally { if (jobs.get(id) === ac) jobs.delete(id); }
}
const summary = (meta, embedded = 0) => ({ files: meta.files.length, chunks: meta.chunks.length, model: meta.model, updated: meta.updated, skipped: meta.skipped, embedded });
function cancel(id) { jobs.get(String(id))?.abort(); }
async function info(id) { const c = await load(String(id)).catch(() => null); return c ? summary(c.meta) : null; }
async function remove(id) {
  if (!ID.test(String(id))) throw new Error('Bad project id');
  cancel(id); cache.delete(id);
  await fsp.rm(metaFile(id), { force: true }); await fsp.rm(vecFile(id), { force: true });
  return true;
}

/** Search projects for a question: the best excerpts across all of them. → [{ project, name, file, lines, text, score }] */
async function search(ids, query, cfgIn, k = 6) {
  const q = String(query || '').trim().slice(0, 4000);
  if (!q) return [];
  const cfg = cleanCfg(cfgIn);
  const [qv] = await embed(cfg, [q], AbortSignal.timeout(60000));
  const hits = [];
  for (const id of (Array.isArray(ids) ? ids : []).map(String).filter(x => ID.test(x))) {
    const c = await load(id).catch(() => null);
    if (!c || c.meta.dims !== qv.length) continue;
    const { meta, vecs } = c, d = meta.dims;
    for (let row = 0; row < meta.chunks.length; row++) {
      let s = 0;
      for (let j = 0, o = row * d; j < d; j++) s += vecs[o + j] * qv[j];
      hits.push({ id, row, s });
    }
  }
  hits.sort((a, b) => b.s - a.s);
  const out = [];
  for (const hit of hits.slice(0, Math.min(Math.max(1, Number(k) || 6), 20))) {
    const { meta } = cache.get(hit.id);
    const c = meta.chunks[hit.row];
    out.push({ project: hit.id, name: meta.name, file: meta.files[c.f].rel, path: meta.files[c.f].path, lines: `${c.l}-${c.e}`, text: c.t, score: Math.round(hit.s * 1000) / 1000 });
  }
  return out;
}

module.exports = { allow, isAllowed, test, index, cancel, info, remove, search, chunk };
