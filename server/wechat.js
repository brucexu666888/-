'use strict';
const { now } = require('./db');

// 订阅消息模板字段默认映射：模板字段名 → 取值来源
// 可选来源：title 资料标题 / brand 品牌 / category 分类 / action 动作 / time 时间 / note 版本说明
const DEFAULT_TEMPLATE_FIELDS = { thing1: 'title', thing2: 'brand', time3: 'time', thing4: 'action' };
const MAX_QUOTA = 50;

const ACTION_TEXT = { created: '发布了新资料', new_version: '更新了资料文件' };

function beijingTime(iso) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 按微信订阅消息的字段类型限制截断取值
function fitValue(key, value) {
  const s = String(value ?? '');
  const limits = { thing: 20, phrase: 5, character_string: 32, name: 10, letter: 32, number: 32 };
  const type = Object.keys(limits).find((t) => key.startsWith(t));
  if (!type) return s;
  const chars = [...s];
  if (chars.length <= limits[type]) return s;
  return type === 'thing' ? chars.slice(0, limits[type] - 1).join('') + '…' : chars.slice(0, limits[type]).join('');
}

function createWechat(db, config = {}) {
  const {
    appId,
    secret,
    templateId = '',
    templateFields = DEFAULT_TEMPLATE_FIELDS,
    apiBase = 'https://api.weixin.qq.com',
    miniprogramState = 'formal',
    logger = console,
  } = config;
  const enabled = Boolean(appId && secret);
  let tokenCache = { value: null, expiresAt: 0 };

  async function callApi(path, { method = 'GET', body } = {}) {
    const res = await fetch(apiBase + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (data.errcode) {
      const err = new Error(`微信接口错误 ${data.errcode}: ${data.errmsg}`);
      err.errcode = data.errcode;
      throw err;
    }
    return data;
  }

  async function code2Session(code) {
    const qs = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: 'authorization_code' });
    const data = await callApi(`/sns/jscode2session?${qs}`);
    if (!data.openid) throw new Error('微信登录失败：未获取到 openid');
    return data.openid;
  }

  async function accessToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
    const data = await callApi('/cgi-bin/stable_token', {
      method: 'POST',
      body: { grant_type: 'client_credential', appid: appId, secret },
    });
    tokenCache = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
    return tokenCache.value;
  }

  const q = {
    byOpenid: db.prepare('SELECT user_id FROM wx_accounts WHERE openid = ?'),
    byUser: db.prepare('SELECT openid, quota FROM wx_accounts WHERE user_id = ?'),
    unbindOpenid: db.prepare('DELETE FROM wx_accounts WHERE openid = ? OR user_id = ?'),
    bind: db.prepare('INSERT INTO wx_accounts (user_id, openid, quota, bound_at) VALUES (?, ?, 0, ?)'),
    unbind: db.prepare('DELETE FROM wx_accounts WHERE user_id = ?'),
    addQuota: db.prepare(`UPDATE wx_accounts SET quota = MIN(quota + ?, ${MAX_QUOTA}) WHERE user_id = ?`),
    setQuota: db.prepare('UPDATE wx_accounts SET quota = ? WHERE user_id = ?'),
    useQuota: db.prepare('UPDATE wx_accounts SET quota = quota - 1 WHERE user_id = ? AND quota > 0'),
    audience: db.prepare(`
      SELECT w.user_id, w.openid FROM wx_accounts w
      JOIN users u ON u.id = w.user_id
      JOIN user_brands ub ON ub.user_id = u.id
      WHERE ub.brand_id = ? AND u.role = 'sales' AND u.active = 1 AND w.quota > 0`),
  };

  // 通过 wx.login 的 code 找到已绑定的账号
  async function userIdForCode(code) {
    const openid = await code2Session(code);
    return q.byOpenid.get(openid)?.user_id ?? null;
  }

  // 将当前微信绑定到账号（一个微信只能绑定一个账号，反之亦然）
  async function bind(userId, code) {
    const openid = await code2Session(code);
    q.unbindOpenid.run(openid, userId);
    q.bind.run(userId, openid, now());
  }

  function status(userId) {
    const row = q.byUser.get(userId);
    return { bound: Boolean(row), quota: row?.quota ?? 0 };
  }

  function unbind(userId) {
    q.unbind.run(userId);
  }

  function addQuota(userId, count) {
    return q.addQuota.run(count, userId).changes > 0;
  }

  function buildData(material, action) {
    const source = {
      title: material.title,
      brand: material.brandName,
      category: material.categoryName,
      action: ACTION_TEXT[action] ?? '资料已更新',
      time: beijingTime(material.updatedAt),
      note: material.note || '无',
    };
    const data = {};
    for (const [key, from] of Object.entries(templateFields)) {
      data[key] = { value: fitValue(key, source[from] ?? from) };
    }
    return data;
  }

  // 资料发布 / 更新后，给负责该品牌、且还有订阅额度的销售员发送微信订阅消息
  async function notifyMaterial(material, action) {
    if (!enabled || !templateId || !ACTION_TEXT[action]) return [];
    const targets = q.audience.all(material.brandId);
    const results = [];
    for (const { user_id: userId, openid } of targets) {
      q.useQuota.run(userId);
      try {
        await callApi(`/cgi-bin/message/subscribe/send?access_token=${await accessToken()}`, {
          method: 'POST',
          body: {
            touser: openid,
            template_id: templateId,
            page: `pages/detail/detail?id=${material.id}`,
            miniprogram_state: miniprogramState,
            lang: 'zh_CN',
            data: buildData(material, action),
          },
        });
        results.push({ userId, ok: true });
      } catch (err) {
        // 43101：用户拒绝或额度已用完，服务端额度与微信不同步时归零
        if (err.errcode === 43101) q.setQuota.run(0, userId);
        if (err.errcode === 40001 || err.errcode === 42001) tokenCache = { value: null, expiresAt: 0 };
        logger.warn(`订阅消息发送失败（用户 ${userId}）：${err.message}`);
        results.push({ userId, ok: false, error: err.message });
      }
    }
    return results;
  }

  return {
    enabled,
    templateId: enabled ? templateId : '',
    userIdForCode,
    bind,
    unbind,
    status,
    addQuota,
    notifyMaterial,
  };
}

module.exports = { createWechat, fitValue, DEFAULT_TEMPLATE_FIELDS };
