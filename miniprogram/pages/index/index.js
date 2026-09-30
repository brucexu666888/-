const api = require('../../utils/api');

const app = getApp();
const POLL_MS = 30000;

Page({
  data: {
    brands: [],
    categories: [],
    brandId: '',
    category: '',
    q: '',
    list: [],
    shown: [],
    unread: 0,
    onlyUnread: false,
    noBrands: false,
    loading: true,
    showSubscribeTip: false,
  },

  async onShow() {
    if (!(await app.ensureLogin())) return;
    await this.load();
    this.refreshSubscribeTip();
    // 前台时定时刷新，保证看到的始终是最新资料
    clearInterval(this.timer);
    this.timer = setInterval(() => this.load({ silent: true }), POLL_MS);
  },

  onHide() {
    clearInterval(this.timer);
  },

  onUnload() {
    clearInterval(this.timer);
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load({ silent = false } = {}) {
    try {
      const categories = await app.categories();
      const query = [];
      if (this.data.brandId) query.push(`brandId=${this.data.brandId}`);
      if (this.data.category) query.push(`category=${this.data.category}`);
      if (this.data.q) query.push(`q=${encodeURIComponent(this.data.q)}`);
      const [brands, list, stats] = await Promise.all([
        api.request('/brands'),
        api.request(`/materials${query.length ? `?${query.join('&')}` : ''}`),
        api.request('/stats'),
      ]);
      // 负责品牌被取消后重置筛选
      if (this.data.brandId && !brands.some((b) => String(b.id) === this.data.brandId)) {
        this.setData({ brandId: '' });
        return this.load({ silent });
      }
      const unread = stats.unread || 0;
      this.setData({
        categories,
        brands: brands.map((b) => Object.assign({}, b, { idStr: String(b.id) })),
        list: list.map((m) => api.decorate(m, categories)),
        unread,
        onlyUnread: unread ? this.data.onlyUnread : false,
        noBrands: brands.length === 0,
        loading: false,
      });
      this.applyFilter();
      if (unread) wx.setTabBarBadge({ index: 0, text: unread > 99 ? '99+' : String(unread) });
      else wx.removeTabBarBadge({ index: 0 });
    } catch (err) {
      this.setData({ loading: false });
      if (!silent) api.toastError(err);
    }
  },

  applyFilter() {
    const { list, onlyUnread } = this.data;
    this.setData({ shown: onlyUnread ? list.filter((m) => m.status !== 'read') : list });
  },

  async refreshSubscribeTip() {
    const { enabled, templateId } = app.globalData.wx;
    if (!enabled || !templateId) return;
    try {
      const s = await api.request('/wx/status');
      this.setData({ showSubscribeTip: s.bound && s.quota === 0 });
    } catch (err) {
      // 忽略
    }
  },

  subscribe() {
    api.requestSubscribe(app.globalData.wx.templateId).then((ok) => {
      if (ok) {
        wx.showToast({ title: '已开启提醒', icon: 'success' });
        this.setData({ showSubscribeTip: false });
      }
    });
  },

  pickBrand(e) {
    this.setData({ brandId: e.currentTarget.dataset.value });
    this.load();
  },

  pickCategory(e) {
    this.setData({ category: e.currentTarget.dataset.value });
    this.load();
  },

  onSearchInput(e) {
    clearTimeout(this.searchTimer);
    const q = e.detail.value.trim();
    this.searchTimer = setTimeout(() => {
      this.setData({ q });
      this.load();
    }, 400);
  },

  onSearchConfirm(e) {
    clearTimeout(this.searchTimer);
    this.setData({ q: e.detail.value.trim() });
    this.load();
  },

  toggleUnread() {
    this.setData({ onlyUnread: !this.data.onlyUnread });
    this.applyFilter();
  },

  openDetail(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
