/* Kalends 前端 · core.js
   工具与全局状态、api 调用、视图偏好存取、汇率折算、loadAll/renderAll、首页的到期栏与支出栏。它定义的东西后面每一份都在用，必须第一个加载。

   **这些文件是普通 <script>，共享同一个全局作用域，按 index.html 里的顺序执行。**
   不是 ES module，也不打算是：e2e 有十几处靠 `evl('loadAll()')` 这样直接调全局函数，
   换成模块作用域会让整套断言一起报废；而"零构建步骤"这条也不允许引打包器。
   拆分本身是纯搬运——**加东西时放进对应的那份，别又长回一个大文件**。
*/

'use strict';

const $ = s => document.querySelector(s);
const MODULES = window.KALENDS_MODULES || ['renewals', 'media'];
const state = {
  overview: null, subs: [], sims: [], vps: [], settings: {}, media: [], fields: [], fx: null,
  tab: 'subs', page: 'renewals', mKind: '全部', mStatus: '全部', mQ: '',
  upWindow: '30', upFolded: localStorage.getItem('kalends.upfold') === '1',
};

// 各表视图偏好（列排序 / 列筛选 / 表内搜索 / 列类型 / 媒体视图），存本浏览器
const VIEWS_KEY = 'kalends.views.v1';
const views = { subs: {}, sims: {}, vps: {}, media: {} };
try { Object.assign(views, JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}')); } catch {}
for (const t of ['subs', 'sims', 'vps']) views[t] = { sort: null, filters: {}, q: '', widths: {}, order: null, hiddenCols: [], types: {}, keys: null, collapsed: [], ...views[t] };
views.media = { sort: null, filters: {}, view: 'wall', widths: {}, order: null, hiddenCols: [], types: {}, keys: null, ...views.media };
if (views.media.key) { // 旧形态迁移：媒体表早期用 key/dir 而非 sort
  if (!(views.media.key === 'marked' && views.media.dir === -1)) views.media.sort = { key: views.media.key, dir: views.media.dir };
  delete views.media.key;
  delete views.media.dir;
}
function saveViews() {
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch {}
}

const CYCLE_LABEL = {
  weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Semiannual',
  annual: 'Annual', biennial: 'Biennial', triennial: 'Triennial', lifetime: 'Lifetime', days: 'Custom',
};
// 周期下拉的档位与次序（就地编辑器与详情表单共用，'' = 不设周期）。
// 选项的 value 恒为存储键（monthly），显示的才是 CYCLE_LABEL 的文案（Monthly）。
const CYCLE_ORDER = ['', 'monthly', 'annual', 'biennial', 'triennial', 'quarterly', 'semiannual', 'weekly', 'days', 'lifetime'];
const M_KINDS = ['电影', '剧集', '动画', '游戏'];
const M_STATUSES = ['想看', '在看', '看过', '弃'];

function toast(msg, err) {
  const t = $('#toast');
  t.classList.toggle('err', !!err);
  // 先露出来再写文本：hidden 的元素不在无障碍树里，趁它还藏着改内容，
  // live region 的那次变更就没人听见了
  t.hidden = false;
  t.textContent = msg;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, err ? 4200 : 1800);
}

async function api(path, opts = {}, mayAskPin = true) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401 && mayAskPin) {
    const pin = prompt('此 Kalends 设置了访问 PIN，请输入：');
    if (pin != null && pin !== '') {
      document.cookie = `kalends_pin=${pin};path=/;max-age=31536000;SameSite=Lax`;
      return api(path, opts, false);
    }
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (c, p) => (p == null || !c) ? '' : `${c} ${Number(p).toFixed(2)}`;

/* ── 币种折算：只发生在呈现层 ────────────────────────────────────────────
   原币入账那条不变（items.price + items.currency 存的永远是原币），这里只决定
   「显示成什么」。汇率表整份由 /api/fx 下发（内置平均汇率打底、拉到的实时值盖上面），
   所以换算只有前端这一份实现。通知文案与 ICS 不走这里——那是发到外部系统的内容，
   数字要对得上真实账单。 */
const fxCode = c => String(c || '').trim().toUpperCase();
const fxRate = c => state.fx?.rates?.[fxCode(c)];
const fxDisplay = () => state.fx?.display || '';

// 折不出来就给 null（表里没这个币种的报价）——编一个数字比不显示更糟
function fxConv(amount, from, to) {
  if (amount == null || !from || !to) return null;
  const [f, t] = [fxCode(from), fxCode(to)];
  if (f === t) return amount;
  const [a, b] = [fxRate(f), fxRate(t)];
  return a && b ? amount / a * b : null;
}

/// 一笔钱该怎么显示：{main 主行, sub 小字里的原币}。没开折算或折不出来时 sub 为空。
function moneyView(c, p) {
  if (p == null || !c) return { main: '', sub: '' };
  const to = fxDisplay();
  const v = to && fxCode(to) !== fxCode(c) ? fxConv(p, c, to) : null;
  return v == null ? { main: money(c, p), sub: '' } : { main: money(to, v), sub: money(c, p) };
}

// 金额的通用呈现：折算值在主行，原币缩在小字里（没开折算时就只有主行）
function amtHtml(c, p) {
  const { main, sub } = moneyView(c, p);
  if (!main) return '';
  return esc(main) + (sub ? `<span class="orig">${esc(sub)}</span>` : '');
}
// 空名条目（表尾新建的空行还没填）要有个看得见的占位，否则整格空着、⤢ 入口也难找
const nameCell = n => (n ? esc(n) : '<span class="unnamed">未命名</span>');

// 仅放行 http/https，防止 url 字段存入 javascript: 等协议
function safeUrl(u) {
  try {
    const p = new URL(u);
    return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '';
  } catch { return ''; }
}

async function loadAll() {
  const hasR = MODULES.includes('renewals');
  const hasM = MODULES.includes('media');
  // 汇率表属于续费模块（/api/fx 挂在 renewals 路由上）。这一句曾经不看模块开关：
  // media-only 部署下它必然 404，而它就在首屏这一批 Promise.all 里——媒体数据明明取回来了，
  // 整页却渲染不出来，只闪一下错误 toast（实测复现过）。
  // 拉不到也不该拖垮首屏：折算是呈现层的可选视图，没有汇率就按原币显示，并如实说一声。
  const noFx = { display: '', rates: {}, live: [], baseline_period: '', source: '' };
  // 先取概览（里面带库清单）与设置，之后才知道有哪些库要拉条目
  [state.overview, state.settings, state.media, state.fx] = await Promise.all([
    hasR ? api('/api/overview') : { today: '', upcoming: [], undated: [], totals: [], collections: [] },
    api('/api/settings'),
    hasM ? api('/api/media') : [],
    hasR ? api('/api/fx').catch(e => {
      toast('汇率表没取到，费用按原币显示：' + e.message, true);
      return noFx;
    }) : noFx,
  ]);
  const wins = ['7', '14', '30', '60', '90', '180', 'all'];
  state.upWindow = wins.includes(state.settings['ui.upcoming_days'])
    ? state.settings['ui.upcoming_days'] : '30';
  // 表格的列由字段注册表决定，所以每次全量加载都要一并刷新，
  // 否则新建库/加列之后前端还按旧字段集渲染（会渲染出没有名称格的空行）
  try { await refreshFields(); } catch (e) { toast('字段注册加载失败：' + e.message, true); }
  // 所有库（含三个预置库）的条目都走同一条通用端点
  await Promise.all(colls().map(async c => {
    state[c.key] = await api(`/api/collections/${encodeURIComponent(c.key)}/items`);
  }));
  renderAll();
}

function renderAll() {
  renderUpcoming();
  renderTotals();
  syncColls();
  syncMediaCols();
  for (const c of colls()) renderColl(c.key);
  renderMedia();
}

/* ── 即将到期 ── */
// 到期时间线里的 kind 是库键；库名与到期动作说法都由后端随 overview 给下来
const collName = key => (state.overview?.collections || []).find(c => c.key === key)?.name || key;
function renderUpcoming() {
  const { upcoming, today } = state.overview;
  $('#today-note').textContent = `今日 ${today}`;
  $('#up-window').value = state.upWindow;
  const items = state.upWindow === 'all'
    ? upcoming : upcoming.filter(it => it.days_left <= +state.upWindow);
  const ol = $('#up-list');
  ol.innerHTML = '';
  const hiddenN = upcoming.length - items.length;
  const more = $('#up-more');
  more.hidden = hiddenN <= 0;
  // 窗口内空、窗口外还有：只说「更远期还有 N 项」——同屏既说"无账"又说"还有 N 项"读着矛盾
  $('#up-empty').hidden = items.length > 0 || hiddenN > 0;
  if (hiddenN > 0) more.textContent = `▾ 更远期还有 ${hiddenN} 项`;
  items.forEach((it, idx) => {
    const d = it.days_left;
    const cls = d < 0 ? 'd-over' : d <= 3 ? 'd-soon' : d <= 7 ? 'd-week' : 'd-far';
    const daysTxt = d < 0 ? `${-d}<small>天前</small>` : d === 0 ? `今<small>到期</small>` : `${d}<small>天后</small>`;
    // muted＝状态语义关掉了提醒（Ending 到期不续）：还在时间线上，但不该催人
    const meta = [collName(it.kind), it.cycle, it.action, it.muted ? '不提醒' : ''].filter(Boolean).join(' · ');
    const li = document.createElement('li');
    li.className = cls + (it.muted ? ' quiet' : '');
    li.style.setProperty('--i', idx);
    li.innerHTML = `
      <span class="days">${daysTxt}</span>
      <span class="due">${esc(it.due)}</span>
      <span class="what"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(meta)}</div></span>
      <span class="amt">${amtHtml(it.currency, it.price)}</span>
      <button class="btn mini ghost" data-renew="${it.kind}:${it.id}" type="button">已${esc(it.verb || '续费')}</button>`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('[data-renew]').forEach(b => b.onclick = () => doRenew(b.dataset.renew));

  // 该上时间线却算不出到期日的条目。不点名的话它们既不在这张表上、也不进日历、
  // 更不会提醒——你以为在管，其实它从界面上消失了
  const und = state.overview.undated || [];
  const un = $('#up-undated');
  un.hidden = !und.length;
  if (und.length) {
    const names = und.map(x => `${x.name}（缺${x.missing}）`).join('、');
    un.textContent = `⚠ 另有 ${und.length} 项算不出到期日，不会提醒也不进日历：${names}`;
  }

  $('#up-panel').classList.toggle('folded', state.upFolded);
  $('#up-toggle').setAttribute('aria-expanded', String(!state.upFolded));
  const sum = $('#up-summary');
  sum.hidden = !state.upFolded;
  if (state.upFolded) {
    if (!items.length) {
      sum.textContent = '窗口内无到期项';
      sum.classList.remove('hot');
    } else {
      const w = items[0];
      const dt = w.days_left < 0 ? `已逾期 ${-w.days_left} 天`
        : w.days_left === 0 ? '今日到期' : `${w.days_left} 天后`;
      sum.innerHTML = `<b>${items.length}</b> 项 · 最近 ${esc(w.name)} · ${esc(dt)}`;
      sum.classList.toggle('hot', w.days_left <= 3);
    }
  }
}

function toggleUpFold() {
  state.upFolded = !state.upFolded;
  try { localStorage.setItem('kalends.upfold', state.upFolded ? '1' : '0'); } catch {}
  renderUpcoming();
}

async function setUpWindow(v) {
  state.upWindow = v;
  state.settings['ui.upcoming_days'] = v;
  renderUpcoming();
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ 'ui.upcoming_days': v }) });
  } catch (err) { toast(err.message, true); }
}

$('#up-toggle').onclick = toggleUpFold;
$('#up-title').onclick = toggleUpFold;
$('#up-window').onchange = e => setUpWindow(e.target.value);
$('#up-more').onclick = () => setUpWindow('all');

async function doRenew(key) {
  const [kind, id] = key.split(':');
  // 表格里的行未必落在到期窗口内，所以先从本库找，找不到再回退到到期时间线
  const it = (state[kind] || []).find(x => x.id === +id)
    || (state.overview?.upcoming || []).find(u => u.kind === kind && u.id === +id);
  const verb = it?.verb || collOf(kind)?.verb || '续费';
  if (!confirm(`记一笔「${it?.name || ''}」的${verb}？`)) return;
  try {
    const r = await api(`/api/items/${id}/renew`, { method: 'POST', body: '{}' });
    // 报出下次到期是哪天：库设成「从操作当天重新计时」的话账单日会被拽走，说出来才看得见。
    // 日期由后端算（engine::renew_to 那一份），前端自己再算一遍就又是两份会各说各话的实现。
    // 算不出到期日时后端仍然会把「上次续费日」记成今天（这正是该动作的语义，也是给缺日期的
    // 条目补日期的既定路径）——旧日期被覆盖这件事得说出来，不然只看见"算不出"三个字
    const stamped = r?.last_renewed;
    toast(r?.due ? `已记账，下次到期 ${r.due}`
      : stamped ? `已记账，上次${verb}日记作 ${stamped}；这条算不出到期日（没有周期或买断），到期日请手动改`
      : '已记一笔；这条算不出到期日（没有周期或买断），到期日请手动改');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 支出 ── */
function renderTotals() {
  const el = $('#totals');
  // 后端恒按原币分币种给（engine::totals），折算在这里做
  const ts = totalsShown(state.overview.totals);
  el.innerHTML = ts.length ? '' : '<span class="note">暂无在订支出</span>';
  for (const t of ts) {
    const div = document.createElement('div');
    div.className = 'cur';
    div.innerHTML = `<span class="code">${esc(t.currency)}</span>
      <span class="m">${t.monthly.toFixed(2)}<span style="font-size:.7rem">/月</span></span>
      <span class="y">≈ ${t.annual.toFixed(2)} /年</span>`;
    el.appendChild(div);
  }
  $('#totals-hint').textContent = fxDisplay() ? `仅在订项，折算成 ${fxDisplay()}` : '仅在订项，分币种';
  // 总额漏掉的东西一律说出来，别让它看着像"全都算进去了"：
  // ① 开了折算但没有报价的币种；② 该计支出却缺了金额/币种/周期一项的条目（engine 点的名）
  const missed = fxDisplay() ? state.overview.totals.filter(t => fxConv(t.monthly, t.currency, fxDisplay()) == null) : [];
  const gaps = state.overview.uncounted || [];
  const notes = [];
  if (missed.length) notes.push(`${missed.map(t => t.currency).join('、')} 没有汇率，未计入`);
  if (gaps.length) {
    const names = gaps.slice(0, 3).map(g => `${g.name}（缺${g.missing}）`).join('、');
    notes.push(`${gaps.length} 项没算进来：${names}${gaps.length > 3 ? ' 等' : ''}`);
  }
  $('#totals-note').hidden = !notes.length;
  $('#totals-note').textContent = notes.join('；');
}

/// 开了折算就并成一笔，否则原样分币种。折不出来的币种不并入，单独留一行。
function totalsShown(ts) {
  const to = fxDisplay();
  if (!to) return ts;
  let m = 0, has = false;
  const rest = [];
  for (const t of ts) {
    const v = fxConv(t.monthly, t.currency, to);
    if (v == null) rest.push(t);
    else { m += v; has = true; }
  }
  return has ? [{ currency: to, monthly: m, annual: m * 12 }, ...rest] : rest;
}
