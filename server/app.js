'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { openDb, transaction, now, CATEGORIES, CATEGORY_CODES } = require('./db');
const auth = require('./auth');
const { createEventHub } = require('./events');
const { createWechat } = require('./wechat');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg = '资源不存在') => new HttpError(404, msg);

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(value, { field, required = false, max = 200 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (required && !s) throw bad(`${field}不能为空`);
  if (s.length > max) throw bad(`${field}不能超过 ${max} 个字符`);
  return s;
}

function createApp({ dataDir, maxUploadMb = 200, adminPassword = 'admin123', wechat: wechatConfig = {} } = {}) {
  const db = openDb(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const events = createEventHub(db);
  const wechat = createWechat(db, wechatConfig);

  // 首次启动时创建默认管理员
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('admin', auth.hashPassword(adminPassword), '市场部管理员', 'admin', now());
    if (process.env.NODE_ENV !== 'test') {
      console.log('已创建默认管理员账号 admin，请登录后立即修改密码。');
    }
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: { fileSize: maxUploadMb * 1024 * 1024 },
  });

  const removeStoredFiles = (names) => {
    for (const name of names) fs.rmSync(path.join(uploadDir, name), { force: true });
  };

  // busboy 默认按 latin1 解码文件名，中文文件名需要转回 UTF-8
  const originalName = (file) => {
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? file.originalname : decoded;
  };

  // ---------- 查询帮助函数 ----------
  const q = {
    userById: db.prepare('SELECT id, username, display_name, role, active, created_at FROM users WHERE id = ?'),
    userBrandIds: db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ?'),
    brand: db.prepare('SELECT * FROM brands WHERE id = ?'),
    material: db.prepare('SELECT * FROM materials WHERE id = ?'),
    version: db.prepare('SELECT * FROM material_versions WHERE material_id = ? AND version = ?'),
  };

  const brandIdsOf = (userId) => q.userBrandIds.all(userId).map((r) => r.brand_id);

  function canSeeBrand(user, brandId) {
    return user.role === 'admin' || brandIdsOf(user.id).includes(brandId);
  }

  function publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      active: !!u.active,
      createdAt: u.created_at,
      brandIds: brandIdsOf(u.id),
    };
  }

  function materialDto(row, user) {
    const dto = {
      id: row.id,
      brandId: row.brand_id,
      brandName: row.brand_name,
      category: row.category,
      title: row.title,
      description: row.description,
      version: row.version,
      fileName: row.file_name,
      fileSize: row.file_size,
      mimeType: row.mime_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (user.role === 'sales') {
      dto.status = row.read_version == null ? 'new' : row.read_version < row.version ? 'updated' : 'read';
    }
    return dto;
  }

  function loadMaterial(id, user) {
    const row = db
      .prepare(
        `SELECT m.*, b.name AS brand_name, v.file_name, v.file_size, v.mime_type, r.version AS read_version
         FROM materials m
         JOIN brands b ON b.id = m.brand_id
         JOIN material_versions v ON v.material_id = m.id AND v.version = m.version
         LEFT JOIN material_reads r ON r.material_id = m.id AND r.user_id = ?
         WHERE m.id = ?`
      )
      .get(user.id, id);
    if (!row || !canSeeBrand(user, row.brand_id)) throw notFound('资料不存在');
    return materialDto(row, user);
  }

  // ---------- 路由 ----------
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(auth.authenticate(db));

  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ ok: true }));

  api.post('/login', async (req, res) => {
    const username = text(req.body?.username, { field: '用户名', required: true });
    const password = String(req.body?.password ?? '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, '用户名或密码错误');
    }
    if (!user.active) throw new HttpError(403, '账号已停用，请联系市场部');
    // 小程序登录时顺带绑定微信，下次可一键登录
    let wxBound = false;
    if (req.body?.wxCode && wechat.enabled) {
      try {
        await wechat.bind(user.id, String(req.body.wxCode));
        wxBound = true;
      } catch (err) {
        console.warn(`绑定微信失败：${err.message}`);
      }
    }
    const { token } = auth.createSession(db, user.id);
    res.cookie(auth.COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      maxAge: auth.SESSION_DAYS * 86400_000,
    });
    res.json({ token, user: publicUser(user), wxBound });
  });

  // ----- 微信小程序 -----
  api.get('/wx/config', (_req, res) => {
    res.json({ enabled: wechat.enabled, templateId: wechat.templateId });
  });

  api.post('/wx/login', async (req, res) => {
    if (!wechat.enabled) throw new HttpError(404, '未启用微信登录');
    const code = text(req.body?.code, { field: 'code', required: true });
    const userId = await wechat.userIdForCode(code).catch((err) => {
      throw new HttpError(502, err.message);
    });
    const user = userId && db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: '该微信尚未绑定账号，请用账号密码登录', needBind: true });
    if (!user.active) throw new HttpError(403, '账号已停用，请联系市场部');
    const { token } = auth.createSession(db, user.id);
    res.json({ token, user: publicUser(user) });
  });

  api.use(auth.requireLogin);

  api.get('/wx/status', (req, res) => res.json({ enabled: wechat.enabled, ...wechat.status(req.user.id) }));

  // 小程序端用户同意订阅后调用，每次同意可接收一条更新提醒
  api.post('/wx/subscribe', (req, res) => {
    const count = Math.min(Math.max(toInt(req.body?.count) ?? 1, 1), 10);
    if (!wechat.addQuota(req.user.id, count)) throw bad('当前账号未绑定微信');
    res.json(wechat.status(req.user.id));
  });

  api.post('/wx/unbind', (req, res) => {
    wechat.unbind(req.user.id);
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ ok: true });
  });

  api.get('/me', (req, res) => res.json(publicUser(q.userById.get(req.user.id))));

  api.post('/me/password', (req, res) => {
    const { oldPassword = '', newPassword = '' } = req.body ?? {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(oldPassword), user.password_hash)) throw bad('原密码不正确');
    if (String(newPassword).length < 6) throw bad('新密码至少 6 位');
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(newPassword)), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, req.token);
    });
    res.json({ ok: true });
  });

  api.get('/events', events.handler);

  api.get('/categories', (_req, res) => res.json(CATEGORIES));

  // ----- 品牌 -----
  api.get('/brands', (req, res) => {
    const rows =
      req.user.role === 'admin'
        ? db.prepare(
            `SELECT b.*, (SELECT COUNT(*) FROM materials m WHERE m.brand_id = b.id) AS material_count
             FROM brands b ORDER BY b.name`
          ).all()
        : db.prepare(
            `SELECT b.*, (SELECT COUNT(*) FROM materials m WHERE m.brand_id = b.id) AS material_count
             FROM brands b JOIN user_brands ub ON ub.brand_id = b.id
             WHERE ub.user_id = ? ORDER BY b.name`
          ).all(req.user.id);
    res.json(
      rows.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        materialCount: b.material_count,
        createdAt: b.created_at,
      }))
    );
  });

  function brandInput(body) {
    return {
      name: text(body?.name, { field: '品牌名称', required: true, max: 100 }),
      description: text(body?.description, { field: '品牌描述', max: 1000 }),
    };
  }

  function assertUniqueBrand(name, exceptId = 0) {
    if (db.prepare('SELECT 1 FROM brands WHERE name = ? AND id <> ?').get(name, exceptId)) {
      throw bad('品牌名称已存在');
    }
  }

  api.post('/brands', auth.requireAdmin, (req, res) => {
    const { name, description } = brandInput(req.body);
    assertUniqueBrand(name);
    const r = db
      .prepare('INSERT INTO brands (name, description, created_at) VALUES (?, ?, ?)')
      .run(name, description, now());
    res.status(201).json({ id: Number(r.lastInsertRowid), name, description });
  });

  api.put('/brands/:id', auth.requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    if (!id || !q.brand.get(id)) throw notFound('品牌不存在');
    const { name, description } = brandInput(req.body);
    assertUniqueBrand(name, id);
    db.prepare('UPDATE brands SET name = ?, description = ? WHERE id = ?').run(name, description, id);
    events.notifyBrand(id, 'brands', { brandId: id });
    res.json({ id, name, description });
  });

  api.delete('/brands/:id', auth.requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    if (!id || !q.brand.get(id)) throw notFound('品牌不存在');
    const files = db
      .prepare(
        `SELECT v.stored_name FROM material_versions v
         JOIN materials m ON m.id = v.material_id WHERE m.brand_id = ?`
      )
      .all(id)
      .map((r) => r.stored_name);
    const audience = events.audience(id);
    db.prepare('DELETE FROM brands WHERE id = ?').run(id);
    removeStoredFiles(files);
    events.sendTo(audience, 'brands', { brandId: id });
    res.json({ ok: true });
  });

  // ----- 销售员 / 用户 -----
  function setUserBrands(userId, brandIds) {
    if (!Array.isArray(brandIds)) throw bad('负责品牌格式不正确');
    const ids = [...new Set(brandIds.map(toInt))];
    if (ids.some((id) => !id || !q.brand.get(id))) throw bad('包含不存在的品牌');
    db.prepare('DELETE FROM user_brands WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_brands (user_id, brand_id) VALUES (?, ?)');
    for (const id of ids) ins.run(userId, id);
  }

  api.get('/users', auth.requireAdmin, (_req, res) => {
    const rows = db
      .prepare('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY role, username')
      .all();
    res.json(rows.map(publicUser));
  });

  api.post('/users', auth.requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const username = text(body.username, { field: '用户名', required: true, max: 50 });
    if (!/^[A-Za-z0-9_.@-]+$/.test(username)) throw bad('用户名只能包含字母、数字和 _ . @ -');
    const displayName = text(body.displayName, { field: '姓名', required: true, max: 50 });
    const role = body.role === 'admin' ? 'admin' : 'sales';
    const password = String(body.password ?? '');
    if (password.length < 6) throw bad('密码至少 6 位');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('用户名已存在');
    const id = transaction(db, () => {
      const r = db
        .prepare(
          'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(username, auth.hashPassword(password), displayName, role, now());
      const userId = Number(r.lastInsertRowid);
      setUserBrands(userId, body.brandIds ?? []);
      return userId;
    });
    res.status(201).json(publicUser(q.userById.get(id)));
  });

  api.put('/users/:id', auth.requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    const existing = id && q.userById.get(id);
    if (!existing) throw notFound('用户不存在');
    const body = req.body ?? {};
    const isSelf = id === req.user.id;
    transaction(db, () => {
      if (body.displayName !== undefined) {
        const displayName = text(body.displayName, { field: '姓名', required: true, max: 50 });
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
      }
      if (body.role !== undefined) {
        const role = body.role === 'admin' ? 'admin' : 'sales';
        if (isSelf && role !== 'admin') throw bad('不能取消自己的管理员权限');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
      }
      if (body.active !== undefined) {
        if (isSelf && !body.active) throw bad('不能停用自己的账号');
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
        if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (body.password) {
        if (String(body.password).length < 6) throw bad('密码至少 6 位');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(body.password)), id);
        if (!isSelf) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (body.brandIds !== undefined) setUserBrands(id, body.brandIds);
    });
    const updated = q.userById.get(id);
    if (!updated.active) events.disconnectUser(id);
    else events.notifyUser(id, 'brands', {});
    res.json(publicUser(updated));
  });

  api.delete('/users/:id', auth.requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    if (!id || !q.userById.get(id)) throw notFound('用户不存在');
    if (id === req.user.id) throw bad('不能删除自己的账号');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    events.disconnectUser(id);
    res.json({ ok: true });
  });

  // ----- 资料 -----
  api.get('/materials', (req, res) => {
    const where = [];
    const params = [req.user.id];
    if (req.user.role !== 'admin') {
      where.push('m.brand_id IN (SELECT brand_id FROM user_brands WHERE user_id = ?)');
      params.push(req.user.id);
    }
    const brandId = toInt(req.query.brandId);
    if (brandId) {
      where.push('m.brand_id = ?');
      params.push(brandId);
    }
    if (req.query.category && CATEGORY_CODES.has(req.query.category)) {
      where.push('m.category = ?');
      params.push(req.query.category);
    }
    const keyword = String(req.query.q ?? '').trim();
    if (keyword) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.description LIKE ? ESCAPE '\\' OR v.file_name LIKE ? ESCAPE '\\')");
      const like = `%${keyword.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(like, like, like);
    }
    const rows = db
      .prepare(
        `SELECT m.*, b.name AS brand_name, v.file_name, v.file_size, v.mime_type, r.version AS read_version
         FROM materials m
         JOIN brands b ON b.id = m.brand_id
         JOIN material_versions v ON v.material_id = m.id AND v.version = m.version
         LEFT JOIN material_reads r ON r.material_id = m.id AND r.user_id = ?
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY m.updated_at DESC`
      )
      .all(...params);
    res.json(rows.map((row) => materialDto(row, req.user)));
  });

  api.get('/materials/:id', (req, res) => {
    const id = toInt(req.params.id);
    if (!id) throw notFound('资料不存在');
    res.json(loadMaterial(id, req.user));
  });

  function materialFields(body, { partial }) {
    const out = {};
    if (!partial || body.brandId !== undefined) {
      const brandId = toInt(body.brandId);
      if (!brandId || !q.brand.get(brandId)) throw bad('请选择有效的品牌');
      out.brandId = brandId;
    }
    if (!partial || body.category !== undefined) {
      if (!CATEGORY_CODES.has(body.category)) throw bad('请选择有效的资料分类');
      out.category = body.category;
    }
    if (!partial || body.title !== undefined) {
      out.title = text(body.title, { field: '标题', required: true, max: 200 });
    }
    if (!partial || body.description !== undefined) {
      out.description = text(body.description, { field: '说明', max: 2000 });
    }
    return out;
  }

  function insertVersion(materialId, version, file, note, userId, at) {
    db.prepare(
      `INSERT INTO material_versions
         (material_id, version, file_name, stored_name, mime_type, file_size, note, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      materialId,
      version,
      originalName(file),
      file.filename,
      file.mimetype || 'application/octet-stream',
      file.size,
      note,
      userId,
      at
    );
  }

  // 微信订阅消息在后台发送，不阻塞接口响应
  function pushWechat(dto, action, note) {
    const categoryName = CATEGORIES.find((c) => c.code === dto.category)?.name;
    const pending = wechat.notifyMaterial({ ...dto, categoryName, note }, action).catch((err) => {
      console.warn(`订阅消息发送异常：${err.message}`);
    });
    app.locals.wechatPending = pending;
  }

  // multer 在出错时需要清理已写入磁盘的文件
  const withUpload = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      if (req.file) removeStoredFiles([req.file.filename]);
      throw err;
    }
  };

  api.post(
    '/materials',
    auth.requireAdmin,
    upload.single('file'),
    withUpload((req, res) => {
      if (!req.file) throw bad('请选择要上传的文件');
      const f = materialFields(req.body ?? {}, { partial: false });
      const note = text(req.body?.note, { field: '版本说明', max: 500 });
      const at = now();
      const id = transaction(db, () => {
        const r = db
          .prepare(
            `INSERT INTO materials (brand_id, category, title, description, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`
          )
          .run(f.brandId, f.category, f.title, f.description, at, at);
        const materialId = Number(r.lastInsertRowid);
        insertVersion(materialId, 1, req.file, note || '首次发布', req.user.id, at);
        return materialId;
      });
      const dto = loadMaterial(id, req.user);
      events.notifyBrand(dto.brandId, 'material', { action: 'created', material: dto });
      pushWechat(dto, 'created', note);
      res.status(201).json(dto);
    })
  );

  api.put(
    '/materials/:id',
    auth.requireAdmin,
    upload.single('file'),
    withUpload((req, res) => {
      const id = toInt(req.params.id);
      const existing = id && q.material.get(id);
      if (!existing) throw notFound('资料不存在');
      const f = materialFields(req.body ?? {}, { partial: true });
      const note = text(req.body?.note, { field: '版本说明', max: 500 });
      const at = now();
      transaction(db, () => {
        const next = {
          brand_id: f.brandId ?? existing.brand_id,
          category: f.category ?? existing.category,
          title: f.title ?? existing.title,
          description: f.description ?? existing.description,
          version: existing.version,
        };
        if (req.file) {
          next.version += 1;
          insertVersion(id, next.version, req.file, note, req.user.id, at);
        }
        db.prepare(
          `UPDATE materials SET brand_id = ?, category = ?, title = ?, description = ?, version = ?, updated_at = ?
           WHERE id = ?`
        ).run(next.brand_id, next.category, next.title, next.description, next.version, at, id);
      });
      const dto = loadMaterial(id, req.user);
      const payload = { action: req.file ? 'new_version' : 'updated', material: dto };
      if (existing.brand_id !== dto.brandId) {
        events.notifyBrand(existing.brand_id, 'material', { action: 'deleted', id });
      }
      events.notifyBrand(dto.brandId, 'material', payload);
      pushWechat(dto, payload.action, note);
      res.json(dto);
    })
  );

  api.delete('/materials/:id', auth.requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    const existing = id && q.material.get(id);
    if (!existing) throw notFound('资料不存在');
    const files = db
      .prepare('SELECT stored_name FROM material_versions WHERE material_id = ?')
      .all(id)
      .map((r) => r.stored_name);
    db.prepare('DELETE FROM materials WHERE id = ?').run(id);
    removeStoredFiles(files);
    events.notifyBrand(existing.brand_id, 'material', { action: 'deleted', id });
    res.json({ ok: true });
  });

  api.get('/materials/:id/versions', auth.requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    if (!id || !q.material.get(id)) throw notFound('资料不存在');
    const rows = db
      .prepare(
        `SELECT v.version, v.file_name, v.file_size, v.mime_type, v.note, v.created_at, u.display_name AS uploader
         FROM material_versions v LEFT JOIN users u ON u.id = v.uploaded_by
         WHERE v.material_id = ? ORDER BY v.version DESC`
      )
      .all(id);
    res.json(
      rows.map((r) => ({
        version: r.version,
        fileName: r.file_name,
        fileSize: r.file_size,
        mimeType: r.mime_type,
        note: r.note,
        uploader: r.uploader,
        createdAt: r.created_at,
      }))
    );
  });

  // 下载 / 在线预览。销售员只能拿到当前最新版本；管理员可指定历史版本。
  api.get('/materials/:id/file', (req, res) => {
    const id = toInt(req.params.id);
    const material = id && q.material.get(id);
    if (!material || !canSeeBrand(req.user, material.brand_id)) throw notFound('资料不存在');
    const requested = toInt(req.query.version);
    const version = req.user.role === 'admin' && requested ? requested : material.version;
    const file = q.version.get(id, version);
    if (!file) throw notFound('文件版本不存在');

    if (req.user.role === 'sales') {
      db.prepare(
        `INSERT INTO material_reads (user_id, material_id, version, read_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, material_id) DO UPDATE SET version = excluded.version, read_at = excluded.read_at`
      ).run(req.user.id, id, version, now());
    }

    const disposition = req.query.inline ? 'inline' : 'attachment';
    const asciiName = file.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.set({
      'Content-Type': file.mime_type,
      'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(path.join(uploadDir, file.stored_name), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '文件丢失，请联系市场部' });
    });
  });

  // 首页统计（销售员：未读数量；管理员：总量）
  api.get('/stats', (req, res) => {
    if (req.user.role === 'admin') {
      const count = (sql) => db.prepare(sql).get().n;
      return res.json({
        brands: count('SELECT COUNT(*) AS n FROM brands'),
        materials: count('SELECT COUNT(*) AS n FROM materials'),
        sales: count("SELECT COUNT(*) AS n FROM users WHERE role = 'sales' AND active = 1"),
      });
    }
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN r.version IS NULL OR r.version < m.version THEN 1 ELSE 0 END) AS unread
         FROM materials m
         LEFT JOIN material_reads r ON r.material_id = m.id AND r.user_id = ?
         WHERE m.brand_id IN (SELECT brand_id FROM user_brands WHERE user_id = ?)`
      )
      .get(req.user.id, req.user.id);
    res.json({ total: row.total, unread: row.unread ?? 0 });
  });

  api.use((_req, _res) => {
    throw notFound('接口不存在');
  });

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 统一错误处理
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `文件不能超过 ${maxUploadMb} MB` : `上传失败：${err.message}`;
      return res.status(400).json({ error: msg });
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '服务器内部错误' : err.message });
  });

  app.locals.close = () => {
    events.closeAll();
    db.close();
  };
  return app;
}

module.exports = { createApp };
