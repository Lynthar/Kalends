// Kalends 端到端验证的入口（headless chromium + CDP，零第三方依赖）。
//   node scripts/e2e/run.mjs            # 全部套件
//   node scripts/e2e/run.mjs api rows   # 只跑点名的
// 每个套件都在自己的一次性实例上跑（临时数据目录、重新播种、新标签页、清空本机存储），
// 所以套件之间没有顺序依赖，也不用互相收拾。api 套件不开浏览器。
// 环境变量：KALENDS_E2E_BIN（默认 $CARGO_TARGET_DIR 或 target/ 下的 kalends）、
// KALENDS_E2E_CHROME（默认 Playwright 缓存里的 headless shell）、KALENDS_E2E_OUT、KALENDS_E2E_PORT。
import {
  APP, OUT, calendar, check, failureCount, fields, findBinary, findChrome, helpers, items, mk,
  openPage, patch, post, put, raw, seed, skip, sleep, startBrowser, startServer, stopServer,
} from './lib.mjs';

// 顺序无关；api 排第一是因为它最快、不用浏览器
const ALL = [
  'api', 'overview', 'table-view', 'persistence', 'inline-edit', 'item-form', 'fields',
  'rows', 'ledger-settings', 'a11y-style', 'regressions', 'collections',
];
const names = process.argv.slice(2);
for (const n of names) if (!ALL.includes(n)) { console.error(`没有这个套件：${n}（可选：${ALL.join(' ')}）`); process.exit(2); }

const bin = findBinary();
if (!bin) { console.error('找不到 kalends 二进制：先 cargo build，或设 KALENDS_E2E_BIN'); process.exit(2); }

let chrome = null;
for (const name of names.length ? names : ALL) {
  const mod = await import(`./${name}.mjs`);
  const needsBrowser = mod.browser !== false;
  if (needsBrowser && !chrome) {
    const shell = findChrome();
    if (!shell) { console.error('未找到 headless chromium：请 npx playwright install chromium --with-shell，或设 KALENDS_E2E_CHROME'); process.exit(2); }
    chrome = await startBrowser(shell);
  }
  console.log(`\n── ${name} ──`);
  let server;
  try { server = await startServer(bin); } catch (e) {
    console.error(String(e.message || e));
    if (chrome) chrome.kill();
    process.exit(2);
  }
  let page = null;
  try {
    const cal = await calendar();
    await seed(cal.day);
    if (needsBrowser) page = await openPage();
    const t = { APP, OUT, sleep, post, put, patch, raw, mk, items, fields, check, skip, ...cal };
    if (page) Object.assign(t, page, helpers(page.evl));
    await mod.default(t);
    if (page) {
      const errs = page.consoleMsgs.filter(m => !m.includes('favicon'));
      check(`[${name}] 无 console 错误`, errs.length === 0, JSON.stringify(errs));
      // 静态资源：index.html 引了服务端没有的路径就会在这里现形
      check(`[${name}] 静态资源全部取得到`, page.badLoads.length === 0, JSON.stringify(page.badLoads));
    }
  } catch (e) {
    // 一个套件里的异常只算它自己一条失败，别的套件照跑——负向对照才看得全
    check(`[${name}] 套件跑完没有中途抛异常`, false, String(e?.stack || e).slice(0, 800));
  } finally {
    if (page) await page.close();
    await stopServer(server);
  }
}
console.log(failureCount() ? `\n${failureCount()} FAILURES` : '\nALL PASS');
if (chrome) { console.log('截图目录：' + OUT); chrome.kill(); }
process.exit(failureCount() ? 1 : 0);
