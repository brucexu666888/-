// 重置账号密码（忘记管理员密码时在服务器上使用）
// 用法：node scripts/reset-password.js <账号> <新密码>
// 服务器上：cd /opt/sales-library && sudo -u saleslib env DATA_DIR=/var/lib/sales-library node scripts/reset-password.js admin 新密码
'use strict';
const path = require('node:path');
const { openDb } = require('../server/db');
const { hashPassword } = require('../server/auth');

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 6) {
  console.log('用法：node scripts/reset-password.js <账号> <新密码（至少 6 位）>');
  process.exit(1);
}
const db = openDb(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.log(`账号 ${username} 不存在`);
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`已重置账号 ${username} 的密码，并已启用该账号。`);
