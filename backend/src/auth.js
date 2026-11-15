// Accounts: scrypt password hashes, signed tokens (HS256), role permissions.
import crypto from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './errors.js';

export const PERMISSIONS = {
  coordinator: ['view', 'emergency', 'publish', 'plan', 'import'],
  admin: ['view', 'emergency', 'publish', 'plan', 'import', 'users'],
  viewer: ['view'],
  staff: ['view', 'own_schedule'],
};
export const ROLE_LABEL = { coordinator: 'OR coordinator', admin: 'Administrator', viewer: 'Viewer', staff: 'OR staff' };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16 || s.startsWith('change-me')) throw new Error('Set JWT_SECRET in backend/.env to a long random string');
  return s;
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signToken(user) {
  const hours = Number(process.env.TOKEN_HOURS || 12);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + hours * 3600 })}`;
  return `${body}.${crypto.createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

function readToken(token) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;
  const want = crypto.createHmac('sha256', secret()).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  return claims.exp > Date.now() / 1000 ? claims : null;
}

export function publicUser(u) {
  return { id: u.id, username: u.username, name: u.display_name, role: u.role, roleLabel: ROLE_LABEL[u.role],
    surgeonId: u.surgeon_id, permissions: PERMISSIONS[u.role] };
}

// Sets req.user when a valid token is sent; never refuses on its own.
export async function identify(req, _res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const claims = m && readToken(m[1]);
  if (claims) {
    const { rows } = await query('SELECT * FROM app_user WHERE id = $1 AND active', [claims.sub]);
    if (rows[0]) req.user = publicUser(rows[0]);
  }
  next();
}

export const requireUser = (req, _res, next) => next(req.user ? undefined : new HttpError(401, 'Sign in first.'));

export const requirePermission = (perm) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Sign in first.'));
  if (!req.user.permissions.includes(perm)) return next(new HttpError(403, `Your role (${req.user.roleLabel}) cannot do this.`));
  next();
};
