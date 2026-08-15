/* Kalends 前端 · pages.js —— 页面级交互：主导航切页、模块开关裁剪、切表、表内搜索、
   滚动与缩放的收尾，以及 boot() 启动。加载方式与作用域约定见 core.js 头注。 */

/* ── 页面级交互 ── */
document.querySelectorAll('.nav-tab[data-page]').forEach(b => b.onclick = () => {
  state.page = b.dataset.page;
  closePop();
  clearAllSel(); // 选区跟着看得见的那张表走，换页就散掉，免得批量删到看不见的表里
  document.querySelectorAll('.nav-tab[data-page]').forEach(x => {
    x.classList.toggle('on', x === b);
    // 当前页要让读屏听得出来。**不认领 role=tab**：那承诺方向键能在标签间移动，
    // 而我们没有那套键盘模型——半套 tablist 比不做更糟
    if (x === b) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
  });
  $('#page-renewals').hidden = state.page !== 'renewals';
  $('#page-media').hidden = state.page !== 'media';
  applyWidths(state.page === 'media' ? 'media' : state.tab); // 隐藏页里量不到自然宽，可见了补排
});

// 模块开关：只装其一时隐藏导航、落到对应页
(function initModules() {
  const hasR = MODULES.includes('renewals');
  const hasM = MODULES.includes('media');
  const tabR = document.querySelector('.nav-tab[data-page="renewals"]');
  const tabM = document.querySelector('.nav-tab[data-page="media"]');
  tabR.hidden = !hasR;
  tabM.hidden = !hasM;
  if (!hasR && hasM) {
    state.page = 'media';
    tabR.classList.remove('on');
    tabM.classList.add('on');
    $('#page-renewals').hidden = true;
    $('#page-media').hidden = false;
  }
  if (!(hasR && hasM)) document.querySelector('.nav').hidden = true;
  // 首屏也要标一次「当前页」——上面那两个 classList 只改了视觉
  document.querySelector('.nav-tab.on')?.setAttribute('aria-current', 'page');
})();

$('#btn-settings').onclick = openSettings;
// 切表：视图容器由库决定，不再逐个写死
function switchTab(key) {
  state.tab = key;
  closePop();
  clearAllSel(); // 同上：选区不跨表带走
  $('#t-search').value = views[key]?.q || '';
  document.querySelectorAll('.tab[data-tab]').forEach(x => {
    const on = x.dataset.tab === key;
    x.classList.toggle('on', on);
    if (on) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tablewrap[data-tab]').forEach(w => { w.hidden = w.dataset.tab !== key; });
  applyWidths(key); // 隐藏页里量不到自然宽，可见了补排
  renderViewPills(key); // 共用的胶囊行切到当前表
}
function bindTabs() {
  document.querySelectorAll('.tab[data-tab]').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
}
bindTabs();
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

let tSearchTimer;
$('#t-search').addEventListener('input', e => {
  clearTimeout(tSearchTimer);
  tSearchTimer = setTimeout(() => {
    if (!views[state.tab]) return; // 一个库都不剩时没有表可搜
    views[state.tab].q = e.target.value;
    saveViews();
    RENDER[state.tab]();
  }, 180);
});
// 页面或表格滚动时浮层会脱锚，直接收起（浮层内部滚动除外）
window.addEventListener('scroll', e => {
  if (popEl && !popEl.contains(e.target)) closePop();
}, true);
// 窗口尺寸变化：无手动列宽的表要重新装进容器
let refitTimer;
window.addEventListener('resize', () => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => applyWidths(state.page === 'media' ? 'media' : state.tab), 150);
});

$('#up-panel').classList.toggle('folded', state.upFolded);
$('#up-toggle').setAttribute('aria-expanded', String(!state.upFolded));
$('#t-search').value = views[state.tab]?.q || '';
$('#m-sort').value = views.media.sort?.key || 'marked';

async function boot() {
  // 媒体表的表头写在 index.html 里，仍走模板快照 + 自定义列注入那条老路；
  // 各库的表头与 COLS 由 loadAll → syncColls → ensureCollDom 按字段注册表生成。
  THEAD_HTML.media = $(HEAD_SEL.media).rows[0].innerHTML;
  try {
    await refreshFields();
  } catch (e) { toast('字段注册加载失败：' + e.message, true); }
  injectCustomCols('media');
  initHead('media');
  await loadAll();
}

boot().catch(e => toast('加载失败：' + e.message, true));
