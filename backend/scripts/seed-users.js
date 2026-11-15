// Demo accounts (development only — change the passwords before anyone else can reach the server).
import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const USERS = [
  ['coordinator', 'OR Coordinator', 'coordinator', null, 'coordinator123'],
  ['admin', 'Administrator', 'admin', null, 'admin123'],
  ['viewer', 'Viewer', 'viewer', null, 'viewer123'],
  ['staff.sur001', 'SUR001 (surgeon)', 'staff', 'SUR001', 'staff123'],
  ['staff.sur004', 'SUR004 (surgeon)', 'staff', 'SUR004', 'staff123'],
];

for (const [username, name, role, surgeon, pw] of USERS) {
  await pool.query(
    `INSERT INTO app_user (username, display_name, role, surgeon_id, password_hash) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
       surgeon_id = EXCLUDED.surgeon_id, password_hash = EXCLUDED.password_hash, active = true`,
    [username, name, role, surgeon, hashPassword(pw)]);
  console.log(`${username.padEnd(14)} ${pw.padEnd(16)} ${role}${surgeon ? ` (${surgeon})` : ''}`);
}
await pool.end();
