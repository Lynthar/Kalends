/* Kalends 前端 · collections.js
   库这一侧：标签与容器的生成、库序拖动、通用行渲染、通用详情表单（含 logo 与父条目）、库管理对话框。

   **这些文件是普通 <script>，共享同一个全局作用域，按 index.html 里的顺序执行。**
   不是 ES module，也不打算是：e2e 有十几处靠 `evl('loadAll()')` 这样直接调全局函数，
   换成模块作用域会让整套断言一起报废；而"零构建步骤"这条也不允许引打包器。
   拆分本身是纯搬运——**加东西时放进对应的那份，别又长回一个大文件**。
*/

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
  const numeric = !!TYPES[t]?.numeric;
  const isCycle = f.src === 'col' && f.key === 'cycle';
  const get = r => fieldVal(f, r);
  return {
    t, fkey: f.key, src: f.src, custom: f.builtin ? 0 : f.id,
    conv: CONV_TYPES.includes(t) ? 1 : 0,
    ord: f.key === 'status' ? statusOrder(key) : null,
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
  // 否则它们连拖都拖不动（真踩过）。
  // **右键开库设置已于 2026-08-15 撤掉**：不看文档发现不了，而齿轮就在旁边，同一件事两个入口
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.onclick = () => switchTab(key);
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
      // 模板列单列一支：它在 COLS 里被映射成 text，走 cellVal 会连带吃到"文本列可切换呈现"
      if (f.ftype === 'tpl') return `<td class="cdate">${esc(v || '')}</td>`;
      // 其余一律：class 与要不要 title 由类型表说了算，内容一律交给 cellVal
      const ts = TYPES[f.ftype] || {};
      return `<td${ts.td ? ` class="${ts.td}"` : ''}${ts.title ? ` title="${esc(v ?? '')}"` : ''}>${cellVal(key, f.key, v)}</td>`;
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
   免得多选/单选这几种非平凡控件各写一遍、各漏一处。

   **一个 `<label>` 只配一枚控件**：多选是一串各带自己 label 的勾选框，外层再套 label 就是
   嵌套（规范不允许，读屏读出的关联也是错的），所以那一支用 `div[role=group]` +
   `aria-labelledby` —— 拿到的可访问性结果一样，还不用背 fieldset 的默认边框与
   grid 里 `min-width:auto` 那些包袱。栅格样式因此要认 `.field`（见 `.fgrid label, .fgrid .field`）。 */
let grpSeq = 0;
function fieldControl(key, f, it) {
  const v = it ? fieldRaw(f, it) : ''; // 编辑值，不是格子里那份呈现
  const val = Array.isArray(v) ? v.join(', ') : (v ?? '');
  const grouped = !!TYPES[f.ftype]?.group; // 里面是一串控件，不是单独一枚
  const lab = document.createElement(grouped ? 'div' : 'label');
  if (grouped) {
    const gid = `grp-${++grpSeq}`;
    lab.className = 'field';
    lab.setAttribute('role', 'group');
    lab.setAttribute('aria-labelledby', gid);
    lab.dataset.gid = gid;
  }
  if (f.ftype === 'multi') {
    // 勾选清单，不是逗号分隔的文本框——值里含 , ， 、 / 时，文本框存回去会把它拆成两个
    const cur = new Set(Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
    const opts = fieldOptions(key, f);
    for (const x of cur) if (!opts.includes(x)) opts.push(x);
    lab.className = 'field span2';
    // 勾选框超过三行就在自己的框里滚（长词表如 VPS 地点有 19 个值，否则把费用/到期挤出首屏）；
    // 「新选项」输入框留在滚动框外，不然想加值得先滚到底
    lab.innerHTML = `<span id="${lab.dataset.gid}">${esc(f.name || f.key)}</span>
      <span class="mopts"><span class="mchecks" data-mbox="${esc(f.key)}">${opts.map(o =>
        `<label class="check"><input type="checkbox" value="${esc(o)}"${cur.has(o) ? ' checked' : ''}><span>${esc(o)}</span></label>`
      ).join('')}</span><input class="mopt-add" placeholder="新选项，回车加入" aria-label="给「${esc(f.name || f.key)}」加一个新选项，回车加入"></span>`;
    initMoptAdd(lab.querySelector('.mopt-add'));
  } else if (f.ftype === 'sel') {
    const cur = val === '' ? '' : String(val);
    const sel = `<select data-f="${esc(f.key)}"><option value=""></option>${selOptions(key, f, cur).map(o =>
      `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    // 开放词表配一个「新选项」输入框，不然空库首装时这一栏是个填不出东西的死胡同
    lab.innerHTML = `<span>${esc(f.name || f.key)}</span>`
      + (fixedVocab(f) ? sel : `<span class="sopts">${sel}<input class="sopt-add" placeholder="新选项，回车加入"
          aria-label="给「${esc(f.name || f.key)}」加一个新选项，回车加入"></span>`);
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
    const type = TYPES[f.ftype]?.input || 'text';
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
  // 里面是三颗按钮加一个文件选择框，不是单独一枚控件——用 group 而不是 label：
  // 套在 label 里的话它会关联到那个隐藏的 file input，点按钮还可能顺带触发一次文件选择
  const lab = document.createElement('div');
  lab.className = 'field span2';
  lab.setAttribute('role', 'group');
  lab.setAttribute('aria-labelledby', 'logo-row-label');
  lab.innerHTML = `<span id="logo-row-label">图标</span>
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
   语义下把字段清掉的那类事故。multi 没有单一的 [data-f]，所以要分支读。 */
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
  return TYPES[f.ftype]?.numeric ? (v === '' ? null : Number(v)) : v;
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
