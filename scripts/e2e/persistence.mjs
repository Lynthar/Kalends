// 刷新持久化：本机视图（排序、列序、列宽、折叠）与服务端设置（窗口）都要活过整页导航。
export default async function (t) {
  const { APP, sleep, check, send, evl, shot, menuClick, dragW } = t;
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


}
