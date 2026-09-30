const config = require('../config');

const TOKEN_KEY = 'sl_token';
const USER_KEY = 'sl_user';

// 小程序内可直接打开的文档格式（wx.openDocument）
const DOC_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const VIDEO_TYPES = ['mp4', 'mov', 'm4v', '3gp'];

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function setSession(token, user) {
  wx.setStorageSync(TOKEN_KEY, token);
  wx.setStorageSync(USER_KEY, user);
}

function clearSession() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
}

function goLogin() {
  clearSession();
  wx.reLaunch({ url: '/pages/login/login' });
}

function request(path, { method = 'GET', data } = {}) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    wx.request({
      url: `${config.baseUrl}/api${path}`,
      method,
      data,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        const body = res.data || {};
        if (res.statusCode === 401 && token) {
          goLogin();
          return reject(new Error('登录已过期，请重新登录'));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        const err = new Error(body.error || `请求失败（${res.statusCode}）`);
        err.statusCode = res.statusCode;
        err.data = body;
        reject(err);
      },
      fail() {
        reject(new Error('网络异常，请检查网络后重试'));
      },
    });
  });
}

function wxLoginCode() {
  return new Promise((resolve) => {
    wx.login({
      success: (res) => resolve(res.code || ''),
      fail: () => resolve(''),
    });
  });
}

function fileExt(name) {
  const i = String(name).lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 给列表 / 详情展示补充格式化字段
function decorate(m, categories) {
  const cat = (categories || []).find((c) => c.code === m.category);
  const ext = fileExt(m.fileName);
  return Object.assign({}, m, {
    categoryName: cat ? cat.name : m.category,
    ext: (ext || 'file').slice(0, 4).toUpperCase(),
    sizeText: formatSize(m.fileSize),
    timeText: formatTime(m.updatedAt),
  });
}

// 下载资料最新版本到临时文件（服务端会同时记为已读）
function downloadMaterial(m) {
  return new Promise((resolve, reject) => {
    const task = wx.downloadFile({
      url: `${config.baseUrl}/api/materials/${m.id}/file`,
      header: { Authorization: `Bearer ${getToken()}` },
      success(res) {
        if (res.statusCode === 200) return resolve(res.tempFilePath);
        if (res.statusCode === 401) goLogin();
        reject(new Error(res.statusCode === 404 ? '资料不存在或已被删除' : `下载失败（${res.statusCode}）`));
      },
      fail(err) {
        reject(new Error(err && /domain/.test(err.errMsg) ? '下载域名未配置，请联系管理员' : '下载失败，请检查网络'));
      },
    });
    task.onProgressUpdate(({ progress }) => {
      wx.showLoading({ title: `下载中 ${progress}%`, mask: true });
    });
  });
}

// 在小程序内打开资料：文档用 openDocument，图片 / 视频用 previewMedia
async function openMaterial(m) {
  const ext = fileExt(m.fileName);
  wx.showLoading({ title: '下载中', mask: true });
  let path;
  try {
    path = await downloadMaterial(m);
  } finally {
    wx.hideLoading();
  }
  if (DOC_TYPES.includes(ext)) {
    return new Promise((resolve, reject) => {
      wx.openDocument({
        filePath: path,
        fileType: ext,
        showMenu: true,
        success: resolve,
        fail: () => reject(new Error('文件无法打开')),
      });
    });
  }
  if (IMAGE_TYPES.includes(ext) || VIDEO_TYPES.includes(ext)) {
    const type = IMAGE_TYPES.includes(ext) ? 'image' : 'video';
    return new Promise((resolve, reject) => {
      wx.previewMedia({
        sources: [{ url: path, type }],
        success: resolve,
        fail: () => reject(new Error('文件无法打开')),
      });
    });
  }
  // 其他格式无法在小程序内预览，引导转发到聊天
  const { confirm } = await showModal({
    title: '无法直接打开',
    content: `小程序暂不支持预览 .${ext || '未知'} 格式，可以转发到微信聊天后用其他应用打开。`,
    confirmText: '转发',
  });
  if (confirm) await shareFile(path, m.fileName);
}

// 下载后转发到微信聊天（例如发给客户）
async function shareMaterial(m) {
  wx.showLoading({ title: '准备文件', mask: true });
  let path;
  try {
    path = await downloadMaterial(m);
  } finally {
    wx.hideLoading();
  }
  // shareFileMessage 需要由用户点击触发，下载完成后用弹窗确认一次
  const { confirm } = await showModal({
    title: '文件已准备好',
    content: m.fileName,
    confirmText: '转发',
  });
  if (confirm) await shareFile(path, m.fileName);
}

function shareFile(filePath, fileName) {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName,
      success: resolve,
      fail(err) {
        if (err && /cancel/.test(err.errMsg)) resolve();
        else reject(new Error('转发失败'));
      },
    });
  });
}

function showModal(opts) {
  return new Promise((resolve) => {
    wx.showModal(Object.assign({}, opts, { success: resolve, fail: () => resolve({ confirm: false }) }));
  });
}

// 请求订阅“资料更新提醒”。必须在用户点击事件中同步调用。
function requestSubscribe(templateId) {
  return new Promise((resolve) => {
    if (!templateId) return resolve(false);
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success(res) {
        if (res[templateId] !== 'accept') return resolve(false);
        request('/wx/subscribe', { method: 'POST', data: { count: 1 } })
          .then(() => resolve(true))
          .catch(() => resolve(false));
      },
      fail: () => resolve(false),
    });
  });
}

function toastError(err) {
  wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none', duration: 2500 });
}

module.exports = {
  getToken,
  getUser,
  setSession,
  clearSession,
  goLogin,
  request,
  wxLoginCode,
  decorate,
  openMaterial,
  shareMaterial,
  requestSubscribe,
  showModal,
  toastError,
};
