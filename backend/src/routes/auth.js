import { Router } from 'express';
import { query } from '../db.js';
import { audit } from '../audit.js';
import { HttpError } from '../errors.js';
import { publicUser, requireUser, signToken, verifyPassword } from '../auth.js';

const r = Router();

// POST /api/auth/login {username, password} -> {token, user}
r.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) throw new HttpError(400, 'Enter a username and a password.');
  const { rows } = await query('SELECT * FROM app_user WHERE username = $1 AND active', [username]);
  const u = rows[0];
  if (!u || !verifyPassword(password, u.password_hash)) {
    await audit({ query }, null, 'Sign-in refused', { entity: 'user', entityId: username });
    throw new HttpError(401, 'Wrong username or password.');
  }
  await audit({ query }, { id: u.id, username: u.username }, 'Signed in', { entity: 'user', entityId: u.id });
  res.json({ token: signToken(u), user: publicUser(u) });
});

r.get('/me', requireUser, (req, res) => res.json(req.user));

r.post('/logout', requireUser, async (req, res) => {
  await audit({ query }, req.user, 'Signed out', { entity: 'user', entityId: req.user.id });
  res.json({ ok: true });
});

export default r;
