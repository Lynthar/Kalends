// 库：自建库、建库模板、库设置（库序、字段序与上表、状态语义）、哪些列删得掉、移列与调宽、续费起算、换到期模型、删光也不崩（放最后）。
export default async function (t) {
  const { APP, sleep, post, put, patch, raw, mk, items, fields, check, today, day, send, evl, shot, consoleMsgs, menuClick, thWidthSum, tableW, evlSafe } = t;
  /* 12g. 自建库：新建 → 默认字段集 → 表头/行由字段生成 → 语义驱动的续费按钮 → 删库 */
  const nc = await post('/api/collections', { name: '域名', icon: '🌐', due_anchor: 'next' });
  check('新建库返回库键', /^k\d+$/.test(nc.key || ''), JSON.stringify(nc));
  const NK = nc.key;
  const ncf = (await (await fetch(`${APP}api/fields`)).json()).filter(f => f.tbl === NK);
  check('新库播了默认字段集', ncf.length >= 8 && ncf.some(f => f.key === 'status'), ncf.map(f => f.key));
  check('新库到期字段随模型给 next_renewal',
    ncf.some(f => f.key === 'next_renewal') && !ncf.some(f => f.key === 'last_renewed'));
  await post(`/api/collections/${NK}/items`, {
    name: 'lynthar.com', status: 'Active', price: 12.5, currency: 'USD',
    cycle: 'annual', next_renewal: day(9), extra: {},
  });
  await post(`/api/collections/${NK}/items`, {
    name: 'kalends.dev', status: 'Planned', price: 9, currency: 'USD',
    cycle: 'annual', next_renewal: day(180), extra: {},
  });
  await post('/api/fields', { tbl: NK, name: '注册商', ftype: 'sel' });
  await evl(`loadAll()`);
  await sleep(900);
  check('自建库出现在标签行',
    await evl(`!!document.querySelector('.tab[data-tab="${NK}"]')`) === true);
  await evl(`switchTab('${NK}')`);
  await sleep(400);
  const nheads = await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${NK}"] thead th')].map(t => t.dataset.k)`);
  check('表头由字段注册表生成（自定义列在操作列前）',
    nheads.slice(0, 6).join() === 'name,status,price,cycle,next_renewal,notes'
    && nheads.at(-1) === 'ops' && nheads.some(k => /^c\d+$/.test(k)), nheads);
  check('两行条目渲染', await evl(`document.querySelectorAll('#${NK}-body tr').length`) === 2);
  check('Active 行有续费按钮、Planned 行没有（状态语义驱动）', await evl(`(() => {
    const rows = [...document.querySelectorAll('#${NK}-body tr')];
    const a = rows.find(r => r.textContent.includes('lynthar'));
    const p = rows.find(r => r.textContent.includes('kalends.dev'));
    return !!a.querySelector('[data-renew]') && !p.querySelector('[data-renew]');
  })()`) === true);
  check('自建库条目进了合并到期时间线',
    (await (await fetch(APP + 'api/overview')).json()).upcoming.some(u => u.kind === NK));
  await evl(`document.querySelector('#${NK}-body tr [data-open]').click()`);
  await sleep(350);
  check('详情表单按字段集生成且排除算出来的列', await evl(`(() => {
    const ks = [...document.querySelectorAll('#item-fields [data-f]')].map(e => e.dataset.f);
    return ks.includes('name') && ks.includes('status') && !ks.includes('left');
  })()`) === true);
  await evl(`document.querySelector('#dlg-item').close()`);
  await sleep(150);


  /* 12g-2. 自建库也能点格即编（曾经点击委托写死成四个 tbody 选择器，自建库的格子点了没反应） */
  await evl(`document.querySelector('#${NK}-body td[data-k="name"]').click()`);
  await sleep(350);
  check('自建库点格开就地编辑浮层', await evl(`!!document.querySelector('.cellpop')`) === true);
  // 取不到就跳过（浮层没开时不抛异常，好让负向对照跑完整套）
  await evl(`(() => { const i = document.querySelector('.cellpop input[data-f="name"]'); if (!i) return; i.value = 'renamed.com'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(800);
  check('自建库点格即编落库',
    (await (await fetch(`${APP}api/collections/${NK}/items`)).json()).some(x => x.name === 'renamed.com'));


  /* 12g-3. 多选值里含分隔符（, ， 、 /）：勾选它自己要能筛出自己那行，存回去也不能被拆开 */
  const mf = await post('/api/fields', { tbl: NK, name: '线路', ftype: 'multi' });
  await put('/api/fields/options', { tbl: NK, key: mf.key, options: [{ v: 'CN2 GIA/9929' }, { v: '普通' }] });
  const nrows = await (await fetch(`${APP}api/collections/${NK}/items`)).json();
  const slashRow = nrows.find(r => r.name === 'renamed.com') || nrows.find(r => r.name === 'lynthar.com');
  const SLASH_NAME = slashRow.name;
  await patch(`/api/items/${slashRow.id}`, {
    ...slashRow, extra: { ...(slashRow.extra || {}), [mf.key]: ['CN2 GIA/9929'] },
  });
  // star 类型 2026-08-15 撤掉了：建列时后端要拒，且撤掉之后表格不能因为"认不出的类型"而崩
  check('star 已不是可建的列类型', (await raw('/api/fields', 'POST', { tbl: NK, name: '星级', ftype: 'star' })).status === 400);
  await evl(`loadAll()`);
  await sleep(900);
  await evl(`switchTab('${NK}')`);
  await sleep(400);
  check('含 / 的多选值渲染成一枚完整标签', await evl(
    `[...document.querySelectorAll('#${NK}-body td[data-k="${mf.key}"] .tag')].map(t => t.textContent).join('|')`) === 'CN2 GIA/9929');
  check('筛选浮层不列出被拆碎的片段', await evl(`(() => {
    openFilterPop('${NK}', '${mf.key}', document.querySelector('.tablewrap[data-tab="${NK}"] th[data-k="${mf.key}"]'));
    const vs = [...document.querySelectorAll('.filterpop .fp-v')].map(x => x.textContent);
    closePop();
    return vs.join('|');
  })()`) === 'CN2 GIA/9929|普通|（空）');
  check('勾选含 / 的值能筛出自己那行', await evl(`(async () => {
    setFilter('${NK}', '${mf.key}', ['CN2 GIA/9929']);
    await new Promise(r => setTimeout(r, 400));
    const names = [...document.querySelectorAll('#${NK}-body td[data-k="name"]')].map(t => t.textContent);
    setFilter('${NK}', '${mf.key}', null);
    return names.some(n => n.includes('${SLASH_NAME}'));
  })()`) === true);


  /* 12g-4. 详情表单用真控件：多选是勾选清单；开表单直接保存不得改坏任何值 */
  await evl(`openItemDialog('${NK}', state['${NK}'].find(r => r.name === '${SLASH_NAME}'))`);
  await sleep(500);
  check('多选字段是勾选清单而非文本框', await evl(
    `!!document.querySelector('#item-fields [data-mbox="${mf.key}"] input[type=checkbox]')
     && !document.querySelector('#item-fields input[data-f="${mf.key}"]')`) === true);
  check('勾选清单带出当前值', await evl(
    `[...document.querySelectorAll('#item-fields [data-mbox="${mf.key}"] input:checked')].map(i => i.value).join('|')`) === 'CN2 GIA/9929');
  await shot('15-item-form');
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1000);
  const saved = (await (await fetch(`${APP}api/collections/${NK}/items`)).json()).find(r => r.name === SLASH_NAME);
  check('原样保存不拆坏含 / 的多选值', JSON.stringify(saved.extra?.[mf.key]) === '["CN2 GIA/9929"]', JSON.stringify(saved.extra?.[mf.key]));
  await evl(`openItemDialog('${NK}', state['${NK}'].find(r => r.name === '${SLASH_NAME}'))`);
  await sleep(450);
  // 勾选框封顶三行内部滚动（长词表不能把费用/到期挤出首屏），「新选项」输入框在滚动框外
  check('勾选框可内部滚动、新选项框在框外', await evl(`(() => {
    const checks = document.querySelector('#item-fields [data-mbox="${mf.key}"]');
    const add = document.querySelector('#item-fields .mopt-add');
    return getComputedStyle(checks).overflowY === 'auto' && !checks.contains(add);
  })()`) === true);
  // 回车加新选项：用真实按键，合成 KeyboardEvent 不触发浏览器默认的提交行为，测不出 preventDefault
  await evl(`document.querySelector('#item-fields .mopt-add').focus()`);
  await send('Input.insertText', { text: '临时线路' });
  // keyDown 必须带 text，否则浏览器不产生「字符键」的默认行为（表单隐式提交），
  // 这条断言就永远为真——摘掉 preventDefault 实测验证过
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(350);
  check('回车把新值加成已勾选的选项', await evl(
    `[...document.querySelectorAll('#item-fields [data-mbox="${mf.key}"] input:checked')].map(i => i.value).join('|')`) === 'CN2 GIA/9929|临时线路');
  check('回车没有顺手提交表单', await evl(`!!document.querySelector('#dlg-item')?.open`) === true);
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await sleep(1000);
  const reopened = (await (await fetch(`${APP}api/collections/${NK}/items`)).json()).find(r => r.name === SLASH_NAME);
  check('回车加的新选项一并落库', JSON.stringify(reopened.extra?.[mf.key]) === '["CN2 GIA/9929","临时线路"]', JSON.stringify(reopened.extra?.[mf.key]));

  check('删库', (await fetch(`${APP}api/collections/${nc.id}`, { method: 'DELETE' })).ok);
  await evl(`loadAll()`);
  await sleep(800);
  check('删库后标签与容器都撤掉', await evl(`!document.querySelector('.tab[data-tab="${NK}"]') && !document.querySelector('.tablewrap[data-tab="${NK}"]')`) === true);
  check('删库后字段注册表也清了',
    (await (await fetch(`${APP}api/fields`)).json()).every(f => f.tbl !== NK));
  await evl(`switchTab('subs')`);
  await sleep(300);


  /* 12h. 建库模板：预置一套字段集与库属性，免得新建的库是个空壳 */
  const tpls = await (await fetch(APP + 'api/collections/templates')).json();
  check('模板清单可取且首项是空白', Array.isArray(tpls) && tpls[0]?.id === 'blank', JSON.stringify(tpls));
  check('模板含域名 / 保险 / 证件', ['domain', 'insurance', 'docs'].every(id => tpls.some(t => t.id === id)));
  check('未知模板报错而不是静默当空白', !(await fetch(APP + 'api/collections', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', template: '没这个模板' }),
  })).ok);

  const dc = await post('/api/collections', { name: '我的证件', template: 'docs' });
  const DK = dc.key;
  check('模板带来库属性（到期模型 / 图标 / 动作说法）',
    dc.due_anchor === 'next' && dc.icon === '🪪' && dc.verb === '换证', JSON.stringify(dc));
  const ic = await post('/api/collections', { name: '我的保单', template: 'insurance' });
  check('模板带来名称格小字字段', ic.subline === 'policy_no' && ic.verb === '续保', JSON.stringify(ic));

  const allF = await (await fetch(APP + 'api/fields')).json();
  const dcf = allF.filter(f => f.tbl === DK);
  const fby = k => dcf.find(f => f.key === k);
  check('证件模板播了域字段', ['doc_type', 'holder', 'doc_no', 'issuer'].every(k => fby(k)), dcf.map(f => f.key));
  check('域字段挂 extra、与手加的自定义列同权（可改名可改选项可删）',
    fby('doc_type').src === 'extra' && fby('doc_type').builtin === false);
  check('封闭词表预置了选项', fby('doc_type').options.map(o => o.v).includes('护照'));
  check('开放词表不预置选项，让它从数据里长出来',
    allF.filter(f => f.tbl === ic.key).find(f => f.key === 'insurer').options.length === 0);
  check('模板可改通用字段的显示名与是否上表',
    fby('next_renewal').name === '有效期至' && fby('next_renewal').shown === true
    && fby('price').name === '工本费' && fby('price').shown === false && fby('cycle').shown === false);
  check('模板域字段可管理选项（后端 resolve 认它）',
    (await put('/api/fields/options', { tbl: DK, key: 'doc_type', options: [{ v: '护照', c: 3 }, { v: '签证' }] })).ok);
  check('模板域字段可删（src=extra）', (await fetch(`${APP}api/fields/${fby('issuer').id}`, { method: 'DELETE' })).ok);

  await post(`/api/collections/${DK}/items`, {
    name: '护照', status: 'Active', next_renewal: day(200), extra: { doc_type: '护照', holder: '本人' },
  });
  await evl(`loadAll()`);
  await sleep(900);
  await evl(`switchTab('${DK}')`);
  await sleep(400);
  const dheads = await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${DK}"] thead th')].map(t => t.dataset.k)`);
  check('模板域字段排在状态与费用之间，隐藏的通用列不上表',
    dheads.join() === 'name,status,doc_type,holder,next_renewal,notes,ops', dheads);
  check('模板列的值渲染出来',
    await evl(`document.querySelector('#${DK}-body tr td[data-k="doc_type"]').textContent.includes('护照')`) === true);
  check('模板域字段在表头菜单里可编辑选项', await evl(`optionsEditable('${DK}','doc_type')`) === true);
  // 没有周期就推不动到期日：只记一笔账，提示不能谎报"周期已推进"
  await evl(`window.confirm = () => true`);
  await evl(`document.querySelector('#${DK}-body tr [data-renew]').click()`);
  await sleep(900);
  const rmsg = await evl(`document.querySelector('#toast').textContent`);
  check('无周期条目续费只记账、提示不谎报推进', rmsg.includes('手动改'), rmsg);

  await evl(`document.querySelector('#coll-add').click()`);
  await sleep(600);
  check('新建库浮层出现模板选择器', await evl(
    `!document.querySelector('#coll-tpl-row').hidden && document.querySelectorAll('#coll-tpl .chip').length === ${tpls.length}`) === true);
  check('默认选中空白模板', await evl(`document.querySelector('#coll-tpl .chip.on').textContent.trim()`) === '空白');
  await shot('23-coll-templates');
  await evl(`[...document.querySelectorAll('#coll-tpl .chip')].find(b => b.textContent.includes('域名')).click()`);
  await sleep(250);
  check('挑模板预填库名 / 图标 / 到期模型 / 动作说法', await evl(`(() => {
    const d = document.querySelector('#dlg-coll');
    const g = k => d.querySelector('[data-c="' + k + '"]').value;
    return g('name') === '域名' && g('icon') === '🌐' && g('due_anchor') === 'next' && g('verb') === '续费';
  })()`) === true);
  check('说明里列出模板预置的字段', await evl(`document.querySelector('#coll-tpl-desc').textContent.includes('注册商')`) === true);
  await evl(`document.querySelector('#dlg-coll').close()`);
  await sleep(150);
  await evl(`openCollDialog(collOf('${DK}'))`);
  await sleep(500);
  check('改已有库时不显示模板选择器', await evl(`document.querySelector('#coll-tpl-row').hidden`) === true);
  await evl(`document.querySelector('#dlg-coll').close()`);
  await sleep(150);
  check('删掉模板建的两个库',
    (await fetch(`${APP}api/collections/${dc.id}`, { method: 'DELETE' })).ok
    && (await fetch(`${APP}api/collections/${ic.id}`, { method: 'DELETE' })).ok);
  await evl(`loadAll()`);
  await sleep(800);
  await evl(`switchTab('subs')`);
  await sleep(300);


  /* 12h2. 订阅 / SIM / VPS 也是模板：此前它们只由迁移 0007/0008 一次性建出来，
     删掉就再也建不回来，也建不了第二个同类库。字段集与预置库的等价性由单测钉住
     （collections::tests），这里管的是界面与接口这一侧。 */
  check('模板清单含三个续费库', ['subs', 'sims', 'vps'].every(id => tpls.some(t => t.id === id)),
    tpls.map(t => t.id));

  const sc = await post('/api/collections', { name: '第二份订阅', template: 'subs' });
  const SK = sc.key;
  check('订阅模板：到期模型与图标', sc.due_anchor === 'next' && sc.icon === '🔁', JSON.stringify(sc));
  check('订阅模板不写死动作说法（NULL 时前后端都回落成「续费」）', !sc.verb, JSON.stringify(sc));
  const scf = (await (await fetch(`${APP}api/fields`)).json()).filter(f => f.tbl === SK);
  const sfby = k => scf.find(f => f.key === k);
  check('订阅模板播了域字段', ['category', 'payment_method', 'account'].every(k => sfby(k)),
    scf.map(f => f.key));
  check('订阅模板的域字段与自定义列同权', sfby('category').src === 'extra' && sfby('category').builtin === false);
  check('续费库用六值状态词表（比通用词表多 Deferred / Unused）',
    sfby('status').options.map(o => o.v).join() === 'Active,Planned,Deferred,Unused,Ending,Ended',
    sfby('status').options.map(o => o.v));
  check('开放词表不预置选项', sfby('category').options.length === 0);

  const vc = await post('/api/collections', { name: '第二批机器', template: 'vps' });
  const VK = vc.key;
  check('VPS 模板：产品名进日历标题、也做名称格小字',
    vc.subtitle === 'product' && vc.subline === 'product', JSON.stringify(vc));
  const vcf = (await (await fetch(`${APP}api/fields`)).json()).filter(f => f.tbl === VK);
  const vfby = k => vcf.find(f => f.key === k);
  check('VPS 模板带得动 tpl 合成列（src=calc + config）',
    vfby('spec').ftype === 'tpl' && vfby('spec').src === 'calc'
    && vfby('spec').config?.tpl?.includes('{cores}'), JSON.stringify(vfby('spec')));
  check('VPS 模板把商家做成名称列', vfby('name').name === '商家');

  await post(`/api/collections/${VK}/items`, {
    name: '某商家', status: 'Active', cycle: 'annual', last_renewed: day(-30),
    extra: { product: '小鸡', cores: 2, ram_gb: 4, storage_gb: 40, storage_type: 'NVMe' },
  });
  await evl(`loadAll()`);
  await sleep(900);
  await evl(`switchTab('${VK}')`);
  await sleep(400);
  check('模板建出来的合成列真的算得出来',
    (await evl(`document.querySelector('#${VK}-body tr td[data-k="spec"]').textContent`) || '')
      .replace(/\s+/g, ' ').includes('2C / 4G / 40G NVMe'),
    await evl(`document.querySelector('#${VK}-body tr td[data-k="spec"]').textContent`));

  // 迁移 0014：预置三库的域字段收归 builtin=0，两张硬编码白名单（前端 OPT_EDITABLE /
  // 后端 BUILTIN_OPT）随之删掉。这几条断言就是那两张表被删干净了还照样能编辑选项。
  check('预置库的域字段可编辑选项（后端不再靠白名单点名）',
    (await put('/api/fields/options', { tbl: 'subs', key: 'category', options: [{ v: 'AI', c: 2 }] })).ok);
  check('预置库的域字段在表头菜单里也可编辑', await evl(`optionsEditable('subs','category')`) === true);
  // storage_type 是 shown=0 的域字段：它 src='extra' 所以一直可改名可删除，却因为不在
  // 白名单里而不能编辑选项——收归 builtin=0 之后这处不一致没了。界面入口要先在字段面板
  // 把它放上表（optionsEditable 只对表格列有意义），所以这里只测后端这一侧的能力。
  check('此前漏在白名单外的隐藏域字段现在也能管（vps.storage_type）',
    (await put('/api/fields/options', { tbl: 'vps', key: 'storage_type', options: [{ v: 'NVMe' }] })).ok);
  // codeOf 定义在后面，这里用 raw（它在文件开头就定义好了）
  check('通用真列仍然不开放选项编辑（周期是语义词表）',
    (await raw('/api/fields/options', 'PUT', { tbl: 'subs', key: 'cycle', options: [{ v: '乱来' }] })).status === 400);

  check('删掉这两个模板库',
    (await fetch(`${APP}api/collections/${sc.id}`, { method: 'DELETE' })).ok
    && (await fetch(`${APP}api/collections/${vc.id}`, { method: 'DELETE' })).ok);
  await evl(`loadAll()`);
  await sleep(800);
  await evl(`switchTab('subs')`);
  await sleep(300);


  /* 12i. 库设置的收尾：库顺序 / 字段顺序与上表 / 状态语义标记 */
  const bc = await post('/api/collections', { name: '收尾测试', template: 'domain' });
  const BK = bc.key;
  await post(`/api/collections/${BK}/items`, {
    name: 'a.com', status: 'Active', cycle: 'annual', next_renewal: day(20), extra: {},
  });
  await evl(`loadAll()`);
  await sleep(900);
  const tabs0 = await evl(`[...document.querySelectorAll('.tab[data-tab]')].map(t => t.dataset.tab)`);
  check('新库排在标签行末尾', tabs0.join() === `subs,sims,vps,${BK}`, tabs0);
  check('标签可拖动', await evl(`document.querySelector('.tab[data-tab="${BK}"]').draggable`) === true);
  await evl(`(() => {
    const src = document.querySelector('.tab[data-tab="${BK}"]');
    const dst = document.querySelector('.tab[data-tab="subs"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r.left + 2 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  })()`);
  await sleep(1300);
  check('拖标签改库序并落库',
    (await (await fetch(APP + 'api/collections')).json())[0].key === BK);
  const tabs1 = await evl(`[...document.querySelectorAll('.tab[data-tab]')].map(t => t.dataset.tab)`);
  check('标签行跟着重排', tabs1.join() === `${BK},subs,sims,vps`, tabs1);

  // 预置库的标签写在 index.html 里，事件绑定曾经漏掉它们——库设置一度打不开
  await evl(`switchTab('subs')`);
  await sleep(300);
  await evl(`document.querySelector('#coll-settings').click()`);
  await sleep(500);
  check('⚙ 能打开预置库的设置并带出字段面板', await evl(`
    document.querySelector('#dlg-coll').open
    && document.querySelector('#dlg-coll-title').textContent.includes('订阅')
    && !document.querySelector('#coll-fields-box').hidden`) === true);
  // 名称列不给撤下表格：撤了表头就少一列而行还多一格，整表错位
  check('字段面板里名称的「上表」开关是禁用的', await evl(`(() => {
    const rows = [...document.querySelectorAll('#coll-fields .opt-row')];
    const nameRow = rows.find(r => r.textContent.includes('名称'));
    const others = rows.filter(r => r !== nameRow);
    return !!nameRow?.querySelector('input')?.disabled && others.every(r => !r.querySelector('input').disabled);
  })()`) === true);
  // 标签位置按钮：库顺序的单指针替代，与拖标签写同一个 /api/collections/order
  const collOrderNow = async () => (await (await fetch(APP + 'api/collections')).json()).map(c => c.key).join();
  const tOrder0 = await collOrderNow();
  await evl(`document.querySelector('#coll-mv-r').click()`);
  await sleep(900);
  check('「后移 ▶」把库往右挪一位并落库', await collOrderNow() === tOrder0.replace('subs,sims', 'sims,subs'), await collOrderNow());
  await evl(`document.querySelector('#coll-mv-l').click()`);
  await sleep(900);
  check('「◀ 前移」挪得回来', await collOrderNow() === tOrder0, await collOrderNow());
  await evl(`document.querySelector('#dlg-coll').close()`);
  await sleep(200);
  check('预置库的标签也可拖动', await evl(`document.querySelector('.tab[data-tab="subs"]').draggable`) === true);

  await evl(`switchTab('${BK}')`);
  await sleep(300);
  await evl(`openCollDialog(collOf('${BK}'))`);
  await sleep(600);
  check('库设置浮层出现字段面板',
    await evl(`!document.querySelector('#coll-fields-box').hidden
      && document.querySelectorAll('#coll-fields .opt-row').length === 12`) === true);
  const fb = await evl(`[...document.querySelectorAll('#coll-fields .opt-row .fp-v')].map(e => e.textContent)`);
  await evl(`(() => {
    const rows = [...document.querySelectorAll('#coll-fields .opt-row')];
    const src = rows[rows.length - 1], dst = rows[0];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: r.top + 1 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  })()`);
  await sleep(1200);
  const fa = await evl(`[...document.querySelectorAll('#coll-fields .opt-row .fp-v')].map(e => e.textContent)`);
  check('拖字段调序（面板重排）', fa[0] === fb.at(-1), `${fb.at(-1)} → ${fa[0]}`);
  const posSorted = (await (await fetch(`${APP}api/fields`)).json())
    .filter(f => f.tbl === BK).sort((a, b) => a.pos - b.pos);
  check('字段顺序落到 fields.pos', posSorted[0].name === fb.at(-1), posSorted.map(f => f.name));
  // 单指针替代：字段行的 ↑↓ 与拖动写同一个 /api/fields/order。只动自建库——
  // settleView 会因 schema 序变化作废本机列序，动 subs 会打掉第 11 段摆好的分类首列
  const bkOrder = async () => (await (await fetch(`${APP}api/fields`)).json())
    .filter(f => f.tbl === BK).sort((a, b) => a.pos - b.pos).map(f => f.name).join();
  const bo0 = await bkOrder();
  await evl(`[...document.querySelectorAll('#coll-fields .opt-row')][0].querySelector('[data-dn]').click()`);
  await sleep(800);
  check('字段行 ↓ 换了顺序并落库', (await bkOrder()).split(',')[1] === bo0.split(',')[0], `${bo0} → ${await bkOrder()}`);
  await evl(`[...document.querySelectorAll('#coll-fields .opt-row')][1].querySelector('[data-up]').click()`);
  await sleep(800);
  check('字段行 ↑ 挪得回来', await bkOrder() === bo0, await bkOrder());

  const bh0 = await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${BK}"] thead th')].map(t => t.dataset.k)`);
  await evl(`(() => {
    const row = [...document.querySelectorAll('#coll-fields .opt-row')].find(r => r.querySelector('.fp-v').textContent === '链接');
    const box = row.querySelector('input');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(1200);
  const bh1 = await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${BK}"] thead th')].map(t => t.dataset.k)`);
  check('打开「上表」把只在表单里的字段搬上表头',
    !bh0.includes('url') && bh1[0] === 'url', `${bh0} → ${bh1}`);
  check('上表状态落库',
    (await (await fetch(`${APP}api/fields`)).json()).find(f => f.tbl === BK && f.key === 'url').shown === true);
  await evl(`document.querySelector('#dlg-coll').close()`);
  await sleep(200);

  await evl(`switchTab('${BK}')`);
  await sleep(400);
  check('条目在到期时间线上',
    (await (await fetch(APP + 'api/overview')).json()).upcoming.some(u => u.kind === BK));
  await evl(`document.querySelector('.tablewrap[data-tab="${BK}"] th[data-k="status"]').click()`);
  await sleep(300);
  check('状态列菜单有「状态语义…」',
    await evl(`[...document.querySelectorAll('.thmenu .mi')].some(b => b.textContent.includes('状态语义'))`) === true);
  check('状态列仍不开放改值', await evl(`optionsEditable('${BK}','status')`) !== true);
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('状态语义')).click()`);
  await sleep(350);
  check('语义浮层列出状态值与三个标记', await evl(`
    document.querySelectorAll('.optpop .opt-row').length === 4
    && document.querySelectorAll('.optpop .opt-row input[data-f="timeline"]').length === 4`) === true);
  await evl(`(() => {
    const row = [...document.querySelectorAll('.optpop .opt-row')].find(r => r.textContent.includes('Active'));
    const box = row.querySelector('input[data-f="timeline"]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(1300);
  check('关掉 timeline 后条目退出到期时间线',
    !(await (await fetch(APP + 'api/overview')).json()).upcoming.some(u => u.kind === BK));
  const semF = (await (await fetch(`${APP}api/fields`)).json()).find(f => f.tbl === BK && f.key === 'status');
  check('语义标记落库', semF.options.find(o => o.v === 'Active').timeline === 0, JSON.stringify(semF.options));
  check('只动了改的那个状态，别的原样',
    semF.options.find(o => o.v === 'Ending').timeline === 1 && semF.options.length === 4);
  check('续费按钮跟着语义消失',
    await evl(`!document.querySelector('#${BK}-body tr [data-renew]')`) === true);

  // 状态词表只增不改删：加得进去，且新值默认没有任何语义
  await evl(`closePop()`);
  await evl(`document.querySelector('.tablewrap[data-tab="${BK}"] th[data-k="status"]').click()`);
  await sleep(300);
  check('状态列菜单有「新增状态值…」',
    await evl(`[...document.querySelectorAll('.thmenu .mi')].some(b => b.textContent.includes('新增状态值'))`) === true);
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('新增状态值')).click()`);
  await sleep(300);
  await evl(`(() => {
    const i = document.querySelector('.optpop input');
    i.value = '待寄回';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await sleep(1200);
  const stF = (await (await fetch(`${APP}api/fields`)).json()).find(f => f.tbl === BK && f.key === 'status');
  const added = stF.options.find(o => o.v === '待寄回');
  check('新状态值落到词表末尾', stF.options.at(-1).v === '待寄回', JSON.stringify(stF.options.map(o => o.v)));
  check('新状态值默认三个语义全关',
    added && added.spend === 0 && added.alert === 0 && added.timeline === 0, JSON.stringify(added));
  check('重复加同一个值被拒绝',
    !(await raw('/api/fields/add_status', 'POST', { tbl: BK, key: 'status', value: '待寄回' })).ok);
  check('非状态列不能走这条路',
    !(await raw('/api/fields/add_status', 'POST', { tbl: BK, key: 'notes', value: 'x' })).ok);
  await evl(`switchTab('${BK}')`);
  await sleep(400);
  await evl(`document.querySelector('#${BK}-body td[data-k="status"]').click()`);
  await sleep(350);
  check('状态格的选值列表里出现新值', await evl(
    `[...document.querySelectorAll('.cellpop .mi')].some(b => b.textContent.includes('待寄回'))`) === true);
  check('状态格仍不给现场新建（只挑不建）', await evl(
    `!document.querySelector('.cellpop .opt-add')`) === true);
  await evl(`closePop()`);


  /* 12i-2. 哪些列删得掉：判据是 src='extra' 不是 builtin——域字段与自定义列同权，
     引擎真列与算出来的列一项都不给。shown=0 的列没有表头，字段面板那颗 ✕ 是唯一出口。 */
  const delFs = await (await fetch(`${APP}api/fields`)).json();
  const thMenuOf = async (tab, k) => {
    await evl(`closePop()`);
    await evl(`switchTab('${tab}')`);
    await sleep(300);
    await evl(`document.querySelector('.tablewrap[data-tab="${tab}"] th[data-k="${k}"]').click()`);
    await sleep(250);
    const txt = await evl(`[...document.querySelectorAll('.thmenu .mi')].map(x => x.textContent).join('|')`);
    await evl(`closePop()`);
    await sleep(120);
    return txt;
  };
  // 预置库的域字段：builtin=1 但值在 extra 里，照样归用户管
  // 播下来的域字段（键不是 c<id>，那是用户手加的自定义列）。此前这里靠 builtin=1 认它们，
  // 迁移 0014 把预置三库的域字段一并收归 builtin=0 之后，判据要改问"键从哪来"。
  const seededExtra = delFs.find(f =>
    f.tbl === 'subs' && f.src === 'extra' && f.shown && !/^c\d+$/.test(f.key));
  check('预置库有播下来的 extra 域字段（本段前提）', !!seededExtra, JSON.stringify(seededExtra));
  check('它与手加的自定义列同权（迁移 0014 收归 builtin=0）', seededExtra.builtin === false,
    JSON.stringify(seededExtra));
  const mSeeded = await thMenuOf('subs', seededExtra.key);
  check(`预置域字段「${seededExtra.name}」菜单里有删除列`, mSeeded.includes('删除列'), mSeeded);
  check(`预置域字段「${seededExtra.name}」菜单里有重命名列`, mSeeded.includes('重命名列'), mSeeded);
  // 多出改名/删除两项后，最长的那份菜单曾撑破 max-height：末项「删除列」被切成半行藏进滚动条
  await evl(`switchTab('subs')`);
  await sleep(300);
  await evl(`document.querySelector('.tablewrap[data-tab="subs"] th[data-k="${seededExtra.key}"]').click()`);
  await sleep(250);
  const menuBox = await evl(`(() => {
    const m = document.querySelector('.thmenu');
    const r = m.getBoundingClientRect();
    return { cut: m.scrollHeight > m.clientHeight, bottom: Math.round(r.bottom), vh: innerHeight };
  })()`);
  check('最长的表头菜单整份放得下，不靠内部滚动', menuBox.cut === false, JSON.stringify(menuBox));
  check('菜单也没长出视口', menuBox.bottom <= menuBox.vh, JSON.stringify(menuBox));
  await evl(`closePop()`);
  await sleep(120);


  /* 12g2. 移列与调宽子菜单：列序/列宽的单指针替代（WCAG 2.5.7）。写入必须与拖动同一套：
     列序进 views.order、调宽走拖宽的基线与结算，右边框硬边界那套法则不因入口而异。 */
  const visCols = () => evl(`[...document.querySelectorAll('#view-subs th')]
    .filter(t => t.style.display !== 'none' && !t.classList.contains('ops')).map(t => t.dataset.k).join()`);
  const cBefore = await visCols();
  check('表头菜单有移列与调宽入口', await menuClick(`#view-subs th[data-k="status"]`, '移列与调宽'));
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('右移一列')).click()`);
  await sleep(400);
  const cAfter = await visCols();
  check('右移一列换了显示序', cAfter !== cBefore && cAfter.indexOf('status') > cBefore.indexOf('status'), `${cBefore} → ${cAfter}`);
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('左移一列')).click()`);
  await sleep(400);
  check('左移一列挪得回来', await visCols() === cBefore, await visCols());
  const wSnap = await evl(`JSON.stringify(views.subs.widths)`);
  const wOfStatus = () => evl(`Math.round(document.querySelector('#view-subs th[data-k="status"]').getBoundingClientRect().width)`);
  const wMenu0 = await wOfStatus();
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('加宽此列')).click()`);
  await sleep(400);
  check('菜单加宽 +60px', Math.abs(await wOfStatus() - wMenu0 - 60) <= 3, `${wMenu0} → ${await wOfStatus()}`);
  check('菜单加宽后表宽=列宽和', Math.abs(await tableW() - await thWidthSum()) <= 2, `table=${await tableW()} sum=${await thWidthSum()}`);
  await evl(`[...document.querySelectorAll('.thmenu .mi')].find(b => b.textContent.includes('变窄此列')).click()`);
  await sleep(400);
  check('菜单变窄挪得回来', Math.abs(await wOfStatus() - wMenu0) <= 3, `${await wOfStatus()}`);
  await evl(`closePop()`);
  await evl(`views.subs.widths = JSON.parse('${wSnap}'); saveViews(); applyWidths('subs')`);
  await sleep(200);

  // 负向：引擎真列与算出来的列不给这两项，删了没有意义（后端也只认 src='extra'）
  const mCol = await thMenuOf('subs', 'price');
  check('引擎真列（价格）没有删除列', !mCol.includes('删除列'), mCol);
  check('引擎真列（价格）没有重命名列', !mCol.includes('重命名列'), mCol);
  const vpsCalc = delFs.find(f => f.tbl === 'vps' && f.src === 'calc' && f.shown);
  const mCalc = await thMenuOf('vps', vpsCalc.key);
  check(`算出来的列（${vpsCalc.name}）没有删除列`, !mCalc.includes('删除列'), mCalc);
  check('后端同样拒绝删非 extra 列',
    (await fetch(`${APP}api/fields/${delFs.find(f => f.tbl === 'subs' && f.key === 'price').id}`,
      { method: 'DELETE' })).status === 404);

  // 字段面板：extra 行有 ✕，真列/算出来的行没有
  await evl(`closePop()`);
  await evl(`switchTab('${BK}')`);
  await sleep(300);
  await evl(`openCollDialog(collOf('${BK}'))`);
  await sleep(600);
  const panelDel = await evl(`(() => {
    const rows = [...document.querySelectorAll('#coll-fields .opt-row')];
    return rows.map(r => [r.querySelector('.fp-v').textContent, !!r.querySelector('[data-del]')]);
  })()`);
  const panelBy = Object.fromEntries(panelDel);
  const nameOfKey = k => delFs.find(f => f.tbl === BK && f.key === k)?.name;
  check('字段面板给 extra 列出了删除按钮',
    panelBy[nameOfKey('registrar')] === true && panelBy[nameOfKey('dns')] === true, JSON.stringify(panelDel));
  check('字段面板不给真列/算出来的列删除按钮',
    panelBy['名称'] === false && panelBy['费用'] === false && panelBy['备注'] === false, JSON.stringify(panelDel));
  await shot('16-field-panel-delete');

  // shown=0 的列：表头上没有它，只能从面板删——删完表头不该有任何变化
  const headBefore = await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${BK}"] thead th')].map(t => t.dataset.k).join()`);
  check('待删的 dns 本来就不在表头上', !headBefore.split(',').includes('dns'), headBefore);
  const rowsBefore = await evl(`document.querySelectorAll('#coll-fields .opt-row').length`);
  await evl(`[...document.querySelectorAll('#coll-fields .opt-row')]
    .find(r => r.querySelector('.fp-v').textContent === ${JSON.stringify(nameOfKey('dns'))})
    ?.querySelector('[data-del]')?.click()`);
  await sleep(1200);
  check('面板删掉不上表的列：注册表里已注销',
    !(await (await fetch(`${APP}api/fields`)).json()).some(f => f.tbl === BK && f.key === 'dns'));
  check('面板少一行',
    await evl(`document.querySelectorAll('#coll-fields .opt-row').length`) === rowsBefore - 1);
  check('表头不受影响（本来就没有这列）',
    await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${BK}"] thead th')].map(t => t.dataset.k).join()`) === headBefore);

  // 上表的 extra 列从面板删掉，表头要跟着收回去
  await evl(`[...document.querySelectorAll('#coll-fields .opt-row')]
    .find(r => r.querySelector('.fp-v').textContent === ${JSON.stringify(nameOfKey('registrar'))})
    ?.querySelector('[data-del]')?.click()`);
  await sleep(1200);
  check('面板删掉上表的列：表头跟着收回',
    !(await evl(`[...document.querySelectorAll('.tablewrap[data-tab="${BK}"] thead th')].map(t => t.dataset.k).join()`))
      .split(',').includes('registrar'));
  await evl(`document.querySelector('#dlg-coll').close()`);
  await sleep(200);

  check('删掉收尾测试库', (await fetch(`${APP}api/collections/${bc.id}`, { method: 'DELETE' })).ok);
  await evl(`loadAll()`);
  await sleep(900);
  check('删库后本机视图偏好也清掉（否则 localStorage 里越堆越多）',
    await evl(`JSON.parse(localStorage.getItem('kalends.views.v1'))['${BK}'] === undefined`) === true);

  // 自定义周期不填天数：既算不出到期日，周期还会显示成 "Every 0 days"
  await evl(`switchTab('subs')`);
  await sleep(400);
  const cycRowId = +(await evl(`document.querySelector('#subs-body tr').dataset.id`));
  const cycBefore = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(r => r.id === cycRowId);
  await evl(`(async () => {
    document.querySelector('#subs-body tr[data-id="${cycRowId}"] td[data-k="cycle"]').click();
    await new Promise(r => setTimeout(r, 350));
    const sel = document.querySelector('.cellpop [data-cycle]');
    sel.value = 'days';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.cellpop .cp-foot button').click();
  })()`);
  await sleep(800);
  check('自定义周期不填天数会被拦下', await evl(
    `document.querySelector('#toast').textContent.includes('天数')`) === true);
  const cycAfter = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(r => r.id === cycRowId);
  check('拦下时不落库', cycAfter.cycle === cycBefore.cycle && cycAfter.cycle_days === cycBefore.cycle_days,
    `${cycBefore.cycle}/${cycBefore.cycle_days} → ${cycAfter.cycle}/${cycAfter.cycle_days}`);
  await evl(`closePop()`);


  /* 17.27. 「续费起算」是独立的轴：保号窗口从实际充值当天重算（today），
     VPS 按固定日历日出账（schedule）——两种语义不能挤在一个标记里。 */
  const rfColls = await (await fetch(APP + 'api/collections')).json();
  const rfMap = Object.fromEntries(rfColls.map(c => [c.key, c.renew_from]));
  check('预置库的续费起算：订阅/VPS 按日程、SIM 从当天',
    rfMap.subs === 'schedule' && rfMap.vps === 'schedule' && rfMap.sims === 'today', JSON.stringify(rfMap));

  // 同一份数据喂给两个库：30 天一期、欠了三期多。差别只在库的续费起算方式上。
  // 用天数周期是为了不在断言里再复刻一遍日历加法——月末钳位那类边界由 cargo test 守着
  const rfSeed = { status: 'Active', cycle: 'days', cycle_days: 30, last_renewed: day(-100) };
  const rfVps = await mk('vps', { name: '账单日机器', price: 9, currency: 'USD', ...rfSeed, extra: { purpose: '任务' } });
  const rfSim = await mk('sims', { name: '保号测试卡', ...rfSeed, extra: { keepalive_action: '充值' } });

  const rfResp = await post(`/api/items/${rfVps.id}/renew`, {});
  const rfVpsAfter = (await (await fetch(APP + 'api/collections/vps/items')).json()).find(r => r.id === rfVps.id);
  check('按日程续费：锚点落在刚付的那一期，不是今天',
    rfVpsAfter.last_renewed === day(-10), `落在 ${rfVpsAfter.last_renewed}，今天是 ${today}`);
  check('按日程续费：到期日回到原本的账单日',
    rfResp.due === day(20), JSON.stringify(rfResp));

  await post(`/api/items/${rfSim.id}/renew`, {});
  const rfSimAfter = (await (await fetch(APP + 'api/collections/sims/items')).json()).find(r => r.id === rfSim.id);
  check('保号仍从操作当天重新计时（同样的数据，另一种语义）',
    rfSimAfter.last_renewed === today, `落在 ${rfSimAfter.last_renewed}，今天是 ${today}`);

  await evl(`loadAll()`);
  await sleep(700);
  await evl(`switchTab('vps')`);
  await sleep(250);
  await evl(`openCollDialog(collOf('vps'))`);
  await sleep(350);
  check('库设置里有「续费起算」这一栏',
    await evl(`document.querySelector('#dlg-coll [data-c="renew_from"]')?.value`) === 'schedule');
  await shot('24-renew-from');
  await evl(`document.querySelector('#dlg-coll [data-c="renew_from"]').value = 'today'`);
  await evl(`document.querySelector('#form-coll button[type=submit]').click()`);
  await sleep(800);
  const rfSaved = (await (await fetch(APP + 'api/collections')).json()).find(c => c.key === 'vps');
  check('界面改「续费起算」能存回去', rfSaved?.renew_from === 'today', JSON.stringify(rfSaved));
  // 收拾：改回按日程、删掉这两条，后面的段落按原样算
  await put(`/api/collections/${rfSaved.id}`, { renew_from: 'schedule' });
  for (const id of [rfVps.id, rfSim.id]) await fetch(`${APP}api/items/${id}`, { method: 'DELETE' });
  await evl(`(() => { const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true; })()`);
  await evl(`loadAll()`);
  await sleep(700);


  /* 17.29. 换库的到期模型：另一侧的日期字段此前从未注册过，切过去 due_from 就改读一个
     界面上根本造不出来的字段（字段面板只能建 extra 自定义列），整库到期日静默消失——
     表格里旧的那列还显示着值，看着一切正常，时间线却空了。 */
  const acColl = await post('/api/collections', { name: '锚点切换', due_anchor: 'last' });
  const acItem = await mk(acColl.key, { name: '按上次续费算', status: 'Active', cycle: 'monthly', last_renewed: day(-5) });
  const acKeys = async () => (await (await fetch(`${APP}api/fields`)).json())
    .filter(f => f.tbl === acColl.key).map(f => f.key);
  const k0 = await acKeys();
  check('last 锚点的库只播了上次续费日', k0.includes('last_renewed') && !k0.includes('next_renewal'), JSON.stringify(k0));
  check('切换前算得出到期日',
    (await (await fetch(APP + 'api/overview')).json()).upcoming.some(u => u.kind === acColl.key && u.id === acItem.id));

  await put(`/api/collections/${acColl.id}`, { due_anchor: 'next' });
  const k1 = await acKeys();
  check('切成 next 之后下次到期日被补进字段注册表', k1.includes('next_renewal'), JSON.stringify(k1));
  const acOv = await (await fetch(APP + 'api/overview')).json();
  check('日期还没填时条目被点名，而不是从时间线上静默消失',
    acOv.undated.some(x => x.kind === acColl.key && x.id === acItem.id && x.missing === '下次续费日'),
    JSON.stringify(acOv.undated));
  await evl(`loadAll()`);
  await sleep(800);
  check('新字段在详情表单里真的有一格可填', await evl(`(() => {
    const r = (state['${acColl.key}'] || []).find(x => x.id === ${acItem.id});
    if (!r) return 'no-row';
    openItemDialog('${acColl.key}', r);
    const has = !!document.querySelector('#item-fields [data-f="next_renewal"]');
    document.querySelector('#dlg-item').close();
    return has;
  })()`) === true);
  const acRow = (await (await fetch(`${APP}api/collections/${acColl.key}/items`)).json()).find(r => r.id === acItem.id);
  await patch(`/api/items/${acItem.id}`, { ...acRow, next_renewal: day(9) });
  check('填上之后到期日就回来了',
    (await (await fetch(APP + 'api/overview')).json()).upcoming
      .some(u => u.kind === acColl.key && u.id === acItem.id && u.due === day(9)));

  // 算不出到期日时点名的必须是真正缺的那一项：last 锚点有两半成因（缺日期 / 缺周期），
  // 一律报「缺上次续费日」的话，用户打开条目看见日期填着，按提示无从下手
  await put(`/api/collections/${acColl.id}`, { due_anchor: 'last' });
  const acRow2 = (await (await fetch(`${APP}api/collections/${acColl.key}/items`)).json()).find(r => r.id === acItem.id);
  await patch(`/api/items/${acItem.id}`, { ...acRow2, cycle: '', last_renewed: day(-5) });
  check('日期填着、周期空着时点名的是「周期」',
    (await (await fetch(APP + 'api/overview')).json()).undated
      .find(x => x.kind === acColl.key && x.id === acItem.id)?.missing === '周期');

  // 提前续费（按日程续费会产生「未来的 last_renewed」，0017 之前不可能出现的合法状态）：
  // 本期还没开始，照旧画进度条就是「剩 35 天 / 30」配一根空槽，看着像算错了
  await patch(`/api/items/${acItem.id}`, { ...acRow2, cycle: 'days', cycle_days: 30, last_renewed: day(5) });
  await evl(`loadAll()`);
  await sleep(800);
  await evl(`switchTab('${acColl.key}')`);
  await sleep(400);
  const acLeft = (await evl(
    `document.querySelector('#${acColl.key}-body tr[data-id="${acItem.id}"] td[data-k="left"]')?.textContent || ''`))
    .replace(/\s+/g, ' ');
  check('本期还没开始时不画进度条，改说清本期哪天起算',
    acLeft.includes('剩 35 天') && acLeft.includes(day(5)) && !acLeft.includes('/ 30'), acLeft);
  // 拍在该看的状态下：表格在页面下半，不滚过去截出来的是首页那一屏
  await evl(`document.querySelector('#${acColl.key}-body tr[data-id="${acItem.id}"]')?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await shot('25-early-renew-left');
  await fetch(`${APP}api/collections/${acColl.id}`, { method: 'DELETE' });
  await evl(`loadAll()`);
  await sleep(700);


  /* 17.33 后半：库设置只留齿轮 */
  // 库设置只剩齿轮：右键那个入口不看文档发现不了，撤掉
  check('右键库标签不再开设置', await evl(`(() => {
    const tab = document.querySelector('.tab[data-tab="subs"]');
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return !document.querySelector('#dlg-coll')?.open;
  })()`) === true);
  check('齿轮仍能开库设置', await evl(`(() => {
    document.querySelector('#coll-settings').click();
    const open = !!document.querySelector('#dlg-coll')?.open;
    document.querySelector('#dlg-coll')?.close();
    return open;
  })()`) === true);


  /* 18. 库删光也不能把界面打崩。放在最后跑——这一段会把预置库连数据一起删掉。
     预置库过去在界面上删不掉（后端一直放行、文档也写着可删），而新库的表格容器
     锚在 VPS 那张表上：VPS 一删，同一会话里再建库就是 null.after()，loadAll 断在那儿。 */
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(300);
  await sleep(250);
  await evl(`openCollDialog(collOf('vps'))`);
  await sleep(350);
  check('预置库的库设置里有删除入口', await evl(`!document.querySelector('#coll-del').hidden`) === true);
  await evl(`document.querySelector('#coll-del').click()`); // confirm 由 CDP 自动 accept
  await sleep(1400);
  check('预置库删得掉', (await (await fetch(APP + 'api/collections')).json()).every(c => c.key !== 'vps'));
  check('删掉后标签与容器一并撤走', await evl(
    `!document.querySelector('.tab[data-tab="vps"]') && !document.querySelector('.tablewrap[data-tab="vps"]')`) === true);
  // 同一会话里再建库：原来的锚点已经不在了
  const anchorProbe = await post('/api/collections', { name: '锚点探针' });
  const rebuilt = await evlSafe(`loadAll()`);
  check('删掉 VPS 后同一会话仍能建库', rebuilt.ok, rebuilt.v);
  await sleep(700);
  check('新库的表格容器建起来了', await evl(
    `!!document.querySelector('.tablewrap[data-tab="${anchorProbe.key}"]')`) === true);
  // 删到一个不剩：列宽结算、视图胶囊、表内搜索都会拿到一张不存在的表
  for (const c of await (await fetch(APP + 'api/collections')).json()) {
    await fetch(`${APP}api/collections/${c.id}`, { method: 'DELETE' });
  }
  const emptied = await evlSafe(`loadAll()`);
  check('删到一个库不剩也不崩', emptied.ok, emptied.v);
  await sleep(700);
  check('标签行空了', await evl(`document.querySelectorAll('.tab[data-tab]').length`) === 0);
  const typed = await evlSafe(`(() => {
    const s = document.querySelector('#t-search');
    s.value = 'x';
    s.dispatchEvent(new Event('input'));
    window.dispatchEvent(new Event('resize'));
  })()`);
  await sleep(500);
  check('零库时搜索与窗口缩放都不崩', typed.ok, typed.v);
  check('零库时也没有冒出 console 异常', consoleMsgs.filter(m => !m.includes('favicon')).length === 0,
    JSON.stringify(consoleMsgs.slice(0, 3)));
  const revived = await post('/api/collections', { name: '重建' });
  const revivedLoad = await evlSafe(`loadAll()`);
  check('零库之后还能重新建库', revivedLoad.ok, revivedLoad.v);
  await sleep(800);
  check('重建的库直接就是当前表', await evl(
    `state.tab === '${revived.key}' && !document.querySelector('.tablewrap[data-tab="${revived.key}"]').hidden`) === true);
  await shot('10-after-wipe');


}
