// Kalends 前端端到端验证：headless chromium + CDP，零第三方依赖。
//
// 用法：
//   1. 起一次性实例：KALENDS_DATA=$(mktemp -d) KALENDS_ADDR=127.0.0.1:4181 ./kalends（或 cargo run）
//   2. node scripts/e2e-ui.mjs
// 空库会自动播种假数据；断言里的天数按播种日推算，所以数据目录务必用一次性的，
// 复用旧库会因日期漂移出现失败。截图与浏览器 profile 落在系统临时目录（见输出）。
//
// 浏览器：默认在 Playwright 缓存里找 chromium headless shell
//（npx playwright install chromium --with-shell 可得），或 KALENDS_E2E_CHROME 指定二进制。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, globSync } from 'node:fs';
import os from 'node:os';

const APP = process.env.KALENDS_E2E_URL || 'http://127.0.0.1:4181/';
const OUT = process.env.KALENDS_E2E_OUT || os.tmpdir() + '/kalends-e2e';
const PORT = 9333;
const SHELL = process.env.KALENDS_E2E_CHROME || globSync(
  os.homedir() + '/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell'
).sort().pop();
if (!SHELL) {
  console.error('未找到 headless chromium：请 npx playwright install chromium --with-shell，或设 KALENDS_E2E_CHROME');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
rmSync(OUT + '/profile', { recursive: true, force: true });

/* ── 播种（仅当订阅表为空） ── */
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const post = (path, body) => fetch(APP.replace(/\/$/, '') + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());
const put = (path, body) => fetch(APP.replace(/\/$/, '') + path, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
// 条目（库与媒体）的更新是 PATCH：局部更新语义，缺席即保持。列/库的整份序仍是 PUT
const patch = (path, body) => fetch(APP.replace(/\/$/, '') + path, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
// 拿原始 Response（要断言「被拒绝」时用，post/put 会把错误体也当成正常结果）
const raw = (path, method, body) => fetch(APP.replace(/\/$/, '') + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const subs0 = await fetch(APP + 'api/collections/subs/items').then(r => r.json()).catch(() => null);
if (!subs0) { console.error('服务未启动？先起 Kalends 实例再跑本脚本'); process.exit(2); }
const mk = (key, body) => post(`/api/collections/${key}/items`, body);
if (subs0.length === 0) {
  console.log('空库，播种假数据…');
  await mk('subs', { name: 'Netflix', status: 'Active', price: 15.49, currency: 'USD', cycle: 'monthly', next_renewal: day(3), extra: { category: 'Streaming', payment_method: 'Visa' } });
  await mk('subs', { name: 'ChatGPT Plus', status: 'Active', price: 20, currency: 'USD', cycle: 'monthly', next_renewal: day(45), extra: { category: 'AI', payment_method: 'Master' } });
  await mk('subs', { name: 'iCloud+', status: 'Active', price: 6, currency: 'CNY', cycle: 'monthly', next_renewal: day(10), extra: { category: 'CloudSvc', payment_method: '支付宝' } });
  const mj = await mk('subs', { name: 'Midjourney', status: 'Deferred', extra: { category: 'AI' } });
  await mk('subs', { name: 'Basic Plan', status: 'Active', price: 96, currency: 'USD', cycle: 'annual', next_renewal: day(200), parent_id: mj.id, extra: { category: 'AI', payment_method: 'Visa' } });
  await mk('subs', { name: '旧订阅', status: 'Ended', extra: { category: 'News' } });
  await mk('sims', { name: '🇬🇧 Giffgaff', status: 'Active', cycle: 'days', cycle_days: 181, last_renewed: day(-175), extra: { forms: ['SIM'], keepalive_action: '发一条短信' } });
  await mk('sims', { name: '🇺🇸 Ultra', status: 'Active', cycle: 'days', cycle_days: 90, last_renewed: day(-10), extra: { forms: ['eSIM', 'VOIP'], keepalive_action: '充值 $5' } });
  await mk('vps', { name: 'HostA', status: 'Active', price: 25, currency: 'USD', cycle: 'annual', last_renewed: day(-334), extra: { product: 'VPS-1', purpose: '代理出口', locations: ['东京'], routes: ['CN2 GIA'], cores: 1, ram_gb: 1, storage_gb: 20, storage_type: 'SSD' } });
  await mk('vps', { name: 'HostB', status: 'Ending', price: 48, currency: 'USD', cycle: 'annual', last_renewed: day(-304), extra: { purpose: '建站', locations: ['洛杉矶'], routes: ['9929'], cores: 2, ram_gb: 4, storage_gb: 60 } });
  await mk('vps', { name: 'HostC', status: 'Active', price: 320, currency: 'CNY', cycle: 'triennial', last_renewed: day(-60), extra: { purpose: '任务', locations: ['香港', '东京'], routes: ['CMI'], cores: 4, ram_gb: 8, storage_gb: 100 } });
  // 评分是 10 分制（迁移 0019 起）
  await post('/api/media', { kind: '电影', title: '测试电影甲', year: 2019, rating: 8, douban_rating: 8.4, status: '看过', marked_at: '2026-06-01' });
  await post('/api/media', { kind: '剧集', title: '测试剧集乙', year: 2023, rating: 10, douban_rating: 9.1, status: '在看', marked_at: '2026-07-10' });
  await post('/api/media', { kind: '游戏', title: '测试游戏丙', year: 2021, rating: 6, status: '想看', marked_at: '2026-05-20', platform: 'Steam' });
} else {
  console.log('警告：复用已有数据，断言可能因日期漂移或数据差异失败');
}
await fetch(APP + 'api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 'ui.upcoming_days': '30' }),
});

/* ── 起浏览器、接 CDP ── */
const chrome = spawn(SHELL, [
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${OUT}/profile`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
const sleep = ms => new Promise(r => setTimeout(r, ms));

let targetInfo;
for (let i = 0; i < 50 && !targetInfo; i++) {
  await sleep(200);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' });
    targetInfo = await r.json();
  } catch {}
}
const ws = new WebSocket(targetInfo.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleMsgs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    consoleMsgs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Runtime.exceptionThrown')
    consoleMsgs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Page.javascriptDialogOpening')
    ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
};
const send = (method, params = {}) => new Promise(res => { pending.set(++msgId, res); ws.send(JSON.stringify({ id: msgId, method, params })); });
const evl = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot:', name);
};
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};
// 点表头 → 菜单 → 点条目
const menuClick = async (thSel, itemText) => {
  await evl(`document.querySelector('${thSel}').click()`);
  await sleep(200);
  const okItem = await evl(`(() => {
    const b = [...document.querySelectorAll('.thmenu .mi')].find(x => x.textContent.includes('${itemText}'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(200);
  return okItem;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
for (let i = 0; i < 50; i++) {
  await sleep(200);
  if (await evl(`document.querySelectorAll('#up-list li').length`) > 0) break;
}

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

/* 4. Notion 式视觉基础 + 状态收进列 */
check('订阅表彩色标签', await evl(`document.querySelectorAll('#subs-body .tag').length`) > 0);
check('标签 4px 圆角', await evl(`getComputedStyle(document.querySelector('#subs-body .tag')).borderRadius`) === '4px');
check('表头属性图标', await evl(`document.querySelectorAll('#view-subs th .ticon').length`) >= 6);
check('纵向格线存在', await evl(`getComputedStyle(document.querySelector('#subs-body tr td')).borderRightWidth`) === '1px');
check('表头常规字重', await evl(`getComputedStyle(document.querySelector('#view-subs th')).fontWeight`) === '500');
check('状态胶囊行已移除', await evl(`!document.querySelector('#chips')`) === true);
check('订阅状态列存在', await evl(`!!document.querySelector('#view-subs th[data-k="status"]')`) === true);
check('订阅默认显示全部 6 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 6);
check('状态胶囊按语义定色', await evl(`document.querySelectorAll('#subs-body .st.on').length`) === 4
  && await evl(`document.querySelectorAll('#subs-body .st.cmp').length`) === 1);
check('VPS 状态列存在', await evl(`!!document.querySelector('#view-vps th[data-k="status"]')`) === true);
check('＋新建行存在', await evl(`document.querySelectorAll('.newrow').length`) === 4);

/* 4b. 订阅子行树 + 行悬停打开 */
check('编辑按钮已移除', await evl(`!document.querySelector('#subs-body [data-edit]')`) === true);
check('行悬停打开按钮存在', await evl(`document.querySelectorAll('#subs-body .rowopen').length`) === 6);
await evl(`document.querySelector('#subs-body tr .rowopen').click()`);
await sleep(300);
check('⤢ 打开全表单', await evl(`document.querySelector('#dlg-item').open`) === true);
await evl(`document.querySelector('#dlg-item').close()`);
check('父行有折叠钮', await evl(`(() => {
  const tr = [...document.querySelectorAll('#subs-body tr')].find(r => r.textContent.includes('Midjourney') && !r.classList.contains('subrow'));
  return !!tr?.querySelector('.tgl');
})()`) === true);
check('子行缩进且紧随父行', await evl(`(() => {
  const rows = [...document.querySelectorAll('#subs-body tr')];
  const p = rows.findIndex(r => r.textContent.includes('Midjourney') && !r.classList.contains('subrow'));
  return p >= 0 && rows[p + 1]?.classList.contains('subrow') && rows[p + 1].textContent.includes('Basic');
})()`) === true);
await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.querySelector('.tgl')).querySelector('.tgl').click()`);
await sleep(250);
check('折叠后子行隐藏', await evl(`document.querySelectorAll('#subs-body tr').length`) === 5
  && await evl(`!document.querySelector('#subs-body tr.subrow')`) === true);
check('折叠状态持久化', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).subs.collapsed.length`) === 1);
await evl(`[...document.querySelectorAll('#subs-body tr')].find(r => r.querySelector('.tgl')).querySelector('.tgl').click()`);
await sleep(250);
check('展开恢复 6 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 6);

/* 5. 表头菜单排序 */
await evl(`document.querySelector('#view-subs th[data-k="price"]').click()`);
await sleep(250);
check('点表头出菜单', await evl(`!!document.querySelector('.thmenu')`) === true);
check('菜单含列名标题', (await evl(`document.querySelector('.thmenu .tm-title')?.textContent`) || '') === '价格');
await shot('12-headmenu');
await evl(`[...document.querySelectorAll('.thmenu .mi')].find(x => x.textContent.includes('升序')).click()`);
await sleep(250);
const firstName = () => evl(`document.querySelector('#subs-body tr td:not([style*="display: none"])')?.textContent.trim()`);
check('升序后首行 iCloud', (await firstName()).startsWith('iCloud'), await firstName());
check('升序箭头', await evl(`document.querySelector('#view-subs th[data-k="price"] .sind').textContent`) === '▲');
check('排序胶囊出现', await evl(`[...document.querySelectorAll('#view-pills .vpill.p-sort')].length`) === 1);
check('排序胶囊用列名（价格而非币种）', (await evl(`document.querySelector('#view-pills .p-sort').textContent`)).includes('价格'));
check('菜单勾选当前方向', await menuClick('#view-subs th[data-k="price"]', '降序'));
check('降序后首行 ChatGPT（子行随父）', (await firstName()).includes('ChatGPT'), await firstName());
await evl(`document.querySelector('#view-pills .p-sort .vl').click()`);
await sleep(200);
check('胶囊点击翻转为升序', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).subs.sort?.dir`) === 1);
await evl(`document.querySelector('#view-pills .p-sort .x').click()`);
await sleep(200);
check('胶囊 × 清除排序', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).subs.sort`) === null);
// 周期列按周期长短排，不是显示文案的字母序（那样 Annual 会排在 Monthly 前面，读者无从理解）
check('周期列取的排序值是周期长短', await evl(`(() => {
  const v = COLS.subs.cycle.val;
  return [v({ cycle: 'monthly' }), v({ cycle: 'annual' }), v({ cycle: 'days', cycle_days: 181 }), v({ cycle: null })].join(',');
})()`) === '30,365,181,');
check('周期列按数值比较而不是中文串', await evl(`COLS.subs.cycle.str`) === 0);

/* 6. 列筛选（菜单直达，全列可筛）+ 筛选胶囊 */
check('菜单进入筛选', await menuClick('#view-subs th[data-k="category"]', '筛选'));
check('筛选浮层出现', await evl(`!!document.querySelector('.filterpop')`) === true);
await evl(`[...document.querySelectorAll('.filterpop input')].find(i => i.value === 'AI').click()`);
await sleep(250);
check('分类=AI 3 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 3);
check('筛选胶囊出现', (await evl(`document.querySelector('#view-pills .p-filt')?.textContent`) || '').includes('分类'));
await evl(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
await sleep(150);
check('外点关闭浮层', await evl(`!!document.querySelector('.filterpop')`) === false);
await shot('05-filtered');
await evl(`document.querySelector('#view-pills .p-filt .x').click()`);
await sleep(200);
check('筛选胶囊 × 恢复 6 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 6);

/* 6b. 状态列筛选（status 型勾选列表） */
check('状态列菜单筛选', await menuClick('#view-subs th[data-k="status"]', '筛选'));
check('浮层渲染状态胶囊', await evl(`document.querySelectorAll('.filterpop .st').length`) >= 3);
await evl(`[...document.querySelectorAll('.filterpop input')].find(i => i.value === 'Active').click()`);
await sleep(250);
check('状态=Active 4 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 4);
await evl(`document.querySelector('#view-pills .p-filt .x').click()`);
await sleep(200);

/* 6c. 数字列筛选（操作符型） */
check('价格列菜单筛选', await menuClick('#view-subs th[data-k="price"]', '筛选'));
check('操作符表单出现', await evl(`!!document.querySelector('.filterpop .fp-form')`) === true);
await evl(`(() => {
  const s = document.querySelector('.fp-form .fp-op'); s.value = 'ge'; s.dispatchEvent(new Event('change'));
  const i = document.querySelector('.fp-form .fp-q'); i.value = '15'; i.dispatchEvent(new Event('input'));
})()`);
await sleep(250);
check('价格 ≥ 15 共 3 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 3);
check('数字筛选胶囊文案', (await evl(`document.querySelector('#view-pills .p-filt')?.textContent`) || '').includes('≥'));
await evl(`document.querySelector('#view-pills .p-filt .x').click()`);
await sleep(200);
check('清除数字筛选恢复 6 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 6);

/* 7. 表内搜索 */
await evl(`(() => { const i = document.querySelector('#t-search'); i.value = 'chatgpt'; i.dispatchEvent(new Event('input')); })()`);
await sleep(400);
check('搜索后 1 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 1);
await evl(`(() => { const i = document.querySelector('#t-search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
await sleep(400);
check('清空搜索恢复 6 行', await evl(`document.querySelectorAll('#subs-body tr').length`) === 6);

/* 8. 隐藏列与恢复（备注列 oi=8） */
check('菜单隐藏备注列', await menuClick('#view-subs th[data-k="notes"]', '隐藏此列'));
check('备注列已隐藏', await evl(`document.querySelector('#view-subs th[data-k="notes"]').style.display`) === 'none');
check('数据行同步隐藏', await evl(`document.querySelector('#subs-body tr').querySelectorAll('td[style*="display: none"]').length`) === 1);
check('隐藏胶囊出现', (await evl(`document.querySelector('#view-pills .p-hid')?.textContent`) || '').includes('1 列'));
await shot('13-hidden-col');
await evl(`document.querySelector('#view-pills .p-hid').click()`);
await sleep(200);
check('恢复隐藏列', await evl(`document.querySelector('#view-subs th[data-k="notes"]').style.display`) === '');

/* 8b. 字段类型：菜单类型行 + 可切换列的类型转换 */
await evl(`document.querySelector('#view-subs th[data-k="price"]').click()`);
await sleep(200);
check('价格列类型=数字', (await evl(`document.querySelector('.thmenu')?.textContent`) || '').includes('类型 · 数字'));
check('固定类型列不可切换', await evl(`!!document.querySelector('.thmenu .mi:disabled')`) === true);
await evl(`document.querySelector('#view-subs th[data-k="price"]').click()`); // 再点关闭
await sleep(150);
const tagsBefore = await evl(`document.querySelectorAll('#subs-body .tag').length`);
check('打开类型子菜单', await menuClick('#view-subs th[data-k="category"]', '类型'));
await evl(`[...document.querySelectorAll('.thmenu .mi')].find(x => x.textContent.includes('文本')).click()`);
await sleep(250);
check('切文本后标签变少', await evl(`document.querySelectorAll('#subs-body .tag').length`) < tagsBefore);
check('类型覆写持久化', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).subs.types?.category`) === 'text');
check('再开类型子菜单', await menuClick('#view-subs th[data-k="category"]', '类型'));
await evl(`[...document.querySelectorAll('.thmenu .mi')].find(x => x.textContent.includes('单选')).click()`);
await sleep(250);
check('切回单选清除覆写', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).subs.types?.category`) === undefined);
check('标签数恢复', await evl(`document.querySelectorAll('#subs-body .tag').length`) === tagsBefore);

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

/* 9b. 窄窗自动装容器：无手动列宽时表格等比压缩，右边框不越界，窗口变宽自动还原 */
await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 1000, deviceScaleFactor: 2, mobile: false });
await sleep(600);
check('窄窗压缩进容器不越界', await evl(`(() => {
  const wrap = document.querySelector('#view-subs');
  const last = [...wrap.querySelectorAll('th')].pop();
  return wrap.scrollWidth <= wrap.clientWidth + 2
    && last.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 2;
})()`) === true);
check('窄窗压缩走 fixed 布局', await evl(`document.querySelector('#view-subs table').classList.contains('fixed')`) === true);
check('压缩宽度不落存储', await evl(`Object.keys(JSON.parse(localStorage.getItem('kalends.views.v1')).subs.widths).length`) === 0);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
await sleep(600);
check('宽窗恢复自然布局', await evl(`document.querySelector('#view-subs table').classList.contains('fixed')`) === false);

/* 9c. 浮层是 fixed 的：贴着视口底部打开时必须翻到锚点上方，否则永远够不着 */
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 520, deviceScaleFactor: 2, mobile: false });
await sleep(500);
const popFit = await evl(`(async () => {
  const trs = [...document.querySelectorAll('#subs-body tr')];
  const td = trs[trs.length - 1].querySelector('td[data-k="name"]');
  td.scrollIntoView({ block: 'end' });
  await new Promise(r => setTimeout(r, 400));
  td.click();
  await new Promise(r => setTimeout(r, 350));
  const pop = document.querySelector('.cellpop');
  if (!pop) return { no: 1 };
  const r = pop.getBoundingClientRect();
  const anchor = td.getBoundingClientRect();
  closePop();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, above: r.bottom <= anchor.top + 1 };
})()`);
check('底部单元格的浮层不越出视口', !popFit.no && popFit.bottom <= popFit.h && popFit.top >= 0, JSON.stringify(popFit));
check('放不下时翻到锚点上方', popFit.above === true, JSON.stringify(popFit));
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
await sleep(500);

/* 10. 列宽拖动：右边框硬边界——拖宽先吃空白再压右侧列，拖窄收窄，下限 52px，永不越界 */
const dragW = (dx) => evl(`(() => {
  const h = document.querySelector('#view-subs th[data-k="name"] .rhandle');
  h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 300 }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 + (${dx}) }));
  window.dispatchEvent(new PointerEvent('pointerup', {}));
})()`);
const thWidthSum = () => evl(`[...document.querySelectorAll('#view-subs th')]
  .filter(t => t.style.display !== 'none')
  .reduce((s, t) => s + t.getBoundingClientRect().width, 0)`);
const tableW = () => evl(`document.querySelector('#view-subs table').getBoundingClientRect().width`);
const wBefore = await evl(`Math.round(document.querySelector('#view-subs th[data-k="name"]').getBoundingClientRect().width)`);
await dragW(60);
await sleep(150);
check('拖后 fixed 布局', await evl(`document.querySelector('#view-subs table').classList.contains('fixed')`) === true);
const wAfter = await evl(`Math.round(document.querySelector('#view-subs th[data-k="name"]').getBoundingClientRect().width)`);
check('列宽 +60px', Math.abs(wAfter - wBefore - 60) <= 3, `before=${wBefore} after=${wAfter}`);
check('表宽=列宽和', Math.abs(await tableW() - await thWidthSum()) <= 2, `table=${await tableW()} sum=${await thWidthSum()}`);
check('操作列按钮未截断', await evl(`(() => { const td = document.querySelector('#subs-body tr td:last-child'); return td.scrollWidth <= td.clientWidth + 2; })()`) === true);
// 窄拖到底：被拖列钳在 52px，邻列宽不被摊改，整表收窄且不左溢
const statusWBefore = await evl(`Math.round(document.querySelector('#view-subs th[data-k="status"]').getBoundingClientRect().width)`);
await dragW(-5000);
await sleep(150);
check('窄拖钳制 52px', await evl(`Math.round(document.querySelector('#view-subs th[data-k="name"]').getBoundingClientRect().width)`) === 52);
check('邻列宽不受摊派', await evl(`Math.round(document.querySelector('#view-subs th[data-k="status"]').getBoundingClientRect().width)`) === statusWBefore);
check('窄拖后表宽=列宽和', Math.abs(await tableW() - await thWidthSum()) <= 2);
check('窄拖后表格仍贴满容器', Math.abs(await tableW() - await evl(`document.querySelector('#view-subs').clientWidth`)) <= 2);
check('最右列右缘恒贴右边框', await evl(`(() => {
  const wrap = document.querySelector('#view-subs');
  const ths = [...wrap.querySelectorAll('th')].filter(t => t.style.display !== 'none');
  return Math.abs(ths[ths.length - 1].getBoundingClientRect().right - wrap.getBoundingClientRect().right) <= 2;
})()`) === true);
check('无左侧溢出', await evl(`(() => {
  const wrap = document.querySelector('#view-subs');
  const table = wrap.querySelector('table');
  return wrap.scrollLeft === 0 && table.getBoundingClientRect().left >= wrap.getBoundingClientRect().left - 1;
})()`) === true);
// 宽拖到底：先吃空白再压右侧列到 52px，把手停在右边框——不产生任何横向溢出
await dragW(2000);
await sleep(150);
check('宽拖不越右边框', await evl(`(() => {
  const wrap = document.querySelector('#view-subs');
  const last = [...wrap.querySelectorAll('th')].pop();
  return wrap.scrollWidth <= wrap.clientWidth + 2 && wrap.scrollLeft === 0
    && last.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 2;
})()`) === true);
check('宽拖后表格贴满容器', Math.abs(await tableW() - await evl(`document.querySelector('#view-subs').clientWidth`)) <= 2);
check('右侧数据列被压到下限', await evl(`[...document.querySelectorAll('#view-subs th')]
  .filter(t => t.style.display !== 'none' && !t.classList.contains('ops') && t.dataset.k !== 'name')
  .every(t => Math.abs(t.getBoundingClientRect().width - 52) <= 1)`) === true);
// 把手双击整表还原，再拖回 +60 给后面的持久化断言留 fixed 状态
await evl(`document.querySelector('#view-subs th[data-k="name"] .rhandle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await sleep(150);
check('双击还原列宽', await evl(`document.querySelector('#view-subs table').classList.contains('fixed')`) === false
  && await evl(`document.querySelector('#view-subs table').style.width`) === '');
await dragW(60);
await sleep(150);

/* 11. 列序拖动 */
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
check('表头第一列变分类', await evl(`document.querySelector('#view-subs thead th').dataset.k`) === 'category');
check('列序持久化', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).subs.order?.[0]`) === 'category');
await shot('11-reordered');

/* 12. VPS：菜单排序 + 地点筛选 + 文本筛选 */
await evl(`document.querySelector('.tab[data-tab="vps"]').click()`);
await sleep(200);
check('VPS 默认显示全部 3 行', await evl(`document.querySelectorAll('#vps-body tr').length`) === 3);
check('VPS Ending 状态胶囊', await evl(`document.querySelectorAll('#vps-body .st.warn').length`) === 1);
check('VPS 剩余升序', await menuClick('#view-vps th[data-k="left"]', '升序'));
check('VPS 首行 HostA', (await evl(`document.querySelector('#vps-body tr td').textContent.trim()`)).startsWith('HostA'));
check('VPS 地点菜单筛选', await menuClick('#view-vps th[data-k="locations"]', '筛选'));
await evl(`[...document.querySelectorAll('.filterpop input')].find(i => i.value === '东京').click()`);
await sleep(200);
check('地点=东京 2 行', await evl(`document.querySelectorAll('#vps-body tr').length`) === 2);
check('VPS 两个胶囊+清除全部', await evl(`document.querySelectorAll('#view-pills .vpill').length`) === 3);
await shot('06-vps');
await evl(`document.querySelector('#view-pills .p-clear').click()`);
await sleep(200);
check('清除全部生效', await evl(`document.querySelectorAll('#view-pills .vpill').length`) === 0);
check('商家（名称列）文本筛选', await menuClick('#view-vps th[data-k="name"]', '筛选'));
await evl(`(() => { const i = document.querySelector('.fp-form .fp-q'); i.value = 'hosta'; i.dispatchEvent(new Event('input')); })()`);
await sleep(250);
check('包含 hosta 1 行', await evl(`document.querySelectorAll('#vps-body tr').length`) === 1);
await evl(`document.querySelector('#view-pills .p-filt .x').click()`);
await sleep(200);
check('清除文本筛选恢复 3 行', await evl(`document.querySelectorAll('#vps-body tr').length`) === 3);

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

/* 12e-2. 详情表单「打开 → 什么都不改 → 保存」必须是幂等的。
   按字段逐条追加断言（多选、星级…）兜不住这一族，所以这里整行深比对：
   周期曾经在这条路上被写坏——表单初值取的是格子里的显示文案（Monthly），
   保存就把它写回了 items.cycle，存储键丢失，于是周期格变空、支出漏这一条、
   按「上次续费+周期」推日期的库整条掉出到期时间线与 ICS。 */
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

/* 12i-2. 哪些列删得掉：判据是 src='extra'（值挂在行里），不是 builtin。
   预置库播下来的域字段（订阅的分类、VPS 的地点/规格参数）与手加的自定义列同权，都能改名删除；
   引擎真列与算出来的列一项都不给。**shown=0 的列压根没有表头**，表头菜单够不着它们，
   所以库设置的字段面板里那颗 ✕ 是它们唯一的出口——曾经两处都没有，用户一列也删不掉。 */
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
await evl(`loadAll()`);
await sleep(700);
const back = await (await fetch(APP + 'api/collections')).json();
await put('/api/collections/order', { ids: ['subs', 'sims', 'vps'].map(k => back.find(c => c.key === k).id) });
await evl(`loadAll()`);
await sleep(800);
await evl(`switchTab('subs')`);
await sleep(300);

/* 13. 媒体表格 */
await evl(`document.querySelector('.nav-tab[data-page="media"]').click()`);
await sleep(200);
check('海报墙显示类别 chips', await evl(`getComputedStyle(document.querySelector('#m-kind-chips')).display`) !== 'none');
await evl(`document.querySelector('#m-view-toggle').click()`);
await sleep(200);
check('表格视图海报墙隐藏', await evl(`getComputedStyle(document.querySelector('#m-wall')).display`) === 'none');
check('表格视图 chips 隐藏', await evl(`getComputedStyle(document.querySelector('#m-kind-chips')).display`) === 'none'
  && await evl(`getComputedStyle(document.querySelector('#m-status-row')).display`) === 'none');
check('媒体年份降序', await menuClick('#m-tablewrap th[data-k="year"]', '降序'));
check('媒体首行 2023 剧集', (await evl(`document.querySelector('#m-body tr td').textContent.trim()`)).includes('乙'));
check('排序选择器联动', await evl(`document.querySelector('#m-sort').value`) === 'year');
check('媒体排序胶囊', await evl(`!!document.querySelector('#m-view-pills .p-sort')`) === true);
check('媒体菜单清除排序', await menuClick('#m-tablewrap th[data-k="year"]', '清除排序'));
check('回到默认后胶囊消失', await evl(`!!document.querySelector('#m-view-pills .p-sort')`) === false);
check('类别列菜单筛选', await menuClick('#m-tablewrap th[data-k="kind"]', '筛选'));
await evl(`[...document.querySelectorAll('.filterpop input')].find(i => i.value === '剧集').click()`);
await sleep(250);
check('类别=剧集 1 行', await evl(`document.querySelectorAll('#m-body tr').length`) === 1);
await evl(`document.querySelector('#m-view-pills .p-filt .x').click()`);
await sleep(200);
check('清除类别筛选恢复 3 行', await evl(`document.querySelectorAll('#m-body tr').length`) === 3);
// 评分是 10 分制的数字 + 一颗蜂蜜金星（迁移 0019 起）：光一列数字看不出是评分，
// 而 5 颗星又把 10 分制的精度抹掉；数字给精度、星给辨识
const mrate = (await evl(`[...document.querySelectorAll('#m-body tr td[data-k="rating"]')].map(t => t.textContent.trim()).join('|')`));
check('我评列显示成「N ★」', /^\d+ ★/.test(mrate.split('|')[0]) && !mrate.includes('★★'), mrate);
check('评分那颗星用的是蜂蜜金', await evl(
  `getComputedStyle(document.querySelector('#m-body .rstar')).color`) === 'rgb(237, 164, 18)');
check('评分列已是数字列（筛选给操作符而不是勾选清单）', await menuClick('#m-tablewrap th[data-k="rating"]', '筛选')
  && await evl(`(() => {
    const ops = [...document.querySelectorAll('.filterpop .fp-op option')].map(o => o.value).join(',');
    const q = document.querySelector('.filterpop .fp-q');
    return ops.includes('ge') && q?.type === 'number' && !document.querySelector('.filterpop input[type=checkbox]');
  })()`) === true);
await evl(`closePop()`);
check('后端只收 1–10', (await raw('/api/media', 'POST', { title: '越界评分', rating: 11 })).status === 400
  && (await raw('/api/media', 'POST', { title: '满分', rating: 10 })).ok);
await evl(`loadAll()`);
await sleep(600);
await shot('07-media-table');

/* 14. fetch_cover 端点（未配 TMDB Key 的错误路径；游戏拒绝） */
const mediaList = await (await fetch(APP + 'api/media')).json();
const filmT = mediaList.find(m => m.kind !== '游戏');
const fcResp = await fetch(`${APP}api/media/${filmT.id}/fetch_cover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const fcBody = await fcResp.json().catch(() => ({}));
const st2 = await (await fetch(APP + 'api/settings')).json();
if (st2['meta.tmdb_key']) {
  console.log('SKIP 无 Key 报错断言（本实例已配置 TMDB Key）');
} else {
  check('无 Key 报错清晰', !fcResp.ok && String(fcBody.error || '').includes('TMDB API Key'));
  // 服务端侧的问题仍要是 500——别因为给客户端错误分了级就把真故障也一起降级了
  check('未判定为客户端错误的仍返回 500', fcResp.status === 500, String(fcResp.status));
}
const game = mediaList.find(m => m.kind === '游戏');
if (game) {
  const gResp = await fetch(`${APP}api/media/${game.id}/fetch_cover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('游戏类拒绝', !gResp.ok && String((await gResp.json().catch(() => ({}))).error || '').includes('游戏'));
}
check('补海报按钮存在', await evl(`!!document.querySelector('#m-covers')`) === true);

/* 15. 刷新持久化 */
await evl(`document.querySelector('.nav-tab[data-page="renewals"]').click()`);
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
check('刷新后媒体表格视图', await evl(`JSON.parse(localStorage.getItem('kalends.views.v1')).media.view`) === 'table');
await shot('08-reloaded-folded');

/* 16. hidden 属性回归（全局 [hidden]{display:none!important} 不能被 display 规则盖掉，
   历史上媒体海报墙就是这么翻车的；这里用到期栏的「更远期还有 N 项」当探针） */
await evl(`(() => { const s = document.querySelector('#up-window'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
await sleep(500);
check('窗口=全部时「更远期」按 hidden 属性隐藏',
  await evl(`document.querySelector('#up-more').hasAttribute('hidden')`) === true
  && await evl(`getComputedStyle(document.querySelector('#up-more')).display`) === 'none');
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

/* 17. 深色 */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await sleep(400);
await shot('09-dark');

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
await evl(`document.querySelector('#ledger-list').scrollIntoView({ block: 'center' })`);
await sleep(400);
await shot('12-ledger');
await evl(`document.querySelector('#dlg-settings').close()`);
await sleep(250);

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

/* 17.8. 窄屏：压到下限还塞不进容器时，等比压缩只剩坏处——横滚照样免不了，却把每一列
   都挤成省略号（390px 实测：九列全压到 52px，表宽仍有 573px 要滚）。这时该退回自然
   列宽，并把首列吸附在左侧，滚到哪一列都还认得出在看哪一行。 */
await evl(`switchTab('subs')`);
await sleep(200);
// 前面的拖宽段留下了手动列宽，那条路本就不压缩（存宽即下限，最右列吸残差）。
// 这里要验的是没有手动列宽时的自动装容器，先还原到那个状态
await evl(`(() => { views.subs.widths = {}; saveViews(); applyWidths('subs'); })()`);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(700);
await evl(`window.dispatchEvent(new Event('resize'))`);
await sleep(700);
const narrowGeom = await evl(`(() => {
  const wrap = document.querySelector('#view-subs'), table = wrap.querySelector('table');
  const ths = [...table.querySelectorAll('thead th')].filter(t => t.style.display !== 'none');
  const first = wrap.querySelector('#subs-body tr td');
  return {
    container: wrap.clientWidth,
    fixed: table.classList.contains('fixed'),
    dataCols: ths.filter(t => !t.classList.contains('ops')).map(t => Math.round(t.getBoundingClientRect().width)),
    firstPos: first && getComputedStyle(first).position,
    firstLeft: first && getComputedStyle(first).left,
  };
})()`);
check('窄到压不进去时不再等比压缩', narrowGeom.fixed === false, JSON.stringify(narrowGeom));
check('窄屏下没有一列被压到 52px 下限',
  narrowGeom.dataCols.every(w => w > 52), JSON.stringify(narrowGeom.dataCols));
check('首列横滚时吸附在左侧',
  narrowGeom.firstPos === 'sticky' && narrowGeom.firstLeft === '0px',
  `${narrowGeom.firstPos} / ${narrowGeom.firstLeft}`);
// 吸附的格子得有不透明底，否则滚过去的内容会从它身下透出来
check('吸附的首列有不透明底', await evl(`(() => {
  const bg = getComputedStyle(document.querySelector('#subs-body tr td')).backgroundColor;
  return bg !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(bg);
})()`) === true);
await evl(`document.querySelector('#view-subs').scrollIntoView({ block: 'center' })`);
await sleep(400);
await shot('19-narrow-table');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
await sleep(600);

/* 17.9. 名称列不给隐藏：⤢ 详情入口与子行折叠钮都长在这一格里，撤掉它整库就没了全表单
   入口。后端 PUT /api/fields/{id} 早就拒绝把它设成 shown=0，本机视图这条口子是漏的。 */
await evl(`document.querySelector('#view-subs thead th[data-k="name"]').click()`);
await sleep(250);
check('名称列表头菜单里没有「隐藏此列」', await evl(
  `[...document.querySelectorAll('.thmenu .mi')].every(x => !x.textContent.includes('隐藏此列'))`) === true);
await evl(`closePop()`);
await sleep(200);
await evl(`document.querySelector('#view-subs thead th[data-k="notes"]').click()`);
await sleep(250);
check('别的列照样给隐藏（对照）', await evl(
  `[...document.querySelectorAll('.thmenu .mi')].some(x => x.textContent.includes('隐藏此列'))`) === true);
await evl(`closePop()`);
await sleep(200);
// 菜单曾经放行过，已经把 name 存进 hiddenCols 的人光靠列集迁移救不回来（列集没变），
// 所以要无条件捞。走 rebuildHead 这条真实路径：表头按模板序重建 → initHead 结算偏好
await evl(`(() => { views.subs.hiddenCols = ['name']; saveViews(); })()`);
await evl(`rebuildHead('subs')`);
await sleep(900);
check('本机存着的隐藏名称列偏好被捞回来', await evl(
  `!views.subs.hiddenCols.includes('name')
   && document.querySelector('#view-subs thead th[data-k="name"]').style.display !== 'none'`) === true);
const nameCellDiag = await evl(`JSON.stringify({
  hidden: views.subs.hiddenCols,
  headKeys: [...document.querySelectorAll('#view-subs thead th')].map(t => t.dataset.k),
  cellKeys: [...([...document.querySelectorAll('#subs-body tr')][0]?.children || [])].map(td => td.dataset.k),
  rowopenAny: !!document.querySelector('#subs-body tr .rowopen'),
})`);
// 隐藏是 display:none 而不是摘掉节点，所以光问「在不在」测不出来，得问「看得见吗」
check('名称格里的 ⤢ 详情入口还看得见', await evl(`(() => {
  const td = document.querySelector('#subs-body tr td[data-k="name"]');
  return !!td && td.style.display !== 'none' && !!td.querySelector('.rowopen');
})()`) === true, nameCellDiag);

/* 17.10. 详情表单的开放词表（分类/支付方式/注册商…）建库时是空的，而表单的 sel 是个纯
   下拉：空库首装点「＋新建」，这几栏一个候选都没有、也没处输入，只能先存个残缺条目再
   回表格用就地编辑器把值造出来。周期是固定档位词表，不给现场新增——放开了会有人把
   Monthly 这样的文案写回 items.cycle，按周期推日期的库整条掉出到期时间线。 */
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
await evl(`loadAll()`);
await sleep(700);

/* 17.12. 键盘可达性：表头属性菜单是排序/筛选/改列/删列的唯一入口，只挂 click 就等于
   键盘用户全够不着；`.rowopen` 平时 opacity:0，不给 focus 态的话焦点环画在透明元素上。 */
await evl(`switchTab('subs')`);
await sleep(300);
check('表头可聚焦、带弹出菜单语义，且**没有**被 role=button 盖掉列头身份', await evl(`(() => {
  const th = document.querySelector('#view-subs thead th[data-k="name"]');
  // role=button 会盖掉 th 原生的 columnheader，而 aria-sort 只对列头有意义——
  // 盖掉之后"当前按这列升序排着"读屏永远读不出来
  return th.tabIndex === 0 && th.getAttribute('aria-haspopup') === 'menu' && !th.getAttribute('role');
})()`) === true);
check('排序状态挂在列头上（aria-sort）', await evl(`(() => {
  const th = document.querySelector('#view-subs thead th[data-k="name"]');
  return ['ascending', 'descending', 'none'].includes(th.getAttribute('aria-sort'));
})()`) === true);
// 真键盘事件：合成的 KeyboardEvent 走不到浏览器默认行为，也测不出 preventDefault
await evl(`document.querySelector('#view-subs thead th[data-k="status"]').focus()`);
await send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
  windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await send('Input.dispatchKeyEvent', {
  type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await sleep(350);
check('回车能打开表头属性菜单', await evl(`!!document.querySelector('.thmenu')`) === true);
check('菜单里能走到排序项', await evl(
  `[...document.querySelectorAll('.thmenu .mi')].some(x => x.textContent.includes('升序排序'))`) === true);
await evl(`closePop()`);
await sleep(200);
check('⤢ 入口有 focus 态才不至于隐形', await evl(`(() => {
  const has = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
    .some(r => r.selectorText && r.selectorText.includes('.rowopen:focus-visible'));
  return has;
})()`) === true);
check('表尾「＋ 新建」也能用键盘走到', await evl(`(() => {
  const nr = document.querySelector('#view-subs .newrow');
  return nr.tabIndex === 0 && nr.getAttribute('role') === 'button';
})()`) === true);

/* 17.13. TMDB 搜索缩略图此前直连 image.tmdb.org：绕开 meta.proxy（被墙环境配了代理
   也全是空图），且是浏览器直连第三方的唯一出口。改成经服务端转发，路径要校验。 */
check('缩略图不再直连 image.tmdb.org',
  !(await (await fetch(APP + 'app.js')).text()).includes('image.tmdb.org'));
const thumbBad = await fetch(APP + 'api/tmdb/thumb?path=' + encodeURIComponent('/../../etc/passwd'));
check('转发端点拦下不合法路径', thumbBad.status === 400, String(thumbBad.status));
// 路径不合法＝请求本身的问题＝400；未配 Key 是配置故障，与 fetch_cover 一致保持 500
// （第 14 段那条注释是同一个决定：别因为分了级就把真故障也降级）
const thumbNoKey = await fetch(APP + 'api/tmdb/thumb?path=' + encodeURIComponent('/abc123.jpg'));
const thumbNoKeyBody = await thumbNoKey.json().catch(() => ({}));
if ((await (await fetch(APP + 'api/settings')).json())['meta.tmdb_key']) {
  console.log('SKIP 缩略图无 Key 断言（本实例已配置 TMDB Key）');
} else {
  check('未配 Key 时缩略图仍是 500 且报错清晰',
    thumbNoKey.status === 500 && String(thumbNoKeyBody.error || '').includes('TMDB API Key'),
    `${thumbNoKey.status} ${JSON.stringify(thumbNoKeyBody)}`);
}

/* 17.14. 媒体的自定义列此前只有表格里点格能改，海报墙用户等于没有入口；更要命的是
   媒体表单的提交体压根不带 extra，而后端 `values_of` 恒写 extra——用详情表单存一次
   就把自定义列的值全清了（实测坐实过）。 */
// 加列走的是接口而不是界面：等同于「别处（另一台设备/另一个标签页）加了列」。
// 媒体的 COLS 此前只在 boot 与 rebuildHead 各注入一次，而 loadAll 每次都刷字段注册表，
// 于是这边会拿着旧 COLS 去渲染新字段，colType 读到 undefined 把整个 renderAll 打断。
const mfield = await post('/api/fields', { tbl: 'media', name: '片源', ftype: 'text' });
const mrow = (await (await fetch(APP + 'api/media')).json())[0];
await patch(`/api/media/${mrow.id}`, { ...mrow, extra: { [mfield.key]: 'BD 原盘' } });
// 得等 loadAll 自己结算再问它成没成：它抛的是异步异常，同步去查 DOM 只会看到上一轮
// 渲染留下的行，两版都「通过」。**而且值必须先落到某一行上**——cellVal 对空值提前返回，
// 列刚建好、还没有任何行有值时根本走不到 colType，那一刻同样测不出东西（两条都真踩过）。
check('别处加了媒体列，这边 loadAll 不崩', await evl(
  `loadAll().then(() => 'ok', e => 'ERR: ' + (e && e.message))`) === 'ok');
await sleep(900);
check('新列的表头也补上了', await evl(
  `!!document.querySelector('#m-tablewrap thead th[data-k="${mfield.key}"]')`) === true);
check('表头没有被注入两遍', await evl(
  `document.querySelectorAll('#m-tablewrap thead th[data-k="${mfield.key}"]').length`) === 1);
await evl(`document.querySelector('.nav-tab[data-page="media"]').click()`);
await sleep(400);
await evl(`openMediaDialog(state.media.find(m => m.id === ${mrow.id}))`);
await sleep(500);
check('媒体表单里出现了自定义列', await evl(
  `!document.querySelector('#m-extra-fold').hidden
   && !!document.querySelector('#m-extra-fields [data-f="${mfield.key}"]')`) === true);
check('自定义列的现值被读进控件', await evl(
  `document.querySelector('#m-extra-fields [data-f="${mfield.key}"]')?.value`) === 'BD 原盘');
check('已有值时那一段自动摊开', await evl(`document.querySelector('#m-extra-fold').open`) === true);
// 撤回修复做负向对照时这个控件不在场：要让套件继续跑完，别崩在半路
await evl(`(() => { const el = document.querySelector('#m-extra-fields [data-f="${mfield.key}"]'); if (el) el.value = 'REMUX'; })()`);
await shot('21-media-extra');
await evl(`document.querySelector('#form-media').requestSubmit()`);
await sleep(1400);
const msaved = (await (await fetch(APP + 'api/media')).json()).find(m => m.id === mrow.id);
check('改动落库', msaved?.extra?.[mfield.key] === 'REMUX', JSON.stringify(msaved?.extra));
check('保存没有清掉条目本身的字段',
  msaved?.title === mrow.title && msaved?.rating === mrow.rating,
  `${msaved?.title} / ${msaved?.rating}`);
// 负向对照的靶子：表单不带 extra 时后端会把它写成 NULL，所以这条要一直有人守着
await patch(`/api/media/${mrow.id}`, { ...msaved, extra: { [mfield.key]: '守着' } });
await evl(`loadAll().catch(() => {})`); // 负向对照时这里本就会抛，别让它打断套件
await sleep(700);
await evl(`openMediaDialog(state.media.find(m => m.id === ${mrow.id}))`);
await sleep(500);
await evl(`document.querySelector('#form-media').requestSubmit()`);
await sleep(1400);
check('开表单直接保存不动自定义列的值',
  (await (await fetch(APP + 'api/media')).json()).find(m => m.id === mrow.id)?.extra?.[mfield.key] === '守着');
await fetch(`${APP}api/fields/${mfield.id}`, { method: 'DELETE' });
await evl(`document.querySelector('.nav-tab[data-page="renewals"]').click()`);
await evl(`loadAll().catch(() => {})`); // 负向对照时这里本就会抛，别让它打断套件
await sleep(700);

/* 17.15. 行首浮标：⠿ 拖动手柄 + 复选框，占的是首格预留的左内边距而不是一列。
   浮标住在名称格里，所以字形必须由 CSS ::before 画——写成按钮文本就会混进
   td.textContent，行文本从此永远带一个 ⠿（复制整行、断言取值都会看见）。 */
await evl(`switchTab('subs')`);
await sleep(400);
// 断言的是不变式本身（首个可见格拿到 .c0、且只有它拿到），不假定名称列排在最左——
// 前面的段落会改列序，写死成 name 就变成在测「列序没被动过」
check('首个可见格拿到 .c0（不是 :first-child）', await evl(`(() => {
  const vis = [...document.querySelector('#subs-body tr').children].filter(td => td.style.display !== 'none');
  return vis[0].classList.contains('c0') && !vis.slice(1).some(td => td.classList.contains('c0'));
})()`) === true);
check('浮标在首格里', await evl(`!!document.querySelector('#subs-body tr td.c0 > .rowgut')`) === true);
check('手柄与复选框都在', await evl(`(() => {
  const g = document.querySelector('#subs-body tr .rowgut');
  return !!g.querySelector('[data-grip]') && !!g.querySelector('[data-sel]');
})()`) === true);
check('⠿ 不混进行文本', (await evl(`document.querySelector('#subs-body tr td.c0').textContent`)).includes('⠿') === false);
check('⠿ 由 ::before 画出来',
  await evl(`getComputedStyle(document.querySelector('#subs-body tr .rgrip'), '::before').content`) === '"⠿"');
check('表头也有全选框', await evl(`!!document.querySelector('#view-subs thead th.c0 [data-selall]')`) === true);
// 把一个可隐藏的列挪到最左、再把它藏起来：隐藏列只是 display:none、没从 DOM 里摘掉，
// 所以 :first-child 会落在看不见的格上，吸附与浮标一起失效。藏 name 是不行的（它撤不下来），
// 藏一个本来就不在最左的列也测不出什么——必须让被藏的那个正好排在 DOM 首位
await evl(`views.subs.order = ['category', ...colKeys('subs').filter(k => k !== 'category')];
           views.subs.hiddenCols = ['category']; saveViews(); renderColl('subs')`);
await sleep(300);
check('首列被藏起来时 .c0 落到第一个看得见的格上', await evl(`(() => {
  const tr = document.querySelector('#subs-body tr');
  const vis = [...tr.children].filter(td => td.style.display !== 'none');
  return tr.children[0].style.display === 'none'
    && vis[0].classList.contains('c0') && !!vis[0].querySelector('.rowgut');
})()`) === true);
await evl(`views.subs.order = null; views.subs.hiddenCols = []; saveViews(); renderColl('subs')`);
await sleep(300);

/* 17.16. 多选与批量删除：行末那颗「删」已经撤了，选区 + 批量条是唯一的删除出口。 */
check('行末不再有「删」按钮',
  await evl(`!!document.querySelector('#subs-body tr td.ops [data-del]')`) === false);
check('没勾选时批量条是收着的', await evl(`document.querySelector('#bulkbar').hidden`) === true);
await evl(`(() => { const b = document.querySelector('#subs-body tr [data-sel]'); b.checked = true; b.dispatchEvent(new Event('change')); })()`);
await sleep(250);
check('勾一行就浮出批量条', await evl(`document.querySelector('#bulkbar').hidden`) === false);
check('批量条报出选中数', (await evl(`document.querySelector('#bulk-n').textContent`)).includes('1'));
check('选中的行有高亮', await evl(`!!document.querySelector('#subs-body tr.selrow')`) === true);
check('勾选后复选框常驻（表上挂 .selecting）',
  await evl(`!!document.querySelector('#view-subs table.selecting')`) === true);
await evl(`document.querySelector('#view-subs thead [data-selall]').checked = true;
           document.querySelector('#view-subs thead [data-selall]').dispatchEvent(new Event('change'))`);
await sleep(250);
const subsRowsNow = await evl(`document.querySelectorAll('#subs-body tr').length`);
check('全选把整表勾上', await evl(`document.querySelectorAll('#subs-body tr.selrow').length`) === subsRowsNow);
await evl(`document.querySelector('#bulk-clear').click()`);
await sleep(200);
check('取消把选区清干净', await evl(`document.querySelector('#bulkbar').hidden`) === true);
check('取消后行高亮也撤了', await evl(`document.querySelectorAll('#subs-body tr.selrow').length`) === 0);
// 真删：建两条一次性条目再批量删掉，别动播种数据
const bulkA = await post('/api/collections/subs/items', { name: '批量甲', status: 'Planned' });
const bulkB = await post('/api/collections/subs/items', { name: '批量乙', status: 'Planned' });
const delRes = await (await raw('/api/items/bulk_delete', 'POST', { ids: [bulkA.id, bulkB.id] })).json();
check('批量删除端点一次删两条', delRes.deleted === 2, JSON.stringify(delRes));
const afterBulk = await (await fetch(APP + 'api/collections/subs/items')).json();
check('两条都没了', afterBulk.some(x => x.id === bulkA.id || x.id === bulkB.id) === false);
check('批量删除缺 ids → 400', (await raw('/api/items/bulk_delete', 'POST', {})).status === 400);
// 换表要把选区带走，否则会对着看不见的表按删除
await evl(`(() => { const b = document.querySelector('#subs-body tr [data-sel]'); b.checked = true; b.dispatchEvent(new Event('change')); })()`);
await sleep(200);
await evl(`switchTab('vps')`);
await sleep(300);
check('换表清掉选区', await evl(`document.querySelector('#bulkbar').hidden`) === true);
await evl(`switchTab('subs')`);
await sleep(300);

/* 17.17. 手动排序：无列排序时的基态就是 pos（此前是名称字母序，拖出来的顺序无处安放）。
   按列排序时拖动的位置存不住，手柄随之停用。 */
// 前面的段落留了列排序在身上，先还原到该走的分支——否则测的是「按列排序」那条路
await evl(`setSort('subs', 'price', null)`);
await sleep(300);
// 子行是吸附在父行下渲染的，所以单调性只对顶层行成立
check('无排序时顶层按 pos 排', await evl(`(() => {
  const pos = [...document.querySelectorAll('#subs-body tr:not(.subrow)')]
    .map(t => state.subs.find(x => x.id === +t.dataset.id).pos);
  return pos.every((p, i) => i === 0 || p >= pos[i - 1]);
})()`) === true);
const ordBefore = await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`);
// 把顶层第一行挪到第二个顶层行之后（子行跟着父行整块走）
const topIds = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
await evl(`applyRowOrder('subs', moveRow('subs', ${topIds[0]}, ${topIds[1]}, true))`);
await sleep(600);
const ordAfter = await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`);
check('拖动改变了行序', JSON.stringify(ordAfter) !== JSON.stringify(ordBefore),
  `${ordBefore} → ${ordAfter}`);
check('新序落了库', await (async () => {
  const rows = await (await fetch(APP + 'api/collections/subs/items')).json();
  const byPos = [...rows].sort((a, b) => a.pos - b.pos).map(r => r.id);
  return JSON.stringify(byPos) === JSON.stringify(ordAfter);
})() === true);
check('刷新之后顺序还在', await (async () => {
  await evl(`loadAll()`); await sleep(600);
  const now = await evl(`[...document.querySelectorAll('#subs-body tr')].map(t => +t.dataset.id)`);
  return JSON.stringify(now) === JSON.stringify(ordAfter);
})() === true);
// 父行整块搬：子行仍然紧跟着它的父行
check('子行仍吸附在父行下', await evl(`(() => {
  const trs = [...document.querySelectorAll('#subs-body tr')];
  return trs.every((t, i) => !t.classList.contains('subrow') || (i > 0 && !trs[i - 1].classList.contains('subrow')
    || state.subs.find(x => x.id === +t.dataset.id).parent_id === state.subs.find(x => x.id === +trs[i - 1].dataset.id).parent_id));
})()`) === true);
// 同级约束：把子行拖到顶层行上要被拦下
const kidId = await evl(`state.subs.find(x => x.parent_id)?.id`);
check('子行拖不到顶层去', await evl(`moveRow('subs', ${kidId}, ${topIds[0]}, true)`) === null);
// 按列排序时手柄停用
await menuClick('#view-subs th[data-k="price"]', '升序');
await sleep(300);
check('按列排序后手柄停用', await evl(`!!document.querySelector('#subs-body .rgrip.off')`) === true);
check('停用的手柄给出了原因',
  (await evl(`document.querySelector('#subs-body .rgrip').title`)).includes('清掉列排序'));
await evl(`setSort('subs', 'price', null)`);
await sleep(300);
check('清掉排序后手柄又能拖', await evl(`!!document.querySelector('#subs-body .rgrip.off')`) === false);

/* 17.18. 键盘挪行：手柄不进 Tab 序（一行一个停靠点已经够多），改用复选框上的 Alt+↑/↓。 */
const kbBefore = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
await evl(`nudgeRow('subs', ${kbBefore[0]}, 1)`);
await sleep(600);
const kbAfter = await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`);
check('Alt+↓ 把行往下挪了一格', kbAfter[1] === kbBefore[0], `${kbBefore} → ${kbAfter}`);
await evl(`nudgeRow('subs', ${kbBefore[0]}, -1)`);
await sleep(600);
check('Alt+↑ 挪得回来',
  JSON.stringify(await evl(`[...document.querySelectorAll('#subs-body tr:not(.subrow)')].map(t => +t.dataset.id)`))
  === JSON.stringify(kbBefore));
check('手柄不在 Tab 序里', await evl(`document.querySelector('#subs-body .rgrip').tabIndex`) === -1);
check('复选框可聚焦', await evl(`document.querySelector('#subs-body [data-sel]').tabIndex`) !== -1);

/* 17.19. 媒体侧同样三件事。媒体的默认序仍是「最近标记」——拖拽是排序下拉里新增的
   「手动」档，选中才可拖，否则 439 条会被一次性冻结成当前顺序。 */
await evl(`document.querySelector('.nav-tab[data-page="media"]').click()`);
await evl(`views.media.view = 'table'; saveViews(); renderMedia()`);
await sleep(500);
check('媒体排序下拉有「手动」档',
  await evl(`!!document.querySelector('#m-sort option[value="pos"]')`) === true);
check('媒体默认序仍是最近标记（不是手动）', await evl(`views.media.sort?.key`) !== 'pos');
check('非手动档时媒体手柄停用', await evl(`!!document.querySelector('#m-body .rgrip.off')`) === true);
check('媒体行末也没有「删」了',
  await evl(`!!document.querySelector('#m-body tr td.ops [data-del]')`) === false);
await evl(`setSort('media', 'pos', 1)`);
await sleep(400);
check('选了手动档手柄就活了', await evl(`!!document.querySelector('#m-body .rgrip.off')`) === false);
const mOrd0 = await evl(`[...document.querySelectorAll('#m-body tr')].map(t => +t.dataset.id)`);
await evl(`applyRowOrder('media', moveRow('media', ${mOrd0[0]}, ${mOrd0[mOrd0.length - 1]}, true))`);
await sleep(600);
const mOrd1 = await evl(`[...document.querySelectorAll('#m-body tr')].map(t => +t.dataset.id)`);
check('媒体拖动改变了行序', mOrd1[mOrd1.length - 1] === mOrd0[0], `${mOrd0} → ${mOrd1}`);
check('媒体新序落了库', await (async () => {
  const rows = await (await fetch(APP + 'api/media')).json();
  const byPos = [...rows].sort((a, b) => a.pos - b.pos).map(r => r.id);
  return JSON.stringify(byPos) === JSON.stringify(mOrd1);
})() === true);
// 媒体的新建空行 + 批量删除
const mN0 = await evl(`document.querySelectorAll('#m-body tr').length`);
await evl(`document.querySelector('#m-tablewrap .newrow').click()`);
await sleep(800);
check('媒体新建也是直接插空行', await evl(`document.querySelectorAll('#m-body tr').length`) === mN0 + 1);
check('媒体空标题渲染成「未命名」', await evl(`!!document.querySelector('#m-body .unnamed')`) === true);
await evl(`closePop()`);
const mBlank = await evl(`Math.max(...state.media.map(x => x.id))`);
const mDel = await (await raw('/api/media/bulk_delete', 'POST', { ids: [mBlank] })).json();
check('媒体批量删除端点可用', mDel.deleted === 1, JSON.stringify(mDel));
await evl(`setSort('media', 'marked', -1)`);
await evl(`loadAll()`);
await sleep(600);
check('媒体收拾回原来的行数', await evl(`document.querySelectorAll('#m-body tr').length`) === mN0);
await evl(`document.querySelector('.nav-tab[data-page="renewals"]').click()`);
await sleep(400);
// 拍在该看的状态下：滚到表格、勾两行，让浮标（复选框常驻）、行高亮与批量条一起入镜
await evl(`document.querySelector('#view-subs').scrollIntoView({ block: 'center' })`);
await evl(`[...document.querySelectorAll('#subs-body tr [data-sel]')].slice(0, 2)
  .forEach(b => { b.checked = true; b.dispatchEvent(new Event('change')); })`);
await sleep(400);
await shot('22-row-gutter');
await evl(`document.querySelector('#bulk-clear').click()`);
await sleep(200);

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
// localhost 更早一步就被 url 形状检查拦了（域名里没有点），同样进不去出网那一段
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

/* 17.27. 「续费起算」独立成一个轴。此前 due_anchor='last' 一个标记同时扛着两种语义：
   SIM 保号的窗口**本来就该**从实际充值那天重新计时，而 VPS 是服务商按固定日历日出账。
   共用一条实现的结果是 VPS 那侧错着——点一次「已续费」就把锚点拽到今天，晚付十天
   账期便永久后移十天，逐期累积。 */
const rfColls = await (await fetch(APP + 'api/collections')).json();
const rfMap = Object.fromEntries(rfColls.map(c => [c.key, c.renew_from]));
check('预置库的续费起算：订阅/VPS 按日程、SIM 从当天',
  rfMap.subs === 'schedule' && rfMap.vps === 'schedule' && rfMap.sims === 'today', JSON.stringify(rfMap));

// 日期基准取服务端的「今天」，不用本脚本的 day()：那个按 UTC 算，而服务端看 Local::now()，
// 半夜跑的时候两者会差一天，断言就会在一个与本段无关的理由上翻
const rfToday = (await (await fetch(APP + 'api/overview')).json()).today;
const rfDay = n => new Date(new Date(rfToday + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

// 同一份数据喂给两个库：30 天一期、欠了三期多。差别只在库的续费起算方式上。
// 用天数周期是为了不在断言里再复刻一遍日历加法——月末钳位那类边界由 cargo test 守着
const rfSeed = { status: 'Active', cycle: 'days', cycle_days: 30, last_renewed: rfDay(-100) };
const rfVps = await mk('vps', { name: '账单日机器', price: 9, currency: 'USD', ...rfSeed, extra: { purpose: '任务' } });
const rfSim = await mk('sims', { name: '保号测试卡', ...rfSeed, extra: { keepalive_action: '充值' } });

const rfResp = await post(`/api/items/${rfVps.id}/renew`, {});
const rfVpsAfter = (await (await fetch(APP + 'api/collections/vps/items')).json()).find(r => r.id === rfVps.id);
check('按日程续费：锚点落在刚付的那一期，不是今天',
  rfVpsAfter.last_renewed === rfDay(-10), `落在 ${rfVpsAfter.last_renewed}，今天是 ${rfToday}`);
check('按日程续费：到期日回到原本的账单日',
  rfResp.due === rfDay(20), JSON.stringify(rfResp));

await post(`/api/items/${rfSim.id}/renew`, {});
const rfSimAfter = (await (await fetch(APP + 'api/collections/sims/items')).json()).find(r => r.id === rfSim.id);
check('保号仍从操作当天重新计时（同样的数据，另一种语义）',
  rfSimAfter.last_renewed === rfToday, `落在 ${rfSimAfter.last_renewed}，今天是 ${rfToday}`);

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

/* 17.28. 「类型 × 场所」的叉积。本轮评审里 18 条发现有 6 条落在这上头，共同的形状是
   一个新字段类型只接了一半管线：渲染接了、筛选没接；库那侧接了、媒体那侧没接。
   按功能加断言的习惯抓不到这类缺口，得按「类型 × 场所」补。 */
await evl(`document.querySelector('.nav-tab[data-page="renewals"]').click()`);
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

// 媒体表两头都要接：建列的类型下拉对媒体一视同仁地供应这三种类型，
// 而写入口不规范化、格子里不给链接的话，同名同类型的列在两张表上表现就不一样。
const xMField = await post('/api/fields', { tbl: 'media', name: '播放页', ftype: 'url' });
const xMRow = (await (await fetch(APP + 'api/media')).json())[0];
await patch(`/api/media/${xMRow.id}`, { ...xMRow, extra: { ...(xMRow.extra || {}), [xMField.key]: 'netflix.com/title/1' } });
const xMSaved = (await (await fetch(APP + 'api/media')).json()).find(m => m.id === xMRow.id);
check('媒体的 url 列同样过写入口规范化（没有协议的裸串会被当成站内相对路径）',
  xMSaved?.extra?.[xMField.key] === 'https://netflix.com/title/1', JSON.stringify(xMSaved?.extra));
await evl(`loadAll()`);
await sleep(900);
await evl(`document.querySelector('.nav-tab[data-page="media"]').click()`);
await sleep(400);
check('媒体表里也渲染成可点链接（此前是灰色纯文本）',
  await evl(`document.querySelector('#m-body tr[data-id="${xMRow.id}"] td[data-k="${xMField.key}"] a')?.getAttribute('href')`)
    === 'https://netflix.com/title/1');
await fetch(`${APP}api/fields/${xMField.id}`, { method: 'DELETE' });
await evl(`document.querySelector('.nav-tab[data-page="renewals"]').click()`);
await evl(`loadAll()`);
await sleep(700);

/* 17.29. 换库的到期模型：另一侧的日期字段此前从未注册过，切过去 due_from 就改读一个
   界面上根本造不出来的字段（字段面板只能建 extra 自定义列），整库到期日静默消失——
   表格里旧的那列还显示着值，看着一切正常，时间线却空了。 */
const acColl = await post('/api/collections', { name: '锚点切换', due_anchor: 'last' });
const acItem = await mk(acColl.key, { name: '按上次续费算', status: 'Active', cycle: 'monthly', last_renewed: rfDay(-5) });
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
await patch(`/api/items/${acItem.id}`, { ...acRow, next_renewal: rfDay(9) });
check('填上之后到期日就回来了',
  (await (await fetch(APP + 'api/overview')).json()).upcoming
    .some(u => u.kind === acColl.key && u.id === acItem.id && u.due === rfDay(9)));

// 算不出到期日时点名的必须是真正缺的那一项：last 锚点有两半成因（缺日期 / 缺周期），
// 一律报「缺上次续费日」的话，用户打开条目看见日期填着，按提示无从下手
await put(`/api/collections/${acColl.id}`, { due_anchor: 'last' });
const acRow2 = (await (await fetch(`${APP}api/collections/${acColl.key}/items`)).json()).find(r => r.id === acItem.id);
await patch(`/api/items/${acItem.id}`, { ...acRow2, cycle: '', last_renewed: rfDay(-5) });
check('日期填着、周期空着时点名的是「周期」',
  (await (await fetch(APP + 'api/overview')).json()).undated
    .find(x => x.kind === acColl.key && x.id === acItem.id)?.missing === '周期');

// 提前续费（按日程续费会产生「未来的 last_renewed」，0017 之前不可能出现的合法状态）：
// 本期还没开始，照旧画进度条就是「剩 35 天 / 30」配一根空槽，看着像算错了
await patch(`/api/items/${acItem.id}`, { ...acRow2, cycle: 'days', cycle_days: 30, last_renewed: rfDay(5) });
await evl(`loadAll()`);
await sleep(800);
await evl(`switchTab('${acColl.key}')`);
await sleep(400);
const acLeft = (await evl(
  `document.querySelector('#${acColl.key}-body tr[data-id="${acItem.id}"] td[data-k="left"]')?.textContent || ''`))
  .replace(/\s+/g, ' ');
check('本期还没开始时不画进度条，改说清本期哪天起算',
  acLeft.includes('剩 35 天') && acLeft.includes(rfDay(5)) && !acLeft.includes('/ 30'), acLeft);
// 拍在该看的状态下：表格在页面下半，不滚过去截出来的是首页那一屏
await evl(`document.querySelector('#${acColl.key}-body tr[data-id="${acItem.id}"]')?.scrollIntoView({ block: 'center' })`);
await sleep(400);
await shot('25-early-renew-left');
await fetch(`${APP}api/collections/${acColl.id}`, { method: 'DELETE' });
await evl(`loadAll()`);
await sleep(700);

/* 17.30. 条目更新是局部更新（PATCH）：请求里出现的键写入（"" 与 null 即清空），
   缺席的键保持原值；extra 作为一个整体值走同一条规则。
   从前是全量替换（PUT），body 漏一列就清一列，于是每条写入路径都得先铺整行再覆盖——
   SIM 的周期、媒体的自定义列、条目图标、父条目都这样被一次保存清掉过。 */
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
// 媒体那侧同一套语义
const pa_m = (await (await fetch(APP + 'api/media')).json())[0];
await patch(`/api/media/${pa_m.id}`, { extra: { pa_note: '自定义列的值' } });
await patch(`/api/media/${pa_m.id}`, { title: pa_m.title });
const pa_m2 = (await (await fetch(APP + 'api/media')).json()).find(r => r.id === pa_m.id);
check('媒体：只发标题不会清掉 extra 与评分',
  pa_m2.extra?.pa_note === '自定义列的值' && pa_m2.rating === pa_m.rating,
  JSON.stringify([pa_m2.extra, pa_m2.rating]));
await patch(`/api/media/${pa_m.id}`, { extra: {} });
// 协议真的换了：旧的整行 PUT 不再受理（405），免得有人照旧发全量体却以为是局部更新
check('条目的 PUT 已不受理（405）', (await raw(`/api/items/${pa_item.id}`, 'PUT', { name: 'x' })).status === 405);
check('媒体条目同样（405）', (await raw(`/api/media/${pa_m.id}`, 'PUT', { title: 'x' })).status === 405);
await fetch(`${APP}api/items/${pa_item.id}`, { method: 'DELETE' });
await evl(`loadAll()`);
await sleep(700);

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

// ③ 有金额没币种的条目一分钱不进总额（engine::totals 要两样都在场才累加）。
//    界面得点名，别让总额看着像"全都算进去了"
await mk('subs', { name: '只填了金额', status: 'Active', cycle: 'monthly', next_renewal: day(9), price: 42 });
await evl(`loadAll()`);
await sleep(900);
const nx_note = await evl(`document.querySelector('#totals-note').hidden ? '' : document.querySelector('#totals-note').textContent`);
check('支出栏点名了"该计支出却没算进来"的条目',
  nx_note.includes('只填了金额') && nx_note.includes('缺币种'), nx_note);

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

// ⑥ 汇率是辅助资源：它拉不到也不该让整页渲染不出来（media-only 部署下 /api/fx 必然 404，
//    从前它就在首屏那一批 Promise.all 里，媒体数据取回来了页面却是空的）
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

// ⑦ 海报墙是媒体库的默认视图，卡片只挂 onclick 就等于键盘用户在这一屏无路可走
await evl(`(() => { state.page = 'media'; document.querySelector('#page-renewals').hidden = true;
  document.querySelector('#page-media').hidden = false; views.media.view = 'wall'; renderMedia(); })()`);
await sleep(500);
check('海报卡进 Tab 序且自报身份', await evl(
  `(() => { const c = document.querySelector('#m-wall .card');
     return c?.tabIndex === 0 && c.getAttribute('role') === 'button' && !!c.getAttribute('aria-label'); })()`) === true);
await evl(`document.querySelector('#m-wall .card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(400);
check('回车能打开详情', await evl(`document.querySelector('#dlg-media')?.open`) === true);
await evl(`document.querySelector('#dlg-media').close(); state.page = 'renewals';
  document.querySelector('#page-media').hidden = true; document.querySelector('#page-renewals').hidden = false;`);
await sleep(300);

/* 17.31a. schema 与 view 是两层：字段序与「上表」跟着账本走（服务端 fields），
   列宽/列序/隐藏/排序/筛选各设备各记（本机 views）。两层唯一会打架的是列序——
   本机那份覆写会盖住刚在库设置里排好的字段序，**由 settleView 自动结算**，
   而不是靠调用方"记得"清一次（从前那句手动清就住在字段面板的保存回调里）。 */
await evl(`switchTab('subs')`);
await sleep(300);
const svKeys = await evl(`TKEYS.subs.slice(0, 3).join(',')`);
// 先在本机拖出一份列序覆写
await evl(`(() => { const o = [...TKEYS.subs]; o.unshift(o.splice(o.indexOf('status'), 1)[0]);
  views.subs.order = o; saveViews(); renderColl('subs'); })()`);
await sleep(300);
check('本机列序覆写生效（状态被拖到最前）', await evl(
  `document.querySelector('#view-subs thead th').dataset.k`) === 'status');
// 服务端改字段序：列集没变、只是换了次序
const svFields = (await (await fetch(APP + 'api/fields')).json()).filter(f => f.tbl === 'subs').sort((a, b) => a.pos - b.pos);
const svOrder = svFields.map(f => f.key);
await put('/api/fields/order', { tbl: 'subs', keys: [...svOrder.slice(1), svOrder[0]] });
await evl(`loadAll()`);
await sleep(900);
check('服务端字段序一变，本机那份过期的列序覆写自动作废', await evl(`views.subs.order`) === null);
await put('/api/fields/order', { tbl: 'subs', keys: svOrder }); // 还原
await evl(`loadAll()`);
await sleep(800);
check('两层的边界在界面上说得出来', await evl(`(() => {
  const note = document.querySelector('#coll-fields-box .fp-note')?.textContent || '';
  return note.includes('所有设备一致');
})()`) === true || await evl(`(() => {
  openCollDialog(collOf('subs'));
  const note = document.querySelector('#coll-fields-box .fp-note')?.textContent || '';
  document.querySelector('#dlg-coll').close();
  return note.includes('所有设备一致');
})()`) === true);
// 「还原列宽」只在真有手动列宽时才出现——先把那个前提造出来，否则这条断言没有区分度
check('表头菜单里的本机项标了「仅本机」', await evl(`(() => {
  views.subs.widths = { ...views.subs.widths, notes: 180 };
  document.querySelector('#view-subs thead th[data-k="notes"]').click();
  const txt = [...document.querySelectorAll('.thmenu .mi')].map(x => x.textContent).join('|');
  closePop();
  views.subs.widths = {};
  saveViews();
  return txt.includes('隐藏此列（仅本机）') && txt.includes('还原列宽（仅本机）');
})()`) === true);

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
check('「新建列」下拉列的正是内核里那几种', await evl(`(() => {
  openNewColPop('subs', document.querySelector('#view-subs th.ops'));
  const opts = [...document.querySelectorAll('.optpop [data-type] option')].map(o => o.value).join(',');
  closePop();
  return opts === Object.keys(TYPES).join(',');
})()`) === true);

/* 17.32. 无障碍收尾与对比度：这批的价值不在"合规"，在于当前态与控件名字此前**只存在于视觉里**。
   刻意**不认领 role=tab**——那等于向读屏承诺方向键能在标签间移动，而我们没有那套键盘模型。 */
await evl(`switchTab('subs')`);
await sleep(300);
check('当前库标签标了 aria-current，其余没有', await evl(`(() => {
  const on = [...document.querySelectorAll('.tab[data-tab]')].filter(t => t.getAttribute('aria-current'));
  return on.length === 1 && on[0].dataset.tab === 'subs';
})()`) === true);
await evl(`switchTab('vps')`);
await sleep(300);
check('切库后 aria-current 跟着走', await evl(
  `document.querySelector('.tab[aria-current]')?.dataset.tab`) === 'vps');
await evl(`switchTab('subs')`);
await sleep(250);
check('主导航标了当前页（且只标一个）', await evl(`(() => {
  const on = [...document.querySelectorAll('.nav-tab[data-page]')].filter(t => t.getAttribute('aria-current') === 'page');
  return on.length === 1 && on[0].dataset.page === 'renewals';
})()`) === true);
check('没有认领 tab 模式（没有 role=tab / tablist）', await evl(
  `!document.querySelector('[role="tab"], [role="tablist"]')`) === true);
check('搜索框有可访问名（placeholder 一输入就没了，不能当名字）', await evl(
  `!!document.querySelector('#t-search').getAttribute('aria-label') && !!document.querySelector('#m-search').getAttribute('aria-label')`) === true);

// 复合控件：一个 label 只配一枚控件，多选那种一串控件的用 group + aria-labelledby
await evl(`openItemDialog('vps', state.vps[0])`);
await sleep(500);
check('多选字段外层不再是 label（改用带名字的 group）', await evl(`(() => {
  const box = document.querySelector('#item-fields [data-mbox]');
  const wrap = box?.closest('.field');
  return !!wrap && wrap.tagName === 'DIV' && wrap.getAttribute('role') === 'group'
    && !!document.getElementById(wrap.getAttribute('aria-labelledby'))
    && !box.closest('label');
})()`) === true);
check('图标行同样是 group，不是套着 file input 的 label', await evl(`(() => {
  const w = document.querySelector('#item-fields .logo-row')?.closest('.field');
  return !!w && w.getAttribute('role') === 'group' && !document.querySelector('#item-fields .logo-row')?.closest('label');
})()`) === true);
check('表单栅格样式没塌（group 与 label 同为竖排）', await evl(
  `getComputedStyle(document.querySelector('#item-fields .field')).flexDirection`) === 'column');
check('币种下拉与「新选项」框都有可访问名', await evl(`(() => {
  const cur = document.querySelector('#item-fields .pricebox select[data-f="currency"]');
  const add = document.querySelector('#item-fields .sopt-add');
  return !!cur?.getAttribute('aria-label') && !!add?.getAttribute('aria-label');
})()`) === true);
check('复合控件里不再有嵌套 label', await evl(
  `!document.querySelector('#item-fields label label')`) === true);
await evl(`document.querySelector('#dlg-item').close()`);
await sleep(200);

// 对比度：算给机器看，比目检稳。小字要 4.5，最差那一档是 --surface-2 当底（表头底/行悬停底）
check('浅色 --ink-2 在三种底上都过 WCAG AA 的 4.5', await evl(`(() => {
  const lin = c => (c /= 255, c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = rgb => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  // 自定义属性拿到的是声明原样（#56766f 这种十六进制），不是 rgb()
  const parse = v => { const h = v.trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const cs = getComputedStyle(document.documentElement);
  const ink = parse(cs.getPropertyValue('--ink-2'));
  const ratio = b => { const [hi, lo] = [L(ink), L(parse(cs.getPropertyValue(b)))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05); };
  return ['--bg', '--surface', '--surface-2'].every(b => ratio(b) >= 4.5);
})()`) === true);

/* 17.33. 写入口的日期与币种校验；媒体排序下拉只属于海报墙；库设置只留齿轮。 */
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
await evl(`loadAll()`);
await sleep(700);
// 排序下拉：海报墙没有表头可点，它是唯一入口；表格视图里点表头就能排，两个入口管同一个状态
await evl(`(() => { state.page = 'media'; document.querySelector('#page-renewals').hidden = true;
  document.querySelector('#page-media').hidden = false; views.media.view = 'wall'; renderMedia(); })()`);
await sleep(400);
check('海报墙里排序下拉在', await evl(`!document.querySelector('#m-sort').hidden`) === true);
await evl(`(() => { views.media.view = 'table'; renderMedia(); })()`);
await sleep(400);
check('表格视图里排序下拉收起（点表头就能排）', await evl(
  `getComputedStyle(document.querySelector('#m-sort')).display`) === 'none');
await evl(`(() => { views.media.view = 'wall'; state.page = 'renewals';
  document.querySelector('#page-media').hidden = true; document.querySelector('#page-renewals').hidden = false; })()`);
await sleep(250);
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
// 出异常时给出 FAIL 而不是让整个脚本崩掉，负向对照才跑得完整套
const evlSafe = async expr => {
  try { return { ok: true, v: await evl(expr) }; } catch (e) { return { ok: false, v: String(e.message).slice(0, 300) }; }
};
await evl(`switchTab('vps')`);
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

const errs = consoleMsgs.filter(m => !m.includes('favicon'));
check('无 console 错误', errs.length === 0, JSON.stringify(errs));
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
console.log('截图目录：' + OUT);
ws.close();
chrome.kill();
process.exit(failures ? 1 : 0);
