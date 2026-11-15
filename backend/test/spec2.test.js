// Specification 2 end to end: import the Spec 2 booking sheet, plan it with the ICS model's predictions, publish,
// and check the evidence the website shows. Runs after api.test.js on the same test database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost/orbit_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Tests only run on a database whose name contains "test"');
const ENGINE_PORT = 5083;
process.env.ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const SHEET = fs.readFileSync(path.join(here, '..', '..', 'database', 'data', 'booking_sheet_spec2.csv'), 'utf8');

let server, base, engine, token;
async function call(method, url, body) {
  const res = await fetch(base + url, { method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  const venv = path.join(here, '..', '..', 'engine', '.venv', 'bin', 'python');
  const py = process.env.ENGINE_PYTHON || (fs.existsSync(venv) ? venv : 'python3');
  engine = spawn(py, ['service.py'], { cwd: path.join(here, '..', '..', 'engine'), env: { ...process.env, ENGINE_PORT: String(ENGINE_PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${process.env.ENGINE_URL}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  await pool.query(`INSERT INTO app_user (username, display_name, role, password_hash) VALUES ('t.s2', 't.s2', 'coordinator', $1)
                    ON CONFLICT (username) DO NOTHING`, [hashPassword('test-pass-1')]);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/api/auth/login', { username: 't.s2', password: 'test-pass-1' })).body.token;
});
after(async () => { server?.close(); engine?.kill(); await pool.end(); });

test('Spec 2: the ICS model meets 85% within ±15% on its held-out test set', async () => {
  const m = (await call('GET', '/api/orbit/model')).body;
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.ok(m.test.within15 >= 85, `${m.test.within15}%`);
  assert.equal(m.met, true);
  assert.ok(m.test.byDepartment.length >= 5);
  console.log(`  held-out ${m.test.cases} cases: ${m.test.within15}% within ±15%, MAE ${m.test.maeMin} min`);
});

test('Spec 2: a sheet with only some clinical factor columns is refused', async () => {
  const lines = SHEET.trim().split('\n').map((l) => l.split(',').slice(0, 12).join(','));   // keeps complexity and asa_class only
  const r = await call('POST', '/api/sheets', { fileName: 'partial.csv', csv: lines.join('\n') });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /all be present/);
});

let sheet, plan;
test('Spec 2: importing the Spec 2 sheet stores the ICS predictions and the true durations', async () => {
  const r = await call('POST', '/api/sheets', { fileName: 'booking_sheet_spec2.csv', csv: SHEET });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  sheet = r.body;
  assert.equal(sheet.cases, 241);
  assert.equal(sheet.predicted, true);
  const { rows: [x] } = await pool.query(
    `SELECT count(*)::int AS n, count(predicted_duration_min)::int AS p FROM sheet_case WHERE sheet_id = $1`, [sheet.id]);
  assert.deepEqual(x, { n: 241, p: 241 });
});

test('Spec 2: planning with predicted durations keeps Specs 3 and 5 and Integrated Spec 1, without clashes', async () => {
  const r = await call('POST', '/api/plans', { sheetId: sheet.id, mode: 'predicted' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  plan = r.body;
  assert.equal(plan.mode, 'predicted');
  assert.deepEqual(plan.T.clash, [0, 0]);
  assert.ok(Math.max(...Object.values(plan.solveS)) < 300);
  assert.ok(plan.T.otPct >= 20, `overtime ${plan.T.otPct}%`);
  assert.ok(plan.T.dlPct >= 30, `start delay ${plan.T.dlPct}%`);
  console.log(`  predicted mode: overtime -${plan.T.otPct}%, start delay -${plan.T.dlPct}%`);
});

test('Spec 2: once published, the website shows the sheet\'s prediction accuracy, and emergencies re-plan on it', async () => {
  assert.equal((await call('POST', `/api/plans/${plan.id}/publish`)).status, 200);
  const D = (await call('GET', '/api/orbit/data')).body;
  assert.equal(D.meta.sheet.id, sheet.id);
  assert.equal(D.meta.plan.mode, 'predicted');
  assert.ok(D.meta.prediction.within15 >= 85, JSON.stringify(D.meta.prediction));
  const e = await call('POST', '/api/emergencies', { date: '2026-01-05', nowMin: 630, department: 'General surgery', surgeonId: 'SUR001', minutes: 90 });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.deepEqual(e.body.result.clashes, [0, 0]);
  assert.ok(e.body.engineMs < 300000);
});
