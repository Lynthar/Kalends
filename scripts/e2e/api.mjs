// 接口契约：不开浏览器就能验的写入口规则、错误码、密钥处理。CI 里只要二进制就能跑。
export const browser = false;
export default async function (t) {
  const { APP, sleep, post, put, patch, raw, mk, items, fields, check, day } = t;
  /* 12j. 子行只有两层：三层的孙行在表格里既不属顶层也不会被渲染，会静默消失，所以写入口就拦住 */
  const gp = await post('/api/collections/subs/items', { name: '祖行', status: 'Active', extra: {} });
  const pr = await post('/api/collections/subs/items', { name: '父行', status: 'Active', parent_id: gp.id, extra: {} });
  check('两层可以建', typeof pr.id === 'number', JSON.stringify(pr));
  const third = await raw('/api/collections/subs/items', 'POST', { name: '孙行', status: 'Active', parent_id: pr.id, extra: {} });
  check('第三层被拒绝', !third.ok);
  check('拒绝时给的是可读原因', String((await third.json()).error).includes('两层'));
  const subsRows = await (await fetch(`${APP}api/collections/subs/items`)).json();
  check('被拒的孙行没有落库', !subsRows.some(r => r.name === '孙行'));
  const simRow = (await (await fetch(`${APP}api/collections/sims/items`)).json())[0];
  check('跨库的父行被拒绝',
    !(await raw('/api/collections/subs/items', 'POST', { name: '跨库', status: 'Active', parent_id: simRow.id, extra: {} })).ok);
  check('不存在的父行被拒绝',
    !(await raw('/api/collections/subs/items', 'POST', { name: '野父', status: 'Active', parent_id: 999999, extra: {} })).ok);
  const gpRow = subsRows.find(r => r.id === gp.id);
  const topRow = subsRows.find(r => !r.parent_id && r.id !== gp.id && r.id !== pr.id);
  check('自己不能当自己的父行', !(await raw(`/api/items/${gp.id}`, 'PATCH', { ...gpRow, parent_id: gp.id })).ok);
  check('已有子行的条目不能再挂到别人下面',
    !(await raw(`/api/items/${gp.id}`, 'PATCH', { ...gpRow, parent_id: topRow.id })).ok);

  const nameF = (await fields()).find(f => f.tbl === 'subs' && f.key === 'name');
  /* 12l. 错误码分级：请求本身的问题不该报 500，否则日志与反代的错误率指标全是假的 */
  const codeOf = async (path, method, body) => (await raw(path, method, body)).status;
  check('改不存在的条目 → 404', await codeOf('/api/items/999999', 'PATCH', { name: 'x' }) === 404);
  check('往不存在的库里加条目 → 404', await codeOf('/api/collections/nope/items', 'POST', { name: 'x' }) === 404);
  // 空名不再是客户端错误：表尾「＋ 新建」就是先插一行空的、再就地填（界面上渲染成「未命名」）
  const blank9 = await post('/api/collections/subs/items', { status: 'Active' });
  check('条目缺名称是允许的', typeof blank9.id === 'number', JSON.stringify(blank9));
  await raw(`/api/items/${blank9.id}`, 'DELETE');
  check('未知字段类型 → 400', await codeOf('/api/fields', 'POST', { tbl: 'subs', name: 'x', ftype: 'bogus' }) === 400);
  check('未知建库模板 → 400', await codeOf('/api/collections', 'POST', { name: 'x', template: 'bogus' }) === 400);
  check('改不存在的列 → 404', await codeOf('/api/fields/999999', 'PUT', { name: 'x', shown: true }) === 404);
  check('删不可删的列 → 404', await codeOf(`/api/fields/${nameF.id}`, 'DELETE') === 404);
  check('错误体仍带可读 error 字段',
    typeof (await (await raw('/api/items/999999', 'PATCH', { name: 'x' })).json()).error === 'string');

  for (const x of [pr.id, gp.id]) await fetch(`${APP}api/items/${x}`, { method: 'DELETE' });

  /* 17.11. 库的 key 曾经是 'k'||rowid 派生的，而 SQLite 不带 AUTOINCREMENT 会复用删掉的
     id；删库按设计保留台账（那张表存的是 kind 字符串，不跟外键走），于是新建的库会捡到
     旧库的 kind——一个从没付过钱的新库，台账里凭空多出别人的付款记录。实测复现过。 */
  const kruA = await post('/api/collections', { name: '键复用甲', template: 'domain' });
  const kruItem = await post(`/api/collections/${kruA.key}/items`, {
    name: 'reuse.example', status: 'Active', price: 12, currency: 'USD',
    cycle: 'annual', next_renewal: '2026-12-01',
  });
  await post(`/api/items/${kruItem.id}/renew`, {});
  await fetch(`${APP}api/collections/${kruA.id}`, { method: 'DELETE' });
  const kruB = await post('/api/collections', { name: '键复用乙', template: 'blank' });
  check('删库后新建的库不复用旧 key', kruB.key !== kruA.key, `${kruA.key} → ${kruB.key}`);
  const kruLedger = await (await fetch(APP + 'api/ledger')).json();
  check('旧账没有被认到新库头上',
    kruLedger.every(r => r.kind !== kruB.key),
    JSON.stringify(kruLedger.filter(r => r.kind === kruB.key)));
  // 库删了旧账仍留着当存档，而且名字还在——那是写入时钉进台账的快照（迁移 0018 起），
  // 不再靠回查当前的库与条目：回查的话，库一删这笔账就只剩个编号
  check('旧账仍留着当存档，库名与条目名都还说得出',
    kruLedger.some(r => r.kind === kruA.key && r.coll_name === kruA.name && r.item_name === 'reuse.example'),
    JSON.stringify(kruLedger.map(r => [r.kind, r.coll_name, r.item_name])));
  await fetch(`${APP}api/collections/${kruB.id}`, { method: 'DELETE' });

  /* 17.30. 条目更新是局部更新（PATCH）：出现的键写入（"" 与 null 即清空）、缺席的键
     保持原值、extra 整体替换。全量替换时代"漏一键=清一列"的事故一族由此封口。 */
  const pa_item = await mk('subs', {
    name: 'PATCH 语义', status: 'Active', price: 12.5, currency: 'USD', cycle: 'monthly',
    next_renewal: day(20), url: 'https://example.com', notes: '备注原样',
    extra: { category: 'AI', payment_method: 'Visa' },
  });
  const pa_get = async () => (await (await fetch(APP + 'api/collections/subs/items')).json())
    .find(r => r.id === pa_item.id);
  const pa_before = await pa_get();
  check('PATCH 只发一个键：其余真列原样', (await patch(`/api/items/${pa_item.id}`, { name: '改过名' })).ok);
  const pa_after = await pa_get();
  check('缺席的键保持原值（价格/币种/周期/到期日/网址/备注）',
    pa_after.name === '改过名' && pa_after.price === 12.5 && pa_after.currency === 'USD'
    && pa_after.cycle === 'monthly' && pa_after.next_renewal === pa_before.next_renewal
    && pa_after.url === pa_before.url && pa_after.notes === '备注原样',
    JSON.stringify(pa_after));
  check('extra 缺席时整份保持',
    JSON.stringify(pa_after.extra) === JSON.stringify(pa_before.extra), JSON.stringify(pa_after.extra));
  // 清空要显式说出来：null 与空串都算"清空"，而键缺席一律是"别动它"
  await patch(`/api/items/${pa_item.id}`, { price: null, next_renewal: '' });
  const pa_cleared = await pa_get();
  check('显式 null 清空金额，空串清空日期',
    pa_cleared.price === null && pa_cleared.next_renewal === null, JSON.stringify(pa_cleared));
  check('清这两项没有连累币种与周期',
    pa_cleared.currency === 'USD' && pa_cleared.cycle === 'monthly', JSON.stringify(pa_cleared));
  // extra 是整体值：出现即整份替换（少写的键就是要删掉的键）
  await patch(`/api/items/${pa_item.id}`, { extra: { category: 'AI' } });
  const pa_ex = await pa_get();
  check('extra 出现即整份替换',
    pa_ex.extra.category === 'AI' && pa_ex.extra.payment_method === undefined, JSON.stringify(pa_ex.extra));
  // 历史事故的形状：SIM 的周期不是注册字段，表单里根本没有这一栏
  const pa_sim = (await (await fetch(APP + 'api/collections/sims/items')).json())[0];
  await patch(`/api/items/${pa_sim.id}`, { name: pa_sim.name });
  const pa_sim2 = (await (await fetch(APP + 'api/collections/sims/items')).json()).find(r => r.id === pa_sim.id);
  check('表单里没有的真列（SIM 的周期）不会被一次保存清掉',
    pa_sim2.cycle === pa_sim.cycle && pa_sim2.cycle_days === pa_sim.cycle_days,
    `${pa_sim2.cycle}/${pa_sim2.cycle_days}`);
  // 协议真的换了：旧的整行 PUT 不再受理（405），免得有人照旧发全量体却以为是局部更新
  check('条目的 PUT 已不受理（405）', (await raw(`/api/items/${pa_item.id}`, 'PUT', { name: 'x' })).status === 405);
  await fetch(`${APP}api/items/${pa_item.id}`, { method: 'DELETE' });

  /* 17.31. 本轮修的几处，各补一条落在缺陷真会发作的那一刻的断言。 */

  // ① 台账要能自证。items.id 没带 AUTOINCREMENT，删掉最后一条再新建就会捡回同一个号，
  //    而台账从前是按 (kind, item_id) 回查当前条目名的——旧账于是改口叫了新条目的名字。
  const nx_coll = (await (await fetch(APP + 'api/collections')).json()).find(c => c.key === 'subs');
  const nx_item = await mk('subs', {
    name: '台账身份', status: 'Active', cycle: 'monthly', next_renewal: day(5), price: 9, currency: 'USD',
  });
  await post(`/api/items/${nx_item.id}/renew`, {});
  const nx_ledger = async () => (await (await fetch(APP + 'api/ledger')).json())
    .filter(l => l.item_id === nx_item.id && l.kind === 'subs');
  const nx_l1 = await nx_ledger();
  check('续费时把条目名与库名钉进了台账',
    nx_l1[0]?.item_name === '台账身份' && nx_l1[0]?.coll_name === nx_coll.name,
    JSON.stringify(nx_l1[0]));
  await fetch(`${APP}api/items/${nx_item.id}`, { method: 'DELETE' });
  check('条目删掉之后，那笔账仍然说得出是谁', (await nx_ledger())[0]?.item_name === '台账身份');
  const nx_new = await mk('subs', { name: '后来的条目', status: 'Active' });
  check('新条目确实捡到了同一个 id（这正是问题的前提）', nx_new.id === nx_item.id, `${nx_item.id} → ${nx_new.id}`);
  check('旧账没有跟着改口叫新条目的名字', (await nx_ledger())[0]?.item_name === '台账身份');

  // ② 同一秒里传第二张图标：文件名带的是秒级时间戳，新旧同名，
  //    从前是写完新文件转头把它当"旧文件"删了——库里记着名字，图标 404
  const nx_png = tail => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(tail).fill(0x41)]);
  const nx_up = body => fetch(`${APP}api/items/${nx_new.id}/logo?ext=png`, { method: 'POST', body }).then(r => r.json());
  await sleep(1050 - (Date.now() % 1000)); // 从一秒的开头起跑，保证两次落在同一秒里
  const nx_u1 = await nx_up(nx_png(8));
  const nx_u2 = await nx_up(nx_png(24));
  check('两次上传确实同名（同一秒）', nx_u1.logo === nx_u2.logo, `${nx_u1.logo} / ${nx_u2.logo}`);
  const nx_logoResp = await fetch(`${APP}logos/${nx_u2.logo}`);
  check('同秒重传之后图标还在，且是后传的那张',
    nx_logoResp.status === 200 && (await nx_logoResp.arrayBuffer()).byteLength === 32,
    `HTTP ${nx_logoResp.status}`);


  /* 17.33. 写入口的日期与币种校验；库设置只留齿轮。 */
  // 界面挡得住（原生 date 控件 / 币种下拉），接口挡不住——而写坏的后果都不出声：
  // 坏日期让条目掉出到期时间线，坏币种让那笔钱永远不进支出统计
  const vRow = (await (await fetch(`${APP}api/collections/subs/items`)).json())[0];
  check('接口写不进坏日期', (await raw(`/api/items/${vRow.id}`, 'PATCH', { next_renewal: '明天' })).status === 400);
  check('接口写不进坏币种', (await raw(`/api/items/${vRow.id}`, 'PATCH', { currency: '这不是ISO码' })).status === 400);
  check('认得出的松散日期补齐成标准形状，不是拒掉', await (async () => {
    await patch(`/api/items/${vRow.id}`, { next_renewal: '2026-9-5' });
    const r = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(x => x.id === vRow.id);
    await patch(`/api/items/${vRow.id}`, { next_renewal: vRow.next_renewal });
    return r.next_renewal;
  })() === '2026-09-05');
  check('币种统一存大写，四位的也进得来', await (async () => {
    await patch(`/api/items/${vRow.id}`, { currency: 'usdt' });
    const r = (await (await fetch(`${APP}api/collections/subs/items`)).json()).find(x => x.id === vRow.id);
    await patch(`/api/items/${vRow.id}`, { currency: vRow.currency });
    return r.currency;
  })() === 'USDT');

  /* 17.35. 写入口的类型契约：出现的键必须是它该有的类型。取值函数读不出来就当缺席，
     「出现即写入」的协议下那是一次静默清空——价格传成字符串，响应 200，价格却成 NULL。
     logo/cover 另有归属防线：文件名由服务端生成、删条目按行内名字删文件，
     放开通用写入就能把 A 的文件名写进 B、删 B 连 A 的图一起删。 */
  const tv_item = await mk('subs', { name: '类型契约', status: 'Active', price: 12.5, currency: 'USD', extra: { note: '甲' } });
  check('PATCH price 传字符串 → 400', (await raw(`/api/items/${tv_item.id}`, 'PATCH', { price: '不是数字' })).status === 400);
  check('PATCH extra 传数组 → 400', (await raw(`/api/items/${tv_item.id}`, 'PATCH', { extra: ['不是对象'] })).status === 400);
  check('PATCH name 传数字 → 400', (await raw(`/api/items/${tv_item.id}`, 'PATCH', { name: 123 })).status === 400);
  const tv_after = (await (await fetch(APP + 'api/collections/subs/items')).json()).find(x => x.id === tv_item.id);
  check('被拒的请求一字未动', tv_after.price === 12.5 && tv_after.extra?.note === '甲' && tv_after.name === '类型契约',
    JSON.stringify([tv_after.price, tv_after.extra, tv_after.name]));
  check('PATCH 带非空 logo → 400', (await raw(`/api/items/${tv_item.id}`, 'PATCH', { logo: 'item-1-1.png' })).status === 400);
  check('整行回读的 logo:null 不挡道', (await raw(`/api/items/${tv_item.id}`, 'PATCH', { logo: null, notes: '行' })).ok);
  await fetch(`${APP}api/items/${tv_item.id}`, { method: 'DELETE' });


  /* 17.36. 渠道密钥不得进错误链：Telegram 的网址带着 bot token，而错误链会进 500
     响应体与 warn 日志——粘错误信息去 issue 的人不该顺手把 token 也贴出去。
     代理指到不可达端口让发送立刻失败，断言错误文本里没有金丝雀 token。 */
  const NT_CANARY = 'CANARYTOKEN1234567890';
  await put('/api/settings', {
    'notify.telegram': JSON.stringify({ enabled: true, bot_token: NT_CANARY, chat_id: '1', proxy: 'http://127.0.0.1:9' }),
  });
  const nt_resp = await raw('/api/notify/test', 'POST', { channel: 'telegram' });
  const nt_body = await nt_resp.text();
  check('发送失败是 500（配置在、网络不通不是客户端的锅）', nt_resp.status === 500, String(nt_resp.status));
  check('错误响应里没有 bot token', !nt_body.includes(NT_CANARY), nt_body.slice(0, 160));


  /* 17.36b. 渠道密钥不回读明文：GET 是占位串；占位串写回=保持（notify/test 走到发送层
     报 500 说明 token 还在——「未配置」才是 400）；发空串=真清掉。 */
  const maskedSt = await (await fetch(APP + 'api/settings')).json();
  check('设置回读不含 bot token', !JSON.stringify(maskedSt).includes(NT_CANARY));
  const maskedTg = JSON.parse(maskedSt['notify.telegram']);
  check('token 字段是占位串', maskedTg.bot_token === '••••••••', maskedTg.bot_token);
  await put('/api/settings', { 'notify.telegram': JSON.stringify(maskedTg) }); // 表单原样存回
  check('占位串写回后配置仍完整（发送层 500 而非 400）',
    (await raw('/api/notify/test', 'POST', { channel: 'telegram' })).status === 500);
  await put('/api/settings', {
    'notify.telegram': JSON.stringify({ enabled: true, bot_token: '', chat_id: '1', proxy: 'http://127.0.0.1:9' }),
  });
  check('发空串把密钥真清掉（回到未配置 400）',
    (await raw('/api/notify/test', 'POST', { channel: 'telegram' })).status === 400);
  await put('/api/settings', {
    'notify.telegram': JSON.stringify({ enabled: false, bot_token: '', chat_id: '', proxy: '' }),
  });


}
