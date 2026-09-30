'use strict';

// 基于 Server-Sent Events 的实时推送：管理员更新资料后，
// 在线的相关销售员立即收到通知并刷新列表。
function createEventHub(db) {
  const clients = new Set();
  const brandsOf = db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ?');

  function send(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function handler(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const client = { res, user: req.user };
    clients.add(client);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  }

  // 能看到该品牌的所有在线连接（管理员 + 负责该品牌的销售员）
  function audience(brandId) {
    return [...clients].filter(
      ({ user }) => user.role === 'admin' || brandsOf.all(user.id).some((r) => r.brand_id === brandId)
    );
  }

  function sendTo(targets, event, data) {
    for (const client of targets) send(client, event, data);
  }

  function notifyBrand(brandId, event, data) {
    sendTo(audience(brandId), event, data);
  }

  function notifyUser(userId, event, data) {
    for (const client of clients) {
      if (client.user.id === userId) send(client, event, data);
    }
  }

  // 账号停用或删除时断开其实时连接
  function disconnectUser(userId) {
    for (const client of clients) {
      if (client.user.id === userId) {
        client.res.end();
        clients.delete(client);
      }
    }
  }

  function closeAll() {
    for (const client of clients) client.res.end();
    clients.clear();
  }

  return { handler, audience, sendTo, notifyBrand, notifyUser, disconnectUser, closeAll };
}

module.exports = { createEventHub };
