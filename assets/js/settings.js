/* Kalends 前端 · settings.js —— 设置页：通知、汇率、ICS、台账、备份、PIN。
   加载方式与作用域约定见 core.js 头注。 */

// 币种折算栏的候选＝汇率表里有的 ∪ 数据里用过的（后者可能没报价，仍列出并如实标注）
function syncFxPanel() {
  const fx = state.fx || { rates: {}, live: [] };
  const used = new Set();
  for (const c of colls()) for (const r of state[c.key] || []) if (r.currency) used.add(fxCode(r.currency));
  const codes = [...new Set([...Object.keys(fx.rates || {}), ...used])].sort();
  const sel = $('#fx-display');
  const cur = fxCode(state.settings['fx.display']);
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

function openSettings() {
  const st = state.settings;
  const f = $('#form-settings').elements;
  f.pin.value = st['auth.pin'] || '';
  f.meta_proxy.value = st['meta.proxy'] || '';
  try {
    f.thresholds.value = JSON.parse(st['notify.thresholds'] || '[]').join(',');
  } catch { f.thresholds.value = ''; }
  f.digest_time.value = st['notify.digest_time'] || '09:00';
  f.window_days.value = st['notify.window_days'] || '14';
  syncFxPanel();
  let tg = {}, em = {};
  try { tg = JSON.parse(st['notify.telegram'] || '{}'); } catch {}
  try { em = JSON.parse(st['notify.email'] || '{}'); } catch {}
  f.tg_enabled.checked = !!tg.enabled;
  f.tg_token.value = tg.bot_token || '';
  f.tg_chat.value = tg.chat_id || '';
  f.tg_proxy.value = tg.proxy || '';
  f.em_enabled.checked = !!em.enabled;
  f.em_host.value = em.host || '';
  f.em_port.value = em.port || 465;
  f.em_starttls.checked = !!em.starttls;
  f.em_user.value = em.username || '';
  f.em_pass.value = em.password || '';
  f.em_from.value = em.from || '';
  f.em_to.value = em.to || '';
  $('#ics-url').value = `${location.origin}/calendar.ics?token=${st['ics.token'] || ''}`;
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
      const when = r.threshold_days == null ? '' : (r.threshold_days === 0 ? '当天' : `提前${r.threshold_days}天`);
      const status = r.ok ? '<span class="lg-a">已发</span>'
        : `<span class="lg-a lg-bad" title="${esc(r.error || '')}">失败</span>`;
      div.innerHTML = `<span class="lg-d">${esc(localTime(r.sent_at))}</span>
        <span class="lg-n">${what}<small>${esc([r.channel, when].filter(Boolean).join(' · '))}</small></span>
        ${status}`;
      box.appendChild(div);
    }
  } catch (e) {
    box.className = 'ledger-log note';
    box.textContent = '发送记录读取失败：' + e.message;
  }
}

// sent_at 是 SQLite 的 UTC datetime；按本地时区显示，解析不动就原样给
function localTime(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function settingsBody() {
  const f = $('#form-settings').elements;
  // 空串必须先滤掉：`Number('')` 是 0，混进来就成了「只在到期当天提醒」，而界面上看不出来
  //（清空这一栏、或末尾多打一个逗号都会撞上）。留空是合法配置——后端认 `[]` ＝只发每日摘要，
  // 拿默认值把它顶回去，这条配置在界面上就永远表达不出来
  const thresholds = [...new Set(f.thresholds.value.split(/[,，\s]+/).filter(Boolean).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => b - a);
  return {
    'auth.pin': f.pin.value.replace(/[^A-Za-z0-9]/g, ''),
    'meta.proxy': f.meta_proxy.value.trim(),
    'notify.thresholds': JSON.stringify(thresholds),
    'notify.digest_time': f.digest_time.value || '09:00',
    'notify.window_days': String(+f.window_days.value || 14),
    'fx.display': f.fx_display.value,
    'notify.telegram': JSON.stringify({
      enabled: f.tg_enabled.checked, bot_token: f.tg_token.value.trim(),
      chat_id: f.tg_chat.value.trim(), proxy: f.tg_proxy.value.trim(),
    }),
    'notify.email': JSON.stringify({
      enabled: f.em_enabled.checked, host: f.em_host.value.trim(), port: +f.em_port.value || 465,
      starttls: f.em_starttls.checked, username: f.em_user.value.trim(), password: f.em_pass.value,
      from: f.em_from.value.trim(), to: f.em_to.value.trim(),
    }),
  };
}

$('#form-settings').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const body = settingsBody();
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    // 设了 PIN 就给当前浏览器立刻发一份，避免下一次请求被自己锁在门外
    if (body['auth.pin']) {
      document.cookie = `kalends_pin=${body['auth.pin']};path=/;max-age=31536000;SameSite=Lax`;
    }
    $('#dlg-settings').close();
    toast('设置已保存');
    state.settings = await api('/api/settings');
  } catch (err) { toast(err.message, true); }
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

document.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
  b.disabled = true;
  try {
    // 先落盘当前填写的配置，再触发测试
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(settingsBody()) });
    await api('/api/notify/test', { method: 'POST', body: JSON.stringify({ channel: b.dataset.test }) });
    toast('测试已发送，请查收');
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
});

$('#btn-copy-ics').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#ics-url').value);
    toast('已复制');
  } catch { $('#ics-url').select(); }
};
