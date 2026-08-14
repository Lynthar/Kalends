// 模块组合冒烟：renewals,media（默认）/ renewals / media 三种部署各起一次真实例，
// 用 headless chromium 打开首屏，看它是不是真的渲染出来了。
//
// 为什么单开一个脚本：scripts/e2e-ui.mjs 只跑默认组合，而"只装一半"是 README 明写的
// 交付形态。media-only 曾经整屏渲染不出来（前端无条件请求 /api/fx，而那个端点挂在
// renewals 路由上），后端一切正常、接口也都 200，光看默认组合永远看不见。
//
// 用法：node scripts/e2e-modules.mjs（自己起实例、自己收摊，不用先跑服务）
// 浏览器同 e2e-ui.mjs：Playwright 缓存里的 headless chromium。
import { spawn, spawnSync } from 'node:child_process';
import { globSync, mkdtempSync } from 'node:fs';
import os from 'node:os';

const BIN = process.env.KALENDS_BIN || os.homedir() + '/.cache/kalends-target/debug/kalends';
const SHELL = globSync(os.homedir() + '/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell').sort().pop();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  ' + extra));
  if (!cond) fails++;
};

async function run(modules, port, dbgPort) {
  const dir = mkdtempSync(os.tmpdir() + '/kalends-mm-');
  const srv = spawn(BIN, [], {
    stdio: 'ignore',
    env: { ...process.env, KALENDS_DATA: dir, KALENDS_ADDR: `127.0.0.1:${port}`, KALENDS_MODULES: modules },
  });
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
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = await (await fetch(`http://127.0.0.1:${dbgPort}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json(); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  ws.close();
  chrome.kill();
  srv.kill();
  await sleep(400);
}

await run('renewals,media', 4191, 9341);
await run('renewals', 4192, 9342);
await run('media', 4193, 9343);
console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
