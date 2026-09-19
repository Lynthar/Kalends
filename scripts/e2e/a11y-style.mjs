// 无障碍与样式契约：深色截图、键盘可达性（CDP 真按键）、aria 与对比度。
export default async function (t) {
  const { sleep, fields, check, send, evl, shot } = t;
  /* 17. 深色 */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(400);
  await shot('09-dark');


  await send('Emulation.setEmulatedMedia', { features: [] }); // 下面的对比度算的是浅色
  await sleep(300);

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
  check('没有认领 tab 模式（没有 role=tab / tablist）', await evl(
    `!document.querySelector('[role="tab"], [role="tablist"]')`) === true);
  check('搜索框有可访问名（placeholder 一输入就没了，不能当名字）', await evl(
    `!!document.querySelector('#t-search').getAttribute('aria-label')`) === true);

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


}
