// End-to-end tests on a fresh test database (npm run test:db) and Salem's engine started here.
//   npm run test:db && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost/orbit_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Tests only run on a database whose name contains "test"');
const ENGINE_PORT = 5081;
process.env.ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const V2 = JSON.parse(fs.readFileSync(path.join(here, 'v2_page_data.json'), 'utf8'));
const SHEET = fs.readFileSync(path.join(here, '..', '..', 'database', 'data', 'booking_sheet_example.csv'), 'utf8');

let server, base, engine;
const tok = {};

async function call(method, url, { token, body, raw } = {}) {
  const res = await fetch(base + url, {
    method, headers: { ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
}

function core(D) { const { days, depts, rooms, sur, cases, K, T } = D; return { days, depts, rooms, sur, cases, K, T }; }

before(async () => {
  const py = process.env.ENGINE_PYTHON || (fs.existsSync(path.join(here, '..', '..', 'engine', '.venv', 'bin', 'python'))
    ? path.join(here, '..', '..', 'engine', '.venv', 'bin', 'python') : 'python3');
  engine = spawn(py, ['service.py'], { cwd: path.join(here, '..', '..', 'engine'), env: { ...process.env, ENGINE_PORT: String(ENGINE_PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${process.env.ENGINE_URL}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const [u, role, s] of [['t.coord', 'coordinator', null], ['t.viewer', 'viewer', null], ['t.staff', 'staff', 'SUR001']]) {
    await pool.query(`INSERT INTO app_user (username, display_name, role, surgeon_id, password_hash) VALUES ($1, $1, $2, $3, $4)
                      ON CONFLICT (username) DO NOTHING`, [u, role, s, hashPassword('test-pass-1')]);
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['t.coord', 't.viewer', 't.staff']) tok[u] = (await call('POST', '/api/auth/login', { body: { username: u, password: 'test-pass-1' } })).body.token;
});

after(async () => { server?.close(); engine?.kill(); await pool.end(); });

test('health: database with V2 data, website served', async () => {
  const h = await call('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.cases, 241);
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /ORbit/);
});

test('same data as V2: the page data built from the database equals V2 page data exactly', async () => {
  const pub = await call('GET', '/api/orbit/data');
  assert.equal(pub.status, 200);
  assert.deepEqual(core(pub.body), core(V2));
  const signed = await call('GET', '/api/orbit/data', { token: tok['t.coord'] });
  assert.deepEqual(core(signed.body), core(V2));
  assert.equal(signed.body.meta.plan.kind, 'v2_baseline');
});

test('sign-in and roles', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 't.coord', password: 'wrong' } })).status, 401);
  assert.equal((await call('GET', '/api/sheets')).status, 401);
  assert.equal((await call('POST', '/api/plans', { token: tok['t.viewer'], body: {} })).status, 403);
  assert.equal((await call('POST', '/api/emergencies', { token: tok['t.viewer'], body: {} })).status, 403);
  const me = await call('GET', '/api/auth/me', { token: tok['t.coord'] });
  assert.deepEqual(me.body.permissions, ['view', 'emergency', 'publish', 'plan', 'import']);
});

test('C1: patient-identifiable data is refused by the import and by the schema', async () => {
  const before = (await pool.query('SELECT count(*)::int n FROM sheet')).rows[0].n;
  const bad = SHEET.split('\n').map((l, i) => (l ? `${l},${i ? 'Ahmed' : 'patient_name'}` : l)).join('\n');
  const r = await call('POST', '/api/sheets', { token: tok['t.coord'], body: { fileName: 'bad.csv', csv: bad } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Constraint 1/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM sheet')).rows[0].n, before);
  await assert.rejects(pool.query('ALTER TABLE sheet_case ADD COLUMN national_id text'), /Constraint 1/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM v_spec_c1')).rows[0].n, 0);
});

test('C3: the database refuses a room or surgeon in two places at once', async () => {
  await assert.rejects(pool.query(`UPDATE plan_item SET planned_start_min = 480 WHERE version_id = 1 AND case_id = 'C00029'`), (e) => e.code === '23P01');
  // a surgeon in two rooms at the same time
  await assert.rejects(pool.query(`UPDATE plan_item SET surgeon_id = 'SUR012', planned_start_min = 480 WHERE version_id = 1 AND case_id = 'C00021'`),
    (e) => e.code === '23P01');
});

test('C4 and audit: overtime rate and the log are append-only', async () => {
  await assert.rejects(pool.query('UPDATE rate_policy SET sar_per_minute = 1'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
  const { rows } = await pool.query('SELECT sar_per_minute, multiplier FROM rate_policy');
  assert.deepEqual(rows[0], { sar_per_minute: 19.3, multiplier: 1.5 });
});

let emergency;
test('S3: an emergency is re-planned by Salem\'s engine on the server, timed, without clashes', async () => {
  const r = await call('POST', '/api/emergencies', { token: tok['t.coord'],
    body: { date: '2026-01-05', nowMin: 630, department: 'General surgery', surgeonId: 'SUR001', minutes: 90 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  emergency = r.body;
  assert.ok(r.body.engineMs > 0 && r.body.engineMs <= 300000, `engine ${r.body.engineMs} ms`);
  assert.deepEqual(r.body.result.clashes, [0, 0]);
  assert.ok(r.body.result.atMin >= 630);
  const isNew = r.body.items.find((i) => i.isNew);
  assert.equal(isNew.caseId, 'E00001');
  assert.equal(r.body.items.filter((i) => i.caseId.startsWith('C')).length, 23);     // every case of that day is still planned or deferred
  // not public until published
  const D = (await call('GET', '/api/orbit/data', { token: tok['t.coord'] })).body;
  assert.equal(D.cases.some((c) => c.i === 'E00001'), false);
});

test('IS2: publish, then the first OR staff view stops the end-to-end clock', async () => {
  const p = await call('POST', `/api/emergencies/${emergency.id}/publish`, { token: tok['t.coord'] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const D = (await call('GET', '/api/orbit/data', { token: tok['t.coord'] })).body;
  const e = D.cases.find((c) => c.i === 'E00001');
  assert.ok(e && e.x === 1 && e.st === 1 && e.d === 1);
  assert.deepEqual(D.T.clash, [0, 0]);
  assert.equal(D.meta.repairs['2026-01-05'].status, 'published');
  const s = await call('GET', '/api/staff/schedule?date=2026-01-05', { token: tok['t.staff'] });
  assert.equal(s.status, 200);
  assert.equal(s.body.surgeon, 'SUR001');
  assert.ok(s.body.items.some((i) => i.caseId === 'E00001'));
  assert.equal(s.body.seen.length, 1);
  assert.ok(s.body.seen[0].endToEndMs > 0 && s.body.seen[0].endToEndMs <= 600000);
  const again = await call('GET', '/api/staff/schedule?date=2026-01-05', { token: tok['t.staff'] });
  assert.equal(again.body.seen.length, 0);                                           // first view only
  const list = (await call('GET', '/api/emergencies?date=2026-01-05', { token: tok['t.coord'] })).body;
  assert.ok(list[0].endToEndMs >= list[0].engineMs);
  const D2 = (await call('GET', '/api/orbit/data', { token: tok['t.coord'] })).body;
  assert.equal(D2.ev.seen, 1);
});

test('a second emergency on the same day re-plans on top of the first, still without clashes', async () => {
  const r = await call('POST', '/api/emergencies', { token: tok['t.coord'],
    body: { date: '2026-01-05', nowMin: 630, department: 'General surgery', surgeonId: 'SUR001', minutes: 120 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.caseId, 'E00002');
  assert.deepEqual(r.body.result.clashes, [0, 0]);
  const first = r.body.items.find((i) => i.caseId === 'E00001');
  assert.ok(first && first.status === 'emergency' && !first.moved);                   // the first emergency stays where it was
  assert.equal((await call('POST', `/api/emergencies/${r.body.id}/publish`, { token: tok['t.coord'] })).status, 200);
  const D = (await call('GET', '/api/orbit/data', { token: tok['t.coord'] })).body;
  assert.deepEqual(D.T.clash, [0, 0]);
  assert.equal(D.cases.filter((c) => c.x === 1).length, 2);
});

test('V2 mode re-run: no clashes and V2\'s specifications still met', async () => {
  const r = await call('POST', '/api/plans', { token: tok['t.coord'], body: { sheetId: 1, mode: 'v2' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const D = (await call('GET', `/api/orbit/data?version=${r.body.id}`, { token: tok['t.coord'] })).body;
  const T = D.T;
  assert.deepEqual(T.clash, [0, 0]);                                                 // 1. no room or surgeon clashes
  const { rows: items } = await pool.query('SELECT case_id, status FROM plan_item WHERE version_id = $1', [r.body.id]);
  const sheetIds = V2.cases.map((c) => c.i).sort();
  assert.deepEqual(items.map((i) => i.case_id).sort(), sheetIds);                    // 2. every case exactly once ...
  assert.ok(items.every((i) => ['scheduled', 'emergency', 'deferred'].includes(i.status)));   // ... scheduled, emergency or deferred
  const slowest = Math.max(...Object.values(r.body.solveS));
  assert.ok(slowest < 300, `slowest day ${slowest} s`);                             // 3. Spec 3
  assert.ok(T.otPct >= 20, `overtime cost ${T.cost[0]} -> ${T.cost[1]} SAR (${T.otPct}%)`);      // 4. Spec 5
  assert.ok(T.dlPct >= 30, `start delay ${T.dl[0]} -> ${T.dl[1]} min (${T.dlPct}%)`);           // 5. Integrated Spec 1
  const electives = D.cases.filter((c) => !c.x && !c.em);
  const deferred = (100 * electives.filter((c) => c.st === 2).length) / electives.length;
  assert.ok(deferred <= 5, `deferred electives ${deferred.toFixed(1)}%`);            // 6. deferred electives <= 5%
  // Information only: HiGHS may stop at a different plan within mip_rel_gap 0.01 on another platform, so a field-for-field match with V2 is not asserted.
  const mine = D.cases.filter((c) => !c.x);
  const same = mine.filter((c, k) => { try { assert.deepEqual(c, V2.cases[k]); return true; } catch { return false; } }).length;
  console.log(`  V2 mode re-run: overtime cost/day ${T.cost[0]} -> ${T.cost[1]} SAR (${T.otPct}%), start delay ${T.dl[0]} -> ${T.dl[1]} min (${T.dlPct}%), ` +
    `deferred electives ${deferred.toFixed(1)}%, slowest day ${slowest} s; ${same}/${mine.length} cases identical to V2 (info)`);
  await call('POST', `/api/plans/${r.body.id}/reject`, { token: tok['t.coord'] });
});

test('import a booking sheet, plan it from booked durations, publish: it becomes the active sheet', async () => {
  const lines = SHEET.trim().split('\n');
  const three = [lines[0], ...lines.slice(1).filter((l) => ['2026-01-04', '2026-01-05', '2026-01-06'].includes(l.split(',')[1]))].join('\n');
  const imp = await call('POST', '/api/sheets', { token: tok['t.coord'], body: { fileName: 'three_days.csv', csv: three } });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(imp.body.days, 3);
  const plan = await call('POST', '/api/plans', { token: tok['t.coord'], body: { sheetId: imp.body.id, mode: 'booked' } });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.T.clash, [0, 0]);
  assert.equal((await call('POST', `/api/plans/${plan.body.id}/publish`, { token: tok['t.viewer'] })).status, 403);
  assert.equal((await call('POST', `/api/plans/${plan.body.id}/publish`, { token: tok['t.coord'] })).status, 200);
  const D = (await call('GET', '/api/orbit/data', { token: tok['t.coord'] })).body;
  assert.equal(D.meta.sheet.id, imp.body.id);
  assert.equal(D.days.length, 3);
  assert.equal(D.meta.plan.mode, 'booked');
  const pub = (await call('GET', '/api/orbit/data')).body;
  assert.deepEqual(core(pub), { ...core(V2), cases: pub.cases, K: pub.K, T: pub.T });   // public page still shows the V2 sheet
  assert.equal(pub.meta.sheet.id, 1);
  const bad = await call('POST', '/api/sheets', { token: tok['t.coord'], body: { fileName: 'x.csv', csv: 'case_id,surgery_date\nC1,2026-01-01' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /missing columns/);
});

test('audit log: server actions with user and time, browser events allow-listed', async () => {
  assert.equal((await call('POST', '/api/audit/events', { token: tok['t.viewer'], body: { action: 'Report copied as CSV' } })).status, 201);
  assert.equal((await call('POST', '/api/audit/events', { token: tok['t.viewer'], body: { action: 'Deleted everything' } })).status, 400);
  const log = (await call('GET', '/api/audit', { token: tok['t.viewer'] })).body;
  const actions = log.map((a) => a.action);
  for (const a of ['Data loaded', 'Signed in', 'Emergency registered and re-planned', 'Emergency re-plan published',
    'Published re-plan first seen by OR staff', 'Booking sheet imported', 'Optimizer run', 'Plan published', 'Report copied as CSV']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  assert.ok(log.every((a) => a.at && a.username));
});

test('errors are JSON; unknown endpoints 404; bad JSON 400; engine down 503', async () => {
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  assert.equal((await call('POST', '/api/auth/login', { raw: '{bad' })).status, 400);
  const keep = process.env.ENGINE_URL;
  process.env.ENGINE_URL = 'http://127.0.0.1:5099';
  try {
    const r = await call('POST', '/api/plans', { token: tok['t.coord'], body: { sheetId: 1 } });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /npm run engine/);
  } finally { process.env.ENGINE_URL = keep; }
});
