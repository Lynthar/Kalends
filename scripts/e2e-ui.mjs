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

const subs0 = await fetch(APP + 'api/subscriptions').then(r => r.json()).catch(() => null);
if (!subs0) { console.error('服务未启动？先起 Kalends 实例再跑本脚本'); process.exit(2); }
if (subs0.length === 0) {
  console.log('空库，播种假数据…');
  await post('/api/subscriptions', { name: 'Netflix', status: 'Active', category: 'Streaming', price: 15.49, currency: 'USD', cycle: 'monthly', next_renewal: day(3), payment_method: 'Visa' });
  await post('/api/subscriptions', { name: 'ChatGPT Plus', status: 'Active', category: 'AI', price: 20, currency: 'USD', cycle: 'monthly', next_renewal: day(45), payment_method: 'Master' });
  await post('/api/subscriptions', { name: 'iCloud+', status: 'Active', category: 'CloudSvc', price: 6, currency: 'CNY', cycle: 'monthly', next_renewal: day(10), payment_method: '支付宝' });
  const mj = await post('/api/subscriptions', { name: 'Midjourney', status: 'Deferred', category: 'AI' });
  await post('/api/subscriptions', { name: 'Basic Plan', status: 'Active', category: 'AI', price: 96, currency: 'USD', cycle: 'annual', next_renewal: day(200), parent_id: mj.id, payment_method: 'Visa' });
  await post('/api/subscriptions', { name: '旧订阅', status: 'Ended', category: 'News' });
  await post('/api/sims', { name: '🇬🇧 Giffgaff', status: 'Active', forms: ['SIM'], cycle_days: 181, last_renewed: day(-175), keepalive_action: '发一条短信' });
  await post('/api/sims', { name: '🇺🇸 Ultra', status: 'Active', forms: ['eSIM', 'VOIP'], cycle_days: 90, last_renewed: day(-10), keepalive_action: '充值 $5' });
  await post('/api/vps', { vendor: 'HostA', product: 'VPS-1', status: 'Active', purpose: '代理出口', locations: ['东京'], routes: ['CN2 GIA'], cores: 1, ram_gb: 1, storage_gb: 20, storage_type: 'SSD', price: 25, currency: 'USD', cycle: 'annual', last_renewed: day(-334) });
  await post('/api/vps', { vendor: 'HostB', status: 'Ending', purpose: '建站', locations: ['洛杉矶'], routes: ['9929'], cores: 2, ram_gb: 4, storage_gb: 60, price: 48, currency: 'USD', cycle: 'annual', last_renewed: day(-304) });
  await post('/api/vps', { vendor: 'HostC', status: 'Active', purpose: '任务', locations: ['香港', '东京'], routes: ['CMI'], cores: 4, ram_gb: 8, storage_gb: 100, price: 320, currency: 'CNY', cycle: 'triennial', last_renewed: day(-60) });
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
check('⤢ 打开全表单', await evl(`document.querySelector('#dlg-sub').open`) === true);
await evl(`document.querySelector('#dlg-sub').close()`);
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

/* 9. ＋新建行 */
await evl(`document.querySelector('#view-subs .newrow').click()`);
await sleep(300);
check('新建行开订阅表单', await evl(`document.querySelector('#dlg-sub').open`) === true);
await evl(`document.querySelector('#dlg-sub').close()`);

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
check('商家文本筛选', await menuClick('#view-vps th[data-k="vendor"]', '筛选'));
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
const cg = (await (await fetch(APP + 'api/subscriptions')).json()).find(x => x.name === 'ChatGPT Plus');
check('整行 PUT 未丢字段', !!cg && cg.price === 20 && cg.next_renewal === day(45) && cg.category === 'AI',
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
const subsNow = await (await fetch(APP + 'api/subscriptions')).json();
const mj2 = subsNow.find(x => x.name === 'Midjourney');
const upResp = await fetch(`${APP}api/subscriptions/${mj2.id}/logo?ext=png`, { method: 'POST', body: PNG1 });
check('logo 上传成功', upResp.ok && (await upResp.json()).logo?.endsWith('.png'));
const logoName = (await (await fetch(APP + 'api/subscriptions')).json()).find(x => x.id === mj2.id).logo;
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
check('内联编辑后 logo 保留', (await (await fetch(APP + 'api/subscriptions')).json()).find(x => x.id === mj2.id).logo === logoName);
const fakeSvg = await fetch(`${APP}api/subscriptions/${mj2.id}/logo?ext=svg`, { method: 'POST', body: PNG1 });
check('魔数不符的上传被拒', !fakeSvg.ok && ((await fakeSvg.json()).error || '').includes('不符'));
const delResp = await fetch(`${APP}api/subscriptions/${mj2.id}/logo`, { method: 'DELETE' });
check('logo 清除', delResp.ok && (await (await fetch(APP + 'api/subscriptions')).json()).find(x => x.id === mj2.id).logo == null);
await evl(`loadAll()`);
await sleep(500);

/* 12e. 整行 PUT：点格即编与 ⤢ 详情表单都走这条路，三表都得能存回去 */
for (const [p, mark] of [['subscriptions', 'notes'], ['sims', 'keepalive_action'], ['vps', 'notes']]) {
  const before = (await (await fetch(`${APP}api/${p}`)).json())[0];
  const res = await put(`/api/${p}/${before.id}`, { ...before, [mark]: 'e2e 往返' });
  check(`${p} 整行 PUT`, res.ok, res.ok ? '' : JSON.stringify(await res.json().catch(() => ({}))));
  const after = (await (await fetch(`${APP}api/${p}`)).json()).find(x => x.id === before.id);
  check(`${p} PUT 后字段落库`, after?.[mark] === 'e2e 往返');
  check(`${p} PUT 未丢状态`, after?.status === before.status);
  check(`${p} 还原`, (await put(`/api/${p}/${before.id}`, before)).ok); // 不给后续断言留脏数据
}

/* 12f. SIM 点格即编（整行 PUT 曾在此静默失败） */
await evl(`document.querySelector('.tab[data-tab="sims"]').click()`);
await sleep(250);
await evl(`document.querySelector('#sims-body tr td[data-k="keepalive_action"]').click()`);
await sleep(250);
check('SIM 单元格编辑器打开', await evl(`!!document.querySelector('.cellpop input[data-f="keepalive_action"]')`) === true);
await evl(`(() => { const i = document.querySelector('.cellpop input[data-f="keepalive_action"]'); i.value = 'e2e 改过'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
await sleep(700);
check('SIM 点格即编落库', (await (await fetch(`${APP}api/sims`)).json()).some(x => x.keepalive_action === 'e2e 改过'));
check('SIM 编辑后无错误提示', await evl(`(() => { const t = document.querySelector('#toast'); return t.hidden || !t.classList.contains('err'); })()`) === true);
await evl(`document.querySelector('.tab[data-tab="subs"]').click()`);
await sleep(200);

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

/* 16. hidden 属性回归 */
await evl(`document.querySelector('#btn-add').click()`);
await sleep(250);
check('周期天数行默认隐藏', await evl(`getComputedStyle(document.querySelector('#row-cycle-days')).display`) === 'none');
await evl(`(() => { const f = document.querySelector('#form-sub'); f.elements.cycle.value = 'days'; f.elements.cycle.dispatchEvent(new Event('change')); })()`);
check('按天数行出现', await evl(`getComputedStyle(document.querySelector('#row-cycle-days')).display`) !== 'none');
await evl(`document.querySelector('#dlg-sub').close()`);

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
