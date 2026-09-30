const api = require('../../utils/api');

const app = getApp();
// 订阅额度低于该值时，打开资料时顺带请求订阅提醒
const SUBSCRIBE_BELOW = 3;

Page({
  data: {
    m: null,
    error: '',
    isEntry: false,
  },

  async onLoad(options) {
    this.id = Number(options.id);
    // 从订阅消息直接进入时没有上一页，提供返回列表的入口
    this.setData({ isEntry: getCurrentPages().length === 1 });
    if (!(await app.ensureLogin())) return;
    await this.load();
    this.loadQuota();
  },

  async load() {
    try {
      const categories = await app.categories();
      const m = await api.request(`/materials/${this.id}`);
      this.setData({ m: api.decorate(m, categories), error: '' });
      wx.setNavigationBarTitle({ title: m.title });
    } catch (err) {
      this.setData({ error: err.statusCode === 404 ? '资料不存在、已删除，或不在你负责的品牌范围内' : err.message });
    }
  },

  async loadQuota() {
    const { enabled, templateId } = app.globalData.wx;
    if (!enabled || !templateId) return;
    try {
      const s = await api.request('/wx/status');
      this.canSubscribe = s.bound && s.quota < SUBSCRIBE_BELOW;
    } catch (err) {
      this.canSubscribe = false;
    }
  },

  open() {
    // 订阅请求必须在点击事件中同步发起
    let ready = Promise.resolve();
    if (this.canSubscribe) {
      this.canSubscribe = false;
      ready = api.requestSubscribe(app.globalData.wx.templateId);
    }
    ready
      .then(() => api.openMaterial(this.data.m))
      .then(() => this.load())
      .catch(api.toastError);
  },

  share() {
    api
      .shareMaterial(this.data.m)
      .then(() => this.load())
      .catch(api.toastError);
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    // 仅分享小程序页面，打开者仍需登录且有该品牌权限
    return { title: this.data.m ? this.data.m.title : '销售资料库', path: `/pages/detail/detail?id=${this.id}` };
  },
});
