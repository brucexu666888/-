'use strict';
const crypto = require('node:crypto');
const { now } = require('./db');

const SESSION_DAYS = 30;
const COOKIE_NAME = 'sl_token';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

function readToken(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookies = req.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

// 解析当前用户，挂到 req.user 上；未登录则 req.user = null
function authenticate(db) {
  const stmt = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`);
  return (req, _res, next) => {
    req.token = readToken(req);
    const row = req.token ? stmt.get(req.token, now()) : null;
    req.user = row && row.active ? row : null;
    next();
  };
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  createSession,
  authenticate,
  requireLogin,
  requireAdmin,
};
