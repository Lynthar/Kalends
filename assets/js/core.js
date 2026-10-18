/* Kalends 前端 · core.js —— 工具/全局状态/api/视图偏好/汇率折算/loadAll/首页，必须第一个加载。
   八份文件是普通 <script>、共享同一个全局作用域，按 index.html 里的顺序执行（顺序即依赖）；
   不是也不打算是 ES module（e2e 直调全局函数，零构建步骤也不允许打包器）。加东西放进对应的那份。 */

'use strict';

const $ = s => document.querySelector(s);
// 浏览器禁了站点存储时，连读 localStorage 都抛 SecurityError；顶层抛出去整页就是空壳
function stored(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
const state = {
  overview: null, subs: [], sims: [], vps: [], settings: {}, defaults: {}, fields: [], fx: null,
  tab: 'subs',
  upWindow: '', upFolded: stored('kalends.upfold') === '1',
};

// 各表视图偏好（列排序 / 列筛选 / 表内搜索 / 列类型），存本浏览器
const VIEWS_KEY = 'kalends.views.v1';
const views = { subs: {}, sims: {}, vps: {} };
try { Object.assign(views, JSON.parse(stored(VIEWS_KEY) || '{}')); }
catch (e) { console.warn('本机视图偏好解析不出来，各表按默认视图显示：', e); }
for (const t of ['subs', 'sims', 'vps']) views[t] = viewShape(views[t]);

/* 一个库的视图偏好，形状不对的项回默认：它来自 localStorage，可能是旧代码、别的设备或手改
   写下的。一个 filters:null 或数字 q 就让所有库的表格白屏，而界面上没有重置入口 */
function viewShape(v) {
  const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const strs = x => (Array.isArray(x) ? x.filter(s => typeof s === 'string') : []);
  const o = obj(v), s = obj(o.sort);
  return {
    ...o,
    sort: typeof s.key === 'string' && (s.dir === 1 || s.dir === -1) ? { key: s.key, dir: s.dir } : null,
    filters: obj(o.filters),
    q: typeof o.q === 'string' ? o.q : '',
    widths: Object.fromEntries(Object.entries(obj(o.widths)).filter(([, w]) => Number.isFinite(w) && w > 0)),
    order: Array.isArray(o.order) ? strs(o.order) : null,
    hiddenCols: strs(o.hiddenCols),
    types: Object.fromEntries(Object.entries(obj(o.types)).filter(([, t]) => typeof t === 'string')),
    keys: Array.isArray(o.keys) ? strs(o.keys) : null,
    collapsed: Array.isArray(o.collapsed) ? o.collapsed.filter(Number.isInteger) : [],
  };
}
// 存不进去（隐私模式 / 配额满）只丢本机偏好，不该打断操作；但要留一句，
// 否则「列宽设了下次又没了」永远查不出所以然
function saveViews() {
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); }
  catch (e) { console.warn('视图偏好存不进 localStorage，本机设置不会保留：', e); }
}

const CYCLE_LABEL = {
  weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Semiannual',
  annual: 'Annual', biennial: 'Biennial', triennial: 'Triennial', lifetime: 'Lifetime', days: 'Custom',
};
// 周期下拉的档位与次序（就地编辑器与详情表单共用，'' = 不设周期）。
// 选项的 value 恒为存储键（monthly），显示的才是 CYCLE_LABEL 的文案（Monthly）。
const CYCLE_ORDER = ['', 'monthly', 'annual', 'biennial', 'triennial', 'quarterly', 'semiannual', 'weekly', 'days', 'lifetime'];

// 模态对话框在 top layer、框外一律 inert：toast 留在 body 就被压在下面，读屏也听不见。
// 所以有框开着时住进框里，框关上时回 body——不回的话「先 toast 再关框」的成功提示跟着框一起藏掉
function homeToast() {
  const t = $('#toast'), home = document.querySelector('dialog:modal') || document.body;
  if (t.parentNode !== home) home.append(t);
  return t;
}
document.addEventListener('close', homeToast, true); // close 不冒泡，只能在捕获阶段接

function toast(msg, err) {
  // 挪位要在露出与写文本之前：带着内容插进来的 live region 不播报
  const t = homeToast();
  t.classList.toggle('err', !!err);
  // 先露出来再写文本：hidden 的元素不在无障碍树里，趁藏着改内容 live region 就没人听见
  t.hidden = false;
  t.textContent = msg;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, err ? 4200 : 1800);
}

// 一波并发请求同时吃 401 时只问一次 PIN：先回来的那个问，同一波里其余的沿用它的答复
let pinWave = 0, pinGiven = false;
async function api(path, opts = {}, mayAskPin = true) {
  const wave = pinWave;
  let r;
  try {
    r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch {
    throw new Error('连不上 Kalends：网络断开，或服务没在运行'); // 浏览器原文只有「Failed to fetch」
  }
  if (r.status === 401 && mayAskPin) {
    if (wave === pinWave) {
      pinWave++;
      const pin = prompt('此 Kalends 设置了访问 PIN，请输入：');
      pinGiven = pin != null && pin !== '';
      if (pinGiven) document.cookie = `kalends_pin=${pin};path=/;max-age=31536000;SameSite=Lax`;
    }
    if (pinGiven) return api(path, opts, false);
  }
  if (r.status === 401) throw new Error('访问 PIN 不对或没填：刷新页面重新输入');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// 提交用的回车：输入法组字时确认候选的那一下也是 Enter（isComposing / keyCode 229），当成提交就把没定稿的拼音存进去
const enterPressed = e => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;

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

/* 拖放换位的公共仪式，五处共用（库标签 / 表头列 / 表格行 / 库字段列表 / 词表选项）。
   标记类只有 drop-before / drop-after 一对，前后由指针落在中点哪一侧定、轴向只决定量 x 还是 y，
   各处的样式差别留在 CSS 里。调用方只给身份与落点处置，别再各写一遍这套事件。 */
let dndFrom = null;

// 抹标记要抹全场：dragend 只落在拖动源上，而源常常在落库重绘里被换掉、根本不触发
function clearDndMarks() {
  for (const el of document.querySelectorAll('.dragging, .drop-before, .drop-after')) {
    el.classList.remove('dragging', 'drop-before', 'drop-after');
  }
}

// 元素 → 它在 reorderDnD 登记的身份与落点处置；触屏路径靠它从手指下的元素找回落点
const dndTargets = new WeakMap();

function markDrop(el, axis, x, y) {
  const r = el.getBoundingClientRect();
  const after = axis === 'x' ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
  el.classList.toggle('drop-after', after);
  el.classList.toggle('drop-before', !after);
}

/* 手机浏览器不为触摸派发 HTML5 拖放：长按起手、跟手标落点、松手换位。没按够就滑开的照旧是滚动或点击：
   起手前不拦 touchmove，拦了第一下这一整个手势就再也滚不动。但 touchmove 监听必须一开始就以非被动挂上——
   手指按下那一刻元素上没有它，浏览器就把这一串 touchmove 定成拦不住的，拖动时表格跟着手指一起滚 */
const LONG_PRESS_MS = 500;
const PRESS_SLOP = 8;
const EDGE_PX = 32;

// 沿轴向能滚的最近祖先：手机上表格一屏只露两三列，拖到边上得自己滚过去才够得着后面的列
function scrollerOf(el, axis) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const can = axis === 'x' ? /auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth
      : /auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight;
    if (can) return p;
  }
  return null;
}

function touchDnD(el, { group, axis, key, onStart }) {
  let p = null; // 这一次按压：{ x0, y0, live, over, last, timer, raf }
  const retarget = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && !(dndTargets.get(hit)?.group === group && dndTargets.get(hit).key !== key)) hit = hit.parentElement;
    if (p.over && p.over !== hit) p.over.classList.remove('drop-before', 'drop-after');
    p.over = hit;
    if (hit) markDrop(hit, dndTargets.get(hit).axis, x, y);
  };
  // 手指停在滚动区边缘就一直滚，越贴边越快；滚完按原地重新找落点
  const edgeScroll = () => {
    const box = scrollerOf(el, axis);
    if (box && p.last) {
      const r = box.getBoundingClientRect();
      const [at, lo, hi] = axis === 'x' ? [p.last.x, r.left, r.right] : [p.last.y, r.top, r.bottom];
      const d = at < lo + EDGE_PX ? at - (lo + EDGE_PX) : at > hi - EDGE_PX ? at - (hi - EDGE_PX) : 0;
      if (d) {
        const step = Math.sign(d) * Math.min(12, 2 + Math.abs(d) / 3);
        if (axis === 'x') box.scrollLeft += step; else box.scrollTop += step;
        retarget(p.last.x, p.last.y);
      }
    }
    p.raf = requestAnimationFrame(edgeScroll);
  };
  const done = () => {
    if (!p) return;
    clearTimeout(p.timer);
    cancelAnimationFrame(p.raf);
    if (p.live) { dndFrom = null; clearDndMarks(); }
    p = null;
  };
  // 长按会招来系统菜单（Android 的 contextmenu），按住期间一律压掉
  el.addEventListener('contextmenu', e => { if (p) e.preventDefault(); });
  el.addEventListener('touchstart', e => {
    done();
    if (e.touches.length !== 1 || dndFrom) return;
    const t = e.touches[0];
    const press = p = { x0: t.clientX, y0: t.clientY, live: false, over: null, last: null, raf: 0 };
    press.timer = setTimeout(() => {
      if (p !== press) return;
      if (dndFrom || onStart?.(e) === false) { done(); return; }
      press.live = true;
      dndFrom = { group, key };
      el.classList.add('dragging');
      press.raf = requestAnimationFrame(edgeScroll);
    }, LONG_PRESS_MS);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!p) return;
    const t = e.touches[0];
    if (!p.live) {
      if (Math.hypot(t.clientX - p.x0, t.clientY - p.y0) > PRESS_SLOP) done();
      return;
    }
    e.preventDefault();
    p.last = { x: t.clientX, y: t.clientY };
    retarget(p.last.x, p.last.y);
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (!p) return;
    const { live, over } = p;
    const after = !!over?.classList.contains('drop-after');
    done();
    if (!live) return;
    // 长按松手后浏览器可能补一次 click：吞掉，别顺手开出表头菜单或切了标签
    const swallow = ev => { ev.stopImmediatePropagation(); ev.preventDefault(); };
    el.addEventListener('click', swallow, true);
    setTimeout(() => el.removeEventListener('click', swallow, true), 350);
    if (over) dndTargets.get(over).onDrop(key, after);
  });
  el.addEventListener('touchcancel', done);
}

/**
 * @param {Element} el 参与换位的元素；`draggable` 由调用方自己置（行拖动是按住手柄才开）
 * @param {object} o
 * @param {string} o.group 同组之间才收得下。**跨组必须给不同的名字**——五处共用一份拖动
 *   状态，同名就等于允许把一个标签拖进字段列表，落点处置会拿到一个它读不懂的 key
 * @param {'x'|'y'} o.axis 量哪个方向的中点
 * @param {*} o.key 本元素在组内的身份，原样交回 onDrop
 * @param {(e:DragEvent)=>*} [o.onStart] 起手钩子，**返回 false 即取消这次拖动**
 * @param {(from:*, after:boolean)=>void} o.onDrop 落点处置：把 from 放到本元素前/后
 * @param {boolean} [o.touch=true] 触屏长按拖动。表格行要关掉：每行挂一个非被动 touchmove，
 *   整张表在手机上的滚动都得等主线程
 */
function reorderDnD(el, { group, axis, key, onDrop, onStart, touch = true }) {
  const ok = f => f != null && f.group === group && f.key !== key;
  dndTargets.set(el, { group, axis, key, onDrop });
  el.addEventListener('dragstart', e => {
    if (onStart?.(e) === false) { e.preventDefault(); return; }
    dndFrom = { group, key };
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragover', e => {
    if (!ok(dndFrom)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(el, axis, e.clientX, e.clientY);
  });
  if (touch) touchDnD(el, { group, axis, key, onStart });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    const after = el.classList.contains('drop-after');
    const from = dndFrom;
    dndFrom = null;
    clearDndMarks();
    if (ok(from)) onDrop(from.key, after);
  });
  el.addEventListener('dragend', () => { dndFrom = null; clearDndMarks(); });
}

async function fetchAll() {
  // 汇率拉不到不该拖垮首屏——折算是可选视图，没有汇率就按原币显示并如实说一声
  const noFx = { display: '', rates: {}, live: [], baseline_period: '', source: '' };
  // 先取概览（里面带库清单）与设置，之后才知道有哪些库要拉条目
  const [overview, settings, defaults, fx] = await Promise.all([
    api('/api/overview'),
    api('/api/settings'),
    api('/api/settings/defaults'),
    api('/api/fx').catch(e => {
      toast('汇率表没取到，费用按原币显示：' + e.message, true);
      return noFx;
    }),
  ]);
  // 表格的列由字段注册表决定，所以每次全量加载都要一并刷新，
  // 否则新建库/加列之后前端还按旧字段集渲染（会渲染出没有名称格的空行）
  let fields = null;
  try { fields = await fetchFields(); } catch (e) { toast('字段注册加载失败：' + e.message, true); }
  // 所有库（含三个预置库）的条目都走同一条通用端点
  const rows = {};
  await Promise.all((overview.collections || []).map(async c => {
    rows[c.key] = await api(`/api/collections/${encodeURIComponent(c.key)}/items`);
  }));
  return { overview, settings, defaults, fx, fields, rows };
}

/* 整轮刷新的结果先落局部，确认仍是最后出发的那一轮才整份写进 state：早出发的一轮可能读在
   某次写入之前，晚到了就把新值盖回旧值，下一次编辑再把旧值写回库。作废的一轮转去等最新那轮，
   所以 await loadAll() 之后读到的总是最新的 state。 */
let latestLoad = null;
function loadAll() {
  const run = fetchAll().then(d => {
    if (run !== latestLoad) return latestLoad;
    Object.assign(state, { overview: d.overview, settings: d.settings, defaults: d.defaults, fx: d.fx }, d.rows);
    if (d.fields) state.fields = d.fields;
    const wins = ['7', '14', '30', '60', '90', '180', 'all'];
    state.upWindow = wins.includes(d.settings['ui.upcoming_days'])
      ? d.settings['ui.upcoming_days'] : d.defaults['ui.upcoming_days'];
    renderAll();
  }, e => {
    if (run !== latestLoad) return latestLoad;
    throw e;
  });
  latestLoad = run;
  return run;
}

/* ── 写入：改服务端数据的操作都走 write ── */
const writeTails = new Map();
const busyWrite = key => writeTails.has(key);
// key 上排着的写入连同它们的刷新都落定。编辑器开之前等它，免得拿旧行去拼整份 extra
const settled = key => writeTails.get(key) || Promise.resolve();
// 所有写入都落定；e2e 拿它代替「点完 sleep 一下」
const writesSettled = () => Promise.all([...writeTails.values()]).then(() => latestLoad?.catch(() => {}));

/**
 * 同一对象（key）的写入排队执行，写成后刷新。写失败与「写成了、刷新失败」分开报：
 * 写成了却报失败，用户会重试，续费这类不幂等的写入就多记一笔。
 * @param {string} key 被写的对象，如 `item:12`；同 key 串行，不同 key 互不等待
 * @param {() => Promise<*>} run 真正的写请求，轮到它时才执行——所以能读到前一次写入之后的 state
 * @param {object} [o]
 * @param {(r:*) => string} [o.done] 成功提示
 * @param {boolean} [o.once] 不幂等（续费、新建）：同 key 还在途时拒收，而不是排队再做一遍
 * @returns {Promise<*>} run 的结果（没有结果给 true）；写失败给 undefined，提示已经报过
 */
function write(key, run, { done, once } = {}) {
  if (once && busyWrite(key)) {
    toast('上一次还在处理，稍等', true);
    return Promise.resolve(undefined);
  }
  const job = settled(key).then(async () => {
    let r;
    try { r = await run(); } catch (e) { toast(e.message, true); return undefined; }
    const said = done ? done(r) : '已保存';
    if (done) toast(said);
    try { await loadAll(); }
    catch (e) { toast(`${said}，但列表没刷新（${e.message}）：别重复操作，稍后刷新页面再看`, true); }
    return r ?? true;
  });
  writeTails.set(key, job);
  job.finally(() => { if (writeTails.get(key) === job) writeTails.delete(key); });
  return job;
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
// 入场动画只在开页那一轮播：每次写入后的刷新都整列重新浮起，看着像整页重载
let upIntro = true;
function renderUpcoming() {
  const { upcoming, today } = state.overview;
  $('#today-note').textContent = `今日 ${today}`;
  $('#up-window').value = state.upWindow;
  const inWindow = it => state.upWindow === 'all' || it.days_left <= +state.upWindow;
  const items = upcoming.filter(inWindow);
  const ol = $('#up-list');
  ol.innerHTML = '';
  ol.classList.toggle('intro', upIntro);
  upIntro = false;
  const hiddenN = upcoming.length - items.length;
  const more = $('#up-more');
  more.hidden = hiddenN <= 0;
  const und = state.overview.undated || [];
  const off = (state.overview.off_timeline || []).filter(inWindow);
  const unk = state.overview.unknown_status || [];
  // 窗口内空、窗口外还有，或下面有点名：都别说「诸项安然」，同屏两句读着矛盾
  $('#up-empty').hidden = items.length > 0 || hiddenN > 0 || und.length > 0 || off.length > 0 || unk.length > 0;
  if (hiddenN > 0) more.textContent = `▾ 更远期还有 ${hiddenN} 项`;
  items.forEach((it, idx) => {
    const d = it.days_left;
    const cls = d < 0 ? 'd-over' : d <= 3 ? 'd-soon' : d <= 7 ? 'd-week' : 'd-far';
    const daysTxt = d < 0 ? `${-d}<small>天前</small>` : d === 0 ? `今<small>到期</small>` : `${d}<small>天后</small>`;
    // muted＝不单独提醒：状态关了提醒（Ending 到期不续），或这期会自动续（auto）。还在时间线上，但不该催人
    const meta = [collName(it.kind), it.cycle, it.action, it.auto ? '自动续费' : it.muted ? '不提醒' : '']
      .filter(Boolean).join(' · ');
    const li = document.createElement('li');
    li.className = cls + (it.muted ? ' quiet' : '');
    li.style.setProperty('--i', Math.min(idx, 12)); // 错峰封顶：长列表末尾不必干等一秒多
    li.innerHTML = `
      <span class="days">${daysTxt}</span>
      <span class="due">${esc(it.due)}</span>
      <span class="what"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(meta)}</div></span>
      <span class="amt">${amtHtml(it.currency, it.price)}</span>
      <button class="btn mini ghost" data-renew="${esc(it.kind)}:${it.id}" type="button">已${esc(it.verb || '续费')}</button>`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('[data-renew]').forEach(b => b.onclick = () => doRenew(b.dataset.renew, b));

  // 该上时间线却算不出到期日的条目。不点名的话它们既不在这张表上、也不进日历、
  // 更不会提醒——你以为在管，其实它从界面上消失了
  const un = $('#up-undated');
  un.hidden = !und.length;
  if (und.length) {
    const names = und.map(x => `${x.name}（缺${x.missing}）`).join('、');
    un.textContent = `⚠ 另有 ${und.length} 项算不出到期日，不会提醒也不进日历：${names}`;
  }
  // 状态不上时间线的（新建默认的 Planned 就是）：日期填了也不在上面，得说一声为什么
  const offEl = $('#up-off');
  offEl.hidden = !off.length;
  if (off.length) {
    const when = d => d === 0 ? '今天' : `${d} 天后`;
    const names = off.map(x => `${x.name}（${x.status} · ${when(x.days_left)}）`).join('、');
    offEl.textContent = `◌ 另有 ${off.length} 项状态不上时间线，到期不会提醒：${names}`;
  }
  // 状态不在所属库词表里的：写入口照收（导入要能先进来），语义只能回落到内置含义，说出来让人补
  const unkEl = $('#up-unknown');
  unkEl.hidden = !unk.length;
  if (unk.length) {
    const names = unk.map(x => `${x.name}（${x.status}）`).join('、');
    unkEl.textContent = `⚠ 另有 ${unk.length} 项的状态不在所属库的词表里，加进词表或改成词表里的值：${names}`;
  }

  syncUpFold();
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

// 折叠只是视觉上收起：不 inert 的话里面的按钮仍在 Tab 序里，回车会对看不见的条目弹出续费确认
function syncUpFold() {
  $('#up-panel').classList.toggle('folded', state.upFolded);
  $('#up-toggle').setAttribute('aria-expanded', String(!state.upFolded));
  $('#up-body').inert = state.upFolded;
}

function toggleUpFold() {
  state.upFolded = !state.upFolded;
  try { localStorage.setItem('kalends.upfold', state.upFolded ? '1' : '0'); }
  catch (e) { console.warn('折叠状态存不进 localStorage，下次开页会回到默认：', e); }
  renderUpcoming();
}

async function setUpWindow(v) {
  const was = [state.upWindow, state.settings['ui.upcoming_days']];
  state.upWindow = v;
  state.settings['ui.upcoming_days'] = v;
  renderUpcoming();
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ 'ui.upcoming_days': v }) });
  } catch (err) {
    // 存不上就退回原档，否则界面停在一个刷新后就会消失的档位上；期间又换过档的不动
    if (state.upWindow === v) {
      [state.upWindow, state.settings['ui.upcoming_days']] = was;
      renderUpcoming();
    }
    toast(err.message, true);
  }
}

$('#up-toggle').onclick = toggleUpFold;
$('#up-title').onclick = toggleUpFold;
$('#up-window').onchange = e => setUpWindow(e.target.value);
$('#up-more').onclick = () => setUpWindow('all');

// 续费后后端给不出到期日：多半是没有周期或买断，但存量里周期写坏、日期越界的也走到这里
const NO_NEXT_DUE = '算不出下一个到期日（没有周期、买断，或周期与日期有误）';

/* 续费确认框：日期默认今天（服务端的本地日），晚几天才来记就改成实际付款那天，台账与起算都落在那天。
   主按钮先聚焦、回车即记：和原生 confirm 一样一下就过，最高频的动作不能被拖慢。 */
let renewAnswer = null; // 开着的那一轮在等的回答；每一轮只答一次
const answerRenew = v => { const a = renewAnswer; renewAnswer = null; a?.(v); };
function renewDialog() {
  let d = $('#dlg-renew');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'dlg-renew';
  d.setAttribute('aria-labelledby', 'dlg-renew-title');
  d.innerHTML = `<form method="dialog">
      <h3 id="dlg-renew-title"></h3>
      <div class="fgrid">
        <label class="span2"><span id="dlg-renew-label"></span><input type="date" data-r="date"></label>
      </div>
      <p class="fp-note">晚几天才来记的，改成实际付款那天</p>
      <p id="dlg-renew-note" class="fp-note" hidden></p>
      <footer>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn primary">记账</button>
      </footer>
    </form>`;
  document.body.appendChild(d);
  d.querySelector('[data-close]').onclick = () => d.close();
  // 结果在提交那一刻同步取。close 是排队派发的，上一轮的可能晚到、落在这一轮开框之后，靠它判结果会张冠李戴
  d.querySelector('form').addEventListener('submit', () => answerRenew(d.querySelector('[data-r="date"]').value));
  d.addEventListener('close', () => { if (!d.open) answerRenew(null); });
  return d;
}

/* 问一次付款日期：确认回所选日期（空串＝交给服务端按今天记），取消回 null。
   paidDays 是这一条已有台账的日子：选中其中一天要说出来，否则在途丢了响应再点一次就多记一笔。 */
function askRenewDate(title, verb, paidDays) {
  const d = renewDialog();
  const today = state.overview?.today || '';
  const inp = d.querySelector('[data-r="date"]');
  const note = $('#dlg-renew-note');
  $('#dlg-renew-title').textContent = title;
  $('#dlg-renew-label').textContent = `${verb}日期`;
  inp.value = today;
  inp.max = today;
  inp.oninput = () => {
    const day = inp.value || today;
    note.hidden = !paidDays.includes(day);
    note.textContent = `${day === today ? '今天' : day}已经记过一笔${verb}，再记就是第二笔`;
  };
  inp.oninput();
  answerRenew(null); // 框能再开说明上一轮已经关了；没被提交答掉的就是取消
  d.showModal();
  d.querySelector('[type="submit"]').focus();
  return new Promise(done => { renewAnswer = done; });
}

async function doRenew(key, btn) {
  const [kind, id] = key.split(':');
  // 表格里的行未必落在到期窗口内，所以先从本库找，找不到再回退到到期时间线
  const it = (state[kind] || []).find(x => x.id === +id)
    || (state.overview?.upcoming || []).find(u => u.kind === kind && u.id === +id);
  const verb = it?.verb || collOf(kind)?.verb || '续费';
  if (busyWrite(`item:${id}`)) return void toast('上一次还在处理，稍等', true);
  let paidDays = [];
  try {
    paidDays = (await api('/api/ledger')).filter(r => r.kind === kind && r.item_id === +id).map(r => r.renewed_at);
  } catch { /* 读不出台账只是少提醒这一句，照常确认 */ }
  const paidOn = await askRenewDate(`记一笔「${it?.name || ''}」的${verb}`, verb, paidDays);
  if (paidOn === null) return;
  // 慢链路上一个往返内毫无动静，用户就会再点一次、再确认一次——多记一笔、多推一期
  const was = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '记账中…'; }
  const body = JSON.stringify(paidOn ? { renewed_at: paidOn } : {});
  const r = await write(`item:${id}`, () => api(`/api/items/${id}/renew`, { method: 'POST', body }), {
    once: true,
    // 报出下次到期是哪天（renew_from='today' 会把账单日拽走，说出来才看得见）；日期由后端算，前端不自己算
    done: r => r?.due ? `已记账，下次到期 ${r.due}` : `已记一笔；${NO_NEXT_DUE}`,
  });
  if (btn?.isConnected) { btn.disabled = false; btn.textContent = was; }
  // 推不动日期的（没有周期的证件、买断）：记完账就开表单让人当场填新的到期日
  const fresh = r && !r.due && state[kind]?.find(x => x.id === +id);
  if (fresh) openItemDialog(kind, fresh, { focus: 'next_renewal', note: `已记一笔${verb}；${NO_NEXT_DUE}——在这里填上新的到期日再保存` });
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
