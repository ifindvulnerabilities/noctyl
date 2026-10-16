// Commands on a Noctyl server (the agent's run_command tool, from the web version): for ADMINS ONLY, and only once an
// admin has turned it on (config.commands = 'admins', Settings → Admin → Access; off by default).
//
// Commands run on the computer the server runs on, as the account the server runs as, with its permissions. The app
// still shows every command first and only sends it after an admin presses Allow; on top of that the server checks,
// for every command, that the session belongs to an admin (cookie sessions only: an API token can't run commands),
// writes each one to the server log, runs it without input, hidden, with a timeout that kills the whole process tree,
// and caps its output. Mirrors the desktop app's runner (electron/main.js).
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MAX_CMD_LEN = 8000, MAX_CAPTURE = 1024 * 1024;
const running = new Map();   // `${userId}:${id}` → child process
const onPath = exe => { try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { windowsHide: true, timeout: 3000 }).status === 0; } catch { return false; } };
let shellCache = null;
function shells() {
  return (shellCache ||= process.platform === 'win32'
    ? ['powershell', ...(onPath('pwsh') ? ['pwsh'] : []), 'cmd', ...(onPath('bash') ? ['bash'] : [])]
    : [...(onPath('bash') ? ['bash'] : []), ...(onPath('zsh') ? ['zsh'] : []), 'sh']);   // servers (Alpine…) may not have bash
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
const status = enabled => ({ enabled, shells: shells(), defaultShell: shells()[0], home: os.homedir(), platform: process.platform, server: true });

/**
 * Run one command and stream it back as lines of JSON: {"out":"…"} while it prints, then {"done":{…}} (the same result
 * the desktop app gives). Closing the request (Stop) kills it.
 */
function run(req, res, user, body, log) {
  const command = String(body?.command || '');
  if (!command.trim() || command.length > MAX_CMD_LEN || command.includes('\0')) throw Object.assign(new Error('Invalid command'), { status: 400 });
  const shell = shells().includes(body?.shell) ? body.shell : shells()[0];
  const cwd = path.resolve(String(body?.cwd || os.homedir()));
  try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { throw Object.assign(new Error(`Folder not found on the server: ${cwd}`), { status: 400 }); }
  const timeout = Math.min(Math.max(Number(body?.timeout) || 60, 1), 600) * 1000;
  const key = `${user.id}:${String(body?.id || '').slice(0, 40)}`;
  log(`[noctyl] ${user.name} ran a command (${shell}, in ${cwd}): ${command.length > 300 ? command.slice(0, 300) + '…' : command}`);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  const started = Date.now();
  let out = '', err = '', truncated = false, timedOut = false, stopped = false;
  const take = (buf, add) => { if (buf.length >= MAX_CAPTURE) { truncated = true; return buf; } return buf + add; };
  const [exe, args] = shellArgs(shell, command);
  let child;
  try { child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: process.env }); }
  catch (ex) { send({ done: { exitCode: null, stdout: '', stderr: String(ex.message), ms: 0, shell, cwd } }); return res.end(); }
  running.set(key, child);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  // live output in small batches (~10 a second), like the desktop app
  let pending = '', timer = null;
  const flush = () => { timer = null; if (pending) send({ out: pending }); pending = ''; };
  const live = d => { if (pending.length < 64 * 1024) pending += d; if (!timer) timer = setTimeout(flush, 100); };
  child.stdout.on('data', d => { out = take(out, d); live(d); });
  child.stderr.on('data', d => { err = take(err, d); live(d); });
  const kill = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
  // Stop in the app (or the page closing) ends the request: the command is killed
  res.on('close', () => { if (child.exitCode === null && !res.writableFinished) { stopped = true; killTree(child); } });
  let finished = false;
  const finish = (code, error) => {
    if (finished) return; finished = true;
    clearTimeout(kill); running.delete(key);
    if (timer) { clearTimeout(timer); flush(); }
    send({ done: { exitCode: code, stdout: out, stderr: err + (error ? String(error.message) : ''), ms: Date.now() - started, timedOut, aborted: stopped, truncated, shell, cwd } });
    res.end();
  };
  child.on('error', ex => finish(null, ex));
  child.on('close', code => finish(code));
}
/** turning commands off (or a restart) stops whatever is still running */
const stopAll = () => { for (const child of running.values()) killTree(child); };
process.on('exit', stopAll);

module.exports = { run, status, stopAll };
