// 模块组合冒烟：三种 KALENDS_MODULES 部署各起一次真实例，headless chromium 看首屏是否
// 真的渲染出来（e2e-ui 只跑默认组合，"只装一半"的缺陷它永远看不见）。
// 用法：node scripts/e2e-modules.mjs——自己起实例自己收摊；浏览器同 e2e-ui.mjs。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync } from 'node:fs';
import os from 'node:os';

// 这个脚本自己起实例，所以两样东西都得先确认在场：二进制与浏览器。
// 缺了直接 spawn 的话，ENOENT 是以 error 事件抛出来的——绕过 try/catch，
// 崩出来的是一串看不出所以然的 syscall 堆栈
const BIN = process.env.KALENDS_BIN || os.homedir() + '/.cache/kalends-target/debug/kalends';
if (!existsSync(BIN)) {
  console.error(`找不到二进制 ${BIN}：先 cargo build，或用 KALENDS_BIN 指一个`);
  process.exit(2);
}
// 浏览器的找法与 e2e-ui.mjs 保持一致：缓存里找不到就认 KALENDS_E2E_CHROME，
// 两样都没有时给一句人话——不给的话 spawn(undefined) 抛一个看不出所以然的异常
const SHELL = process.env.KALENDS_E2E_CHROME || globSync(
  os.homedir() + '/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell'
).sort().pop();
if (!SHELL) {
  console.error('未找到 headless chromium：请 npx playwright install chromium --with-shell，或设 KALENDS_E2E_CHROME');
  process.exit(2);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  ' + extra));
  if (!cond) fails++;
};

async function run(modules, port, dbgPort) {
  const stop = [];
  try {
    await drive(modules, port, dbgPort, stop);
  } finally {
    // 起了什么就收什么：中途抛异常（浏览器连不上是常客）也不能把实例留在后台占着端口
    for (const kill of stop.reverse()) { try { kill(); } catch {} }
    await sleep(400);
  }
}

async function drive(modules, port, dbgPort, stop) {
  const dir = mkdtempSync(os.tmpdir() + '/kalends-mm-');
  const srv = spawn(BIN, [], {
    stdio: 'ignore',
    env: { ...process.env, KALENDS_DATA: dir, KALENDS_ADDR: `127.0.0.1:${port}`, KALENDS_MODULES: modules },
  });
  stop.push(() => srv.kill());
  const APP = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(APP + 'api/health')).ok) break; } catch {}
    await sleep(250);
  }
  // 有续费模块就播一条，好让"表格里有行"这件事有意义
  if (modules.includes('renewals')) {
    await fetch(APP + 'api/collections/subs/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '模块矩阵', status: 'Active', cycle: 'monthly', next_renewal: '2026-12-01', price: 5, currency: 'USD' }),
    });
  }
  if (modules.includes('media')) {
    await fetch(APP + 'api/media', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: '电影', title: '模块矩阵电影', year: 2020, status: '看过' }),
    });
  }

  const chrome = spawn(SHELL, [`--remote-debugging-port=${dbgPort}`, '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${dir}/profile`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  stop.push(() => chrome.kill());
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = await (await fetch(`http://127.0.0.1:${dbgPort}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json(); } catch {}
  }
  if (!target) throw new Error(`连不上调试端口 ${dbgPort}：浏览器没起来，或这个端口被占着`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  stop.push(() => ws.close());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evl = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result?.value;
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);

  const info = await evl(`JSON.stringify({
    modules: window.KALENDS_MODULES,
    subsRows: document.querySelectorAll('#subs-body tr').length,
    mediaCards: document.querySelectorAll('#m-wall .card, #m-body tr').length,
    toast: document.querySelector('#toast')?.hidden === false ? document.querySelector('#toast').textContent : '',
    navR: !document.querySelector('.nav-tab[data-page="renewals"]')?.hidden,
    navM: !document.querySelector('.nav-tab[data-page="media"]')?.hidden,
  })`);
  const st = JSON.parse(info || '{}');
  console.log(`\n=== KALENDS_MODULES=${modules} ===`, JSON.stringify(st));
  if (modules.includes('renewals')) check(`${modules}：续费表渲染出行了`, st.subsRows > 0, JSON.stringify(st));
  if (modules.includes('media')) check(`${modules}：媒体渲染出条目了`, st.mediaCards > 0, JSON.stringify(st));
  check(`${modules}：首屏没有报错 toast`, !st.toast, st.toast);
  check(`${modules}：没有 console 异常`, errors.length === 0, errors.join(' | '));
}

// 一种组合崩了不该带走另外两种：记成 FAIL，矩阵照跑完
for (const [modules, port, dbgPort] of [['renewals,media', 4191, 9341], ['renewals', 4192, 9342], ['media', 4193, 9343]]) {
  try {
    await run(modules, port, dbgPort);
  } catch (e) {
    check(`${modules}：跑得起来`, false, String(e?.message || e));
  }
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
