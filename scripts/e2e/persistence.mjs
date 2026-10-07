// 刷新持久化：本机视图（排序、列序、列宽、折叠）与服务端设置（窗口）都要活过整页导航。
export default async function (t) {
  const { APP, sleep, check, send, evl, shot, menuClick, dragW, waitFor, consoleMsgs } = t;
  // 刷新前的状态原先由别的段落顺手留下（列序拖动、拖宽后的 fixed 布局）；现在自己摆好
  await dragW(60); // 留一份手动列宽 → fixed 布局
  await sleep(150);
  await evl(`(() => {
    const src = document.querySelector('#view-subs th[data-k="category"]');
    const dst = document.querySelector('#view-subs th[data-k="name"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r.left + 2 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  })()`);
  await sleep(250);

  /* 15. 刷新持久化 */
  await evl(`document.querySelector('.tab[data-tab="subs"]').click()`);
  await sleep(150);
  check('刷新前设升序', await menuClick('#view-subs th[data-k="price"]', '升序'));
  await evl(`(() => { const s = document.querySelector('#up-window'); s.value = '14'; s.dispatchEvent(new Event('change')); })()`);
  await evl(`localStorage.setItem('kalends.upfold', '1')`);
  await sleep(400);
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 50; i++) { await sleep(200); if (await evl(`document.querySelector('#up-window')?.value`)) break; }
  await sleep(500);
  check('刷新后窗口=14', await evl(`document.querySelector('#up-window').value`) === '14');
  check('刷新后保持折叠', await evl(`document.querySelector('#up-panel').classList.contains('folded')`) === true);
  check('刷新后首列分类', await evl(`document.querySelector('#view-subs thead th').dataset.k`) === 'category');
  check('刷新后 fixed 列宽', await evl(`document.querySelector('#view-subs table').classList.contains('fixed')`) === true);
  check('刷新后排序胶囊在', await evl(`!!document.querySelector('#view-pills .p-sort')`) === true);
  await shot('08-reloaded-folded');

  // 本机视图偏好来自 localStorage（旧代码、别的设备、手改都可能写下坏形状）：
  // 形状不对的项回默认，哪一张表都不能白屏；指着已不在的列的排序与类型覆写一并清掉
  const reload = async () => {
    await send('Page.navigate', { url: APP });
    await sleep(300);
    return waitFor(`document.querySelectorAll('#up-list li').length > 0`, 8000);
  };
  const keysNow = await evl(`views.subs.keys`);
  await evl(`localStorage.setItem('kalends.views.v1', JSON.stringify({
    subs: { keys: ${JSON.stringify(keysNow)}, filters: null, q: 5, hiddenCols: 'name', collapsed: 7,
            sort: { key: 'c9999', dir: 1 }, types: { c9999: 'sel' } },
    sims: { keys: ['x'], widths: null, hiddenCols: null, order: 'x' },
    vps: { keys: ['y'], q: {}, hiddenCols: {}, collapsed: {}, order: {} },
  }))`);
  await reload();
  const rowsOf = k => evl(`document.querySelectorAll('#${k}-body tr').length`);
  const counts = [await rowsOf('subs'), await rowsOf('sims'), await rowsOf('vps')];
  check('坏形状的视图偏好不让任何一张表白屏', counts.every(n => n > 0), JSON.stringify(counts));
  check('指着已不在的列的排序与类型覆写被清掉',
    await evl(`views.subs.sort === null && !('c9999' in views.subs.types)`) === true);

  // 浏览器禁了站点存储时连读 localStorage 都抛 SecurityError：页面照常渲染，只是偏好不保留
  const n0 = consoleMsgs.length;
  const block = await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'localStorage',
    { get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); } });` });
  check('禁了站点存储，首页与表格照常渲染', await reload() && await rowsOf('subs') > 0);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: block.result.identifier });
  // 「偏好存不进 localStorage」的 warn 是这一段期望的产物，异常不是
  const extra = consoleMsgs.splice(n0);
  check('禁了存储只留存不进的提示，没有异常', extra.every(m => m.startsWith('warning: ') && m.includes('localStorage')),
    JSON.stringify(extra.slice(0, 3)));


}
