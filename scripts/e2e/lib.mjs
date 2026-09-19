// 端到端套件的公共部分：起一次性 Kalends 实例、播种、接 headless chromium 的 CDP、
// 断言与截图。每个套件从 run.mjs 拿到同一形状的 `t`，套件之间不共享实例、页面或数据。
import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.KALENDS_E2E_PORT || 4181);
export const APP = `http://127.0.0.1:${PORT}/`;
export const OUT = process.env.KALENDS_E2E_OUT || join(os.tmpdir(), 'kalends-e2e');
const CDP_PORT = Number(process.env.KALENDS_E2E_CDP_PORT || 9333);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 一次性实例 ── */

// 二进制：KALENDS_E2E_BIN，否则 $CARGO_TARGET_DIR 或 target/ 下的 debug / release
export function findBinary() {
  if (process.env.KALENDS_E2E_BIN) return process.env.KALENDS_E2E_BIN;
  for (const dir of [process.env.CARGO_TARGET_DIR, 'target'].filter(Boolean)) {
    for (const profile of ['debug', 'release']) {
      const bin = join(dir, profile, 'kalends');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

// 数据目录是一次性的（断言里的天数按播种日推算），且在本机临时目录——SQLite 不上网络盘
export async function startServer(bin) {
  // 端口上已有人应答就是别人的实例：往里播种、末段删库都会砸到它，宁可拒绝
  if (await answering()) throw new Error(`127.0.0.1:${PORT} 已有实例在应答；停掉它或换 KALENDS_E2E_PORT`);
  const data = mkdtempSync(join(os.tmpdir(), 'kalends-e2e-data-'));
  const proc = spawn(bin, [], {
    env: { ...process.env, KALENDS_DATA: data, KALENDS_ADDR: `127.0.0.1:${PORT}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  for (let i = 0; i < 100 && proc.exitCode === null; i++) {
    try {
      if ((await fetch(APP + 'api/health')).ok && proc.exitCode === null) return { proc, data };
    } catch {}
    await sleep(100);
  }
  proc.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true });
  throw new Error(`Kalends 没起来（${bin}）：${stderr.slice(-800)}`);
}

// 端口上有没有东西在应答，不管答的是什么（设了 PIN 的实例答 401，也算有人）
async function answering() {
  try { await fetch(APP + 'api/health'); return true; } catch { return false; }
}

export async function stopServer({ proc, data }) {
  if (proc.exitCode === null) {
    const exited = new Promise(r => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
    await exited;
  }
  rmSync(data, { recursive: true, force: true });
}

/* ── 接口 ── */

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// 拿原始 Response（要断言「被拒绝」时用，post 会把错误体也当成正常结果）
export const raw = (path, method, body) => fetch(APP.replace(/\/$/, '') + path, {
  method, headers: JSON_HEADERS, body: JSON.stringify(body),
});
export const post = (path, body) => raw(path, 'POST', body).then(r => r.json());
export const put = (path, body) => raw(path, 'PUT', body);
// 条目的更新是 PATCH：局部更新语义，缺席即保持。列/库的整份序仍是 PUT
export const patch = (path, body) => raw(path, 'PATCH', body);
export const mk = (key, body) => post(`/api/collections/${key}/items`, body);
export const items = key => fetch(`${APP}api/collections/${key}/items`).then(r => r.json());
export const fields = () => fetch(APP + 'api/fields').then(r => r.json());

// 日期基准取服务端的「今天」，不拿本脚本的 UTC 日期：服务端按本地时区算 days_left，
// 非 UTC 机器上跨日的那几个小时里两者差一天，天数类断言会因一个与被测无关的理由翻
export async function calendar() {
  const today = (await (await fetch(APP + 'api/overview')).json()).today;
  const day = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  return { today, day };
}

// 每个套件都从这份假数据起步；断言里的行数、天数与名字都按它算
export async function seed(day) {
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
  await put('/api/settings', { 'ui.upcoming_days': '30' });
}

/* ── 断言 ── */

let failures = 0;
export const failureCount = () => failures;
export const check = (label, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};
// 前提不成立时的唯一出路：跳过并说明原因，不计入失败数。恒红的断言会把 ALL PASS
// 从二值信号变成"要人工判读"，久了就养成无视红字的习惯
export const skip = (label, why) => console.log(`SKIP ${label}  ——  ${why}`);

/* ── 浏览器与 CDP ── */

export function findChrome() {
  if (process.env.KALENDS_E2E_CHROME) return process.env.KALENDS_E2E_CHROME;
  const caches = [
    join(os.homedir(), 'Library/Caches/ms-playwright'),   // macOS
    join(os.homedir(), '.cache/ms-playwright'),           // Linux / WSL
    join(os.homedir(), 'AppData/Local/ms-playwright'),    // Windows
  ];
  // fs.globSync 要 node 22；只在真要开浏览器时才碰它，api 套件在 node 20 上也能跑
  if (!fs.globSync) return undefined;
  return caches
    .flatMap(c => fs.globSync(join(c, 'chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell*')))
    .filter(p => !p.endsWith('.pdb')).sort().pop();
}

export async function startBrowser(shell) {
  mkdirSync(OUT, { recursive: true });
  rmSync(join(OUT, 'profile'), { recursive: true, force: true });
  const chrome = spawn(shell, [
    `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${OUT}/profile`, '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });
  process.on('exit', () => chrome.kill());
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return chrome;
    } catch {}
  }
  chrome.kill();
  throw new Error('headless chromium 没起来');
}

// 每个套件一个新标签页：本机存储先清空（同一 origin 的 localStorage 会跨标签页），
// 再导航到刚播完种的实例，等首屏的到期列表渲染出来
export async function openPage() {
  const info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const consoleMsgs = [];
  const badLoads = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
      consoleMsgs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      consoleMsgs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    // 静态资源 404 既不抛异常也不进 console，只有网络层看得见；业务请求的 4xx 另有断言管
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400
        && ['Document', 'Script', 'Stylesheet', 'Image', 'Font', 'Manifest'].includes(m.params.type)
        && !m.params.response.url.includes('favicon'))
      badLoads.push(`${m.params.response.status} ${m.params.type} ${m.params.response.url}`);
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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Storage.clearDataForOrigin', { origin: APP.replace(/\/$/, ''), storageTypes: 'all' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { if (await evl(`document.querySelectorAll('#up-list li').length`) > 0) break; } catch {}
  }
  const close = async () => {
    ws.close();
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${info.id}`).catch(() => {});
  };
  return { send, evl, shot, consoleMsgs, badLoads, close };
}

// 表格与菜单的度量助手：多个套件共用，量的都是 #view-subs
export const helpers = (evl, sleepFn = sleep) => ({
  // 点表头 → 菜单 → 点条目
  menuClick: async (thSel, itemText) => {
    await evl(`document.querySelector('${thSel}').click()`);
    await sleepFn(200);
    const okItem = await evl(`(() => {
      const b = [...document.querySelectorAll('.thmenu .mi')].find(x => x.textContent.includes('${itemText}'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleepFn(200);
    return okItem;
  },
  dragW: dx => evl(`(() => {
    const h = document.querySelector('#view-subs th[data-k="name"] .rhandle');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 300 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 + (${dx}) }));
    window.dispatchEvent(new PointerEvent('pointerup', {}));
  })()`),
  thWidthSum: () => evl(`[...document.querySelectorAll('#view-subs th')]
    .filter(t => t.style.display !== 'none')
    .reduce((s, t) => s + t.getBoundingClientRect().width, 0)`),
  tableW: () => evl(`document.querySelector('#view-subs table').getBoundingClientRect().width`),
  // 出异常时给出 FAIL 而不是让整个套件崩掉，负向对照才跑得完整套
  evlSafe: async expr => {
    try { return { ok: true, v: await evl(expr) }; } catch (e) { return { ok: false, v: String(e.message).slice(0, 300) }; }
  },
});
