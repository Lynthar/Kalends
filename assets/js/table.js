/* Kalends 前端 · table.js —— 表格引擎：排序、筛选、表内搜索、自定义列注入、
   表头生成（initHead/settleView）、列宽三律、列序拖动、行首浮标与选区。
   加载方式与作用域约定见 core.js 头注。 */

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
   列表型（sel/multi/status）筛选存已选值数组；操作符型（text/num/date）存 {op, q}。 */
// 拨号链接只留 + 与数字：href 里带空格/横杠时部分客户端会拨错
const telHref = v => 'tel:' + String(v).replace(/[^\d+]/g, '');
// 位数太少多半是只填了国家码这类残缺值。这里只标不拦——存量数据里就有，
// 在写入口 400 掉等于让人打不开自己的旧条目（后端同理，见 normalize_shaped）
const telSuspect = v => (String(v).match(/\d/g) || []).length < 5;
// 网址在格子里只显示域名：原始串常是带一长串查询参数的登录页，铺开会把整列撑爆
const urlHost = v => String(v).replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./, '');
/* 认不出的类型一律当文本：漏接新类型、或类型被撤而库里留着旧字段（star）都会走到
   这里，退化成"当普通文本用"总好过浮层打不开。tpl 到不了这里——colFromField 已映射成 text。 */
const colType = (tab, k) => {
  const t = views[tab].types?.[k] || COLS[tab][k].t;
  return TYPES[t] ? t : 'text';
};

// t：字段类型；conv=1 允许切换呈现类型；ord：勾选列表按词表序（默认按中文序）；
// val：取排序值（str=1 按中文串比较，否则按数值）；fvals：取筛选值列表（无值行归入 BLANK）
const ordVal = (ord, get) => r => { const i = ord.indexOf(get(r)); return i < 0 ? null : i; };
const COLS = {
  media: {
    title: { t: 'text', val: r => r.title, str: 1, fvals: r => [r.title, r.orig_title].filter(Boolean) },
    kind: { t: 'sel', conv: 1, ord: M_KINDS, val: ordVal(M_KINDS, r => r.kind), fvals: r => r.kind ? [r.kind] : [] },
    year: { t: 'num', val: r => r.year },
    // 10 分制（迁移 0019 起），与豆瓣评分同一把尺；筛选因此从「勾 1–5」变成 ≥8 这类操作符
    rating: { t: 'num', val: r => r.rating },
    douban: { t: 'num', val: r => r.douban_rating },
    status: { t: 'status', ord: M_STATUSES, val: ordVal(M_STATUSES, r => r.status), fvals: r => r.status ? [r.status] : [] },
    marked: { t: 'date', val: r => r.marked_at, str: 1 },
  },
};

// 有效类型感知的筛选值：呈现为多选的文本列按分隔符拆开。
// 真多选列的值本身就是数组，**绝不能再拆**——含 , ， 、 / 的值（「CN2 GIA/9929」）
// 会碎成两个，勾选它自己筛不出自己那行。
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

/* 单元格渲染**只此一处**（库的列与媒体的自定义列共用）：写成两份的下场是同名同类型
   的列在两张表里长得不一样。怎么渲染由类型表的 cell 说了算，没写就是转义纯文本。 */
function cellVal(tab, k, v) {
  if (v == null || v === '') return '';
  const cell = TYPES[colType(tab, k)]?.cell;
  return cell ? cell(v, tab, k) : esc(String(v));
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
    const numeric = !!TYPES[f.ftype]?.numeric; // 按不按数值排序由类型表说了算
    cols[k] = {
      t: f.ftype, custom: f.id,
      conv: CONV_TYPES.includes(f.ftype) ? 1 : 0,
      ord: null,
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

/* 媒体的 COLS 要跟字段注册表对账：注入只在 boot 与 rebuildHead 跑，而 loadAll 每次都
   刷注册表——别处（另一台设备/标签页/接口）加了列，这边就会拿旧 COLS 渲染新字段，
   colType 读到 undefined 把整个 renderAll 打断。库那侧由 ensureCollDom 兜着。 */
function syncMediaCols() {
  const want = customFields('media').map(FKEY).join();
  const have = Object.keys(COLS.media).filter(k => COLS.media[k].custom).join();
  if (want !== have) rebuildMediaHead();
}

// td 的造型与要不要挂 title 同样查类型表（与 renderColl 那侧同一份判据），
// 否则同名同类型的列在两张表上长得不一样
function customTds(tab, it) {
  let h = '';
  for (const f of customFields(tab)) {
    const k = FKEY(f);
    const v = (it.extra || {})[k];
    const ts = TYPES[f.ftype] || {};
    h += `<td${ts.td ? ` class="${ts.td}"` : ''}${ts.title ? ` title="${esc(v ?? '')}"` : ''}>${cellVal(tab, k, v)}</td>`;
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
// 媒体渲染器住在后一份文件里，而函数声明只在自己那个 script 内提升——顶层直接取它的值
// 会拿到 undefined（拆文件时踩过）。包一层，等真正调用时再解析
const RENDER = { media: (...a) => renderMedia(...a) };   // 库的渲染器由 ensureCollDom 注册
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

/* 行的详情入口（⤢）与子行折叠钮长在哪一格：库是名称列、媒体是标题列。
   这一列撤下去，整表就没了全表单入口——两处守它（表头菜单不出「隐藏此列」、
   settleView 无条件捞回），所以判据只此一份，别在别处写死 'name'。 */
const entryKey = tab => (tab === 'media' ? 'title' : 'name');

// 各表列键的模板序快照（tbody 渲染恒为模板序，td 定位靠它；列序重排只动 thead/td 的 DOM 序）
const TKEYS = {};
const colKeys = tab => TKEYS[tab];

/* 本机视图偏好对着当前列集结算一次：列集变了做温和迁移、名称列无条件捞回、筛选清洗。
   与"重建表头"是两个节奏：表头只在列集真的变了时重建（见 ensureCollDom），而偏好
   来自 localStorage（可能是别的设备/标签页写的，也可能就是坏值），每次渲染都要结算。 */
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
    // 服务端字段序变了（列集没增没减、只是换了次序）⇒ 本机这份列序覆写已过期，丢掉——
    // 留着就等于"在库设置里排完序，表格纹丝不动"。判定放在结算处，别再往调用方加"顺手清一下"
    if (v.keys.length === keys.length && v.keys.every(k => keys.includes(k))) v.order = null;
    if (v.order) {
      const o = v.order.filter(k => keys.includes(k));
      const fresh = keys.filter(k => !o.includes(k) && k !== 'ops');
      o.splice(o.indexOf('ops') < 0 ? o.length : o.indexOf('ops'), 0, ...fresh);
      if (!o.includes('ops')) o.push('ops');
      v.order = o;
    }
  }
  // 详情入口那一列无条件捞回：已把它存进 hiddenCols 的存量偏好光靠列集迁移救不回来（列集没变）
  const entry = entryKey(tab);
  if (v.hiddenCols?.includes(entry)) v.hiddenCols = v.hiddenCols.filter(k => k !== entry);
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
    ic.innerHTML = TYPES[colType(tab, th.dataset.k)].icon;
    th.prepend(ic);
    initColDrag(tab, th);
    initColResize(tab, th);
    th.onclick = () => openHeadMenu(tab, th); // Notion 式：点表头开属性菜单
    // 属性菜单是排序/筛选/改列/删列的唯一入口：th 不是原生可聚焦元素，自己给 tabindex
    // 与回车/空格。**别给 role="button"**——会盖掉原生 columnheader，aria-sort 就读不出来了
    th.tabIndex = 0;
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

/* 列宽三律（右边框硬边界，最右可见列右缘恒贴容器）：① 无手动宽 fitWidths 自动装容器
   （不落存储）；② 有手动宽最右可见列吸收残差（存宽是它的下限）；③ 拖宽先吃残差、贴边后
   压右侧数据列到 MIN_COLW，拖窄全给最右列。一切宽度变化都经 applyWidths 结算。 */
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
  // 压到下限还塞不进容器就整个放弃压缩、退回自然列宽：横滚照样免不了，压缩只会把
  // 每格挤成省略号。判据是几何（total > avail）而不是视口阈值，桌面端的宽表同样受用。
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

/* ── 行首浮标（⠿ 手柄 + 复选框）：不是一列，是首格左内边距里的两个控件——做成真列，
   列宽三律/列序存储/隐藏列全要再认一个新键。手动序真源是后端的 pos，只在「没按任何列
   排序」时生效；按列排序时拖动的位置存不住，手柄随之停用（Notion 同款）。 */

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
  // 手柄不进 Tab 序（键盘挪行用复选框上的 Alt+↑/↓）；⠿ 由 CSS ::before 画——
  // 写成按钮文本会混进 td.textContent，行文本从此永远带一个 ⠿
  g.innerHTML = head
    ? '<input class="rgsel" type="checkbox" data-selall aria-label="全选本表">'
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
  // 全局 scroll 监听会关浮层（fixed 浮层滚动后脱锚），而 scrollIntoView 的 scroll 事件
  // 是异步的——先开编辑器会被自己这下滚动关掉。滚动事件排在 rAF 回调之前，等一帧就够。
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
    if (ic) ic.innerHTML = TYPES[colType(tab, th.dataset.k)].icon; // 图标随有效类型
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
/* 类型 → 操作符组。**要认全部非列表型类型**：tel/url/email 的值就是文本、共用 text
   那套；漏接的类型 OP_MENU[t] 是 undefined、取下标当场 TypeError——浮层不出现、
   无任何提示，而排序照常，「所有列都可排序可筛选」就对新类型静默失守。 */
const opKind = t => (TYPES[t]?.filter === 'num' || TYPES[t]?.filter === 'date' ? TYPES[t].filter : 'text');

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

// 勾选列表型筛选（sel/multi/status）：值 + 计数，多选并集
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
