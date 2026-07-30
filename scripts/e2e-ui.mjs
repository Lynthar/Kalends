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
  await post('/api/media', { kind: '电影', title: '测试电影甲', year: 2019, rating: 4, douban_rating: 8.4, status: '看过', marked_at: '2026-06-01' });
  await post('/api/media', { kind: '剧集', title: '测试剧集乙', year: 2023, rating: 5, douban_rating: 9.1, status: '在看', marked_at: '2026-07-10' });
  await post('/api/media', { kind: '游戏', title: '测试游戏丙', year: 2021, rating: 3, status: '想看', marked_at: '2026-05-20', platform: 'Steam' });
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

/* 9. ＋新建行是加条目的唯一入口，右上角那颗绿按钮改成了建库 */
await evl(`document.querySelector('#view-subs .newrow').click()`);
await sleep(300);
check('新建行开订阅表单', await evl(`document.querySelector('#dlg-item').open`) === true);
await evl(`document.querySelector('#dlg-item').close()`);
await sleep(150);
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
check('字段注册表已清空', (await (await fetch(APP + 'api/fields')).json()).filter(f => !f.builtin).length === 0);

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
  const res = await put(`/api/items/${before.id}`, { ...before, [mark]: 'e2e 往返' });
  check(`${key} 整行 PUT`, res.ok, res.ok ? '' : JSON.stringify(await res.json().catch(() => ({}))));
  const after = (await items()).find(x => x.id === before.id);
  check(`${key} PUT 后字段落库`, after?.[mark] === 'e2e 往返');
  check(`${key} PUT 未丢状态与周期`, after?.status === before.status && after?.cycle === before.cycle);
  check(`${key} PUT 未丢 extra 域字段`,
    JSON.stringify(after?.extra || {}) === JSON.stringify(before.extra || {}),
    `前 ${JSON.stringify(before.extra)} 后 ${JSON.stringify(after?.extra)}`);
  check(`${key} 还原`, (await put(`/api/items/${before.id}`, before)).ok); // 不给后续断言留脏数据
}

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
  nheads.slice(0, 7).join() === 'name,status,price,currency,cycle,next_renewal,notes'
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
const sf = await post('/api/fields', { tbl: NK, name: '星级', ftype: 'star' });
await put('/api/fields/options', { tbl: NK, key: mf.key, options: [{ v: 'CN2 GIA/9929' }, { v: '普通' }] });
const nrows = await (await fetch(`${APP}api/collections/${NK}/items`)).json();
const slashRow = nrows.find(r => r.name === 'renamed.com') || nrows.find(r => r.name === 'lynthar.com');
const SLASH_NAME = slashRow.name;
await put(`/api/items/${slashRow.id}`, {
  ...slashRow, extra: { ...(slashRow.extra || {}), [mf.key]: ['CN2 GIA/9929'], [sf.key]: 4 },
});
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

/* 12g-4. 详情表单用真控件：多选是勾选清单、星级是点星；开表单直接保存不得改坏任何值 */
await evl(`openItemDialog('${NK}', state['${NK}'].find(r => r.name === '${SLASH_NAME}'))`);
await sleep(500);
check('多选字段是勾选清单而非文本框', await evl(
  `!!document.querySelector('#item-fields [data-mbox="${mf.key}"] input[type=checkbox]')
   && !document.querySelector('#item-fields input[data-f="${mf.key}"]')`) === true);
check('勾选清单带出当前值', await evl(
  `[...document.querySelectorAll('#item-fields [data-mbox="${mf.key}"] input:checked')].map(i => i.value).join('|')`) === 'CN2 GIA/9929');
check('星级字段是点星控件、已点亮 4 颗', await evl(
  `document.querySelectorAll('#item-fields .stars button.lit').length`) === 4);
await shot('15-item-form');
await evl(`document.querySelector('#form-item').requestSubmit()`);
await sleep(1000);
const saved = (await (await fetch(`${APP}api/collections/${NK}/items`)).json()).find(r => r.name === SLASH_NAME);
check('原样保存不拆坏含 / 的多选值', JSON.stringify(saved.extra?.[mf.key]) === '["CN2 GIA/9929"]', JSON.stringify(saved.extra?.[mf.key]));
check('原样保存后星级仍是数字', saved.extra?.[sf.key] === 4, JSON.stringify(saved.extra?.[sf.key]));
// 点星改分同样要落成数字
await evl(`openItemDialog('${NK}', state['${NK}'].find(r => r.name === '${SLASH_NAME}'))`);
await sleep(450);
await evl(`document.querySelector('#item-fields .stars button[data-v="2"]')?.click()`);
await sleep(150);
check('点第 2 颗星后只亮 2 颗', await evl(`document.querySelectorAll('#item-fields .stars button.lit').length`) === 2);
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
const restarred = (await (await fetch(`${APP}api/collections/${NK}/items`)).json()).find(r => r.name === SLASH_NAME);
check('点星改分落库为数字 2', restarred.extra?.[sf.key] === 2, JSON.stringify(restarred.extra?.[sf.key]));
check('回车加的新选项一并落库', JSON.stringify(restarred.extra?.[mf.key]) === '["CN2 GIA/9929","临时线路"]', JSON.stringify(restarred.extra?.[mf.key]));

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
    && document.querySelectorAll('#coll-fields .opt-row').length === 13`) === true);
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
check('自己不能当自己的父行', !(await raw(`/api/items/${gp.id}`, 'PUT', { ...gpRow, parent_id: gp.id })).ok);
check('已有子行的条目不能再挂到别人下面',
  !(await raw(`/api/items/${gp.id}`, 'PUT', { ...gpRow, parent_id: topRow.id })).ok);
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
check('改不存在的条目 → 404', await codeOf('/api/items/999999', 'PUT', { name: 'x' }) === 404);
check('往不存在的库里加条目 → 404', await codeOf('/api/collections/nope/items', 'POST', { name: 'x' }) === 404);
check('条目缺名称 → 400', await codeOf('/api/collections/subs/items', 'POST', { status: 'Active' }) === 400);
check('未知字段类型 → 400', await codeOf('/api/fields', 'POST', { tbl: 'subs', name: 'x', ftype: 'bogus' }) === 400);
check('未知建库模板 → 400', await codeOf('/api/collections', 'POST', { name: 'x', template: 'bogus' }) === 400);
check('改不存在的列 → 404', await codeOf('/api/fields/999999', 'PUT', { name: 'x', shown: true }) === 404);
check('删不可删的列 → 404', await codeOf(`/api/fields/${nameF.id}`, 'DELETE') === 404);
check('错误体仍带可读 error 字段',
  typeof (await (await raw('/api/items/999999', 'PUT', { name: 'x' })).json()).error === 'string');

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

const errs = consoleMsgs.filter(m => !m.includes('favicon'));
check('无 console 错误', errs.length === 0, JSON.stringify(errs));
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
console.log('截图目录：' + OUT);
ws.close();
chrome.kill();
process.exit(failures ? 1 : 0);
