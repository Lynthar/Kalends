'use strict';

const $ = s => document.querySelector(s);
const MODULES = window.KALENDS_MODULES || ['renewals', 'media'];
const state = {
  overview: null, subs: [], sims: [], vps: [], settings: {}, media: [], fields: [],
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
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.hidden = false;
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
  // 先取概览（里面带库清单）与设置，之后才知道有哪些库要拉条目
  [state.overview, state.settings, state.media] = await Promise.all([
    hasR ? api('/api/overview') : { today: '', upcoming: [], totals: [], collections: [] },
    api('/api/settings'),
    hasM ? api('/api/media') : [],
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
      <span class="amt">${esc(money(it.currency, it.price))}</span>
      <button class="btn mini ghost" data-renew="${it.kind}:${it.id}" type="button">已${esc(it.verb || '续费')}</button>`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('[data-renew]').forEach(b => b.onclick = () => doRenew(b.dataset.renew));

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
    // 没有周期就推不动日期，别谎报"周期已推进"
    toast(r?.next_renewal || r?.last_renewed ? '已记账，周期已推进' : '已记一笔；该条目没有周期，到期日请手动改');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 支出 ── */
function renderTotals() {
  const el = $('#totals');
  const ts = state.overview.totals;
  el.innerHTML = ts.length ? '' : '<span class="note">暂无在订支出</span>';
  for (const t of ts) {
    const div = document.createElement('div');
    div.className = 'cur';
    div.innerHTML = `<span class="code">${esc(t.currency)}</span>
      <span class="m">${t.monthly.toFixed(2)}<span style="font-size:.7rem">/月</span></span>
      <span class="y">≈ ${t.annual.toFixed(2)} /年</span>`;
    el.appendChild(div);
  }
}

/* ── 表格视图：列排序 / 列筛选 / 表内搜索 ── */
const BLANK = '（空）';
const cmpZh = (a, b) => String(a).localeCompare(String(b), 'zh');
const CYCLE_RANK = { weekly: 7, monthly: 30, quarterly: 91, semiannual: 182, annual: 365, biennial: 730, triennial: 1095, lifetime: 1e9 };
// 周期列按周期长短排序：文案的字母序（Annual < Custom < Monthly）对读者没有意义
const cycleRank = it => it.cycle === 'days' ? (it.cycle_days ?? null) : (CYCLE_RANK[it.cycle] ?? null);
const dayDiff = (a, b) => Math.round((a - b) / 864e5);
const todayDate = () => new Date((state.overview?.today || '1970-01-01') + 'T00:00:00');



const cycleText = it => it.cycle === 'days' ? `Every ${it.cycle_days ?? '?'} days` : (CYCLE_LABEL[it.cycle] || '');

// Notion 式彩色标签：值哈希定色，同值全站同色
function tagHash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 10;
}
const tag = v => v ? `<span class="tag t${tagHash(v)}">${esc(v)}</span>` : '';
const tags = arr => (arr || []).map(tag).join('');
const splitVals = s => String(s).split(/[,，、/]+/).map(x => x.trim()).filter(Boolean);

// 状态词的语义定色（Notion status 式），未列出的词走默认灰底
const ST_CLASS = {
  Active: 'on', 看过: 'on',
  Planned: 'plan', 在看: 'plan',
  Deferred: 'cmp', Ending: 'warn',
};
const stPill = v => v ? `<span class="st${ST_CLASS[v] ? ' ' + ST_CLASS[v] : ''}">${esc(v)}</span>` : '';

/* 字段类型（Notion 式）：每列必属其一，驱动表头图标、排序、筛选操作符与单元格造型。
   勾选列表型（sel/multi/status/star）筛选存已选值数组；操作符型（text/num/date）存 {op, q}。 */
const TYPE_LABEL = { text: '文本', num: '数字', sel: '单选', multi: '多选', status: '状态', date: '日期', star: '星级' };
const LIST_TYPES = ['sel', 'multi', 'status', 'star'];
const CONV_TYPES = ['text', 'sel', 'multi']; // 纯文本值列可在这三种呈现间切换
const colType = (tab, k) => views[tab].types?.[k] || COLS[tab][k].t;

// t：字段类型；conv=1 允许切换呈现类型；ord：勾选列表按词表序（默认按中文序）；
// val：取排序值（str=1 按中文串比较，否则按数值）；fvals：取筛选值列表（无值行归入 BLANK）
const ordVal = (ord, get) => r => { const i = ord.indexOf(get(r)); return i < 0 ? null : i; };
const COLS = {
  media: {
    title: { t: 'text', val: r => r.title, str: 1, fvals: r => [r.title, r.orig_title].filter(Boolean) },
    kind: { t: 'sel', conv: 1, ord: M_KINDS, val: ordVal(M_KINDS, r => r.kind), fvals: r => r.kind ? [r.kind] : [] },
    year: { t: 'num', val: r => r.year },
    rating: { t: 'star', ord: ['1', '2', '3', '4', '5'], val: r => r.rating, fvals: r => r.rating ? [String(r.rating)] : [] },
    douban: { t: 'num', val: r => r.douban_rating },
    status: { t: 'status', ord: M_STATUSES, val: ordVal(M_STATUSES, r => r.status), fvals: r => r.status ? [r.status] : [] },
    marked: { t: 'date', val: r => r.marked_at, str: 1 },
  },
};

// 有效类型感知的筛选值：呈现为多选的文本列按分隔符拆开。
// 真多选列的值本身就是数组，绝不能再拆——否则含 , ， 、 / 的值（如线路「CN2 GIA/9929」）
// 会碎成两个，勾选它自己筛不出自己那行。cellVal 与 multiEditor 早就是按值形态判断的，这里补齐。
function colFvals(tab, k, r) {
  const col = COLS[tab][k];
  const vals = (col.fvals || (() => []))(r);
  return colType(tab, k) === 'multi' && col.t !== 'multi' ? vals.flatMap(splitVals) : vals;
}

// 筛选值形态必须匹配列的有效类型（列表型=数组 / 操作符型={op,q}），换类型或旧版残留时清掉
function filterShapeOk(tab, k, f) {
  if (!COLS[tab][k]) return false;
  const listy = LIST_TYPES.includes(colType(tab, k));
  return Array.isArray(f) ? listy : (!listy && f && typeof f.op === 'string');
}

function sanitizeFilters(tab) {
  const v = views[tab];
  for (const k of Object.keys(v.filters || {})) {
    if (!filterShapeOk(tab, k, v.filters[k])) delete v.filters[k];
  }
}

// 单元格值按有效类型呈现：文本原样 / 单选一枚标签 / 多选拆标签 / 星级星串（conv 列与自定义列共用）
function cellVal(tab, k, v) {
  if (v == null || v === '') return '';
  const t = colType(tab, k);
  if (t === 'multi') return tagsFor(tab, k, Array.isArray(v) ? v : splitVals(v));
  if (t === 'sel') return tagFor(tab, k, v);
  if (t === 'star') return starRow(+v);
  return esc(String(v));
}

/* ── 自定义列（/api/fields，值挂在行的 extra JSON，键 c<id>）── */
const FKEY = f => 'c' + f.id;
const customFields = tab => state.fields
  .filter(f => f.tbl === tab && !f.builtin)
  .sort((a, b) => a.pos - b.pos || a.id - b.id);
const fieldOf = (tab, k) => state.fields.find(f => f.tbl === tab && f.key === k);

// 把自定义列并进 COLS 并在操作列前插 th；rebuildHead 前会先清掉旧的
function injectCustomCols(tab) {
  const cols = COLS[tab];
  for (const k of Object.keys(cols)) if (cols[k].custom) delete cols[k];
  const opsTh = $(HEAD_SEL[tab]).querySelector('th.ops');
  for (const f of customFields(tab)) {
    const k = FKEY(f);
    const cv = r => (r.extra || {})[k];
    const numeric = f.ftype === 'num' || f.ftype === 'star';
    cols[k] = {
      t: f.ftype, custom: f.id,
      conv: CONV_TYPES.includes(f.ftype) ? 1 : 0,
      ord: f.ftype === 'star' ? ['1', '2', '3', '4', '5'] : null,
      str: numeric ? 0 : 1,
      val: numeric ? r => { const v = cv(r); return v == null || v === '' ? null : +v; } : cv,
      fvals: r => { const v = cv(r); return v == null || v === '' ? [] : Array.isArray(v) ? v.map(String) : [String(v)]; },
    };
    const th = document.createElement('th');
    th.dataset.k = k;
    th.textContent = f.name;
    opsTh.before(th);
  }
}

async function refreshFields() {
  state.fields = await api('/api/fields');
  for (const f of state.fields) {
    f.options = (f.options || []).map(o => typeof o === 'string' ? { v: o } : o); // 老形态常规化
  }
}

// 选项定色：字段词表里指定了调色板号就用它，否则按值哈希（同值全站同色的兜底）
const storedOpts = (tab, k) => fieldOf(tab, k)?.options || [];
function tagFor(tab, k, v) {
  const s = String(v);
  const c = storedOpts(tab, k).find(o => o.v === s)?.c;
  return `<span class="tag t${c ?? tagHash(s)}">${esc(s)}</span>`;
}
const tagsFor = (tab, k, arr) => (arr || []).map(v => tagFor(tab, k, v)).join('');

// 加删列后重建表头：回到模板再注入，视图偏好走 initHead 的温和迁移
const THEAD_HTML = {};
async function rebuildHead(tab) {
  // 库的表头由字段注册表生成：先刷字段，再交给 ensureCollDom 重建，不走下面媒体表那条模板路
  const c = collOf(tab);
  if (c) {
    await refreshFields();
    ensureCollDom(c);
    renderColl(tab);
    return;
  }
  const thead = $(HEAD_SEL[tab]);
  thead.rows[0].innerHTML = THEAD_HTML[tab];
  thead.closest('.tablewrap').querySelector('.newrow')?.remove();
  injectCustomCols(tab);
  initHead(tab);
  RENDER[tab]();
}

function customTds(tab, it) {
  let h = '';
  for (const f of customFields(tab)) {
    const k = FKEY(f);
    h += `<td>${cellVal(tab, k, (it.extra || {})[k])}</td>`;
  }
  return h;
}



const filterActive = f => Array.isArray(f)
  ? f.length > 0
  : !!f && (f.op === 'empty' || f.op === 'nonempty' || String(f.q ?? '').trim() !== '');

// 按列有效类型生成筛选谓词；形态不符或未激活返回 null（不过滤）
function filterPred(tab, k, f) {
  if (!filterActive(f) || !filterShapeOk(tab, k, f)) return null;
  if (Array.isArray(f)) {
    return r => {
      const vals = colFvals(tab, k, r);
      return vals.length ? vals.some(x => f.includes(x)) : f.includes(BLANK);
    };
  }
  const t = colType(tab, k);
  const col = COLS[tab][k];
  if (t === 'num') {
    const q = parseFloat(f.q);
    return r => {
      const v = col.val(r);
      if (f.op === 'empty') return v == null || v === '';
      if (f.op === 'nonempty') return v != null && v !== '';
      if (!Number.isFinite(q) || v == null || v === '') return false;
      return { eq: v === q, ne: v !== q, gt: v > q, ge: v >= q, lt: v < q, le: v <= q }[f.op] ?? false;
    };
  }
  if (t === 'date') {
    return r => {
      const v = col.val(r) || '';
      if (f.op === 'empty') return !v;
      if (f.op === 'nonempty') return !!v;
      if (!v) return false;
      return { is: v === f.q, before: v < f.q, after: v > f.q }[f.op] ?? false;
    };
  }
  const q = String(f.q).trim().toLowerCase();
  return r => {
    const s = colFvals(tab, k, r).join(' ');
    if (f.op === 'empty') return !s;
    if (f.op === 'nonempty') return !!s;
    return f.op === 'not' ? !s.toLowerCase().includes(q) : s.toLowerCase().includes(q);
  };
}

function sortRows(tab, rows, s) {
  const col = s && COLS[tab][s.key];
  if (!col || !col.val) return rows;
  return [...rows].sort((ra, rb) => {
    const a = col.val(ra), b = col.val(rb);
    const an = a == null || a === '', bn = b == null || b === '';
    if (an || bn) return an - bn; // 空值恒沉底，不随方向翻转
    return s.dir * (col.str ? cmpZh(a, b) : a - b);
  });
}

function applyView(tab, rows) {
  const v = views[tab];
  for (const [k, f] of Object.entries(v.filters)) {
    const pred = filterPred(tab, k, f);
    if (pred) rows = rows.filter(pred);
  }
  const q = (v.q || '').trim().toLowerCase();
  if (q && SEARCH_FIELDS[tab]) rows = rows.filter(r => SEARCH_FIELDS[tab](r).some(x => x && String(x).toLowerCase().includes(q)));
  return sortRows(tab, rows, v.sort);
}

function setEmpty(sel, shown, base) {
  const el = $(sel);
  el.hidden = shown > 0;
  el.textContent = base > 0 ? '无匹配项，试试清除筛选' : '此栏尚无记录';
}

// 表内搜索取哪些字段：库的由 ensureCollDom 按字段集注册；媒体走自己的搜索框
const SEARCH_FIELDS = {};
const RENDER = { media: renderMedia };   // 库的渲染器由 ensureCollDom 注册
const HEAD_SEL = { media: '#m-tablewrap thead' };   // 库的表头选择器由 ensureCollDom 注册
const M_DIR_DEFAULT = { marked: -1, year: -1, rating: -1, douban: -1, title: 1 };

// dir: 1 升 / -1 降 / null 清除（媒体表的默认序 标记日期↓ 视同无排序）
function setSort(tab, k, dir) {
  const isDefault = dir == null || (tab === 'media' && k === 'marked' && dir === -1);
  views[tab].sort = isDefault ? null : { key: k, dir };
  if (tab === 'media') $('#m-sort').value = views.media.sort?.key || 'marked';
  saveViews();
  RENDER[tab]();
}

function colLabel(tab, k) {
  const th = $(HEAD_SEL[tab]).querySelector(`th[data-k="${k}"]`);
  return th ? th.dataset.label : k;
}

const FUNNEL_SVG = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1.4 1.6h9.2L7.4 5.9v3.4l-2.8 1.1V5.9L1.4 1.6Z"/></svg>';

// 表头属性类型图标（Notion 式：Aa 文本 / # 数字 / ⊙ 单选 / ≔ 多选 / ◐ 状态 / 日历 / 星）
const TYPE_ICON = {
  status: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6" opacity=".35"/><path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"/></svg>',
  text: '<svg viewBox="0 0 16 16"><text x="1.2" y="12" font-size="11" font-weight="600" fill="currentColor">Aa</text></svg>',
  num: '<svg viewBox="0 0 16 16"><text x="4" y="12.6" font-size="12.5" font-weight="600" fill="currentColor">#</text></svg>',
  sel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M5.6 7l2.4 2.4L10.4 7"/></svg>',
  multi: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.4" cy="4" r=".95" fill="currentColor" stroke="none"/><circle cx="2.4" cy="8" r=".95" fill="currentColor" stroke="none"/><circle cx="2.4" cy="12" r=".95" fill="currentColor" stroke="none"/></svg>',
  date: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.6"/><path d="M2.5 6.8h11M5.6 2v2.6M10.4 2v2.6"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z"/></svg>',
};

// 各表列键的模板序快照（tbody 渲染恒为模板序，td 定位靠它；列序重排只动 thead/td 的 DOM 序）
const TKEYS = {};
const colKeys = tab => TKEYS[tab];

function initHead(tab) {
  const thead = $(HEAD_SEL[tab]);
  const ths = thead.querySelectorAll('th');
  const v = views[tab];
  const keys = [...ths].map(t => t.dataset.k);
  TKEYS[tab] = keys;
  if (!Array.isArray(v.keys)) {
    // 旧版（数字 oi 键）或首装：布局偏好作废重来
    v.widths = {};
    v.order = null;
    v.hiddenCols = [];
  } else if (v.keys.join() !== keys.join()) {
    // 列集变了（加删列等）：温和迁移——只丢消失列的偏好，新列插到操作列前
    for (const k of Object.keys(v.widths)) if (!keys.includes(k)) delete v.widths[k];
    v.hiddenCols = v.hiddenCols.filter(k => keys.includes(k));
    if (v.order) {
      const o = v.order.filter(k => keys.includes(k));
      const fresh = keys.filter(k => !o.includes(k) && k !== 'ops');
      o.splice(o.indexOf('ops') < 0 ? o.length : o.indexOf('ops'), 0, ...fresh);
      if (!o.includes('ops')) o.push('ops');
      v.order = o;
    }
  }
  v.keys = keys;
  saveViews();
  sanitizeFilters(tab);
  ths.forEach(th => {
    th.dataset.label = th.textContent.trim();
    if (th.classList.contains('ops')) {
      // Notion 式：最右上角的 ＋ 新建列
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'addcol';
      b.title = '新建列';
      b.textContent = '＋';
      b.onclick = e => { e.stopPropagation(); openNewColPop(tab, b); };
      th.appendChild(b);
      return;
    }
    const ic = document.createElement('span');
    ic.className = 'ticon';
    ic.innerHTML = TYPE_ICON[colType(tab, th.dataset.k)];
    th.prepend(ic);
    initColDrag(tab, th);
    initColResize(tab, th);
    th.onclick = () => openHeadMenu(tab, th); // Notion 式：点表头开属性菜单
    th.classList.add('th-sort');
    th.appendChild(Object.assign(document.createElement('span'), { className: 'sind' }));
  });
  // Notion 式表尾新建行
  const nr = document.createElement('div');
  nr.className = 'newrow';
  nr.textContent = '＋ 新建';
  nr.onclick = () => (tab === 'media' ? openMediaDialog(null) : openItemDialog(tab, null));
  thead.closest('.tablewrap').appendChild(nr);
  applyColumns(tab);
  applyWidths(tab);
}

/* 列宽三律（用户定案：右边框是硬边界，最右列右缘恒贴容器右边框）：
   ① 无手动列宽——fitWidths 把表装进容器：自然宽放得下保持 auto 铺满，放不下等比压缩
     数据列（下限 MIN_COLW、操作列保持自然宽），随窗口尺寸重排，不落存储；
   ② 有手动列宽——按存储锁定 fixed，最右可见列吸收残差（存宽是它的下限），
     表格恒铺满容器、右缘不动；只有窗口骤缩/解除隐藏可能超容器，此时容器内横向滚动兜底；
   ③ 拖动中——拖宽先吃残差，贴边后从右侧数据列邻列起逐列压缩到下限后把手停住；
     拖窄的空间全部让给最右列。把手双击整表还原到 ①。 */
const MIN_COLW = 52;

function applyWidths(tab) {
  const thead = $(HEAD_SEL[tab]);
  if (!thead) return; // 这张表不在了（库刚被删，或一个库都不剩）：没有列宽要结算
  const v = views[tab];
  const w = v.widths || {};
  const table = thead.closest('table');
  if (!Object.keys(w).length) {
    fitWidths(thead, table);
    return;
  }
  table.classList.add('fixed');
  const hid = v.hiddenCols || [];
  const ths = [...thead.querySelectorAll('th')].filter(t => !hid.includes(t.dataset.k));
  let sum = 0;
  for (const th of ths) {
    let px = w[th.dataset.k];
    if (!(px > 0)) {
      // 冻结后才恢复显示的列没有存宽：按当前渲染宽补冻结，量不到（表在隐藏页）就先不锁表宽
      px = Math.round(th.getBoundingClientRect().width);
      if (px < 8) { table.style.width = ''; return; }
      w[th.dataset.k] = px;
    }
    th.style.width = px + 'px';
    sum += px;
  }
  // 最右可见列（显示序）吸收残差：右缘恒贴容器右边框；残差不落存储
  const last = ths[ths.length - 1];
  const capW = table.closest('.tablewrap').clientWidth;
  if (last && capW > 8) {
    const lastW = Math.max(w[last.dataset.k], capW - (sum - w[last.dataset.k]));
    last.style.width = lastW + 'px';
    sum += lastW - w[last.dataset.k];
  }
  table.style.width = sum + 'px';
}

// 无手动列宽时的自动布局：量一遍自然宽，超出容器就等比压进去（被下限顶住的列锁定后重分配）
function fitWidths(thead, table) {
  const ths = [...thead.querySelectorAll('th')].filter(t => t.style.display !== 'none');
  table.classList.remove('fixed');
  table.style.width = '';
  for (const t of ths) t.style.width = '';
  const avail = table.closest('.tablewrap').clientWidth;
  if (!avail) return; // 表在隐藏页量不到，等可见时再排
  const nat = ths.map(t => ({ t, w: t.getBoundingClientRect().width, ops: t.classList.contains('ops') }));
  if (nat.reduce((s, x) => s + x.w, 0) <= avail + 1) return; // 天然放得下：保持 auto 铺满
  const fitted = new Map(nat.filter(x => x.ops).map(x => [x.t, Math.round(x.w)]));
  let pool = nat.filter(x => !x.ops);
  let room = avail - [...fitted.values()].reduce((s, x) => s + x, 0);
  for (let guard = 0; guard < nat.length; guard++) {
    const natSum = pool.reduce((s, x) => s + x.w, 0);
    const clamped = pool.filter(x => x.w * room / natSum < MIN_COLW);
    if (!clamped.length) break;
    for (const x of clamped) { fitted.set(x.t, MIN_COLW); room -= MIN_COLW; }
    pool = pool.filter(x => !clamped.includes(x));
  }
  const natSum = pool.reduce((s, x) => s + x.w, 0) || 1;
  for (const x of pool) fitted.set(x.t, Math.max(MIN_COLW, Math.floor(x.w * room / natSum)));
  let total = 0;
  for (const [t, px] of fitted) { t.style.width = px + 'px'; total += px; }
  table.classList.add('fixed');
  table.style.width = total + 'px';
}

function initColResize(tab, th) {
  const h = document.createElement('span');
  h.className = 'rhandle';
  h.title = '拖动调宽 · 双击整表还原';
  h.addEventListener('click', e => e.stopPropagation());
  h.addEventListener('dblclick', e => {
    e.stopPropagation();
    views[tab].widths = {};
    saveViews();
    applyWidths(tab);
  });
  h.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    th.draggable = false; // 调宽期间禁掉列序拖动（dragstart 的 target 是 th，拦不到把手）
    closePop();
    const v = views[tab];
    const hid = v.hiddenCols || [];
    if (!Object.keys(v.widths).length) {
      // 冻结当前渲染宽（可见列，含操作列；fit 压缩过就是压缩后的值），避免切 fixed 时跳动
      $(HEAD_SEL[tab]).querySelectorAll('th').forEach(t => {
        if (!hid.includes(t.dataset.k) && t.style.display !== 'none') v.widths[t.dataset.k] = Math.round(t.getBoundingClientRect().width);
      });
      applyWidths(tab);
    }
    const table = th.closest('table');
    const capW = table.closest('.tablewrap').clientWidth;
    const k = th.dataset.k;
    const startX = e.clientX;
    const startW = v.widths[k] || Math.round(th.getBoundingClientRect().width);
    let startSum = 0;
    for (const [o, px] of Object.entries(v.widths)) if (!hid.includes(o)) startSum += px;
    // 右边框是硬边界：拖宽先吃容器空白，贴边后从被拖列右侧的数据列（显示序邻列优先，
    // 操作列除外）逐列压缩到 MIN_COLW，压无可压把手就停；拖窄整表收窄。
    const after = [];
    for (let t = th.nextElementSibling; t; t = t.nextElementSibling) {
      if (t.classList.contains('ops') || t.style.display === 'none') continue;
      after.push({ el: t, k: t.dataset.k, w0: v.widths[t.dataset.k] || Math.round(t.getBoundingClientRect().width) });
    }
    const blank = Math.max(0, capW - startSum); // 最右列当前吃着的残差
    const maxW = startW + blank + after.reduce((s, a) => s + Math.max(0, a.w0 - MIN_COLW), 0);
    const move = ev => {
      const nw = Math.min(maxW, Math.max(MIN_COLW, Math.round(startW + ev.clientX - startX)));
      v.widths[k] = nw;
      let need = Math.max(0, nw - startW - blank);
      for (const a of after) {
        const take = Math.min(need, Math.max(0, a.w0 - MIN_COLW));
        need -= take;
        v.widths[a.k] = a.w0 - take;
      }
      applyWidths(tab); // 残差列与表宽统一由它结算，右缘恒贴边
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      th.draggable = true;
      applyWidths(tab); // 收尾对账：表宽、各列宽与存储一致
      saveViews();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  th.appendChild(h);
}

/* 列序拖动（Notion 式）：拖表头换位，操作列固定在最后 */
let dragTab = null, dragK = null;

function clearDropMarks(tab) {
  $(HEAD_SEL[tab]).querySelectorAll('th').forEach(t => t.classList.remove('drop-l', 'drop-r', 'dragging'));
}

function initColDrag(tab, th) {
  th.draggable = true;
  th.addEventListener('dragstart', e => {
    if (e.target.closest?.('.rhandle')) { e.preventDefault(); return; }
    dragTab = tab;
    dragK = th.dataset.k;
    e.dataTransfer.effectAllowed = 'move';
    closePop();
    th.classList.add('dragging');
  });
  th.addEventListener('dragover', e => {
    if (dragTab !== tab || dragK === th.dataset.k) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = th.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    th.classList.toggle('drop-r', after);
    th.classList.toggle('drop-l', !after);
  });
  th.addEventListener('dragleave', () => th.classList.remove('drop-l', 'drop-r'));
  th.addEventListener('drop', e => {
    e.preventDefault();
    if (dragTab !== tab) return;
    const after = th.classList.contains('drop-r');
    const cur = validOrder(tab) || colKeys(tab);
    const o = cur.filter(x => x !== dragK);
    o.splice(o.indexOf(th.dataset.k) + (after ? 1 : 0), 0, dragK);
    views[tab].order = o;
    saveViews();
    clearDropMarks(tab);
    RENDER[tab]();
  });
  th.addEventListener('dragend', () => clearDropMarks(tab));
}

function validOrder(tab) {
  const o = views[tab].order;
  const keys = colKeys(tab);
  return o && o.length === keys.length && keys.every(k => o.includes(k)) ? o : null;
}

// 列的隐藏与显示顺序一趟做完：thead 按 data-k 归位；tbody 每次渲染都是原始列序，
// 先给 td 补上列键再重排一次即到位
function applyColumns(tab) {
  const thead = $(HEAD_SEL[tab]);
  const keys = colKeys(tab);
  const hid = views[tab].hiddenCols || [];
  const o = validOrder(tab);
  const hrow = thead.rows[0];
  for (const th of hrow.cells) th.style.display = hid.includes(th.dataset.k) ? 'none' : '';
  if (o) for (const k of o) hrow.appendChild(hrow.querySelector(`th[data-k="${k}"]`));
  for (const tr of thead.parentElement.tBodies[0].rows) {
    const cells = [...tr.children];
    if (cells.length !== keys.length) continue;
    cells.forEach((td, i) => {
      td.dataset.k = keys[i];
      td.style.display = hid.includes(keys[i]) ? 'none' : '';
    });
    if (o) for (const k of o) tr.appendChild(cells[keys.indexOf(k)]);
  }
}

// 每张表渲染完的收尾：列隐藏/列序、表宽对账、表头指示、视图胶囊行一次做齐
function syncTable(tab) {
  applyColumns(tab);
  applyWidths(tab); // 隐藏/恢复列后表宽必须重算，否则 fixed 布局把差额摊给其余列
  syncHeads(tab);
  renderViewPills(tab);
}

function syncHeads(tab) {
  const s = views[tab].sort;
  $(HEAD_SEL[tab]).querySelectorAll('th[data-k]').forEach(th => {
    const on = !!s && s.key === th.dataset.k;
    const sind = th.querySelector('.sind');
    if (sind) {
      sind.textContent = on ? (s.dir === 1 ? '▲' : '▼') : '';
      th.setAttribute('aria-sort', on ? (s.dir === 1 ? 'ascending' : 'descending') : 'none');
    }
    const ic = th.querySelector('.ticon');
    if (ic) ic.innerHTML = TYPE_ICON[colType(tab, th.dataset.k)]; // 图标随有效类型
  });
}

/* 列筛选浮层（多选 + 计数 + 清除） */
let popEl = null, popKey = '';

function closePop() {
  if (!popEl) return;
  popEl.remove();
  popEl = null;
  popKey = '';
  document.removeEventListener('pointerdown', popOutside, true);
  window.removeEventListener('keydown', popEsc, true);
}

function popOutside(e) { if (popEl && !popEl.contains(e.target)) closePop(); }
function popEsc(e) { if (e.key === 'Escape') closePop(); }

function placePop(el, anchor) {
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  // 浮层是 fixed 的，落到视口外就永远够不着（表格越长越容易撞上）：放不下就翻到锚点上方
  const h = el.offsetHeight;
  const below = r.bottom + 6;
  el.style.top = Math.max(8, below + h <= innerHeight - 8 ? below : Math.min(r.top - 6 - h, innerHeight - 8 - h)) + 'px';
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
  document.addEventListener('pointerdown', popOutside, true);
  window.addEventListener('keydown', popEsc, true);
}

function setFilter(tab, k, f) {
  if (f == null) delete views[tab].filters[k];
  else views[tab].filters[k] = f;
  saveViews();
  RENDER[tab]();
}

// 操作符型筛选（text/num/date）：操作符下拉 + 值输入
const OP_MENU = {
  text: [['has', '包含'], ['not', '不包含'], ['empty', '为空'], ['nonempty', '非空']],
  num: [['eq', '='], ['ne', '≠'], ['ge', '≥'], ['le', '≤'], ['gt', '>'], ['lt', '<'], ['empty', '为空'], ['nonempty', '非空']],
  date: [['is', '等于'], ['before', '早于'], ['after', '晚于'], ['empty', '为空'], ['nonempty', '非空']],
};

function opFilterBody(tab, k, t) {
  const cur = views[tab].filters[k];
  const f = filterShapeOk(tab, k, cur) && cur ? cur : { op: OP_MENU[t][0][0], q: '' };
  const wrap = document.createElement('div');
  wrap.className = 'fp-form';
  const sel = document.createElement('select');
  sel.className = 'mini-select fp-op';
  for (const [op, label] of OP_MENU[t]) {
    sel.appendChild(Object.assign(document.createElement('option'), { value: op, textContent: label, selected: op === f.op }));
  }
  const inp = document.createElement('input');
  inp.className = 'fp-q';
  inp.type = t === 'num' ? 'number' : t === 'date' ? 'date' : 'text';
  if (t === 'num') inp.step = 'any';
  inp.placeholder = '筛选值…';
  inp.value = f.q ?? '';
  const apply = () => {
    inp.disabled = sel.value === 'empty' || sel.value === 'nonempty';
    setFilter(tab, k, { op: sel.value, q: inp.value });
  };
  sel.addEventListener('change', apply);
  inp.addEventListener('input', apply);
  inp.disabled = f.op === 'empty' || f.op === 'nonempty';
  wrap.append(sel, inp);
  return wrap;
}

// 勾选列表型筛选（sel/multi/status/star）：值 + 计数，多选并集
function listFilterBody(tab, k, t) {
  const col = COLS[tab][k];
  const counts = new Map();
  for (const r of state[tab]) {
    const vals = colFvals(tab, k, r);
    if (!vals.length) counts.set(BLANK, (counts.get(BLANK) || 0) + 1);
    for (const x of vals) counts.set(x, (counts.get(x) || 0) + 1);
  }
  const sel = Array.isArray(views[tab].filters[k]) ? views[tab].filters[k] : [];
  for (const x of sel) if (!counts.has(x)) counts.set(x, 0); // 已选但数据里已消失的值仍可见、可取消
  for (const x of effectiveOptions(tab, k)) if (!counts.has(x)) counts.set(x, 0); // 词表选项零使用也列出（Notion 同款）
  // 顺序：词表序（状态等语义词表用 ord，其余跟随选项手动序），词表外的值按中文序垫底，（空）恒最后
  const ord = col.ord || effectiveOptions(tab, k);
  const pos = x => { const i = ord.indexOf(x); return i < 0 ? ord.length : i; };
  const keys = [...counts.keys()].sort((a, b) =>
    (a === BLANK) - (b === BLANK) || pos(a) - pos(b) || cmpZh(a, b));
  const wrap = document.createElement('div');
  for (const x of keys) {
    const l = document.createElement('label');
    l.className = 'check fp-item';
    const shown = x === BLANK ? esc(x)
      : t === 'status' ? stPill(x)
      : t === 'star' ? `<span class="star-row">${'★'.repeat(+x || 0)}</span>`
      : tagFor(tab, k, x);
    l.innerHTML = `<input type="checkbox" value="${esc(x)}"${sel.includes(x) ? ' checked' : ''}><span class="fp-v">${shown}</span><i>${counts.get(x)}</i>`;
    wrap.appendChild(l);
  }
  wrap.addEventListener('change', () => {
    setFilter(tab, k, [...wrap.querySelectorAll('input:checked')].map(i => i.value));
  });
  return wrap;
}

function openFilterPop(tab, k, anchor) {
  const id = 'filter:' + tab + ':' + k;
  if (popKey === id) { closePop(); return; }
  closePop();
  popKey = id;
  const t = colType(tab, k);
  popEl = document.createElement('div');
  popEl.className = 'filterpop';
  popEl.innerHTML = `<div class="fp-head"><b>${esc(colLabel(tab, k))}</b><button type="button" class="btn link" data-clear>清除</button></div>`;
  popEl.appendChild(LIST_TYPES.includes(t) ? listFilterBody(tab, k, t) : opFilterBody(tab, k, t));
  popEl.querySelector('[data-clear]').onclick = () => {
    setFilter(tab, k, null);
    closePop();
  };
  placePop(popEl, anchor);
}

/* ── 字段属性编辑：选项管理 / 自定义列的改名删除新建 ──
   可管理选项的列 = 自由词表的内置列（与后端 BUILTIN_OPT 白名单一致）+ 自定义单选/多选列；
   状态/周期/币种/类别等参与语义的词表不开放。 */
const OPT_EDITABLE = {
  subs: ['category', 'payment_method'],
  vps: ['purpose', 'locations', 'routes'],
  sims: ['forms'],
  media: [],
};
const optionsEditable = (tab, k) => OPT_EDITABLE[tab]?.includes(k)
  || (!!COLS[tab][k].custom && ['sel', 'multi'].includes(COLS[tab][k].t));

// 字段的有效选项值 = 已存词表（{v,c} 取 v）∪ 数据里出现过的值（存续顺序：词表在前）
function effectiveOptions(tab, k) {
  const out = storedOpts(tab, k).map(o => o.v);
  const seen = new Set(out);
  for (const r of state[tab]) {
    for (const v of colFvals(tab, k, r)) {
      if (!seen.has(v)) { seen.add(v); out.push(v); }
    }
  }
  return out;
}

async function fieldCall(path, method, body) {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    await refreshFields();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

const putOpts = (tab, k, opts) => fieldCall('/api/fields/options', 'PUT', { tbl: tab, key: k, options: opts });

/* 状态语义浮层：每个状态值自己声明计不计支出 / 发不发提醒 / 上不上到期时间线，
   engine 与 notify 都读这三个标记。只改标记不动值——状态是 items 的真列，
   改名删值要连行数据一起迁移，那不在这条路上做。 */
const SEM_FLAGS = [['spend', '计支出'], ['alert', '提醒'], ['timeline', '时间线']];

/* 新增状态值：词表只增不改不删。新值三个语义标记默认全关，
   要它计支出/提醒/上时间线得再去「状态语义…」里勾。 */
function openAddStatusPop(tab, k, anchor) {
  closePop();
  popKey = 'addst:' + tab + ':' + k;
  popEl = document.createElement('div');
  popEl.className = 'filterpop optpop';
  popEl.innerHTML = `<div class="fp-head"><b>新增状态值</b></div>
    <div class="fp-note">词表只能加，不能改名或删除——状态是条目的真列，改它要连行数据一起迁移</div>
    <div class="opt-add"><input class="fp-q" placeholder="新状态，回车加入"></div>`;
  const inp = popEl.querySelector('input');
  inp.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = inp.value.trim();
    if (!value) return;
    closePop();
    if (await fieldCall('/api/fields/add_status', 'POST', { tbl: tab, key: k, value })) {
      rebuildHead(tab).then(() => RENDER[tab]());
      toast(`已加入「${value}」，默认不计支出 / 不提醒 / 不上时间线`);
    }
  });
  placePop(popEl, anchor);
  inp.focus();
}

function openStatusSemPop(tab, k, anchor) {
  closePop();
  popKey = 'sem:' + tab + ':' + k;
  popEl = document.createElement('div');
  popEl.className = 'filterpop optpop sempop';
  popEl.innerHTML = `<div class="fp-head"><b>状态语义 · ${esc(colLabel(tab, k))}</b></div>
    <div class="fp-note">勾了「计支出」才进支出统计，「提醒」才发通知，「时间线」才上到期栏与日历</div>`;
  const stored = storedOpts(tab, k);
  for (const o of stored) {
    const sem = semOf(tab, o.v);
    const row = document.createElement('div');
    row.className = 'opt-row';
    row.innerHTML = `<span class="fp-v">${stPill(o.v)}</span>` + SEM_FLAGS.map(([f, lab]) =>
      `<label class="check sem"><input type="checkbox" data-f="${f}"${sem[f] ? ' checked' : ''}><span>${lab}</span></label>`
    ).join('');
    row.querySelectorAll('input').forEach(inp => inp.onchange = async () => {
      const flags = Object.fromEntries(
        [...row.querySelectorAll('input')].map(i => [i.dataset.f, i.checked ? 1 : 0]));
      const next = stored.map(x => x.v === o.v ? { ...x, ...flags } : { ...x });
      if (await fieldCall('/api/fields/semantics', 'PUT', { tbl: tab, key: k, options: next })) await loadAll();
    });
    popEl.appendChild(row);
  }
  placePop(popEl, anchor);
}

// 选项管理浮层：颜色 / 加 / 原位改名 / 删除（改名删除会传播到所有行，颜色只动词表）
function openOptionsPop(tab, k, anchor) {
  closePop();
  popKey = 'opts:' + tab + ':' + k;
  const reopen = () => { popKey = ''; openOptionsPop(tab, k, anchor); };
  popEl = document.createElement('div');
  popEl.className = 'filterpop optpop';
  popEl.innerHTML = `<div class="fp-head"><b>选项 · ${esc(colLabel(tab, k))}</b></div>`;
  const stored = storedOpts(tab, k);
  // 展示 = 已存词表（带颜色，手动序）+ 数据里出现但未入表的值；任何编辑都按展示序整体落表
  const shown = [...stored, ...effectiveOptions(tab, k).filter(v => !stored.some(o => o.v === v)).map(v => ({ v }))];
  const commitList = async next => {
    await putOpts(tab, k, next);
    RENDER[tab]();
    reopen();
  };
  let dragFrom = null;
  shown.forEach((o, idx) => {
    const x = o.v;
    const row = document.createElement('div');
    row.className = 'opt-row';
    row.draggable = true; // 手动拖动排序
    row.innerHTML = `<button type="button" class="cdot t${o.c ?? tagHash(x)}" data-color title="颜色"></button>
      <span class="fp-v">${tagFor(tab, k, x)}</span>
      <button type="button" class="btn link" data-rn title="改名">✎</button>
      <button type="button" class="btn link" data-del title="删除">✕</button>`;
    row.addEventListener('dragstart', e => {
      dragFrom = idx;
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', e => {
      if (dragFrom == null || dragFrom === idx) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle('drop-b', after);
      row.classList.toggle('drop-t', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-t', 'drop-b'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const after = row.classList.contains('drop-b');
      row.classList.remove('drop-t', 'drop-b');
      if (dragFrom == null || dragFrom === idx) return;
      const next = shown.map(s => ({ ...s }));
      const [moved] = next.splice(dragFrom, 1);
      let at = idx + (after ? 1 : 0);
      if (dragFrom < at) at--;
      next.splice(at, 0, moved);
      dragFrom = null;
      commitList(next);
    });
    row.addEventListener('dragend', () => { dragFrom = null; });
    row.querySelector('[data-color]').onclick = () => {
      // 换成十色色板行；自动=清掉指定色回到哈希。原位改色，不改变次序
      row.innerHTML = '';
      row.draggable = false;
      const strip = document.createElement('div');
      strip.className = 'cstrip';
      for (let c = 0; c < 10; c++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `cdot t${c}${o.c === c ? ' on' : ''}`;
        b.onclick = () => commitList(shown.map(s => s.v === x ? { v: x, c } : { ...s }));
        strip.appendChild(b);
      }
      const auto = document.createElement('button');
      auto.type = 'button';
      auto.className = 'btn link';
      auto.textContent = '自动';
      auto.onclick = () => commitList(shown.map(s => s.v === x ? { v: x } : { ...s }));
      strip.appendChild(auto);
      row.appendChild(strip);
    };
    row.querySelector('[data-rn]').onclick = () => {
      row.innerHTML = '';
      row.draggable = false;
      const inp = Object.assign(document.createElement('input'), { className: 'fp-q', value: x });
      row.appendChild(inp);
      inp.focus();
      inp.select();
      let done = false; // Enter 提交后 blur 会再触发一次
      const commit = async () => {
        if (done) return;
        done = true;
        const to = inp.value.trim();
        if (!to || to === x) { reopen(); return; }
        if (await fieldCall('/api/fields/rename_option', 'POST', { tbl: tab, key: k, from: x, to })) await loadAll();
        reopen();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
      inp.addEventListener('blur', commit);
    };
    row.querySelector('[data-del]').onclick = async () => {
      if (!confirm(`删除选项「${x}」？将从所有行中移除该值。`)) return;
      if (await fieldCall('/api/fields/remove_option', 'POST', { tbl: tab, key: k, value: x })) await loadAll();
      reopen();
    };
    popEl.appendChild(row);
  });
  const addRow = document.createElement('div');
  addRow.className = 'opt-add';
  addRow.innerHTML = `<input class="fp-q" placeholder="新选项，回车添加">`;
  const addInp = addRow.querySelector('input');
  addInp.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const val = addInp.value.trim();
    if (!val) return;
    if (!effectiveOptions(tab, k).includes(val)) {
      await putOpts(tab, k, [...shown.map(s => ({ ...s })), { v: val }]);
    }
    reopen();
  });
  popEl.appendChild(addRow);
  placePop(popEl, anchor);
}

// 新建列浮层（挂在操作列表头的 ＋ 上）
function openNewColPop(tab, anchor) {
  closePop();
  popKey = 'newcol:' + tab;
  popEl = document.createElement('div');
  popEl.className = 'filterpop optpop';
  popEl.innerHTML = `<div class="fp-head"><b>新建列</b></div>
    <div class="fp-form"><input class="fp-q" data-name placeholder="列名"></div>
    <div class="fp-form"><select class="mini-select fp-op" data-type>
      ${['text', 'num', 'sel', 'multi', 'date', 'star'].map(t => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('')}
    </select><button type="button" class="btn primary mini" data-go>创建</button></div>`;
  const go = async () => {
    const name = popEl.querySelector('[data-name]').value.trim();
    if (!name) { toast('列名不能为空', true); return; }
    const ftype = popEl.querySelector('[data-type]').value;
    closePop();
    if (await fieldCall('/api/fields', 'POST', { tbl: tab, name, ftype })) await rebuildHead(tab);
  };
  popEl.querySelector('[data-go]').onclick = go;
  popEl.querySelector('[data-name]').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  placePop(popEl, anchor);
  popEl.querySelector('[data-name]').focus();
}

// 重命名自定义列
function openRenameColPop(tab, k, th) {
  closePop();
  popKey = 'rename:' + tab + ':' + k;
  const f = fieldOf(tab, k);
  popEl = document.createElement('div');
  popEl.className = 'filterpop optpop';
  popEl.innerHTML = `<div class="fp-head"><b>重命名列</b></div>
    <div class="fp-form"><input class="fp-q" value="${esc(f.name)}"></div>`;
  const inp = popEl.querySelector('input');
  inp.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const name = inp.value.trim();
    if (!name || name === f.name) { closePop(); return; }
    closePop();
    if (await fieldCall(`/api/fields/${f.id}`, 'PUT', { name })) await rebuildHead(tab);
  });
  placePop(popEl, th);
  inp.focus();
  inp.select();
}

// 类型子菜单：文本值列可在 文本/单选/多选 呈现间切换（数据库字段本身不变）
function openTypeMenu(tab, th) {
  closePop();
  popKey = 'type:' + tab + ':' + th.dataset.k;
  const k = th.dataset.k;
  const cur = colType(tab, k);
  popEl = document.createElement('div');
  popEl.className = 'thmenu';
  popEl.innerHTML = '<div class="tm-title">字段类型</div>';
  for (const t of CONV_TYPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mi';
    b.innerHTML = `<span class="ticon">${TYPE_ICON[t]}</span>${esc(TYPE_LABEL[t])}${t === cur ? '<span class="mon">✓</span>' : ''}`;
    b.onclick = () => {
      closePop();
      const v = views[tab];
      if (t === COLS[tab][k].t) delete v.types[k];
      else v.types[k] = t;
      if (!filterShapeOk(tab, k, v.filters[k])) delete v.filters[k]; // 换类型后旧筛选形态失效
      saveViews();
      RENDER[tab]();
    };
    popEl.appendChild(b);
  }
  placePop(popEl, th);
}

/* Notion 式表头属性菜单：类型 / 排序 / 筛选 / 隐藏列 / 还原列宽 */
function openHeadMenu(tab, th) {
  const id = 'menu:' + tab + ':' + th.dataset.k;
  if (popKey === id) { closePop(); return; }
  closePop();
  popKey = id;
  const k = th.dataset.k;
  const v = views[tab];
  const t = colType(tab, k);
  const cur = v.sort;
  const here = !!cur && cur.key === k;
  const items = [];
  items.push({
    ticon: TYPE_ICON[t], t: `类型 · ${TYPE_LABEL[t]}`,
    inert: !COLS[tab][k].conv,
    act: () => openTypeMenu(tab, th), keepPop: true,
  });
  items.push({ sep: 1 });
  items.push({ ic: '↑', t: '升序排序', on: here && cur.dir === 1, act: () => setSort(tab, k, 1) });
  items.push({ ic: '↓', t: '降序排序', on: here && cur.dir === -1, act: () => setSort(tab, k, -1) });
  if (here) items.push({ ic: '✕', t: '清除排序', act: () => setSort(tab, null, null) });
  items.push({ sep: 1 });
  items.push({ svg: FUNNEL_SVG, t: '筛选…', act: () => openFilterPop(tab, k, th), keepPop: true });
  if (optionsEditable(tab, k)) {
    items.push({ ic: '≡', t: '编辑选项…', act: () => openOptionsPop(tab, k, th), keepPop: true });
  }
  // 状态词表只能加不能改删（状态是真列，改名删值要连行数据一起迁移），语义标记可以随便改
  if (colType(tab, k) === 'status' && storedOpts(tab, k).length) {
    items.push({ ic: '＋', t: '新增状态值…', act: () => openAddStatusPop(tab, k, th), keepPop: true });
    items.push({ ic: '◐', t: '状态语义…', act: () => openStatusSemPop(tab, k, th), keepPop: true });
  }
  items.push({ ic: '⊘', t: '隐藏此列', act: () => {
    v.hiddenCols = [...(v.hiddenCols || []), k];
    saveViews();
    RENDER[tab]();
  } });
  if (Object.keys(v.widths || {}).length) {
    items.push({ ic: '⟺', t: '还原列宽', act: () => { v.widths = {}; saveViews(); applyWidths(tab); } });
  }
  if (COLS[tab][k].custom) {
    items.push({ sep: 1 });
    items.push({ ic: '✎', t: '重命名列', act: () => openRenameColPop(tab, k, th), keepPop: true });
    items.push({ ic: '✕', t: '删除列', act: async () => {
      if (!confirm(`删除列「${th.dataset.label}」？该列在所有行的值将被清除，不可撤销。`)) return;
      if (await fieldCall(`/api/fields/${COLS[tab][k].custom}`, 'DELETE', {})) await rebuildHead(tab);
    } });
  }
  popEl = document.createElement('div');
  popEl.className = 'thmenu';
  popEl.innerHTML = `<div class="tm-title">${esc(th.dataset.label)}</div>`;
  for (const it of items) {
    if (it.sep) { popEl.appendChild(Object.assign(document.createElement('div'), { className: 'tm-sep' })); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    if (it.inert) b.disabled = true;
    b.className = 'mi';
    b.innerHTML = `<span class="${it.ticon ? 'ticon' : 'mic'}">${it.ticon || it.svg || esc(it.ic)}</span>${esc(it.t)}${it.on ? '<span class="mon">✓</span>' : ''}`;
    b.onclick = () => {
      if (it.keepPop) { it.act(); return; } // 筛选/类型项自己接管弹层
      closePop();
      it.act();
    };
    popEl.appendChild(b);
  }
  placePop(popEl, th);
}

// 筛选胶囊文案：勾选型给值/计数，操作符型给 列名+操作符+值
const NUM_OP_SIGN = { eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤' };
function filtDesc(tab, k, f) {
  const name = colLabel(tab, k);
  if (Array.isArray(f)) return `${name}: ${f.length === 1 ? f[0] : f.length + ' 项'}`;
  if (f.op === 'empty') return `${name}: 空`;
  if (f.op === 'nonempty') return `${name}: 非空`;
  const t = colType(tab, k);
  if (t === 'num') return `${name} ${NUM_OP_SIGN[f.op] || '='} ${f.q}`;
  if (t === 'date') return `${name} ${{ is: '=', before: '早于', after: '晚于' }[f.op] || '='} ${f.q}`;
  return `${name} ${f.op === 'not' ? '不含' : '含'}「${f.q}」`;
}

/* 表格上方的视图状态胶囊行：当前排序 / 各列筛选 / 已隐藏列 */
function renderViewPills(tab) {
  const el = tab === 'media' ? $('#m-view-pills') : $('#view-pills');
  if (tab !== 'media' && tab !== state.tab) return; // 三张续费表共用一行，只画当前标签页的
  el.innerHTML = '';
  const v = views[tab];
  if (!v) { el.hidden = true; return; } // 这张表的视图偏好已随库一起删掉
  const s = v.sort;
  const pills = [];
  if (s) {
    pills.push({
      cls: 'p-sort', title: '点击翻转方向',
      html: `⇅ ${esc(colLabel(tab, s.key))} ${s.dir === 1 ? '↑' : '↓'}`,
      act: () => setSort(tab, s.key, -s.dir),
      del: () => setSort(tab, null, null),
    });
  }
  for (const [k, f] of Object.entries(v.filters || {})) {
    if (!filterActive(f)) continue;
    pills.push({
      cls: 'p-filt', title: '点击编辑筛选',
      html: esc(filtDesc(tab, k, f)),
      act: e => openFilterPop(tab, k, e.currentTarget),
      del: () => setFilter(tab, k, null),
    });
  }
  if (v.hiddenCols && v.hiddenCols.length) {
    pills.push({
      cls: 'p-hid', title: '点击恢复显示',
      html: `⊘ 已隐藏 ${v.hiddenCols.length} 列`,
      act: () => { v.hiddenCols = []; saveViews(); RENDER[tab](); },
    });
  }
  el.hidden = pills.length === 0;
  for (const p of pills) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vpill ' + p.cls;
    b.title = p.title;
    b.innerHTML = `<span class="vl">${p.html}</span>${p.del ? '<span class="x" title="移除">✕</span>' : ''}`;
    b.onclick = e => {
      if (e.target.classList.contains('x')) p.del();
      else p.act(e);
    };
    el.appendChild(b);
  }
  if (pills.length >= 2) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'vpill p-clear';
    c.textContent = '清除全部';
    c.onclick = () => {
      v.sort = null;
      v.filters = {};
      v.hiddenCols = [];
      if (tab === 'media') $('#m-sort').value = 'marked';
      saveViews();
      RENDER[tab]();
    };
    el.appendChild(c);
  }
}

/* ── 点格即编：点单元格就地编辑，保存 = 整行 PUT（后端是全量替换语义）──
   复合格（名称/商家产品/规格/周期）弹多输入迷你表单；表外字段仍走「编辑」全表单。 */
// 行对象 → PUT 全量体（与各编辑表单发的字段集一致，缺一项就会被后端置空）
const ROW_BODY = {
  media: it => {
    const b = { extra: it.extra || {} };
    for (const k of M_STR) b[k] = it[k] ?? '';
    for (const k of [...M_INT, ...M_REAL]) b[k] = it[k] ?? undefined;
    if (it.cover) b.cover = it.cover;
    return b;
  },
};

/* 行对象 → 整行 PUT 的体。后端是全量替换语义：body 里漏一列，那一列就被置空。
   **不能只按字段注册表拼**——注册表管的是「界面上有哪些列」，并不覆盖每个真列：
   SIM 的周期恒为自定义天数，当初就没注册 cycle 列，于是 SIM 条目每编辑一次
   周期就被清一次（剩余天数算不出、整条掉出到期时间线与 ICS）；parent_id 与 logo
   另有专门 UI，同样没注册。所以先按行数据铺满真列，再让字段集里的值覆盖。 */
// items 的可写真列，与后端 WRITE_COLS 一一对应
const ITEM_COLS = ['name', 'parent_id', 'status', 'price', 'currency', 'cycle', 'cycle_days',
  'next_renewal', 'last_renewed', 'url', 'notes', 'logo'];

function itemBodyFromRow(key, r) {
  const b = { extra: { ...(r.extra || {}) } };
  for (const k of ITEM_COLS) if (r[k] != null) b[k] = r[k];
  for (const f of fieldsOf(key)) {
    if (f.src !== 'col') continue;
    const v = r[f.key];
    b[f.key] = f.ftype === 'num' ? (v ?? undefined) : (Array.isArray(v) ? v : (v ?? ''));
  }
  b.name = r.name ?? '';
  return b;
}

async function patchRow(tab, it, patch) {
  try {
    const body = tab === 'media'
      ? ROW_BODY.media({ ...it, ...patch })
      : itemBodyFromRow(tab, { ...it, ...patch });
    const path = tab === 'media' ? `/api/media/${it.id}` : `/api/items/${it.id}`;
    await api(path, { method: 'PUT', body: JSON.stringify(body) });
    await loadAll();
  } catch (err) { toast(err.message, true); }
}

// 复合格与字段名映射；没列出的格按列的有效类型走通用编辑器（字段名=列键）
const CELL_SPEC = {
  media: {
    title: { inputs: [['title', '标题', 'text'], ['orig_title', '又名 / 原文名', 'text']] },
    year: { inputs: [['year', '年份', 'number']] },
    douban: { inputs: [['douban_rating', '豆瓣评分', 'number']] },
    marked: { f: 'marked_at' },
  },
};

// 自定义列的值写进 extra；空值直接摘掉键
function extraPatch(it, k, v) {
  const ex = { ...(it.extra || {}) };
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete ex[k];
  else ex[k] = v;
  return { extra: ex };
}

function cellPopShell(td, title) {
  popEl = document.createElement('div');
  popEl.className = 'filterpop cellpop';
  if (title) popEl.innerHTML = `<div class="fp-head"><b>${esc(title)}</b></div>`;
  return popEl;
}

// 多输入迷你表单（复合格与通用 text/num/date 共用）
function inputsEditor(tab, it, td, fieldsDef, save) {
  const box = cellPopShell(td, colLabel(tab, td.dataset.k));
  for (const [f, label, type] of fieldsDef) {
    const wrap = document.createElement('label');
    wrap.className = 'cp-field';
    const val = f in it ? it[f] : (it.extra || {})[td.dataset.k];
    wrap.innerHTML = `${esc(label)}<input class="fp-q" type="${type}" ${type === 'number' ? 'step="any"' : ''} data-f="${esc(f)}">`;
    wrap.querySelector('input').value = val ?? '';
    box.appendChild(wrap);
  }
  const foot = document.createElement('div');
  foot.className = 'cp-foot';
  foot.innerHTML = '<button type="button" class="btn primary mini">保存</button>';
  box.appendChild(foot);
  const commit = () => {
    const patch = {};
    for (const inp of box.querySelectorAll('input[data-f]')) {
      patch[inp.dataset.f] = inp.type === 'number'
        ? (inp.value === '' ? undefined : +inp.value)
        : inp.value;
    }
    closePop();
    save(patch);
  };
  foot.querySelector('button').onclick = commit;
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') commit(); });
  placePop(box, td);
  box.querySelector('input')?.focus();
}

// 单选/状态：点值即存；自由词表列可现场新建选项
function pickEditor(tab, it, td, k, save) {
  const col = COLS[tab][k];
  const t = colType(tab, k);
  const fixed = t === 'status' || (col.ord && !col.custom && !optionsEditable(tab, k)); // 语义词表：只挑不建
  const values = col.ord && fixed ? col.ord : effectiveOptions(tab, k);
  const cur = String((k in it ? it[k] : (it.extra || {})[k]) ?? '');
  const box = cellPopShell(td, colLabel(tab, k));
  for (const x of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mi';
    b.innerHTML = `<span class="fp-v">${t === 'status' ? stPill(x) : tagFor(tab, k, x)}</span>${x === cur ? '<span class="mon">✓</span>' : ''}`;
    b.onclick = () => { closePop(); if (x !== cur) save(x); };
    box.appendChild(b);
  }
  if (!fixed) {
    if (cur) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'mi';
      c.innerHTML = '<span class="fp-v">清除</span>';
      c.onclick = () => { closePop(); save(''); };
      box.appendChild(c);
    }
    const addRow = document.createElement('div');
    addRow.className = 'opt-add';
    addRow.innerHTML = '<input class="fp-q" placeholder="新选项，回车选用">';
    const inp = addRow.querySelector('input');
    inp.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const val = inp.value.trim();
      if (!val) return;
      closePop();
      if (optionsEditable(tab, k) && !values.includes(val)) {
        await putOpts(tab, k, [...storedOpts(tab, k), { v: val }]);
      }
      save(val);
    });
    box.appendChild(addRow);
  }
  placePop(box, td);
}

// 值挂在行的 extra 里还是顶层：库的列看注册表的 src，媒体的自定义列看 custom
const inExtra = col => (col.src ? col.src === 'extra' : !!col.custom);

// 多选：勾选并集实时存；同样可现场新建选项
function multiEditor(tab, it, td, k, save) {
  const col = COLS[tab][k];
  const raw = inExtra(col) ? (it.extra || {})[k] : it[k];
  const cur = Array.isArray(raw) ? raw.map(String) : raw ? splitVals(raw) : [];
  const values = effectiveOptions(tab, k);
  for (const v of cur) if (!values.includes(v)) values.push(v);
  const box = cellPopShell(td, colLabel(tab, k));
  const commit = () => {
    const sel = [...box.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
    save(sel);
  };
  for (const x of values) {
    const l = document.createElement('label');
    l.className = 'check fp-item';
    l.innerHTML = `<input type="checkbox" value="${esc(x)}"${cur.includes(x) ? ' checked' : ''}><span class="fp-v">${tagFor(tab, k, x)}</span>`;
    box.appendChild(l);
  }
  box.addEventListener('change', commit);
  const addRow = document.createElement('div');
  addRow.className = 'opt-add';
  addRow.innerHTML = '<input class="fp-q" placeholder="新选项，回车加入">';
  const inp = addRow.querySelector('input');
  inp.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const val = inp.value.trim();
    if (!val) return;
    closePop();
    if (optionsEditable(tab, k) && !values.includes(val)) {
      await putOpts(tab, k, [...storedOpts(tab, k), { v: val }]);
    }
    save([...cur, val]);
  });
  box.appendChild(addRow);
  placePop(box, td);
}

// 星级：点星即存
function starEditor(tab, it, td, k, save) {
  const cur = +((k in it ? it[k] : (it.extra || {})[k]) || 0);
  const box = cellPopShell(td, null);
  const row = document.createElement('span');
  row.className = 'stars';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '★';
    if (n <= cur) b.classList.add('lit');
    b.onclick = () => { closePop(); save(n); };
    row.appendChild(b);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'star-clear';
  clear.textContent = '清除';
  clear.onclick = () => { closePop(); save(null); };
  row.appendChild(clear);
  box.appendChild(row);
  placePop(box, td);
}

// 周期编辑：付费周期下拉 + 按天数时的天数输入（订阅周期列 / VPS 周期列共用）
function cycleEditor(tab, it, td) {
  const box = cellPopShell(td, '付费周期');
  box.insertAdjacentHTML('beforeend', `<div class="fp-form">
    <select class="mini-select fp-op" data-cycle>${CYCLE_ORDER.map(c => `<option value="${c}"${c === (it.cycle || '') ? ' selected' : ''}>${c ? CYCLE_LABEL[c] : '—'}</option>`).join('')}</select>
    <input class="fp-q" type="number" min="1" data-days placeholder="天数" value="${esc(String(it.cycle_days ?? ''))}">
  </div><div class="cp-foot"><button type="button" class="btn primary mini">保存</button></div>`);
  const sel = box.querySelector('[data-cycle]');
  const days = box.querySelector('[data-days]');
  const syncDays = () => { days.hidden = sel.value !== 'days'; };
  sel.addEventListener('change', syncDays);
  syncDays();
  box.querySelector('.cp-foot button').onclick = () => {
    // 选了自定义天数却不填数：既算不出到期日，周期还会显示成 "Every 0 days"
    if (sel.value === 'days' && !(+days.value > 0)) { toast('自定义周期要填天数', true); return; }
    const patch = { cycle: sel.value, cycle_days: days.value === '' ? undefined : +days.value };
    closePop();
    patchRow(tab, it, patch);
  };
  placePop(box, td);
}

function openCellPop(tab, it, k, td) {
  const id = `cell:${tab}:${it.id}:${k}`;
  if (popKey === id) { closePop(); return; }
  closePop();
  popKey = id;
  const col = COLS[tab][k];
  if (!col) return;
  const spec = CELL_SPEC[tab]?.[k] || {};
  const t = colType(tab, k);
  const toExtra = inExtra(col);
  // 算出来的列（剩余天数 / 模板列）不能就地编辑，点它开详情表单去改源字段
  if (col.src === 'calc') return openItemDialog(tab, it);
  // 周期是复合格：周期枚举 + 自定义天数
  if (spec.cycle || k === 'cycle') return cycleEditor(tab, it, td);
  const save = v => patchRow(tab, it, toExtra ? extraPatch(it, k, v) : { [spec.f || k]: v });
  if (spec.inputs) return inputsEditor(tab, it, td, spec.inputs, patch => patchRow(tab, it, patch));
  if (t === 'sel' || t === 'status') return pickEditor(tab, it, td, k, save);
  if (t === 'star') return starEditor(tab, it, td, k, save);
  if (t === 'multi') {
    return multiEditor(tab, it, td, k, sel => {
      if (toExtra) return patchRow(tab, it, extraPatch(it, k, sel));
      if (col.src === 'col') return patchRow(tab, it, { [k]: sel });
      return patchRow(tab, it, { [k]: sel.join(', ') }); // 文本列的多选呈现：拼回字符串
    });
  }
  const f = spec.f || k;
  const type = t === 'num' ? 'number' : t === 'date' ? 'date' : 'text';
  return inputsEditor(tab, it, td, [[f, colLabel(tab, k), type]], patch => {
    if (toExtra) return patchRow(tab, it, extraPatch(it, k, patch[f] ?? ''));
    return patchRow(tab, it, patch);
  });
}

// 点击委托：按钮/链接照旧，其余格子进就地编辑。挂在 document 上、按 tbody 的 data-tab 认表，
// 后建的库自然生效——曾经写死成四个 tbody 选择器，于是自建库的格子点了毫无反应
document.addEventListener('click', e => {
  if (e.target.closest('button, a, input, select, textarea, label')) return;
  const td = e.target.closest('td');
  const tab = td?.closest('tbody[data-tab]')?.dataset.tab;
  if (!tab || !td.dataset.k || td.dataset.k === 'ops') return;
  const it = state[tab]?.find(x => x.id === +td.closest('tr').dataset.id);
  if (it) openCellPop(tab, it, td.dataset.k, td);
});

/* ── 订阅表（Notion 式子行：服务→套餐档位可折叠，比价一目了然）── */
async function delItem(kind, it) {
  if (!confirm(`删除「${it.name || it.vendor || it.title || ''}」？此操作不可撤销。`)) return;
  try {
    await api(`/api/${kind}/${it.id}`, { method: 'DELETE' });
    toast('已删除');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 订阅表单 ── */
function openSettings() {
  const st = state.settings;
  const f = $('#form-settings').elements;
  $('#settings-renewals').hidden = !MODULES.includes('renewals');
  $('#settings-media').hidden = !MODULES.includes('media');
  f.pin.value = st['auth.pin'] || '';
  f.tmdb_key.value = st['meta.tmdb_key'] || '';
  f.meta_proxy.value = st['meta.proxy'] || '';
  try {
    f.thresholds.value = JSON.parse(st['notify.thresholds'] || '[]').join(',');
  } catch { f.thresholds.value = ''; }
  f.digest_time.value = st['notify.digest_time'] || '09:00';
  f.window_days.value = st['notify.window_days'] || '14';
  let tg = {}, em = {};
  try { tg = JSON.parse(st['notify.telegram'] || '{}'); } catch {}
  try { em = JSON.parse(st['notify.email'] || '{}'); } catch {}
  f.tg_enabled.checked = !!tg.enabled;
  f.tg_token.value = tg.bot_token || '';
  f.tg_chat.value = tg.chat_id || '';
  f.tg_proxy.value = tg.proxy || '';
  f.em_enabled.checked = !!em.enabled;
  f.em_host.value = em.host || '';
  f.em_port.value = em.port || 465;
  f.em_starttls.checked = !!em.starttls;
  f.em_user.value = em.username || '';
  f.em_pass.value = em.password || '';
  f.em_from.value = em.from || '';
  f.em_to.value = em.to || '';
  $('#ics-url').value = `${location.origin}/calendar.ics?token=${st['ics.token'] || ''}`;
  $('#dlg-settings').showModal();
  if (MODULES.includes('renewals')) loadLedger(); // 不挡对话框，读回来再填
}

/* 续费台账：每次「已续费 / 已保号」记的那一笔，此前只进库不露面。
   条目或库删掉之后旧账仍在（那是历史），名字取不到就回落到编号。 */
async function loadLedger() {
  const box = $('#ledger-list');
  box.textContent = '读取中…';
  box.className = 'ledger-log note';
  try {
    const rows = await api('/api/ledger');
    box.className = 'ledger-log';
    if (!rows.length) {
      box.className = 'ledger-log note';
      box.textContent = '还没有记过账——表格里点「已续费 / 已保号」就会写一笔';
      return;
    }
    box.innerHTML = '';
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'lg-row';
      div.innerHTML = `<span class="lg-d">${esc(r.renewed_at)}</span>
        <span class="lg-n">${esc(r.item_name || `#${r.item_id}`)}<small>${esc(r.coll_name || r.kind)}</small></span>
        <span class="lg-a">${esc(money(r.currency, r.amount))}</span>`;
      box.appendChild(div);
    }
  } catch (e) {
    box.className = 'ledger-log note';
    box.textContent = '台账读取失败：' + e.message;
  }
}

function settingsBody() {
  const f = $('#form-settings').elements;
  const thresholds = f.thresholds.value.split(/[,，\s]+/).map(Number)
    .filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => b - a);
  return {
    'auth.pin': f.pin.value.replace(/[^A-Za-z0-9]/g, ''),
    'meta.tmdb_key': f.tmdb_key.value.trim(),
    'meta.proxy': f.meta_proxy.value.trim(),
    'notify.thresholds': JSON.stringify(thresholds.length ? thresholds : [14, 7, 3, 1, 0]),
    'notify.digest_time': f.digest_time.value || '09:00',
    'notify.window_days': String(+f.window_days.value || 14),
    'notify.telegram': JSON.stringify({
      enabled: f.tg_enabled.checked, bot_token: f.tg_token.value.trim(),
      chat_id: f.tg_chat.value.trim(), proxy: f.tg_proxy.value.trim(),
    }),
    'notify.email': JSON.stringify({
      enabled: f.em_enabled.checked, host: f.em_host.value.trim(), port: +f.em_port.value || 465,
      starttls: f.em_starttls.checked, username: f.em_user.value.trim(), password: f.em_pass.value,
      from: f.em_from.value.trim(), to: f.em_to.value.trim(),
    }),
  };
}

$('#form-settings').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const body = settingsBody();
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    // 设了 PIN 就给当前浏览器立刻发一份，避免下一次请求被自己锁在门外
    if (body['auth.pin']) {
      document.cookie = `kalends_pin=${body['auth.pin']};path=/;max-age=31536000;SameSite=Lax`;
    }
    $('#dlg-settings').close();
    toast('设置已保存');
    state.settings = await api('/api/settings');
  } catch (err) { toast(err.message, true); }
});

$('#btn-backup').onclick = async () => {
  const b = $('#btn-backup');
  b.disabled = true;
  try {
    const r = await api('/api/backup', { method: 'POST', body: '{}' });
    toast(`已备份：${r.snapshot.split('/').pop()}`);
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
};

document.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
  b.disabled = true;
  try {
    // 先落盘当前填写的配置，再触发测试
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(settingsBody()) });
    await api('/api/notify/test', { method: 'POST', body: JSON.stringify({ channel: b.dataset.test }) });
    toast('测试已发送，请查收');
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
});

$('#btn-copy-ics').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#ics-url').value);
    toast('已复制');
  } catch { $('#ics-url').select(); }
};

/* ── 媒体库 ── */
const M_STR = ['kind', 'title', 'orig_title', 'status', 'marked_at', 'started_at', 'review',
  'others_reviews', 'genres', 'directors', 'writers', 'actors', 'countries', 'languages',
  'runtime', 'release_date', 'douban_url', 'douban_id', 'imdb_id', 'platform', 'notes'];
const M_INT = ['year', 'rating', 'douban_votes', 'tmdb_id', 'steam_appid'];
const M_REAL = ['douban_rating', 'playtime_hours'];

const starRow = n => n ? `<span class="star-row">${'★'.repeat(n)}</span>` : '';

// 海报墙沿用类别/状态 chips；表格视图交给列筛选（applyView），互不影响
function mediaRows() {
  const m = views.media;
  let rows = state.media;
  if (m.view === 'wall') {
    if (state.mKind !== '全部') rows = rows.filter(x => x.kind === state.mKind);
    if (state.mStatus !== '全部') rows = rows.filter(x => x.status === state.mStatus);
  } else {
    for (const [k, f] of Object.entries(m.filters)) {
      const pred = filterPred('media', k, f);
      if (pred) rows = rows.filter(pred);
    }
  }
  const q = state.mQ.trim().toLowerCase();
  if (q) {
    rows = rows.filter(x => [x.title, x.orig_title, x.review, x.directors, x.actors]
      .some(v => v && String(v).toLowerCase().includes(q)));
  }
  if (m.sort) return sortRows('media', rows, m.sort);
  return [...rows].sort((a, b) =>
    String(b.marked_at || '').localeCompare(String(a.marked_at || '')) || b.id - a.id);
}

function renderMediaChips() {
  const kc = $('#m-kind-chips');
  kc.innerHTML = '';
  for (const k of ['全部', ...M_KINDS]) {
    const n = k === '全部' ? state.media.length : state.media.filter(x => x.kind === k).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (k === state.mKind ? ' on' : '');
    b.innerHTML = `${esc(k)}<b>${n}</b>`;
    b.onclick = () => { state.mKind = k; renderMedia(); };
    kc.appendChild(b);
  }
  const base = state.mKind === '全部' ? state.media : state.media.filter(x => x.kind === state.mKind);
  const sc = $('#m-status-row');
  sc.innerHTML = '';
  for (const st of ['全部', ...M_STATUSES]) {
    const n = st === '全部' ? base.length : base.filter(x => x.status === st).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (st === state.mStatus ? ' on' : '');
    b.innerHTML = `${esc(st)}<b>${n}</b>`;
    b.onclick = () => { state.mStatus = st; renderMedia(); };
    sc.appendChild(b);
  }
}

function renderMedia() {
  const isWall = views.media.view === 'wall';
  renderMediaChips();
  const rows = mediaRows();
  $('#m-empty').hidden = rows.length > 0;
  $('#m-wall').hidden = !isWall;
  $('#m-tablewrap').hidden = isWall;
  $('#m-kind-chips').hidden = !isWall; // 表格视图的类别/状态走列筛选，chips 只属于海报墙
  $('#m-status-row').hidden = !isWall;
  $('#m-view-toggle').textContent = isWall ? '表格' : '海报墙';
  if (isWall) {
    $('#m-body').innerHTML = ''; // 清掉表格视图的残留行，避免列序重排作用在旧行上
    const wall = $('#m-wall');
    wall.innerHTML = '';
    rows.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--i', Math.min(idx, 20));
      const badge = it.status !== '看过' ? `<span class="badge">${esc(it.status)}</span>` : '';
      const cov = it.cover
        // 封面文件名恒为 {id}.jpg 且响应带一周强缓存：重抓海报后不带版本号就会一周看不到新图
        ? `<img loading="lazy" src="/covers/${esc(it.cover)}?v=${encodeURIComponent(it.updated_at || '')}" alt="">`
        : `<div class="ph">${esc((it.title || '?').slice(0, 1))}</div>`;
      card.innerHTML = `
        <div class="cov">${cov}${badge}</div>
        <div class="t">${esc(it.title)}</div>
        <div class="meta"><span>${esc(String(it.year || ''))}</span>${starRow(it.rating)}${it.douban_rating ? `<span>豆 ${it.douban_rating}</span>` : ''}</div>`;
      card.onclick = () => openMediaDialog(it);
      wall.appendChild(card);
    });
  } else {
    const tb = $('#m-body');
    tb.innerHTML = '';
    for (const it of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = it.id;
      tr.innerHTML = `
        <td>${esc(it.title)}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${it.orig_title ? `<div class="muted" style="font-size:.75rem">${esc(it.orig_title)}</div>` : ''}</td>
        <td>${cellVal('media', 'kind', it.kind)}</td>
        <td class="cdate">${esc(String(it.year || ''))}</td>
        <td>${starRow(it.rating)}</td>
        <td class="amt">${it.douban_rating ?? ''}</td>
        <td>${stPill(it.status)}</td>
        <td class="cdate">${esc(it.marked_at || '')}</td>
        ${customTds('media', it)}<td class="ops">
          <button class="btn link" data-del type="button">删</button>
        </td>`;
      tr.querySelector('[data-open]').onclick = () => openMediaDialog(it);
      tr.querySelector('[data-del]').onclick = () => delItem('media', it);
      tb.appendChild(tr);
    }
  }
  syncTable('media');
}

let editingMedia = null;

// 星串点亮到第 n 颗（「清除」钮的 data-v 为空，不参与点亮）
const litStars = (el, n) => el.querySelectorAll('button[data-v]').forEach(b => {
  if (b.dataset.v) b.classList.toggle('lit', +b.dataset.v <= n);
});

function setStars(v) {
  $('#form-media').elements.rating.value = v || '';
  litStars($('#m-stars'), +v || 0);
}

function openMediaDialog(it) {
  editingMedia = it || null;
  const form = $('#form-media');
  form.reset();
  $('#m-tmdb-results').innerHTML = '';
  $('#m-tmdb-q').value = '';
  $('#dlg-media-title').textContent = it ? '编辑条目' : '新增条目';
  const f = form.elements;
  if (it) {
    for (const k of M_STR) f[k].value = it[k] ?? '';
    for (const k of [...M_INT, ...M_REAL]) f[k].value = it[k] ?? '';
    setStars(it.rating);
  } else {
    setStars('');
  }
  $('#m-tmdb-box').hidden = !!it || f.kind.value === '游戏';
  $('#m-game-fold').open = f.kind.value === '游戏';
  $('#m-fetch-cover').hidden = !it || f.kind.value === '游戏';
  $('#dlg-media').showModal();
}

$('#m-fetch-cover').onclick = async e => {
  const b = e.target;
  b.disabled = true;
  try {
    await api(`/api/media/${editingMedia.id}/fetch_cover`, { method: 'POST', body: '{}' });
    toast('海报已缓存到本地');
    await loadAll();
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
};

$('#m-covers').onclick = async () => {
  const targets = state.media.filter(x => !x.cover && x.kind !== '游戏');
  if (!targets.length) { toast('没有缺海报的条目（游戏封面暂不支持）'); return; }
  if (!confirm(`将为 ${targets.length} 个条目从 TMDB 搜索并缓存海报（需已配置 TMDB Key），继续？`)) return;
  const b = $('#m-covers');
  b.disabled = true;
  let ok = 0;
  const misses = [];
  for (const [i, it] of targets.entries()) {
    b.textContent = `补海报 ${i + 1}/${targets.length}`;
    try {
      await api(`/api/media/${it.id}/fetch_cover`, { method: 'POST', body: '{}' });
      ok++;
    } catch (err) {
      misses.push(it.title);
      // Key 未配置这类全局错误没必要一路撞到底
      if (String(err.message).includes('TMDB API Key')) { toast(err.message, true); break; }
    }
    await new Promise(r => setTimeout(r, 250)); // 对 TMDB 客气点
  }
  b.disabled = false;
  b.textContent = '补海报';
  if (ok || misses.length) {
    toast(`补抓完成：成功 ${ok}${misses.length ? `，未匹配 ${misses.length}（可编辑条目填 TMDB 编号后单独抓取）` : ''}`, ok === 0);
  }
  await loadAll();
};

$('#m-stars').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) setStars(b.dataset.v);
});

$('#form-media').elements.kind.addEventListener('change', e => {
  $('#m-game-fold').open = e.target.value === '游戏';
  $('#m-tmdb-box').hidden = !!editingMedia || e.target.value === '游戏';
  $('#m-fetch-cover').hidden = !editingMedia || e.target.value === '游戏';
});

$('#form-media').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {};
  for (const k of M_STR) body[k] = f[k].value;
  for (const k of [...M_INT, ...M_REAL]) body[k] = f[k].value === '' ? undefined : +f[k].value;
  // 表单不含封面字段，编辑时带上原值以免被清空
  if (editingMedia && editingMedia.cover) body.cover = editingMedia.cover;
  try {
    if (editingMedia) await api(`/api/media/${editingMedia.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/media', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-media').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

async function tmdbSearch() {
  const form = $('#form-media').elements;
  const q = $('#m-tmdb-q').value.trim() || form.title.value.trim();
  if (!q) { toast('先输入片名', true); return; }
  const box = $('#m-tmdb-results');
  box.innerHTML = '<p class="note">搜索中…</p>';
  try {
    const hits = await api(`/api/tmdb/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(form.kind.value)}`);
    box.innerHTML = hits.length ? '' : '<p class="note">无结果</p>';
    for (const h of hits) {
      const div = document.createElement('div');
      div.className = 'tmdb-hit';
      div.innerHTML = `
        ${h.poster ? `<img src="https://image.tmdb.org/t/p/w92${esc(h.poster)}" alt="" onerror="this.hidden=true">` : ''}
        <span class="ti">${esc(h.title || '')}（${esc(String(h.year || '?'))}）<small>${esc(h.orig_title || '')}</small></span>
        <button class="btn mini primary" type="button">选用</button>`;
      div.querySelector('button').onclick = async ev => {
        ev.target.disabled = true;
        try {
          const r = await api('/api/media/from_tmdb', {
            method: 'POST',
            body: JSON.stringify({ tmdb_id: h.tmdb_id, kind: form.kind.value, status: form.status.value }),
          });
          $('#dlg-media').close();
          toast('已建档，海报已缓存到本地');
          await loadAll();
          const created = state.media.find(x => x.id === r.id);
          if (created) openMediaDialog(created);
        } catch (err) { toast(err.message, true); ev.target.disabled = false; }
      };
      box.appendChild(div);
    }
  } catch (err) { box.innerHTML = ''; toast(err.message, true); }
}

$('#m-tmdb-go').onclick = tmdbSearch;
$('#m-tmdb-q').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); tmdbSearch(); }
});
$('#m-add').onclick = () => openMediaDialog(null);
$('#m-view-toggle').onclick = () => {
  views.media.view = views.media.view === 'wall' ? 'table' : 'wall';
  saveViews();
  renderMedia();
};
$('#m-sort').onchange = e => {
  setSort('media', e.target.value, M_DIR_DEFAULT[e.target.value] ?? -1);
};
let mSearchTimer;
$('#m-search').addEventListener('input', e => {
  clearTimeout(mSearchTimer);
  mSearchTimer = setTimeout(() => { state.mQ = e.target.value; renderMedia(); }, 180);
});

/* ── 页面级交互 ── */
document.querySelectorAll('.nav-tab[data-page]').forEach(b => b.onclick = () => {
  state.page = b.dataset.page;
  closePop();
  document.querySelectorAll('.nav-tab[data-page]').forEach(x => x.classList.toggle('on', x === b));
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
})();

$('#btn-settings').onclick = openSettings;
// 切表：视图容器由库决定，不再逐个写死
function switchTab(key) {
  state.tab = key;
  closePop();
  $('#t-search').value = views[key]?.q || '';
  document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === key));
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

/* ══ 用户自建库：标签页 / 表头 / 行 / 详情表单全部由 /api/collections + /api/fields 生成 ══
   预置三库（订阅 / SIM / VPS）暂时仍走各自的专用渲染器，切片 B2b 会一并收敛到这里。 */

const collOf = key => (state.overview?.collections || []).find(c => c.key === key);
const colls = () => state.overview?.collections || [];
const fieldsOf = key => state.fields
  .filter(f => f.tbl === key)
  .sort((a, b) => a.pos - b.pos || a.id - b.id);
// 名称列恒上表：它承载折叠钮 / logo / ⤢ 详情入口，关掉等于整行没有入口。
// **表头与行必须读同一份字段集**——兜底只写在其中一处就会表头少一列、行多一格，整表错位（真踩过）。
const NAME_FIELD = { key: 'name', name: '名称', ftype: 'text', src: 'col', shown: true };
function shownFields(key) {
  const fs = fieldsOf(key).filter(f => f.shown || f.key === 'name');
  return fs.some(f => f.key === 'name') ? fs : [NAME_FIELD, ...fs];
}

// 状态语义：以库的状态词表标记为准，读不到就回落到内置六值的既有含义（与后端 status_sem 同源）
const SEM_DEFAULT = {
  Active: { spend: 1, alert: 1, timeline: 1 },
  Ending: { spend: 0, alert: 0, timeline: 1 },
};
function semOf(key, status) {
  const o = (fieldOf(key, 'status')?.options || []).find(x => x.v === status);
  if (o && ['spend', 'alert', 'timeline'].some(f => f in o)) return o;
  return SEM_DEFAULT[status] || { spend: 0, alert: 0, timeline: 0 };
}
const statusOrder = key => (fieldOf(key, 'status')?.options || []).map(o => o.v);

/* 字段取值有两个：**显示值与编辑值必须分开**。
   周期是唯一一个存储键与呈现文案不同的字段（monthly ↔ Monthly）——拿显示值当表单初值，
   保存时就把文案写回了 items.cycle，存储键就此丢失：周期格变空、支出漏算这一条、
   「上次续费+周期」的库连到期日都推不出来（条目从时间线与 ICS 上消失）。真踩过。
   表格与筛选读 fieldVal，表单与编辑器一律读 fieldRaw。 */
// 编辑值：真列直接读、extra 读挂载点、calc 由服务端或模板算出
function fieldRaw(f, r) {
  if (f.src === 'col') return r[f.key];
  if (f.src === 'extra') return (r.extra || {})[f.key];
  if (f.key === 'left') return r.days_left;
  if (f.ftype === 'tpl') return tplText(f, r);
  return null;
}

// 显示值：在编辑值之上套一层呈现（目前只有周期需要）
function fieldVal(f, r) {
  if (f.src === 'col' && f.key === 'cycle') return cycleText(r);
  return fieldRaw(f, r);
}

// 模板列：按 ' / ' 分段，段首占位字段为空则整段不出现（复刻 VPS「规格」的既有观感）
function tplText(f, r) {
  const tpl = f.config?.tpl || '';
  const get = k => {
    const v = (r.extra || {})[k] ?? r[k];
    return v == null || v === '' ? '' : String(v);
  };
  return tpl.split(' / ').map(seg => {
    const keys = [...seg.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (!keys.length) return seg;
    if (!get(keys[0])) return '';
    return seg.replace(/\{(\w+)\}/g, (_, k) => get(k)).replace(/\s+/g, ' ').trim();
  }).filter(Boolean).join(' / ');
}

// 字段 → COLS 条目（类型驱动排序/筛选，与内置列同权）
function colFromField(key, f) {
  const t = f.ftype === 'tpl' ? 'text' : f.ftype;
  const numeric = t === 'num' || t === 'star';
  const isCycle = f.src === 'col' && f.key === 'cycle';
  const get = r => fieldVal(f, r);
  return {
    t, fkey: f.key, src: f.src, custom: f.builtin ? 0 : f.id,
    conv: CONV_TYPES.includes(t) ? 1 : 0,
    ord: f.key === 'status' ? statusOrder(key) : (t === 'star' ? ['1', '2', '3', '4', '5'] : null),
    str: numeric || isCycle ? 0 : 1,
    val: f.key === 'status' ? ordVal(statusOrder(key), r => r.status)
      : isCycle ? cycleRank
      : numeric ? r => { const v = get(r); return v == null || v === '' ? null : +v; }
      : get,
    fvals: r => {
      const v = get(r);
      return v == null || v === '' ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
    },
  };
}

/* ── 库顺序：拖标签换位，落到 collections.pos（跨设备），与本机列序不是一回事 ── */
let dragColl = null;
const clearTabMarks = () =>
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('drop-l', 'drop-r', 'dragging'));

function initTabDrag(btn, key) {
  btn.draggable = true;
  btn.addEventListener('dragstart', e => {
    dragColl = key;
    e.dataTransfer.effectAllowed = 'move';
    btn.classList.add('dragging');
  });
  btn.addEventListener('dragover', e => {
    if (!dragColl || dragColl === key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = btn.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    btn.classList.toggle('drop-r', after);
    btn.classList.toggle('drop-l', !after);
  });
  btn.addEventListener('dragleave', () => btn.classList.remove('drop-l', 'drop-r'));
  btn.addEventListener('drop', async e => {
    e.preventDefault();
    const after = btn.classList.contains('drop-r');
    const moved = dragColl;
    dragColl = null;
    clearTabMarks();
    if (!moved || moved === key) return;
    const order = colls().map(c => c.key).filter(k => k !== moved);
    order.splice(order.indexOf(key) + (after ? 1 : 0), 0, moved);
    try {
      await api('/api/collections/order', {
        method: 'PUT', body: JSON.stringify({ ids: order.map(k => collOf(k).id) }),
      });
      await loadAll();
    } catch (err) { toast(err.message, true); }
  });
  btn.addEventListener('dragend', () => { dragColl = null; clearTabMarks(); });
}

/* ── 库的 DOM：标签按钮 + 表格容器 + 由字段生成的表头 ── */
function collThead(key) {
  return shownFields(key).map(f => {
    const cls = f.ftype === 'num' && f.key !== 'left' ? ' class="num"' : (f.key === 'left' ? ' class="wide"' : '');
    return `<th${cls} data-k="${esc(f.key)}">${esc(f.name || f.key)}</th>`;
  }).join('') + '<th class="ops" data-k="ops"></th>';
}

function ensureCollDom(c) {
  const key = c.key;
  const label = (c.icon ? c.icon + ' ' : '') + c.name;
  let btn = document.querySelector(`.tab[data-tab="${key}"]`);
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'tab';
    btn.type = 'button';
    btn.dataset.tab = key;
    $('#coll-settings').before(btn);
  }
  // 三个预置库的标签写在 index.html 里，不走上面的新建分支——事件一律在这儿绑，
  // 否则它们既拖不动也右键不开设置（真踩过）
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.onclick = () => switchTab(key);
    btn.oncontextmenu = e => { e.preventDefault(); openCollDialog(collOf(key)); };
    initTabDrag(btn, key);
  }
  btn.textContent = label;
  let wrap = document.querySelector(`.tablewrap[data-tab="${key}"]`);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'tablewrap';
    wrap.dataset.tab = key;
    wrap.hidden = state.tab !== key;
    wrap.innerHTML = `<table class="grid"><thead><tr></tr></thead><tbody id="${esc(key)}-body" data-tab="${esc(key)}"></tbody></table>
      <p class="empty" id="${esc(key)}-empty" hidden>◌ 空架待书</p>`;
    // 挂在最后一张表之后。别锚在某个预置库上——那个库是可以被删掉的，
    // 删掉之后同一会话里再建库就会拿 null 去 .after()，整个 loadAll 断在这里
    const wraps = document.querySelectorAll('#page-renewals .tablewrap[data-tab]');
    if (wraps.length) wraps[wraps.length - 1].after(wrap);
    else $('#view-pills').after(wrap);
  }
  HEAD_SEL[key] = `.tablewrap[data-tab="${key}"] thead`;
  SEARCH_FIELDS[key] = r => [r.name, r.notes, ...Object.values(r.extra || {}).flatMap(v => Array.isArray(v) ? v : [v])];
  RENDER[key] = () => renderColl(key);
  views[key] = { sort: null, filters: {}, q: '', widths: {}, order: null, hiddenCols: [], types: {}, keys: null, collapsed: [], ...views[key] };
  COLS[key] = Object.fromEntries(shownFields(key).map(f => [f.key, colFromField(key, f)]));
  const head = $(HEAD_SEL[key]);
  const want = collThead(key);
  if (head.rows[0].innerHTML !== want) {
    head.rows[0].innerHTML = want;
    THEAD_HTML[key] = want;
    head.closest('.tablewrap').querySelector('.newrow')?.remove();
    initHead(key);
  }
}

// 每次渲染前对账：新库补 DOM，删掉的库连标签带容器一起撤
function syncColls() {
  const keys = new Set(colls().map(c => c.key));
  for (const c of colls()) ensureCollDom(c);
  // 标签依次挪到 ⚙ 前面 = 按库序排好（已存在的标签不会自己归位）
  for (const c of colls()) $('#coll-settings').before(document.querySelector(`.tab[data-tab="${c.key}"]`));
  // 库被删掉了就连标签带容器一起撤；三个预置库的容器写在 index.html 里，删库时同样该撤
  document.querySelectorAll('.tablewrap[data-tab]').forEach(w => {
    const k = w.dataset.tab;
    if (keys.has(k)) return;
    document.querySelector(`.tab[data-tab="${k}"]`)?.remove();
    w.remove();
    delete views[k]; // 本机视图偏好跟着走，否则 localStorage 里堆一堆已删库的列宽/筛选
    // 落到剩下的第一个库；一个都不剩时 key 是 undefined，交给下面的守卫
    if (state.tab === k) switchTab(colls()[0]?.key);
  });
  // 当前标签指向一个不存在的库（删空之后又建了一个）：落到第一个，否则新表建好却是隐藏的
  if (colls().length && !keys.has(state.tab)) switchTab(colls()[0].key);
  saveViews();
}

/* ── 通用行渲染 ── */
function leftBar(it) {
  if (it.days_left == null) return '<span class="muted">—</span>';
  const left = it.days_left;
  if (it.last_renewed && it.due) {
    const total = dayDiff(new Date(it.due + 'T00:00:00'), new Date(it.last_renewed + 'T00:00:00'));
    if (total > 0) {
      const pct = Math.min(100, Math.max(0, (total - left) / total * 100));
      const lbl = left < 0 ? `已超期 ${-left} 天` : `剩 ${left} 天 / ${total}`;
      return `<div class="bar"><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="lbl">${lbl}</div></div>`;
    }
  }
  return esc(left < 0 ? `已超期 ${-left} 天` : `剩 ${left} 天`);
}

function renderColl(key) {
  const c = collOf(key);
  if (!c) return;
  const all = state[key] || [];
  const tb = $(`#${key}-body`);
  if (!tb) return;
  tb.innerHTML = '';
  const byId = Object.fromEntries(all.map(x => [x.id, x]));
  let rows = applyView(key, all);
  if (!views[key].sort) rows = [...rows].sort((a, b) => cmpZh(a.name, b.name));
  const vis = new Set(rows.map(r => r.id));
  const kids = new Map();
  const top = [];
  for (const r of rows) {
    if (r.parent_id && vis.has(r.parent_id)) {
      if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
      kids.get(r.parent_id).push(r);
    } else top.push(r);
  }
  const collapsed = new Set(views[key].collapsed || []);
  setEmpty(`#${key}-empty`, rows.length, all.length);
  const fields = shownFields(key); // 名称格的兜底在 shownFields 里，表头读的是同一份
  const cycleShown = fields.some(f => f.key === 'cycle');
  const logoOf = r => r.logo || (r.parent_id && byId[r.parent_id]?.logo) || '';

  const emit = (it, depth) => {
    const parent = it.parent_id ? byId[it.parent_id] : null;
    const hasKids = kids.has(it.id);
    const sub = c.subline ? ((it.extra || {})[c.subline] ?? it[c.subline]) : '';
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    if (depth) tr.classList.add('subrow');
    const tds = fields.map(f => {
      const v = fieldVal(f, it);
      if (f.key === 'name') {
        return `<td>${hasKids ? `<button class="tgl" data-tgl type="button" title="折叠 / 展开子行">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : ''}${(!depth && parent) ? `<span class="sub-parent">${esc(parent.name)} ↳ </span>` : ''}${logoOf(it) ? `<img class="slogo" src="/logos/${esc(logoOf(it))}" alt="" loading="lazy">` : ''}${esc(it.name)}${safeUrl(it.url) ? ` <a class="btn link" href="${esc(safeUrl(it.url))}" target="_blank" rel="noreferrer">↗</a>` : ''}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${sub ? `<div class="muted" style="font-size:.75rem">${esc(sub)}</div>` : ''}</td>`;
      }
      if (f.key === 'status') return `<td>${stPill(it.status)}</td>`;
      if (f.key === 'left') return `<td class="wide">${leftBar(it)}</td>`;
      if (f.key === 'price') {
        const cyc = cycleShown ? '' : cycleText(it);
        return `<td class="amt">${esc(money(it.currency, it.price))}${cyc ? `<div class="muted" style="font-size:.72rem">${esc(cyc)}</div>` : ''}</td>`;
      }
      if (f.ftype === 'date') return `<td class="cdate">${esc(v || '')}</td>`;
      if (f.ftype === 'tpl') return `<td class="cdate">${esc(v || '')}</td>`;
      if (f.ftype === 'text') return `<td class="muted clip" title="${esc(v ?? '')}">${cellVal(key, f.key, v)}</td>`;
      if (f.ftype === 'num') return `<td class="amt">${v == null || v === '' ? '' : esc(String(v))}</td>`;
      return `<td>${cellVal(key, f.key, v)}</td>`;
    }).join('');
    const sem = semOf(key, it.status);
    const canRenew = sem.timeline && (c.due_anchor === 'last' || it.next_renewal);
    tr.innerHTML = `${tds}<td class="ops">
        ${canRenew ? `<button class="btn link" data-renew type="button">已${esc(c.verb || '续费')}</button>` : ''}
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-open]').onclick = () => openItemDialog(key, it);
    tr.querySelector('[data-del]').onclick = () => delColItem(key, it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`${key}:${it.id}`);
    const tg = tr.querySelector('[data-tgl]');
    if (tg) tg.onclick = () => {
      const s = new Set(views[key].collapsed || []);
      s.has(it.id) ? s.delete(it.id) : s.add(it.id);
      views[key].collapsed = [...s];
      saveViews();
      renderColl(key);
    };
    tb.appendChild(tr);
  };
  for (const it of top) {
    emit(it, 0);
    if (kids.has(it.id) && !collapsed.has(it.id)) for (const k of kids.get(it.id)) emit(k, 1);
  }
  syncTable(key);
}

async function delColItem(key, it) {
  if (!confirm(`删除「${it.name}」？`)) return;
  try {
    await api(`/api/items/${it.id}`, { method: 'DELETE' });
    toast('已删除');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 通用详情表单：按字段集生成 ── */
function itemDialog() {
  let d = $('#dlg-item');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'dlg-item';
  d.className = 'sheet';
  d.innerHTML = `<form id="form-item" method="dialog">
      <h3 id="dlg-item-title">条目</h3>
      <div id="item-fields" class="fgrid"></div>
      <footer>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn primary">保存</button>
      </footer>
    </form>`;
  document.body.appendChild(d);
  d.querySelector('[data-close]').onclick = () => d.close();
  return d;
}

let editingItem = null;
// 表单里的候选值 = 词表 ∪ 各行已用过的值。不走 COLS——shown=0 的字段不在里面。
function fieldOptions(key, f) {
  const out = (f.options || []).map(o => o.v);
  const seen = new Set(out);
  for (const r of state[key] || []) {
    const v = fieldRaw(f, r);
    const vals = Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)];
    for (const x of vals) if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// 单选下拉的候选：一律 {v: 存回去的值, label: 给人看的文案}。
// 周期的词表是固定档位，不从数据里长——那样长出来的会是上一次存进去的东西。
function selOptions(key, f, cur) {
  if (f.src === 'col' && f.key === 'cycle') {
    return CYCLE_ORDER.filter(Boolean).map(v => ({ v, label: CYCLE_LABEL[v] }));
  }
  const vs = fieldOptions(key, f);
  if (cur && !vs.includes(cur)) vs.push(cur);
  return vs.map(v => ({ v, label: v }));
}

// 多选清单末尾的「新选项」输入：回车加一枚勾好的复选框（已有就勾上）。
// 必须吃掉回车——表单里的回车默认直接提交。
function initMoptAdd(inp) {
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = inp.value.trim();
    inp.value = '';
    if (!val) return;
    const checks = inp.parentElement.querySelector('[data-mbox]');
    const same = [...checks.querySelectorAll('input[type=checkbox]')].find(i => i.value === val);
    if (same) { same.checked = true; same.scrollIntoView({ block: 'nearest' }); return; }
    const l = document.createElement('label');
    l.className = 'check';
    l.innerHTML = `<input type="checkbox" value="${esc(val)}" checked><span>${esc(val)}</span>`;
    checks.appendChild(l);
    l.scrollIntoView({ block: 'nearest' });
  });
}

function openItemDialog(key, it) {
  const c = collOf(key);
  editingItem = { key, id: it?.id ?? null, row: it || {} };
  const d = itemDialog();
  $('#dlg-item-title').textContent = `${it ? '编辑' : '新增'}${c?.name || ''}`;
  const box = $('#item-fields');
  box.innerHTML = '';
  for (const f of fieldsOf(key)) {
    if (f.src === 'calc') continue; // 算出来的列不可编辑
    const v = it ? fieldRaw(f, it) : ''; // 编辑值，不是格子里那份呈现
    const val = Array.isArray(v) ? v.join(', ') : (v ?? '');
    const lab = document.createElement('label');
    if (f.ftype === 'multi') {
      // 勾选清单，不是逗号分隔的文本框——值里含 , ， 、 / 时，文本框存回去会把它拆成两个
      const cur = new Set(Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
      const opts = fieldOptions(key, f);
      for (const x of cur) if (!opts.includes(x)) opts.push(x);
      lab.className = 'span2';
      // 勾选框超过三行就在自己的框里滚（长词表如 VPS 地点有 19 个值，否则把费用/到期挤出首屏）；
      // 「新选项」输入框留在滚动框外，不然想加值得先滚到底
      lab.innerHTML = `<span>${esc(f.name || f.key)}</span>
        <span class="mopts"><span class="mchecks" data-mbox="${esc(f.key)}">${opts.map(o =>
          `<label class="check"><input type="checkbox" value="${esc(o)}"${cur.has(o) ? ' checked' : ''}><span>${esc(o)}</span></label>`
        ).join('')}</span><input class="mopt-add" placeholder="新选项，回车加入"></span>`;
      initMoptAdd(lab.querySelector('.mopt-add'));
    } else if (f.ftype === 'star') {
      const n = +val || 0;
      lab.innerHTML = `<span>${esc(f.name || f.key)}</span>
        <span class="stars">${[1, 2, 3, 4, 5].map(i =>
          `<button type="button" data-v="${i}"${i <= n ? ' class="lit"' : ''}>★</button>`).join('')
        }<button type="button" class="star-clear" data-v="">清除</button></span>
        <input type="hidden" data-f="${esc(f.key)}" value="${n || ''}">`;
    } else if (f.ftype === 'sel') {
      const cur = val === '' ? '' : String(val);
      lab.innerHTML = `<span>${esc(f.name || f.key)}</span><select data-f="${esc(f.key)}">`
        + `<option value=""></option>${selOptions(key, f, cur).map(o =>
          `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.ftype === 'status') {
      const opts = statusOrder(key);
      lab.innerHTML = `<span>${esc(f.name || f.key)}</span><select data-f="${esc(f.key)}">${opts.map(o => `<option${o === (val || 'Planned') ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else {
      const type = f.ftype === 'num' ? 'number' : f.ftype === 'date' ? 'date' : 'text';
      lab.innerHTML = `<span>${esc(f.name || f.key)}</span><input type="${type}"${type === 'number' ? ' step="any"' : ''} data-f="${esc(f.key)}" value="${esc(val)}">`;
    }
    box.appendChild(lab);
  }
  box.appendChild(parentRow(key, it));
  if (it) box.appendChild(logoRow(it));
  d.showModal();
}

/* 父条目：子行只有两层（服务 → 套餐档位），所以候选是同库的顶层行。
   自己已经有子行时不能再挂到别人下面——后端 check_parent 一样会拒，这里先把口封上，
   免得用户填完一整张表单才被退回。parent_id 不是注册字段，值单独读、单独写。 */
function parentRow(key, it) {
  const rows = state[key] || [];
  const hasKids = !!it && rows.some(r => r.parent_id === it.id);
  const cur = it?.parent_id ?? '';
  const opts = rows.filter(r => !r.parent_id && (!it || r.id !== it.id));
  const lab = document.createElement('label');
  lab.innerHTML = `<span>父条目</span>
    <select data-parent${hasKids ? ' disabled' : ''}${hasKids ? ' title="本条目已经有子行，子行只支持两层"' : ''}>
      <option value="">（顶层）</option>
      ${opts.map(r => `<option value="${r.id}"${r.id === cur ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
    </select>`;
  return lab;
}

/* 条目图标：上传/清除各走自己的端点，与表单的整行 PUT 不是一回事。
   **上传后必须同步 editingItem.row.logo**——整行 PUT 的体由那份行数据拼，
   不同步的话紧接着按「保存」会把刚传的图标清掉（itemBodyFromRow 没有 logo 就置空）。 */
function logoRow(it) {
  const lab = document.createElement('label');
  lab.className = 'span2';
  lab.innerHTML = `<span>图标</span>
    <span class="logo-row">
      <span class="logo-prev"></span>
      <button type="button" class="btn ghost mini" data-logo-pick>选择图片</button>
      <button type="button" class="btn ghost mini" data-logo-clear hidden>清除</button>
      <input type="file" accept=".png,.jpg,.jpeg,.webp,.svg,.gif,.ico" data-logo hidden>
    </span>`;
  const prev = lab.querySelector('.logo-prev');
  const clear = lab.querySelector('[data-logo-clear]');
  const paint = name => {
    editingItem.row = { ...editingItem.row, logo: name || null };
    prev.innerHTML = name
      ? `<img class="slogo-view" src="/logos/${esc(name)}" alt="">`
      : '<span class="muted">未设置</span>';
    clear.hidden = !name;
  };
  paint(it.logo);
  // 原生文件选择框在这套外壳里太扎眼：藏起来，用统一样式的按钮触发
  const pick = lab.querySelector('[data-logo]');
  lab.querySelector('[data-logo-pick]').onclick = () => pick.click();
  pick.onchange = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    try {
      const r = await api(`/api/items/${it.id}/logo?ext=${encodeURIComponent(ext)}`,
        { method: 'POST', body: f, headers: {} });
      paint(r.logo);
      toast('图标已更新');
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };
  clear.onclick = async () => {
    try {
      await api(`/api/items/${it.id}/logo`, { method: 'DELETE' });
      paint(null);
      toast('图标已清除');
    } catch (err) { toast(err.message, true); }
  };
  return lab;
}

// 表单 → 整行 PUT/POST 的 body：真列放顶层，extra 字段收进 extra
// 表单 → 整行 PUT/POST 的体：先按表单值攒一个补丁，再交给 itemBodyFromRow 补全字段集
function itemBody(key, row) {
  const patch = { extra: { ...(row.extra || {}) } };
  for (const f of fieldsOf(key)) {
    if (f.src === 'calc') continue;
    let val;
    if (f.ftype === 'multi') {
      // 勾选清单直接给数组，不经字符串往返——那正是含分隔符的值被拆坏的地方
      const mbox = document.querySelector(`#item-fields [data-mbox="${f.key}"]`);
      if (!mbox) continue;
      val = [...mbox.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
    } else {
      const el = document.querySelector(`#item-fields [data-f="${f.key}"]`);
      if (!el) continue;
      const v = el.value.trim();
      val = f.ftype === 'num' || f.ftype === 'star' ? (v === '' ? undefined : Number(v)) : v;
    }
    if (f.src === 'col') patch[f.key] = val;
    else if (val == null || val === '' || (Array.isArray(val) && !val.length)) delete patch.extra[f.key];
    else patch.extra[f.key] = val;
  }
  // 父条目有自己的下拉（不是注册字段）：选「（顶层）」＝ null ＝ 脱离父行
  const psel = document.querySelector('#item-fields [data-parent]');
  if (psel) patch.parent_id = psel.value ? +psel.value : null;
  return itemBodyFromRow(key, { ...row, ...patch });
}

// 详情表单里的星级：点星写进隐藏输入（与就地编辑的 starEditor 同一套呈现）
document.addEventListener('click', e => {
  const b = e.target.closest('#item-fields .stars button[data-v]');
  if (!b) return;
  const n = +b.dataset.v || 0;
  b.closest('label').querySelector('input[data-f]').value = n || '';
  litStars(b.closest('.stars'), n);
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'form-item') return;
  e.preventDefault();
  const { key, id, row } = editingItem || {};
  if (!key) return;
  const body = itemBody(key, row || {});
  if (!body.name) { toast('名称不能为空', true); return; }
  // 与就地编辑器同一条规矩：选了自定义天数却不填数，既算不出到期日，周期还显示成 "Every 0 days"
  if (body.cycle === 'days' && !(+body.cycle_days > 0)) { toast('自定义周期要填天数', true); return; }
  try {
    if (id) await api(`/api/items/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api(`/api/collections/${encodeURIComponent(key)}/items`, { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-item').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

/* ── 库管理：新建 / 改名 / 图标 / 到期模型 / 删除 ── */
function collDialog() {
  let d = $('#dlg-coll');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'dlg-coll';
  d.className = 'sheet';
  d.innerHTML = `<form id="form-coll" method="dialog">
      <h3 id="dlg-coll-title">新建库</h3>
      <div class="fgrid">
        <label class="span2" id="coll-tpl-row"><span>模板</span>
          <div class="chips" id="coll-tpl"></div>
          <div class="muted" id="coll-tpl-desc" style="font-size:.72rem;font-weight:500"></div>
        </label>
        <label><span>库名</span><input data-c="name" required></label>
        <label><span>图标（emoji，可空）</span><input data-c="icon" maxlength="4"></label>
        <label><span>到期模型</span><select data-c="due_anchor">
          <option value="last">上次续费 + 周期</option>
          <option value="next">直接记下次到期日</option>
        </select></label>
        <label><span>到期动作说法</span><input data-c="verb" placeholder="续费"></label>
      </div>
      <div id="coll-fields-box" hidden>
        <div class="fp-note">字段：拖动调序（对所有设备生效），关掉「上表」的只留在详情表单里</div>
        <div id="coll-fields" class="fpanel"></div>
      </div>
      <footer>
        <button type="button" class="btn ghost" id="coll-del" hidden>删除本库</button>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn primary">保存</button>
      </footer>
    </form>`;
  document.body.appendChild(d);
  d.querySelector('[data-close]').onclick = () => d.close();
  return d;
}

/* 建库模板：字段集由后端播（见 collections::TEMPLATES），前端只管挑和预填。
   挑中的模板会覆盖库名/图标/到期模型/动作说法——库名除外：用户自己改过就不覆盖。 */
let collTemplates = null;
let collTpl = null;

function fillTplChips(d) {
  const box = $('#coll-tpl');
  box.innerHTML = '';
  for (const t of collTemplates || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (t.id === collTpl?.id ? ' on' : '');
    b.textContent = (t.icon ? t.icon + ' ' : '') + t.label;
    b.onclick = () => pickTpl(d, t);
    box.appendChild(b);
  }
}

function pickTpl(d, t) {
  const g = k => d.querySelector(`[data-c="${k}"]`);
  const cur = g('name').value.trim();
  if (!cur || cur === collTpl?.label) g('name').value = t.fields.length ? t.label : '';
  collTpl = t;
  g('icon').value = t.icon || '';
  g('due_anchor').value = t.due_anchor;
  g('verb').value = t.verb || '';
  $('#coll-tpl-desc').textContent = t.fields.length ? `${t.desc} · 预置字段：${t.fields.join(' · ')}` : t.desc;
  fillTplChips(d);
}

/* 字段面板：库级的字段顺序与「上不上表」。顺序落 fields.pos，对所有设备生效，
   所以调完顺手清掉本机那份列序覆写，否则用户看不到自己刚排的结果。 */
function fillCollFields(c) {
  const box = $('#coll-fields-box');
  box.hidden = !c;
  if (!c) return;
  const list = $('#coll-fields');
  list.innerHTML = '';
  const fs = fieldsOf(c.key);
  const apply = async body => {
    try {
      await api('/api/fields/order', { method: 'PUT', body: JSON.stringify(body) });
      views[c.key].order = null;
      saveViews();
      await rebuildHead(c.key);
      fillCollFields(c);
    } catch (err) { toast(err.message, true); }
  };
  let from = null;
  fs.forEach((f, idx) => {
    const row = document.createElement('div');
    row.className = 'opt-row';
    row.draggable = true;
    // 名称列不给关：它是行的唯一入口，且关掉会让表头与行的字段集对不上
    const locked = f.key === 'name';
    row.innerHTML = `<span class="fp-v">${esc(f.name || f.key)}</span>
      <label class="check sem"${locked ? ' title="名称列承载详情入口，不能撤下表格"' : ''}><input type="checkbox"${f.shown || locked ? ' checked' : ''}${locked ? ' disabled' : ''}><span>上表</span></label>`;
    if (!locked) row.querySelector('input').onchange = async e => {
      const on = e.target.checked;
      try {
        await api(`/api/fields/${f.id}`, {
          method: 'PUT', body: JSON.stringify({ name: f.name, shown: on }),
        });
        await rebuildHead(c.key);
        fillCollFields(c);
      } catch (err) { toast(err.message, true); e.target.checked = !on; }
    };
    row.addEventListener('dragstart', e => { from = idx; e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', e => {
      if (from == null || from === idx) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle('drop-b', after);
      row.classList.toggle('drop-t', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-t', 'drop-b'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const after = row.classList.contains('drop-b');
      row.classList.remove('drop-t', 'drop-b');
      if (from == null || from === idx) return;
      const keys = fs.map(x => x.key);
      const [moved] = keys.splice(from, 1);
      let at = idx + (after ? 1 : 0);
      if (from < at) at--;
      keys.splice(at, 0, moved);
      from = null;
      apply({ tbl: c.key, keys });
    });
    row.addEventListener('dragend', () => { from = null; });
    list.appendChild(row);
  });
}

let editingColl = null;
async function openCollDialog(c) {
  editingColl = c || null;
  const d = collDialog();
  $('#dlg-coll-title').textContent = c ? `库设置 · ${c.name}` : '新建库';
  const g = k => d.querySelector(`[data-c="${k}"]`);
  g('name').value = c?.name || '';
  g('icon').value = c?.icon || '';
  g('due_anchor').value = c?.due_anchor || 'last';
  g('verb').value = c?.verb || '';
  collTpl = null;
  fillCollFields(c);
  const tplRow = $('#coll-tpl-row');
  tplRow.hidden = true;
  if (!c) {
    try {
      collTemplates = collTemplates || await api('/api/collections/templates');
    } catch (e) { toast(e.message, true); }
    // 列表第一项约定是空白模板
    if (collTemplates?.length) {
      tplRow.hidden = false;
      pickTpl(d, collTemplates[0]);
    }
  }
  const del = $('#coll-del');
  // 预置库同样可删：它们只是"出厂自带"，不是不可动的内置件（后端一直放行）
  del.hidden = !c;
  del.onclick = async () => {
    const n = (state[c.key] || []).length;
    if (!confirm(`删除库「${c.name}」${n ? `及其 ${n} 个条目` : ''}？此操作不可撤销。`)) return;
    try {
      await api(`/api/collections/${c.id}`, { method: 'DELETE' });
      d.close();
      toast('已删除');
      await loadAll(); // 当前标签落到哪张表，由 syncColls 统一收拾
    } catch (e) { toast(e.message, true); }
  };
  d.showModal();
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'form-coll') return;
  e.preventDefault();
  const d = $('#dlg-coll');
  const g = k => d.querySelector(`[data-c="${k}"]`).value.trim();
  const body = { name: g('name'), icon: g('icon'), due_anchor: g('due_anchor'), verb: g('verb') };
  if (!body.name) { toast('库名不能为空', true); return; }
  try {
    if (editingColl) await api(`/api/collections/${editingColl.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else {
      const tpl = collTpl;
      const c = await api('/api/collections', { method: 'POST', body: JSON.stringify({ ...body, template: tpl?.id }) });
      await loadAll();
      switchTab(c.key);
      d.close();
      toast(tpl?.fields.length ? `库已建好，${tpl.label}模板的字段已就位` : '库已建好，先在表头「＋」里加列');
      return;
    }
    d.close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

$('#coll-add').onclick = () => openCollDialog(null);
$('#coll-settings').onclick = () => {
  const c = collOf(state.tab);
  if (c) openCollDialog(c);
};
