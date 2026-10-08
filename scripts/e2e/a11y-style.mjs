// 无障碍与样式契约：深色截图、键盘可达性（CDP 真按键）、aria 与对比度。

// 页面里算 WCAG 对比度的几样：rgb() 与 #hex 都认，ratio 取两色亮度比
const CONTRAST = `
  const lin = c => (c /= 255, c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = rgb => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const rgbOf = v => v.trim().startsWith('#')
    ? [0, 2, 4].map(i => parseInt(v.trim().slice(1).slice(i, i + 2), 16)) : v.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const ratio = (a, b) => { const [hi, lo] = [L(a), L(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const token = name => rgbOf(getComputedStyle(document.documentElement).getPropertyValue(name));`;
// 点名行（算不出到期日 / 状态不在词表里）是小字，在三种底上都要过 4.5
const NOTE_CONTRAST = `(() => {${CONTRAST}
  const ink = rgbOf(getComputedStyle(document.querySelector('#up-undated')).color);
  return ['--bg', '--surface', '--surface-2'].map(b => +ratio(ink, token(b)).toFixed(2));
})()`;
// 设置框顶的坏配置原因是红色小字，框底是 --surface：是 --coral-ink 且过 4.5
const SETTINGS_NOTE = `(() => {${CONTRAST}
  const ink = rgbOf(getComputedStyle(document.querySelector('#settings-note')).color);
  return { red: ink.join() === token('--coral-ink').join(), ratio: +ratio(ink, token('--surface')).toFixed(2) };
})()`;

export default async function (t) {
  const { sleep, fields, check, skip, send, evl, shot, waitFor } = t;
  /* 17. 深色 */
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(400);
  await shot('09-dark');
  // toast 是唯一的成败反馈：白字压在渐变上，成功与失败两种底的两端都要过 4.5
  const toastRatios = await evl(`(() => {${CONTRAST}
    const t = document.querySelector('#toast');
    const ends = err => { t.classList.toggle('err', err); const cs = getComputedStyle(t);
      return cs.backgroundImage.match(/rgba?\\([^)]+\\)/g).map(c => +ratio(rgbOf(cs.color), rgbOf(c)).toFixed(2)); };
    const out = [...ends(false), ...ends(true)];
    t.classList.remove('err');
    return out;
  })()`);
  check('深色 toast 白字在两种底的渐变两端都过 4.5', toastRatios.every(r => r >= 4.5), JSON.stringify(toastRatios));
  const darkNote = await evl(NOTE_CONTRAST);
  check('深色点名行在三种底上都过 4.5', darkNote.every(r => r >= 4.5), JSON.stringify(darkNote));
  const darkSetNote = await evl(SETTINGS_NOTE);
  check('深色设置框的坏配置原因是红字且过 4.5', darkSetNote.red && darkSetNote.ratio >= 4.5, JSON.stringify(darkSetNote));


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
  // ⚙ 的内容只有一个符号；地址框没有 label；对话框不指向标题，读屏进框只会念「对话框」
  const unnamed = await evl(`(() => {
    itemDialog(); collDialog();
    const named = el => !!el?.getAttribute('aria-label')?.trim()
      || !!document.getElementById(el?.getAttribute('aria-labelledby') || '')?.textContent.trim();
    return ['#coll-settings', '#ics-url', '#dlg-settings', '#dlg-item', '#dlg-coll'].filter(s => !named(document.querySelector(s)));
  })()`);
  check('⚙、日历地址框与三个对话框都有可访问名', unnamed.length === 0, JSON.stringify(unnamed));

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

  // 就地编辑器里的输入框：单输入框的 label 里没有文字，「新选项」框只有 placeholder——都得另给名字；
  // 造型与筛选框同一套，不论包在哪种容器里
  const popInput = async (tab, k, sel) => {
    await evl(`switchTab('${tab}')`);
    await evl(`tbodyOf('${tab}').querySelector('tr:not(.subrow) td[data-k="${k}"]').click()`);
    await waitFor(`!!document.querySelector('.cellpop ${sel}')`);
    const r = await evl(`(() => {
      const i = document.querySelector('.cellpop ${sel}');
      return { name: i?.getAttribute('aria-label') || '', radius: i ? getComputedStyle(i).borderTopLeftRadius : '' };
    })()`);
    await evl('closePop()');
    return r;
  };
  const noteIn = await popInput('subs', 'notes', 'input[data-f="notes"]');
  check('单输入框以列名为可访问名', noteIn.name !== '' && noteIn.name === await evl(`colLabel('subs', 'notes')`), noteIn.name);
  const selAdd = await popInput('subs', 'category', '.opt-add input');
  check('单选的「新选项」框有可访问名', selAdd.name !== '');
  const multiAdd = await popInput('sims', 'forms', '.opt-add input');
  check('多选的「新选项」框有可访问名', multiAdd.name !== '');
  check('浮层里不在 .fp-form 中的输入框也有统一造型', [noteIn, selAdd, multiAdd].every(x => x.radius === '10px'),
    JSON.stringify([noteIn.radius, selAdd.radius, multiAdd.radius]));
  await evl(`switchTab('subs')`);

  // 对比度：算给机器看，比目检稳。小字要 4.5，最差那一档是 --surface-2 当底（表头底/行悬停底）
  check('浅色 --ink-2 在三种底上都过 WCAG AA 的 4.5', await evl(`(() => {${CONTRAST}
    return ['--bg', '--surface', '--surface-2'].every(b => ratio(token('--ink-2'), token(b)) >= 4.5);
  })()`) === true);
  const lightNote = await evl(NOTE_CONTRAST);
  check('浅色点名行在三种底上都过 4.5', lightNote.every(r => r >= 4.5), JSON.stringify(lightNote));
  const lightSetNote = await evl(SETTINGS_NOTE);
  check('浅色设置框的坏配置原因是红字且过 4.5', lightSetNote.red && lightSetNote.ratio >= 4.5, JSON.stringify(lightSetNote));

  /* 样式契约：深浅色下的原生控件、减弱动态、折叠区的键盘焦点、吸附格底色、窄屏居中、触屏命中区 */
  check('页面声明了 color-scheme，原生控件跟着深浅色走', await evl(
    `getComputedStyle(document.documentElement).colorScheme`) === 'light dark');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('减弱动态时背景光斑也停下（它们在 body 的伪元素上）', await evl(
    `[getComputedStyle(document.body, '::before').animationName, getComputedStyle(document.body, '::after').animationName].every(n => n === 'none')`) === true);
  await send('Emulation.setEmulatedMedia', { features: [] });

  // 到期栏折叠后，Tab 不该走进看不见的「已续费」按钮（回车就对看不见的条目弹续费确认）
  await evl(`state.upFolded || toggleUpFold()`);
  await evl(`document.querySelector('#up-window').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  check('到期栏折叠后 Tab 跳过里面的按钮', await evl(`(() => {
    const a = document.activeElement;
    return a !== document.body && !document.querySelector('#up-body').contains(a);
  })()`) === true, await evl(`document.activeElement?.outerHTML.slice(0, 100)`));
  await evl(`state.upFolded && toggleUpFold()`);

  // 深色下被勾选行的吸附首格：底色必须不透明，否则横滚时后面几列透出来压在名称上
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await evl(`switchTab('subs')`);
  await evl(`document.querySelector('#subs-body tr [data-sel]').click()`);
  const c0Bg = await evl(`getComputedStyle(document.querySelector('#subs-body tr.selrow td.c0')).backgroundColor`);
  const alpha = (c0Bg.match(/[\d.]+/g) || [])[3];
  check('深色下勾选行的吸附首格底色不透明', alpha === undefined || +alpha === 1, c0Bg);
  await send('Emulation.setEmulatedMedia', { features: [] });

  // 390 px：批量条与长 toast 都居中，且能用满视口宽度（不再只占右半边、按钮竖排）
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  const bar = await evl(`(() => {
    const b = document.querySelector('#bulkbar'), r = b.getBoundingClientRect();
    const tops = [...b.querySelectorAll('button')].map(x => Math.round(x.getBoundingClientRect().top));
    // 按钮文字各自只占一行（旧写法下批量条只有半个视口宽，按钮里的字被挤成两行）
    const lines = [...b.querySelectorAll('button')].map(x => { const rg = document.createRange(); rg.selectNodeContents(x); return rg.getClientRects().length; });
    return { mid: r.left + r.width / 2, vw: innerWidth, oneRow: new Set(tops).size === 1, lines, w: Math.round(r.width) };
  })()`);
  check('窄屏批量条居中、按钮排成一行且字不折行', Math.abs(bar.mid - bar.vw / 2) <= 1 && bar.oneRow && bar.lines.every(n => n === 1), JSON.stringify(bar));
  await evl(`toast('这是一条很长很长的提示，用来看它在窄屏上能不能用满宽度，而不是挤成好几行')`);
  await sleep(600);
  const tst = await evl(`(() => { const r = document.querySelector('#toast').getBoundingClientRect();
    return { mid: r.left + r.width / 2, w: r.width, vw: innerWidth }; })()`);
  check('窄屏长 toast 居中且用得上大半个视口', Math.abs(tst.mid - tst.vw / 2) <= 1 && tst.w > tst.vw * 0.7, JSON.stringify(tst));
  await evl(`clearAllSel()`);
  // 设置框里日历地址很长，旁边的「复制」不能被挤成两行
  await evl(`openSettings()`);
  const copyLines = await evl(`(() => {
    const rg = document.createRange();
    rg.selectNodeContents(document.querySelector('#btn-copy-ics'));
    return rg.getClientRects().length;
  })()`);
  check('窄屏设置框里「复制」不折行', copyLines === 1, copyLines);
  await evl(`document.querySelector('#dlg-settings').close()`);

  // 触屏没有悬停：行首复选框与 ⤢ 是删除与完整表单的唯一入口，得常显且命中区 ≥ 24 px（WCAG 2.5.8）
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
  await sleep(300);
  if (!await evl(`matchMedia('(hover: none)').matches`)) {
    skip('触屏常显行首入口', '这个浏览器模拟不出 (hover: none)');
  } else {
    const touch = await evl(`(() => {
      const tr = document.querySelector('#subs-body tr');
      const box = el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, l: r.left, r: r.right, op: +getComputedStyle(el).opacity }; };
      return { sel: box(tr.querySelector('[data-sel]')), grip: box(tr.querySelector('[data-grip]')), open: box(tr.querySelector('[data-open]')) };
    })()`);
    const big = b => b.w >= 24 && b.h >= 24 && b.op > 0;
    check('触屏上行首复选框、拖手与 ⤢ 常显且命中区 ≥ 24 px', big(touch.sel) && big(touch.grip) && big(touch.open), JSON.stringify(touch));
    check('触屏上拖手与复选框不重叠', touch.grip.r <= touch.sel.l || touch.sel.r <= touch.grip.l, JSON.stringify(touch));
    await evl(`(() => { const t = document.querySelector('#toast'); clearTimeout(t._h); t.hidden = true;
      document.querySelector('#view-subs').scrollIntoView(); })()`);
    await sleep(300);
    await shot('31-touch-390');
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
}
