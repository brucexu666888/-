'use strict';
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const { fitValue } = require('../server/wechat');

// 模拟微信服务端：code "code-<name>" 对应 openid "openid-<name>"
const sent = [];
let refuse = new Set();
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/sns/jscode2session') {
      const code = url.searchParams.get('js_code');
      if (!code.startsWith('code-')) return res.end(JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }));
      return res.end(JSON.stringify({ openid: code.replace('code-', 'openid-'), session_key: 'k' }));
    }
    if (url.pathname === '/cgi-bin/stable_token') {
      return res.end(JSON.stringify({ access_token: 'TOKEN', expires_in: 7200 }));
    }
    if (url.pathname === '/cgi-bin/message/subscribe/send') {
      const msg = JSON.parse(body);
      if (refuse.has(msg.touser)) return res.end(JSON.stringify({ errcode: 43101, errmsg: 'user refuse' }));
      sent.push({ token: url.searchParams.get('access_token'), ...msg });
      return res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

let server;
let app;
let base;
let dataDir;

before(async () => {
  await new Promise((r) => mock.listen(0, r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-lib-wx-'));
  app = createApp({
    dataDir,
    adminPassword: 'admin-pass',
    wechat: {
      appId: 'wx-test',
      secret: 'secret',
      templateId: 'TPL',
      apiBase: `http://127.0.0.1:${mock.address().port}`,
      logger: { warn() {} },
    },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  mock.close();
  app.locals.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body = form;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(base + url, { method, headers, body });
  return { status: res.status, data: await res.json() };
}

function upload(token, fields, name, content, id) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (name) form.append('file', new Blob([content]), name);
  return call(id ? 'PUT' : 'POST', id ? `/materials/${id}` : '/materials', { token, form });
}

test('fitValue 按字段类型截断', () => {
  assert.equal(fitValue('thing1', '一二三四五六七八九十一二三四五六七八九十一'), '一二三四五六七八九十一二三四五六七八九…');
  assert.equal(fitValue('thing1', '短'), '短');
  assert.equal(fitValue('phrase3', '发布了新资料'), '发布了新资');
  assert.equal(fitValue('time2', '2026-10-01 09:00'), '2026-10-01 09:00');
});

test('微信绑定、一键登录与订阅消息推送', async () => {
  assert.deepEqual((await call('GET', '/wx/config')).data, { enabled: true, templateId: 'TPL' });

  const admin = (await call('POST', '/login', { json: { username: 'admin', password: 'admin-pass' } })).data.token;
  const brand = (await call('POST', '/brands', { token: admin, json: { name: '品牌A' } })).data;
  const other = (await call('POST', '/brands', { token: admin, json: { name: '品牌B' } })).data;
  for (const [username, brandIds] of [['zhang', [brand.id]], ['li', [brand.id]], ['wang', [other.id]]]) {
    await call('POST', '/users', { token: admin, json: { username, displayName: username, password: 'secret1', brandIds } });
  }

  // 未绑定时一键登录失败
  const miss = await call('POST', '/wx/login', { json: { code: 'code-zhang' } });
  assert.equal(miss.status, 404);
  assert.equal(miss.data.needBind, true);
  assert.equal((await call('POST', '/wx/login', { json: { code: 'bad' } })).status, 502);

  // 账号密码登录时带上 wxCode 完成绑定
  const login = await call('POST', '/login', { json: { username: 'zhang', password: 'secret1', wxCode: 'code-zhang' } });
  assert.equal(login.data.wxBound, true);
  const zhang = login.data.token;
  const quick = await call('POST', '/wx/login', { json: { code: 'code-zhang' } });
  assert.equal(quick.status, 200);
  assert.equal(quick.data.user.username, 'zhang');

  // li、wang 也绑定微信
  const li = (await call('POST', '/login', { json: { username: 'li', password: 'secret1', wxCode: 'code-li' } })).data.token;
  const wang = (await call('POST', '/login', { json: { username: 'wang', password: 'secret1', wxCode: 'code-wang' } })).data.token;

  // 订阅额度
  assert.deepEqual((await call('GET', '/wx/status', { token: zhang })).data, { enabled: true, bound: true, quota: 0 });
  assert.equal((await call('POST', '/wx/subscribe', { token: zhang, json: { count: 2 } })).data.quota, 2);
  await call('POST', '/wx/subscribe', { token: wang });
  // li 不订阅

  // 发布品牌 A 的资料：只有 zhang 收到（li 没有额度，wang 不负责该品牌）
  const m = (await upload(admin, { brandId: brand.id, category: 'price', title: '2026 年第四季度全系列产品经销商价格表' }, 'p.pdf', 'v1')).data;
  await app.locals.wechatPending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].touser, 'openid-zhang');
  assert.equal(sent[0].template_id, 'TPL');
  assert.equal(sent[0].token, 'TOKEN');
  assert.equal(sent[0].page, `pages/detail/detail?id=${m.id}`);
  assert.equal(sent[0].data.thing1.value, '2026 年第四季度全系列产品经销商价…');
  assert.equal(sent[0].data.thing2.value, '品牌A');
  assert.equal(sent[0].data.thing4.value, '发布了新资料');
  assert.match(sent[0].data.time3.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal((await call('GET', '/wx/status', { token: zhang })).data.quota, 1);

  // 只改文字不推送；替换文件推送
  await upload(admin, { title: '改标题' }, null, null, m.id);
  await app.locals.wechatPending;
  assert.equal(sent.length, 1);
  await upload(admin, {}, 'p2.pdf', 'v2', m.id);
  await app.locals.wechatPending;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].data.thing4.value, '更新了资料文件');
  assert.equal((await call('GET', '/wx/status', { token: zhang })).data.quota, 0);

  // 额度用完后不再推送
  await upload(admin, {}, 'p3.pdf', 'v3', m.id);
  await app.locals.wechatPending;
  assert.equal(sent.length, 2);

  // 微信返回 43101（用户拒收）时额度清零
  await call('POST', '/wx/subscribe', { token: li, json: { count: 3 } });
  refuse = new Set(['openid-li']);
  await upload(admin, {}, 'p4.pdf', 'v4', m.id);
  await app.locals.wechatPending;
  assert.equal((await call('GET', '/wx/status', { token: li })).data.quota, 0);

  // 同一个微信改绑到另一个账号时，旧绑定自动解除
  await call('POST', '/login', { json: { username: 'li', password: 'secret1', wxCode: 'code-zhang' } });
  assert.equal((await call('GET', '/wx/status', { token: zhang })).data.bound, false);
  assert.equal((await call('POST', '/wx/login', { json: { code: 'code-zhang' } })).data.user.username, 'li');

  // 解绑
  await call('POST', '/wx/unbind', { token: li });
  assert.equal((await call('POST', '/wx/login', { json: { code: 'code-zhang' } })).status, 404);
  assert.equal((await call('POST', '/wx/subscribe', { token: li })).status, 400);
});
