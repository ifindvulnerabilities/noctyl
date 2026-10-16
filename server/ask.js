// The start scripts' network questions (start-server.bat / start-server.sh), the same on every system.
//
//   node server/ask.js mode <data>       who can sign in → single | open | admin
//   node server/ask.js port              the port → a number (8787 by default)
//   node server/ask.js host              which address to serve on → prints it (0.0.0.0, 127.0.0.1, or one of this
//                                        computer's addresses, like its Tailscale IP)
//   node server/ask.js ollama <data>     where Ollama runs (this computer, or another device such as a desktop with a GPU
//                                        on your tailnet) → prints its address, or "local"
//   node server/ask.js open <host> <port>  the address to open in a browser for that host
//
// Questions go to stderr and the answer to stdout, so a script can capture it. With nobody at the keyboard (a service)
// the default is printed without asking. NOCTYL_MODE / NOCTYL_PORT / NOCTYL_HOST / NOCTYL_OLLAMA answer them ahead of
// time. Ctrl+C (or Ctrl+D) at a question cancels: it prints CANCEL and exits with code 130, and the start scripts stop
// there without starting anything.
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const say = s => process.stderr.write(s + '\n');
const tailscale = (ip, name) => /tailscale/i.test(name) || (net.isIPv4(ip) && (() => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; })());

/** this computer's own addresses (IPv4 first), with Tailscale ones marked */
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, name, tailscale: tailscale(a.address, name) });
    }
  }
  return out.sort((x, y) => Number(y.tailscale) - Number(x.tailscale));
}

/** Ctrl+C / Ctrl+D at a question: stop here, and tell the start script not to go on */
function cancel() {
  say('\n\n  Cancelled. Nothing was started.\n');
  process.stdout.write('CANCEL\n');
  process.exit(130);
}
process.on('SIGINT', cancel);   // (when the terminal sends Ctrl+C as a signal rather than as a key)
function prompt(q) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(res => {
    let answered = false;
    // the terminal is in raw mode while asking, so Ctrl+C arrives here as a key, not as a signal to the script
    rl.on('SIGINT', cancel);
    rl.on('close', () => { if (!answered) cancel(); });   // Ctrl+D / end of input
    rl.question(q, a => { answered = true; rl.close(); res(a.trim()); });
  });
}

async function askMode(dataDir) {
  const env = String(process.env.NOCTYL_MODE || '').toLowerCase();
  if (['single', 'open', 'admin'].includes(env)) return env;
  let current = 'single';
  try { current = JSON.parse(fs.readFileSync(path.join(dataDir || '', 'config.json'), 'utf8')).registration || 'single'; } catch { /* first start */ }
  if (!process.stdin.isTTY) return current;
  say('');
  say('  Who can sign in?');
  say('    1  Just me: one account');
  say('    2  Several accounts: anyone who can open the page can sign up');
  say('    3  Several accounts: only admins add them');
  say('  Press Ctrl+C to cancel.');
  for (;;) {
    const a = await prompt(`  Choose 1, 2 or 3 [Enter keeps ${current}]: `);
    if (!a) return current;
    const m = { 1: 'single', 2: 'open', 3: 'admin' }[a];
    if (m) return m;
    say('  Please type 1, 2 or 3.');
  }
}
async function askPort() {
  const env = String(process.env.NOCTYL_PORT || '');
  if (/^\d+$/.test(env) && +env > 0 && +env < 65536) return env;
  if (!process.stdin.isTTY) return '8787';
  for (;;) {
    const a = await prompt('  Port [8787]: ');
    if (!a) return '8787';
    if (/^\d+$/.test(a) && +a > 0 && +a < 65536) return a;
    say('  Please type a number from 1 to 65535, like 8787.');
  }
}

/** "100.101.1.2", "desk:11434", "http://desk.tailnet.ts.net:11434/" → "http://…:11434" ("" when it isn't an address) */
function ollamaUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return '';
    if (!u.port && u.protocol === 'http:') u.port = '11434';
    return `${u.protocol}//${u.host}`;
  } catch { return ''; }
}

async function askHost() {
  if (process.env.NOCTYL_HOST) return process.env.NOCTYL_HOST;
  const own = addresses();
  say('');
  say('  Which address should it answer on?');
  say('    1  Every address this computer has (0.0.0.0): this computer, your network, and outside it if you forward a port');
  say('    2  Only this computer (127.0.0.1)');
  own.forEach((a, i) => say(`    ${i + 3}  Only ${a.ip}  (${a.tailscale ? 'Tailscale: only devices on your tailnet' : a.name})`));
  say('    Or type an address.');
  for (;;) {
    const a = await prompt('  Choose [1]: ');
    if (!a || a === '1') return '0.0.0.0';
    if (a === '2') return '127.0.0.1';
    const n = Number(a);
    if (Number.isInteger(n) && own[n - 3]) return own[n - 3].ip;
    if (net.isIP(a)) {
      if (!['0.0.0.0', '::', '127.0.0.1', '::1'].includes(a) && !own.some(x => x.ip === a)) say(`  Note: ${a} isn't one of this computer's addresses right now (is Tailscale or the network up?). The server can only start once it is.`);
      return a;
    }
    say('  Please choose a number from the list, or type an IP address like 100.64.0.1.');
  }
}

/** does Ollama answer there? (3 s; only to tell you, nothing depends on it) */
async function check(url) {
  try {
    const r = await fetch(url + '/api/version', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return `answers (Ollama ${j.version || '?'})`;
  } catch { return "isn't answering right now. That's fine: the server starts anyway; start Ollama there (with OLLAMA_HOST=0.0.0.0 so other devices can reach it), or change the address later in Settings → Admin → Access."; }
}

async function askOllama(dataDir) {
  let current = '';
  try { current = JSON.parse(fs.readFileSync(path.join(dataDir || '', 'config.json'), 'utf8')).ollamaUrl || ''; } catch { /* no config yet */ }
  if (process.env.NOCTYL_OLLAMA) return ollamaUrl(process.env.NOCTYL_OLLAMA) || 'local';
  say('');
  say('  Where does Ollama run? It doesn\'t have to be on this computer: another device on your network or tailnet');
  say('  (like a desktop with a GPU) works too. Type its address (e.g. 100.101.102.103 or my-desktop:11434),');
  say(`  "local" for this computer, or press Enter to keep ${current || 'this computer'}.`);
  for (;;) {
    const a = await prompt('  Ollama address: ');
    if (!a) {
      if (current && process.stdin.isTTY) say(`  Ollama at ${current} ${await check(current)}`);
      return current || 'local';
    }
    if (/^(local|localhost|this|none)$/i.test(a)) return 'local';
    const u = ollamaUrl(a);
    if (!u) { say('  That doesn\'t look like an address. Try 100.101.102.103 or http://my-desktop:11434'); continue; }
    say(`  Ollama at ${u} ${await check(u)}`);
    return u;
  }
}

const openUrl = (host, port) => {
  const h = !host || ['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost'].includes(host) ? '127.0.0.1' : net.isIPv6(host) ? `[${host}]` : host;
  return `http://${h}:${port}`;
};

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  (async () => {
    if (cmd === 'mode') console.log(await askMode(a));
    else if (cmd === 'port') console.log(await askPort());
    else if (cmd === 'host') console.log(await askHost());
    else if (cmd === 'ollama') console.log(await askOllama(a));
    else if (cmd === 'open') console.log(openUrl(a, b));
    else { say('Usage: node server/ask.js mode <data folder> | port | host | ollama <data folder> | open <host> <port>'); process.exit(1); }
  })();
}
module.exports = { addresses, ollamaUrl, openUrl };
