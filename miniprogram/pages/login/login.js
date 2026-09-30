const api = require('../../utils/api');

const app = getApp();

Page({
  data: {
    username: '',
    password: '',
    error: '',
    loading: false,
    wxEnabled: false,
  },

  async onLoad() {
    await app.ready;
    // 启动时已通过微信一键登录
    if (api.getToken()) return wx.switchTab({ url: '/pages/index/index' });
    this.setData({ wxEnabled: app.globalData.wx.enabled });
  },

  onUsername(e) {
    this.setData({ username: e.detail.value });
  },

  onPassword(e) {
    this.setData({ password: e.detail.value });
  },

  async submit() {
    const username = this.data.username.trim();
    const { password } = this.data;
    if (!username || !password) return this.setData({ error: '请输入账号和密码' });
    this.setData({ loading: true, error: '' });
    try {
      const data = { username, password };
      if (app.globalData.wx.enabled) data.wxCode = await api.wxLoginCode();
      const { token, user } = await api.request('/login', { method: 'POST', data });
      api.setSession(token, user);
      wx.switchTab({ url: '/pages/index/index' });
    } catch (err) {
      this.setData({ error: err.message });
    } finally {
      this.setData({ loading: false });
    }
  },
});
