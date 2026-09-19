// 各处修复的回归，落在缺陷真会发作的那一刻：币种现打、loadAll 不重建表头、汇率拉不到照常渲染。
export default async function (t) {
  const { APP, sleep, mk, items, check, send, evl } = t;
  /* 17.31 ④⑤⑥（①②在 api 套件，③在 overview） */
  const nx_new = await mk('subs', { name: '后来的条目', status: 'Active' });
  await evl(`loadAll()`);
  await sleep(900);
  // ④ 币种可以现打：TWD 这类不在内置汇率表里的币种，从前在界面上根本录不进第一笔
  await evl(`switchTab('subs')`);
  await sleep(300);
  const nx_priceTd = `document.querySelector('#subs-body tr[data-id="${nx_new.id}"] td[data-k="price"]')`;
  await evl(`${nx_priceTd}.scrollIntoView({ block: 'center' })`);
  await sleep(250);
  await evl(`${nx_priceTd}.click()`);
  await sleep(300);
  // 与表单里的 sel 字段同一套：下拉 + 「新选项，回车加入」（datalist 那条路早被拍板否掉）
  check('币种下拉旁有「新币种」输入', await evl(
    `!!document.querySelector('.cellpop .sopts select[data-cur]')
     && !!document.querySelector('.cellpop .sopts .cur-add')`) === true);
  await evl(`document.querySelector('.cellpop .cur-add').focus()`);
  await send('Input.insertText', { text: 'twd' });
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(250);
  check('回车把手打的币种加进下拉并选中（顺手大写）',
    await evl(`document.querySelector('.cellpop [data-cur]')?.value`) === 'TWD');
  await evl(`(() => {
    document.querySelector('.cellpop [data-price]').value = '350';
    document.querySelector('.cellpop .cp-foot button').click();
  })()`);
  await sleep(900);
  const nx_saved = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(r => r.id === nx_new.id);
  check('手打的币种存得进去，且规范成大写', nx_saved?.currency === 'TWD' && nx_saved?.price === 350,
    JSON.stringify([nx_saved?.currency, nx_saved?.price]));


  // ⑤ 全量加载不再整份重建库表头：从前拿"被 initHead 注入过图标与拖拽结构的 innerHTML"
  //    去比对原始模板串，必然不相等，于是每次 loadAll 都白重建一遍并重新绑事件
  await evl(`document.querySelector('.tablewrap[data-tab="subs"] thead th').dataset.probe = 'kept'`);
  await evl(`loadAll()`);
  await sleep(900);
  check('loadAll 不再重建库表头',
    await evl(`document.querySelector('.tablewrap[data-tab="subs"] thead th')?.dataset.probe`) === 'kept');


  // ⑥ 汇率是辅助资源：它拉不到也不该让整页渲染不出来
  //    （从前它就在首屏那一批 Promise.all 里，一起被拖垮时表格是空的）
  await evl(`(() => { window._rf = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/fx') ? Promise.reject(new Error('装作拉不到')) : window._rf(u, o); })()`);
  // 先把行清空：不清的话上一轮渲染的行还在，"渲染出来了"这条断言就没有区分度
  // （首屏被拖垮时 renderAll 根本不会执行，表格停在旧内容上）
  await evl(`document.querySelector('#subs-body').innerHTML = ''`);
  await evl(`loadAll().catch(e => e)`);
  await sleep(1000);
  check('汇率拉不到，表格照常渲染',
    await evl(`document.querySelectorAll('#subs-body tr').length`) > 0);
  await evl(`window.fetch = window._rf`);
  await evl(`loadAll()`);
  await sleep(900);


}
