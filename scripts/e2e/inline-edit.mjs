// 点格即编：新建空行、内置字段与 SIM 的就地编辑、筛选中新建、费用格的币种、规格格、多选呈现与浮层快照。
export default async function (t) {
  const { APP, sleep, patch, raw, items, fields, check, day, evl, shot } = t;
  /* 9. ＋新建行直接插一行空行（Notion 式，不再弹表单），右上角那颗绿按钮是建库 */
  const subsN0 = await evl(`document.querySelectorAll('#subs-body tr').length`);
  await evl(`document.querySelector('#view-subs .newrow').click()`);
  await sleep(700);
  check('新建行不再弹表单', await evl(`!!document.querySelector('#dlg-item')?.open`) === false);
  check('直接多出一行', await evl(`document.querySelectorAll('#subs-body tr').length`) === subsN0 + 1);
  check('新行是「未命名」占位', await evl(`!!document.querySelector('#subs-body .unnamed')`) === true);
  // 编辑器开在新行的名称格上。这条曾经假绿过一轮：focusNewRow 先 scrollIntoView 再开浮层，
  // 而滚动事件是异步派发的、全局 scroll 监听会把刚开的浮层关掉——开出来又被自己关掉
  check('就地编辑器开在新行上', await evl(`!!document.querySelector('.cellpop')`) === true,
    await evl(`String(popKey)`));
  check('编辑器认的是新行的名称格', (await evl(`String(popKey)`)).endsWith(':name'));
  await evl(`closePop()`);
  // 收拾干净：后面的断言都按原来的行数算
  const blankId = await evl(`Math.max(...state.subs.map(x => x.id))`);
  await raw(`/api/items/${blankId}`, 'DELETE');
  await evl(`loadAll()`);
  await sleep(500);
  check('收拾回原来的行数', await evl(`document.querySelectorAll('#subs-body tr').length`) === subsN0);
  // 按视觉角色取那颗绿按钮（不按 id——旧版的 ＋ 库 标签也叫 #coll-add，认 id 的断言两版都过）
  const PRIMARY = `document.querySelector('#page-renewals .tab-actions .btn.primary')`;
  check('标签行不再有「＋ 库」', await evl(
    `![...document.querySelectorAll('.tabs .tab')].some(b => b.textContent.includes('库'))`) === true);
  check('动作区绿按钮文案是新增库', await evl(`${PRIMARY}.textContent.trim()`) === '＋ 新增库');
  await evl(`${PRIMARY}.click()`);
  await sleep(500);
  // 两个浮层都是首次用时才注入 DOM，取不到时要判否而不是抛异常（否则后面的断言整批跑不到）
  check('绿按钮开建库浮层而非条目表单', await evl(
    `!!document.querySelector('#dlg-coll')?.open && !document.querySelector('#dlg-item')?.open`) === true);
  await evl(`document.querySelector('#dlg-coll')?.close(); document.querySelector('#dlg-item')?.close()`);
  await sleep(150);


  /* 12c. 内置字段点格即编：文本 / 状态，整行 PUT 不丢字段 */
  await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('ChatGPT')).querySelector('td[data-k="notes"]').click()`);
  await sleep(250);
  await evl(`(() => { const i = document.querySelector('.cellpop input[data-f="notes"]'); i.value = '测试备注'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(700);
  check('备注就地保存', await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('ChatGPT'))?.querySelector('td[data-k="notes"]').textContent.trim()`) === '测试备注');
  const cg = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(x => x.name === 'ChatGPT Plus');
  check('整行 PUT 未丢字段', !!cg && cg.price === 20 && cg.next_renewal === day(45) && cg.extra?.category === 'AI',
    JSON.stringify({ price: cg?.price, next: cg?.next_renewal, cat: cg?.category }));
  await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('旧订阅')).querySelector('td[data-k="status"]').click()`);
  await sleep(250);
  await evl(`[...document.querySelectorAll('.cellpop .mi')].find(x => x.textContent.includes('Planned')).click()`);
  await sleep(700);
  check('状态就地切换', await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('旧订阅'))?.querySelector('td[data-k="status"] .st')?.textContent`) === 'Planned');
  await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('旧订阅')).querySelector('td[data-k="status"]').click()`);
  await sleep(250);
  await evl(`[...document.querySelectorAll('.cellpop .mi')].find(x => x.textContent.includes('Ended')).click()`);
  await sleep(700);
  await shot('14-custom-col');


  /* 12f. SIM 点格即编（整行 PUT 曾在此静默失败） */
  await evl(`document.querySelector('.tab[data-tab="sims"]').click()`);
  await sleep(250);
  await evl(`document.querySelector('#sims-body tr td[data-k="keepalive_action"]').click()`);
  await sleep(250);
  check('SIM 单元格编辑器打开', await evl(`!!document.querySelector('.cellpop input[data-f="keepalive_action"]')`) === true);
  await evl(`(() => { const i = document.querySelector('.cellpop input[data-f="keepalive_action"]'); i.value = 'e2e 改过'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(700);
  check('SIM 点格即编落库', (await (await fetch(`${APP}api/collections/sims/items`)).json()).some(x => x.extra?.keepalive_action === 'e2e 改过'));
  check('SIM 编辑后无错误提示', await evl(`(() => { const t = document.querySelector('#toast'); return t.hidden || !t.classList.contains('err'); })()`) === true);
  // 多选格：值挂在 extra 的内置多选列（形式 / 地点 / 线路）曾经读成空，勾选状态全丢
  await evl(`[...document.querySelectorAll('#sims-body tr')].find(r => r.textContent.includes('Ultra')).querySelector('td[data-k="forms"]').click()`);
  await sleep(300);
  const formsChecked = await evl(`[...document.querySelectorAll('.cellpop input[type=checkbox]:checked')].map(c => c.value).sort().join()`);
  check('SIM 形式多选编辑器带出当前值', formsChecked === 'VOIP,eSIM', formsChecked);
  await evl(`closePop()`);
  await evl(`document.querySelector('.tab[data-tab="subs"]').click()`);
  await sleep(200);


  /* 17.12b. 筛选中新建：新空行必被筛选挡住，此前只有 toast、再点一次就攒空行——
     现在自动清掉本表筛选与搜索并定位到新行。 */
  await evl(`setFilter('subs', 'status', ['Active'])`);
  await sleep(300);
  const nrIds0 = new Set(await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`));
  await evl(`document.querySelector('#view-subs .newrow').click()`);
  await sleep(900);
  const nrNew = (await (await fetch(APP + 'api/collections/subs/items')).json())
    .map(x => x.id).filter(x => !nrIds0.has(x)).sort((a, b) => b - a)[0];
  check('筛选被自动清掉', await evl(`JSON.stringify(views.subs.filters)`) === '{}');
  check('新行落位可见', await evl(`!!document.querySelector('#subs-body tr[data-id="${nrNew}"]')`) === true);
  await evl(`closePop()`);
  await fetch(`${APP}api/items/${nrNew}`, { method: 'DELETE' });
  await evl(`loadAll()`);
  await sleep(600);


  /* 17.20. 币种并进费用格：不再单独占一列，填金额的同时选币种。
     数据层没变——items.price 与 items.currency 仍是两个真列，变的只是「界面上有哪些列」。 */
  await evl(`switchTab('subs')`);
  await sleep(400);
  check('币种不再是一列', await evl(
    `[...document.querySelectorAll('#view-subs thead th')].some(t => t.dataset.k === 'currency')`) === false);
  check('字段注册表里也撤了（迁移 0013）',
    (await (await fetch(APP + 'api/fields')).json()).filter(f => f.key === 'currency').length === 0);
  check('费用格仍然带着币种显示',
    (await evl(`document.querySelector('#subs-body tr td[data-k="price"]')?.textContent`) || '').includes('USD'));
  // 点费用格开的是复合编辑器：金额 + 币种
  const fx_priceTd = `[...document.querySelectorAll('#subs-body tr')].find(t => t.querySelector('td[data-k="price"]')?.textContent.includes('USD')).querySelector('td[data-k="price"]')`;
  await evl(`${fx_priceTd}.click()`);
  await sleep(300);
  check('费用格是金额 + 币种的复合编辑器', await evl(
    `!!document.querySelector('.cellpop [data-price]') && !!document.querySelector('.cellpop [data-cur]')`) === true);
  check('币种下拉里带着这一行的现值',
    await evl(`document.querySelector('.cellpop [data-cur]')?.value`) === 'USD');
  await evl(`closePop()`);
  // 详情表单里也是同一枚控件，且整行 PUT 不会把 currency 清掉
  const fx_curRow = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(r => r.currency === 'USD');
  await evl(`openItemDialog('subs', state.subs.find(x => x.id === ${fx_curRow.id}))`);
  await sleep(450);
  check('详情表单的费用栏里有币种下拉',
    await evl(`!!document.querySelector('#item-fields .pricebox [data-f="currency"]')`) === true);
  check('币种下拉带着现值',
    await evl(`document.querySelector('#item-fields .pricebox [data-f="currency"]').value`) === 'USD');
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1200);
  const fx_afterSave = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(r => r.id === fx_curRow.id);
  check('开表单直接保存不会清掉币种', fx_afterSave?.currency === 'USD', JSON.stringify(fx_afterSave?.currency));
  check('金额也原样', fx_afterSave?.price === fx_curRow.price, `${fx_curRow.price} → ${fx_afterSave?.price}`);
  // 上面两条现在由"缺席即保持"兜着（表单没改币种就不会碰它），改不改代码都绿；真正要钉住的是
  // 「在表单里改了币种能存回去」——currency 不是注册字段，itemBody 得单独读它那枚控件
  await evl(`openItemDialog('subs', state.subs.find(x => x.id === ${fx_curRow.id}))`);
  await sleep(450);
  // 币种是「下拉 + 新选项」：EUR 在内置汇率表里，下拉本就有它，直接选中即可
  await evl(`document.querySelector('#item-fields .pricebox select[data-f="currency"]').value = 'EUR'`);
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1200);
  const fx_changed = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(r => r.id === fx_curRow.id);
  check('在表单里改币种能存回去', fx_changed?.currency === 'EUR', JSON.stringify(fx_changed?.currency));
  // 改回去，后面的断言按 USD 算
  await patch(`/api/items/${fx_curRow.id}`, { ...fx_changed, currency: 'USD' });
  await evl(`loadAll()`);
  await sleep(700);


  /* 17.23. 规格格就地编辑：值分散在几个真字段里，模板串同时声明"显示哪几项、编辑哪几项"。 */
  const vpsSpec = (await (await fetch(`${APP}api/fields`)).json()).find(f => f.tbl === 'vps' && f.key === 'spec');
  check('规格模板串已含端口与流量',
    ['{cores}', '{ram_gb}', '{storage_gb}', '{port_gbps}', '{traffic_tb}'].every(k => vpsSpec.config?.tpl?.includes(k)),
    vpsSpec.config);
  const vpsRow = (await (await fetch(`${APP}api/collections/vps/items`)).json())[0];
  await patch(`/api/items/${vpsRow.id}`, { ...vpsRow, extra: {
    ...(vpsRow.extra || {}), cores: 2, ram_gb: 4, storage_gb: 40, storage_type: 'NVMe', port_gbps: 1, traffic_tb: 2,
  } });
  await evl(`loadAll()`);
  await sleep(900);
  await evl(`switchTab('vps')`);
  await sleep(500);
  check('规格格把六项一起显示出来',
    (await evl(`document.querySelector('#vps-body tr[data-id="${vpsRow.id}"] td[data-k="spec"]')?.textContent || ''`))
      .replace(/\s+/g, ' ').includes('2C / 4G / 40G NVMe / 1Gbps / 2TB'),
    await evl(`document.querySelector('#vps-body tr[data-id="${vpsRow.id}"] td[data-k="spec"]')?.textContent`));

  await evl(`document.querySelector('#vps-body tr[data-id="${vpsRow.id}"] td[data-k="spec"]').click()`);
  await sleep(400);
  check('点规格格开的是复合编辑器，不是详情表单',
    await evl(`!!document.querySelector('.cellpop [data-f="cores"]')`) === true
    && await evl(`document.querySelector('#dlg-item')?.open !== true`) === true);
  check('编辑器按模板串列出六个部分，标签取自字段注册表',
    await evl(`[...document.querySelectorAll('.cellpop [data-f]')].map(e => e.dataset.f).join()`)
      === 'cores,ram_gb,storage_gb,storage_type,port_gbps,traffic_tb');
  check('存储类型是下拉而不是文本框',
    await evl(`document.querySelector('.cellpop [data-f="storage_type"]').tagName`) === 'SELECT');
  await evl(`(() => {
    const i = document.querySelector('.cellpop [data-f="ram_gb"]'); i.value = '8';
    document.querySelector('.cellpop .cp-foot button').click();
  })()`);
  await sleep(900);
  check('就地改内存存回了底层字段，不必开详情表单',
    (await (await fetch(`${APP}api/collections/vps/items`)).json()).find(r => r.id === vpsRow.id).extra.ram_gb === 8);
  check('规格格随之刷新',
    (await evl(`document.querySelector('#vps-body tr[data-id="${vpsRow.id}"] td[data-k="spec"]')?.textContent || ''`)).includes('8G'));


  /* 17.34 ② */
  // ② 文本真列切成「多选」呈现后勾一下：存回去必须是字符串。写数组的话后端读不出来当成空——
  //    那一格的原值被静默清成 NULL，而界面只说「已保存」
  await evl(`(() => { views.subs.hiddenCols = []; views.subs.order = null;
    views.subs.types.notes = 'multi'; saveViews(); })()`);
  const subsForNotes = await (await fetch(APP + 'api/collections/subs/items')).json();
  const noteIt = subsForNotes.find(x => x.name === 'Netflix') || subsForNotes[0];
  await patch(`/api/items/${noteIt.id}`, { notes: '甲, 乙' });
  await evl(`switchTab('subs')`);
  check('切了呈现类型之后 loadAll 不崩', await evl(
    `loadAll().then(() => 'ok', e => 'ERR: ' + (e && e.message))`) === 'ok');
  await sleep(900);
  const openNotes = await evl(`(() => {
    const tr = document.querySelector('#subs-body tr[data-id="${noteIt.id}"]');
    if (!tr) return 'no-row';
    const td = [...tr.children].find(x => x.dataset.k === 'notes');
    if (!td) return 'no-td';
    openCellPop('subs', state.subs.find(x => x.id === ${noteIt.id}), 'notes', td);
    return 'ok';
  })()`);
  const notesChecked = await evl(
    `JSON.stringify([...document.querySelectorAll('.cellpop input[type=checkbox]:checked')].map(i => i.value))`) || '';
  check('备注格开出多选编辑器，「甲, 乙」拆成两个勾着的选项',
    openNotes === 'ok' && notesChecked.includes('甲') && notesChecked.includes('乙'), `${openNotes} ${notesChecked}`);
  await evl(`[...document.querySelectorAll('.cellpop input[type=checkbox]')].find(i => i.value === '乙')?.click()`);
  await sleep(1200);
  const noteAfter = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(x => x.id === noteIt.id);
  check('文本真列存回去的是字符串，原值没被清成 NULL',
    noteAfter?.notes === '甲', JSON.stringify(noteAfter?.notes));
  await evl(`(() => { delete views.subs.types.notes; saveViews(); })()`);


  /* 17.34 ⑥ */
  // ⑥ 多选浮层里「先取消勾选、再回车加新值」：拿开浮层那会儿的快照会把刚取消的又带回来
  await evl(`switchTab('vps')`);
  await sleep(300);
  const vpsRows = await (await fetch(APP + 'api/collections/vps/items')).json();
  const hostA = vpsRows.find(x => x.name === 'HostA') || vpsRows[0];
  await patch(`/api/items/${hostA.id}`, { extra: { ...(hostA.extra || {}), locations: ['东京', '大阪'] } });
  await evl(`loadAll()`);
  await sleep(1000);
  await evl(`(() => {
    const tr = document.querySelector('#vps-body tr[data-id="${hostA.id}"]');
    const td = tr && [...tr.children].find(x => x.dataset.k === 'locations');
    if (td) openCellPop('vps', state.vps.find(x => x.id === ${hostA.id}), 'locations', td);
  })()`);
  await sleep(350);
  await evl(`[...document.querySelectorAll('.cellpop input[type=checkbox]')].find(i => i.value === '大阪')?.click()`);
  await sleep(1100);
  await evl(`(() => {
    const inp = document.querySelector('.cellpop .opt-add input');
    if (!inp) return;
    inp.value = '京都';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(1600);
  const hostAfter = (await (await fetch(APP + 'api/collections/vps/items')).json()).find(x => x.id === hostA.id);
  check('回车加新值用的是此刻的勾选态，不是开浮层时的快照',
    JSON.stringify(hostAfter?.extra?.locations) === '["东京","京都"]', JSON.stringify(hostAfter?.extra?.locations));
  await evl(`loadAll()`);
  await sleep(700);


}
