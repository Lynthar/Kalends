// 写入路径：刷新逆序交付、同一行连续保存、保存在途时开表单、续费的在途与刷新失败、语义浮层连改、
// 表单只写动过的控件、编辑器保存失败留住输入、换图标后取消、改显示币种、字段操作写成而界面没刷新。
// 每条都用「扣住响应 / 注入失败」造出缺陷发作的那一刻，而不是指望慢机碰巧撞上。
export default async function (t) {
  const { APP, put, items, mk, fields, check, evl, waitFor, settle, sql, menuClick } = t;

  // 在页面里包一层 api：命中 __hold 的那次请求照常发出、服务端照常处理，只把响应扣住等测试放行；
  // 命中 __fail 的那次直接抛错。其余模块按全局名调用 api，所以都会走这一层
  await evl(`(() => {
    const real = api;
    window.__hold = null; window.__fail = null; window.__release = null;
    api = async (path, opts, ...rest) => {
      if (window.__fail?.(path, opts)) { window.__fail = null; throw new Error('注入的失败'); }
      const v = await real(path, opts, ...rest);
      if (window.__hold?.(path, opts)) {
        window.__hold = null;
        await new Promise(r => { window.__release = r; });
      }
      return v;
    };
    return true;
  })()`);
  const held = () => waitFor('!!window.__release');
  const release = () => evl('(() => { const r = window.__release; window.__release = null; r(); return true; })()');
  const row = async (tab, id) => (await items(tab)).find(r => r.id === id);
  const toastText = () => evl(`document.querySelector('#toast').textContent`);
  const subs0 = await items('subs');
  const A = subs0.find(r => r.name === 'Netflix');
  const B = subs0.find(r => r.name === 'iCloud+');
  const C = subs0.find(r => r.name === 'ChatGPT Plus');


  /* 1. 旧刷新晚到：改 A 触发的那轮刷新被扣在半路，期间改 B 并刷新完。放行旧的那轮不能把 B 盖回旧值，
     之后再改 B 的另一个 extra 键，服务端的 B 仍是新值。 */
  await evl(`(() => {
    window.__hold = p => p === '/api/collections/subs/items';
    window.__aDone = false;
    patchRow('subs', state.subs.find(r => r.id === ${A.id}), extraPatch('category', 'A1')).then(() => { window.__aDone = true; });
    return true;
  })()`);
  check('A 的刷新被扣在半路', await held());
  await evl(`patchRow('subs', state.subs.find(r => r.id === ${B.id}), extraPatch('category', 'B1'))`);
  check('B 改完也刷新完，页面上是新值', await evl(`state.subs.find(r => r.id === ${B.id}).extra.category`) === 'B1');
  await release();
  check('A 那轮刷新收尾', await waitFor('window.__aDone'));
  const bShown = await evl(`state.subs.find(r => r.id === ${B.id}).extra.category`);
  check('晚到的旧一轮刷新没有把 B 盖回旧值', bShown === 'B1', bShown);
  await evl(`patchRow('subs', state.subs.find(r => r.id === ${B.id}), extraPatch('payment_method', 'Card'))`);
  const b2 = await row('subs', B.id);
  check('再改 B 的另一格，服务端的新值还在',
    b2.extra.category === 'B1' && b2.extra.payment_method === 'Card', JSON.stringify(b2.extra));


  /* 2. 同一行连着两次保存（第一次的响应还在路上）：第二次对着第一次落定后的行去拼 extra，两处都留得住。 */
  await evl(`(() => {
    window.__hold = (p, o) => o?.method === 'PATCH';
    patchRow('subs', state.subs.find(r => r.id === ${C.id}), extraPatch('category', 'C1'));
    patchRow('subs', state.subs.find(r => r.id === ${C.id}), extraPatch('payment_method', 'C2'));
    return true;
  })()`);
  check('第一次保存的响应被扣住', await held());
  await release();
  await settle();
  const c2 = await row('subs', C.id);
  check('同一行连着两次保存，两处都留下了',
    c2.extra.category === 'C1' && c2.extra.payment_method === 'C2', JSON.stringify(c2.extra));


  /* 3. 上一次保存还在路上就点开同一行的详情表单：表单等它落定再开；改别的栏保存后，上一次的改动还在。 */
  await evl(`(() => {
    window.__hold = (p, o) => o?.method === 'PATCH';
    patchRow('subs', state.subs.find(r => r.id === ${A.id}), extraPatch('category', 'A3'));
    return true;
  })()`);
  check('保存的响应被扣住', await held());
  await evl(`document.querySelector('#subs-body tr[data-id="${A.id}"] [data-open]').click()`);
  check('保存落定之前表单不开', await evl(`!document.querySelector('#dlg-item')?.open`) === true);
  await release();
  check('落定之后表单打开', await waitFor(`!!document.querySelector('#dlg-item')?.open`));
  check('表单里是刚存的值', await evl(`document.querySelector('#item-fields [data-f="category"]').value`) === 'A3');
  await evl(`(() => {
    const n = document.querySelector('#item-fields [data-f="notes"]');
    n.value = '表单改的';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#form-item').requestSubmit();
    return true;
  })()`);
  await settle();
  const a3 = await row('subs', A.id);
  check('表单保存没把上一次的改动写回旧值',
    a3.extra.category === 'A3' && a3.notes === '表单改的', JSON.stringify([a3.extra, a3.notes]));


  /* 4. 续费：在途时按钮立刻变成「记账中…」、再点被拒；记成了但随后刷新失败时，提示说清已经记账，
     台账只多一笔——报成「失败」的话用户会重试，多记一笔、多推一期。 */
  const ledgerOf = async id => (await (await fetch(APP + 'api/ledger')).json()).filter(l => l.item_id === id).length;
  const led0 = await ledgerOf(A.id);
  const due0 = (await row('subs', A.id)).next_renewal;
  await evl(`(() => {
    window.__hold = p => p.endsWith('/renew');
    doRenew('subs:${A.id}', document.querySelector('#up-list [data-renew="subs:${A.id}"]'));
    return true;
  })()`);
  check('续费请求在路上', await held());
  check('按钮立刻进入在途态', await evl(`(() => {
    const b = document.querySelector('#up-list [data-renew="subs:${A.id}"]');
    return b.disabled && b.textContent.includes('记账中');
  })()`) === true);
  await evl(`doRenew('subs:${A.id}'); true`);
  check('在途时再点被拒', (await toastText()).includes('还在处理'), await toastText());
  // 放行之前布好下一步：这一笔记成之后的那轮刷新失败
  await evl(`window.__fail = p => p === '/api/overview'; true`);
  await release();
  await settle();
  const renewToast = await toastText();
  check('刷新失败时说清已经记账', renewToast.startsWith('已记账') && renewToast.includes('没刷新'), renewToast);
  check('台账只多一笔', await ledgerOf(A.id) === led0 + 1, `${led0} → ${await ledgerOf(A.id)}`);
  check('到期日推过了', (await row('subs', A.id)).next_renewal > due0);
  await evl('loadAll()');


  /* 5. 状态语义浮层同一次打开连改两项：两项都要落库，后一次不能把前一次写回原值。 */
  await evl(`openStatusSemPop('subs', 'status', document.querySelector('#view-subs th[data-k="status"]'))`);
  const flip = (v, f) => evl(`(() => {
    const r = [...document.querySelectorAll('.sempop .opt-row')].find(x => x.textContent.includes('${v}'));
    const i = r.querySelector('input[data-f="${f}"]');
    i.checked = !i.checked;
    i.dispatchEvent(new Event('change'));
    return true;
  })()`);
  const semFlag = async (v, f) => (await fields()).find(x => x.tbl === 'subs' && x.key === 'status').options.find(o => o.v === v)?.[f];
  // 用 spend 不用 alert：勾提醒会连带勾上时间线，改回去时时间线不跟着回来
  await flip('Planned', 'timeline');
  await flip('Deferred', 'spend');
  await settle();
  const [pt, ds] = [await semFlag('Planned', 'timeline'), await semFlag('Deferred', 'spend')];
  check('同一次打开连改两项，两项都落库', pt === 1 && ds === 1, JSON.stringify([pt, ds]));
  await flip('Planned', 'timeline');
  await flip('Deferred', 'spend');
  await settle();
  check('改回去也两项都生效', await semFlag('Planned', 'timeline') === 0 && await semFlag('Deferred', 'spend') === 0);
  await evl('closePop()');


  /* 6. 详情表单「打开 → 不改 → 保存」不能改写控件表达不了的存量值（词表外的状态与周期、非数字的数值）；
     只改一栏时，其余一字不变，extra 里没动的键也在。 */
  await evl(`switchTab('vps')`);
  const odd = await mk('vps', { name: '表单往返', status: 'Trial' });
  // 档位外的周期与非数字的数值接口已经拒收，只会出现在存量库里：直接写库造出来
  sql('UPDATE items SET cycle=?, extra=? WHERE id=?',
    ['yearly', JSON.stringify({ cores: '2 vCPU', ram_gb: 4, purpose: '建站' }), odd.id]);
  await evl('loadAll()');
  const plain = r => { const { updated_at: _, ...rest } = r; return JSON.stringify(rest); };
  const before = await row('vps', odd.id);
  const openForm = async () => {
    await evl(`tbodyOf('vps').querySelector('tr[data-id="${odd.id}"] [data-open]').click()`);
    return waitFor(`!!document.querySelector('#dlg-item')?.open`);
  };
  check('表单打开', await openForm());
  check('表单如实显示词表外的状态', await evl(`document.querySelector('#item-fields [data-f="status"]').value`) === 'Trial');
  check('表单如实显示档位外的周期', await evl(`document.querySelector('#item-fields [data-f="cycle"]').value`) === 'yearly');
  await evl(`document.querySelector('#form-item').requestSubmit()`);
  await settle();
  const after = await row('vps', odd.id);
  check('不改就保存，整行一字不变', plain(after) === plain(before), `${plain(before)}\n→ ${plain(after)}`);
  check('表单再开', await openForm());
  await evl(`(() => {
    const n = document.querySelector('#item-fields [data-f="notes"]');
    n.value = '只改这一栏';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#form-item').requestSubmit();
    return true;
  })()`);
  await settle();
  const after2 = await row('vps', odd.id);
  check('只改一栏，其余原样（extra 没动的键也在）',
    after2.notes === '只改这一栏' && plain({ ...after2, notes: before.notes }) === plain(before), plain(after2));


  /* 7. 就地编辑器保存失败（服务端 400）时浮层不关，用户填的东西还在。 */
  await evl(`switchTab('subs')`);
  await evl(`document.querySelector('#subs-body tr[data-id="${B.id}"] td[data-k="price"]').click()`);
  check('费用格的编辑器打开', await waitFor(`!!document.querySelector('.cellpop [data-price]')`));
  await evl(`(() => {
    document.querySelector('.cellpop [data-price]').value = '77';
    const s = document.querySelector('.cellpop [data-cur]');
    s.appendChild(new Option('X', 'X'));
    s.value = 'X';
    document.querySelector('.cellpop .cp-foot button').click();
    return true;
  })()`);
  await settle();
  check('保存被拒后编辑器还开着、填的金额还在', await evl(`document.querySelector('.cellpop [data-price]')?.value`) === '77');
  check('并且报了错', await evl(`document.querySelector('#toast').classList.contains('err')`) === true);
  await evl('closePop()');


  /* 8. 在详情表单里清除图标后点「取消」：图标已在服务端清掉，表格行也得跟上。 */
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await fetch(`${APP}api/items/${B.id}/logo?ext=png`, { method: 'POST', body: png });
  await evl('loadAll()');
  const rowImg = `!!document.querySelector('#subs-body tr[data-id="${B.id}"] img.slogo')`;
  check('图标先挂上了', await evl(rowImg) === true);
  await evl(`document.querySelector('#subs-body tr[data-id="${B.id}"] [data-open]').click()`);
  check('表单打开（清图标）', await waitFor(`!!document.querySelector('#dlg-item')?.open`));
  await evl(`document.querySelector('#item-fields [data-logo-clear]').click()`);
  check('表单里图标已清', await waitFor(`document.querySelector('#item-fields [data-logo-clear]').hidden`));
  await evl(`document.querySelector('#dlg-item [data-close]').click()`);
  check('点取消后表格行里的图标也没了', await waitFor(`!${rowImg}`));


  /* 9. 设置里改「统一显示币种」保存：月度支出当场按新币种并成一笔，不用等下一次刷新。 */
  await evl('openSettings()');
  await evl(`(() => { const f = document.querySelector('#form-settings'); f.elements.fx_display.value = 'CNY'; f.requestSubmit(); return true; })()`);
  await settle();
  check('改显示币种后当场折算',
    await evl(`document.querySelectorAll('#totals .cur').length === 1 && document.querySelector('#totals .cur .code').textContent === 'CNY'`) === true);
  await put('/api/settings', { 'fx.display': '' });
  await evl('loadAll()');


  /* 10. 字段操作写成了、界面没刷新：提示要说清已经生效（报成失败，用户会再建一列、再加一次值），
     收尾里的异常也得进提示，不能变成没人接的 rejection。两种坏法：重取字段失败、重建表头抛错。 */
  await evl(`window.addEventListener('unhandledrejection', () => { window.__rejected++; }); true`);
  const breakRebuild = `(() => { const real = ensureCollDom;
    ensureCollDom = () => { ensureCollDom = real; throw new Error('注入的失败'); }; return true; })()`;
  const failRefetch = `window.__fail = (p, o) => p === '/api/fields' && !o?.method; true`;
  const th = k => `document.querySelector('#view-subs th[data-k="${k}"]')`;
  // 字段操作不走 write 队列，settle 等不到它：清空 toast 再等下一条提示出来
  const nextToast = async act => {
    await evl(`window.__rejected = 0; document.querySelector('#toast').textContent = ''`);
    await act();
    await waitFor(`document.querySelector('#toast').textContent !== ''`);
    return toastText();
  };
  const refreshFails = async (what, inject, act, written) => {
    await evl(inject);
    const said = await nextToast(() => evl(act));
    check(`${what}：写成而界面没刷新时说清已生效`, said.includes('，但界面没刷新（注入的失败）'), said);
    check(`${what}：没有漏接的 rejection`, await evl('window.__rejected') === 0, String(await evl('window.__rejected')));
    check(`${what}：服务端确实写成了`, await written());
    await evl(`rebuildHead('subs')`);
  };
  const subsCol = async name => (await fields()).find(f => f.tbl === 'subs' && f.name === name);
  await refreshFails('建列', breakRebuild, `(() => { openNewColPop('subs', ${th('name')});
    popEl.querySelector('[data-name]').value = '收尾失败列'; popEl.querySelector('[data-go]').click(); return true; })()`,
  async () => !!await subsCol('收尾失败列'));
  const made = await subsCol('收尾失败列');
  await refreshFails('改列名', failRefetch, `(() => { openRenameColPop('subs', '${made.key}', ${th('name')});
    const i = popEl.querySelector('input'); i.value = '改过的列';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`,
  async () => !!await subsCol('改过的列'));
  await refreshFails('加状态值', breakRebuild, `(() => { openAddStatusPop('subs', 'status', ${th('status')});
    const i = popEl.querySelector('input'); i.value = 'Paused';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; })()`,
  async () => (await fields()).find(f => f.tbl === 'subs' && f.key === 'status').options.some(o => o.v === 'Paused'));
  await evl(`window.__fail = p => p === '/api/overview'; true`);
  let opened = false;
  const dropSaid = await nextToast(async () => {
    opened = await menuClick(`#view-subs th[data-k="${made.key}"]`, '删除列');
  });
  check('删列：打开表头菜单删除', opened);
  check('删列：写成而界面没刷新时说清已生效', dropSaid.includes('，但界面没刷新（注入的失败）'), dropSaid);
  check('删列：没有漏接的 rejection', await evl('window.__rejected') === 0, String(await evl('window.__rejected')));
  check('删列：服务端确实删了', !await subsCol('改过的列'));
  await evl('loadAll()');
}
