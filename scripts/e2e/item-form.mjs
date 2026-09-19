// 详情表单：整行往返与幂等保存、自定义天数拦截、图标上传与清除、父条目下拉、开放词表的现场新增。
export default async function (t) {
  const { APP, sleep, patch, raw, items, fields, check, send, evl, shot } = t;
  /* 12d. 订阅 logo：上传 → 名称格渲染（子行回退父 logo）→ 整行 PUT 保留 → 清除 */
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const subsNow = await (await fetch(APP + 'api/collections/subs/items')).json();
  const mj2 = subsNow.find(x => x.name === 'Midjourney');
  const upResp = await fetch(`${APP}api/items/${mj2.id}/logo?ext=png`, { method: 'POST', body: PNG1 });
  check('logo 上传成功', upResp.ok && (await upResp.json()).logo?.endsWith('.png'));
  const logoName = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(x => x.id === mj2.id).logo;
  const logoGet = await fetch(`${APP}logos/${logoName}`);
  check('logo 静态服务与类型', logoGet.ok && logoGet.headers.get('content-type') === 'image/png');
  await evl(`loadAll()`);
  await sleep(600);
  check('名称格渲染 logo', await evl(`(() => {
    const tr = [...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('Midjourney') && !r.classList.contains('subrow'));
    return !!tr?.querySelector('img.slogo');
  })()`) === true);
  check('子行回退父 logo', await evl(`(() => {
    const tr = [...document.querySelectorAll('#subs-body tr.subrow')].find(r => r.textContent.includes('Basic'));
    return !!tr?.querySelector('img.slogo');
  })()`) === true);
  await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('Midjourney') && !r.classList.contains('subrow')).querySelector('td[data-k="notes"]').click()`);
  await sleep(250);
  await evl(`(() => { const i = document.querySelector('.cellpop input[data-f="notes"]'); i.value = '比价'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(700);
  check('内联编辑后 logo 保留', (await (await fetch(APP + 'api/collections/subs/items')).json()).find(x => x.id === mj2.id).logo === logoName);
  const fakeSvg = await fetch(`${APP}api/items/${mj2.id}/logo?ext=svg`, { method: 'POST', body: PNG1 });
  check('魔数不符的上传被拒', !fakeSvg.ok && ((await fakeSvg.json()).error || '').includes('不符'));
  const delResp = await fetch(`${APP}api/items/${mj2.id}/logo`, { method: 'DELETE' });
  check('logo 清除', delResp.ok && (await (await fetch(APP + 'api/collections/subs/items')).json()).find(x => x.id === mj2.id).logo == null);
  await evl(`loadAll()`);
  await sleep(500);


  /* 12e. 整行 PUT：点格即编与 ⤢ 详情表单都走这条路，每个库都得能存回去。
     后端是全量替换语义，所以这里同时盯住"没在改的字段有没有被置空"。 */
  for (const [key, mark] of [['subs', 'notes'], ['sims', 'notes'], ['vps', 'notes']]) {
    const items = () => fetch(`${APP}api/collections/${key}/items`).then(r => r.json());
    const before = (await items())[0];
    const res = await patch(`/api/items/${before.id}`, { ...before, [mark]: 'e2e 往返' });
    check(`${key} 整行 PUT`, res.ok, res.ok ? '' : JSON.stringify(await res.json().catch(() => ({}))));
    const after = (await items()).find(x => x.id === before.id);
    check(`${key} PUT 后字段落库`, after?.[mark] === 'e2e 往返');
    check(`${key} PUT 未丢状态与周期`, after?.status === before.status && after?.cycle === before.cycle);
    check(`${key} PUT 未丢 extra 域字段`,
      JSON.stringify(after?.extra || {}) === JSON.stringify(before.extra || {}),
      `前 ${JSON.stringify(before.extra)} 后 ${JSON.stringify(after?.extra)}`);
    check(`${key} 还原`, (await patch(`/api/items/${before.id}`, before)).ok); // 不给后续断言留脏数据
  }


  /* 12e-2. 详情表单「打开 → 什么都不改 → 保存」必须幂等，整行深比对（逐字段追加断言
     兜不住这一族）。周期在这条路上被写坏过：表单初值拿了显示文案，存储键就丢了。 */
  const stripVolatile = o => {
    const { updated_at, ...rest } = o || {};
    return JSON.stringify(rest);
  };
  await evl(`loadAll()`); // 12e 用接口改过数据，表单读的是 state，先对齐再比对
  await sleep(700);
  for (const key of ['subs', 'sims', 'vps']) {
    const items = () => fetch(`${APP}api/collections/${key}/items`).then(r => r.json());
    const rows = await items();
    const before = rows.find(r => r.cycle) || rows[0]; // 优先挑有周期的行，那正是出事的字段
    await evl(`switchTab('${key}')`);
    await sleep(200);
    await evl(`openItemDialog('${key}', state['${key}'].find(r => r.id === ${before.id}))`);
    await sleep(400);
    if (key === 'subs') {
      check('周期下拉存的是档位键、显示的才是文案', await evl(`(() => {
        const el = document.querySelector('#item-fields [data-f="cycle"]');
        return el ? el.value + '|' + (el.options[el.selectedIndex]?.textContent ?? '') : '(缺)';
      })()`) === `${before.cycle}|${{ weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Semiannual', annual: 'Annual', biennial: 'Biennial', triennial: 'Triennial', lifetime: 'Lifetime', days: 'Custom' }[before.cycle]}`);
    }
    await evl(`document.querySelector('#form-item').requestSubmit()`);
    await sleep(900);
    const after = (await items()).find(r => r.id === before.id);
    check(`${key} 详情表单原样保存不动任何字段`, stripVolatile(before) === stripVolatile(after),
      `\n    前 ${stripVolatile(before)}\n    后 ${stripVolatile(after)}`);
  }
  // 自定义天数没填天数：表单该拦下（就地编辑器早就拦了，表单一直没拦）。
  // 挑 subs——SIM 的周期恒为自定义天数，当初就没把 cycle 注册成字段，表单里没有这个控件
  const daysRow = (await fetch(`${APP}api/collections/subs/items`).then(r => r.json())).find(r => r.cycle);
  await evl(`switchTab('subs')`);
  await sleep(200);
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${daysRow.id}))`);
  await sleep(400);
  await evl(`(() => {
    document.querySelector('#item-fields [data-f="cycle"]').value = 'days';
    document.querySelector('#item-fields [data-f="cycle_days"]').value = '';
  })()`);
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(700);
  check('表单拦下「自定义周期不填天数」', await evl(`!!document.querySelector('#dlg-item')?.open`) === true);
  check('拦下时给的是错误提示', await evl(
    `(() => { const t = document.querySelector('#toast'); return !t.hidden && t.classList.contains('err') && t.textContent; })()`
  ) === '自定义周期要填天数');
  check('拦下时没有落库', (await fetch(`${APP}api/collections/subs/items`).then(r => r.json()))
    .find(r => r.id === daysRow.id)?.cycle === daysRow.cycle);
  await evl(`document.querySelector('#dlg-item').close()`);
  // 这条错误提示是本段期望的产物（err 态挂 4.2 秒），收掉它，别飘到下一段的「无错误提示」断言里
  await evl(`(() => { const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true; t.classList.remove('err'); })()`);
  await sleep(150);


  const subsRows = await items('subs');
  /* 12k. 条目图标：上传/清除的界面在 B2 泛化删手写表单时丢过一次（端点还在、前端零调用）。
     关键陷阱：上传后若不同步表单持有的行数据，紧接着按「保存」会把刚传的图标清掉。 */
  const PNG1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const logoTarget = subsRows.find(r => r.name === 'Netflix') || subsRows[0];
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${logoTarget.id}))`);
  await sleep(500);
  check('详情表单里有图标控件', await evl(
    `!!document.querySelector('#item-fields input[data-logo]')`) === true);
  check('未设置时不显示清除按钮', await evl(
    `document.querySelector('#item-fields [data-logo-clear]').hidden`) === true);
  await evl(`(() => {
    const bytes = Uint8Array.from(atob('${PNG1X1}'), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'probe.png', { type: 'image/png' }));
    const inp = document.querySelector('#item-fields input[data-logo]');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(900);
  const afterUp = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(r => r.id === logoTarget.id);
  check('上传后落库', /^item-\d+-\d+\.png$/.test(afterUp.logo || ''), JSON.stringify(afterUp.logo));
  check('表单里出现预览与清除按钮', await evl(
    `!!document.querySelector('#item-fields .logo-prev img')
     && !document.querySelector('#item-fields [data-logo-clear]').hidden`) === true);
  check('上传的图标能取回', (await fetch(`${APP}logos/${afterUp.logo}`)).ok);
  // 上传后立刻保存整行：图标不能被这次 PUT 清掉
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1100);
  const afterSave = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(r => r.id === logoTarget.id);
  check('保存表单不会清掉刚传的图标', afterSave.logo === afterUp.logo, JSON.stringify(afterSave.logo));
  check('名称格渲染出小图标', await evl(
    `!!document.querySelector('#subs-body tr[data-id="${logoTarget.id}"] img.slogo')`) === true);
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${logoTarget.id}))`);
  await sleep(500);
  await evl(`document.querySelector('#item-fields [data-logo-clear]').click()`);
  await sleep(800);
  const afterClear = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(r => r.id === logoTarget.id);
  check('清除后落库为空', !afterClear.logo, JSON.stringify(afterClear.logo));
  await evl(`document.querySelector('#dlg-item').close()`);
  await sleep(200);

  // 名称列必须留在表格上：撤了表头就少一列而行还多一格，整表错位
  const nameF = (await (await fetch(`${APP}api/fields`)).json()).find(f => f.tbl === 'subs' && f.key === 'name');
  check('名称列不能撤下表格（API 也拦）',
    !(await raw(`/api/fields/${nameF.id}`, 'PUT', { name: nameF.name, shown: false })).ok);
  await evl(`loadAll()`);
  await sleep(900);
  check('名称列仍在表头', await evl(`!!document.querySelector('#view-subs th[data-k="name"]')`) === true);
  check('表头列数与行内格数一致', await evl(`(() => {
    const ths = document.querySelectorAll('#view-subs thead th').length;
    const tds = document.querySelector('#subs-body tr')?.children.length ?? -1;
    return ths === tds;
  })()`) === true);

  /* 17.7. 子行归属此前只能靠接口改：详情表单里根本没有「父条目」这一项，
     界面上既建不出「服务 → 套餐档位」的比价结构，也解不开已有的。 */
  const parentRows = await (await fetch(APP + 'api/collections/subs/items')).json();
  const mjRow = parentRows.find(r => r.name === 'Midjourney');
  const orphan = parentRows.find(r => r.name === '旧订阅');
  await evl(`switchTab('subs')`);
  await evl(`(() => { views.subs.collapsed = []; saveViews(); renderColl('subs'); })()`); // 上一段折叠过父行
  await sleep(350);
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${orphan.id}))`);
  await sleep(450);
  check('详情表单里有父条目下拉', await evl(`!!document.querySelector('#item-fields [data-parent]')`) === true);
  check('候选是同库顶层行、不含自己也不含子行', await evl(`(() => {
    const sel = document.querySelector('#item-fields [data-parent]');
    if (!sel) return '(没有父条目下拉)';
    const vs = [...sel.options].map(o => o.textContent.trim());
    return vs.includes('（顶层）') && vs.includes('Midjourney') && !vs.includes('旧订阅') && !vs.includes('Basic Plan');
  })()`) === true);
  await evl(`(() => { const s = document.querySelector('#item-fields [data-parent]'); if (s) s.value = '${mjRow.id}'; })()`);
  await sleep(200);
  await shot('13-parent-picker');
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1200);
  check('选中父条目后落库成子行', (await (await fetch(APP + 'api/collections/subs/items')).json())
    .find(r => r.id === orphan.id)?.parent_id === mjRow.id);
  check('表格里也缩进成子行', await evl(
    `!!document.querySelector('#subs-body tr[data-id="${orphan.id}"]')?.classList.contains('subrow')`) === true);
  // 已经有子行的条目不能再挂到别人下面（两层上限，后端 check_parent 同样会拒）
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${mjRow.id}))`);
  await sleep(450);
  check('已有子行的条目禁用父条目下拉', await evl(
    `document.querySelector('#item-fields [data-parent]')?.disabled ?? '(没有父条目下拉)'`) === true);
  await evl(`document.querySelector('#dlg-item').close()`);
  await sleep(250);
  // 选回「（顶层）」＝脱离父行
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${orphan.id}))`);
  await sleep(450);
  await evl(`(() => { const s = document.querySelector('#item-fields [data-parent]'); if (s) s.value = ''; })()`);
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1200);
  check('选回顶层就脱离父行', (await (await fetch(APP + 'api/collections/subs/items')).json())
    .find(r => r.id === orphan.id)?.parent_id == null);


  /* 17.10. 详情表单的开放词表建库时是空的，sel 要配「新选项，回车加入」——否则空库首装
     这几栏填不出东西。周期是固定档位词表不给现场新增（放开会把文案写回 items.cycle）。 */
  await evl(`openItemDialog('subs', null)`);
  await sleep(450);
  check('开放词表的下拉旁有「新选项」输入', await evl(
    `!!document.querySelector('#item-fields .sopts select[data-f="category"]')
     && !!document.querySelector('#item-fields .sopts .sopt-add')`) === true);
  check('支付方式同样有', await evl(
    `!!document.querySelector('#item-fields .sopts select[data-f="payment_method"] ~ .sopt-add')`) === true);
  check('周期是固定档位，不给现场新增', await evl(`(() => {
    const sel = document.querySelector('#item-fields select[data-f="cycle"]');
    return !!sel && !sel.closest('.sopts');
  })()`) === true);
  // 撤回修复做负向对照时这里会是 undefined：得让整份套件继续跑完，别崩在半路
  const soptAdd = `[...document.querySelectorAll('#item-fields .sopts')].find(x => x.querySelector('select[data-f="payment_method"]'))?.querySelector('.sopt-add')`;
  await evl(`${soptAdd}?.focus()`);
  await send('Input.insertText', { text: '云闪付' });
  // keyDown 带 text 才会产生「字符键」的默认行为（表单隐式提交），否则 preventDefault 测不出来
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(350);
  check('回车把新值加进下拉并选中', await evl(
    `document.querySelector('#item-fields select[data-f="payment_method"]').value`) === '云闪付');
  check('回车没有顺手提交表单', await evl(`!!document.querySelector('#dlg-item')?.open`) === true);
  await evl(`document.querySelector('#item-fields [data-f="name"]').value = '首装新条目'`);
  await shot('20-form-sel-add');
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1200);
  const freshItem = (await (await fetch(APP + 'api/collections/subs/items')).json())
    .find(r => r.name === '首装新条目');
  check('现场加的支付方式一路存回了库',
    freshItem?.extra?.payment_method === '云闪付', JSON.stringify(freshItem?.extra));


}
