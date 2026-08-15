/* Kalends 前端 · fields.js
   字段属性编辑：选项管理（增删改名、配色、手动调序）、新建/改名/删列、状态语义与新增状态值。

   **这些文件是普通 <script>，共享同一个全局作用域，按 index.html 里的顺序执行。**
   不是 ES module，也不打算是：e2e 有十几处靠 `evl('loadAll()')` 这样直接调全局函数，
   换成模块作用域会让整套断言一起报废；而"零构建步骤"这条也不允许引打包器。
   拆分本身是纯搬运——**加东西时放进对应的那份，别又长回一个大文件**。
*/

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
      ${Object.entries(TYPES).map(([t, s]) => `<option value="${t}">${s.label}</option>`).join('')}
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
    b.innerHTML = `<span class="ticon">${TYPES[t].icon}</span>${esc(TYPES[t].label)}${t === cur ? '<span class="mon">✓</span>' : ''}`;
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
    ticon: TYPES[t].icon, t: `类型 · ${TYPES[t].label}`,
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
