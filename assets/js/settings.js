/* Kalends 前端 · settings.js —— 设置页：通知、汇率、ICS、台账、备份、PIN。
   加载方式与作用域约定见 core.js 头注。 */

// 币种折算栏的候选＝汇率表里有的 ∪ 数据里用过的（后者可能没报价，仍列出并如实标注）∪ 现值：
// 现值不在候选里时下拉会落到「不折算」，随便保存一次别的设置就把它清掉了
function syncFxPanel() {
  const fx = state.fx || { rates: {}, live: [] };
  const cur = fxCode(state.settings['fx.display']);
  const used = new Set(cur ? [cur] : []);
  for (const c of colls()) for (const r of state[c.key] || []) if (r.currency) used.add(fxCode(r.currency));
  const codes = [...new Set([...Object.keys(fx.rates || {}), ...used])].sort();
  const sel = $('#fx-display');
  sel.innerHTML = '<option value="">不折算（分币种显示）</option>'
    + codes.map(c => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}${fx.rates[c] ? '' : '（无汇率）'}</option>`).join('');
  $('#fx-status').textContent = !fx.baseline_period
    ? '汇率表没有加载，费用一律按原币显示。'
    : fx.live?.length
      ? `实时汇率 ${fx.live.length} 种，取自 ${fx.fetched_at || '未知日期'}（${fx.source}）；其余用内置平均汇率 ${fx.baseline_period}`
      : `当前用内置平均汇率（${fx.baseline_period}）。未拉过实时汇率——这是唯一一处按需出网，不点就不发生。`;
}

$('#fx-refresh').onclick = async e => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    state.fx = await api('/api/fx/refresh', { method: 'POST', body: '{}' });
    syncFxPanel();
    toast(`已更新 ${state.fx.live.length} 种汇率`);
    renderAll();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = '拉取实时汇率';
};

// SMTP 端口的默认值住在声明的 notify.email JSON 里，不另设一项
const smtpPortDefault = () => JSON.parse(state.defaults['notify.email']).port;

function openSettings() {
  const st = state.settings, D = state.defaults;
  const f = $('#form-settings').elements;
  f.pin.value = st['auth.pin'] || '';
  f.meta_proxy.value = st['meta.proxy'] || '';
  // 占位串只能是举例：写成默认列表的样子，就和标签上的「留空＝只发每日摘要」打架
  f.thresholds.placeholder = `如 ${JSON.parse(D['notify.thresholds']).join(',')}`;
  const broken = [];
  try {
    const th = JSON.parse(st['notify.thresholds'] || '[]');
    if (!Array.isArray(th)) throw new Error('不是数组');
    f.thresholds.value = th.join(',');
  } catch { f.thresholds.value = ''; broken.push('提醒阈值'); }
  f.digest_time.value = st['notify.digest_time'] || D['notify.digest_time'];
  f.window_days.value = st['notify.window_days'] || D['notify.window_days'];
  syncFxPanel();
  let tg = {}, em = {};
  try { tg = JSON.parse(st['notify.telegram'] || '{}'); } catch { broken.push('Telegram 配置'); }
  try { em = JSON.parse(st['notify.email'] || '{}'); } catch { broken.push('邮件配置'); }
  f.tg_enabled.checked = !!tg.enabled;
  f.tg_token.value = tg.bot_token || '';
  f.tg_chat.value = tg.chat_id || '';
  f.tg_proxy.value = tg.proxy || '';
  f.em_enabled.checked = !!em.enabled;
  f.em_host.value = em.host || '';
  f.em_port.placeholder = smtpPortDefault();
  f.em_port.value = em.port || smtpPortDefault();
  f.em_starttls.checked = !!em.starttls;
  f.em_user.value = em.username || '';
  f.em_pass.value = em.password || '';
  f.em_from.value = em.from || '';
  f.em_to.value = em.to || '';
  $('#ics-url').value = `${location.origin}/calendar.ics?token=${st['ics.token'] || ''}`;
  // 存着的渠道配置解析不出来时，上面那圈会把它渲染成「渠道关着、字段全空」——用户一保存，
  // settingsBody() 就用这些空值把凭据覆盖掉。停掉保存并说出来，别让它悄悄发生
  f.tg_enabled.closest('fieldset').disabled = broken.includes('Telegram 配置');
  f.em_enabled.closest('fieldset').disabled = broken.includes('邮件配置');
  // 阈值同理：表单显示成空、读侧却在按默认值发，一保存就写成 []，逐项提醒静默关掉。
  // 原因写在框顶、框开着就一直在：toast 几秒就没了，停用的保存键却还停着
  $('#form-settings').querySelector('button[type=submit]').disabled = broken.length > 0;
  $('#settings-note').hidden = !broken.length;
  $('#settings-note').textContent = broken.length
    ? `存着的${broken.join('、')}读不出来，保存已停用：保存会用表单里的空值盖掉它` : '';
  $('#dlg-settings').showModal();
  loadLedger();
  loadNotifyLog(); // 不挡对话框，读回来再填
}

// 续费台账的只读列表：条目或库删掉之后旧账仍在（那是历史），名字取不到就回落到编号
async function loadLedger() {
  const box = $('#ledger-list');
  box.textContent = '读取中…';
  box.className = 'ledger-log note';
  try {
    const rows = await api('/api/ledger');
    box.className = 'ledger-log';
    if (!rows.length) {
      box.className = 'ledger-log note';
      box.textContent = '还没有记过账——表格里点「已续费 / 已保号」就会写一笔';
      return;
    }
    box.innerHTML = '';
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'lg-row';
      div.innerHTML = `<span class="lg-d">${esc(r.renewed_at)}</span>
        <span class="lg-n">${esc(r.item_name || `#${r.item_id}`)}<small>${esc(r.coll_name || r.kind)}</small></span>
        <span class="lg-a">${amtHtml(r.currency, r.amount)}</span>`;
      box.appendChild(div);
    }
  } catch (e) {
    box.className = 'ledger-log note';
    box.textContent = '台账读取失败：' + e.message;
  }
}

// 通知投递记录的只读列表：投递失败的原因要在界面上看得见，不能只活在服务端日志里。
// covered 是折叠档位的记账行、不是一次真实投递，列出来只会把一次提醒显示成好几条。
async function loadNotifyLog() {
  const box = $('#notify-log');
  box.textContent = '读取中…';
  box.className = 'ledger-log note';
  try {
    const rows = (await api('/api/notify/log')).filter(r => r.error !== 'covered');
    box.className = 'ledger-log';
    if (!rows.length) {
      box.className = 'ledger-log note';
      box.textContent = '还没有发过通知——开渠道后每次投递都会在这里记一条';
      return;
    }
    box.innerHTML = '';
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'lg-row';
      const what = r.kind === 'digest' ? '每日摘要' : esc(r.item_name || `#${r.item_id}`);
      const when = r.threshold_days == null ? '' : r.threshold_days > 0 ? `提前${r.threshold_days}天`
        : r.due_date < localDay(r.sent_at) ? '逾期' : '当天'; // 0 档也管逾期项，逾期只提醒一次
      const status = r.ok ? '<span class="lg-a">已发</span>' : '<span class="lg-a lg-bad">失败</span>';
      // 失败原因另起一行写出来：只放在悬停提示里的话，触屏与键盘都读不到，而排查第一步就靠它
      const why = r.ok || !r.error ? '' : `<small class="lg-why">${esc(r.error)}</small>`;
      div.innerHTML = `<span class="lg-d">${esc(localTime(r.sent_at))}</span>
        <span class="lg-n">${what}<small>${esc([r.channel, when].filter(Boolean).join(' · '))}</small>${why}</span>
        ${status}`;
      box.appendChild(div);
    }
  } catch (e) {
    box.className = 'ledger-log note';
    box.textContent = '发送记录读取失败：' + e.message;
  }
}

// sent_at 是 SQLite 的 UTC datetime；按本地时区显示，解析不动就原样给
const sentDate = s => new Date(String(s).replace(' ', 'T') + 'Z');
const pad2 = n => String(n).padStart(2, '0');
function localTime(s) {
  const d = sentDate(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 发送那天的本地日期（YYYY-MM-DD），与 due_date 同一种写法；解析不动给空串
function localDay(s) {
  const d = sentDate(s);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function settingsBody() {
  const f = $('#form-settings').elements, D = state.defaults;
  // 空串必须先滤掉：`Number('')` 是 0，混进来就成了「只在到期当天提醒」，而界面上看不出来
  //（清空这一栏、或末尾多打一个逗号都会撞上）。留空是合法配置——后端认 `[]` ＝只发每日摘要，
  // 拿默认值把它顶回去，这条配置在界面上就永远表达不出来
  const thresholds = [...new Set(f.thresholds.value.split(/[,，\s]+/).filter(Boolean).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => b - a);
  return {
    // 原样交给后端判：前端先剥掉符号的话，`12-34` 存成 `1234`、全是符号的存成空串＝关掉了门
    'auth.pin': f.pin.value.trim(),
    'meta.proxy': f.meta_proxy.value.trim(),
    'notify.thresholds': JSON.stringify(thresholds),
    'notify.digest_time': f.digest_time.value || D['notify.digest_time'],
    'notify.window_days': String(+f.window_days.value || D['notify.window_days']),
    'fx.display': f.fx_display.value,
    'notify.telegram': JSON.stringify({
      enabled: f.tg_enabled.checked, bot_token: f.tg_token.value.trim(),
      chat_id: f.tg_chat.value.trim(), proxy: f.tg_proxy.value.trim(),
    }),
    'notify.email': JSON.stringify({
      enabled: f.em_enabled.checked, host: f.em_host.value.trim(), port: +f.em_port.value || smtpPortDefault(),
      starttls: f.em_starttls.checked, username: f.em_user.value.trim(), password: f.em_pass.value,
      from: f.em_from.value.trim(), to: f.em_to.value.trim(),
    }),
  };
}

$('#form-settings').addEventListener('submit', async e => {
  e.preventDefault();
  let body;
  try { body = settingsBody(); } catch (err) { return void toast(err.message, true); }
  // 存完整轮刷新：显示币种这类设置改的是整页的呈现，只重读设置的话要等下次刷新才折算
  const ok = await write('settings', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    // 设了 PIN 就给当前浏览器立刻发一份，避免接下来的刷新被自己锁在门外
    if (body['auth.pin']) {
      document.cookie = `kalends_pin=${body['auth.pin']};path=/;max-age=31536000;SameSite=Lax`;
    }
  }, { done: () => '设置已保存' });
  if (ok) $('#dlg-settings').close();
});

$('#btn-backup').onclick = async () => {
  const b = $('#btn-backup');
  b.disabled = true;
  try {
    const r = await api('/api/backup', { method: 'POST', body: '{}' });
    toast(`已备份：${r.snapshot.split('/').pop()}`);
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
};

// 测的是表单里这个渠道的当前值，不落盘：点完再取消就是什么都没改（占位串由后端换回库里的密钥）
document.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
  b.disabled = true;
  try {
    const channel = b.dataset.test;
    const config = settingsBody()[`notify.${channel}`];
    await api('/api/notify/test', { method: 'POST', body: JSON.stringify({ channel, config }) });
    toast('测试已发送，请查收——设置还没保存');
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
});

// 经 http:// 访问局域网地址时没有 navigator.clipboard（只给安全上下文），退到 execCommand；仍不行就说一声
$('#btn-copy-ics').onclick = async () => {
  const box = $('#ics-url');
  try {
    await navigator.clipboard.writeText(box.value);
    return void toast('已复制');
  } catch { /* 往下退 */ }
  box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 当作没复制成 */ }
  toast(ok ? '已复制' : '浏览器不让网页写剪贴板：链接已选中，请手动复制', !ok);
};
