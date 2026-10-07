// 台账与设置页：续费记账可见、通知记录空态、坏渠道配置停保存、阈值与默认值来自服务端声明。
export default async function (t) {
  const { APP, sleep, put, items, check, send, evl, shot, settle, waitFor, dialogs } = t;
  /* 17.6. 「已续费」记的那笔账要能被看到：写台账这条路 e2e 从没走过，
     而台账在界面上一直没有入口——点完按钮，账进了库就再也见不到。 */
  const ledgerTarget = (await (await fetch(APP + 'api/collections/subs/items')).json())
    .find(r => r.name === 'Netflix');
  await evl(`switchTab('subs')`);
  await sleep(300);
  await evl(`document.querySelector('#subs-body tr[data-id="${ledgerTarget.id}"] [data-renew]').click()`);
  await sleep(1300);
  const led = await (await fetch(APP + 'api/ledger')).json();
  const entry = led.find(x => x.item_id === ledgerTarget.id && x.kind === 'subs');
  check('「已续费」写了一笔台账', !!entry, JSON.stringify(led.slice(0, 2)));
  check('台账带出条目名与库名', entry?.item_name === 'Netflix' && entry?.coll_name === '订阅', JSON.stringify(entry));
  check('续费把到期日往后推了',
    (await (await fetch(APP + 'api/collections/subs/items')).json())
      .find(r => r.id === ledgerTarget.id).next_renewal > ledgerTarget.next_renewal);
  // 续费的响应在途中丢了，前端分不清记没记上：今天已经记过一笔的条目再点要多问一句，别的照常
  const askFor = async row => evl(`(async () => {
    const keep = window.confirm;
    let asked = '';
    window.confirm = m => { asked = m; return false; };
    try { await doRenew('subs:${row.id}'); } finally { window.confirm = keep; }
    return asked;
  })()`);
  const other = (await items('subs')).find(r => r.id !== ledgerTarget.id && r.name);
  check('今天记过一笔的再续费要多问一句', (await askFor(ledgerTarget)).includes('今天已经记过一笔'));
  check('今天没记过的照常问', (await askFor(other)) === `记一笔「${other.name}」的续费？`);
  await evl(`openSettings()`);
  await sleep(800);
  check('设置页里列出了这笔台账', await evl(
    `[...document.querySelectorAll('#ledger-list .lg-row')].some(r => r.textContent.includes('Netflix'))`) === true);
  check('台账行带上了金额', await evl(
    `[...document.querySelectorAll('#ledger-list .lg-row')].find(r => r.textContent.includes('Netflix'))?.querySelector('.lg-a').textContent`
  ) === 'USD 15.49');
  // 通知发送记录：notification_log 的唯一读路径。渠道没开过的一次性实例里必须是空态文案，
  // 接口也应答空数组——这一步同时验了端点挂载与界面落位。
  check('通知记录接口可读且为空', (await (await fetch(APP + 'api/notify/log')).json()).length === 0);
  check('设置页给出发送记录的空态', await evl(
    `document.querySelector('#notify-log').textContent`) === '还没有发过通知——开渠道后每次投递都会在这里记一条');
  await evl(`document.querySelector('#ledger-list').scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await shot('12-ledger');
  await evl(`document.querySelector('#dlg-settings').close()`);
  await sleep(250);


  /* 17.6b. 存着的渠道配置解析不出来时，表单会渲染成「渠道关着、字段全空」——用户一保存，
     settingsBody() 就用这些空值把凭据覆盖掉。停掉保存、停掉那一栏、说出原因。 */
  await evl(`(() => { window._tgStash = state.settings['notify.telegram']; state.settings['notify.telegram'] = '不是 JSON'; openSettings(); })()`);
  await sleep(500);
  check('坏配置时保存键停用', await evl(`document.querySelector('#form-settings button[type=submit]').disabled`) === true);
  check('坏配置时那一栏也停用', await evl(`document.querySelector('#form-settings [name=tg_enabled]').closest('fieldset').disabled`) === true);
  check('坏配置时说出了原因', await evl(`document.querySelector('#toast').textContent.includes('读不出来')`) === true);
  await evl(`document.querySelector('#dlg-settings').close()`);
  await evl(`(() => { state.settings['notify.telegram'] = window._tgStash; openSettings(); })()`);
  await sleep(500);
  check('配置读得回来时保存键恢复', await evl(`document.querySelector('#form-settings button[type=submit]').disabled`) === false);
  await evl(`document.querySelector('#dlg-settings').close()`);
  // 上面那条错误提示是本段期望的产物（err 态挂 4.2 秒），收掉它别飘进后面的断言
  await evl(`(() => { const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true; t.classList.remove('err'); })()`);
  await sleep(250);


  /* 17.34 ⑤ */
  // ⑤ 清空阈值栏＝只发每日摘要（后端认 []），不能悄悄变成「只在到期当天提醒」：
  //    Number('') 是 0，滤不掉就落成 [0]，而界面上看不出任何异常
  await evl(`openSettings()`);
  await sleep(500);
  check('阈值栏：清空给 []，末尾多个逗号也不会多出一个 0 档', await evl(`(() => {
    const f = document.querySelector('#form-settings').elements;
    const was = f.thresholds.value;
    f.thresholds.value = '';
    const empty = settingsBody()['notify.thresholds'];
    f.thresholds.value = '14,7,';
    const trailing = settingsBody()['notify.thresholds'];
    f.thresholds.value = was;
    return empty + ' | ' + trailing;
  })()`) === '[] | [14,7]');
  // ⑤b 清空摘要时刻 / 摘要窗口 / SMTP 端口＝回默认，而默认只有服务端声明的那一份，占位串同理：
  //    前端再长出一份字面量且与声明不一致，就在这里红
  const dfDecl = await (await fetch(APP + 'api/settings/defaults')).json();
  check('占位串来自服务端声明', await evl(`(() => {
    const f = document.querySelector('#form-settings').elements;
    return f.thresholds.placeholder + ' | ' + f.em_port.placeholder;
  })()`) === `${JSON.parse(dfDecl['notify.thresholds']).join(',')} | ${JSON.parse(dfDecl['notify.email']).port}`);
  const dfCleared = await evl(`(() => {
    const f = document.querySelector('#form-settings').elements;
    const was = [f.digest_time.value, f.window_days.value, f.em_port.value];
    [f.digest_time.value, f.window_days.value, f.em_port.value] = ['', '', ''];
    const b = settingsBody();
    [f.digest_time.value, f.window_days.value, f.em_port.value] = was;
    return { 'notify.digest_time': b['notify.digest_time'], 'notify.window_days': b['notify.window_days'], 'notify.email': b['notify.email'] };
  })()`);
  const dfBefore = await (await fetch(APP + 'api/settings')).json();
  check('清空后的三项服务端收下', (await put('/api/settings', dfCleared)).ok);
  const dfAfter = await (await fetch(APP + 'api/settings')).json();
  check('清空摘要时刻＝声明的默认', dfAfter['notify.digest_time'] === dfDecl['notify.digest_time'], dfAfter['notify.digest_time']);
  check('清空摘要窗口＝声明的默认', dfAfter['notify.window_days'] === dfDecl['notify.window_days'], dfAfter['notify.window_days']);
  check('清空 SMTP 端口＝声明的默认', JSON.parse(dfAfter['notify.email']).port === JSON.parse(dfDecl['notify.email']).port, dfAfter['notify.email']);
  await put('/api/settings', { 'notify.digest_time': dfBefore['notify.digest_time'], 'notify.window_days': dfBefore['notify.window_days'], 'notify.email': dfBefore['notify.email'] });
  await evl(`document.querySelector('#dlg-settings').close()`);
  await sleep(200);


  // 「发送测试」测表单里的当前值、不落盘：先落盘的话点完测试再取消，试填的值已经盖掉库里的
  // 配置（清空 PIN 栏再点测试，门就静默打开了）。库里关着、表单里勾上：测的若是库里那份就是
  // 「未启用」；代理指死端口，测的是表单那份就当场在发送层失败
  const tgStored = { enabled: false, bot_token: 'TG-STORED', chat_id: '1', proxy: 'http://127.0.0.1:9' };
  await put('/api/settings', { 'notify.telegram': JSON.stringify(tgStored) });
  await evl(`loadAll()`);
  await evl(`openSettings()`);
  await sleep(300);
  await evl(`(() => {
    const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true; t.classList.remove('err');
    const f = document.querySelector('#form-settings').elements;
    f.tg_enabled.checked = true;
    f.tg_chat.value = '999';
    document.querySelector('[data-test=telegram]').click();
  })()`);
  check('发送测试拿的是表单里勾上的那份', await waitFor(`(() => {
    const t = document.querySelector('#toast');
    return !t.hidden && t.classList.contains('err') && t.textContent.includes('请求失败');
  })()`), await evl(`document.querySelector('#toast').textContent`));
  await evl(`document.querySelector('#dlg-settings').close()`);
  const tgAfter = JSON.parse((await (await fetch(APP + 'api/settings')).json())['notify.telegram']);
  check('点了测试再取消，库里的渠道配置一字未动', tgAfter.enabled === false && tgAfter.chat_id === '1',
    JSON.stringify(tgAfter));
  await put('/api/settings', { 'notify.telegram': JSON.stringify({ enabled: false, bot_token: '', chat_id: '', proxy: '' }) });
  await evl(`(() => { const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true; t.classList.remove('err'); })()`);
  await evl(`loadAll()`);


  // PIN 原样交给后端判：前端先剥符号的话，`12-34` 存成 `1234`（照原样输入反而进不去），
  // 全是符号的存成空串＝关掉了门，而 toast 照样说「设置已保存」
  await evl(`openSettings()`);
  await sleep(500);
  await evl(`(() => {
    document.querySelector('#form-settings').elements.pin.value = '12-34';
    document.querySelector('#form-settings button[type=submit]').click();
  })()`);
  await settle();
  const pinAfter = (await (await fetch(APP + 'api/settings')).json())['auth.pin'];
  check('带符号的 PIN 被拒收，库里不变', pinAfter === '', JSON.stringify(pinAfter));
  check('拒收的原因照实说出来，设置框没关', await evl(`(() => {
    const t = document.querySelector('#toast');
    return t.classList.contains('err') && t.textContent.includes('PIN') && document.querySelector('#dlg-settings').open;
  })()`) === true, await evl(`document.querySelector('#toast').textContent`));
  await evl(`document.querySelector('#dlg-settings').close()`);



  /* 存着的提醒阈值读不出来时，表单显示成空、读侧却在按默认值发——一保存就写成 []，逐项提醒静默关掉 */
  await evl(`(() => { window._thStash = state.settings['notify.thresholds']; state.settings['notify.thresholds'] = 'oops'; openSettings(); })()`);
  await sleep(400);
  check('阈值读不出时停用保存并说明', await evl(`document.querySelector('#form-settings button[type=submit]').disabled
    && document.querySelector('#toast').textContent.includes('提醒阈值')`) === true, await evl(`document.querySelector('#toast').textContent`));
  await evl(`document.querySelector('#dlg-settings').close(); state.settings['notify.thresholds'] = window._thStash`);
  await evl(`(() => { const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true; t.classList.remove('err'); })()`);

  /* 发送记录的失败原因写在那一行里：只放在悬停提示里的话，触屏与键盘都读不到 */
  t.sql(`INSERT INTO notification_log(kind,item_id,channel,threshold_days,due_date,ok,error) VALUES('digest',NULL,'telegram',NULL,'2026-01-01',0,'连不上 api.telegram.org')`);
  await evl(`openSettings()`);
  await waitFor(`!!document.querySelector('#notify-log .lg-row')`);
  check('发送记录的失败原因直接写在行里', await evl(`(() => {
    const why = document.querySelector('#notify-log .lg-why');
    return !!why && why.textContent.includes('api.telegram.org') && why.getBoundingClientRect().height > 0;
  })()`) === true);

  /* 经 http:// 访问局域网地址时没有 navigator.clipboard：退到 execCommand，再不行就说「已选中，请手动复制」 */
  await evl(`(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    window._exec = document.execCommand;
    document.execCommand = () => false;
    document.querySelector('#btn-copy-ics').click();
  })()`);
  await sleep(200);
  check('复制不了时选中链接并说请手动复制', await evl(`(() => {
    const t = document.querySelector('#toast'), box = document.querySelector('#ics-url');
    return t.classList.contains('err') && t.textContent.includes('手动复制')
      && box.selectionStart === 0 && box.selectionEnd === box.value.length;
  })()`) === true, await evl(`document.querySelector('#toast').textContent`));
  await evl(`document.execCommand = window._exec; document.querySelector('#dlg-settings').close()`);

  /* 设了 PIN 时首次开页：首屏并发的几个请求同时吃 401，只该问一次 PIN（放最后：之后不带 PIN 的接口调用都会 401） */
  await put('/api/settings', { 'auth.pin': '2468' });
  await send('Network.clearBrowserCookies');
  dialogs.seen.length = 0;
  dialogs.promptText = 'wrong';
  await send('Page.reload');
  const told = await waitFor(`document.querySelector('#toast')?.textContent.includes('PIN 不对')`, 8000);
  check('PIN 答错时也只问一次，并说是 PIN 不对', told && dialogs.seen.filter(x => x === 'prompt').length === 1,
    JSON.stringify([dialogs.seen, await evl(`document.querySelector('#toast')?.textContent`)]));
  dialogs.seen.length = 0;
  dialogs.promptText = '2468';
  await send('Page.reload');
  const loaded = await waitFor(`document.querySelectorAll('#up-list li').length > 0`, 8000);
  check('设了 PIN 首次开页只问一次，答对后页面照常加载', loaded && dialogs.seen.filter(x => x === 'prompt').length === 1,
    JSON.stringify(dialogs.seen));
  dialogs.promptText = '';
}
