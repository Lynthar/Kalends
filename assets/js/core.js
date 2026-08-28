/* Kalends 前端 · core.js —— 工具/全局状态/api/视图偏好/汇率折算/loadAll/首页，必须第一个加载。
   八份文件是普通 <script>、共享同一个全局作用域，按 index.html 里的顺序执行（顺序即依赖）；
   不是也不打算是 ES module（e2e 直调全局函数，零构建步骤也不允许打包器）。加东西放进对应的那份。 */

'use strict';

const $ = s => document.querySelector(s);
const state = {
  overview: null, subs: [], sims: [], vps: [], settings: {}, fields: [], fx: null,
  tab: 'subs',
  upWindow: '30', upFolded: localStorage.getItem('kalends.upfold') === '1',
};

// 各表视图偏好（列排序 / 列筛选 / 表内搜索 / 列类型），存本浏览器
const VIEWS_KEY = 'kalends.views.v1';
const views = { subs: {}, sims: {}, vps: {} };
try { Object.assign(views, JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}')); } catch {}
for (const t of ['subs', 'sims', 'vps']) views[t] = { sort: null, filters: {}, q: '', widths: {}, order: null, hiddenCols: [], types: {}, keys: null, collapsed: [], ...views[t] };
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

function toast(msg, err) {
  const t = $('#toast');
  t.classList.toggle('err', !!err);
  // 先露出来再写文本：hidden 的元素不在无障碍树里，趁藏着改内容 live region 就没人听见
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

/* ── 币种折算只发生在呈现层：原币入账不变，汇率表整份由 /api/fx 下发，
   换算只有这一份实现；通知与 ICS 不走这里（数字要对得上真实账单）。 */
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
  // 汇率拉不到不该拖垮首屏——折算是可选视图，没有汇率就按原币显示并如实说一声
  const noFx = { display: '', rates: {}, live: [], baseline_period: '', source: '' };
  // 先取概览（里面带库清单）与设置，之后才知道有哪些库要拉条目
  [state.overview, state.settings, state.fx] = await Promise.all([
    api('/api/overview'),
    api('/api/settings'),
    api('/api/fx').catch(e => {
      toast('汇率表没取到，费用按原币显示：' + e.message, true);
      return noFx;
    }),
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
  for (const c of colls()) renderColl(c.key);
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
    // 报出下次到期是哪天（renew_from='today' 会把账单日拽走，说出来才看得见）；日期由
    // 后端算，前端不自己算。算不出到期日时后端仍把上次续费日记成今天（给缺日期的条目
    // 补日期的既定路径）——旧日期被覆盖要说出来
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
