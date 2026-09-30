'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 资料分类（固定枚举，前后端共用）
const CATEGORIES = [
  { code: 'product', name: '产品资料' },
  { code: 'price', name: '价格表' },
  { code: 'training', name: '培训文件' },
  { code: 'sample', name: '样本' },
  { code: 'manual', name: '手册' },
  { code: 'marketing', name: '市场资料' },
];
const CATEGORY_CODES = new Set(CATEGORIES.map((c) => c.code));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'sales')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_brands (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, brand_id)
);

CREATE TABLE IF NOT EXISTS materials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id    INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_brand ON materials(brand_id, category);

-- 每次上传新文件都生成一个版本，materials.version 指向当前版本
CREATE TABLE IF NOT EXISTS material_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (material_id, version)
);

-- 销售员已查看过的版本，用于标记“新”/“已更新”
CREATE TABLE IF NOT EXISTS material_reads (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  read_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, material_id)
);
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'library.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// 在事务中执行 fn，出错时回滚
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const now = () => new Date().toISOString();

module.exports = { openDb, transaction, now, CATEGORIES, CATEGORY_CODES };
