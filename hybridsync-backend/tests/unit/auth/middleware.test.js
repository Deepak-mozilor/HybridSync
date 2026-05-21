const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const JWT_SECRET = 'test-secret';

// Replicate the requireAuth middleware in isolation — no DB or Slack needed.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const app = express();
app.use(express.json());
app.get('/public',    (req, res) => res.json({ ok: true }));
app.get('/protected', requireAuth, (req, res) => res.json({ ok: true, role: req.auth.role }));

describe('requireAuth middleware', () => {
  it('allows unauthenticated access to public routes', async () => {
    const res = await request(app).get('/public');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects request with no Authorization header', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing token');
  });

  it('rejects request with a malformed token', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer not.a.valid.token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('rejects request with wrong secret', async () => {
    const token = jwt.sign({ role: 'admin' }, 'wrong-secret');
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('allows request with a valid admin token', async () => {
    const token = jwt.sign({ role: 'admin', name: 'Admin' }, JWT_SECRET);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('allows request with a valid manager token', async () => {
    const token = jwt.sign({ role: 'manager', teamId: 'team_alpha' }, JWT_SECRET);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('manager');
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: 1 });
    await new Promise(r => setTimeout(r, 1100));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });
});
