/* Kalends 前端 · types.js
   **属性内核：一种字段类型的全部行为集中在这一张表里。**

   在此之前它散在十处——类型名、表头图标、筛选样式、操作符组、可否切换呈现、排序取值、
   单元格渲染、td 造型、就地编辑器、详情表单控件——加一种类型要挨个接一遍，
   漏哪处就在哪处静默失守（R4 那轮 18 条发现里有 6 条正是这个成因）。

   **加一种类型 = 这里加一行 + 后端 `fields::FTYPES` 加一项**（有形状的再补一段
   `collections::normalize_shaped`）。别再往下面那些分派点里塞 if。

   每一行的字段：
     label    属性菜单与「新建列」下拉里的名字
     filter   'list' 勾选清单 · 'text'/'num'/'date' 三组操作符之一
     conv     1＝值就是纯文本，可在 文本/单选/多选 三种呈现间切换
     numeric  1＝排序按数值比较（否则按中文串）
     group    1＝详情表单里它是一串控件，外层要用 group 而不是 label
     title    1＝td 上挂 title（长文本列悬停看全）
     input    详情表单与就地编辑器用的 <input type>，缺省 text
     td       单元格的 class，缺省无
     cell     单元格渲染，缺省＝转义后的纯文本
     editor   就地编辑器，缺省＝通用的多输入迷你表单
     icon     表头图标

   `cell`/`editor` 里引用的函数住在后面几份文件（table / editors），都在函数体内、
   调用时才解析——所以这一份可以先加载。 */
const TYPES = {
  text: {
    label: '文本',
    filter: 'text',
    conv: 1,
    title: 1,
    td: 'muted clip',
    icon: '<svg viewBox="0 0 16 16"><text x="1.2" y="12" font-size="11" font-weight="600" fill="currentColor">Aa</text></svg>',
  },
  num: {
    label: '数字',
    filter: 'num',
    numeric: 1,
    input: 'number',
    td: 'amt',
    icon: '<svg viewBox="0 0 16 16"><text x="4" y="12.6" font-size="12.5" font-weight="600" fill="currentColor">#</text></svg>',
  },
  sel: {
    label: '单选',
    filter: 'list',
    conv: 1,
    cell: (v, tab, k) => tagFor(tab, k, v),
    editor: ({ tab, it, td, k, save }) => pickEditor(tab, it, td, k, save),
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M5.6 7l2.4 2.4L10.4 7"/></svg>',
  },
  multi: {
    label: '多选',
    filter: 'list',
    conv: 1,
    group: 1,
    cell: (v, tab, k) => tagsFor(tab, k, Array.isArray(v) ? v : splitVals(v)),
    editor: ({ tab, it, td, k, col, toExtra }) => multiEditor(tab, it, td, k, sel => {
      if (toExtra) return patchRow(tab, it, extraPatch(it, k, sel));
      if (col.src === 'col') return patchRow(tab, it, { [k]: sel });
      return patchRow(tab, it, { [k]: sel.join(', ') }); // 文本列的多选呈现：拼回字符串
    }),
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.4" cy="4" r=".95" fill="currentColor" stroke="none"/><circle cx="2.4" cy="8" r=".95" fill="currentColor" stroke="none"/><circle cx="2.4" cy="12" r=".95" fill="currentColor" stroke="none"/></svg>',
  },
  status: {
    label: '状态',
    filter: 'list',
    editor: ({ tab, it, td, k, save }) => pickEditor(tab, it, td, k, save),
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.6" opacity=".35"/><path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"/></svg>',
  },
  date: {
    label: '日期',
    filter: 'date',
    input: 'date',
    td: 'cdate',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.6"/><path d="M2.5 6.8h11M5.6 2v2.6M10.4 2v2.6"/></svg>',
  },
  tel: {
    label: '电话',
    filter: 'text',
    input: 'tel',
    td: 'cdate',
    cell: v => `<a class="tel" href="${esc(telHref(v))}">${esc(v)}</a>`
      + (telSuspect(v) ? '<span class="tel-warn" title="位数偏少，可能只填了国家码">?</span>' : ''),
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M5.2 2.4 6.6 5 5.3 6.6c.8 1.7 2.4 3.3 4.1 4.1L11 9.4l2.6 1.4v2.4c0 .5-.4.9-.9.8C7.2 13.5 2.5 8.8 1.8 3.3c-.1-.5.3-.9.8-.9z"/></svg>',
  },
  url: {
    label: '网址',
    filter: 'text',
    input: 'url',
    td: 'clip',
    cell: v => { const href = safeUrl(v);
      return href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(urlHost(v))} ↗</a>` : esc(String(v)); },
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.6 8.7a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/></svg>',
  },
  email: {
    label: '邮箱',
    filter: 'text',
    input: 'email',
    td: 'clip',
    cell: v => `<a href="mailto:${esc(v)}">${esc(v)}</a>`,
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2" y="3.6" width="12" height="8.8" rx="1.4"/><path d="m2.6 4.4 5.4 4 5.4-4"/></svg>',
  },
};

// 下面几个是从上表派生的，别再各自维护一份
const LIST_TYPES = Object.keys(TYPES).filter(t => TYPES[t].filter === 'list');
const CONV_TYPES = Object.keys(TYPES).filter(t => TYPES[t].conv); // 纯文本值列可切换呈现
