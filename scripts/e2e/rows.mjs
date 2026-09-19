// 行：选区与批量删除、手动排序（pos）、真拖放、键盘挪行、拖手菜单。
export default async function (t) {
  const { APP, sleep, post, raw, items, check, evl, shot, menuClick } = t;
  /* 17.16. 多选与批量删除：行末那颗「删」已经撤了，选区 + 批量条是唯一的删除出口。 */
  check('行末不再有「删」按钮',
    await evl(`!!document.querySelector('#subs-body tr td.ops [data-del]')`) === false);
  check('没勾选时批量条是收着的', await evl(`document.querySelector('#bulkbar').hidden`) === true);
  await evl(`(() => { const b = document.querySelector('#subs-body tr [data-sel]'); b.checked = true; b.dispatchEvent(new Event('change')); })()`);
  await sleep(250);
  check('勾一行就浮出批量条', await evl(`document.querySelector('#bulkbar').hidden`) === false);
  check('批量条报出选中数', (await evl(`document.querySelector('#bulk-n').textContent`)).includes('1'));
  check('选中的行有高亮', await evl(`!!document.querySelector('#subs-body tr.selrow')`) === true);
  check('勾选后复选框常驻（表上挂 .selecting）',
    await evl(`!!document.querySelector('#view-subs table.selecting')`) === true);
  await evl(`document.querySelector('#view-subs thead [data-selall]').checked = true;
             document.querySelector('#view-subs thead [data-selall]').dispatchEvent(new Event('change'))`);
  await sleep(250);
  const subsRowsNow = await evl(`document.querySelectorAll('#subs-body tr').length`);
  check('全选把整表勾上', await evl(`document.querySelectorAll('#subs-body tr.selrow').length`) === subsRowsNow);
  await evl(`document.querySelector('#bulk-clear').click()`);
  await sleep(200);
  check('取消把选区清干净', await evl(`document.querySelector('#bulkbar').hidden`) === true);
  check('取消后行高亮也撤了', await evl(`document.querySelectorAll('#subs-body tr.selrow').length`) === 0);
  // 真删：建两条一次性条目再批量删掉，别动播种数据
  const bulkA = await post('/api/collections/subs/items', { name: '批量甲', status: 'Planned' });
  const bulkB = await post('/api/collections/subs/items', { name: '批量乙', status: 'Planned' });
  const delRes = await (await raw('/api/items/bulk_delete', 'POST', { ids: [bulkA.id, bulkB.id] })).json();
  check('批量删除端点一次删两条', delRes.deleted === 2, JSON.stringify(delRes));
  const afterBulk = await (await fetch(APP + 'api/collections/subs/items')).json();
  check('两条都没了', afterBulk.some(x => x.id === bulkA.id || x.id === bulkB.id) === false);
  check('批量删除缺 ids → 400', (await raw('/api/items/bulk_delete', 'POST', {})).status === 400);
  // 换表要把选区带走，否则会对着看不见的表按删除
  await evl(`(() => { const b = document.querySelector('#subs-body tr [data-sel]'); b.checked = true; b.dispatchEvent(new Event('change')); })()`);
  await sleep(200);
  await evl(`switchTab('vps')`);
  await sleep(300);
  check('换表清掉选区', await evl(`document.querySelector('#bulkbar').hidden`) === true);
  await evl(`switchTab('subs')`);
  await sleep(300);


  /* 17.17. 手动排序：无列排序时的基态就是 pos（此前是名称字母序，拖出来的顺序无处安放）。
     按列排序时拖动的位置存不住，手柄随之停用。 */
  // 前面的段落留了列排序在身上，先还原到该走的分支——否则测的是「按列排序」那条路
  await evl(`setSort('subs', 'price', null)`);
  await sleep(300);
  // 子行是吸附在父行下渲染的，所以单调性只对顶层行成立
  check('无排序时顶层按 pos 排', await evl(`(() => {
    const pos = [...document.querySelectorAll('#subs-body tr:not(.subrow)')]
      .map(t => state.subs.find(x => x.id === +t.dataset.id).pos);
    return pos.every((p, i) => i === 0 || p >= pos[i - 1]);
  })()`) === true);
  const ordBefore = await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`);
  // 把顶层第一行挪到第二个顶层行之后（子行跟着父行整块走）
  const topIds = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
  await evl(`applyRowOrder('subs', moveRow('subs', ${topIds[0]}, ${topIds[1]}, true))`);
  await sleep(600);
  const ordAfter = await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`);
  check('拖动改变了行序', JSON.stringify(ordAfter) !== JSON.stringify(ordBefore),
    `${ordBefore} → ${ordAfter}`);
  check('新序落了库', await (async () => {
    const rows = await (await fetch(APP + 'api/collections/subs/items')).json();
    const byPos = [...rows].sort((a, b) => a.pos - b.pos).map(r => r.id);
    return JSON.stringify(byPos) === JSON.stringify(ordAfter);
  })() === true);
  check('刷新之后顺序还在', await (async () => {
    await evl(`loadAll()`); await sleep(600);
    const now = await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`);
    return JSON.stringify(now) === JSON.stringify(ordAfter);
  })() === true);
  // 父行整块搬：子行仍然紧跟着它的父行
  check('子行仍吸附在父行下', await evl(`(() => {
    const trs = [...document.querySelectorAll('#subs-body tr')];
    return trs.every((t, i) => !t.classList.contains('subrow') || (i > 0 && !trs[i - 1].classList.contains('subrow')
      || state.subs.find(x => x.id === +t.dataset.id).parent_id === state.subs.find(x => x.id === +trs[i - 1].dataset.id).parent_id));
  })()`) === true);
  // 同级约束：把子行拖到顶层行上要被拦下
  const kidId = await evl(`state.subs.find(x => x.parent_id)?.id`);
  check('子行拖不到顶层去', await evl(`moveRow('subs', ${kidId}, ${topIds[0]}, true)`) === null);
  // 按列排序时手柄停用
  await menuClick('#view-subs th[data-k="price"]', '升序');
  await sleep(300);
  check('按列排序后手柄停用', await evl(`!!document.querySelector('#subs-body .rgrip.off')`) === true);
  check('停用的手柄给出了原因',
    (await evl(`document.querySelector('#subs-body .rgrip').title`)).includes('清掉列排序'));
  await evl(`setSort('subs', 'price', null)`);
  await sleep(300);
  check('清掉排序后手柄又能拖', await evl(`!!document.querySelector('#subs-body .rgrip.off')`) === false);


  /* 17.17b. 真走一遍拖放事件：上面几条都是直接调 moveRow/applyRowOrder，绕开了 dragstart→
     dragover→drop 这一段。行拖动要先按住手柄才开得动，所以第一步是 mousedown。 */
  const rowDragIds = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
  const rowDrag2 = async (srcId, dstId, toBottom) => evl(`(() => {
    const src = document.querySelector('#subs-body tr[data-id="${srcId}"]');
    const dst = document.querySelector('#subs-body tr[data-id="${dstId}"]');
    src.querySelector('[data-grip]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    const y = ${toBottom} ? r.bottom - 2 : r.top + 2;
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  })()`);
  await rowDrag2(rowDragIds[0], rowDragIds[1], true);
  await sleep(800);
  check('拖放事件真能换行序', (await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`))[1] === rowDragIds[0],
    JSON.stringify(await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`)));
  check('拖完不留标记', await evl(`!document.querySelector('.dragging, .drop-before, .drop-after')`) === true);
  await rowDrag2(rowDragIds[0], rowDragIds[1], false);
  await sleep(800);
  check('反向拖回原位', JSON.stringify(await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`))
    === JSON.stringify(rowDragIds));


  /* 17.18. 键盘挪行：手柄不进 Tab 序（一行一个停靠点已经够多），改用复选框上的 Alt+↑/↓。 */
  const kbBefore = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
  await evl(`nudgeRow('subs', ${kbBefore[0]}, 1)`);
  await sleep(600);
  const kbAfter = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
  check('Alt+↓ 把行往下挪了一格', kbAfter[1] === kbBefore[0], `${kbBefore} → ${kbAfter}`);
  await evl(`nudgeRow('subs', ${kbBefore[0]}, -1)`);
  await sleep(600);
  check('Alt+↑ 挪得回来',
    JSON.stringify(await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`))
    === JSON.stringify(kbBefore));
  check('手柄不在 Tab 序里', await evl(`document.querySelector('#subs-body .rgrip').tabIndex`) === -1);
  check('复选框可聚焦', await evl(`document.querySelector('#subs-body [data-sel]').tabIndex`) !== -1);


  /* 17.18b. 拖手的点击菜单：拖不了的场合（触摸屏）的单指针挪行，与 Alt+↑↓ 同一条 nudgeRow */
  await evl(`document.querySelector('#subs-body tr[data-id="${kbBefore[0]}"] .rgrip').click()`);
  await sleep(250);
  check('拖手点开挪行菜单', await evl(`[...document.querySelectorAll('.thmenu .mi')].map(b => b.textContent.replace(/[↑↓]/g, '')).join()`) === '上移一行,下移一行');
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('下移一行')).click()`);
  await sleep(600);
  check('菜单下移把行挪下去了', (await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`))[1] === kbBefore[0]);
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('上移一行')).click()`);
  await sleep(600);
  check('菜单上移挪得回来',
    JSON.stringify(await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`))
    === JSON.stringify(kbBefore));
  await evl(`closePop()`);
  await sleep(120);

  // 拍在该看的状态下：滚到表格、勾两行，让浮标（复选框常驻）、行高亮与批量条一起入镜
  await evl(`document.querySelector('#view-subs').scrollIntoView({ block: 'center' })`);
  await evl(`[...document.querySelectorAll('#subs-body tr [data-sel]')].slice(0, 2)
    .forEach(b => { b.checked = true; b.dispatchEvent(new Event('change')); })`);
  await sleep(400);
  await shot('22-row-gutter');
  await evl(`document.querySelector('#bulk-clear').click()`);
  await sleep(200);


}
