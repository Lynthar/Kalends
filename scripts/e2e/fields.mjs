// 字段与列：自定义列全链路、选项排序、tel / url / email 三种有形状的类型、类型 × 场所的叉积、属性内核的单一真源、可建类型与后端对齐。
export default async function (t) {
  const { APP, sleep, post, put, patch, raw, items, fields, check, evl, menuClick } = t;
  /* 12b. 自定义列全链路：新建 → 加选项 → 内联赋值 → 筛选 → 选项改名传播 → 删除列 */
  await evl(`document.querySelector('.tab[data-tab="subs"]').click()`);
  await sleep(200);
  await evl(`document.querySelector('#view-subs th.ops .addcol').click()`);
  await sleep(250);
  await evl(`(() => {
    document.querySelector('.optpop [data-name]').value = '渠道';
    document.querySelector('.optpop [data-type]').value = 'sel';
    document.querySelector('.optpop [data-go]').click();
  })()`);
  await sleep(700);
  const ckey = await evl(`[...document.querySelectorAll('#view-subs th')].map(t => t.dataset.k).find(k => /^c\\d+$/.test(k)) || ''`);
  check('新建列出现在表头', /^c\d+$/.test(ckey), ckey);
  check('新列排在操作列前', await evl(`(() => {
    const ths = [...document.querySelectorAll('#view-subs thead th')];
    return ths[ths.length - 1].dataset.k === 'ops' && ths[ths.length - 2].dataset.k === '${ckey}';
  })()`) === true);
  check('打开编辑选项', await menuClick(`#view-subs th[data-k="${ckey}"]`, '编辑选项'));
  await evl(`(() => { const i = document.querySelector('.optpop .opt-add input'); i.value = '官网'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(600);
  check('选项已入词表', (await evl(`document.querySelector('.optpop')?.textContent`) || '').includes('官网'));
  await evl(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(150);
  await evl(`document.querySelector('#subs-body tr td[data-k="${ckey}"]').click()`);
  await sleep(250);
  check('单选就地编辑器出现', await evl(`!!document.querySelector('.cellpop')`) === true);
  await evl(`[...document.querySelectorAll('.cellpop .mi')].find(x => x.textContent.includes('官网')).click()`);
  await sleep(700);
  check('赋值后格内出现标签', await evl(`document.querySelector('#subs-body tr td[data-k="${ckey}"] .tag')?.textContent`) === '官网');
  check('三开编辑选项调色', await menuClick(`#view-subs th[data-k="${ckey}"]`, '编辑选项'));
  await evl(`(() => {
    const row = [...document.querySelectorAll('.optpop .opt-row')].find(r => r.textContent.includes('官网'));
    row.querySelector('[data-color]').click();
  })()`);
  await sleep(200);
  await evl(`document.querySelector('.optpop .cstrip .cdot.t5').click()`);
  await sleep(600);
  check('选项颜色应用到格内标签', await evl(`!!document.querySelector('#subs-body tr td[data-k="${ckey}"] .tag.t5')`) === true);
  await evl(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(150);
  check('自定义列可筛选', await menuClick(`#view-subs th[data-k="${ckey}"]`, '筛选'));
  await evl(`[...document.querySelectorAll('.filterpop input')].find(i => i.value === '官网').click()`);
  await sleep(250);
  check('按自定义列筛出 1 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 1);
  await evl(`document.querySelector('#view-pills .p-filt .x').click()`);
  await sleep(250);
  check('再开编辑选项', await menuClick(`#view-subs th[data-k="${ckey}"]`, '编辑选项'));
  await evl(`(() => {
    const row = [...document.querySelectorAll('.optpop .opt-row')].find(r => r.textContent.includes('官网'));
    row.querySelector('[data-rn]').click();
  })()`);
  await sleep(200);
  await evl(`(() => { const i = document.querySelector('.optpop .opt-row input'); i.value = '官方'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(800);
  check('选项改名传播到行', await evl(`document.querySelector('#subs-body tr td[data-k="${ckey}"] .tag')?.textContent`) === '官方');
  await evl(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(150);


  /* 12c2. 选项手动排序：再添一项后把第一项拖到其后，词表顺序随之持久化 */
  check('四开编辑选项', await menuClick(`#view-subs th[data-k="${ckey}"]`, '编辑选项'));
  await evl(`(() => { const i = document.querySelector('.optpop .opt-add input'); i.value = '备用'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  const optOrder = async () => {
    const fs = await (await fetch(APP + 'api/fields')).json();
    return (fs.find(f => f.key === ckey)?.options || []).map(o => o.v).join(',');
  };
  check('添加后顺序 官方,备用', await optOrder() === '官方,备用', await optOrder());
  await evl(`(() => {
    const rows = [...document.querySelectorAll('.optpop .opt-row')];
    const src = rows[0], dst = rows[1];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: r.bottom - 2 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: r.bottom - 2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  })()`);
  await sleep(600);
  check('拖动后顺序 备用,官方', await optOrder() === '备用,官方', await optOrder());
  // 单指针替代：选项行的 ↑↓ 与拖动写同一份词表（触摸屏拖不动时的出路）
  await evl(`[...document.querySelectorAll('.optpop .opt-row')][1].querySelector('[data-up]').click()`);
  await sleep(500);
  check('选项 ↑ 上移后顺序 官方,备用', await optOrder() === '官方,备用', await optOrder());
  await evl(`[...document.querySelectorAll('.optpop .opt-row')][0].querySelector('[data-dn]').click()`);
  await sleep(500);
  check('选项 ↓ 挪得回来（备用,官方）', await optOrder() === '备用,官方', await optOrder());
  check('筛选浮层跟随手动序', await menuClick(`#view-subs th[data-k="${ckey}"]`, '筛选'));
  check('浮层首项是 备用', await evl(`document.querySelector('.filterpop .fp-item .fp-v')?.textContent`) === '备用');
  await evl(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(150);

  check('菜单删除自定义列', await menuClick(`#view-subs th[data-k="${ckey}"]`, '删除列'));
  await sleep(800);
  check('列已从表头移除', await evl(`!document.querySelector('#view-subs th[data-k="${ckey}"]')`) === true);
  // 判据问的是"这一列没了"，别再拿 !builtin 当"自定义列"的代名词——迁移 0014 之后
  // 预置库的域字段也是 builtin=0，那个代理判据会把它们一并算进来
  check('字段注册表已清空',
    (await (await fetch(APP + 'api/fields')).json()).every(f => f.key !== ckey));


  /* 17.22. 电话号码字段类型：号码本来就不是普通文本，写入口规范化、表格里可点拨号。 */
  const simFs = (await (await fetch(`${APP}api/fields`)).json()).filter(f => f.tbl === 'sims');
  check('SIM 的号码是 tel 类型', simFs.find(f => f.key === 'phone_number')?.ftype === 'tel',
    simFs.map(f => `${f.key}:${f.ftype}`));
  check('tel 在新建列的类型白名单里',
    (await post('/api/fields', { tbl: 'sims', name: '备用号码', ftype: 'tel' })).ftype === 'tel');

  const simRow0 = (await (await fetch(`${APP}api/collections/sims/items`)).json())[0];
  const simBody = e => ({ ...simRow0, extra: { ...(simRow0.extra || {}), phone_number: e } });
  check('写入口折叠多余空白', (await (async () => {
    await patch(`/api/items/${simRow0.id}`, simBody('  +81  90   1234 5678 '));
    const r = (await (await fetch(`${APP}api/collections/sims/items`)).json()).find(x => x.id === simRow0.id);
    return r.extra.phone_number;
  })()) === '+81 90 1234 5678');
  check('一个数字都没有的值被拦下',
    (await raw(`/api/items/${simRow0.id}`, 'PATCH', simBody('打客服'))).status === 400);
  check('混进不该有的字符也被拦下',
    (await raw(`/api/items/${simRow0.id}`, 'PATCH', simBody('+81 90ab'))).status === 400);
  // 位数偏少是既有数据里就有的（只填了国家码），放行但标出来——在写入口 400 掉
  // 等于让人打不开自己的旧条目
  check('位数偏少放行，不当错误', (await raw(`/api/items/${simRow0.id}`, 'PATCH', simBody('+44'))).ok);

  await evl(`loadAll()`);
  await sleep(900);
  await evl(`switchTab('sims')`);
  await sleep(500);
  // 号码默认不占列位（shown=0），只作为名称格小字露面——tel 渲染在两处都要有
  check('名称格小字里的号码也是可点拨号的链接',
    await evl(`(() => {
      const a = document.querySelector('#sims-body tr .muted a.tel');
      return a ? a.getAttribute('href') : null;
    })()`) === 'tel:+44');
  check('位数偏少的号码挂了提醒标',
    await evl(`!!document.querySelector('#sims-body tr .muted .tel-warn')`) === true);
  // 把它放上表，列里同样是拨号链接
  const pnField = (await (await fetch(`${APP}api/fields`)).json()).find(f => f.tbl === 'sims' && f.key === 'phone_number');
  await put(`/api/fields/${pnField.id}`, { name: pnField.name, shown: true });
  await evl(`loadAll()`);
  await sleep(900);
  check('号码列渲染成拨号链接，href 滤掉空格横杠',
    await evl(`(() => {
      const a = document.querySelector('#sims-body tr td[data-k="phone_number"] a.tel');
      return a ? a.getAttribute('href') : null;
    })()`) === 'tel:+44');
  await put(`/api/fields/${pnField.id}`, { name: pnField.name, shown: false });
  await patch(`/api/items/${simRow0.id}`, simBody(simRow0.extra?.phone_number || ''));


  /* 17.25. 网址与邮箱类型：同样是"有形状的文本"，写入口规范化、格子里给可点的链接。 */
  check('url / email 在新建列的类型白名单里',
    (await post('/api/fields', { tbl: 'subs', name: '官网', ftype: 'url' })).ftype === 'url'
    && (await post('/api/fields', { tbl: 'subs', name: '账户邮箱', ftype: 'email' })).ftype === 'email');
  const shapeFs = (await (await fetch(`${APP}api/fields`)).json()).filter(f => f.tbl === 'subs');
  const urlKey = shapeFs.find(f => f.name === '官网').key;
  const mailKey = shapeFs.find(f => f.name === '账户邮箱').key;

  const shapeRow = (await (await fetch(`${APP}api/collections/subs/items`)).json())[0];
  const shapeBody = ex => ({ ...shapeRow, extra: { ...(shapeRow.extra || {}), ...ex } });
  check('网址没写协议时补 https://', (await (async () => {
    await patch(`/api/items/${shapeRow.id}`, shapeBody({ [urlKey]: 'netflix.com' }));
    const r = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(x => x.id === shapeRow.id);
    return r.extra[urlKey];
  })()) === 'https://netflix.com');
  check('邮箱域名统一小写、用户名原样', (await (async () => {
    await patch(`/api/items/${shapeRow.id}`, shapeBody({ [mailKey]: ' Me.You+tag@Example.COM ' }));
    const r = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(x => x.id === shapeRow.id);
    return r.extra[mailKey];
  })()) === 'Me.You+tag@example.com');
  check('形状不对的网址被拦下',
    (await raw(`/api/items/${shapeRow.id}`, 'PATCH', shapeBody({ [urlKey]: 'ftp://a.com' }))).status === 400);
  check('形状不对的邮箱被拦下',
    (await raw(`/api/items/${shapeRow.id}`, 'PATCH', shapeBody({ [mailKey]: 'a@b' }))).status === 400);

  await patch(`/api/items/${shapeRow.id}`, shapeBody({ [urlKey]: 'https://www.netflix.com/browse?x=1', [mailKey]: 'me@example.com' }));
  await evl(`loadAll()`);
  await sleep(900);
  await evl(`switchTab('subs')`);
  await sleep(500);
  check('网址格只显示域名（原串常带一长串参数，铺开会把整列撑爆）',
    (await evl(`document.querySelector('#subs-body tr[data-id="${shapeRow.id}"] td[data-k="${urlKey}"]')?.textContent || ''`)).trim().startsWith('netflix.com'),
    await evl(`document.querySelector('#subs-body tr[data-id="${shapeRow.id}"] td[data-k="${urlKey}"]')?.textContent`));
  check('网址是可点的外链',
    await evl(`document.querySelector('#subs-body tr[data-id="${shapeRow.id}"] td[data-k="${urlKey}"] a')?.getAttribute('href')`)
      === 'https://www.netflix.com/browse?x=1');
  check('邮箱渲染成 mailto',
    await evl(`document.querySelector('#subs-body tr[data-id="${shapeRow.id}"] td[data-k="${mailKey}"] a')?.getAttribute('href')`)
      === 'mailto:me@example.com');


  /* 17.26. 从网站取图标：本项目第二条默认关着的出网，且只连条目自己那个站。
     **内网一律拦下**——不拦的话这颗按钮就成了替人探测内网的工具。 */
  check('没有网址时说清楚，而不是默默失败',
    (await raw(`/api/items/${shapeRow.id}/logo/fetch`, 'POST', { url: '' })).status === 400);
  for (const host of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/']) {
    const r = await raw(`/api/items/${shapeRow.id}/logo/fetch`, 'POST', { url: host });
    check(`拦下内网地址 ${host}`, r.status === 400 && (await r.json()).error?.includes('公网'));
  }
  // localhost 与 IPv6 字面量更早一步就被 url 形状检查拦了（域名里没有点），
  // 同样进不去出网那一段——两道防线叠着，哪道先挡下都行
  for (const h of ['http://localhost/', 'http://[::1]/']) {
    check(`拦下 ${h}（由形状检查先挡）`,
      (await raw(`/api/items/${shapeRow.id}/logo/fetch`, 'POST', { url: h })).status === 400);
  }
  check('形状不对的网址在取图标时也拦下',
    (await raw(`/api/items/${shapeRow.id}/logo/fetch`, 'POST', { url: 'ftp://a.com' })).status === 400);

  // 详情表单里的「从网站取」按钮：填了网址才出现（没网址时点了必然失败，不如不给）
  await evl(`openItemDialog('subs', state.subs.find(r => r.id === ${shapeRow.id}))`);
  await sleep(600);
  // 值在自建的网址列里（不是内置 url 真列）——按钮认的是「url 类型」而不是某个固定键
  check('自建网址列也能触发「从网站取」按钮',
    await evl(`!document.querySelector('[data-logo-grab]')?.hidden`) === true);
  await evl(`(() => {
    for (const i of document.querySelectorAll('#item-fields [data-f="url"], #item-fields [data-urlfield]')) {
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await sleep(200);
  check('所有网址列都清空后按钮才收起来',
    await evl(`document.querySelector('[data-logo-grab]')?.hidden`) === true);
  await evl(`document.querySelector('#dlg-item').close()`);
  await sleep(200);

  // 收拾：删掉这两列，后面的段落按原样算
  for (const f of [shapeFs.find(x => x.name === '官网'), shapeFs.find(x => x.name === '账户邮箱')]) {
    await fetch(`${APP}api/fields/${f.id}`, { method: 'DELETE' });
  }
  await evl(`loadAll()`);
  await sleep(800);


  /* 17.28. 「类型 × 场所」的叉积：新字段类型最常见的失守是只接一半管线——渲染接了
     筛选没接、表格接了表单没接。按功能加断言抓不到这类缺口，得按叉积补。 */
  await evl(`switchTab('subs')`);
  await sleep(400);
  // 上一段收拾掉了自己建的那两列，这里重新建一套自己的（三种类型各一）
  const xUrlF = await post('/api/fields', { tbl: 'subs', name: '站点', ftype: 'url' });
  const xMailF = await post('/api/fields', { tbl: 'subs', name: '联系邮箱', ftype: 'email' });
  const xTel = await post('/api/fields', { tbl: 'subs', name: '客服电话', ftype: 'tel' });
  const [xUrl, xMail] = [xUrlF.key, xMailF.key];
  const xRow = (await (await fetch(`${APP}api/collections/subs/items`)).json())[0];
  await patch(`/api/items/${xRow.id}`, { ...xRow, extra: { ...(xRow.extra || {}),
    [xUrl]: 'https://www.netflix.com/browse?x=1', [xMail]: 'me@example.com', [xTel.key]: '+81 90 1234 5678' } });
  await evl(`loadAll()`);
  await sleep(900);

  // 筛选浮层要认全部非列表型类型。OP_MENU 只有 text/num/date 三键时，OP_MENU['url'][0][0]
  // 对 undefined 取下标当场 TypeError：浮层不出现、无任何提示，而排序照常——
  // 「所有列都可排序可筛选」这条不变量就对新类型静默失守了。
  for (const [label, k] of [['网址', xUrl], ['邮箱', xMail], ['电话', xTel.key]]) {
    const opened = await evl(`(() => {
      try {
        const th = document.querySelector('.tablewrap[data-tab="subs"] thead th[data-k="${k}"]');
        if (!th) return 'no-th';
        openFilterPop('subs', '${k}', th);
        return !!document.querySelector('.filterpop select.fp-op');
      } catch (e) { return 'ERR: ' + e.message; }
    })()`);
    check(`${label}列的筛选浮层打得开`, opened === true, String(opened));
    await evl(`closePop()`);
    await sleep(120);
  }
  // 谓词那侧一直是兜底走文本分支的，顺手连它一起钉住
  // 取节点一律 ?.：撤回修复做负向对照时这里本就抛，别让整份套件断在半路
  await evl(`(() => {
    try {
      const th = document.querySelector('.tablewrap[data-tab="subs"] thead th[data-k="${xUrl}"]');
      openFilterPop('subs', '${xUrl}', th);
      const q = document.querySelector('.filterpop .fp-q');
      q.value = 'netflix';
      q.dispatchEvent(new Event('input'));
    } catch (e) { /* negative control */ }
  })()`);
  await sleep(400);
  check('网址列筛出来的行数真的变了',
    await evl(`document.querySelectorAll('#subs-body tr').length`) === 1,
    await evl(`document.querySelectorAll('#subs-body tr').length`));
  await evl(`setFilter('subs', '${xUrl}', null); closePop();`);
  await sleep(300);
  for (const f of [xUrlF, xMailF, xTel]) await fetch(`${APP}api/fields/${f.id}`, { method: 'DELETE' });
  await evl(`loadAll()`);
  await sleep(700);


  /* 17.31b. 属性内核：一种类型的行为集中在 TYPES 一张表里。这几条守的是"单一真源"本身——
     以后再长出散落的 if，这里不会响；但表里少接一样（漏了筛选组、漏了图标）当场就翻。 */
  check('内核里每种类型都接齐了：名字 / 图标 / 筛选组', await evl(`(() => {
    const ts = Object.entries(TYPES);
    return ts.length >= 9 && ts.every(([t, s]) =>
      !!s.label && !!s.icon && ['list', 'text', 'num', 'date'].includes(s.filter));
  })()`) === true);
  check('筛选分派与内核一致（勾选清单 vs 三组操作符，没有落空的）', await evl(`(() => {
    return Object.keys(TYPES).every(t => TYPES[t].filter === 'list'
      ? LIST_TYPES.includes(t)
      : ['text', 'num', 'date'].includes(opKind(t)));
  })()`) === true);
  check('「新建列」下拉列的正是内核里**建得出来**的那几种', await evl(`(() => {
    openNewColPop('subs', document.querySelector('#view-subs th.ops'));
    const opts = [...document.querySelectorAll('.optpop [data-type] option')].map(o => o.value).join(',');
    closePop();
    return opts === CREATABLE_TYPES.join(',');
  })()`) === true);
  // 状态是内核里的真类型，但不给建：它的词表带着支出/提醒/时间线三层语义，后端 FTYPES 也不收。
  // 下拉一旦直接铺开整张内核表，这一项就是「选了必 400」的死选项（第 17.34 段验后端那一半）
  check('状态在内核里、但不在「新建列」下拉里', await evl(
    `!!TYPES.status && !CREATABLE_TYPES.includes('status')`) === true);


  /* 17.34 ① */
  // ① 下拉里的每一种都得真建得出来：后端 FTYPES 少收一种，那一项就是选了必 400 的死选项
  const offeredTypes = JSON.parse(await evl(`JSON.stringify(CREATABLE_TYPES)`) || '[]');
  const reallyCreatable = [];
  for (const t of offeredTypes) {
    const r = await raw('/api/fields', 'POST', { tbl: 'subs', name: '_t_' + t, ftype: t });
    if (!r.ok) continue;
    reallyCreatable.push(t);
    await raw(`/api/fields/${(await r.json()).id}`, 'DELETE');
  }
  check('「新建列」下拉里的每一种类型，后端都真的建得出来',
    reallyCreatable.join(',') === offeredTypes.join(','), `${reallyCreatable} vs ${offeredTypes}`);
  check('状态类型后端不收（所以它也不该出现在下拉里）',
    (await raw('/api/fields', 'POST', { tbl: 'subs', name: '_t_status', ftype: 'status' })).status === 400);


}
