// Builds the data object the ORbit page runs on ("D"), from the database.
// Field names, rounding and every formula follow V2 (sorrs_tool_v2.py: day_summary, compare,
// overlaps, Step 4), so on V2's data this returns exactly the object embedded in V2's page.
import { query } from './db.js';

const CAP = 600;                 // room day, minutes
const RATE = 19.3;               // SAR per overtime minute (C4)

// Python's round(): half to even, so totals match V2 to the last digit
export function pyRound(x, nd = 0) {
  const m = 10 ** nd;
  const y = x * m;
  const f = Math.floor(y);
  const diff = y - f;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = f % 2 === 0 ? f : f + 1;
  else r = Math.round(y);
  return nd ? r / m : r;
}
const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// V2 overlaps(): pairs on the same day sharing a room (operation + turnover) or a surgeon (operation)
export function overlaps(items) {
  const count = (key, end) => {
    const g = new Map();
    for (const it of items) {
      const k = `${it.date}|${it[key]}`;
      (g.get(k) || g.set(k, []).get(k)).push(it);
    }
    let n = 0;
    for (const v of g.values()) {
      v.sort((a, b) => a.start - b.start);
      for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (v[j].start < end(v[i])) n += 1;
    }
    return n;
  };
  return [count('room', (x) => x.start + x.dur + x.to), count('surgeon', (x) => x.start + x.dur)];
}

// one day of a schedule, scored on the simulated real durations (V2 day_summary)
function daySummary(rows) {
  const busy = new Map();
  for (const r of rows) busy.set(r.room, (busy.get(r.room) || 0) + r.ad + r.to);
  let total = 0, over = 0;
  for (const b of busy.values()) { total += b; over += Math.max(0, b - CAP); }
  return { rh: total / 60, ot: over / 60, cost: over * RATE, dl: mean(rows.map((r) => r.as - r.ps)), n: rows.length };
}

export async function activeSheetId(db = { query }) {
  const { rows } = await db.query('SELECT id FROM sheet WHERE is_active ORDER BY id DESC LIMIT 1');
  return rows[0]?.id ?? null;
}

// The plan shown for each day: the published repair of that day, else the published sheet plan.
// `overrideVersion` shows a proposed plan instead (for review before publishing).
export async function buildD(sheetId, { overrideVersion = null, db = { query } } = {}) {
  const { rows: sheetRows } = await db.query('SELECT * FROM sheet WHERE id = $1', [sheetId]);
  if (!sheetRows[0]) return null;
  const { rows: cases } = await db.query(
    `SELECT c.*, d.name AS department FROM sheet_case c JOIN department d ON d.id = c.department_id
      WHERE c.sheet_id = $1 ORDER BY c.row_no`, [sheetId]);
  const { rows: roster } = await db.query(
    `SELECT s.surgeon_id, s.shift, s.skill, d.name AS department FROM sheet_surgeon s JOIN department d ON d.id = s.department_id
      WHERE s.sheet_id = $1`, [sheetId]);
  const sheetCases = cases.filter((c) => !c.added_by_emergency);
  // Specification 2 on this sheet: ICS predictions against the simulated true durations (null for sheets without factors)
  const withPred = sheetCases.filter((c) => c.predicted_duration_min != null);
  const prediction = withPred.length === sheetCases.length && withPred.length ? {
    cases: withPred.length,
    within15: pyRound((100 * withPred.filter((c) => Math.abs(c.predicted_duration_min / c.actual_duration_min - 1) <= 0.15).length) / withPred.length, 1),
    maeMin: pyRound(withPred.reduce((a, c) => a + Math.abs(c.predicted_duration_min - c.actual_duration_min), 0) / withPred.length, 1),
  } : null;
  const days = [...new Set(sheetCases.map((c) => c.surgery_date))].sort(cmp);
  const depts = [...new Set(cases.map((c) => c.department))].sort(cmp);
  const rooms = [...new Set(sheetCases.map((c) => c.room_id))].sort(cmp);
  const sur = roster.sort((a, b) => cmp(a.surgeon_id, b.surgeon_id))
    .map((s) => ({ id: s.surgeon_id, dp: depts.indexOf(s.department), sh: s.shift }));
  const shift = new Map(roster.map((s) => [s.surgeon_id, s.shift]));

  // versions per day
  let base = null;
  if (overrideVersion) {
    const { rows } = await db.query('SELECT * FROM plan_version WHERE id = $1 AND sheet_id = $2', [overrideVersion, sheetId]);
    base = rows[0] || null;
  } else {
    const { rows } = await db.query(`SELECT * FROM plan_version WHERE sheet_id = $1 AND kind <> 'repair' AND status = 'published'`, [sheetId]);
    base = rows[0] || null;
  }
  const repairs = new Map();
  if (!overrideVersion || base?.kind === 'repair') {
    const { rows } = await db.query(`SELECT * FROM plan_version WHERE sheet_id = $1 AND kind = 'repair' AND status = 'published'`, [sheetId]);
    for (const r of rows) repairs.set(r.surgery_date, r);
  }
  if (base?.kind === 'repair') {
    repairs.set(base.surgery_date, base);
    const { rows } = await db.query(`SELECT * FROM plan_version WHERE sheet_id = $1 AND kind <> 'repair' AND status = 'published'`, [sheetId]);
    base = rows[0] || null;
  }
  const verFor = (d) => repairs.get(d) || base;
  const vids = [...new Set(days.map(verFor).filter(Boolean).map((v) => v.id))];
  const { rows: items } = vids.length
    ? await db.query('SELECT * FROM plan_item WHERE version_id = ANY($1::int[])', [vids])
    : { rows: [] };
  const itemOf = new Map(items.map((i) => [`${i.version_id}|${i.case_id}`, i]));

  const out = [];
  for (const c of cases) {
    const d = days.indexOf(c.surgery_date);
    if (d < 0) continue;
    const v = verFor(c.surgery_date);
    const it = v ? itemOf.get(`${v.id}|${c.case_id}`) : null;
    if (c.added_by_emergency && !it) continue;            // an emergency only appears where it is in the plan
    const st = !it ? 2 : it.status === 'deferred' ? 2 : it.status === 'emergency' ? 1 : 0;
    const o = {
      i: c.case_id, d, dp: depts.indexOf(c.department), em: c.is_emergency ? 1 : 0,
      bs: c.booked_start_min, bd: c.booked_duration_min, ad: c.actual_duration_min, to: c.turnover_min, wd: c.waiting_days,
      mr: c.added_by_emergency ? null : rooms.indexOf(c.room_id), ms: c.surgeon_id, mas: c.manual_actual_start_min,
      st,
    };
    if (st !== 2) {                                         // V2 leaves these out for a deferred case
      Object.assign(o, { orr: rooms.indexOf(it.room_id), os: it.surgeon_id, ops: it.planned_start_min,
        opd: it.planned_duration_min, oas: it.actual_start_min });
    }
    if (c.added_by_emergency) o.x = 1;
    out.push(o);
  }

  // ---- per-day figures (K) and totals (T), as V2
  const K = [], mDays = [], oDays = [], gapM = [], gapO = [];
  const gap = (rows, who) => {
    let a = 0, b = 0;
    for (const r of rows) (shift.get(r[who]) === 'B' ? (b += r.ad) : (a += r.ad));
    return a + b ? Math.abs(a - b) / (a + b) : 0;
  };
  for (let d = 0; d < days.length; d++) {
    const cs = out.filter((c) => c.d === d);
    const man = cs.filter((c) => !c.x).map((c) => ({ room: c.mr, ad: c.ad, to: c.to, as: c.mas, ps: c.bs, ms: c.ms }));
    const orb = cs.filter((c) => c.st !== 2).map((c) => ({ room: c.orr, ad: c.ad, to: c.to, as: c.oas, ps: c.ops, os: c.os }));
    const m = daySummary(man), o = daySummary(orb);
    mDays.push(m); oDays.push(o);
    gapM.push(gap(man, 'ms')); gapO.push(gap(orb, 'os'));
    const v = verFor(days[d]);
    const sv = v?.solve_s?.[days[d]];
    const fig = (x) => ({ rh: pyRound(x.rh, 1), ot: pyRound(x.ot, 1), cost: pyRound(x.cost), dl: pyRound(x.dl), n: x.n });
    K.push({ m: fig(m), o: fig(o), df: cs.filter((c) => c.st === 2).length, sv: sv == null ? null : pyRound(Number(sv), 1) });
  }
  const avg = (arr, k) => mean(arr.map((x) => x[k]));
  const M = { rh: avg(mDays, 'rh'), ot: avg(mDays, 'ot'), cost: avg(mDays, 'cost'), dl: avg(mDays, 'dl'), n: avg(mDays, 'n') };
  const O = { rh: avg(oDays, 'rh'), ot: avg(oDays, 'ot'), cost: avg(oDays, 'cost'), dl: avg(oDays, 'dl'), n: avg(oDays, 'n') };
  const planned = out.filter((c) => c.st !== 2).map((c) => ({ date: c.d, room: c.orr, surgeon: c.os, start: c.ops, dur: c.opd, to: c.to, em: c.em }));
  const manualPlan = out.filter((c) => !c.x).map((c) => ({ date: c.d, room: c.mr, surgeon: c.ms, start: c.bs, dur: c.bd, to: c.to }));
  const load = (rows, key, val) => {
    const g = new Map();
    for (const r of rows) { const k = `${r.date}|${r[key]}`; g.set(k, (g.get(k) || 0) + val(r)); }
    return g.size ? Math.max(...g.values()) : 0;
  };
  const sv = K.map((k) => k.sv).filter((x) => x != null);
  const sheetOnly = out.filter((c) => !c.x);
  const pct = (a, b) => (a ? (100 * (a - b)) / a : 0);
  const T = {
    rh: [pyRound(M.rh, 1), pyRound(O.rh, 1)], ot: [pyRound(M.ot, 1), pyRound(O.ot, 1)],
    cost: [pyRound(M.cost), pyRound(O.cost)], dl: [pyRound(M.dl, 1), pyRound(O.dl, 1)], n: [pyRound(M.n, 1), pyRound(O.n, 1)],
    gap: [pyRound(100 * mean(gapM)), pyRound(100 * mean(gapO))],
    defer: pyRound((100 * out.filter((c) => c.st === 2).length) / (out.length || 1), 1),
    solve: sv.length ? Math.max(...sv) : null,
    clash: overlaps(planned), clashM: overlaps(manualPlan),
    cases: sheetOnly.length,
    em: pyRound(sheetOnly.filter((c) => c.em).length / (days.length || 1), 1),
    within30: pyRound((100 * sheetOnly.filter((c) => Math.abs(c.ad - c.bd) <= 0.3 * c.bd).length) / (sheetOnly.length || 1)),
    maxRoom: load(planned.filter((p) => !p.em), 'room', (r) => r.dur + r.to),
    maxSurg: load(planned, 'surgeon', (r) => r.dur),
    otPct: pyRound(pct(M.cost, O.cost)), dlPct: pyRound(pct(M.dl, O.dl)), rhPct: pyRound(pct(M.rh, O.rh)),
  };

  // ---- evidence from the server (S3, IS2) and what is shown
  const { rows: ev } = await db.query(
    `SELECT count(*)::int AS n, avg(engine_ms) AS mean_ms, max(engine_ms) AS max_ms,
            count(published_at)::int AS published, count(first_seen_at)::int AS seen, max(end_to_end_ms) AS e2e_max_ms
       FROM emergency_event WHERE sheet_id = $1 AND engine_finished_at IS NOT NULL`, [sheetId]);
  const e = ev[0];
  return {
    days, depts, rooms, sur, cases: out, K, T,
    ev: { emergencies: e.n, engineMsMean: e.mean_ms == null ? null : pyRound(e.mean_ms, 1), engineMsMax: e.max_ms == null ? null : pyRound(e.max_ms, 1),
      published: e.published, seen: e.seen, endToEndMsMax: e.e2e_max_ms == null ? null : Math.round(e.e2e_max_ms) },
    meta: {
      sheet: { id: sheetRows[0].id, name: sheetRows[0].name, source: sheetRows[0].source_file, active: sheetRows[0].is_active },
      plan: base ? { id: base.id, kind: base.kind, mode: base.mode, status: base.status } : null,
      prediction,
      repairs: Object.fromEntries([...repairs.entries()].map(([d, r]) => [d, { id: r.id, status: r.status }])),
    },
  };
}
