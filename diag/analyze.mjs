// Summarises a tracefs capture (trace_pipe text) of a CI-faithful job:
// every rename syscall of a node thread, the slow ones (>= 20 ms) with the
// block-layer and writeback activity in the same seconds, and each measured
// phase's block traffic by issuer. Usage: node analyze.mjs trace.txt marks.txt
import { readFileSync } from 'node:fs';
const [traceFile, marksFile] = process.argv.slice(2);
const marks = readFileSync(marksFile, 'utf8').trim().split('\n').map((text) => { const [name, at] = text.split(' '); return { name, at: Number(at) }; });
const line = /^\s*(.+?)-(\d+)\s+\[\d+\]\s+\S+\s+([\d.]+): (.*)$/u;
const open = new Map(), renames = [], issued = new Map(), requests = [], writeback = [], lazy = [];
for (const text of readFileSync(traceFile, 'utf8').split('\n')) {
  const m = text.match(line); if (!m) continue;
  const [, comm, pid, ts, body] = m; const t = Number(ts);
  if (body.startsWith('sys_rename')) {
    if (!body.includes(' -> ')) { open.set(pid, { t, comm }); continue; }
    const start = open.get(pid); if (start) { renames.push({ t: start.t, ms: (t - start.t) * 1000, comm: start.comm }); open.delete(pid); }
    continue;
  }
  const event = body.slice(0, body.indexOf(':')), rest = body.slice(body.indexOf(':') + 2);
  if (event === 'block_rq_issue') {
    const r = rest.match(/^(\d+,\d+) (\S+) (\d+) \(.*?\) (\d+) \+ (\d+) (?:\S+ )?\[(.*)\]$/u);
    if (r) issued.set(`${r[1]}:${r[4]}`, { t, rwbs: r[2], bytes: Number(r[5]) * 512, issuer: r[6] });
  } else if (event === 'block_rq_complete') {
    const r = rest.match(/^(\d+,\d+) (\S+) \(.*?\) (\d+) \+ (\d+)/u);
    if (r) { const key = `${r[1]}:${r[3]}`, start = issued.get(key); if (start) { requests.push({ ...start, ms: (t - start.t) * 1000 }); issued.delete(key); } }
  } else if (event.startsWith('writeback_')) writeback.push({ t, event, rest: rest.slice(0, 160) });
  else if (event.includes('lazy_itable')) lazy.push({ t, rest });
}
const phase = (t) => { let name = 'before'; for (const mark of marks) if (t >= mark.at) name = mark.name; return name; };
const own = renames.filter((r) => r.comm === 'node' || r.comm.startsWith('libuv'));
const byPhase = {};
for (const r of own) {
  const p = (byPhase[phase(r.t)] ??= { renames: 0, over20: 0, over100: 0, maxMs: 0 });
  p.renames++; if (r.ms >= 20) p.over20++; if (r.ms >= 100) p.over100++; p.maxMs = Math.max(p.maxMs, Math.round(r.ms));
}
console.log('marks', JSON.stringify(marks));
console.log('requests traced', requests.length, 'renames traced', own.length);
console.log('renames by phase', JSON.stringify(byPhase));
console.log('lazy itable init events', lazy.length, lazy.length ? `first ${lazy[0].t} last ${lazy.at(-1).t}` : '');
const perSecond = new Map();
for (const r of requests) {
  const s = perSecond.get(Math.floor(r.t)) ?? {}; const k = `${r.issuer}/${r.rwbs}`;
  s[k] = s[k] ?? { n: 0, bytes: 0, slow: 0 }; s[k].n++; s[k].bytes += r.bytes; if (r.ms >= 50) s[k].slow++;
  perSecond.set(Math.floor(r.t), s);
}
for (const r of own.filter((r) => r.ms >= 20)) {
  const s = Math.floor(r.t);
  console.log(`SLOW t=${r.t.toFixed(3)} phase=${phase(r.t)} ms=${r.ms.toFixed(1)} comm=${r.comm}`);
  for (const k of [s - 1, s, s + 1]) console.log(`   io ${k}: ${Object.entries(perSecond.get(k) ?? {}).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5).map(([name, v]) => `${name} n=${v.n} kB=${Math.round(v.bytes / 1024)} slow=${v.slow}`).join('; ')}`);
  for (const w of writeback.filter((w) => w.t >= r.t - 2 && w.t <= r.t + 1).slice(0, 6)) console.log(`   wb ${w.event}@${w.t.toFixed(2)} ${w.rest}`);
}
for (const mark of marks.filter((m) => m.name.startsWith('perf'))) {
  const next = marks[marks.indexOf(mark) + 1]?.at ?? Infinity;
  const totals = {};
  for (const r of requests.filter((r) => r.t >= mark.at && r.t < next)) { const k = `${r.issuer}/${r.rwbs}`; totals[k] = totals[k] ?? { n: 0, kB: 0, slow: 0 }; totals[k].n++; totals[k].kB += Math.round(r.bytes / 1024); if (r.ms >= 50) totals[k].slow++; }
  console.log(`io during ${mark.name}:`, JSON.stringify(Object.fromEntries(Object.entries(totals).sort((a, b) => b[1].kB - a[1].kB).slice(0, 8))));
}
