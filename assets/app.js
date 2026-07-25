'use strict';

const $ = s => document.querySelector(s);
const MODULES = window.KALENDS_MODULES || ['renewals', 'media'];
const state = {
  overview: null, subs: [], sims: [], vps: [], settings: {}, media: [],
  tab: 'subs', subFilter: 'Active', simFilter: '全部', vpsFilter: '全部',
  page: 'renewals', mKind: '全部', mStatus: '全部', mQ: '', mSort: 'marked', mView: 'wall',
};

const CYCLE_LABEL = {
  weekly: '周付', monthly: '月付', quarterly: '季付', semiannual: '半年付',
  annual: '年付', biennial: '两年付', triennial: '三年付', lifetime: '买断', days: '按天数',
};
const SUB_STATUSES = ['Active', 'Planned', 'Deferred', 'Ended', '全部'];
const SIM_STATUSES = ['启用', '准备', '未启用', '已结束', '全部'];
const VPS_STATUSES = ['启用', '准备', '预结束', '未启用', '已结束', '全部'];

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, err ? 4200 : 1800);
}

async function api(path, opts = {}, mayAskPin = true) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401 && mayAskPin) {
    const pin = prompt('此 Kalends 设置了访问 PIN，请输入：');
    if (pin != null && pin !== '') {
      document.cookie = `kalends_pin=${pin};path=/;max-age=31536000;SameSite=Lax`;
      return api(path, opts, false);
    }
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (c, p) => (p == null || !c) ? '' : `${c} ${Number(p).toFixed(2)}`;

// 仅放行 http/https，防止 url 字段存入 javascript: 等协议
function safeUrl(u) {
  try {
    const p = new URL(u);
    return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '';
  } catch { return ''; }
}

async function loadAll() {
  const hasR = MODULES.includes('renewals');
  const hasM = MODULES.includes('media');
  [state.overview, state.subs, state.sims, state.vps, state.settings, state.media] =
    await Promise.all([
      hasR ? api('/api/overview') : { today: '', upcoming: [], totals: [] },
      hasR ? api('/api/subscriptions') : [],
      hasR ? api('/api/sims') : [],
      hasR ? api('/api/vps') : [],
      api('/api/settings'),
      hasM ? api('/api/media') : [],
    ]);
  renderAll();
}

function renderAll() {
  renderUpcoming();
  renderTotals();
  renderChips();
  renderSubs();
  renderSims();
  renderVps();
  renderMedia();
}

/* ── 即将到期 ── */
function renderUpcoming() {
  const { upcoming, today } = state.overview;
  $('#today-note').textContent = `今日 ${today}`;
  const ol = $('#up-list');
  ol.innerHTML = '';
  $('#up-empty').hidden = upcoming.length > 0;
  upcoming.forEach((it, idx) => {
    const d = it.days_left;
    const cls = d < 0 ? 'd-over' : d <= 3 ? 'd-soon' : d <= 7 ? 'd-week' : 'd-far';
    const daysTxt = d < 0 ? `${-d}<small>天前</small>` : d === 0 ? `今<small>到期</small>` : `${d}<small>天后</small>`;
    const meta = [it.kind === 'sim' ? 'SIM' : '订阅', it.cycle, it.action].filter(Boolean).join(' · ');
    const li = document.createElement('li');
    li.className = cls;
    li.style.setProperty('--i', idx);
    li.innerHTML = `
      <span class="days">${daysTxt}</span>
      <span class="due">${esc(it.due)}</span>
      <span class="what"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(meta)}</div></span>
      <span class="amt">${esc(money(it.currency, it.price))}</span>
      <button class="btn mini ghost" data-renew="${it.kind}:${it.id}" type="button">${it.kind === 'sim' ? '已保号' : '已续费'}</button>`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('[data-renew]').forEach(b => b.onclick = () => doRenew(b.dataset.renew));
}

async function doRenew(key) {
  const [kind, id] = key.split(':');
  const list = kind === 'sim' ? state.sims : kind === 'vps' ? state.vps : state.subs;
  const item = list.find(x => x.id === +id);
  const label = item ? (item.name || item.vendor || '') : '';
  if (!confirm(`记一笔「${label}」的${kind === 'sim' ? '保号' : '续费'}？`)) return;
  const path = kind === 'sim' ? `/api/sims/${id}/renew`
    : kind === 'vps' ? `/api/vps/${id}/renew`
    : `/api/subscriptions/${id}/renew`;
  try {
    await api(path, { method: 'POST', body: '{}' });
    toast('已记账，周期已推进');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 支出 ── */
function renderTotals() {
  const el = $('#totals');
  const ts = state.overview.totals;
  el.innerHTML = ts.length ? '' : '<span class="note">暂无在订支出</span>';
  for (const t of ts) {
    const div = document.createElement('div');
    div.className = 'cur';
    div.innerHTML = `<span class="code">${esc(t.currency)}</span>
      <span class="m">${t.monthly.toFixed(2)}<span style="font-size:.7rem">/月</span></span>
      <span class="y">≈ ${t.annual.toFixed(2)} /年</span>`;
    el.appendChild(div);
  }
}

/* ── 筛选 chips ── */
function renderChips() {
  const cfg = {
    subs: { list: SUB_STATUSES, cur: state.subFilter, rows: state.subs, set: v => { state.subFilter = v; }, rerender: renderSubs },
    sims: { list: SIM_STATUSES, cur: state.simFilter, rows: state.sims, set: v => { state.simFilter = v; }, rerender: renderSims },
    vps: { list: VPS_STATUSES, cur: state.vpsFilter, rows: state.vps, set: v => { state.vpsFilter = v; }, rerender: renderVps },
  }[state.tab];
  const wrap = $('#chips');
  wrap.innerHTML = '';
  const counts = {};
  for (const it of cfg.rows) counts[it.status] = (counts[it.status] || 0) + 1;
  for (const st of cfg.list) {
    const n = st === '全部' ? cfg.rows.length : (counts[st] || 0);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (st === cfg.cur ? ' on' : '');
    b.innerHTML = `${esc(st)}<b>${n}</b>`;
    b.onclick = () => {
      cfg.set(st);
      renderChips();
      cfg.rerender();
    };
    wrap.appendChild(b);
  }
}

/* ── 订阅表 ── */
function renderSubs() {
  const tb = $('#subs-body');
  tb.innerHTML = '';
  const byId = Object.fromEntries(state.subs.map(x => [x.id, x]));
  let rows = state.subs;
  if (state.subFilter !== '全部') rows = rows.filter(x => x.status === state.subFilter);
  rows = [...rows].sort((a, b) => {
    const ka = (a.parent_id && byId[a.parent_id] ? byId[a.parent_id].name + '~' : a.name + ' ');
    const kb = (b.parent_id && byId[b.parent_id] ? byId[b.parent_id].name + '~' : b.name + ' ');
    return (ka + a.name).localeCompare(kb + b.name, 'zh');
  });
  $('#subs-empty').hidden = rows.length > 0;
  for (const it of rows) {
    const parent = it.parent_id ? byId[it.parent_id] : null;
    const cyc = it.cycle === 'days' ? `每 ${it.cycle_days ?? '?'} 天` : (CYCLE_LABEL[it.cycle] || '');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${parent ? `<span class="sub-parent">${esc(parent.name)} ↳ </span>` : ''}${esc(it.name)}
        ${safeUrl(it.url) ? ` <a class="btn link" href="${esc(safeUrl(it.url))}" target="_blank" rel="noreferrer">↗</a>` : ''}</td>
      <td class="muted">${esc(it.category || '')}</td>
      <td class="amt">${esc(money(it.currency, it.price))}</td>
      <td class="muted">${esc(cyc)}</td>
      <td class="muted">${esc(it.next_renewal || '')}</td>
      <td class="muted">${esc(it.payment_method || '')}</td>
      <td class="muted clip" title="${esc(it.notes || '')}">${esc(it.notes || '')}</td>
      <td class="ops">
        ${it.status === 'Active' && it.next_renewal ? `<button class="btn link" data-renew type="button">记续费</button>` : ''}
        <button class="btn link" data-edit type="button">编辑</button>
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-edit]').onclick = () => openSubDialog(it);
    tr.querySelector('[data-del]').onclick = () => delItem('subscriptions', it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`subscription:${it.id}`);
    tb.appendChild(tr);
  }
}

/* ── SIM 表 ── */
function renderSims() {
  const tb = $('#sims-body');
  tb.innerHTML = '';
  let rows = state.sims;
  if (state.simFilter !== '全部') rows = rows.filter(x => x.status === state.simFilter);
  $('#sims-empty').hidden = rows.length > 0;
  const today = new Date(state.overview.today + 'T00:00:00');
  for (const it of rows) {
    let barHtml = '<span class="muted">—</span>';
    if (it.last_renewed && it.cycle_days > 0) {
      const last = new Date(it.last_renewed + 'T00:00:00');
      const elapsed = Math.floor((today - last) / 864e5);
      const left = it.cycle_days - elapsed;
      const pct = Math.min(100, Math.max(0, elapsed / it.cycle_days * 100));
      const lbl = left < 0 ? `已超期 ${-left} 天` : `剩 ${left} 天 / ${it.cycle_days}`;
      barHtml = `<div class="bar"><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="lbl">${lbl}</div></div>`;
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(it.name)}${it.phone_number ? `<div class="muted" style="font-size:.75rem">${esc(it.phone_number)}</div>` : ''}</td>
      <td class="muted">${esc((it.forms || []).join(' / '))}</td>
      <td><span class="st${it.status === '启用' ? ' on' : ''}">${esc(it.status)}</span></td>
      <td class="muted">${esc(it.last_renewed || '')}</td>
      <td class="wide">${barHtml}</td>
      <td class="muted clip" title="${esc(it.keepalive_action || '')}">${esc(it.keepalive_action || '')}</td>
      <td class="ops">
        ${it.status === '启用' ? `<button class="btn link" data-renew type="button">已保号</button>` : ''}
        <button class="btn link" data-edit type="button">编辑</button>
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-edit]').onclick = () => openSimDialog(it);
    tr.querySelector('[data-del]').onclick = () => delItem('sims', it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`sim:${it.id}`);
    tb.appendChild(tr);
  }
}

/* ── VPS 表 ── */
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function vpsDue(it) {
  if (!it.last_renewed) return null;
  const last = new Date(it.last_renewed + 'T00:00:00');
  if (it.cycle === 'weekly') return new Date(last.getTime() + 7 * 864e5);
  if (it.cycle === 'days') return it.cycle_days > 0 ? new Date(last.getTime() + it.cycle_days * 864e5) : null;
  const months = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12, biennial: 24, triennial: 36 }[it.cycle];
  return months ? addMonths(last, months) : null;
}

function renderVps() {
  const tb = $('#vps-body');
  tb.innerHTML = '';
  let rows = state.vps;
  if (state.vpsFilter !== '全部') rows = rows.filter(x => x.status === state.vpsFilter);
  $('#vps-empty').hidden = rows.length > 0;
  const today = new Date((state.overview?.today || '1970-01-01') + 'T00:00:00');
  for (const it of rows) {
    const due = vpsDue(it);
    let barHtml = '<span class="muted">—</span>';
    if (due) {
      const last = new Date(it.last_renewed + 'T00:00:00');
      const total = Math.round((due - last) / 864e5);
      const elapsed = Math.floor((today - last) / 864e5);
      const left = total - elapsed;
      const pct = Math.min(100, Math.max(0, elapsed / total * 100));
      const lbl = left < 0 ? `已超期 ${-left} 天` : `剩 ${left} 天 / ${total}`;
      barHtml = `<div class="bar"><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="lbl">${lbl}</div></div>`;
    }
    const spec = [
      it.cores ? `${it.cores}C` : '',
      it.ram_gb ? `${it.ram_gb}G` : '',
      it.storage_gb ? `${it.storage_gb}G ${it.storage_type || ''}`.trim() : '',
    ].filter(Boolean).join(' / ');
    const routes = (it.routes || []).join(' / ');
    const cyc = it.cycle === 'days' ? `每 ${it.cycle_days ?? '?'} 天` : (CYCLE_LABEL[it.cycle] || '');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(it.vendor)}${it.product ? `<div class="muted" style="font-size:.75rem">${esc(it.product)}</div>` : ''}</td>
      <td class="muted">${esc((it.locations || []).join(' / '))}</td>
      <td class="muted">${esc(it.purpose || '')}</td>
      <td class="muted">${esc(spec)}</td>
      <td class="muted clip" title="${esc(routes)}">${esc(routes)}</td>
      <td class="amt">${esc(money(it.currency, it.price))}${cyc ? `<div class="muted" style="font-size:.72rem">${esc(cyc)}</div>` : ''}</td>
      <td class="muted">${esc(it.last_renewed || '')}</td>
      <td class="wide">${barHtml}</td>
      <td class="ops">
        ${(it.status === '启用' || it.status === '预结束') ? `<button class="btn link" data-renew type="button">已续费</button>` : ''}
        <button class="btn link" data-edit type="button">编辑</button>
        <button class="btn link" data-del type="button">删</button>
      </td>`;
    tr.querySelector('[data-edit]').onclick = () => openVpsDialog(it);
    tr.querySelector('[data-del]').onclick = () => delItem('vps', it);
    const rb = tr.querySelector('[data-renew]');
    if (rb) rb.onclick = () => doRenew(`vps:${it.id}`);
    tb.appendChild(tr);
  }
}

let editingVps = null;
const V_STR = ['vendor', 'product', 'status', 'purpose', 'storage_type', 'extra_storage',
  'currency', 'cycle', 'last_renewed', 'url', 'account', 'notes'];
const V_NUM = ['cores', 'ram_gb', 'storage_gb', 'port_gbps', 'traffic_tb', 'price', 'cycle_days'];

function openVpsDialog(it) {
  editingVps = it || null;
  const form = $('#form-vps');
  form.reset();
  $('#dlg-vps-title').textContent = it ? '编辑 VPS' : '新增 VPS';
  const f = form.elements;
  if (it) {
    for (const k of V_STR) f[k].value = it[k] ?? '';
    for (const k of V_NUM) f[k].value = it[k] ?? '';
    f.ipv6.checked = it.ipv6 === 1;
    f.locations.value = (it.locations || []).join(', ');
    f.routes.value = (it.routes || []).join(', ');
  }
  syncVpsCycleDays();
  $('#dlg-vps').showModal();
}

function syncVpsCycleDays() {
  $('#vps-cycle-days').hidden = $('#form-vps').elements.cycle.value !== 'days';
}

$('#form-vps').elements.cycle.addEventListener('change', syncVpsCycleDays);
$('#form-vps').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {};
  for (const k of V_STR) body[k] = f[k].value;
  for (const k of V_NUM) body[k] = f[k].value === '' ? undefined : +f[k].value;
  body.currency = f.currency.value.toUpperCase();
  body.ipv6 = f.ipv6.checked ? 1 : 0;
  const splitArr = v => v.split(/[,，、]+/).map(x => x.trim()).filter(Boolean);
  body.locations = splitArr(f.locations.value);
  body.routes = splitArr(f.routes.value);
  try {
    if (editingVps) await api(`/api/vps/${editingVps.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/vps', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-vps').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

async function delItem(kind, it) {
  if (!confirm(`删除「${it.name || it.vendor || it.title || ''}」？此操作不可撤销。`)) return;
  try {
    await api(`/api/${kind}/${it.id}`, { method: 'DELETE' });
    toast('已删除');
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ── 订阅表单 ── */
let editingSub = null;
function openSubDialog(it) {
  editingSub = it || null;
  const f = $('#form-sub');
  f.reset();
  $('#dlg-sub-title').textContent = it ? '编辑订阅' : '新增订阅';
  const sel = f.elements.parent_id;
  sel.innerHTML = '<option value="">—</option>';
  for (const s of state.subs) {
    if (it && s.id === it.id) continue;
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  if (it) {
    for (const k of ['name', 'category', 'status', 'currency', 'cycle', 'next_renewal', 'payment_method', 'account', 'url', 'notes']) {
      f.elements[k].value = it[k] ?? '';
    }
    f.elements.price.value = it.price ?? '';
    f.elements.cycle_days.value = it.cycle_days ?? '';
    f.elements.parent_id.value = it.parent_id ?? '';
  }
  syncCycleDays();
  $('#dlg-sub').showModal();
}

function syncCycleDays() {
  $('#row-cycle-days').hidden = $('#form-sub').elements.cycle.value !== 'days';
}

$('#form-sub').elements.cycle.addEventListener('change', syncCycleDays);
$('#form-sub').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    name: f.name.value, category: f.category.value, status: f.status.value,
    price: f.price.value === '' ? undefined : +f.price.value,
    currency: f.currency.value.toUpperCase(), cycle: f.cycle.value,
    cycle_days: f.cycle_days.value === '' ? undefined : +f.cycle_days.value,
    next_renewal: f.next_renewal.value, payment_method: f.payment_method.value,
    account: f.account.value, url: f.url.value, notes: f.notes.value,
    parent_id: f.parent_id.value === '' ? undefined : +f.parent_id.value,
  };
  try {
    if (editingSub) await api(`/api/subscriptions/${editingSub.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/subscriptions', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-sub').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

/* ── SIM 表单 ── */
let editingSim = null;
function openSimDialog(it) {
  editingSim = it || null;
  const f = $('#form-sim');
  f.reset();
  $('#dlg-sim-title').textContent = it ? '编辑 SIM 卡' : '新增 SIM 卡';
  if (it) {
    for (const k of ['name', 'phone_number', 'status', 'keepalive_action', 'last_renewed', 'notes']) {
      f.elements[k].value = it[k] ?? '';
    }
    f.elements.cycle_days.value = it.cycle_days ?? '';
    for (const cb of f.querySelectorAll('input[name="forms"]')) {
      cb.checked = (it.forms || []).includes(cb.value);
    }
  }
  $('#dlg-sim').showModal();
}

$('#form-sim').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const el = f.elements;
  const body = {
    name: el.name.value, phone_number: el.phone_number.value, status: el.status.value,
    keepalive_action: el.keepalive_action.value,
    cycle_days: el.cycle_days.value === '' ? undefined : +el.cycle_days.value,
    last_renewed: el.last_renewed.value, notes: el.notes.value,
    forms: [...f.querySelectorAll('input[name="forms"]:checked')].map(x => x.value),
  };
  try {
    if (editingSim) await api(`/api/sims/${editingSim.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/sims', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-sim').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

/* ── 设置 ── */
function openSettings() {
  const st = state.settings;
  const f = $('#form-settings').elements;
  $('#settings-renewals').hidden = !MODULES.includes('renewals');
  $('#settings-media').hidden = !MODULES.includes('media');
  f.pin.value = st['auth.pin'] || '';
  f.tmdb_key.value = st['meta.tmdb_key'] || '';
  f.meta_proxy.value = st['meta.proxy'] || '';
  try {
    f.thresholds.value = JSON.parse(st['notify.thresholds'] || '[]').join(',');
  } catch { f.thresholds.value = ''; }
  f.digest_time.value = st['notify.digest_time'] || '09:00';
  f.window_days.value = st['notify.window_days'] || '14';
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
}

function settingsBody() {
  const f = $('#form-settings').elements;
  const thresholds = f.thresholds.value.split(/[,，\s]+/).map(Number)
    .filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => b - a);
  return {
    'auth.pin': f.pin.value.replace(/[^A-Za-z0-9]/g, ''),
    'meta.tmdb_key': f.tmdb_key.value.trim(),
    'meta.proxy': f.meta_proxy.value.trim(),
    'notify.thresholds': JSON.stringify(thresholds.length ? thresholds : [14, 7, 3, 1, 0]),
    'notify.digest_time': f.digest_time.value || '09:00',
    'notify.window_days': String(+f.window_days.value || 14),
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

/* ── 媒体库 ── */
const M_KINDS = ['全部', '电影', '剧集', '动画', '游戏'];
const M_STATUSES = ['全部', '想看', '在看', '看过', '弃'];
const M_STR = ['kind', 'title', 'orig_title', 'status', 'marked_at', 'started_at', 'review',
  'others_reviews', 'genres', 'directors', 'writers', 'actors', 'countries', 'languages',
  'runtime', 'release_date', 'douban_url', 'douban_id', 'imdb_id', 'platform', 'notes'];
const M_INT = ['year', 'rating', 'douban_votes', 'tmdb_id', 'steam_appid'];
const M_REAL = ['douban_rating', 'playtime_hours'];

const starRow = n => n ? `<span class="star-row">${'★'.repeat(n)}</span>` : '';

function mediaFiltered() {
  let rows = state.media;
  if (state.mKind !== '全部') rows = rows.filter(x => x.kind === state.mKind);
  if (state.mStatus !== '全部') rows = rows.filter(x => x.status === state.mStatus);
  const q = state.mQ.trim().toLowerCase();
  if (q) {
    rows = rows.filter(x => [x.title, x.orig_title, x.review, x.directors, x.actors]
      .some(v => v && String(v).toLowerCase().includes(q)));
  }
  const key = state.mSort;
  return [...rows].sort((a, b) => {
    if (key === 'year') return (b.year || 0) - (a.year || 0);
    if (key === 'rating') return (b.rating || 0) - (a.rating || 0);
    if (key === 'douban') return (b.douban_rating || 0) - (a.douban_rating || 0);
    return String(b.marked_at || '').localeCompare(String(a.marked_at || '')) || b.id - a.id;
  });
}

function renderMediaChips() {
  const kc = $('#m-kind-chips');
  kc.innerHTML = '';
  for (const k of M_KINDS) {
    const n = k === '全部' ? state.media.length : state.media.filter(x => x.kind === k).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (k === state.mKind ? ' on' : '');
    b.innerHTML = `${esc(k)}<b>${n}</b>`;
    b.onclick = () => { state.mKind = k; renderMedia(); };
    kc.appendChild(b);
  }
  const base = state.mKind === '全部' ? state.media : state.media.filter(x => x.kind === state.mKind);
  const sc = $('#m-status-row');
  sc.innerHTML = '';
  for (const st of M_STATUSES) {
    const n = st === '全部' ? base.length : base.filter(x => x.status === st).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (st === state.mStatus ? ' on' : '');
    b.innerHTML = `${esc(st)}<b>${n}</b>`;
    b.onclick = () => { state.mStatus = st; renderMedia(); };
    sc.appendChild(b);
  }
}

function renderMedia() {
  renderMediaChips();
  const rows = mediaFiltered();
  $('#m-empty').hidden = rows.length > 0;
  $('#m-wall').hidden = state.mView !== 'wall';
  $('#m-tablewrap').hidden = state.mView !== 'table';
  $('#m-view-toggle').textContent = state.mView === 'wall' ? '表格' : '海报墙';
  if (state.mView === 'wall') {
    const wall = $('#m-wall');
    wall.innerHTML = '';
    rows.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--i', Math.min(idx, 20));
      const badge = it.status !== '看过' ? `<span class="badge">${esc(it.status)}</span>` : '';
      const cov = it.cover
        ? `<img loading="lazy" src="/covers/${esc(it.cover)}" alt="">`
        : `<div class="ph">${esc((it.title || '?').slice(0, 1))}</div>`;
      card.innerHTML = `
        <div class="cov">${cov}${badge}</div>
        <div class="t">${esc(it.title)}</div>
        <div class="meta"><span>${esc(String(it.year || ''))}</span>${starRow(it.rating)}${it.douban_rating ? `<span>豆 ${it.douban_rating}</span>` : ''}</div>`;
      card.onclick = () => openMediaDialog(it);
      wall.appendChild(card);
    });
  } else {
    const tb = $('#m-body');
    tb.innerHTML = '';
    for (const it of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(it.title)}${it.orig_title ? `<div class="muted" style="font-size:.75rem">${esc(it.orig_title)}</div>` : ''}</td>
        <td class="muted">${esc(it.kind)}</td>
        <td class="muted">${esc(String(it.year || ''))}</td>
        <td>${starRow(it.rating)}</td>
        <td class="amt">${it.douban_rating ?? ''}</td>
        <td><span class="st${it.status === '看过' ? ' on' : ''}">${esc(it.status)}</span></td>
        <td class="muted">${esc(it.marked_at || '')}</td>
        <td class="ops">
          <button class="btn link" data-edit type="button">编辑</button>
          <button class="btn link" data-del type="button">删</button>
        </td>`;
      tr.querySelector('[data-edit]').onclick = () => openMediaDialog(it);
      tr.querySelector('[data-del]').onclick = () => delItem('media', it);
      tb.appendChild(tr);
    }
  }
}

let editingMedia = null;

function setStars(v) {
  $('#form-media').elements.rating.value = v || '';
  $('#m-stars').querySelectorAll('button[data-v]').forEach(b => {
    if (b.dataset.v) b.classList.toggle('lit', +b.dataset.v <= (+v || 0));
  });
}

function openMediaDialog(it) {
  editingMedia = it || null;
  const form = $('#form-media');
  form.reset();
  $('#m-tmdb-results').innerHTML = '';
  $('#m-tmdb-q').value = '';
  $('#dlg-media-title').textContent = it ? '编辑条目' : '新增条目';
  const f = form.elements;
  if (it) {
    for (const k of M_STR) f[k].value = it[k] ?? '';
    for (const k of [...M_INT, ...M_REAL]) f[k].value = it[k] ?? '';
    setStars(it.rating);
  } else {
    setStars('');
  }
  $('#m-tmdb-box').hidden = !!it || f.kind.value === '游戏';
  $('#m-game-fold').open = f.kind.value === '游戏';
  $('#dlg-media').showModal();
}

$('#m-stars').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) setStars(b.dataset.v);
});

$('#form-media').elements.kind.addEventListener('change', e => {
  $('#m-game-fold').open = e.target.value === '游戏';
  $('#m-tmdb-box').hidden = !!editingMedia || e.target.value === '游戏';
});

$('#form-media').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {};
  for (const k of M_STR) body[k] = f[k].value;
  for (const k of [...M_INT, ...M_REAL]) body[k] = f[k].value === '' ? undefined : +f[k].value;
  // 表单不含封面字段，编辑时带上原值以免被清空
  if (editingMedia && editingMedia.cover) body.cover = editingMedia.cover;
  try {
    if (editingMedia) await api(`/api/media/${editingMedia.id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/media', { method: 'POST', body: JSON.stringify(body) });
    $('#dlg-media').close();
    toast('已保存');
    await loadAll();
  } catch (err) { toast(err.message, true); }
});

async function tmdbSearch() {
  const form = $('#form-media').elements;
  const q = $('#m-tmdb-q').value.trim() || form.title.value.trim();
  if (!q) { toast('先输入片名', true); return; }
  const box = $('#m-tmdb-results');
  box.innerHTML = '<p class="note">搜索中…</p>';
  try {
    const hits = await api(`/api/tmdb/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(form.kind.value)}`);
    box.innerHTML = hits.length ? '' : '<p class="note">无结果</p>';
    for (const h of hits) {
      const div = document.createElement('div');
      div.className = 'tmdb-hit';
      div.innerHTML = `
        ${h.poster ? `<img src="https://image.tmdb.org/t/p/w92${esc(h.poster)}" alt="" onerror="this.hidden=true">` : ''}
        <span class="ti">${esc(h.title || '')}（${esc(String(h.year || '?'))}）<small>${esc(h.orig_title || '')}</small></span>
        <button class="btn mini primary" type="button">选用</button>`;
      div.querySelector('button').onclick = async ev => {
        ev.target.disabled = true;
        try {
          const r = await api('/api/media/from_tmdb', {
            method: 'POST',
            body: JSON.stringify({ tmdb_id: h.tmdb_id, kind: form.kind.value, status: form.status.value }),
          });
          $('#dlg-media').close();
          toast('已建档，海报已缓存到本地');
          await loadAll();
          const created = state.media.find(x => x.id === r.id);
          if (created) openMediaDialog(created);
        } catch (err) { toast(err.message, true); ev.target.disabled = false; }
      };
      box.appendChild(div);
    }
  } catch (err) { box.innerHTML = ''; toast(err.message, true); }
}

$('#m-tmdb-go').onclick = tmdbSearch;
$('#m-tmdb-q').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); tmdbSearch(); }
});
$('#m-add').onclick = () => openMediaDialog(null);
$('#m-view-toggle').onclick = () => {
  state.mView = state.mView === 'wall' ? 'table' : 'wall';
  renderMedia();
};
$('#m-sort').onchange = e => { state.mSort = e.target.value; renderMedia(); };
let mSearchTimer;
$('#m-search').addEventListener('input', e => {
  clearTimeout(mSearchTimer);
  mSearchTimer = setTimeout(() => { state.mQ = e.target.value; renderMedia(); }, 180);
});

/* ── 页面级交互 ── */
document.querySelectorAll('.nav-tab[data-page]').forEach(b => b.onclick = () => {
  state.page = b.dataset.page;
  document.querySelectorAll('.nav-tab[data-page]').forEach(x => x.classList.toggle('on', x === b));
  $('#page-renewals').hidden = state.page !== 'renewals';
  $('#page-media').hidden = state.page !== 'media';
});

// 模块开关：只装其一时隐藏导航、落到对应页
(function initModules() {
  const hasR = MODULES.includes('renewals');
  const hasM = MODULES.includes('media');
  const tabR = document.querySelector('.nav-tab[data-page="renewals"]');
  const tabM = document.querySelector('.nav-tab[data-page="media"]');
  tabR.hidden = !hasR;
  tabM.hidden = !hasM;
  if (!hasR && hasM) {
    state.page = 'media';
    tabR.classList.remove('on');
    tabM.classList.add('on');
    $('#page-renewals').hidden = true;
    $('#page-media').hidden = false;
  }
  if (!(hasR && hasM)) document.querySelector('.nav').hidden = true;
})();

$('#btn-settings').onclick = openSettings;
$('#btn-add').onclick = () => {
  if (state.tab === 'subs') openSubDialog(null);
  else if (state.tab === 'sims') openSimDialog(null);
  else openVpsDialog(null);
};
document.querySelectorAll('.tab[data-tab]').forEach(b => b.onclick = () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $('#view-subs').hidden = state.tab !== 'subs';
  $('#view-sims').hidden = state.tab !== 'sims';
  $('#view-vps').hidden = state.tab !== 'vps';
  renderChips();
});
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

loadAll().catch(e => toast('加载失败：' + e.message, true));
