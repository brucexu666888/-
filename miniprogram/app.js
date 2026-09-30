const api = require('./utils/api');

App({
  globalData: {
    wx: { enabled: false, templateId: '' },
    categories: [],
  },

  onLaunch() {
    // 启动时拉取配置，并在已绑定微信的情况下自动登录
    this.ready = this.init();
  },

  async init() {
    try {
      this.globalData.wx = await api.request('/wx/config');
    } catch (err) {
      // 配置获取失败不影响账号密码登录
    }
    if (!api.getToken() && this.globalData.wx.enabled) {
      const code = await api.wxLoginCode();
      if (code) {
        try {
          const { token, user } = await api.request('/wx/login', { method: 'POST', data: { code } });
          api.setSession(token, user);
        } catch (err) {
          // 未绑定：停留在登录页，用账号密码登录时完成绑定
        }
      }
    }
  },

  async categories() {
    if (!this.globalData.categories.length) {
      this.globalData.categories = await api.request('/categories');
    }
    return this.globalData.categories;
  },

  // 页面进入时调用：等待初始化完成，未登录则跳转登录页
  async ensureLogin() {
    await this.ready;
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return false;
    }
    return true;
  },
});
