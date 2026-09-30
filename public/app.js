'use strict';
/* 销售资料库 前端（无需构建，原生 JS） */

const state = {
  user: null,
  categories: [],
  brands: [],
  materials: [],
  users: [],
  filter: { brandId: '', category: '', q: '', onlyUnread: false },
  adminTab: 'materials',
  live: false,
};
let eventSource = null;

// ---------- 工具函数 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const categoryName = (code) => state.categories.find((c) => c.code === code)?.name ?? code;
const fileExt = (name) => (name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE');

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, { method = 'GET', json, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (json) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
  }
  const res = await fetch(`api${path}`, opts);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/login') {
    logoutLocal();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

// 带进度的上传（fetch 不支持上传进度）
function uploadWithProgress(method, path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `api${path}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.send(form);
  });
}

// ---------- 弹窗 ----------
function openModal({ title, body, submitText = '保存', onSubmit, wide = false, noFooter = false }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <form class="modal" ${wide ? 'style="max-width:760px"' : ''} novalidate>
      <header>${esc(title)}<button type="button" data-close aria-label="关闭">×</button></header>
      <div class="content">${body}<div class="error" data-error></div></div>
      ${noFooter ? '' : `<footer>
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">${esc(submitText)}</button>
      </footer>`}
    </form>`;
  const form = $('form', bg);
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => {
    if (e.target === bg || e.target.closest('[data-close]')) close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = $('button[type=submit]', form);
    const err = $('[data-error]', form);
    btn.disabled = true;
    err.textContent = '';
    try {
      if ((await onSubmit(form)) !== false) close();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
  document.body.appendChild(bg);
  $('input:not([type=hidden]), select, textarea', form)?.focus();
  return { el: form, close };
}

function confirmDialog(message, okText = '确定删除') {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({
      title: '请确认',
      body: `<p style="margin:0">${esc(message)}</p>`,
      submitText: okText,
      onSubmit: () => { ok = true; },
    });
    new MutationObserver((_, obs) => {
      if (!document.body.contains(m.el)) { obs.disconnect(); resolve(ok); }
    }).observe(document.body, { childList: true });
  });
}

// ---------- 登录 / 会话 ----------
function renderLogin() {
  closeEvents();
  $('#app').innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <img src="icon.svg" alt="">
        <h1>销售资料库</h1>
        <p class="sub">产品资料 · 价格 · 培训 · 样本 · 手册，随时获取最新版</p>
        <label class="field"><span>账号</span><input type="text" name="username" autocomplete="username" required></label>
        <label class="field"><span>密码</span><input type="password" name="password" autocomplete="current-password" required></label>
        <div class="error" id="login-error"></div>
        <button class="btn primary block" type="submit">登 录</button>
        <div id="install-slot" style="margin-top:16px"></div>
      </form>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user } = await api('/login', {
        method: 'POST',
        json: { username: f.username.value.trim(), password: f.password.value },
      });
      state.user = user;
      await start();
    } catch (ex) {
      $('#login-error').textContent = ex.message;
    }
  });
  fillInstallSlot();
  if (!isMobile) $('input[name=username]').focus();
}

function logoutLocal() {
  state.user = null;
  renderLogin();
}

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
  logoutLocal();
}

function changePasswordDialog() {
  openModal({
    title: '修改密码',
    body: `
      <label class="field"><span>原密码</span><input type="password" name="oldPassword" autocomplete="current-password"></label>
      <label class="field"><span>新密码（至少 6 位）</span><input type="password" name="newPassword" autocomplete="new-password"></label>
      <label class="field"><span>确认新密码</span><input type="password" name="confirm" autocomplete="new-password"></label>`,
    onSubmit: async (f) => {
      if (f.newPassword.value !== f.confirm.value) throw new Error('两次输入的新密码不一致');
      await api('/me/password', { method: 'POST', json: { oldPassword: f.oldPassword.value, newPassword: f.newPassword.value } });
      toast('密码已修改', 'success');
    },
  });
}

// ---------- 实时推送 ----------
function openEvents() {
  closeEvents();
  eventSource = new EventSource('api/events');
  eventSource.onopen = () => setLive(true);
  eventSource.onerror = () => setLive(false);
  eventSource.addEventListener('material', async (e) => {
    const { action, material } = JSON.parse(e.data);
    if (state.user.role === 'sales' && material) {
      const verb = { created: '发布了新资料', new_version: '更新了资料', updated: '修改了资料' }[action] || '更新了资料';
      toast(`市场部${verb}：【${material.brandName}】${material.title}`);
      notifyDevice(`市场部${verb}`, `【${material.brandName}】${material.title}`);
    }
    await refresh();
  });
  eventSource.addEventListener('brands', async () => {
    if (state.user.role === 'sales') toast('你负责的品牌已调整');
    await refresh();
  });
}

function closeEvents() {
  eventSource?.close();
  eventSource = null;
}

function setLive(on) {
  state.live = on;
  const dot = $('#live-dot');
  if (dot) {
    dot.classList.toggle('on', on);
    dot.title = on ? '实时同步中' : '连接中断，正在重连…';
  }
}

function notifyDevice(title, body) {
  if (document.visibilityState === 'visible') return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon.svg' }); } catch { /* 部分移动端不支持 */ }
  }
}

// ---------- 页面骨架 ----------
function shell(inner) {
  const u = state.user;
  return `
    <div class="topbar">
      <span class="live-dot ${state.live ? 'on' : ''}" id="live-dot" title="实时同步"></span>
      <div class="title">销售资料库${u.role === 'admin' ? ' · 管理后台' : ''}</div>
      <span class="user">${esc(u.displayName)}</span>
      <button type="button" data-action="password">改密码</button>
      <button type="button" data-action="logout">退出</button>
    </div>
    <main>${inner}</main>`;
}

function bindShell() {
  $('[data-action=logout]').onclick = logout;
  $('[data-action=password]').onclick = changePasswordDialog;
}

async function start() {
  state.categories = await api('/categories');
  if ('Notification' in window && Notification.permission === 'default' && state.user.role === 'sales') {
    // 仅在用户交互后请求通知权限（部分浏览器要求）
    document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
  }
  openEvents();
  await refresh();
}

async function refresh() {
  if (!state.user) return;
  if (state.user.role === 'admin') await refreshAdmin();
  else await refreshSales();
}

function materialQuery() {
  const p = new URLSearchParams();
  const f = state.filter;
  if (f.brandId) p.set('brandId', f.brandId);
  if (f.category) p.set('category', f.category);
  if (f.q) p.set('q', f.q);
  return p.toString() ? `?${p}` : '';
}

// ======================================================================
// 销售员端
// ======================================================================
async function refreshSales() {
  const [brands, materials, stats] = await Promise.all([
    api('/brands'),
    api(`/materials${materialQuery()}`),
    api('/stats'),
  ]);
  state.brands = brands;
  if (state.filter.brandId && !brands.some((b) => String(b.id) === state.filter.brandId)) {
    state.filter.brandId = '';
    return refreshSales();
  }
  state.materials = materials;
  state.stats = stats;
  renderSales();
}

function materialCard(m, { admin = false } = {}) {
  const badge =
    m.status === 'new' ? '<span class="badge new">新</span>' :
    m.status === 'updated' ? '<span class="badge updated">已更新</span>' : '';
  const actions = admin
    ? `<button class="btn small" data-act="preview" data-id="${m.id}">预览</button>
       <button class="btn small" data-act="edit" data-id="${m.id}">编辑 / 更新文件</button>
       <button class="btn small" data-act="history" data-id="${m.id}">历史版本</button>
       <button class="btn small danger" data-act="delete" data-id="${m.id}">删除</button>`
    : `<button class="btn small primary" data-act="preview" data-id="${m.id}">在线查看</button>
       <button class="btn small" data-act="download" data-id="${m.id}">下载</button>`;
  return `
    <div class="item">
      <div class="icon cat-${esc(m.category)}">${esc(fileExt(m.fileName))}</div>
      <div class="body">
        <div class="t">${esc(m.title)}${badge}</div>
        <div class="meta">
          <span>${esc(m.brandName)}</span>
          <span>${esc(categoryName(m.category))}</span>
          <span>V${m.version}</span>
          <span>${esc(formatSize(m.fileSize))}</span>
          <span>更新于 ${esc(formatTime(m.updatedAt))}</span>
        </div>
        ${m.description ? `<div class="desc">${esc(m.description)}</div>` : ''}
        <div class="meta" style="margin-top:4px">📎 ${esc(m.fileName)}</div>
        <div class="actions">${actions}</div>
      </div>
    </div>`;
}

function filterBar({ showBrands = true } = {}) {
  const f = state.filter;
  const brandChips = showBrands
    ? `<div class="chips" data-filter="brandId">
        <button class="chip ${!f.brandId ? 'active' : ''}" data-value="">全部品牌</button>
        ${state.brands.map((b) => `<button class="chip ${f.brandId === String(b.id) ? 'active' : ''}" data-value="${b.id}">${esc(b.name)}<span class="count">${b.materialCount}</span></button>`).join('')}
      </div>`
    : '';
  return `
    ${brandChips}
    <div class="chips" data-filter="category">
      <button class="chip ${!f.category ? 'active' : ''}" data-value="">全部分类</button>
      ${state.categories.map((c) => `<button class="chip ${f.category === c.code ? 'active' : ''}" data-value="${c.code}">${esc(c.name)}</button>`).join('')}
    </div>`;
}

function bindFilters(root, rerender) {
  root.querySelectorAll('[data-filter]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter[group.dataset.filter] = chip.dataset.value;
      rerender();
    });
  });
  const search = $('#search', root);
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.filter.q = search.value.trim();
        rerender().then(() => {
          const s = $('#search');
          s.focus();
          s.setSelectionRange(s.value.length, s.value.length);
        });
      }, 300);
    });
  }
}

function renderSales() {
  const f = state.filter;
  let list = state.materials;
  if (f.onlyUnread) list = list.filter((m) => m.status !== 'read');
  const noBrands = state.brands.length === 0;
  const unread = state.stats?.unread || 0;

  $('#app').innerHTML = shell(`
    <div id="install-slot"></div>
    ${unread ? `<div class="banner">🔔 有 <b>${unread}</b> 份资料是新发布或刚更新的
      <button class="btn small" id="toggle-unread">${f.onlyUnread ? '显示全部' : '只看未读'}</button></div>` : ''}
    ${noBrands ? '' : filterBar()}
    ${noBrands ? '' : `<div class="toolbar"><input type="search" id="search" class="grow" placeholder="搜索资料标题、说明、文件名" value="${esc(f.q)}"></div>`}
    <div class="list">
      ${noBrands
        ? '<div class="empty">你还没有被分配负责的品牌，请联系市场部管理员。</div>'
        : list.length
          ? list.map((m) => materialCard(m)).join('')
          : '<div class="empty">没有符合条件的资料</div>'}
    </div>`);
  bindShell();
  fillInstallSlot();
  bindFilters($('#app'), refreshSales);
  const t = $('#toggle-unread');
  if (t) t.onclick = () => { f.onlyUnread = !f.onlyUnread; renderSales(); };
  $('.list').addEventListener('click', onMaterialAction);
}

function fileUrl(id, { inline = false, version } = {}) {
  const p = new URLSearchParams();
  if (inline) p.set('inline', '1');
  if (version) p.set('version', version);
  return `api/materials/${id}/file${p.toString() ? `?${p}` : ''}`;
}

async function onMaterialAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const m = state.materials.find((x) => x.id === id);
  switch (btn.dataset.act) {
    case 'preview':
      window.open(fileUrl(id, { inline: true }), '_blank', 'noopener');
      setTimeout(refresh, 800);
      break;
    case 'download': {
      const a = document.createElement('a');
      a.href = fileUrl(id);
      a.download = m?.fileName || '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(refresh, 800);
      break;
    }
    case 'edit':
      materialDialog(m);
      break;
    case 'history':
      historyDialog(m);
      break;
    case 'delete':
      if (await confirmDialog(`确定删除资料「${m.title}」及其所有历史版本吗？销售员将无法再查看。`)) {
        await api(`/materials/${id}`, { method: 'DELETE' });
        toast('已删除', 'success');
        refresh();
      }
      break;
  }
}

// ======================================================================
// 管理员端
// ======================================================================
async function refreshAdmin() {
  const [brands, stats] = await Promise.all([api('/brands'), api('/stats')]);
  state.brands = brands;
  state.stats = stats;
  if (state.adminTab === 'materials') state.materials = await api(`/materials${materialQuery()}`);
  if (state.adminTab === 'users') state.users = await api('/users');
  renderAdmin();
}

function renderAdmin() {
  const s = state.stats || {};
  const tab = state.adminTab;
  const tabs = [
    ['materials', '资料管理'],
    ['brands', '品牌管理'],
    ['users', '销售员管理'],
  ];
  let inner = '';
  if (tab === 'materials') inner = adminMaterialsHtml();
  if (tab === 'brands') inner = adminBrandsHtml();
  if (tab === 'users') inner = adminUsersHtml();

  $('#app').innerHTML = shell(`
    <div class="stats">
      <div class="stat"><div class="num">${s.brands ?? 0}</div><div class="label">品牌</div></div>
      <div class="stat"><div class="num">${s.materials ?? 0}</div><div class="label">资料</div></div>
      <div class="stat"><div class="num">${s.sales ?? 0}</div><div class="label">在职销售员</div></div>
    </div>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${n}</button>`).join('')}</div>
    <div id="panel">${inner}</div>`);
  bindShell();
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.adminTab = b.dataset.tab; refreshAdmin(); };
  });
  if (tab === 'materials') bindAdminMaterials();
  if (tab === 'brands') bindAdminBrands();
  if (tab === 'users') bindAdminUsers();
}

// ----- 资料管理 -----
function adminMaterialsHtml() {
  const f = state.filter;
  return `
    ${filterBar()}
    <div class="toolbar">
      <input type="search" id="search" class="grow" placeholder="搜索资料" value="${esc(f.q)}">
      <button class="btn primary" id="add-material" ${state.brands.length ? '' : 'disabled title="请先创建品牌"'}>＋ 上传资料</button>
    </div>
    <div class="list">
      ${state.brands.length === 0
        ? '<div class="empty">还没有品牌，请先到「品牌管理」中创建品牌。</div>'
        : state.materials.length
          ? state.materials.map((m) => materialCard(m, { admin: true })).join('')
          : '<div class="empty">暂无资料，点击「上传资料」发布第一份资料。</div>'}
    </div>`;
}

function bindAdminMaterials() {
  bindFilters($('#panel'), refreshAdmin);
  $('#add-material').onclick = () => materialDialog(null);
  $('.list').addEventListener('click', onMaterialAction);
}

function materialDialog(m) {
  const isNew = !m;
  const defBrand = m?.brandId ?? (Number(state.filter.brandId) || state.brands[0]?.id);
  const defCat = m?.category ?? (state.filter.category || state.categories[0].code);
  const dlg = openModal({
    title: isNew ? '上传新资料' : `编辑资料：${m.title}`,
    submitText: isNew ? '发布' : '保存',
    body: `
      <label class="field"><span>品牌</span>
        <select name="brandId">${state.brands.map((b) => `<option value="${b.id}" ${b.id === defBrand ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>分类</span>
        <select name="category">${state.categories.map((c) => `<option value="${c.code}" ${c.code === defCat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>标题</span><input type="text" name="title" maxlength="200" value="${esc(m?.title)}" placeholder="例如：2026 年 Q4 经销商价格表"></label>
      <label class="field"><span>说明（可选）</span><textarea name="description" maxlength="2000" placeholder="适用范围、有效期、注意事项等">${esc(m?.description)}</textarea></label>
      <label class="field"><span>${isNew ? '文件' : `替换文件（可选，当前 V${m.version}：${esc(m.fileName)}）`}</span>
        <input type="file" name="file">
        ${isNew ? '' : '<div class="hint">上传新文件后版本号 +1，销售员会收到“已更新”提醒，并且只能下载到最新版本。</div>'}
      </label>
      <label class="field"><span>版本说明（可选）</span><input type="text" name="note" maxlength="500" placeholder="例如：价格调整、新增型号"></label>
      <div class="progress" hidden><div></div></div>`,
    onSubmit: async (f) => {
      const form = new FormData();
      for (const k of ['brandId', 'category', 'title', 'description', 'note']) form.append(k, f[k].value);
      const file = f.file.files[0];
      if (isNew && !file) throw new Error('请选择要上传的文件');
      if (!f.title.value.trim()) throw new Error('请填写标题');
      if (file) form.append('file', file);
      const bar = $('.progress', f);
      bar.hidden = !file;
      await uploadWithProgress(isNew ? 'POST' : 'PUT', isNew ? '/materials' : `/materials/${m.id}`, form, (p) => {
        $('div', bar).style.width = `${Math.round(p * 100)}%`;
      });
      toast(isNew ? '资料已发布，销售员将实时收到' : '资料已更新', 'success');
      refresh();
    },
  });
  // 新建时自动用文件名填充标题
  const fileInput = $('input[name=file]', dlg.el);
  fileInput.addEventListener('change', () => {
    const t = $('input[name=title]', dlg.el);
    const file = fileInput.files[0];
    if (file && !t.value.trim()) t.value = file.name.replace(/\.[^.]+$/, '');
  });
}

async function historyDialog(m) {
  const versions = await api(`/materials/${m.id}/versions`);
  openModal({
    title: `历史版本：${m.title}`,
    wide: true,
    noFooter: true,
    body: `
      <div class="table-wrap"><table>
        <thead><tr><th>版本</th><th>文件</th><th>说明</th><th>上传人</th><th>时间</th><th></th></tr></thead>
        <tbody>${versions.map((v) => `
          <tr>
            <td>V${v.version}${v.version === m.version ? '<span class="badge muted">当前</span>' : ''}</td>
            <td>${esc(v.fileName)}<div class="hint">${esc(formatSize(v.fileSize))}</div></td>
            <td>${esc(v.note)}</td>
            <td>${esc(v.uploader ?? '-')}</td>
            <td style="white-space:nowrap">${esc(formatTime(v.createdAt))}</td>
            <td><a class="btn small" href="${fileUrl(m.id, { version: v.version })}" download>下载</a></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`,
  });
}

// ----- 品牌管理 -----
function adminBrandsHtml() {
  return `
    <div class="toolbar"><div class="grow"></div><button class="btn primary" id="add-brand">＋ 新建品牌</button></div>
    ${state.brands.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>品牌</th><th>说明</th><th>资料数</th><th>操作</th></tr></thead>
      <tbody>${state.brands.map((b) => `
        <tr>
          <td><b>${esc(b.name)}</b></td>
          <td>${esc(b.description)}</td>
          <td>${b.materialCount}</td>
          <td><div class="actions">
            <button class="btn small" data-act="edit" data-id="${b.id}">编辑</button>
            <button class="btn small danger" data-act="delete" data-id="${b.id}">删除</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>` : '<div class="empty">还没有品牌</div>'}`;
}

function bindAdminBrands() {
  $('#add-brand').onclick = () => brandDialog(null);
  $('#panel').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const b = state.brands.find((x) => x.id === Number(btn.dataset.id));
    if (btn.dataset.act === 'edit') brandDialog(b);
    if (btn.dataset.act === 'delete') {
      const ok = await confirmDialog(`删除品牌「${b.name}」将同时删除其下 ${b.materialCount} 份资料，且无法恢复。确定吗？`);
      if (!ok) return;
      await api(`/brands/${b.id}`, { method: 'DELETE' });
      if (state.filter.brandId === String(b.id)) state.filter.brandId = '';
      toast('品牌已删除', 'success');
      refresh();
    }
  });
}

function brandDialog(b) {
  openModal({
    title: b ? '编辑品牌' : '新建品牌',
    body: `
      <label class="field"><span>品牌名称</span><input type="text" name="name" maxlength="100" value="${esc(b?.name)}"></label>
      <label class="field"><span>说明（可选）</span><textarea name="description" maxlength="1000">${esc(b?.description)}</textarea></label>`,
    onSubmit: async (f) => {
      const json = { name: f.name.value, description: f.description.value };
      await api(b ? `/brands/${b.id}` : '/brands', { method: b ? 'PUT' : 'POST', json });
      toast('已保存', 'success');
      refresh();
    },
  });
}

// ----- 销售员管理 -----
function adminUsersHtml() {
  const brandName = (id) => state.brands.find((b) => b.id === id)?.name ?? '';
  return `
    <div class="toolbar"><div class="grow"></div><button class="btn primary" id="add-user">＋ 新建账号</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>负责品牌</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${state.users.map((u) => `
        <tr>
          <td><b>${esc(u.displayName)}</b></td>
          <td>${esc(u.username)}</td>
          <td>${u.role === 'admin' ? '管理员' : '销售员'}</td>
          <td>${u.role === 'admin' ? '<span class="hint">全部</span>' : u.brandIds.map((id) => esc(brandName(id))).join('、') || '<span class="hint">未分配</span>'}</td>
          <td>${u.active ? '正常' : '<span class="badge inactive">已停用</span>'}</td>
          <td><div class="actions">
            <button class="btn small" data-act="edit" data-id="${u.id}">编辑</button>
            ${u.id === state.user.id ? '' : `<button class="btn small danger" data-act="delete" data-id="${u.id}">删除</button>`}
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function bindAdminUsers() {
  $('#add-user').onclick = () => userDialog(null);
  $('#panel').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const u = state.users.find((x) => x.id === Number(btn.dataset.id));
    if (btn.dataset.act === 'edit') userDialog(u);
    if (btn.dataset.act === 'delete') {
      if (!(await confirmDialog(`确定删除账号「${u.displayName}」吗？如只是离职，建议使用“停用”。`))) return;
      await api(`/users/${u.id}`, { method: 'DELETE' });
      toast('账号已删除', 'success');
      refresh();
    }
  });
}

function userDialog(u) {
  const isNew = !u;
  const isSelf = u?.id === state.user.id;
  const dlg = openModal({
    title: isNew ? '新建账号' : `编辑账号：${u.displayName}`,
    body: `
      <label class="field"><span>姓名</span><input type="text" name="displayName" maxlength="50" value="${esc(u?.displayName)}"></label>
      <label class="field"><span>登录账号</span><input type="text" name="username" maxlength="50" value="${esc(u?.username)}" ${isNew ? '' : 'disabled'} placeholder="字母、数字，如 zhangsan"></label>
      <label class="field"><span>${isNew ? '初始密码（至少 6 位）' : '重置密码（留空则不修改）'}</span><input type="text" name="password" autocomplete="new-password"></label>
      <label class="field"><span>角色</span>
        <select name="role" ${isSelf ? 'disabled' : ''}>
          <option value="sales" ${u?.role !== 'admin' ? 'selected' : ''}>销售员（只能查看负责品牌的资料）</option>
          <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>管理员（市场部，可维护所有资料）</option>
        </select>
      </label>
      <div class="field" data-brands><span>负责品牌</span>
        <div class="checks">${state.brands.map((b) => `<label><input type="checkbox" name="brand" value="${b.id}" ${u?.brandIds.includes(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`).join('') || '<span class="hint">暂无品牌</span>'}</div>
      </div>
      ${isNew || isSelf ? '' : `<label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 账号启用（取消勾选即停用，立即退出登录）</label>`}`,
    onSubmit: async (f) => {
      const json = {
        displayName: f.displayName.value,
        brandIds: [...f.querySelectorAll('input[name=brand]:checked')].map((c) => Number(c.value)),
      };
      if (!isSelf) json.role = f.role.value;
      if (f.password.value) json.password = f.password.value;
      if (isNew) {
        json.username = f.username.value.trim();
        await api('/users', { method: 'POST', json });
      } else {
        if (f.active) json.active = f.active.checked;
        await api(`/users/${u.id}`, { method: 'PUT', json });
      }
      toast('已保存', 'success');
      refresh();
    },
  });
  const syncBrands = () => { $('[data-brands]', dlg.el).hidden = $('select[name=role]', dlg.el).value === 'admin'; };
  $('select[name=role]', dlg.el).addEventListener('change', syncBrands);
  syncBrands();
}

// ---------- 启动 ----------
window.addEventListener('unhandledrejection', (e) => {
  toast(e.reason?.message || '操作失败', 'error');
});

// ---------- 安装到手机桌面（PWA，苹果和安卓通用） ----------
const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isWeChat = /MicroMessenger/i.test(ua);
const isMobile = isIOS || /Android|Mobile/i.test(ua);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const INSTALL_DISMISS_KEY = 'sl_install_dismissed_at';
let installPrompt = null;

function installHint() {
  if (!isMobile || isStandalone()) return null;
  if (isWeChat) {
    return { text: '微信里无法安装。请点右上角「···」→「在浏览器中打开」，再添加到手机桌面。' };
  }
  if (isIOS) {
    return { text: '安装到 iPhone 桌面：用 Safari 打开本页，点底部「分享」按钮（方框加向上箭头）→「添加到主屏幕」。' };
  }
  if (installPrompt) return { text: '把销售资料库安装到手机桌面，像 App 一样一键打开。', button: '安装' };
  return { text: '安装到手机桌面：点浏览器菜单（「⋮」或「≡」）→「添加到主屏幕」或「添加到桌面」。' };
}

function installDismissed() {
  try {
    return Date.now() - Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0) < 7 * 86400_000;
  } catch {
    return false;
  }
}

function fillInstallSlot() {
  const slot = $('#install-slot');
  if (!slot) return;
  const hint = installDismissed() ? null : installHint();
  slot.innerHTML = hint
    ? `<div class="banner install">📲 <span>${esc(hint.text)}</span>
        ${hint.button ? `<button type="button" class="btn small primary" data-install>${esc(hint.button)}</button>` : ''}
        <button type="button" class="btn small" data-install-close aria-label="不再提示">×</button></div>`
    : '';
  const btn = $('[data-install]', slot);
  if (btn) {
    btn.onclick = async () => {
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => {});
      installPrompt = null;
      fillInstallSlot();
    };
  }
  const close = $('[data-install-close]', slot);
  if (close) {
    close.onclick = () => {
      try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
      slot.innerHTML = '';
    };
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  fillInstallSlot();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  fillInstallSlot();
  toast('已安装到手机桌面', 'success');
});

// Service Worker 需要 HTTPS（本机调试的 localhost 除外）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function renderOffline() {
  closeEvents();
  $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card" style="text-align:center">
      <img src="icon.svg" alt="">
      <h1>网络不可用</h1>
      <p class="sub">请检查手机网络后重试。资料需要联网获取，以保证始终是最新版本。</p>
      <button class="btn primary block" type="button" onclick="location.reload()">重 试</button>
    </div></div>`;
}

(async function boot() {
  try {
    state.user = await api('/me');
    await start();
  } catch (err) {
    // fetch 本身失败（TypeError）说明没有网络，而不是未登录
    if (err instanceof TypeError) renderOffline();
    else renderLogin();
  }
})();
