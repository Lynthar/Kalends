// 表格的本机视图层：渲染基础、子行树、排序、筛选、搜索、隐藏列、类型覆写、列宽与列序、窄窗与窄屏、schema 与 view 两层的结算。
export default async function (t) {
  const { APP, sleep, put, fields, check, skip, send, evl, shot, menuClick, dragW, thWidthSum, tableW } = t;
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
  check('＋新建行存在', await evl(`document.querySelectorAll('.newrow').length`) === 3);


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
  const wBefore = await evl(`Math.round(document.querySelector('#view-subs th[data-k="name"]').getBoundingClientRect().width)`);
  await dragW(60);
  await sleep(150);
  check('拖后 fixed 布局', await evl(`document.querySelector('#view-subs table').classList.contains('fixed')`) === true);
  const wAfter = await evl(`Math.round(document.querySelector('#view-subs th[data-k="name"]').getBoundingClientRect().width)`);
  check('列宽 +60px', Math.abs(wAfter - wBefore - 60) <= 3, `before=${wBefore} after=${wAfter}`);
  check('表宽=列宽和', Math.abs(await tableW() - await thWidthSum()) <= 2, `table=${await tableW()} sum=${await thWidthSum()}`);
  // 这条量的是文字度量，前提是 --sans 栈点名的字体至少有一个装着；一个都没有的机器上
  // 它恒红且与改动无关。探针：同一串字用「候选字体, monospace」与纯 monospace 各量一次宽度
  const NAMED_SANS = ['Avenir Next', 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei'];
  const sansInstalled = await evl(`(() => {
    const probe = family => {
      const s = document.createElement('span');
      s.textContent = '编辑续费删除MMMWWWiiil';
      s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:72px;font-family:' + family;
      document.body.appendChild(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    };
    const base = probe('monospace');
    return ${JSON.stringify(NAMED_SANS)}.some(f => probe('"' + f + '", monospace') !== base);
  })()`);
  if (sansInstalled) {
    check('操作列按钮未截断', await evl(`(() => { const td = document.querySelector('#subs-body tr td:last-child'); return td.scrollWidth <= td.clientWidth + 2; })()`) === true);
  } else {
    skip('操作列按钮未截断', `--sans 栈点名的字体本机一个都没有（${NAMED_SANS.join(' / ')}），量出来的宽度不作数`);
  }
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


  /* 17.31a. schema 与 view 是两层：字段序与「上表」跟着账本走（服务端 fields），
     列宽/列序/隐藏/排序/筛选各设备各记（本机 views）。两层唯一会打架的是列序——
     本机覆写会盖住刚排好的字段序，**由 settleView 自动结算**，不靠调用方"记得"清。 */
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
  check('表头菜单里的本机项标了「仅本机」', await evl(`(() => {
    document.querySelector('#view-subs thead th[data-k="notes"]').click();
    const txt = [...document.querySelectorAll('.thmenu .mi')].map(x => x.textContent).join('|');
    closePop();
    return txt.includes('隐藏此列（仅本机）') && txt.includes('移列与调宽…');
  })()`) === true);
  // 还原列宽住进了移列与调宽子菜单（主菜单塞不下第五项，上方钉着整份可见），
  // 且只在真有手动列宽时出现——先把前提造出来，否则这条断言没有区分度
  check('还原列宽在子菜单里且只在有手动列宽时出现', await evl(`(() => {
    views.subs.widths = { ...views.subs.widths, notes: 180 };
    openMovePop('subs', document.querySelector('#view-subs thead th[data-k="notes"]'));
    const withW = [...document.querySelectorAll('.thmenu .mi')].map(x => x.textContent).join('|');
    closePop();
    views.subs.widths = {};
    saveViews();
    openMovePop('subs', document.querySelector('#view-subs thead th[data-k="notes"]'));
    const noW = [...document.querySelectorAll('.thmenu .mi')].map(x => x.textContent).join('|');
    closePop();
    return withW.includes('还原列宽') && !noW.includes('还原列宽');
  })()`) === true);


}
