/* Kalends 前端 · pages.js —— 页面级交互：切表、表内搜索、滚动与缩放的收尾，
   以及 boot() 启动。加载方式与作用域约定见 core.js 头注。 */

$('#btn-settings').onclick = openSettings;
// 切表：视图容器由库决定，不再逐个写死
function switchTab(key) {
  state.tab = key;
  closePop();
  clearAllSel(); // 选区跟着看得见的那张表走，换表就散掉，免得批量删到看不见的表里
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
  refitTimer = setTimeout(() => applyWidths(state.tab), 150);
});

$('#up-panel').classList.toggle('folded', state.upFolded);
$('#up-toggle').setAttribute('aria-expanded', String(!state.upFolded));
$('#t-search').value = views[state.tab]?.q || '';

async function boot() {
  // 各库的表头与 COLS 由 loadAll → syncColls → ensureCollDom 按字段注册表生成。
  await loadAll();
}

boot().catch(e => toast('加载失败：' + e.message, true));
