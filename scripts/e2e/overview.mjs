// 首页：到期栏的默认态、折叠、窗口档位、不提醒的条目、算不出到期日的点名、支出折算与缺项点名。
export default async function (t) {
  const { APP, sleep, post, put, patch, raw, mk, items, check, day, send, evl, shot } = t;
  /* 1. 即将到期默认态 */
  const ov = await (await fetch(APP + 'api/overview')).json();
  const expShown = ov.upcoming.filter(u => u.days_left <= 30).length;
  const expHidden = ov.upcoming.length - expShown;
  check('默认窗口 30 天', await evl(`document.querySelector('#up-window').value`) === '30');
  check(`窗口内 ${expShown} 项`, await evl(`document.querySelectorAll('#up-list li').length`) === expShown);
  check('更远期提示', (await evl(`document.querySelector('#up-more').textContent`)).includes(`还有 ${expHidden} 项`));
  check('主宽度 1400', await evl(`getComputedStyle(document.querySelector('main')).maxWidth`) === '1400px');
  await shot('01-desktop-default');


  /* 2. 折叠 */
  await evl(`document.querySelector('#up-toggle').click()`);
  await sleep(700);
  check('折叠 class', await evl(`document.querySelector('#up-panel').classList.contains('folded')`) === true);
  const sumTxt = await evl(`document.querySelector('#up-summary').textContent`);
  check('折叠摘要', sumTxt.includes('Netflix'), sumTxt);
  check('摘要紧急色', await evl(`document.querySelector('#up-summary').classList.contains('hot')`) === true);
  await shot('02-folded');
  await evl(`document.querySelector('#up-title').click()`);
  await sleep(500);
  check('标题点击展开', await evl(`document.querySelector('#up-panel').classList.contains('folded')`) === false);


  /* 3. 窗口调整写服务端 */
  await evl(`(() => { const s = document.querySelector('#up-window'); s.value = '90'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  check('90 天窗口 7 项', await evl(`document.querySelectorAll('#up-list li').length`) === 7);
  const st1 = await (await fetch(APP + 'api/settings')).json();
  check('设置写服务端', st1['ui.upcoming_days'] === '90');


  /* 16. hidden 属性回归（全局 [hidden]{display:none!important} 不能被 display 规则盖掉，
     历史上媒体海报墙就是这么翻车的；这里用到期栏的「更远期还有 N 项」当探针） */
  await evl(`(() => { const s = document.querySelector('#up-window'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  check('窗口=全部时「更远期」按 hidden 属性隐藏',
    await evl(`document.querySelector('#up-more').hasAttribute('hidden')`) === true
    && await evl(`getComputedStyle(document.querySelector('#up-more')).display`) === 'none');
  // 「全部」不是整数：服务端拒掉它的话界面当场正确、刷新就回旧窗口
  const stAll = await (await fetch(APP + 'api/settings')).json();
  check('窗口=全部落到了服务端', stAll['ui.upcoming_days'] === 'all', stAll['ui.upcoming_days']);
  // 下拉的每一档服务端都得收下：前端再加一档、服务端没跟，就在这里红
  for (const w of await evl(`[...document.querySelectorAll('#up-window option')].map(o => o.value)`)) {
    check(`到期窗口档位 ${w} 服务端收下`, (await put('/api/settings', { 'ui.upcoming_days': w })).ok);
  }
  await evl(`(() => { const s = document.querySelector('#up-window'); s.value = '7'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  check('窗口收窄后「更远期」出现',
    await evl(`getComputedStyle(document.querySelector('#up-more')).display`) !== 'none');
  // 同屏既说「朔日无账」又说「还有 N 项」读着矛盾：窗口外还有项时只留后者
  const bothMsg = await evl(`(() => {
    const save = state.overview.upcoming;
    state.overview.upcoming = [{ kind: 'subs', id: 1, name: '远期', due: '2030-01-01', days_left: 900, verb: '续费', cycle: 'Annual' }];
    renderUpcoming();
    const out = { empty: !document.querySelector('#up-empty').hidden, more: !document.querySelector('#up-more').hidden };
    state.overview.upcoming = save;
    renderUpcoming();
    return out;
  })()`);
  check('窗口内无项但更远期有项时不显示空态', bothMsg.empty === false && bothMsg.more === true, JSON.stringify(bothMsg));
  check('日期列不折行', await evl(
    `getComputedStyle(document.querySelector('#subs-body td[data-k="next_renewal"]')).whiteSpace`) === 'nowrap');


  /* 17.5. 状态语义关掉提醒的条目（Ending＝到期不续）在到期栏里要看得出区别：
     engine 一直随 upcoming 下发 muted，界面此前完全没用它，于是「不续」和「该续」长得一样。 */
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(250);
  await evl(`setUpWindow('all')`); // HostB（Ending）到期在 61 天后，默认 30 天窗口看不到
  await evl(`if (state.upFolded) toggleUpFold()`); // 上一段把到期栏折起来了，展开才看得见也才截得到
  await sleep(700);
  const quiet = await evl(`(() => {
    const li = [...document.querySelectorAll('#up-list li')];
    const b = li.find(x => x.textContent.includes('HostB'));
    const n = li.find(x => x.textContent.includes('Netflix'));
    return {
      bQuiet: !!b?.classList.contains('quiet'),
      bMeta: b?.querySelector('.meta')?.textContent || '',
      bDays: b ? getComputedStyle(b.querySelector('.days')).color : '',
      nQuiet: !!n?.classList.contains('quiet'),
    };
  })()`);
  check('不提醒的条目在到期栏里淡下去', quiet.bQuiet === true, JSON.stringify(quiet));
  check('并且在小字里注明不提醒', quiet.bMeta.includes('不提醒'), quiet.bMeta);
  check('照常提醒的条目不受影响', quiet.nQuiet === false, JSON.stringify(quiet));
  await shot('11-quiet-item');


  /* 17.24. 算不出到期日的条目要被点名，而不是从时间线上静默消失。 */
  const undRow = (await (await fetch(`${APP}api/collections/subs/items`)).json())
    .find(r => r.status === 'Active' && r.next_renewal);
  await patch(`/api/items/${undRow.id}`, { ...undRow, next_renewal: '' });
  await evl(`loadAll()`);
  await sleep(900);
  const undOv = await (await fetch(APP + 'api/overview')).json();
  check('接口把它列进 undated 而不是丢掉',
    undOv.undated.some(x => x.id === undRow.id && x.missing === '下次续费日'), JSON.stringify(undOv.undated));
  check('它确实不在到期时间线上（所以才必须点名）',
    !undOv.upcoming.some(x => x.kind === 'subs' && x.id === undRow.id));
  check('首页点名了它',
    await evl(`!document.querySelector('#up-undated').hidden`) === true
    && (await evl(`document.querySelector('#up-undated').textContent`)).includes(undRow.name));
  await patch(`/api/items/${undRow.id}`, undRow);
  await evl(`loadAll()`);
  await sleep(900);
  check('日期填回去之后提示消失',
    await evl(`document.querySelector('#up-undated').hidden`) === true);


  // 这一段拿一条 USD 行做「存的仍是原币」的对照
  const fx_curRow = (await items('subs')).find(r => r.currency === 'USD');
  /* 17.21. 统一币种显示：折算只在呈现层，原币一律不动。 */
  const fx_fx0 = await (await fetch(APP + 'api/fx')).json();
  check('/api/fx 给出内置平均汇率', typeof fx_fx0.rates?.CNY === 'number' && fx_fx0.rates.USD === 1);
  check('默认不折算（这是按需出网，不点就不发生）', fx_fx0.display === '' && fx_fx0.live.length === 0);
  check('内置表说明了取样区间', typeof fx_fx0.baseline_period === 'string' && fx_fx0.baseline_period.length > 0);
  // 打开折算：表格费用格变成折算值 + 原币小字
  await put('/api/settings', { 'fx.display': 'CNY' });
  await evl(`loadAll()`);
  await sleep(900);
  const fx_cellTxt = await evl(`[...document.querySelectorAll('#subs-body td[data-k="price"]')]
    .map(t => t.textContent).find(t => t.includes('CNY') && t.includes('USD')) || ''`);
  check('费用格显示折算值、原币退到小字', fx_cellTxt.startsWith('CNY') && fx_cellTxt.includes('USD'), fx_cellTxt);
  check('原币小字挂的是 .orig',
    await evl(`!!document.querySelector('#subs-body td[data-k="price"] .orig, #subs-body td[data-k="price"] .muted')`) === true);
  // 折算是算对的：拿汇率表自己验一遍，别只看"有个数"
  check('折算值与汇率表对得上', await evl(`(() => {
    const r = state.subs.find(x => x.currency === 'USD' && x.price != null);
    const want = (r.price / state.fx.rates.USD * state.fx.rates.CNY).toFixed(2);
    const td = document.querySelector('#subs-body tr[data-id="' + r.id + '"] td[data-k="price"]');
    return td.textContent.includes(want);
  })()`) === true);
  check('存的仍是原币', (await (await fetch(APP + 'api/collections/subs/items')).json())
    .find(r => r.id === fx_curRow.id)?.currency === 'USD');
  // 首页支出并成一笔
  check('月度支出并成一笔折算值', await evl(`document.querySelectorAll('#totals .cur').length`) === 1);
  check('并出来的那笔标的是显示币种',
    await evl(`document.querySelector('#totals .cur .code')?.textContent`) === 'CNY');
  check('支出小字说明了折算成什么',
    (await evl(`document.querySelector('#totals-hint').textContent`)).includes('CNY'));
  // 折不出来的币种要如实说，不能默默漏掉
  await post('/api/collections/subs/items',
    { name: '无汇率币种', status: 'Active', price: 5, currency: 'XTS', cycle: 'monthly', next_renewal: day(20) });
  await evl(`loadAll()`);
  await sleep(900);
  check('没有汇率的币种如实标注、不并入总额',
    await evl(`!document.querySelector('#totals-note').hidden
      && document.querySelector('#totals-note').textContent.includes('XTS')`) === true);
  check('折不出来的那格原样显示原币', await evl(`(() => {
    const r = state.subs.find(x => x.currency === 'XTS');
    const td = document.querySelector('#subs-body tr[data-id="' + r.id + '"] td[data-k="price"]');
    return td.textContent.includes('XTS');
  })()`) === true);
  await shot('23-fx-converted');
  // 设置页那一栏
  await evl(`openSettings()`);
  await sleep(600);
  check('设置页能选显示币种', await evl(`document.querySelector('#fx-display').value`) === 'CNY');
  check('说清楚了当前用的是内置平均汇率',
    (await evl(`document.querySelector('#fx-status').textContent`)).includes('内置平均汇率'));
  check('有手动拉取按钮', await evl(`!!document.querySelector('#fx-refresh')`) === true);
  await evl(`document.querySelector('#dlg-settings').close()`);
  // 收拾：关掉折算、删掉那条无汇率条目，后面的段落按原样算
  await put('/api/settings', { 'fx.display': '' });
  const fx_xts = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(r => r.currency === 'XTS');
  await raw(`/api/items/${fx_xts.id}`, 'DELETE');
  await evl(`loadAll()`);
  await sleep(800);
  check('关掉折算后又是分币种显示',
    await evl(`document.querySelectorAll('#totals .cur').length`) >= 1
    && await evl(`document.querySelector('#totals-note').hidden`) === true);


  /* 17.34 ④ */
  // ④ 买断没有「每月多少」可言：缺币种也不该被点名——补了也照样不计入
  const lifeIt = await mk('subs', { name: '买断软件', status: 'Active', price: 49, cycle: 'lifetime' });
  const gapIt = await mk('subs', { name: '缺币种月付', status: 'Active', price: 9, cycle: 'monthly' });
  const ovGap = await (await fetch(APP + 'api/overview')).json();
  check('买断条目缺币种不进「没算进来」清单',
    !(ovGap.uncounted || []).some(x => x.id === lifeIt.id), JSON.stringify(ovGap.uncounted));
  check('同样缺币种的月付条目照旧点名（对照）',
    (ovGap.uncounted || []).some(x => x.id === gapIt.id && x.missing === '币种'), JSON.stringify(ovGap.uncounted));
  await raw(`/api/items/${lifeIt.id}`, 'DELETE');
  await raw(`/api/items/${gapIt.id}`, 'DELETE');


  /* 17.31 ③ */
  // ③ 有金额没币种的条目一分钱不进总额（engine::totals 要两样都在场才累加）。
  //    界面得点名，别让总额看着像"全都算进去了"
  await mk('subs', { name: '只填了金额', status: 'Active', cycle: 'monthly', next_renewal: day(9), price: 42 });
  await evl(`loadAll()`);
  await sleep(900);
  const nx_note = await evl(`document.querySelector('#totals-note').hidden ? '' : document.querySelector('#totals-note').textContent`);
  check('支出栏点名了"该计支出却没算进来"的条目',
    nx_note.includes('只填了金额') && nx_note.includes('缺币种'), nx_note);


}
