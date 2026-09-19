// 台账与设置页：续费记账可见、通知记录空态、坏渠道配置停保存、阈值与默认值来自服务端声明。
export default async function (t) {
  const { APP, sleep, put, items, check, evl, shot } = t;
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


}
