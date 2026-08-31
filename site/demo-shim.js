/* Kalends 只读演示 —— 顶掉 core.js 的 api()，让界面改吃 demo-data.js 里的静态快照。
   必须排在 core.js 之后、pages.js 之前：pages.js 顶层直接调 boot()，晚一步就来不及。
   快照由真后端导出，所以这里只做取数与拒写，一行业务逻辑都不复刻。 */

'use strict';

const DEMO_READONLY = '只读演示：改动不会保存。想真用起来，本地跑一份 Kalends 就好。';

/* 供数前必须等文档解析完：pages.js 顶层就调 boot()，而 loadAll 要用的 colls() 定义在
   最后一份 collections.js 里。真后端靠网络往返天然让出到那之后，同步的快照不让就会
   撞上还没定义的 colls——症状是首屏一句「colls is not defined」，表格全空。 */
const DEMO_PARSED = new Promise(done => {
  if (document.readyState !== 'loading') done();
  else document.addEventListener('DOMContentLoaded', done, { once: true });
});

// core.js 的 api() 是全局函数声明，赋 window 上的同名属性即可整个换掉
window.api = async function (path, opts = {}) {
  await DEMO_PARSED;
  if ((opts.method || 'GET').toUpperCase() !== 'GET') throw new Error(DEMO_READONLY);
  const hit = DEMO_DATA[path.split('?')[0]];
  if (hit === undefined) throw new Error(`演示快照里没有 ${path}`);
  // 发拷贝：界面会就地改拿到的对象，直接给引用会让快照越用越脏
  return structuredClone(hit);
};

document.title = 'Kalends 演示 · 只读';

// 横幅固定在顶部，给 body 补等高的内边距——header 是普通流，不补就被盖住
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.innerHTML = `<span class="demo-tag">只读演示</span>
    <span class="demo-txt">数据是合成的，改动不会保存。快照生成于 ${DEMO_BUILT}。</span>
    <a class="demo-link" href="../">项目主页</a>
    <a class="demo-link" href="https://github.com/Lynthar/Kalends">GitHub</a>`;
  document.body.prepend(bar);
  document.body.style.paddingTop = bar.offsetHeight + 'px';
});
