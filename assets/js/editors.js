/* Kalends 前端 · editors.js —— 点格即编：各类型的就地编辑器（多输入/单选/多选/周期/
   费用/模板列）与点击委托。加载方式与作用域约定见 core.js 头注。 */

/* 后端是局部更新语义：出现的键写入（"" 与 null 都是清空），缺席的键保持原值，extra
   整体替换——所以只发改动的键。**但清空必须显式写 null**：JSON.stringify 会把
   undefined 连键一起丢掉，键缺席在这套语义里是"别动它"。 */
async function patchRow(tab, it, patch) {
  try {
    await api(`/api/items/${it.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await loadAll();
  } catch (err) { toast(err.message, true); }
}

// 复合格与字段名映射；没列出的格按列的有效类型走通用编辑器（字段名=列键）
const CELL_SPEC = {};

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
  const picked = () => [...box.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
  const commit = () => save(picked());
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
    // 读**此刻**勾着的，不是开浮层那会儿的快照：同一次浮层里先取消勾选再回车加值，
    // 拿旧快照会把刚取消掉的那个又带回来
    const sel = picked();
    closePop();
    if (optionsEditable(tab, k) && !values.includes(val)) {
      await putOpts(tab, k, [...storedOpts(tab, k), { v: val }]);
    }
    save(sel.includes(val) ? sel : [...sel, val]);
  });
  box.appendChild(addRow);
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

// 币种候选：数据里用过的 ∪ 汇率表里有的（后者让空库首装时也有东西可选）
function currencyOptions(tab, cur) {
  const used = new Set((state[tab] || []).map(r => fxCode(r.currency)).filter(Boolean));
  if (cur) used.add(fxCode(cur));
  const rest = Object.keys(state.fx?.rates || {}).filter(c => !used.has(c));
  return [...[...used].sort(), ...rest];
}

/* 币种控件：下拉 + 「新选项，回车加入」（与表单 sel 同一套 .sopts/initSoptAdd）——
   纯 select 会让不在汇率表里的币种（TWD）录不进第一笔。**不用 datalist**：
   iOS Safari 上建议列表会盖住输入框，而全 iOS 都是 WebKit，嗅探不掉。 */
function currencyPicker(tab, cur, attrs) {
  const opts = currencyOptions(tab, cur);
  // 费用格是「金额 + 币种」两枚控件共一个 label，而 label 只关联第一枚——币种得自报名字
  return `<span class="sopts"><select class="mini-select" aria-label="币种" ${attrs}><option value="">—</option>${
    opts.map(c => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('')
  }</select><input class="sopt-add cur-add" placeholder="新币种，回车加入" maxlength="8"
    aria-label="加一个新币种，回车加入"></span>`;
}

/* 费用格是复合格：金额 + 币种（币种并进这一格、不单独占列）。
   与周期那格同形——按列键特判，不为此新造字段类型。 */
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
    // 值按注册表的 src 取：模板串引用真列键是允许的定制，恒读写 extra 会生出同名键
    // 把真列**遮蔽**掉——规格格显示 extra 那份、engine 读真列，两格各说各话
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
      const type = TYPES[p.ftype]?.input || 'text'; // 控件类型查类型表，别在这儿另立一份映射
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
  // 这一类型专属的编辑器（单选/状态点值即存、多选勾选即存）由类型表给；没有就落到下面的通用框
  const own = TYPES[t]?.editor;
  if (own) return own({ tab, it, td, k, col, toExtra, save });
  const f = spec.f || k;
  const type = TYPES[t]?.input || 'text';
  return inputsEditor(tab, it, td, [[f, colLabel(tab, k), type]], patch => {
    if (toExtra) return patchRow(tab, it, extraPatch(it, k, patch[f] ?? ''));
    return patchRow(tab, it, patch);
  });
}

// 点击委托：按钮/链接照旧，其余格子进就地编辑。挂在 document 上、按 tbody 的 data-tab
// 认表，后建的库自然生效——写死成 tbody 选择器列表的话，自建库的格子点了毫无反应
document.addEventListener('click', e => {
  if (e.target.closest('button, a, input, select, textarea, label')) return;
  const td = e.target.closest('td');
  const tab = td?.closest('tbody[data-tab]')?.dataset.tab;
  if (!tab || !td.dataset.k || td.dataset.k === 'ops') return;
  const it = state[tab]?.find(x => x.id === +td.closest('tr').dataset.id);
  if (it) openCellPop(tab, it, td.dataset.k, td);
});
