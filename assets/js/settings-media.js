/* Kalends 前端 · settings-media.js —— 设置页（通知、汇率、ICS、台账、备份、PIN）与
   媒体库（海报墙、媒体表格、TMDB 搜索与抓取、媒体详情表单）。加载方式见 core.js 头注。 */

/* ── 设置页 ── */
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
  if (MODULES.includes('renewals')) loadLedger(); // 不挡对话框，读回来再填
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

function settingsBody() {
  const f = $('#form-settings').elements;
  // 空串必须先滤掉：`Number('')` 是 0，混进来就成了「只在到期当天提醒」，而界面上看不出来
  //（清空这一栏、或末尾多打一个逗号都会撞上）。留空是合法配置——后端认 `[]` ＝只发每日摘要，
  // 拿默认值把它顶回去，这条配置在界面上就永远表达不出来
  const thresholds = [...new Set(f.thresholds.value.split(/[,，\s]+/).filter(Boolean).map(Number))]
    .filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => b - a);
  return {
    'auth.pin': f.pin.value.replace(/[^A-Za-z0-9]/g, ''),
    'meta.tmdb_key': f.tmdb_key.value.trim(),
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

/* ── 媒体库 ── */
const M_STR = ['kind', 'title', 'orig_title', 'status', 'marked_at', 'started_at', 'review',
  'others_reviews', 'genres', 'directors', 'writers', 'actors', 'countries', 'languages',
  'runtime', 'release_date', 'douban_url', 'douban_id', 'imdb_id', 'platform', 'notes'];
const M_INT = ['year', 'rating', 'douban_votes', 'tmdb_id', 'steam_appid'];
const M_REAL = ['douban_rating', 'playtime_hours'];


// 海报墙沿用类别/状态 chips；表格视图交给列筛选（applyView），互不影响
function mediaRows() {
  const m = views.media;
  let rows = state.media;
  if (m.view === 'wall') {
    if (state.mKind !== '全部') rows = rows.filter(x => x.kind === state.mKind);
    if (state.mStatus !== '全部') rows = rows.filter(x => x.status === state.mStatus);
  } else {
    for (const [k, f] of Object.entries(m.filters)) {
      const pred = filterPred('media', k, f);
      if (pred) rows = rows.filter(pred);
    }
  }
  const q = state.mQ.trim().toLowerCase();
  if (q) {
    rows = rows.filter(x => [x.title, x.orig_title, x.review, x.directors, x.actors]
      .some(v => v && String(v).toLowerCase().includes(q)));
  }
  // 「手动」不是一列，排的是 media_items.pos——sortRows 走 COLS 查不到它
  if (m.sort?.key === 'pos') return [...rows].sort(byPos);
  if (m.sort) return sortRows('media', rows, m.sort);
  return [...rows].sort((a, b) =>
    String(b.marked_at || '').localeCompare(String(a.marked_at || '')) || b.id - a.id);
}

function renderMediaChips() {
  const kc = $('#m-kind-chips');
  kc.innerHTML = '';
  for (const k of ['全部', ...M_KINDS]) {
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
  for (const st of ['全部', ...M_STATUSES]) {
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
  const isWall = views.media.view === 'wall';
  renderMediaChips();
  const rows = mediaRows();
  $('#m-empty').hidden = rows.length > 0;
  $('#m-wall').hidden = !isWall;
  $('#m-tablewrap').hidden = isWall;
  $('#m-kind-chips').hidden = !isWall; // 表格视图的类别/状态走列筛选，chips 只属于海报墙
  $('#m-status-row').hidden = !isWall;
  // 排序下拉同理：海报墙没有表头可点，它是唯一入口；表格视图里点表头就能排，
  // 两个控件管同一个状态只会让人犯嘀咕"我刚才是从哪儿改的"
  $('#m-sort').hidden = !isWall;
  $('#m-view-toggle').textContent = isWall ? '表格' : '海报墙';
  if (isWall) {
    $('#m-body').innerHTML = ''; // 清掉表格视图的残留行，避免列序重排作用在旧行上
    const wall = $('#m-wall');
    wall.innerHTML = '';
    rows.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      // 海报墙是默认视图，卡片只挂 onclick 就等于键盘用户在这一屏无路可走：
      // 补 tabIndex + role，Enter/空格都开详情（空格要 preventDefault 否则滚页）
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${it.title || '未命名'} 详情`);
      card.onkeydown = e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openMediaDialog(it);
      };
      card.style.setProperty('--i', Math.min(idx, 20));
      const badge = it.status !== '看过' ? `<span class="badge">${esc(it.status)}</span>` : '';
      const cov = it.cover
        // 封面文件名恒为 {id}.jpg 且响应带一周强缓存：重抓海报后不带版本号就会一周看不到新图
        ? `<img loading="lazy" src="/covers/${esc(it.cover)}?v=${encodeURIComponent(it.updated_at || '')}" alt="">`
        : `<div class="ph">${esc((it.title || '?').slice(0, 1))}</div>`;
      card.innerHTML = `
        <div class="cov">${cov}${badge}</div>
        <div class="t">${esc(it.title)}</div>
        <div class="meta"><span>${esc(String(it.year || ''))}</span>${it.rating ? `<span>${ratingView(it.rating)}</span>` : ''}${it.douban_rating ? `<span>豆 ${it.douban_rating}</span>` : ''}</div>`;
      card.onclick = () => openMediaDialog(it);
      wall.appendChild(card);
    });
  } else {
    const tb = $('#m-body');
    tb.innerHTML = '';
    for (const it of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = it.id;
      tr.innerHTML = `
        <td>${nameCell(it.title)}<button class="rowopen" data-open type="button" title="打开详情">⤢</button>${it.orig_title ? `<div class="muted" style="font-size:.75rem">${esc(it.orig_title)}</div>` : ''}</td>
        <td>${cellVal('media', 'kind', it.kind)}</td>
        <td class="cdate">${esc(String(it.year || ''))}</td>
        <td class="amt">${ratingView(it.rating)}</td>
        <td class="amt">${it.douban_rating ?? ''}</td>
        <td>${stPill(it.status)}</td>
        <td class="cdate">${esc(it.marked_at || '')}</td>
        ${customTds('media', it)}<td class="ops"></td>`;
      tr.querySelector('[data-open]').onclick = () => openMediaDialog(it);
      tb.appendChild(tr);
    }
  }
  syncTable('media');
}

let editingMedia = null;

/* 我的评分：10 分制数字 + 一颗蜂蜜金星。光一列数字看不出是评分（旁边就是豆瓣评分），
   星串又把 10 分制精度抹掉——数字给精度，星给辨识。 */
const ratingView = n => (n ? `${n} <span class="rstar">★</span>` : '');

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
    for (const k of [...M_INT, ...M_REAL]) f[k].value = it[k] ?? ''; // 评分也在 M_INT 里
  }
  // 自定义列在表单里也要有入口（海报墙用户没有点格即编那条路）
  const ex = $('#m-extra-fields');
  const exFields = customFields('media');
  ex.innerHTML = '';
  for (const cf of exFields) ex.appendChild(fieldControl('media', cf, it));
  $('#m-extra-fold').hidden = !exFields.length;
  // 已经有值就摊开：藏在一次点击后面，等于海报墙用户仍看不见自己填过什么
  $('#m-extra-fold').open = exFields.some(cf => {
    const v = (it?.extra || {})[cf.key];
    return v != null && v !== '' && !(Array.isArray(v) && !v.length);
  });
  $('#m-tmdb-box').hidden = !!it || f.kind.value === '游戏';
  $('#m-game-fold').open = f.kind.value === '游戏';
  $('#m-fetch-cover').hidden = !it || f.kind.value === '游戏';
  $('#dlg-media').showModal();
}

$('#m-fetch-cover').onclick = async e => {
  const b = e.target;
  b.disabled = true;
  try {
    await api(`/api/media/${editingMedia.id}/fetch_cover`, { method: 'POST', body: '{}' });
    toast('海报已缓存到本地');
    await loadAll();
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
};

$('#m-covers').onclick = async () => {
  const targets = state.media.filter(x => !x.cover && x.kind !== '游戏');
  if (!targets.length) { toast('没有缺海报的条目（游戏封面暂不支持）'); return; }
  if (!confirm(`将为 ${targets.length} 个条目从 TMDB 搜索并缓存海报（需已配置 TMDB Key），继续？`)) return;
  const b = $('#m-covers');
  b.disabled = true;
  let ok = 0;
  const misses = [];
  for (const [i, it] of targets.entries()) {
    b.textContent = `补海报 ${i + 1}/${targets.length}`;
    try {
      await api(`/api/media/${it.id}/fetch_cover`, { method: 'POST', body: '{}' });
      ok++;
    } catch (err) {
      misses.push(it.title);
      // Key 未配置这类全局错误没必要一路撞到底
      if (String(err.message).includes('TMDB API Key')) { toast(err.message, true); break; }
    }
    await new Promise(r => setTimeout(r, 250)); // 对 TMDB 客气点
  }
  b.disabled = false;
  b.textContent = '补海报';
  if (ok || misses.length) {
    toast(`补抓完成：成功 ${ok}${misses.length ? `，未匹配 ${misses.length}（可编辑条目填 TMDB 编号后单独抓取）` : ''}`, ok === 0);
  }
  await loadAll();
};

$('#form-media').elements.kind.addEventListener('change', e => {
  $('#m-game-fold').open = e.target.value === '游戏';
  $('#m-tmdb-box').hidden = !!editingMedia || e.target.value === '游戏';
  $('#m-fetch-cover').hidden = !editingMedia || e.target.value === '游戏';
});

$('#form-media').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  // extra 是**一个整体值**（出现即整份替换）：要动自定义列就得从行数据铺起再让控件
  // 覆盖，表单没显示的键才不会被抹掉。数字栏清空显式写 null（undefined 会被丢掉）。
  const body = { extra: { ...(editingMedia?.extra || {}) } };
  for (const k of M_STR) body[k] = f[k].value;
  for (const k of [...M_INT, ...M_REAL]) body[k] = f[k].value === '' ? null : +f[k].value;
  for (const cf of customFields('media')) {
    const val = readFieldControl('#m-extra-fields', cf);
    if (val === NO_CONTROL) continue; // 控件不在场＝别动这个键，不是"用户清空了"
    if (val == null || val === '' || (Array.isArray(val) && !val.length)) delete body.extra[cf.key];
    else body.extra[cf.key] = val;
  }
  try {
    // 封面不在表单里，也就不会出现在 body 里——缺席即保持，不必再把原值带上
    if (editingMedia) await api(`/api/media/${editingMedia.id}`, { method: 'PATCH', body: JSON.stringify(body) });
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
        ${h.poster ? `<img src="/api/tmdb/thumb?path=${encodeURIComponent(h.poster)}" alt="" loading="lazy" onerror="this.hidden=true">` : ''}
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
          // 海报是否真的落了盘由后端如实报（r.poster）——下载失败还说"已缓存"就是假话
          toast(r.poster ? '已建档，海报已缓存到本地' : '已建档（海报没取到，可稍后在条目里补抓）');
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
  views.media.view = views.media.view === 'wall' ? 'table' : 'wall';
  saveViews();
  renderMedia();
};
$('#m-sort').onchange = e => {
  setSort('media', e.target.value, M_DIR_DEFAULT[e.target.value] ?? -1);
};
let mSearchTimer;
$('#m-search').addEventListener('input', e => {
  clearTimeout(mSearchTimer);
  mSearchTimer = setTimeout(() => { state.mQ = e.target.value; renderMedia(); }, 180);
});
