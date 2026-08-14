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
const TYPE_LABEL = { text: '文本', num: '数字', sel: '单选', multi: '多选', status: '状态', date: '日期', star: '星级', tel: '电话', url: '网址', email: '邮箱' };
const LIST_TYPES = ['sel', 'multi', 'status', 'star'];
// 拨号链接只留 + 与数字：href 里带空格/横杠时部分客户端会拨错
const telHref = v => 'tel:' + String(v).replace(/[^\d+]/g, '');
// 位数太少多半是只填了国家码这类残缺值。这里只标不拦——存量数据里就有，
// 在写入口 400 掉等于让人打不开自己的旧条目（后端同理，见 normalize_shaped）
const telSuspect = v => (String(v).match(/\d/g) || []).length < 5;
// 网址在格子里只显示域名：原始串常是带一长串查询参数的登录页，铺开会把整列撑爆
const urlHost = v => String(v).replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./, '');
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

/* 单元格值按有效类型呈现：文本原样 / 单选一枚标签 / 多选拆标签 / 星级星串 /
   有形状的三类渲染成可点链接（conv 列、库的列与媒体的自定义列共用这一份）。
   **tel/url/email 的渲染必须写在这里而不是各渲染器里**：库那侧 renderColl 走它，
   媒体的自定义列走 customTds → cellVal，两处写两份就会出现"同名同类型的列在媒体表
   是灰色纯文本、在续费库是可点链接"这种类型承诺只兑现一半的事。 */
function cellVal(tab, k, v) {
  if (v == null || v === '') return '';
  const t = colType(tab, k);
  if (t === 'multi') return tagsFor(tab, k, Array.isArray(v) ? v : splitVals(v));
  if (t === 'sel') return tagFor(tab, k, v);
  if (t === 'star') return starRow(+v);
  if (t === 'url') {
    const href = safeUrl(v);
    return href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(urlHost(v))} ↗</a>` : esc(String(v));
  }
  if (t === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (t === 'tel') {
    return `<a class="tel" href="${esc(telHref(v))}">${esc(v)}</a>`
      + (telSuspect(v) ? '<span class="tel-warn" title="位数偏少，可能只填了国家码">?</span>' : '');
  }
  return esc(String(v));
}

/* ── 自定义列（/api/fields，值挂在行的 extra JSON，键 c<id>）── */
const FKEY = f => 'c' + f.id;
const customFields = tab => state.fields
  .filter(f => f.tbl === tab && !f.builtin)
  .sort((a, b) => a.pos - b.pos || a.id - b.id);
const fieldOf = (tab, k) => state.fields.find(f => f.tbl === tab && f.key === k);
// 值挂在行的 extra 里还是顶层：库的列看注册表的 src，媒体的自定义列看 custom。
// 这也是"这列归不归用户管"的判据——改名/删除只对 extra 列开放，与后端一致。
const inExtra = col => (col.src ? col.src === 'extra' : !!col.custom);

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
  rebuildMediaHead();
  RENDER[tab]();
}

// 媒体表的表头走模板快照那条老路：先还原成模板再注入，不能直接重入 injectCustomCols
//（它只追加 th、不清旧的，重入一次多一列）
function rebuildMediaHead() {
  const thead = $(HEAD_SEL.media);
  thead.rows[0].innerHTML = THEAD_HTML.media;
  thead.closest('.tablewrap').querySelector('.newrow')?.remove();
  injectCustomCols('media');
  initHead('media');
}

/* 媒体的自定义列此前只在 boot 与 rebuildHead 各注入过一次，而 loadAll 每次都刷字段
   注册表：别处（另一台设备、另一个标签页，或直接调接口）加了列之后，这边下一次
   loadAll 就会拿着旧 COLS 去渲染新字段，`colType` 读到 undefined 直接把整个 renderAll
   打断——界面停在半路。库那边由 syncColls → ensureCollDom 兜着，这是对称的那一半。 */
function syncMediaCols() {
  const want = customFields('media').map(FKEY).join();
  const have = Object.keys(COLS.media).filter(k => COLS.media[k].custom).join();
  if (want !== have) rebuildMediaHead();
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
const M_DIR_DEFAULT = { pos: 1, marked: -1, year: -1, rating: -1, douban: -1, title: 1 };

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
  tel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M5.2 2.4 6.6 5 5.3 6.6c.8 1.7 2.4 3.3 4.1 4.1L11 9.4l2.6 1.4v2.4c0 .5-.4.9-.9.8C7.2 13.5 2.5 8.8 1.8 3.3c-.1-.5.3-.9.8-.9z"/></svg>',
  url: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.6 8.7a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/></svg>',
  email: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2" y="3.6" width="12" height="8.8" rx="1.4"/><path d="m2.6 4.4 5.4 4 5.4-4"/></svg>',
};

// 各表列键的模板序快照（tbody 渲染恒为模板序，td 定位靠它；列序重排只动 thead/td 的 DOM 序）
const TKEYS = {};
const colKeys = tab => TKEYS[tab];

/* 本机视图偏好对着当前列集结算一次：列集变了做温和迁移、名称列无条件捞回、筛选清洗。

   **它与"重建表头"是两个节奏**：表头只在列集真的变了时才重建（见 ensureCollDom），
   而偏好来自 localStorage——可能是另一台设备、另一个标签页写的，也可能是这套代码从前
   放行过的坏值（隐藏名称列就是），所以每次渲染都要结算一遍。 */
function settleView(tab, keys) {
  const v = views[tab];
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
  // 表头菜单曾经放行过隐藏名称列，已经踩下去的人光靠上面那段迁移救不回来（列集没变，
  // 不走温和迁移那一支），所以每次都无条件把它捞出来
  if (v.hiddenCols?.includes('name')) v.hiddenCols = v.hiddenCols.filter(k => k !== 'name');
  v.keys = keys;
  saveViews();
  sanitizeFilters(tab);
}

function initHead(tab) {
  const thead = $(HEAD_SEL[tab]);
  const ths = thead.querySelectorAll('th');
  settleView(tab, [...ths].map(t => t.dataset.k));
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
    // 属性菜单是排序/筛选/改列/删列的唯一入口，只挂 click 就等于键盘用户全够不着。
    // th 不是原生可聚焦元素，得自己给 tabindex 与语义，并把回车/空格接成"点一下"
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    th.setAttribute('aria-haspopup', 'menu');
    th.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // 空格默认滚动页面
      openHeadMenu(tab, th);
    });
    th.classList.add('th-sort');
    th.appendChild(Object.assign(document.createElement('span'), { className: 'sind' }));
  });
  // Notion 式表尾新建行
  const nr = document.createElement('div');
  nr.className = 'newrow';
  nr.textContent = '＋ 新建';
  nr.tabIndex = 0;
  nr.setAttribute('role', 'button');
  nr.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    nr.click();
  });
  nr.onclick = () => addRowInline(tab);
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
  for (const px of fitted.values()) total += px;
  // 压到下限还是塞不进容器时，压缩只剩坏处：横滚照样免不了，却把每一列都挤成省略号
  //（390px 视口实测：九列全被压到 52px，表宽仍有 573px 要滚）。这时退回自然列宽——
  // 滚是要滚的，至少每一格读得出来。判据是几何而不是视口阈值，桌面端的宽表同样受用。
  if (total > avail + 1) return;
  for (const [t, px] of fitted) t.style.width = px + 'px';
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
  markFirstCol(tab);
}

/* ── 行首浮标：多选与手动排序（Notion 式）────────────────────────────────
   浮标不是一列，是首格左内边距里的两个控件：⠿ 拖动手柄 + 复选框。做成真列的话
   列宽三律、列序存储、隐藏列全都要再认一个新键，而它本就不是数据。
   手动序的真源是后端的 items.pos / media_items.pos，只在「没按任何列排序」时生效；
   按列排序时拖动的位置存不住，手柄随之停用（Notion 同款）。 */

const tbodyOf = tab => $(HEAD_SEL[tab])?.parentElement.tBodies[0] || null;
const curTab = () => (state.page === 'media' ? 'media' : state.tab);
const byPos = (a, b) => (a.pos ?? 1e9) - (b.pos ?? 1e9) || a.id - b.id;
const manualOrder = tab =>
  tab === 'media' ? views.media.sort?.key === 'pos' : !views[tab].sort;

const rowSel = {};                                  // tab → Set(选中的 id)
const selOf = tab => (rowSel[tab] ||= new Set());

/* 首格 = 第一个没被隐藏的格。隐藏列只是 display:none、并没有从 DOM 里摘掉，所以
   ":first-child" 会落在看不见的格子上——吸附与浮标都得认这个算出来的 .c0。 */
function markFirstCol(tab) {
  const thead = $(HEAD_SEL[tab]);
  if (!thead) return;
  const rows = [thead.rows[0], ...(thead.parentElement.tBodies[0]?.rows || [])];
  for (const row of rows) {
    if (!row) continue;
    let first = null;
    for (const c of row.children) {
      c.classList.remove('c0');
      if (!first && c.style.display !== 'none') first = c;
    }
    if (!first) continue;
    first.classList.add('c0');
    ensureGutter(tab, row, first, row.parentElement.tagName === 'THEAD');
  }
}

function ensureGutter(tab, row, cell, head) {
  let g = row.querySelector('.rowgut');
  if (g) {
    if (g.parentElement !== cell) cell.prepend(g); // 列序变了，浮标跟到新的首格里
    return;
  }
  g = document.createElement('span');
  g.className = 'rowgut';
  g.innerHTML = head
    ? '<input class="rgsel" type="checkbox" data-selall aria-label="全选本表">'
    // 手柄不进 Tab 序——一行一个停靠点已经够多了；键盘改用复选框上的 Alt+↑ / Alt+↓
    + ''
    // ⠿ 由 CSS ::before 画，不写成按钮文本——浮标住在名称格里，写成文本就会混进
    // td.textContent，行文本从此永远带一个 ⠿（复制整行、断言取值都会看见）
    : '<button class="rgrip" data-grip type="button" tabindex="-1" aria-label="拖动排序"></button>'
    + '<input class="rgsel" type="checkbox" data-sel aria-label="选择此行">';
  cell.prepend(g);
  head ? bindSelectAll(tab, g) : bindRowGutter(tab, row, g);
}

function bindSelectAll(tab, g) {
  const box = g.querySelector('[data-selall]');
  box.onclick = e => e.stopPropagation();       // 表头点击会开属性菜单
  box.onchange = () => {
    const s = selOf(tab);
    for (const tr of tbodyOf(tab)?.rows || []) {
      box.checked ? s.add(+tr.dataset.id) : s.delete(+tr.dataset.id);
    }
    syncSelUI(tab);
  };
}

let rowDrag = null;   // {tab, id}

function bindRowGutter(tab, tr, g) {
  const id = +tr.dataset.id;
  const box = g.querySelector('[data-sel]');
  const grip = g.querySelector('[data-grip]');
  box.onchange = () => {
    box.checked ? selOf(tab).add(id) : selOf(tab).delete(id);
    syncSelUI(tab);
  };
  // 键盘走到复选框上时用 Alt+↑ / Alt+↓ 挪行——拖拽对键盘用户是够不着的
  box.onkeydown = e => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    nudgeRow(tab, id, e.key === 'ArrowUp' ? -1 : 1);
  };
  if (!manualOrder(tab)) {
    grip.classList.add('off');
    grip.title = tab === 'media' ? '排序选「手动」后才能拖动' : '清掉列排序后才能拖动';
    return;
  }
  grip.title = '拖动排序';
  grip.onmousedown = () => { tr.draggable = true; };
  tr.ondragstart = e => {
    if (!tr.draggable) return;
    rowDrag = { tab, id };
    e.dataTransfer.effectAllowed = 'move';
    closePop();
    tr.classList.add('rdrag');
  };
  tr.ondragover = e => {
    if (!rowDrag || rowDrag.tab !== tab || rowDrag.id === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = tr.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    tr.classList.toggle('drop-b', after);
    tr.classList.toggle('drop-a', !after);
  };
  tr.ondragleave = () => tr.classList.remove('drop-a', 'drop-b');
  tr.ondrop = e => {
    e.preventDefault();
    const after = tr.classList.contains('drop-b');
    tr.classList.remove('drop-a', 'drop-b');
    if (rowDrag?.tab === tab) applyRowOrder(tab, moveRow(tab, rowDrag.id, id, after));
  };
  tr.ondragend = () => {
    tr.draggable = false;
    for (const x of tbodyOf(tab)?.rows || []) x.classList.remove('rdrag', 'drop-a', 'drop-b');
    rowDrag = null;
  };
}

/* 全表（不经筛选）的手动序：顶层按 pos，子行紧跟各自的父行。
   落表的 pos 恒按这个形状写，所以「只重排看得见的那几行」不会把被筛掉的行挤乱。 */
function fullOrder(tab) {
  const all = [...(state[tab] || [])].sort(byPos);
  if (tab === 'media') return all;
  const has = new Set(all.map(r => r.id));
  const kids = new Map();
  const top = [];
  for (const r of all) {
    if (r.parent_id && has.has(r.parent_id)) {
      if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
      kids.get(r.parent_id).push(r);
    } else top.push(r);
  }
  return top.flatMap(r => [r, ...(kids.get(r.id) || [])]);
}

/// 把 src 挪到 tgt 之前/之后，返回全表的新 id 序；挪不了就返回 null。
function moveRow(tab, srcId, tgtId, after) {
  const list = fullOrder(tab);
  const has = new Set(list.map(r => r.id));
  const lvl = new Map(list.map(r => [r.id, r.parent_id && has.has(r.parent_id) ? 1 : 0]));
  const si = list.findIndex(r => r.id === srcId);
  const ti = list.findIndex(r => r.id === tgtId);
  if (si < 0 || ti < 0 || si === ti) return null;
  if (lvl.get(srcId) !== lvl.get(tgtId)) {
    toast('只能在同一层里排序', true);
    return null;
  }
  if (lvl.get(srcId) === 1 && list[si].parent_id !== list[ti].parent_id) {
    toast('子行只能在同一个父条目下排序', true);
    return null;
  }
  let len = 1;                                    // 顶层行连着它的子行整块搬
  if (!lvl.get(srcId)) while (si + len < list.length && lvl.get(list[si + len].id)) len++;
  const block = list.splice(si, len);
  let to = list.findIndex(r => r.id === tgtId);
  if (after) {
    to++;
    if (!lvl.get(tgtId)) while (to < list.length && lvl.get(list[to].id)) to++;
  }
  list.splice(to, 0, ...block);
  return list.map(r => r.id);
}

// 键盘挪行：在同级里与相邻的那一行交换位置
function nudgeRow(tab, id, step) {
  if (!manualOrder(tab)) {
    toast(tab === 'media' ? '排序选「手动」后才能挪行' : '清掉列排序后才能挪行', true);
    return;
  }
  const list = fullOrder(tab);
  const has = new Set(list.map(r => r.id));
  const lvl = r => (r.parent_id && has.has(r.parent_id) ? 1 : 0);
  const i = list.findIndex(r => r.id === id);
  if (i < 0) return;
  const peers = list.filter(r => lvl(r) === lvl(list[i]) && r.parent_id === list[i].parent_id);
  const pi = peers.findIndex(r => r.id === id);
  const tgt = peers[pi + step];
  if (!tgt) return;
  applyRowOrder(tab, moveRow(tab, id, tgt.id, step > 0), id);
}

async function applyRowOrder(tab, ids, refocus) {
  if (!ids) return;
  const path = tab === 'media' ? '/api/media/order' : `/api/collections/${tab}/items/order`;
  try {
    await api(path, { method: 'PUT', body: JSON.stringify({ ids }) });
    // 本地同步 pos，省一次整表重取；渲染层无排序时就是按 pos 排
    const at = new Map(ids.map((x, n) => [x, n + 1]));
    for (const r of state[tab] || []) if (at.has(r.id)) r.pos = at.get(r.id);
    RENDER[tab]();
    if (refocus) tbodyOf(tab)?.querySelector(`tr[data-id="${refocus}"] [data-sel]`)?.focus();
  } catch (e) { toast(e.message, true); }
}

/* ── 选区 ── */
function syncSelUI(tab) {
  const tb = tbodyOf(tab);
  const s = selOf(tab);
  if (tb) {
    for (const id of [...s]) if (!tb.querySelector(`tr[data-id="${id}"]`)) s.delete(id);
    tb.closest('table')?.classList.toggle('selecting', s.size > 0);
    let shown = 0;
    for (const tr of tb.rows) {
      const on = s.has(+tr.dataset.id);
      if (on) shown++;
      tr.classList.toggle('selrow', on);
      const b = tr.querySelector('[data-sel]');
      if (b) b.checked = on;
    }
    const all = $(HEAD_SEL[tab])?.querySelector('[data-selall]');
    if (all) {
      all.checked = shown > 0 && shown === tb.rows.length;
      all.indeterminate = shown > 0 && shown < tb.rows.length;
    }
  }
  renderBulkBar();
}

function clearSel(tab) {
  selOf(tab).clear();
  syncSelUI(tab);
}

const clearAllSel = () => { for (const t of Object.keys(rowSel)) clearSel(t); };

function renderBulkBar() {
  const n = selOf(curTab()).size;
  $('#bulkbar').hidden = !n;
  if (n) $('#bulk-n').textContent = `已选 ${n} 项`;
}

$('#bulk-clear').onclick = () => clearSel(curTab());
$('#bulk-del').onclick = async () => {
  const tab = curTab();
  const ids = [...selOf(tab)];
  if (!ids.length) return;
  if (!confirm(`删除选中的 ${ids.length} 项？此操作不可撤销。`)) return;
  const path = tab === 'media' ? '/api/media/bulk_delete' : '/api/items/bulk_delete';
  try {
    await api(path, { method: 'POST', body: JSON.stringify({ ids }) });
    selOf(tab).clear();
    toast(`已删除 ${ids.length} 项`);
    await loadAll();
  } catch (e) { toast(e.message, true); }
};

/* 表尾「＋ 新建」：直接插一行空行、就地填（Notion 同款），不再弹表单。
   空名/空标题后端是放行的；新行落在手动序末尾，所以按列排序时它可能不在末尾。 */
async function addRowInline(tab) {
  try {
    const path = tab === 'media' ? '/api/media' : `/api/collections/${tab}/items`;
    const { id } = await api(path, { method: 'POST', body: JSON.stringify({}) });
    await loadAll();
    focusNewRow(tab, id);
  } catch (e) { toast(e.message, true); }
}

function focusNewRow(tab, id) {
  const tr = tbodyOf(tab)?.querySelector(`tr[data-id="${id}"]`);
  if (!tr) return void toast('新行建好了，但被当前的筛选或搜索挡住了');
  const open = () => {
    const cells = [...tr.children].filter(td => td.style.display !== 'none');
    const td = cells.find(x => x.dataset.k === 'name' || x.dataset.k === 'title') || cells[0];
    const it = state[tab]?.find(x => x.id === id);
    if (td && it) openCellPop(tab, it, td.dataset.k, td);
  };
  const r = tr.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= innerHeight) return open();
  // 全局的 scroll 监听会关掉浮层（浮层是 fixed 的，滚动后就脱离锚点了），而
  // scrollIntoView 派发 scroll 事件是异步的——先开编辑器的话会被自己这一下滚动关掉。
  // 滚动事件在「更新渲染」里排在 rAF 回调之前，所以等一帧就够。
  tr.scrollIntoView({ block: 'nearest' });
  requestAnimationFrame(open);
}

// 每张表渲染完的收尾：列隐藏/列序、表宽对账、表头指示、视图胶囊行一次做齐
function syncTable(tab) {
  applyColumns(tab);
  applyWidths(tab); // 隐藏/恢复列后表宽必须重算，否则 fixed 布局把差额摊给其余列
  syncHeads(tab);
  renderViewPills(tab);
  syncSelUI(tab); // 行是每次渲染重建的，勾选态要照着选区补回来
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

// 操作符型筛选（非列表型的一切）：操作符下拉 + 值输入
const OP_MENU = {
  text: [['has', '包含'], ['not', '不包含'], ['empty', '为空'], ['nonempty', '非空']],
  num: [['eq', '='], ['ne', '≠'], ['ge', '≥'], ['le', '≤'], ['gt', '>'], ['lt', '<'], ['empty', '为空'], ['nonempty', '非空']],
  date: [['is', '等于'], ['before', '早于'], ['after', '晚于'], ['empty', '为空'], ['nonempty', '非空']],
};
/* 字段类型 → 操作符组。**这张表要认全部非列表型类型，别只列 OP_MENU 的三个键**：
   tel/url/email 的值就是文本，共用 text 那套；漏接的类型会让 OP_MENU[t] 是 undefined，
   `OP_MENU[t][0][0]` 当场 TypeError——浮层不出现、无任何提示，而排序还照常，
   于是「所有列都可排序可筛选」这条不变量对新类型静默失守。filterPred 那侧一直是兜底
   走文本分支的，所以只差这一层映射。 */
const opKind = t => (t === 'num' || t === 'date' ? t : 'text');

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
  popEl.appendChild(LIST_TYPES.includes(t) ? listFilterBody(tab, k, t) : opFilterBody(tab, k, opKind(t)));
  popEl.querySelector('[data-clear]').onclick = () => {
    setFilter(tab, k, null);
    closePop();
  };
  placePop(popEl, anchor);
}

/* ── 字段属性编辑：选项管理 / 自定义列的改名删除新建 ──
   能管选项的列 = 任何域字段或自定义列里的 sel|multi（判据与后端 resolve() 一致：builtin=0）；
   状态/周期/类别等参与语义的词表不开放。
   预置三库的域字段此前不算（builtin=1），只能靠一张硬编码白名单逐个点名；迁移 0014 把它们
   收归 builtin=0 之后白名单两边一起删了。 */
const optionsEditable = (tab, k) => !!COLS[tab][k].custom
  && ['sel', 'multi'].includes(COLS[tab][k].t);

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
      ${['text', 'num', 'sel', 'multi', 'date', 'star', 'tel', 'url', 'email'].map(t => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('')}
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
  // 名称列不给隐藏：行的 ⤢ 详情入口与子行折叠钮都长在这一格里，撤掉它整库就没了全表单入口。
  // 后端 PUT /api/fields/{id} 同样拒绝把它设成 shown=0，这里是本机视图那条口子。
  if (k !== 'name') {
    items.push({ ic: '⊘', t: '隐藏此列', act: () => {
      v.hiddenCols = [...(v.hiddenCols || []), k];
      saveViews();
      RENDER[tab]();
    } });
  }
  if (Object.keys(v.widths || {}).length) {
    items.push({ ic: '⟺', t: '还原列宽', act: () => { v.widths = {}; saveViews(); applyWidths(tab); } });
  }
  // 值挂在 extra 里的列都归用户管——手加的自定义列，以及建库时按模板播下来的域字段。
  // 判据用 src 而不是 builtin：预置库的分类/地点/规格参数一样是域字段，凭什么不能改名删除；
  // 引擎真列（价格/周期/到期日）与算出来的列没有这两项，后端也只认 src='extra'。
  if (inExtra(COLS[tab][k])) {
    const fid = fieldOf(tab, k)?.id;
    items.push({ sep: 1 });
    items.push({ ic: '✎', t: '重命名列', act: () => openRenameColPop(tab, k, th), keepPop: true });
    items.push({ ic: '✕', t: '删除列', act: async () => {
      if (!confirm(`删除列「${th.dataset.label}」？该列在所有行的值将被清除，不可撤销。`)) return;
      if (await fieldCall(`/api/fields/${fid}`, 'DELETE', {})) await rebuildHead(tab);
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

/* ── 点格即编：点单元格就地编辑，保存 = 一次 PATCH（只发这次动过的键）──
   复合格（名称/商家产品/规格/周期）弹多输入迷你表单；表外字段仍走「编辑」全表单。 */

/* 后端是局部更新语义：请求里**出现**的键写入（`""` 与 `null` 都表示清空），
   **缺席**的键保持原值；`extra` 作为一个整体值走同一条规则。

   所以这里只发改动的那几个键，不必再把整行铺一遍。**但清空必须显式写 `null`**——
   `JSON.stringify` 会把 `undefined` 连键一起丢掉，在这套语义里那等于"别动它"。

   （从前这里是整行 PUT：body 漏一列就清一列，于是每条写入路径都得先铺整行、再让当前值
   覆盖，只要有一处没铺到就是一次静默的数据丢失——SIM 的周期、媒体的自定义列、条目图标、
   父条目都这样被清掉过。缺席即保持之后，那套铺底代码就没有存在的理由了。） */
async function patchRow(tab, it, patch) {
  try {
    const path = tab === 'media' ? `/api/media/${it.id}` : `/api/items/${it.id}`;
    await api(path, { method: 'PATCH', body: JSON.stringify(patch) });
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
  // 单输入时浮层标题已经是列名了，格内再标一次就是「价格」上下各一遍；
  // 复合格（媒体的标题 / 又名）两个输入名字不同，那才需要各自的标签
  const labelled = fieldsDef.length > 1;
  for (const [f, label, type] of fieldsDef) {
    const wrap = document.createElement('label');
    wrap.className = 'cp-field';
    const val = f in it ? it[f] : (it.extra || {})[td.dataset.k];
    wrap.innerHTML = `${labelled ? esc(label) : ''}<input class="fp-q" type="${type}" ${type === 'number' ? 'step="any"' : ''} data-f="${esc(f)}">`;
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
      // 数字栏清空要显式写 null：undefined 会被 JSON.stringify 丢掉，
      // 而键缺席在 PATCH 语义里是"保持原值"，清空就失效了
      patch[inp.dataset.f] = inp.type === 'number'
        ? (inp.value === '' ? null : +inp.value)
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
    // 天数清空写 null（键缺席＝保持原值，见 patchRow）
    const patch = { cycle: sel.value, cycle_days: days.value === '' ? null : +days.value };
    closePop();
    patchRow(tab, it, patch);
  };
  placePop(box, td);
}

/* 币种候选：数据里用过的 ∪ 汇率表里有的。词表本就从数据里长，汇率表只是让空库首装时
   也有东西可选（否则第一条得先手打一个 ISO 码）。 */
function currencyOptions(tab, cur) {
  const used = new Set((state[tab] || []).map(r => fxCode(r.currency)).filter(Boolean));
  if (cur) used.add(fxCode(cur));
  const rest = Object.keys(state.fx?.rates || {}).filter(c => !used.has(c));
  return [...[...used].sort(), ...rest];
}

/* 币种控件：下拉 + 「新选项，回车加入」，与表单里的 sel 字段同一套（`.sopts`/`initSoptAdd`）。
   这里曾经是个纯 `<select>`，候选只有"用过的 ∪ 汇率表里有的"——于是持有 TWD、AED 这类
   不在欧洲央行那 30 种里的币种时，界面上根本没法录第一笔：要么不填币种（那笔钱从此不进
   支出总额，见 `engine::uncounted`），要么填个别的。
   **不用 datalist**：那条路 2026-08-06 拍板否过——iOS Safari 上建议列表会盖住输入框，
   而全 iOS 都是 WebKit，嗅探不掉。同一个问题在这个项目里已经有惯用解，就别造第二种。 */
function currencyPicker(tab, cur, attrs) {
  const opts = currencyOptions(tab, cur);
  return `<span class="sopts"><select class="mini-select" ${attrs}><option value="">—</option>${
    opts.map(c => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('')
  }</select><input class="sopt-add cur-add" placeholder="新币种，回车加入" maxlength="8"></span>`;
}

/* 费用格是复合格：金额 + 币种（币种不再单独占一列，2026-08-07 合并）。
   与周期那格同一形状——按列键special case，不为此新造一种字段类型。 */
function priceEditor(tab, it, td) {
  const box = cellPopShell(td, colLabel(tab, 'price'));
  const cur = fxCode(it.currency);
  box.insertAdjacentHTML('beforeend', `<div class="fp-form">
    <input class="fp-q" type="number" step="any" data-price placeholder="金额" value="${esc(String(it.price ?? ''))}">
    ${currencyPicker(tab, cur, 'data-cur')}
  </div><div class="cp-foot"><button type="button" class="btn primary mini">保存</button></div>`);
  initSoptAdd(box.querySelector('.cur-add'), fxCode);
  const amt = box.querySelector('[data-price]');
  const sel = box.querySelector('[data-cur]');
  const commit = () => {
    closePop();
    // 清空一律显式 null：键缺席在 PATCH 语义里是"保持原值"（见 patchRow）
    patchRow(tab, it, {
      price: amt.value === '' ? null : +amt.value,
      currency: fxCode(sel.value) || null, // 手打的 usd 一律存成 USD
    });
  };
  box.querySelector('.cp-foot button').onclick = commit;
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    // 「新币种」框里的回车是"把它加进候选"，不是"保存"——不放行的话这一格里的回车
    // 会被这条监听抢走，浮层当场关掉，刚打的币种一次都存不进去
    if (e.target.classList.contains('sopt-add')) return;
    commit();
  });
  placePop(box, td);
  amt.focus();
}

// 模板列（VPS 规格）的就地编辑：值本身分散在几个真字段里，这里把它们凑成一个格子编辑。
// 每个部分的标签、类型、选项都来自字段注册表——模板串只声明"要哪几项、怎么排版"。
function tplEditor(tab, it, td, f) {
  const parts = tplKeys(f).map(k => fieldOf(tab, k)).filter(Boolean);
  if (!parts.length) return openItemDialog(tab, it); // 模板串指向的字段都没了，退回详情表单
  const box = cellPopShell(td, f.name || f.key);
  for (const p of parts) {
    // 值按注册表的 src 取：模板串引用真列键是允许的定制（CLAUDE.md 明说"改模板串即可"），
    // 恒读写 extra 的话保存一次就在 extra 里生出一个同名键，把真列**遮蔽**掉——
    // 规格格从此显示 extra 的那份，而费用列与 engine 读的仍是真列，两格各说各话
    const cur = fieldRaw(p, it) ?? '';
    const wrap = document.createElement('label');
    wrap.className = 'cp-field';
    const attrs = `data-f="${esc(p.key)}" data-src="${esc(p.src || 'extra')}"`;
    if (p.ftype === 'sel') {
      const opts = fieldOptions(tab, p);
      if (cur !== '' && !opts.includes(String(cur))) opts.unshift(String(cur));
      wrap.innerHTML = `${esc(p.name || p.key)}<select class="mini-select" ${attrs}>`
        + `<option value=""></option>`
        + opts.map(o => `<option${String(o) === String(cur) ? ' selected' : ''}>${esc(o)}</option>`).join('')
        + `</select>`;
    } else {
      const type = p.ftype === 'num' ? 'number' : p.ftype === 'tel' ? 'tel' : 'text';
      wrap.innerHTML = `${esc(p.name || p.key)}<input class="fp-q" type="${type}"`
        + `${type === 'number' ? ' step="any"' : ''} ${attrs}>`;
      wrap.querySelector('input').value = cur;
    }
    box.appendChild(wrap);
  }
  const foot = document.createElement('div');
  foot.className = 'cp-foot';
  foot.innerHTML = '<button type="button" class="btn primary mini">保存</button>';
  box.appendChild(foot);
  const commit = () => {
    const ex = { ...(it.extra || {}) };
    const cols = {};
    for (const el of box.querySelectorAll('[data-f]')) {
      const v = el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value;
      const k = el.dataset.f;
      if (el.dataset.src === 'col') { cols[k] = v === '' ? null : v; continue; }
      if (v === '' || v == null) delete ex[k];
      else ex[k] = v;
    }
    closePop();
    patchRow(tab, it, { ...cols, extra: ex });
  };
  foot.querySelector('button').onclick = commit;
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') commit(); });
  placePop(box, td);
  box.querySelector('input,select')?.focus();
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
  // 模板列（VPS 规格）虽然是算出来的，但它的每一部分都是可写的真字段——
  // 点它就地把整套改完，不必为了改个内存开一次详情表单
  const fdef = fieldOf(tab, k);
  if (fdef?.ftype === 'tpl') return tplEditor(tab, it, td, fdef);
  // 其余算出来的列（剩余天数）没有可写的源，点它开详情表单
  if (col.src === 'calc') return openItemDialog(tab, it);
  // 周期是复合格：周期枚举 + 自定义天数
  if (k === 'cycle') return cycleEditor(tab, it, td);
  // 费用也是：金额 + 币种（币种并进了这一格，不再单独占一列）
  if (k === 'price' && col.src === 'col') return priceEditor(tab, it, td);
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
  const type = t === 'num' ? 'number' : t === 'date' ? 'date' : t === 'tel' ? 'tel' : t === 'url' ? 'url' : t === 'email' ? 'email' : 'text';
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

/* ── 设置页 ── */
/* 设置页的币种折算那一栏。候选＝汇率表里有的 ∪ 数据里用过的（后者可能没有报价，
   仍然让它出现在下拉里，选中后界面会如实说"这个币种没有汇率"而不是悄悄漏掉）。 */
function syncFxPanel() {
  const fx = state.fx || { rates: {}, live: [] };
  const used = new Set();
  for (const c of colls()) for (const r of state[c.key] || []) if (r.currency) used.add(fxCode(r.currency));
  const codes = [...new Set([...Object.keys(fx.rates || {}), ...used])].sort();
  const sel = $('#fx-display');
  const cur = fxCode(state.settings['fx.display']);
  sel.innerHTML = '<option value="">不折算（分币种显示）</option>'
    + codes.map(c => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}${fx.rates[c] ? '' : '（无汇率）'}</option>`).join('');
  $('#fx-status').textContent = !fx.baseline_period
    ? '汇率表没有加载，费用一律按原币显示。'
    : fx.live?.length
      ? `实时汇率 ${fx.live.length} 种，取自 ${fx.fetched_at || '未知日期'}（${fx.source}）；其余用内置平均汇率 ${fx.baseline_period}`
      : `当前用内置平均汇率（${fx.baseline_period}）。未拉过实时汇率——这是唯一一处按需出网，不点就不发生。`;
}

$('#fx-refresh').onclick = async e => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    state.fx = await api('/api/fx/refresh', { method: 'POST', body: '{}' });
    syncFxPanel();
    toast(`已更新 ${state.fx.live.length} 种汇率`);
    renderAll();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = '拉取实时汇率';
};

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
  syncFxPanel();
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
        <span class="lg-a">${amtHtml(r.currency, r.amount)}</span>`;
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
    'fx.display': f.fx_display.value,
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
  // 「手动」不是一列，排的是 media_items.pos——sortRows 走 COLS 查不到它
  if (m.sort?.key === 'pos') return [...rows].sort(byPos);
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
      // 海报墙是媒体库的默认视图，而卡片只挂 onclick 就等于键盘用户在这一屏无路可走
      //（表格视图那侧早有 ⤢ 与表头菜单的键盘入口，这里一直缺）。与 th 同一套做法：
      // 自己补 tabIndex + role，Enter/空格都开详情，空格要 preventDefault 否则滚页。
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${it.title || '未命名'} 详情`);
      card.onkeydown = e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openMediaDialog(it);
      };
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
        <td>${nameCell(it.title)}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${it.orig_title ? `<div class="muted" style="font-size:.75rem">${esc(it.orig_title)}</div>` : ''}</td>
        <td>${cellVal('media', 'kind', it.kind)}</td>
        <td class="cdate">${esc(String(it.year || ''))}</td>
        <td>${starRow(it.rating)}</td>
        <td class="amt">${it.douban_rating ?? ''}</td>
        <td>${stPill(it.status)}</td>
        <td class="cdate">${esc(it.marked_at || '')}</td>
        ${customTds('media', it)}<td class="ops"></td>`;
      tr.querySelector('[data-open]').onclick = () => openMediaDialog(it);
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
  // 自定义列此前只有表格里点格能改，海报墙用户等于没有入口
  const ex = $('#m-extra-fields');
  const exFields = customFields('media');
  ex.innerHTML = '';
  for (const cf of exFields) ex.appendChild(fieldControl('media', cf, it));
  $('#m-extra-fold').hidden = !exFields.length;
  // 已经有值就摊开（与「游戏字段」按类别自动展开同理）：藏在一次点击后面，
  // 等于海报墙用户仍然看不见自己填过什么
  $('#m-extra-fold').open = exFields.some(cf => {
    const v = (it?.extra || {})[cf.key];
    return v != null && v !== '' && !(Array.isArray(v) && !v.length);
  });
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
  // extra 在协议里是**一个整体值**：出现即整份替换，缺席即保持。表单要动自定义列，
  // 就得从行数据铺起再让控件覆盖（表单没显示的键才不会被抹掉）。
  // 数字栏清空要显式写 null——undefined 会被 JSON.stringify 丢掉，那等于"别动它"。
  const body = { extra: { ...(editingMedia?.extra || {}) } };
  for (const k of M_STR) body[k] = f[k].value;
  for (const k of [...M_INT, ...M_REAL]) body[k] = f[k].value === '' ? null : +f[k].value;
  for (const cf of customFields('media')) {
    const val = readFieldControl('#m-extra-fields', cf);
    if (val === NO_CONTROL) continue; // 控件不在场＝别动这个键，不是"用户清空了"
    if (val == null || val === '' || (Array.isArray(val) && !val.length)) delete body.extra[cf.key];
    else body.extra[cf.key] = val;
  }
  try {
    // 封面不在表单里，也就不会出现在 body 里——缺席即保持，不必再把原值带上
    if (editingMedia) await api(`/api/media/${editingMedia.id}`, { method: 'PATCH', body: JSON.stringify(body) });
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
        ${h.poster ? `<img src="/api/tmdb/thumb?path=${encodeURIComponent(h.poster)}" alt="" loading="lazy" onerror="this.hidden=true">` : ''}
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
  clearAllSel(); // 选区跟着看得见的那张表走，换页就散掉，免得批量删到看不见的表里
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
  clearAllSel(); // 同上：选区不跨表带走
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

/* ══ 库：标签页 / 表头 / 行 / 详情表单全部由 /api/collections + /api/fields 生成 ══
   预置三库（订阅 / SIM / VPS）与用户自建库同走这一份渲染器，没有第二条路径。 */

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

// 模板串里出现的字段键，按出现顺序。显示与就地编辑共用这一份声明——
// 想让规格格多显示一项、就多编辑一项，改模板串即可，不必两处同步。
const tplKeys = f => [...String(f.config?.tpl || '').matchAll(/\{(\w+)\}/g)].map(m => m[1]);

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
  // 与**上次生成的那份模板串**比，不能与表头此刻的 innerHTML 比：initHead 会往 th 里
  // 注入类型图标、排序指示、拖拽与缩放结构，比完必然不相等——于是每次 loadAll（保存一个
  // 格子、拖一行、改个设置都会触发）都在整份重建库表头、重新绑一遍事件，白干且会丢焦点。
  if (THEAD_HTML[key] !== want) {
    head.rows[0].innerHTML = want;
    THEAD_HTML[key] = want;
    head.closest('.tablewrap').querySelector('.newrow')?.remove();
    initHead(key); // 它自己会结算一次偏好
  } else {
    // 表头没重建，视图偏好照样每次结算（两个节奏，见 settleView）。
    // 列键**从字段集现取**，不能从 thead 的 DOM 里取——那份可能已经被列序拖动重排过，
    // 而 TKEYS 记的必须是模板序（tbody 恒按模板序渲染，td 靠它对上 data-k）
    settleView(key, [...shownFields(key).map(f => f.key), 'ops']);
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
    delete THEAD_HTML[k]; // 表头快照也跟着走：容器都撤了，留着它会让同键的新表跳过重建
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
    // left > total ⟺ last_renewed 在今天之后 ＝ 本期还没开始。这是提前续费 + 账单日不变
    // （renew_from='schedule'）产生的合法状态，0017 之前根本不可能出现；照旧画进度条就是
    // 「剩 37 天 / 31」配一根空槽，看着像算错了。数字都对，错的是拿"进度"去讲一段还没
    // 开始的周期——直接说清本期哪天起算
    if (total > 0 && left > total) return esc(`剩 ${left} 天（本期 ${it.last_renewed} 起）`);
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
  // 无列排序时的基态就是手动序（pos）。这里曾经按名称字母序排，那让「拖出来的顺序」无处安放
  if (!views[key].sort) rows = [...rows].sort(byPos);
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
    // 小字是号码时也给拨号链接：SIM 的号码默认只作为名称格小字露面（不占列位），
    // 只在表格列上做 tel 渲染的话，这个类型最有用的地方恰好看不见
    const subTel = sub && fieldOf(key, c.subline)?.ftype === 'tel';
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    if (depth) tr.classList.add('subrow');
    const tds = fields.map(f => {
      const v = fieldVal(f, it);
      if (f.key === 'name') {
        return `<td>${hasKids ? `<button class="tgl" data-tgl type="button" title="折叠 / 展开子行">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : ''}${(!depth && parent) ? `<span class="sub-parent">${esc(parent.name)} ↳ </span>` : ''}${logoOf(it) ? `<img class="slogo" src="/logos/${esc(logoOf(it))}" alt="" loading="lazy">` : ''}${nameCell(it.name)}${safeUrl(it.url) ? ` <a class="btn link" href="${esc(safeUrl(it.url))}" target="_blank" rel="noreferrer">↗</a>` : ''}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${sub ? `<div class="muted" style="font-size:.75rem">${subTel ? `<a class="tel" href="${esc(telHref(sub))}">${esc(sub)}</a>${telSuspect(sub) ? '<span class="tel-warn" title="位数偏少，可能只填了国家码">?</span>' : ''}` : esc(sub)}</div>` : ''}</td>`;
      }
      if (f.key === 'status') return `<td>${stPill(it.status)}</td>`;
      if (f.key === 'left') return `<td class="wide">${leftBar(it)}</td>`;
      if (f.key === 'price') {
        // 币种并进了这一格：主行是金额（开了折算就是折算值），小字里挂原币与周期
        const cyc = cycleShown ? '' : cycleText(it);
        const { main, sub } = moneyView(it.currency, it.price);
        const note = [sub, cyc].filter(Boolean).join(' · ');
        return `<td class="amt">${esc(main)}${note ? `<div class="muted" style="font-size:.72rem">${esc(note)}</div>` : ''}</td>`;
      }
      // 有形状的三类的渲染在 cellVal 里（媒体的自定义列共用同一份，别在这儿另写一遍）
      if (f.ftype === 'url' || f.ftype === 'email') return `<td class="clip">${cellVal(key, f.key, v)}</td>`;
      if (f.ftype === 'tel') return `<td class="cdate">${cellVal(key, f.key, v)}</td>`;
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
      </td>`;
    tr.querySelector('[data-open]').onclick = () => openItemDialog(key, it);
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
  // 网址是在同一张表单里填的，填完立刻就该能取图标，不必先保存再重开。
  // **这个监听器只能绑一次**：#item-fields 是常驻节点（对话框只建一次），而 logoRow
  // 每开一次详情表单就跑一遍——绑在那里等于每开一次叠一个，闭包还攥着上一次那颗
  // 已经脱离 DOM 的按钮。所以在这里绑，回调里现查当前那颗。
  d.querySelector('#item-fields').addEventListener('input', e => {
    if (e.target.matches('[data-f="url"], [data-urlfield]')) syncGrabBtn();
  });
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

// 周期是目前唯一「存储键 ≠ 呈现文案」的固定档位词表：既不从数据里长，也不接受现场新增。
// 放开了就会有人把 Monthly 这样的文案写回 items.cycle，按周期推日期的库整条掉出
// 到期时间线与 ICS（2026-07-31 真踩过）。
const fixedVocab = f => f.src === 'col' && f.key === 'cycle';

// 单选下拉的候选：一律 {v: 存回去的值, label: 给人看的文案}。
function selOptions(key, f, cur) {
  if (fixedVocab(f)) {
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

// 单选下拉旁的「新选项」输入：回车加一项并选中（已有就直接选中）。
// 开放词表（币种/分类/注册商…）建库时是空的，没有这个入口的话首装第一条就填不出来——
// 只能先存个残缺条目、再回表格用就地编辑器把值造出来。词表本就从数据里长，
// 所以这里只管把值选上，存不存进词表交给保存后的常规流程。
// tr：落进下拉之前的规范化（币种要统一成大写，其余原样）
function initSoptAdd(inp, tr = v => v) {
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // 不吃掉的话表单直接隐式提交
    const val = tr(inp.value.trim());
    inp.value = '';
    if (!val) return;
    const sel = inp.parentElement.querySelector('select');
    if (![...sel.options].some(o => o.value === val)) {
      sel.appendChild(Object.assign(document.createElement('option'), { value: val, textContent: val }));
    }
    sel.value = val;
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
    box.appendChild(fieldControl(key, f, it));
  }
  box.appendChild(parentRow(key, it));
  if (it) box.appendChild(logoRow(it));
  d.showModal();
}

/* 一个字段 → 一枚表单控件。库的详情表单与媒体表单的自定义列共用这一份，
   免得多选/星级/单选这几种非平凡控件各写一遍、各漏一处。 */
function fieldControl(key, f, it) {
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
        // 五颗一模一样的 ★ 读出来是五个"星号按钮"，必须自报第几颗
        `<button type="button" data-v="${i}" aria-label="${i} 星"${i <= n ? ' class="lit"' : ''}>★</button>`).join('')
      }<button type="button" class="star-clear" data-v="">清除</button></span>
      <input type="hidden" data-f="${esc(f.key)}" value="${n || ''}">`;
  } else if (f.ftype === 'sel') {
    const cur = val === '' ? '' : String(val);
    const sel = `<select data-f="${esc(f.key)}"><option value=""></option>${selOptions(key, f, cur).map(o =>
      `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    // 开放词表配一个「新选项」输入框，不然空库首装时这一栏是个填不出东西的死胡同
    lab.innerHTML = `<span>${esc(f.name || f.key)}</span>`
      + (fixedVocab(f) ? sel : `<span class="sopts">${sel}<input class="sopt-add" placeholder="新选项，回车加入"></span>`);
    if (!fixedVocab(f)) initSoptAdd(lab.querySelector('.sopt-add'));
  } else if (f.ftype === 'status') {
    const opts = statusOrder(key);
    lab.innerHTML = `<span>${esc(f.name || f.key)}</span><select data-f="${esc(f.key)}">${opts.map(o => `<option${o === (val || 'Planned') ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (f.key === 'price' && f.src === 'col') {
    // 币种并进费用栏：金额与币种一起填。currency 不是注册字段（迁移 0013 撤了它的列），
    // 值由这枚 select 写，itemBody 单独读——与 parent_id 同一处理方式
    const cur = fxCode(it?.currency);
    lab.className = 'span2';
    lab.innerHTML = `<span>${esc(f.name || f.key)}</span>
      <span class="pricebox"><input type="number" step="any" data-f="price" value="${esc(val)}">
      ${currencyPicker(key, cur, 'data-f="currency"')}</span>`;
    initSoptAdd(lab.querySelector('.cur-add'), fxCode);
  } else {
    const type = f.ftype === 'num' ? 'number' : f.ftype === 'date' ? 'date' : f.ftype === 'tel' ? 'tel' : f.ftype === 'url' ? 'url' : f.ftype === 'email' ? 'email' : 'text';
    // 标出网址输入框：「从网站取图标」认这个标记，所以自建的网址列同样能用
    const mark = f.ftype === 'url' ? ' data-urlfield' : '';
    lab.innerHTML = `<span>${esc(f.name || f.key)}</span><input type="${type}"${type === 'number' ? ' step="any"' : ''} data-f="${esc(f.key)}"${mark} value="${esc(val)}">`;
  }
  return lab;
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

/* 表单里"当前那个网址"：优先本表单正在填的 url 控件，其次任何 url 类型字段，
   最后回落到行数据。读 editingItem.row 而不是闭包里的 it——paint() 会换掉那个对象。 */
function formUrl() {
  const own = document.querySelector('#item-fields [data-f="url"]')?.value?.trim();
  if (own) return own;
  for (const el of document.querySelectorAll('#item-fields [data-urlfield]')) {
    if (el.value.trim()) return el.value.trim();
  }
  return (editingItem?.row?.url || '').trim();
}

// 「从网站取」只在这个条目填了网址时出现：没网址时按钮点了必然失败，不如不给
function syncGrabBtn() {
  const g = document.querySelector('#item-fields [data-logo-grab]');
  if (g) g.hidden = !formUrl();
}

/* 条目图标：上传/清除各走自己的端点，与表单的保存不是一回事——表单的 PATCH 体里
   压根没有 logo 这个键，而缺席即保持，所以两者不会互相覆盖。
   （全量替换那会儿必须把 editingItem.row.logo 同步回去，否则紧接着按「保存」就把刚传的
   图标清掉了；现在 paint() 仍然同步它，是为了让表单里的预览与本次上传一致。） */
function logoRow(it) {
  const lab = document.createElement('label');
  lab.className = 'span2';
  lab.innerHTML = `<span>图标</span>
    <span class="logo-row">
      <span class="logo-prev"></span>
      <button type="button" class="btn ghost mini" data-logo-pick>选择图片</button>
      <button type="button" class="btn ghost mini" data-logo-grab hidden>从网站取</button>
      <button type="button" class="btn ghost mini" data-logo-clear hidden>清除</button>
      <input type="file" accept=".png,.jpg,.jpeg,.webp,.svg,.gif,.ico" data-logo hidden>
    </span>`;
  const prev = lab.querySelector('.logo-prev');
  const clear = lab.querySelector('[data-logo-clear]');
  const grab = lab.querySelector('[data-logo-grab]');
  const paint = name => {
    editingItem.row = { ...editingItem.row, logo: name || null };
    prev.innerHTML = name
      ? `<img class="slogo-view" src="/logos/${esc(name)}" alt="">`
      : '<span class="muted">未设置</span>';
    clear.hidden = !name;
  };
  paint(it.logo);
  // 这一颗还没挂进 DOM，先就地定它的显隐；之后跟着输入走的那次在 itemDialog 里（绑一次）
  grab.hidden = !formUrl();
  grab.onclick = async () => {
    grab.disabled = true;
    const was = grab.textContent;
    grab.textContent = '取图标…';
    try {
      const r = await api(`/api/items/${it.id}/logo/fetch`,
        { method: 'POST', body: JSON.stringify({ url: formUrl() }) });
      paint(r.logo);
      toast('已从 ' + urlHost(r.from) + ' 取到图标');
    } catch (err) { toast(err.message, true); }
    grab.disabled = false;
    grab.textContent = was;
  };
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

/* fieldControl 的反向：从表单里读回一个字段的值。控件不在场时给 NO_CONTROL，
   调用方一律要跳过而不是当成空值——把"没这个控件"当成"用户清空了"，就是整行 PUT
   语义下把字段清掉的那类事故。multi 与 star 没有单一的 [data-f]，所以要分支读。 */
const NO_CONTROL = Symbol('no-control');
function readFieldControl(scope, f) {
  if (f.ftype === 'multi') {
    // 勾选清单直接给数组，不经字符串往返——那正是含分隔符的值被拆坏的地方
    const mbox = document.querySelector(`${scope} [data-mbox="${f.key}"]`);
    if (!mbox) return NO_CONTROL;
    return [...mbox.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
  }
  const el = document.querySelector(`${scope} [data-f="${f.key}"]`);
  if (!el) return NO_CONTROL;
  const v = el.value.trim();
  // 数字/星级清空给 null 而不是 undefined：这个值会直接进 PATCH 体，而 JSON.stringify
  // 会把 undefined 连键一起丢掉——键缺席在那套语义里是"保持原值"，清空就失效了
  return f.ftype === 'num' || f.ftype === 'star' ? (v === '' ? null : Number(v)) : v;
}

// 表单 → PATCH/POST 的体：只装这张表单读得到的字段，其余交给"缺席即保持"
function itemBody(key, row) {
  const patch = { extra: { ...(row.extra || {}) } };
  for (const f of fieldsOf(key)) {
    if (f.src === 'calc') continue;
    const val = readFieldControl('#item-fields', f);
    if (val === NO_CONTROL) continue;
    if (f.src === 'col') patch[f.key] = val;
    else if (val == null || val === '' || (Array.isArray(val) && !val.length)) delete patch.extra[f.key];
    else patch.extra[f.key] = val;
  }
  // 父条目有自己的下拉（不是注册字段）：选「（顶层）」＝ null ＝ 脱离父行
  const psel = document.querySelector('#item-fields [data-parent]');
  if (psel) patch.parent_id = psel.value ? +psel.value : null;
  // 币种同理：它并进了费用栏，迁移 0013 起不再是注册字段，上面那圈循环读不到它
  const csel = document.querySelector('#item-fields [data-f="currency"]');
  if (csel) patch.currency = fxCode(csel.value); // 手打的 usd 一律存成 USD；空串＝清空
  // 就这些。表单没有的真列（SIM 没注册的周期、图标、手动序…）不出现在体里＝后端保持原值，
  // 不必再按 items 的真列全集铺一遍底——那份铺底代码正是全量替换语义逼出来的
  return patch;
}

// 详情表单里的星级：点星写进隐藏输入（与就地编辑的 starEditor 同一套呈现）
document.addEventListener('click', e => {
  // 两张表单都可能有星级字段（媒体的自定义列走 #m-extra-fields），别只认库那一张
  const b = e.target.closest('#item-fields .stars button[data-v], #m-extra-fields .stars button[data-v]');
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
    if (id) await api(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
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
        <label><span>续费起算</span><select data-c="renew_from">
          <option value="schedule">按原定到期日（账单日不变）</option>
          <option value="today">从操作当天重新计时</option>
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
  g('renew_from').value = t.renew_from || 'schedule';
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
      <label class="check sem"${locked ? ' title="名称列承载详情入口，不能撤下表格"' : ''}><input type="checkbox"${f.shown || locked ? ' checked' : ''}${locked ? ' disabled' : ''}><span>上表</span></label>
      ${f.src === 'extra'
        ? '<button type="button" class="btn link fp-del" data-del title="删除此列">✕</button>'
        : '<span class="fp-del"></span>'}`;
    // 不上表的列没有表头，表头菜单那条删除入口够不着——这儿是它们唯一的出口
    row.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm(`删除列「${f.name || f.key}」？该列在所有行的值将被清除，不可撤销。`)) return;
      try {
        await api(`/api/fields/${f.id}`, { method: 'DELETE' });
        await rebuildHead(c.key); // 顺带刷字段注册表，下面这次重绘读到的才是删后的字段集
        fillCollFields(c);
      } catch (err) { toast(err.message, true); }
    });
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
  g('renew_from').value = c?.renew_from || 'schedule';
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
  const body = {
    name: g('name'), icon: g('icon'), due_anchor: g('due_anchor'),
    renew_from: g('renew_from'), verb: g('verb'),
  };
  if (!body.name) { toast('库名不能为空', true); return; }
  // 换到期模型是有后果的：新锚点那一侧的日期字段是空的，已有条目在填上之前都算不出到期日
  //（后端会把该字段补进注册表，所以填得上；首页「算不出到期日」那栏会点名它们）
  if (editingColl && body.due_anchor !== editingColl.due_anchor) {
    const to = body.due_anchor === 'next' ? '直接记下次到期日' : '上次续费 + 周期';
    if (!confirm(`把「${editingColl.name}」的到期模型改成「${to}」？\n\n新模型读的是另一个日期字段，已有条目在把它填上之前算不出到期日（会列在首页「算不出到期日」里）。改回来即可恢复。`)) return;
  }
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
