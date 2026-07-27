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
// 三张续费表共用状态词表（2026-07-27 统一为英文；媒体词表独立）：
// Ending=到期不续（上时间线不提醒不计支出），Unused=未启用，Deferred=比价目录
const R_STATUSES = ['Active', 'Planned', 'Deferred', 'Unused', 'Ending', 'Ended'];
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
  [state.overview, state.subs, state.sims, state.vps, state.settings, state.media] =
    await Promise.all([
      hasR ? api('/api/overview') : { today: '', upcoming: [], totals: [] },
      hasR ? api('/api/subscriptions') : [],
      hasR ? api('/api/sims') : [],
      hasR ? api('/api/vps') : [],
      api('/api/settings'),
      hasM ? api('/api/media') : [],
    ]);
  const wins = ['7', '14', '30', '60', '90', '180', 'all'];
  state.upWindow = wins.includes(state.settings['ui.upcoming_days'])
    ? state.settings['ui.upcoming_days'] : '30';
  renderAll();
}

function renderAll() {
  renderUpcoming();
  renderTotals();
  renderSubs();
  renderSims();
  renderVps();
  renderMedia();
}

/* ── 即将到期 ── */
function renderUpcoming() {
  const { upcoming, today } = state.overview;
  $('#today-note').textContent = `今日 ${today}`;
  $('#up-window').value = state.upWindow;
  const items = state.upWindow === 'all'
    ? upcoming : upcoming.filter(it => it.days_left <= +state.upWindow);
  const ol = $('#up-list');
  ol.innerHTML = '';
  $('#up-empty').hidden = items.length > 0;
  const hiddenN = upcoming.length - items.length;
  const more = $('#up-more');
  more.hidden = hiddenN <= 0;
  if (hiddenN > 0) more.textContent = `▾ 更远期还有 ${hiddenN} 项`;
  items.forEach((it, idx) => {
    const d = it.days_left;
    const cls = d < 0 ? 'd-over' : d <= 3 ? 'd-soon' : d <= 7 ? 'd-week' : 'd-far';
    const daysTxt = d < 0 ? `${-d}<small>天前</small>` : d === 0 ? `今<small>到期</small>` : `${d}<small>天后</small>`;
    const meta = [it.kind === 'sim' ? 'SIM' : '订阅', it.cycle, it.action].filter(Boolean).join(' · ');
    const li = document.createElement('li');
    li.className = cls;
    li.style.setProperty('--i', idx);
    li.innerHTML = `
      <span class="days">${daysTxt}</span>
      <span class="due">${esc(it.due)}</span>
      <span class="what"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(meta)}</div></span>
      <span class="amt">${esc(money(it.currency, it.price))}</span>
      <button class="btn mini ghost" data-renew="${it.kind}:${it.id}" type="button">${it.kind === 'sim' ? '已保号' : '已续费'}</button>`;
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
  const list = kind === 'sim' ? state.sims : kind === 'vps' ? state.vps : state.subs;
  const item = list.find(x => x.id === +id);
  const label = item ? (item.name || item.vendor || '') : '';
  if (!confirm(`记一笔「${label}」的${kind === 'sim' ? '保号' : '续费'}？`)) return;
  const path = kind === 'sim' ? `/api/sims/${id}/renew`
    : kind === 'vps' ? `/api/vps/${id}/renew`
    : `/api/subscriptions/${id}/renew`;
  try {
    await api(path, { method: 'POST', body: '{}' });
    toast('已记账，周期已推进');
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
const dayDiff = (a, b) => Math.round((a - b) / 864e5);
const todayDate = () => new Date((state.overview?.today || '1970-01-01') + 'T00:00:00');

function simLeft(it) {
  if (!it.last_renewed || !(it.cycle_days > 0)) return null;
  return it.cycle_days - dayDiff(todayDate(), new Date(it.last_renewed + 'T00:00:00'));
}

function vpsLeft(it) {
  const due = vpsDue(it);
  return due ? dayDiff(due, todayDate()) : null;
}

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
  subs: {
    name: { t: 'text', val: r => r.name, str: 1, fvals: r => r.name ? [r.name] : [] },
    status: { t: 'status', ord: R_STATUSES, val: ordVal(R_STATUSES, r => r.status), fvals: r => r.status ? [r.status] : [] },
    category: { t: 'sel', conv: 1, val: r => r.category, str: 1, fvals: r => r.category ? [r.category] : [] },
    price: { t: 'num', val: r => r.price },
    currency: { t: 'sel', conv: 1, val: r => r.currency, str: 1, fvals: r => r.currency ? [r.currency] : [] },
    cycle: { t: 'sel', conv: 1, val: r => r.cycle === 'days' ? r.cycle_days : CYCLE_RANK[r.cycle], fvals: r => r.cycle ? [cycleText(r)] : [] },
    next_renewal: { t: 'date', val: r => r.next_renewal, str: 1 },
    payment_method: { t: 'sel', conv: 1, val: r => r.payment_method, str: 1, fvals: r => r.payment_method ? [r.payment_method] : [] },
    notes: { t: 'text', conv: 1, val: r => r.notes, str: 1, fvals: r => r.notes ? [r.notes] : [] },
  },
  sims: {
    name: { t: 'text', val: r => r.name, str: 1, fvals: r => r.name ? [r.name] : [] },
    forms: { t: 'multi', val: r => (r.forms || []).join(' '), str: 1, fvals: r => r.forms || [] },
    status: { t: 'status', ord: R_STATUSES, val: ordVal(R_STATUSES, r => r.status), fvals: r => r.status ? [r.status] : [] },
    last_renewed: { t: 'date', val: r => r.last_renewed, str: 1 },
    left: { t: 'num', val: simLeft },
    keepalive_action: { t: 'text', conv: 1, val: r => r.keepalive_action, str: 1, fvals: r => r.keepalive_action ? [r.keepalive_action] : [] },
  },
  vps: {
    vendor: { t: 'text', val: r => r.vendor + ' ' + (r.product || ''), str: 1, fvals: r => [r.vendor, r.product].filter(Boolean) },
    status: { t: 'status', ord: R_STATUSES, val: ordVal(R_STATUSES, r => r.status), fvals: r => r.status ? [r.status] : [] },
    locations: { t: 'multi', val: r => (r.locations || []).join(' '), str: 1, fvals: r => r.locations || [] },
    purpose: { t: 'sel', conv: 1, val: r => r.purpose, str: 1, fvals: r => r.purpose ? [r.purpose] : [] },
    spec: { t: 'text', conv: 1, val: r => (r.cores || r.ram_gb) ? (r.cores || 0) * 1024 + (r.ram_gb || 0) : null, fvals: r => vpsSpec(r) ? [vpsSpec(r)] : [] },
    routes: { t: 'multi', val: r => (r.routes || []).join(' '), str: 1, fvals: r => r.routes || [] },
    price: { t: 'num', val: r => r.price },
    currency: { t: 'sel', conv: 1, val: r => r.currency, str: 1, fvals: r => r.currency ? [r.currency] : [] },
    last_renewed: { t: 'date', val: r => r.last_renewed, str: 1 },
    left: { t: 'num', val: vpsLeft },
  },
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

// 有效类型感知的筛选值：呈现为多选的文本列按分隔符拆开
function colFvals(tab, k, r) {
  const vals = (COLS[tab][k].fvals || (() => []))(r);
  return colType(tab, k) === 'multi' ? vals.flatMap(splitVals) : vals;
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
function rebuildHead(tab) {
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

const vpsSpec = it => [
  it.cores ? `${it.cores}C` : '',
  it.ram_gb ? `${it.ram_gb}G` : '',
  it.storage_gb ? `${it.storage_gb}G ${it.storage_type || ''}`.trim() : '',
].filter(Boolean).join(' / ');

const SEARCH_FIELDS = {
  subs: r => [r.name, r.category, r.notes, r.account, r.payment_method],
  sims: r => [r.name, r.phone_number, r.keepalive_action, r.notes, ...(r.forms || [])],
  vps: r => [r.vendor, r.product, r.purpose, r.notes, r.account, ...(r.locations || []), ...(r.routes || [])],
};

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

const RENDER = { subs: renderSubs, sims: renderSims, vps: renderVps, media: renderMedia };
const HEAD_SEL = { subs: '#view-subs thead', sims: '#view-sims thead', vps: '#view-vps thead', media: '#m-tablewrap thead' };
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
  nr.onclick = { subs: () => openSubDialog(null), sims: () => openSimDialog(null), vps: () => openVpsDialog(null), media: () => openMediaDialog(null) }[tab];
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
  el.style.top = (r.bottom + 6) + 'px';
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
    if (await fieldCall('/api/fields', 'POST', { tbl: tab, name, ftype })) rebuildHead(tab);
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
    if (await fieldCall(`/api/fields/${f.id}`, 'PUT', { name })) rebuildHead(tab);
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
      if (await fieldCall(`/api/fields/${COLS[tab][k].custom}`, 'DELETE', {})) rebuildHead(tab);
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
const API_PATH = { subs: 'subscriptions', sims: 'sims', vps: 'vps', media: 'media' };
const NATIVE_ARR = { sims: ['forms'], vps: ['locations', 'routes'] };

// 行对象 → PUT 全量体（与各编辑表单发的字段集一致，缺一项就会被后端置空）
const ROW_BODY = {
  subs: it => ({
    name: it.name, parent_id: it.parent_id ?? undefined, category: it.category ?? '',
    status: it.status, price: it.price ?? undefined, currency: it.currency ?? '',
    cycle: it.cycle ?? '', cycle_days: it.cycle_days ?? undefined,
    next_renewal: it.next_renewal ?? '', payment_method: it.payment_method ?? '',
    account: it.account ?? '', url: it.url ?? '', notes: it.notes ?? '', logo: it.logo ?? '',
    extra: it.extra || {},
  }),
  sims: it => ({
    name: it.name, phone_number: it.phone_number ?? '', status: it.status,
    keepalive_action: it.keepalive_action ?? '', cycle_days: it.cycle_days ?? undefined,
    last_renewed: it.last_renewed ?? '', notes: it.notes ?? '', forms: it.forms || [], extra: it.extra || {},
  }),
  vps: it => ({
    vendor: it.vendor, product: it.product ?? '', status: it.status, purpose: it.purpose ?? '',
    storage_type: it.storage_type ?? '', extra_storage: it.extra_storage ?? '',
    currency: it.currency ?? '', cycle: it.cycle ?? '', last_renewed: it.last_renewed ?? '',
    url: it.url ?? '', account: it.account ?? '', notes: it.notes ?? '',
    cycle_days: it.cycle_days ?? undefined, ipv6: it.ipv6 ?? 0,
    cores: it.cores ?? undefined, ram_gb: it.ram_gb ?? undefined, storage_gb: it.storage_gb ?? undefined,
    port_gbps: it.port_gbps ?? undefined, traffic_tb: it.traffic_tb ?? undefined, price: it.price ?? undefined,
    locations: it.locations || [], routes: it.routes || [], extra: it.extra || {},
  }),
  media: it => {
    const b = { extra: it.extra || {} };
    for (const k of M_STR) b[k] = it[k] ?? '';
    for (const k of [...M_INT, ...M_REAL]) b[k] = it[k] ?? undefined;
    if (it.cover) b.cover = it.cover;
    return b;
  },
};

async function patchRow(tab, it, patch) {
  try {
    await api(`/api/${API_PATH[tab]}/${it.id}`, { method: 'PUT', body: JSON.stringify(ROW_BODY[tab]({ ...it, ...patch })) });
    await loadAll();
  } catch (err) { toast(err.message, true); }
}

// 复合格与字段名映射；没列出的格按列的有效类型走通用编辑器（字段名=列键）
const CELL_SPEC = {
  subs: {
    name: { inputs: [['name', '名称', 'text']] },
    price: { inputs: [['price', '价格', 'number']] },
    cycle: { cycle: 1 },
  },
  sims: {
    name: { inputs: [['name', '名称', 'text'], ['phone_number', '号码', 'text']] },
    left: { inputs: [['cycle_days', '保号周期（天）', 'number']] },
  },
  vps: {
    vendor: { inputs: [['vendor', '商家', 'text'], ['product', '产品 / 套餐', 'text']] },
    spec: { inputs: [['cores', 'CPU 核数', 'number'], ['ram_gb', '内存（GB）', 'number'], ['storage_gb', '存储（GB）', 'number'], ['storage_type', '存储类型', 'text']] },
    price: { inputs: [['price', '费用', 'number']] },
    left: { cycle: 1 },
  },
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

// 多选：勾选并集实时存；同样可现场新建选项
function multiEditor(tab, it, td, k, save) {
  const col = COLS[tab][k];
  const raw = col.custom ? (it.extra || {})[k] : it[k];
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
  const order = ['', 'monthly', 'annual', 'biennial', 'triennial', 'quarterly', 'semiannual', 'weekly', 'days', 'lifetime'];
  box.insertAdjacentHTML('beforeend', `<div class="fp-form">
    <select class="mini-select fp-op" data-cycle>${order.map(c => `<option value="${c}"${c === (it.cycle || '') ? ' selected' : ''}>${c ? CYCLE_LABEL[c] : '—'}</option>`).join('')}</select>
    <input class="fp-q" type="number" min="1" data-days placeholder="天数" value="${esc(String(it.cycle_days ?? ''))}">
  </div><div class="cp-foot"><button type="button" class="btn primary mini">保存</button></div>`);
  const sel = box.querySelector('[data-cycle]');
  const days = box.querySelector('[data-days]');
  const syncDays = () => { days.hidden = sel.value !== 'days'; };
  sel.addEventListener('change', syncDays);
  syncDays();
  box.querySelector('.cp-foot button').onclick = () => {
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
  const save = v => patchRow(tab, it, col.custom ? extraPatch(it, k, v) : { [spec.f || k]: v });
  if (spec.cycle) return cycleEditor(tab, it, td);
  if (spec.inputs) return inputsEditor(tab, it, td, spec.inputs, patch => patchRow(tab, it, patch));
  if (t === 'sel' || t === 'status') return pickEditor(tab, it, td, k, save);
  if (t === 'star') return starEditor(tab, it, td, k, save);
  if (t === 'multi') {
    return multiEditor(tab, it, td, k, sel => {
      if (col.custom) return patchRow(tab, it, extraPatch(it, k, sel));
      if ((NATIVE_ARR[tab] || []).includes(k)) return patchRow(tab, it, { [k]: sel });
      return patchRow(tab, it, { [k]: sel.join(', ') }); // 文本列的多选呈现：拼回字符串
    });
  }
  const f = spec.f || k;
  const type = t === 'num' ? 'number' : t === 'date' ? 'date' : 'text';
  return inputsEditor(tab, it, td, [[f, colLabel(tab, k), type]], patch => {
    if (col.custom) return patchRow(tab, it, extraPatch(it, k, patch[f] ?? ''));
    return patchRow(tab, it, patch);
  });
}

// 点击委托：按钮/链接照旧，其余格子进就地编辑
for (const [tab, sel] of Object.entries({ subs: '#subs-body', sims: '#sims-body', vps: '#vps-body', media: '#m-body' })) {
  $(sel).addEventListener('click', e => {
    if (e.target.closest('button, a, input, select, textarea, label')) return;
    const td = e.target.closest('td');
    if (!td || !td.dataset.k || td.dataset.k === 'ops') return;
    const it = state[tab].find(x => x.id === +td.closest('tr').dataset.id);
    if (it) openCellPop(tab, it, td.dataset.k, td);
  });
}

/* ── 订阅表（Notion 式子行：服务→套餐档位可折叠，比价一目了然）── */
function renderSubs() {
  const tb = $('#subs-body');
  tb.innerHTML = '';
  const byId = Object.fromEntries(state.subs.map(x => [x.id, x]));
  const base = state.subs.length;
  let rows = applyView('subs', state.subs);
  if (!views.subs.sort) rows = [...rows].sort((a, b) => cmpZh(a.name, b.name));
  // 父行可见则子行吸附其下（受折叠控制）；父行被筛掉的子行原位平铺、保留归属前缀
  const vis = new Set(rows.map(r => r.id));
  const kids = new Map();
  const top = [];
  for (const r of rows) {
    if (r.parent_id && vis.has(r.parent_id)) {
      if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
      kids.get(r.parent_id).push(r);
    } else {
      top.push(r);
    }
  }
  const collapsed = new Set(views.subs.collapsed || []);
  setEmpty('#subs-empty', rows.length, base);
  const logoOf = r => r.logo || (r.parent_id && byId[r.parent_id]?.logo) || '';
  const emit = (it, depth) => {
    const parent = it.parent_id ? byId[it.parent_id] : null;
    const hasKids = kids.has(it.id);
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    if (depth) tr.classList.add('subrow');
    tr.innerHTML = `
      <td>${hasKids ? `<button class="tgl" data-tgl type="button" title="折叠 / 展开子行">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : ''}${(!depth && parent) ? `<span class="sub-parent">${esc(parent.name)} ↳ </span>` : ''}${logoOf(it) ? `<img class="slogo" src="/logos/${esc(logoOf(it))}" alt="" loading="lazy">` : ''}${esc(it.name)}
        ${safeUrl(it.url) ? ` <a class="btn link" href="${esc(safeUrl(it.url))}" target="_blank" rel="noreferrer">↗</a>` : ''}<button class="rowopen" data-open type="button" title="打开详情">⤢</button></td>
      <td>${stPill(it.status)}</td>
      <td>${cellVal('subs', 'category', it.category)}</td>
      <td class="amt">${esc(money(it.currency, it.price))}</td>
      <td>${cellVal('subs', 'currency', it.currency)}</td>
      <td>${cellVal('subs', 'cycle', cycleText(it))}</td>
      <td class="cdate">${esc(it.next_renewal || '')}</td>
      <td>${cellVal('subs', 'payment_method', it.payment_method)}</td>
      <td class="muted clip" title="${esc(it.notes || '')}">${cellVal('subs', 'notes', it.notes)}</td>
      ${customTds('subs', it)}<td class="ops">
        ${it.status === 'Active' && it.next_renewal ? `<button class="btn link" data-renew type="button">记续费</button>` : ''}
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-open]').onclick = () => openSubDialog(it);
    tr.querySelector('[data-del]').onclick = () => delItem('subscriptions', it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`subscription:${it.id}`);
    const tg = tr.querySelector('[data-tgl]');
    if (tg) tg.onclick = () => {
      const c = new Set(views.subs.collapsed || []);
      if (c.has(it.id)) c.delete(it.id);
      else c.add(it.id);
      views.subs.collapsed = [...c];
      saveViews();
      renderSubs();
    };
    tb.appendChild(tr);
  };
  for (const it of top) {
    emit(it, 0);
    if (kids.has(it.id) && !collapsed.has(it.id)) {
      for (const c of kids.get(it.id)) emit(c, 1);
    }
  }
  syncTable('subs');
}

/* ── SIM 表 ── */
function renderSims() {
  const tb = $('#sims-body');
  tb.innerHTML = '';
  const base = state.sims.length;
  const rows = applyView('sims', state.sims);
  setEmpty('#sims-empty', rows.length, base);
  for (const it of rows) {
    let barHtml = '<span class="muted">—</span>';
    const left = simLeft(it);
    if (left != null) {
      const elapsed = it.cycle_days - left;
      const pct = Math.min(100, Math.max(0, elapsed / it.cycle_days * 100));
      const lbl = left < 0 ? `已超期 ${-left} 天` : `剩 ${left} 天 / ${it.cycle_days}`;
      barHtml = `<div class="bar"><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="lbl">${lbl}</div></div>`;
    }
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    tr.innerHTML = `
      <td>${esc(it.name)}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${it.phone_number ? `<div class="muted" style="font-size:.75rem">${esc(it.phone_number)}</div>` : ''}</td>
      <td>${tagsFor('sims', 'forms', it.forms)}</td>
      <td>${stPill(it.status)}</td>
      <td class="cdate">${esc(it.last_renewed || '')}</td>
      <td class="wide">${barHtml}</td>
      <td class="muted clip" title="${esc(it.keepalive_action || '')}">${cellVal('sims', 'keepalive_action', it.keepalive_action)}</td>
      ${customTds('sims', it)}<td class="ops">
        ${it.status === 'Active' ? `<button class="btn link" data-renew type="button">已保号</button>` : ''}
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-open]').onclick = () => openSimDialog(it);
    tr.querySelector('[data-del]').onclick = () => delItem('sims', it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`sim:${it.id}`);
    tb.appendChild(tr);
  }
  syncTable('sims');
}

/* ── VPS 表 ── */
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function vpsDue(it) {
  if (!it.last_renewed) return null;
  const last = new Date(it.last_renewed + 'T00:00:00');
  if (it.cycle === 'weekly') return new Date(last.getTime() + 7 * 864e5);
  if (it.cycle === 'days') return it.cycle_days > 0 ? new Date(last.getTime() + it.cycle_days * 864e5) : null;
  const months = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12, biennial: 24, triennial: 36 }[it.cycle];
  return months ? addMonths(last, months) : null;
}

function renderVps() {
  const tb = $('#vps-body');
  tb.innerHTML = '';
  const base = state.vps.length;
  const rows = applyView('vps', state.vps);
  setEmpty('#vps-empty', rows.length, base);
  const today = todayDate();
  for (const it of rows) {
    const due = vpsDue(it);
    let barHtml = '<span class="muted">—</span>';
    if (due) {
      const last = new Date(it.last_renewed + 'T00:00:00');
      const total = Math.round((due - last) / 864e5);
      const elapsed = Math.floor((today - last) / 864e5);
      const left = total - elapsed;
      const pct = Math.min(100, Math.max(0, elapsed / total * 100));
      const lbl = left < 0 ? `已超期 ${-left} 天` : `剩 ${left} 天 / ${total}`;
      barHtml = `<div class="bar"><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="lbl">${lbl}</div></div>`;
    }
    const routes = (it.routes || []).join(' / ');
    const cyc = cycleText(it);
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    tr.innerHTML = `
      <td>${esc(it.vendor)}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${it.product ? `<div class="muted" style="font-size:.75rem">${esc(it.product)}</div>` : ''}</td>
      <td>${stPill(it.status)}</td>
      <td>${tagsFor('vps', 'locations', it.locations)}</td>
      <td>${cellVal('vps', 'purpose', it.purpose)}</td>
      <td class="cdate">${cellVal('vps', 'spec', vpsSpec(it))}</td>
      <td class="clip" title="${esc(routes)}">${tagsFor('vps', 'routes', it.routes)}</td>
      <td class="amt">${esc(money(it.currency, it.price))}${cyc ? `<div class="muted" style="font-size:.72rem">${esc(cyc)}</div>` : ''}</td>
      <td>${cellVal('vps', 'currency', it.currency)}</td>
      <td class="cdate">${esc(it.last_renewed || '')}</td>
      <td class="wide">${barHtml}</td>
      ${customTds('vps', it)}<td class="ops">
        ${(it.status === 'Active' || it.status === 'Ending') ? `<button class="btn link" data-renew type="button">已续费</button>` : ''}
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-open]').onclick = () => openVpsDialog(it);
    tr.querySelector('[data-del]').onclick = () => delItem('vps', it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`vps:${it.id}`);
    tb.appendChild(tr);
  }
  syncTable('vps');
}

let editingVps = null;
const V_STR = ['vendor', 'product', 'status', 'purpose', 'storage_type', 'extra_storage',
  'currency', 'cycle', 'last_renewed', 'url', 'account', 'notes'];
const V_NUM = ['cores', 'ram_gb', 'storage_gb', 'port_gbps', 'traffic_tb', 'price', 'cycle_days'];

function openVpsDialog(it) {
  editingVps = it || null;
  const form = $('#form-vps');
  form.reset();
  $('#dlg-vps-title').textContent = it ? '编辑 VPS' : '新增 VPS';
  const f = form.elements;
  if (it) {
    for (const k of V_STR) f[k].value = it[k] ?? '';
    for (const k of V_NUM) f[k].value = it[k] ?? '';
    f.ipv6.checked = it.ipv6 === 1;
    f.locations.value = (it.locations || []).join(', ');
    f.routes.value = (it.routes || []).join(', ');
  }
  syncVpsCycleDays();
  $('#dlg-vps').showModal();
}

function syncVpsCycleDays() {
  $('#vps-cycle-days').hidden = $('#form-vps').elements.cycle.value !== 'days';
}

$('#form-vps').elements.cycle.addEventListener('change', syncVpsCycleDays);
$('#form-vps').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {};
  for (const k of V_STR) body[k] = f[k].value;
  for (const k of V_NUM) body[k] = f[k].value === '' ? undefined : +f[k].value;
  body.currency = f.currency.value.toUpperCase();
  body.ipv6 = f.ipv6.checked ? 1 : 0;
  const splitArr = v => v.split(/[,，、]+/).map(x => x.trim()).filter(Boolean);
  body.locations = splitArr(f.locations.value);
  body.routes = splitArr(f.routes.value);
  try {
    if (editingVps) await api(`/api/vps/${editingVps.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/vps', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-vps').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

async function delItem(kind, it) {
  if (!confirm(`删除「${it.name || it.vendor || it.title || ''}」？此操作不可撤销。`)) return;
  try {
    await api(`/api/${kind}/${it.id}`, { method: 'DELETE' });
    toast('已删除');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 订阅表单 ── */
let editingSub = null;
function openSubDialog(it) {
  editingSub = it || null;
  const f = $('#form-sub');
  f.reset();
  $('#dlg-sub-title').textContent = it ? '编辑订阅' : '新增订阅';
  const sel = f.elements.parent_id;
  sel.innerHTML = '<option value="">—</option>';
  for (const s of state.subs) {
    if (it && s.id === it.id) continue;
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  if (it) {
    for (const k of ['name', 'category', 'status', 'currency', 'cycle', 'next_renewal', 'payment_method', 'account', 'url', 'notes']) {
      f.elements[k].value = it[k] ?? '';
    }
    f.elements.price.value = it.price ?? '';
    f.elements.cycle_days.value = it.cycle_days ?? '';
    f.elements.parent_id.value = it.parent_id ?? '';
  }
  const lv = $('#sub-logo-view');
  const lc = $('#sub-logo-clear');
  lv.hidden = !(it && it.logo);
  lc.hidden = !(it && it.logo);
  if (it && it.logo) lv.src = `/logos/${it.logo}`;
  lc.onclick = async () => {
    if (!confirm('清除该服务的 logo？')) return;
    try {
      await api(`/api/subscriptions/${it.id}/logo`, { method: 'DELETE' });
      it.logo = null;
      lv.hidden = true;
      lc.hidden = true;
      await loadAll();
    } catch (err) { toast(err.message, true); }
  };
  syncCycleDays();
  $('#dlg-sub').showModal();
}

function syncCycleDays() {
  $('#row-cycle-days').hidden = $('#form-sub').elements.cycle.value !== 'days';
}

$('#form-sub').elements.cycle.addEventListener('change', syncCycleDays);
$('#form-sub').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    name: f.name.value, category: f.category.value, status: f.status.value,
    price: f.price.value === '' ? undefined : +f.price.value,
    currency: f.currency.value.toUpperCase(), cycle: f.cycle.value,
    cycle_days: f.cycle_days.value === '' ? undefined : +f.cycle_days.value,
    next_renewal: f.next_renewal.value, payment_method: f.payment_method.value,
    account: f.account.value, url: f.url.value, notes: f.notes.value,
    logo: editingSub?.logo ?? '',
    parent_id: f.parent_id.value === '' ? undefined : +f.parent_id.value,
  };
  try {
    let id = editingSub?.id;
    if (editingSub) await api(`/api/subscriptions/${editingSub.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else id = (await api('/api/subscriptions', { method: 'POST', body: JSON.stringify(body) })).id;
    const lf = f.logo_file?.files?.[0];
    if (lf && id != null) {
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/x-icon': 'ico' })[lf.type]
        || lf.name.split('.').pop().toLowerCase();
      const up = await fetch(`/api/subscriptions/${id}/logo?ext=${encodeURIComponent(ext)}`, { method: 'POST', body: lf });
      if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || 'logo 上传失败');
    }
    $('#dlg-sub').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

/* ── SIM 表单 ── */
let editingSim = null;
function openSimDialog(it) {
  editingSim = it || null;
  const f = $('#form-sim');
  f.reset();
  $('#dlg-sim-title').textContent = it ? '编辑 SIM 卡' : '新增 SIM 卡';
  if (it) {
    for (const k of ['name', 'phone_number', 'status', 'keepalive_action', 'last_renewed', 'notes']) {
      f.elements[k].value = it[k] ?? '';
    }
    f.elements.cycle_days.value = it.cycle_days ?? '';
    for (const cb of f.querySelectorAll('input[name="forms"]')) {
      cb.checked = (it.forms || []).includes(cb.value);
    }
  }
  $('#dlg-sim').showModal();
}

$('#form-sim').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const el = f.elements;
  const body = {
    name: el.name.value, phone_number: el.phone_number.value, status: el.status.value,
    keepalive_action: el.keepalive_action.value,
    cycle_days: el.cycle_days.value === '' ? undefined : +el.cycle_days.value,
    last_renewed: el.last_renewed.value, notes: el.notes.value,
    forms: [...f.querySelectorAll('input[name="forms"]:checked')].map(x => x.value),
  };
  try {
    if (editingSim) await api(`/api/sims/${editingSim.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/sims', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-sim').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

/* ── 设置 ── */
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
        ? `<img loading="lazy" src="/covers/${esc(it.cover)}" alt="">`
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

function setStars(v) {
  $('#form-media').elements.rating.value = v || '';
  $('#m-stars').querySelectorAll('button[data-v]').forEach(b => {
    if (b.dataset.v) b.classList.toggle('lit', +b.dataset.v <= (+v || 0));
  });
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
$('#btn-add').onclick = () => {
  if (state.tab === 'subs') openSubDialog(null);
  else if (state.tab === 'sims') openSimDialog(null);
  else openVpsDialog(null);
};
document.querySelectorAll('.tab[data-tab]').forEach(b => b.onclick = () => {
  state.tab = b.dataset.tab;
  closePop();
  $('#t-search').value = views[state.tab].q || '';
  document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $('#view-subs').hidden = state.tab !== 'subs';
  $('#view-sims').hidden = state.tab !== 'sims';
  $('#view-vps').hidden = state.tab !== 'vps';
  applyWidths(state.tab); // 隐藏页里量不到自然宽，可见了补排
  renderViewPills(state.tab); // 共用的胶囊行切到当前表
});
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

let tSearchTimer;
$('#t-search').addEventListener('input', e => {
  clearTimeout(tSearchTimer);
  tSearchTimer = setTimeout(() => {
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
$('#t-search').value = views.subs.q || '';
$('#m-sort').value = views.media.sort?.key || 'marked';

async function boot() {
  for (const tab of ['subs', 'sims', 'vps', 'media']) {
    THEAD_HTML[tab] = $(HEAD_SEL[tab]).rows[0].innerHTML; // 模板快照，rebuildHead 用
  }
  try {
    await refreshFields();
  } catch (e) { toast('字段注册加载失败：' + e.message, true); }
  for (const tab of ['subs', 'sims', 'vps', 'media']) {
    injectCustomCols(tab);
    initHead(tab);
  }
  await loadAll();
}

boot().catch(e => toast('加载失败：' + e.message, true));
