const api = require('../../utils/api');

const app = getApp();

Page({
  data: {
    user: {},
    initial: '',
    brands: [],
    wxEnabled: false,
    templateId: '',
    bound: false,
    quota: 0,
    showPwd: false,
    oldPassword: '',
    newPassword: '',
    confirm: '',
  },

  async onShow() {
    if (!(await app.ensureLogin())) return;
    const { enabled, templateId } = app.globalData.wx;
    this.setData({ wxEnabled: enabled, templateId });
    try {
      const [user, brands] = await Promise.all([api.request('/me'), api.request('/brands')]);
      this.setData({ user, brands, initial: (user.displayName || '?').slice(0, 1) });
      if (enabled) {
        const s = await api.request('/wx/status');
        this.setData({ bound: s.bound, quota: s.quota });
      }
    } catch (err) {
      api.toastError(err);
    }
  },

  subscribe() {
    api.requestSubscribe(this.data.templateId).then(async (ok) => {
      if (!ok) return;
      wx.showToast({ title: '已开启提醒', icon: 'success' });
      const s = await api.request('/wx/status');
      this.setData({ quota: s.quota });
    });
  },

  togglePwd() {
    this.setData({ showPwd: !this.data.showPwd });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async changePassword() {
    const { oldPassword, newPassword, confirm } = this.data;
    if (newPassword !== confirm) return api.toastError(new Error('两次输入的新密码不一致'));
    try {
      await api.request('/me/password', { method: 'POST', data: { oldPassword, newPassword } });
      this.setData({ showPwd: false, oldPassword: '', newPassword: '', confirm: '' });
      wx.showToast({ title: '密码已修改', icon: 'success' });
    } catch (err) {
      api.toastError(err);
    }
  },

  async logout() {
    const { confirm } = await api.showModal({ title: '退出登录', content: '确定退出吗？退出后本微信将不再自动登录。' });
    if (!confirm) return;
    try {
      if (this.data.bound) await api.request('/wx/unbind', { method: 'POST' });
      await api.request('/logout', { method: 'POST' });
    } catch (err) {
      // 忽略，照常清除本地登录状态
    }
    api.goLogin();
  },
});
