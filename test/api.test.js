'use strict';
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-lib-'));
  const app = createApp({ dataDir, adminPassword: 'admin-pass', maxUploadMb: 1 });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  server.on('close', () => app.locals.close());
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(base + url, { method, headers, body });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function login(username, password) {
  const r = await call('POST', '/login', { json: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

function materialForm(fields, fileName, content) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (fileName) form.append('file', new Blob([content], { type: 'application/pdf' }), fileName);
  return form;
}

test('完整流程：管理员维护资料，销售员按品牌获取最新版本', async () => {
  // 登录失败
  assert.equal((await call('POST', '/login', { json: { username: 'admin', password: 'x' } })).status, 401);
  assert.equal((await call('GET', '/materials')).status, 401);

  const admin = await login('admin', 'admin-pass');

  // 品牌
  const a = (await call('POST', '/brands', { token: admin, json: { name: '品牌A' } })).data;
  const b = (await call('POST', '/brands', { token: admin, json: { name: '品牌B' } })).data;
  assert.equal((await call('POST', '/brands', { token: admin, json: { name: '品牌A' } })).status, 400);

  // 销售员，只负责品牌 A
  const created = await call('POST', '/users', {
    token: admin,
    json: { username: 'zhang', displayName: '张三', password: 'secret1', brandIds: [a.id] },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.brandIds, [a.id]);
  const sales = await login('zhang', 'secret1');

  // 销售员不能做管理操作
  assert.equal((await call('POST', '/brands', { token: sales, json: { name: 'X' } })).status, 403);
  assert.equal((await call('GET', '/users', { token: sales })).status, 403);

  // 上传资料（中文文件名）
  const m1 = await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: a.id, category: 'price', title: '2026 价格表' }, '价格表V1.pdf', 'v1'),
  });
  assert.equal(m1.status, 201, JSON.stringify(m1.data));
  assert.equal(m1.data.fileName, '价格表V1.pdf');
  assert.equal(m1.data.version, 1);

  const mb = await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: b.id, category: 'manual', title: 'B 手册' }, 'b.pdf', 'b'),
  });
  assert.equal(mb.status, 201);

  // 校验
  const noFile = await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: a.id, category: 'price', title: 'x' }),
  });
  assert.equal(noFile.status, 400);
  const badCat = await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: a.id, category: 'nope', title: 'x' }, 'x.pdf', 'x'),
  });
  assert.equal(badCat.status, 400);
  const tooBig = await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: a.id, category: 'price', title: 'x' }, 'x.pdf', 'x'.repeat(2 * 1024 * 1024)),
  });
  assert.equal(tooBig.status, 400);
  // 失败的上传不应在磁盘上留下文件
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 2);

  // 销售员只能看到自己品牌的资料
  let list = (await call('GET', '/materials', { token: sales })).data;
  assert.deepEqual(list.map((m) => m.title), ['2026 价格表']);
  assert.equal(list[0].status, 'new');
  assert.equal((await call('GET', `/materials/${mb.data.id}`, { token: sales })).status, 404);
  assert.equal((await call('GET', `/materials/${mb.data.id}/file`, { token: sales })).status, 404);
  assert.deepEqual((await call('GET', '/brands', { token: sales })).data.map((x) => x.name), ['品牌A']);
  assert.deepEqual((await call('GET', '/stats', { token: sales })).data, { total: 1, unread: 1 });

  // 下载后标记为已读
  const dl = await call('GET', `/materials/${m1.data.id}/file`, { token: sales });
  assert.equal(dl.status, 200);
  assert.equal(dl.data, 'v1');
  assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''%E4%BB%B7/);
  list = (await call('GET', '/materials', { token: sales })).data;
  assert.equal(list[0].status, 'read');

  // 管理员上传新版本 → 销售员看到“已更新”，下载到的是最新文件
  const upd = await call('PUT', `/materials/${m1.data.id}`, {
    token: admin,
    form: materialForm({ note: '调价' }, '价格表V2.pdf', 'v2'),
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.equal(upd.data.version, 2);
  list = (await call('GET', '/materials', { token: sales })).data;
  assert.equal(list[0].status, 'updated');
  assert.equal(list[0].fileName, '价格表V2.pdf');
  assert.equal((await call('GET', `/materials/${m1.data.id}/file?version=1`, { token: sales })).data, 'v2');
  assert.equal((await call('GET', `/materials/${m1.data.id}/file?version=1`, { token: admin })).data, 'v1');

  const versions = (await call('GET', `/materials/${m1.data.id}/versions`, { token: admin })).data;
  assert.deepEqual(versions.map((v) => [v.version, v.note]), [[2, '调价'], [1, '首次发布']]);

  // 仅修改文字信息不产生新版本
  const edit = await call('PUT', `/materials/${m1.data.id}`, {
    token: admin,
    form: materialForm({ title: '2026 价格表（修订）' }),
  });
  assert.equal(edit.data.version, 2);

  // 搜索与筛选
  assert.equal((await call('GET', '/materials?q=修订', { token: sales })).data.length, 1);
  assert.equal((await call('GET', '/materials?q=100%', { token: sales })).data.length, 0);
  assert.equal((await call('GET', '/materials?category=manual', { token: sales })).data.length, 0);
  assert.equal((await call('GET', `/materials?brandId=${b.id}`, { token: admin })).data.length, 1);

  // 给销售员分配品牌 B 后即可看到
  await call('PUT', `/users/${created.data.id}`, { token: admin, json: { brandIds: [a.id, b.id] } });
  assert.equal((await call('GET', '/materials', { token: sales })).data.length, 2);

  // 删除资料会同时删除所有版本的文件
  assert.equal((await call('DELETE', `/materials/${m1.data.id}`, { token: admin })).status, 200);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 1);

  // 删除品牌级联删除资料
  assert.equal((await call('DELETE', `/brands/${b.id}`, { token: admin })).status, 200);
  assert.equal((await call('GET', '/materials', { token: admin })).data.length, 0);

  // 停用账号后会话立即失效
  await call('PUT', `/users/${created.data.id}`, { token: admin, json: { active: false } });
  assert.equal((await call('GET', '/me', { token: sales })).status, 401);
  assert.equal((await call('POST', '/login', { json: { username: 'zhang', password: 'secret1' } })).status, 403);

  // 管理员不能停用自己
  const me = (await call('GET', '/me', { token: admin })).data;
  assert.equal((await call('PUT', `/users/${me.id}`, { token: admin, json: { active: false } })).status, 400);
});

test('修改密码', async () => {
  const admin = await login('admin', 'admin-pass');
  await call('POST', '/users', {
    token: admin,
    json: { username: 'li', displayName: '李四', password: 'secret1', brandIds: [] },
  });
  const t = await login('li', 'secret1');
  assert.equal((await call('POST', '/me/password', { token: t, json: { oldPassword: 'bad', newPassword: 'newpass1' } })).status, 400);
  assert.equal((await call('POST', '/me/password', { token: t, json: { oldPassword: 'secret1', newPassword: 'newpass1' } })).status, 200);
  await login('li', 'newpass1');
});

test('实时推送：管理员发布资料后销售员收到事件', async () => {
  const admin = await login('admin', 'admin-pass');
  const brand = (await call('POST', '/brands', { token: admin, json: { name: '推送品牌' } })).data;
  const other = (await call('POST', '/brands', { token: admin, json: { name: '其他品牌' } })).data;
  await call('POST', '/users', {
    token: admin,
    json: { username: 'wang', displayName: '王五', password: 'secret1', brandIds: [brand.id] },
  });
  const sales = await login('wang', 'secret1');

  const controller = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { authorization: `Bearer ${sales}` },
    signal: controller.signal,
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextEvent = async () => {
    for (;;) {
      const idx = buffer.indexOf('event: ');
      const end = idx >= 0 ? buffer.indexOf('\n\n', idx) : -1;
      if (end >= 0) {
        const chunk = buffer.slice(idx, end);
        buffer = buffer.slice(end + 2);
        const [, name] = chunk.match(/^event: (.*)$/m);
        const [, data] = chunk.match(/^data: (.*)$/m);
        return { name, data: JSON.parse(data) };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
  };

  // 其他品牌的资料不会推送给该销售员；先发它，再发本品牌的，只应收到后者
  await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: other.id, category: 'sample', title: '其他样本' }, 's.pdf', 's'),
  });
  await call('POST', '/materials', {
    token: admin,
    form: materialForm({ brandId: brand.id, category: 'training', title: '新品培训' }, 't.pdf', 't'),
  });
  const evt = await nextEvent();
  assert.equal(evt.name, 'material');
  assert.equal(evt.data.action, 'created');
  assert.equal(evt.data.material.title, '新品培训');
  controller.abort();
});
