// Usage numbers for the Noctyl server (Settings → Server → Usage): how much each account uses, never what it says.
//
//   <data>/stats.json   per day (the server's local date) and account:
//     { r: model requests, e: failed ones, ti: tokens in, to: tokens out, s: sign-ins,
//       m: { "host|model": [requests, tokens in, tokens out] }, sh: { sharedProviderId: requests } }
//
// Tokens are counted when the provider reports them in its answer (Anthropic, Ollama, llama.cpp and most OpenAI-
// compatible servers do; OpenAI itself only when asked to). Kept in memory and written 2 seconds after a change (and on
// exit), so a hard stop loses at most that.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const pad = n => String(n).padStart(2, '0');
const dayKey = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class Stats {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'stats.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    if (!this.data.days || typeof this.data.days !== 'object') this.data = { v: 1, days: {} };
    this.dirty = false;
    this.timer = null;
    process.on('exit', () => this.flush());
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { this.flush(); process.exit(0); });
  }
  /** something changed: write it soon (one write for a burst of changes) */
  touch() { this.dirty = true; if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000); }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[noctyl] could not save usage numbers:', e.message); this.touch(); }
  }
  row(userId, day = dayKey()) {
    const d = (this.data.days[day] ||= {});
    return (d[userId] ||= { r: 0, e: 0, ti: 0, to: 0, s: 0, m: {}, sh: {} });
  }
  /** a model request finished: { host, model, ok, tokensIn, tokensOut, shared } */
  request(userId, u) {
    const r = this.row(userId);
    r.r++; if (!u.ok) r.e++;
    r.ti += u.tokensIn || 0; r.to += u.tokensOut || 0;
    const k = `${u.host}|${String(u.model || '(unknown)').slice(0, 120)}`;
    const m = (r.m[k] ||= [0, 0, 0]);
    m[0]++; m[1] += u.tokensIn || 0; m[2] += u.tokensOut || 0;
    if (u.shared) r.sh[u.shared] = (r.sh[u.shared] || 0) + 1;
    this.touch();
  }
  signIn(userId) { this.row(userId).s++; this.touch(); }
  /** requests this account made through a shared provider today (for its daily limit) */
  sharedToday(userId, sharedId) { return this.data.days[dayKey()]?.[userId]?.sh?.[sharedId] || 0; }
  lastActive(userId) {
    const days = Object.keys(this.data.days).filter(d => this.data.days[d][userId]?.r).sort();
    return days.at(-1) || '';
  }
  forget(userId) { for (const d of Object.values(this.data.days)) delete d[userId]; this.touch(); }

  /**
   * { from, to: 'YYYY-MM-DD' (inclusive; empty = all), group: 'day'|'month'|'year', userIds: [ids] | null }
   * → { buckets: [{ period, requests, errors, tokensIn, tokensOut, signIns, users }], byUser: [{ id, … }], byModel: [{ host, model, … }], totals }
   */
  query({ from = '', to = '', group = 'day', userIds = null } = {}) {
    const cut = { day: 10, month: 7, year: 4 }[group] || 10;
    const want = id => !userIds || userIds.includes(id);
    const buckets = new Map(), byUser = new Map(), byModel = new Map();
    const totals = { requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, signIns: 0, users: new Set() };
    const add = (o, r) => { o.requests += r.r; o.errors += r.e; o.tokensIn += r.ti; o.tokensOut += r.to; o.signIns += r.s; };
    const blank = () => ({ requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, signIns: 0 });
    for (const day of Object.keys(this.data.days).filter(d => DAY.test(d)).sort()) {
      if ((from && day < from) || (to && day > to)) continue;
      for (const [id, r] of Object.entries(this.data.days[day])) {
        if (!want(id)) continue;
        const p = day.slice(0, cut);
        const b = buckets.get(p) || { period: p, ...blank(), users: new Set() };
        add(b, r); if (r.r || r.s) b.users.add(id); buckets.set(p, b);
        const u = byUser.get(id) || { id, ...blank(), lastActive: '' };
        add(u, r); if (r.r) u.lastActive = day; byUser.set(id, u);
        add(totals, r); if (r.r || r.s) totals.users.add(id);
        for (const [k, [n, ti, to2]] of Object.entries(r.m || {})) {
          const [host, model] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
          const m = byModel.get(k) || { host, model, requests: 0, tokensIn: 0, tokensOut: 0 };
          m.requests += n; m.tokensIn += ti; m.tokensOut += to2; byModel.set(k, m);
        }
      }
    }
    const count = o => ({ ...o, users: o.users.size });
    return {
      buckets: [...buckets.values()].map(count),
      byUser: [...byUser.values()].sort((a, b) => b.requests - a.requests),
      byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests).slice(0, 50),
      totals: count(totals),
    };
  }
}

/** Tokens from a model's answer (streamed or not), from its first and last bytes: { tokensIn, tokensOut } or zeros. */
function usageOf(text) {
  const last = re => { let m, v = null; const g = new RegExp(re, 'g'); while ((m = g.exec(text))) v = Number(m[1]); return v; };
  const first = re => { const m = new RegExp(re).exec(text); return m ? Number(m[1]) : null; };
  return {
    tokensIn: last('"prompt_tokens"\\s*:\\s*(\\d+)') ?? first('"input_tokens"\\s*:\\s*(\\d+)') ?? last('"prompt_eval_count"\\s*:\\s*(\\d+)') ?? 0,
    tokensOut: last('"completion_tokens"\\s*:\\s*(\\d+)') ?? last('"output_tokens"\\s*:\\s*(\\d+)') ?? last('"eval_count"\\s*:\\s*(\\d+)') ?? 0,
  };
}

module.exports = { Stats, usageOf, dayKey };
