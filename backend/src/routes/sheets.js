// Booking sheets: the CSV the OR coordinator already keeps (V2 template).
//   POST /api/sheets {name?, fileName, csv}  validate -> simulate (V2 Step 1) -> store (not active yet)
//   GET  /api/sheets                         list
import { Router } from 'express';
import { query, tx } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { requirePermission } from '../auth.js';
import { callEngine } from '../engine.js';

const r = Router();
export const REQUIRED = ['case_id', 'surgery_date', 'department', 'surgeon_id', 'room', 'booked_start', 'booked_duration_min'];
const OPTIONAL = ['is_emergency', 'booking_date', 'skill_required'];
// Specification 2 (optional, all five or none): non-identifying clinical factors, plus the simulation's true duration
export const FACTORS = { complexity: ['simple', 'standard', 'complex'], asa_class: ['1', '2', '3', '4'], bmi_band: ['<25', '25-30', '30-35', '>=35'],
  age_band: ['<40', '40-64', '>=65'], anaesthesia: ['general', 'regional', 'local'] };
const SPEC2 = [...Object.keys(FACTORS), 'sim_true_duration_min'];
// Constraint 1: a sheet carrying anything that could identify a patient is refused as a whole
const IDENTIFIER = /(patient|first_?name|last_?name|full_?name|^name$|mrn|medical_record|national_?id|iqama|passport|birth|dob|phone|mobile|email|address)/i;
const MAX_ROWS = 5000;

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

export function validateSheet(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'The file has no cases.');
  const head = rows[0].map((h) => h.toLowerCase());
  const pii = head.filter((h) => IDENTIFIER.test(h));
  if (pii.length) throw new HttpError(400, `Constraint 1: this file has columns that could identify a patient (${pii.join(', ')}). Remove them and load the file again. Nothing was stored.`, { columns: pii });
  const missing = REQUIRED.filter((c) => !head.includes(c));
  if (missing.length) throw new HttpError(400, `This file is missing columns: ${missing.join(', ')}.`, { missing });
  if (rows.length - 1 > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} cases per file.`);
  const ix = Object.fromEntries([...REQUIRED, ...OPTIONAL, ...SPEC2].map((c) => [c, head.indexOf(c)]));
  const hasF = Object.keys(FACTORS).filter((c) => ix[c] >= 0);
  if (hasF.length && hasF.length < 5) throw new HttpError(400, `Clinical factor columns must all be present or all absent; missing: ${Object.keys(FACTORS).filter((c) => ix[c] < 0).join(', ')}.`);
  const out = [], errors = [], seen = new Set();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const get = (c) => (ix[c] >= 0 ? r[ix[c]] ?? '' : '');
    const bad = (m) => errors.length < 20 && errors.push(`line ${line}: ${m}`);
    const rec = {
      case_id: get('case_id'), surgery_date: get('surgery_date'), department: get('department'), surgeon_id: get('surgeon_id'),
      room: get('room'), booked_start: get('booked_start').slice(0, 5), booked_duration_min: Number(get('booked_duration_min')),
      is_emergency: get('is_emergency') === '' ? 0 : Number(get('is_emergency')),
      booking_date: get('booking_date') || get('surgery_date'), skill_required: get('skill_required') || 'standard',
    };
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(rec.case_id)) bad('case_id must be letters, digits, - or _ (at most 20)');
    else if (seen.has(rec.case_id)) bad(`case_id ${rec.case_id} appears twice`);
    seen.add(rec.case_id);
    if (!isDate(rec.surgery_date)) bad('surgery_date must be YYYY-MM-DD');
    if (!isDate(rec.booking_date)) bad('booking_date must be YYYY-MM-DD');
    else if (rec.booking_date > rec.surgery_date) bad('booking_date is after surgery_date');
    if (!rec.department || rec.department.length > 60) bad('department is empty or too long');
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(rec.surgeon_id)) bad('surgeon_id must be a staff code such as SUR004');
    if (!/^[A-Za-z0-9 _-]{1,20}$/.test(rec.room)) bad('room must be a room code such as OR1');
    const t = /^(\d{1,2}):(\d{2})$/.exec(rec.booked_start);
    if (!t || +t[1] > 23 || +t[2] > 59) bad('booked_start must be HH:MM');
    if (!Number.isInteger(rec.booked_duration_min) || rec.booked_duration_min < 5 || rec.booked_duration_min > 1440) bad('booked_duration_min must be a whole number of minutes (5 to 1440)');
    if (![0, 1].includes(rec.is_emergency)) bad('is_emergency must be 0 or 1');
    if (!['standard', 'advanced'].includes(rec.skill_required)) bad('skill_required must be standard or advanced');
    if (hasF.length) for (const [c, ok] of Object.entries(FACTORS)) { rec[c] = get(c); if (!ok.includes(rec[c])) bad(`${c} must be one of ${ok.join(', ')}`); }
    if (ix.sim_true_duration_min >= 0 && get('sim_true_duration_min') !== '') {
      rec.sim_true_duration_min = Number(get('sim_true_duration_min'));
      if (!Number.isInteger(rec.sim_true_duration_min) || rec.sim_true_duration_min < 5 || rec.sim_true_duration_min > 1440) bad('sim_true_duration_min must be whole minutes (5 to 1440)');
    }
    out.push(rec);
  });
  if (errors.length) throw new HttpError(400, `The file has ${errors.length >= 20 ? '20 or more' : errors.length} problem${errors.length > 1 ? 's' : ''}. First: ${errors[0]}`, { errors });
  return out;
}

r.get('/', requirePermission('view'), async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.source_file AS "sourceFile", s.imported_at AS "importedAt", s.is_active AS "active",
            u.username AS "importedBy",
            (SELECT count(*) FROM sheet_case c WHERE c.sheet_id = s.id AND NOT c.added_by_emergency)::int AS cases,
            (SELECT count(DISTINCT surgery_date) FROM sheet_case c WHERE c.sheet_id = s.id)::int AS days,
            (SELECT json_agg(json_build_object('id', v.id, 'kind', v.kind, 'mode', v.mode, 'status', v.status) ORDER BY v.id)
               FROM plan_version v WHERE v.sheet_id = s.id AND v.kind <> 'repair') AS plans
       FROM sheet s LEFT JOIN app_user u ON u.id = s.imported_by ORDER BY s.id DESC`);
  res.json(rows);
});

r.post('/', requirePermission('import'), async (req, res) => {
  const csv = req.body?.csv;
  const fileName = String(req.body?.fileName || 'booking sheet').slice(0, 120);
  if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(400, 'Send the CSV text in "csv".');
  const rows = validateSheet(csv);
  const startedAt = new Date();
  const sim = await callEngine('/simulate', { rows });
  const out = await tx(async (c) => {
    const depts = [...new Set(sim.rows.map((x) => x.department))];
    await c.query('INSERT INTO department (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING', [depts]);
    const rooms = [...new Set(sim.rows.map((x) => x.room))];
    await c.query('INSERT INTO room (id) SELECT unnest($1::text[]) ON CONFLICT (id) DO NOTHING', [rooms]);
    const name = String(req.body?.name || fileName).slice(0, 120);
    const { rows: [sheet] } = await c.query(
      'INSERT INTO sheet (name, source_file, imported_by) VALUES ($1, $2, $3) RETURNING *', [name, fileName, req.user.id]);
    await c.query(
      `INSERT INTO sheet_surgeon (sheet_id, surgeon_id, department_id, shift, skill)
       SELECT $1, x.s, d.id, x.sh, x.sk FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS x(s, dp, sh, sk)
         JOIN department d ON d.name = x.dp`,
      [sheet.id, sim.roster.map((x) => x.surgeon_id), sim.roster.map((x) => x.department), sim.roster.map((x) => x.shift), sim.roster.map((x) => x.skill)]);
    const col = (k) => sim.rows.map((x) => x[k]);
    await c.query(
      `INSERT INTO sheet_case (sheet_id, case_id, row_no, surgery_date, department_id, surgeon_id, room_id, booked_start_min,
                               booked_duration_min, is_emergency, booking_date, skill_required, actual_duration_min, turnover_min,
                               waiting_days, manual_actual_start_min, complexity, asa_class, bmi_band, age_band, anaesthesia,
                               predicted_duration_min)
       SELECT $1, x.id, x.n, x.d, dp.id, x.s, x.r, x.bs, x.bd, x.em = 1, x.bk, x.sk, x.ad, x.t, x.w, x.mas, x.cx, x.asa, x.bmi, x.age, x.an, x.pd
         FROM unnest($2::text[], $3::int[], $4::date[], $5::text[], $6::text[], $7::text[], $8::int[], $9::int[], $10::int[],
                     $11::date[], $12::text[], $13::int[], $14::int[], $15::int[], $16::int[],
                     $17::text[], $18::text[], $19::text[], $20::text[], $21::text[], $22::int[])
              AS x(id, n, d, dep, s, r, bs, bd, em, bk, sk, ad, t, w, mas, cx, asa, bmi, age, an, pd)
         JOIN department dp ON dp.name = x.dep`,
      [sheet.id, col('case_id'), sim.rows.map((_, k) => k + 1), col('surgery_date'), col('department'), col('surgeon_id'), col('room'),
        col('booked_start_min'), col('booked_duration_min'), col('is_emergency'), col('booking_date'), col('skill_required'),
        col('actual_duration_min'), col('turnover_min'), col('waiting_days'), sim.rows.map((x) => Math.round(x.actual_start_min)),
        ...['complexity', 'asa_class', 'bmi_band', 'age_band', 'anaesthesia', 'predicted_duration_min'].map((k) => sim.rows.map((x) => (x[k] == null ? null : x[k])))]);
    await c.query(
      `INSERT INTO engine_run (kind, sheet_id, started_at, finished_at, status, result, created_by)
       VALUES ('simulate', $1, $2, clock_timestamp(), 'succeeded', $3, $4)`,
      [sheet.id, startedAt, JSON.stringify({ cases: rows.length, seed: 1 }), req.user.id]);
    const days = new Set(rows.map((x) => x.surgery_date)).size;
    await audit(c, req.user, 'Booking sheet imported', { entity: 'sheet', entityId: sheet.id,
      detail: `${fileName}: ${rows.length} cases, ${days} days, ${rooms.length} rooms, ${sim.roster.length} surgeons` });
    const predicted = sim.rows.every((x) => x.predicted_duration_min != null);
    return { id: sheet.id, name, cases: rows.length, days, rooms: rooms.length, surgeons: sim.roster.length, predicted };
  });
  res.status(201).json(out);
});

export default r;
