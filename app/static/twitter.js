// ── State ─────────────────────────────────────────────────────────────────────

let twAccounts        = [];
let twSort            = { field: 'handle', dir: 'asc' };
let twFilter          = { stat: 'all', star: 'all' };
let twSearch          = '';
let twPending         = {};
const twDismissed     = new Set();
let twRunQueue        = [];
let twRunCurrent      = null;
let twLoopRunning     = false;
let twCurrentAccount  = null;
let twLogLines        = [];
let twLogClearIndex   = 0;
let _twLogClearRestored = false;
let twCleanupPoll     = null;

// ── Sort direction labels ─────────────────────────────────────────────────────

const _TW_SORT_DIR_LABELS = {
  handle:           { asc: 'A → Z',      desc: 'Z → A'      },
  display_name:     { asc: 'A → Z',      desc: 'Z → A'      },
  subscriber_count: { asc: 'Low → High', desc: 'High → Low' },
  video_total:      { asc: 'Low → High', desc: 'High → Low' },
  video_deleted:    { asc: 'Low → High', desc: 'High → Low' },
  added_at:         { asc: 'Oldest first', desc: 'Newest first' },
};

// ── Twitter-specific render helpers ──────────────────────────────────────────

function _twThumbCell(v) {
  const id = esc(v.video_id);
  return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
    <img class="video-thumb" src="/api/twitter/videos/${id}/thumbnail" alt="" loading="lazy"
         onerror="this.style.opacity='.15'"
         onclick="event.stopPropagation();twOpenVidModal('${id}')" title="Play video" style="cursor:pointer">
    ${_playBadge}
  </div>`;
}

function _twVideoActionBtns(v) {
  const id = esc(v.video_id);
  if (v.file_path) {
    return `<a class="play-btn" href="/api/twitter/videos/${id}/file" download="${id}.mp4"
             onclick="event.stopPropagation()" title="Download video">${_dlIcon}</a>`;
  }
  return '';
}

function twOpenImgModal(videoId) {
  openImgModalUrl(`/api/twitter/videos/${encodeURIComponent(videoId)}/thumbnail`);
}

function twOpenVidModal(videoId) {
  const vid = document.getElementById('vidModalPlayer');
  vid.src = `/api/twitter/videos/${encodeURIComponent(videoId)}/file`;
  document.getElementById('vidModal').style.display = 'flex';
  _lockScroll();
  vid.play().catch(() => {});
}

// ── Twitter video column config ───────────────────────────────────────────────

const TW_VCOLS = [
  { field: null,            label: '' },
  { field: null,            label: 'Title' },
  { field: 'status',        label: 'Status' },
  { field: 'view_count',    label: 'Views' },
  { field: 'upload_date',   label: 'Posted' },
  { field: 'download_date', label: 'Saved' },
  { field: 'deleted_at',    label: 'Deleted' },
  { field: null,            label: '' },
];

const _twAccountState = {
  videos: [], filter: 'all', typeFilter: 'all', search: '',
  sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, obs: null,
  toolbarExpanded: false, view: 'list',
};

const _TW_MODAL_CFG = {
  st:             _twAccountState,
  listElId:       'twModalVideoList',
  toolbarElId:    'twModalToolbar',
  cols:           TW_VCOLS,
  colsCls:        'vcols',
  pageSize:       50,
  uploadDateFmt:  fmtDateOnly,
  filterFn:     'twSetModalFilter',
  typeFilterFn: 'twSetModalTypeFilter',
  sortFn:       'twSetModalSort',
  toggleFn:     'twToggleModalToolbar',
  searchFn:     'twOnModalSearch',
  authorCol:    null,
  hasSearch:    true,
  hasViewToggle: true,
  viewFn:       'twSetModalView',
  viewKeys: [
    { key: 'list',   icon: _listViewIcon, title: 'List view' },
    { key: 'videos', icon: _gridViewIcon, title: 'Grid view' },
  ],
  viewVideoFilter: (view, vids) => vids,
  gridClassFn: () => '',
  typeIconFn:  () => _playBadge,
  gridId:       'twVideoGrid',
  hasPhistBtn:  true,
  phistBtnFn:   'twOpenProfileHistory',
  thumbCellFn:  _twThumbCell,
  actionBtnsFn: _twVideoActionBtns,
  previewFn:    'twOpenImgModal',
  gridThumbSrc: v => `/api/twitter/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => twOpenVidModal(v.video_id),
};

// ── Stats panel ───────────────────────────────────────────────────────────────

function renderTwStats(s) {
  _renderStatGrid('twStatsGrid', [
    { label: 'Tracked accounts', value: (s.channel_count  || 0).toLocaleString() },
    { label: 'Saved tweets',     value: (s.saved_count    || 0).toLocaleString() },
    { label: 'Deleted',          value: (s.deleted_count  || 0).toLocaleString() },
    { label: 'Latest saved',     value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
    { label: 'Total views',      value: _fmtLarge(s.total_views || 0) },
  ]);
}

async function loadTwStats() {
  const { ok, data } = await apiJSON('/api/twitter/stats');
  if (ok) renderTwStats(data);
}

// ── Recent panel ──────────────────────────────────────────────────────────────

const _TW_FIELD_LABELS = {
  handle: 'Handle', display_name: 'Display name', description: 'Bio', avatar: 'Avatar',
};

const _TW_RECENT_LOG_TITLES = {
  'deletions':       'All Deleted Tweets',
  'profile-changes': 'All Profile Changes',
  'saved':           'All Saved Tweets',
};

function _twRenderSavedRow(g, now) {
  const row = document.createElement('div');
  row.className = 'recent-entry';
  row.title = `Open @${g.handle}`;
  row.onclick = () => twOpenModal(g.channel_id);
  row.innerHTML = `
    <span class="recent-date">${_recentDate(g.download_date, now)}</span>
    <span class="recent-name">@${esc(g.handle)}</span>
    <span class="recent-detail">${g.count}x</span>`;
  return row;
}

function _twRenderOtherRow(item, type, now) {
  const row = document.createElement('div');
  row.className = 'recent-entry';
  if (type === 'deletions') {
    row.title = `Open @${item.handle}`;
    row.onclick = () => twOpenModalAndHighlight(item.channel_id, item.video_id);
    row.innerHTML = `
      <span class="recent-date">${_recentDate(item.deleted_at, now)}</span>
      <span class="recent-name">@${esc(item.handle)}</span>
      <span class="recent-detail">${esc((item.video_id || '').slice(0, 11))}</span>`;
  } else {
    const label = _TW_FIELD_LABELS[item.field] || item.field;
    row.title = `Open @${item.handle} · ${label} history`;
    row.onclick = () => twOpenModalWithHistory(item.channel_id, item.field);
    row.innerHTML = `
      <span class="recent-date">${_recentDate(item.changed_at, now)}</span>
      <span class="recent-name">@${esc(item.handle)}</span>
      <span class="recent-detail">${esc(label)}</span>`;
  }
  return row;
}

function twOpenRecentLog(type) {
  _openRecentLogModal(type, {
    apiBase:     '/api/twitter/recent',
    titles:      _TW_RECENT_LOG_TITLES,
    groupKey:    'channel_id',
    renderSaved: _twRenderSavedRow,
    renderOther: _twRenderOtherRow,
  });
}

function renderTwRecent(data) {
  const leftEl  = document.getElementById('twRecentLeft');
  const rightEl = document.getElementById('twRecentRight');
  if (!leftEl || !rightEl) return;
  const now = new Date();

  let left = '';

  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="twOpenRecentLog('deletions')" title="View all deleted tweets">Recently deleted</div>`;
  if (data.deletions && data.deletions.length) {
    left += data.deletions.map(d => {
      const onclick = `twOpenModalAndHighlight('${esc(d.channel_id)}','${esc(d.video_id)}')`;
      return `<div class="recent-entry" onclick="${onclick}" title="Open @${esc(d.handle)}">
        <span class="recent-date">${_recentDate(d.deleted_at, now)}</span>
        <span class="recent-name">@${esc(d.handle)}</span>
        <span class="recent-detail">${esc((d.video_id || '').slice(0, 11))}</span>
      </div>`;
    }).join('');
  } else {
    left += `<div class="recent-empty">No deleted tweets yet</div>`;
  }
  left += `</div>`;

  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="twOpenRecentLog('profile-changes')" title="View all profile changes">Recently changed profile</div>`;
  if (data.profile_changes && data.profile_changes.length) {
    left += data.profile_changes.map(p =>
      `<div class="recent-entry" onclick="twOpenModalWithHistory('${esc(p.channel_id)}','${esc(p.field)}')" title="Open @${esc(p.handle)}">
        <span class="recent-date">${_recentDate(p.changed_at, now)}</span>
        <span class="recent-name">@${esc(p.handle)}</span>
        <span class="recent-detail">${esc(_TW_FIELD_LABELS[p.field] || p.field)}</span>
      </div>`
    ).join('');
  } else {
    left += `<div class="recent-empty">No profile changes recorded yet</div>`;
  }
  left += `</div>`;

  leftEl.innerHTML = left;

  let right = '';
  right += `<div class="recent-section">`;
  right += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="twOpenRecentLog('saved')" title="View all saved tweets">Recently saved</div>`;
  if (data.saved && data.saved.length) {
    right += data.saved.map(g =>
      `<div class="recent-entry" onclick="twOpenModal('${esc(g.channel_id)}')" title="Open @${esc(g.handle)}">
        <span class="recent-date">${_recentDate(g.download_date, now)}</span>
        <span class="recent-name">@${esc(g.handle)}</span>
        <span class="recent-detail">${g.count}x</span>
      </div>`
    ).join('');
  } else {
    right += `<div class="recent-empty">No tweets saved yet</div>`;
  }
  right += `</div>`;

  rightEl.innerHTML = right;
}

async function loadTwRecent() {
  const { ok, data } = await apiJSON('/api/twitter/recent');
  if (ok) renderTwRecent(data);
}

// ── Loop status ───────────────────────────────────────────────────────────────

const _twEl = {
  meta:       () => document.getElementById('twLoopMeta'),
  next:       () => document.getElementById('twLoopNext'),
  sessions:   () => document.getElementById('twLoopSessions'),
  btnNext:    () => document.getElementById('twTriggerNextBtn'),
  btnStarred: () => document.getElementById('twTriggerStarredBtn'),
  btnHalf:    () => document.getElementById('twTriggerHalfBtn'),
  btnAll:     () => document.getElementById('twTriggerAllBtn'),
  stopBtn:    () => document.getElementById('twStopBtn'),
};

function renderTwStatus(state) {
  twLoopRunning   = state.loop_running;
  twCurrentAccount = state.loop_current_channel;
  twRunQueue      = state.run_queue  || [];
  twRunCurrent    = state.run_current || null;

  const el = _twEl;
  if (el.meta()) {
    const parts = [];
    if (state.loop_last_end) parts.push(`Last: ${fmt.rel(state.loop_last_end)}`);
    else parts.push('Never run');
    if (state.loop_last_new_videos != null) parts.push(`${state.loop_last_new_videos} new`);
    if (state.loop_last_duration_secs != null) parts.push(fmt.dur(state.loop_last_duration_secs));
    el.meta().textContent = parts.join(' · ');
  }
  if (el.next()) el.next().textContent = twLoopRunning
    ? 'Running…'
    : (state.loop_next ? `Next: ${fmt.relFuture(state.loop_next)}` : '');
  _renderSessionPills(el.sessions(), state.loop_sessions_today || [], twLoopRunning, state.loop_manual_run);
  if (el.btnNext())    el.btnNext().disabled    = twLoopRunning;
  if (el.btnStarred()) el.btnStarred().disabled = twLoopRunning;
  if (el.btnHalf())    el.btnHalf().disabled    = twLoopRunning;
  if (el.btnAll())     el.btnAll().disabled     = twLoopRunning;
  if (el.stopBtn())    el.stopBtn().disabled    = !twLoopRunning;

  const badge = document.getElementById('statusBadge');
  const text  = document.getElementById('statusText');
  const active = location.hash === '#twitter';
  if (active && badge && text) {
    const anyActive = twLoopRunning || !!twRunCurrent;
    badge.className  = `status-badge${anyActive ? ' running' : ''}`;
    text.textContent = anyActive
      ? (twCurrentAccount ? `Downloading @${twCurrentAccount}` : 'Running…')
      : 'Idle';
  }

  const logBody = document.getElementById('twLogBody');
  if (logBody && state.logs) {
    if (!_twLogClearRestored) {
      _twLogClearRestored = true;
      const mark = localStorage.getItem('tw-logClearWatermark');
      if (mark) {
        const lines = state.logs;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] === mark) { twLogClearIndex = i + 1; break; }
        }
      }
    }
    const newLines = state.logs.slice(twLogClearIndex);
    if (newLines.length !== twLogLines.length || (twLogLines.length && twLogLines[twLogLines.length - 1] !== newLines[newLines.length - 1])) {
      twLogLines = newLines;
      const auto = document.getElementById('twAutoScroll')?.checked !== false;
      logBody.innerHTML = twLogLines.map(l => `<div class="log-line">${esc(l)}</div>`).join('');
      if (auto) logBody.scrollTop = logBody.scrollHeight;
    }
  }

  updateTwRunStates();
}

function updateTwRunStates() {
  document.querySelectorAll('.tw-account-card[data-channelid]').forEach(card => {
    const id      = card.dataset.channelid;
    const inQueue = twRunQueue.includes(id);
    const isCur   = twRunCurrent === id;
    const btn     = card.querySelector('.btn-run');
    if (!btn) return;
    btn.textContent = isCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
    btn.disabled    = inQueue || isCur;
  });
}

async function loadTwStatus() {
  const { ok, data } = await apiJSON('/api/twitter/status');
  if (ok) renderTwStatus(data);
}

function twClearLog() {
  const lastLine = twLogLines[twLogLines.length - 1];
  if (lastLine) {
    localStorage.setItem('tw-logClearWatermark', lastLine);
  } else {
    localStorage.removeItem('tw-logClearWatermark');
  }
  twLogClearIndex = 0;
  twLogLines = [];
  const logBody = document.getElementById('twLogBody');
  if (logBody) logBody.innerHTML = '';
}

// ── Settings ──────────────────────────────────────────────────────────────────

// Cookie panel logic is shared with TikTok via common.js.
async function twLoadCookies()          { return _cookiesLoad('twitter', 'twCookie'); }
async function twUploadCookies(input)   { return _cookiesUpload('twitter', 'twCookie', input); }
async function twDeleteCookies()        { return _cookiesDelete('twitter', 'twCookie'); }

async function loadTwSettings() {
  twLoadCookies();
  return _scheduleSettingsLoad('twitter', 'twSettings');
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

function twDiagRun()  { _platformDiagRun('twitter', 'twDiag'); }
function twDiagCopy() { _platformDiagCopy('twDiag'); }

async function twSaveLoopSettings() { return _scheduleSettingsSave('twitter', 'twSettings'); }

const _twTriggerToast = _makeTriggerToast('account');
function twTriggerNext()    { return _triggerLoop('twTriggerNextBtn',    '/api/twitter/trigger/next', 'Could not trigger loop', _twTriggerToast); }
function twTriggerStarred() { return _triggerLoop('twTriggerStarredBtn', '/api/twitter/trigger',      'Could not trigger loop', _twTriggerToast); }
function twTriggerHalf()    { return _triggerLoop('twTriggerHalfBtn',    '/api/twitter/trigger/half', 'Could not trigger loop', _twTriggerToast); }
function twTriggerAll()     { return _triggerLoop('twTriggerAllBtn',     '/api/twitter/trigger/all',  'Could not trigger loop', _twTriggerToast); }

async function twStopLoop() {
  const btn = document.getElementById('twStopBtn');
  if (btn) btn.disabled = true;
  const { ok } = await apiJSON('/api/twitter/stop', { method: 'POST' });
  if (!ok) {
    if (btn) btn.disabled = false;
    showToast('Could not stop loop.', { type: 'error' });
  }
}

// ── DB cleanup ────────────────────────────────────────────────────────────────

const _twCleanupWidget = _makeJobWidget('tw-cleanup');

async function twTriggerCleanup() {
  const btn = document.getElementById('job-tw-cleanup-btn');
  if (btn) btn.disabled = true;
  const { ok, data } = await apiJSON('/api/twitter/db/cleanup', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start cleanup', { type: 'error' }); if (btn) btn.disabled = false; return; }
  _twCleanupWidget.update({ barPct: null, label: 'Running…' });
  if (twCleanupPoll) return;
  twCleanupPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/twitter/db/cleanup');
    if (!ok) return;
    if (data.running) {
      _twCleanupWidget.update({ barPct: null, label: data.current || 'Running…', steps: data.steps });
    } else {
      clearInterval(twCleanupPoll); twCleanupPoll = null;
      if (btn) btn.disabled = false;
      _twCleanupWidget.update({
        barPct: 100,
        label: `Done - ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
        steps: data.steps,
      });
    }
  }, 800);
}

// ── Add account form ──────────────────────────────────────────────────────────

document.getElementById('twHandleInput').addEventListener('input', function() {
  const clean = this.textContent.replace(/[^a-zA-Z0-9_.@/-]/g, '');
  if (this.textContent !== clean) {
    this.textContent = clean;
    const range = document.createRange();
    const sel   = window.getSelection();
    range.selectNodeContents(this);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

document.getElementById('twHandleInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); twAddAccount(); }
});

document.getElementById('twHandleInput').addEventListener('paste', function(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

async function twAddAccount() {
  const input    = document.getElementById('twHandleInput');
  const statusEl = document.getElementById('twAddStatus');
  const raw      = input.textContent.trim();
  if (!raw) return;
  input.textContent = '';
  input.focus();

  statusEl.className   = 'add-status info';
  statusEl.textContent = 'Adding…';

  const { ok, data } = await apiJSON('/api/twitter/channels', {
    method: 'POST',
    body: JSON.stringify({ handle: raw }),
  });
  if (ok) {
    const handle = data.handle || raw.replace(/^@/, '');
    twDismissed.delete(handle);
    twPending[handle] = { status: 'pending' };
    statusEl.className   = 'add-status ok';
    statusEl.textContent = `@${handle} queued.`;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'add-status'; }, 5000);
    renderTwPending();
  } else {
    statusEl.className   = 'add-status error';
    statusEl.textContent = data.error || 'Failed.';
  }
}

async function twLoadQueue() {
  const { ok, data } = await apiJSON('/api/twitter/queue');
  if (!ok) return;
  let anyResolved = false;
  for (const h of Object.keys(twPending)) {
    if (!(h in data) && !twDismissed.has(h)) {
      delete twPending[h];
      anyResolved = true;
    }
  }
  for (const [h, info] of Object.entries(data)) {
    if (!twDismissed.has(h)) twPending[h] = info;
  }
  renderTwPending();
  if (anyResolved) loadTwAccounts();
}

function renderTwPending() {
  const container = document.getElementById('twPendingList');
  if (!container) return;
  const entries = Object.entries(twPending).filter(([h]) => !twDismissed.has(h));
  if (!entries.length) { container.innerHTML = ''; return; }
  container.innerHTML = entries.map(([handle, info]) => {
    if (info.status === 'pending') {
      return `<div class="pending-item"><span class="spinner"></span>Looking up @${esc(handle)}…</div>`;
    }
    return `<div class="pending-item error">Failed to add @${esc(handle)}: ${esc(info.message)} <button onclick="twDismissPending('${esc(handle)}')" title="Dismiss">×</button></div>`;
  }).join('');
}

async function twDismissPending(handle) {
  await apiJSON(`/api/twitter/queue/${encodeURIComponent(handle)}`, { method: 'DELETE' });
  delete twPending[handle];
  renderTwPending();
}

// ── Account filters and sort ──────────────────────────────────────────────────

const TW_STAT_IDS = { all: 'twfStatAll', active: 'twfStatActive', inactive: 'twfStatInactive' };
const TW_STAR_IDS = { all: 'twfStarAll', starred: 'twfStarStarred' };

function setTwFilter(group, value) {
  twFilter[group] = value;
  const map = group === 'stat' ? TW_STAT_IDS : TW_STAR_IDS;
  Object.entries(map).forEach(([v, id]) => {
    document.getElementById(id)?.classList.toggle('active', v === value);
  });
  renderTwAccounts();
  const anchorId = group === 'stat' ? 'twfStatAll' : 'twfStarAll';
  _placeGlider(document.getElementById(anchorId).closest('.filter-pills'));
}

function setTwSortField(field) {
  twSort.field = field;
  twSort.dir   = (field === 'handle' || field === 'display_name') ? 'asc' : 'desc';
  _updateTwSortBtn();
  renderTwAccounts();
}

function toggleTwSortDir() {
  twSort.dir = twSort.dir === 'asc' ? 'desc' : 'asc';
  _updateTwSortBtn();
  renderTwAccounts();
}

function _updateTwSortBtn() {
  const btn = document.getElementById('twSortDirBtn');
  if (btn) btn.textContent = _TW_SORT_DIR_LABELS[twSort.field]?.[twSort.dir] ?? twSort.dir;
}

function resetTwFilters() {
  twSort   = { field: 'handle', dir: 'asc' };
  twFilter = { stat: 'all', star: 'all' };
  twSearch = '';
  const searchEl = document.getElementById('twSearch');
  if (searchEl) searchEl.value = '';
  const sel = document.getElementById('twSortField');
  if (sel) sel.value = 'handle';
  _updateTwSortBtn();
  Object.entries(TW_STAT_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  Object.entries(TW_STAR_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  renderTwAccounts();
  _placeGlider(document.getElementById('twfStatAll').closest('.filter-pills'));
  _placeGlider(document.getElementById('twfStarAll').closest('.filter-pills'));
}

function onTwSearch(val) {
  twSearch = val.trim();
  renderTwAccounts();
}

function _filteredTwAccounts() {
  const q = twSearch.toLowerCase();
  return twAccounts.filter(ch => {
    if (twFilter.stat === 'active'   && ch.tracking_enabled === 0) return false;
    if (twFilter.stat === 'inactive' && ch.tracking_enabled !== 0) return false;
    if (twFilter.star === 'starred'  && !ch.starred)               return false;
    if (q) {
      const hay = [ch.handle, ch.display_name, ch.channel_id, ch.description]
                  .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function _sortedTwAccounts() {
  const { field, dir } = twSort;
  return _filteredTwAccounts().sort((a, b) => {
    const av = field === 'display_name' ? (a.display_name || a.handle) : (a[field] ?? (field === 'handle' ? '' : 0));
    const bv = field === 'display_name' ? (b.display_name || b.handle) : (b[field] ?? (field === 'handle' ? '' : 0));
    return _cmp(av, bv, dir);
  });
}

// ── Account cards ─────────────────────────────────────────────────────────────

const _TW_CARD_BATCH = 9;
let _twGridObs       = null;
let _twRenderedCount = 0;
let _twSortedCache   = [];

function _renderTwAccountCard(ch) {
  const isCurrent  = !!twCurrentAccount && ch.handle === twCurrentAccount;
  const isInactive = ch.tracking_enabled === 0;
  const { cls: trackingCls, label: trackingLabel } = _trackingBadge(ch.tracking_enabled);
  const checked    = _fmtLastChecked(ch.last_checked);
  const inQueue    = twRunQueue.includes(ch.channel_id);
  const isRunCur   = twRunCurrent === ch.channel_id;
  const runLabel   = isRunCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
  const runDis     = (inQueue || isRunCur) ? 'disabled' : '';
  const follStr    = ch.subscriber_count != null ? `${_fmtLarge(ch.subscriber_count)} followers` : '';

  return `
    <div class="user-card tw-account-card${isCurrent ? ' user-card-current' : ''}${isInactive ? ' user-card-inactive' : ''}"
         data-channelid="${esc(ch.channel_id)}"
         onclick="if(!event.target.closest('button'))twOpenModal('${esc(ch.channel_id)}')"
         role="button" tabindex="0">
      <div class="user-card-top">
        <div class="avatar-wrap">
          <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
          ${ch.avatar_cached ? `<img class="user-avatar" src="/api/twitter/channels/${esc(ch.channel_id)}/avatar" alt=""
               onerror="this.style.display='none'"
               onclick="event.stopPropagation();openImgModalUrl('/api/twitter/channels/${esc(ch.channel_id)}/avatar')">` : ''}
        </div>
        <div class="user-identity">
          <div class="user-display-name">${esc(ch.display_name || ch.handle)}</div>
          <div class="user-handle">@${esc(ch.handle)}</div>
          ${follStr ? `<div class="user-id-line">${esc(follStr)}</div>` : `<div class="user-id-line">${esc(ch.channel_id)}</div>`}
        </div>
        <div class="user-badges">
          <span class="account-status ${trackingCls}">${trackingLabel}</span>
        </div>
      </div>

      <div class="user-bio-area">
        ${ch.description ? `<div class="user-bio">${esc(ch.description)}</div>` : ''}
      </div>

      <div class="user-stats">
        ${follStr ? `<span class="stat-item"><span class="stat-item-label">followers</span><span class="stat-item-value">${_fmtLarge(ch.subscriber_count)}</span></span>` : ''}
        <span class="stat-item"><span class="stat-item-label">saved</span><span class="stat-item-value">${ch.video_total || 0}</span></span>
        ${ch.video_deleted   ? `<span class="stat-item"><span class="stat-item-label">deleted</span><span class="stat-item-value" style="color:var(--red)">${ch.video_deleted}</span></span>` : ''}
        ${ch.video_missing   ? `<span class="stat-item"><span class="stat-item-label">missing</span><span class="stat-item-value" style="color:#ff9800">${ch.video_missing}</span></span>` : ''}
        ${ch.video_undeleted ? `<span class="stat-item"><span class="stat-item-label">restored</span><span class="stat-item-value" style="color:var(--yellow)">${ch.video_undeleted}</span></span>` : ''}
      </div>

      <div class="user-card-footer">
        <span class="user-checked">${checked}</span>
        <div style="display:flex;gap:6px">
          <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="event.stopPropagation();twToggleStar('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
          <button class="btn-run" ${runDis} onclick="event.stopPropagation();twRunAccount('${esc(ch.channel_id)}')">${runLabel}</button>
          <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>twRunAccountUpdate('${esc(ch.channel_id)}')},{label:'Remove',danger:true,onclick:()=>twRemoveAccount('${esc(ch.channel_id)}','@${esc(ch.handle)}')}])">&#x2022;&#x2022;&#x2022;</button>
        </div>
      </div>
    </div>
  `;
}

function _appendTwAccountCards() {
  const grid = document.getElementById('twChannelsGrid');
  _twGridObs = null;
  const next = _twSortedCache.slice(_twRenderedCount, _twRenderedCount + _TW_CARD_BATCH);
  if (!next.length) return;
  grid.insertAdjacentHTML('beforeend', next.map(_renderTwAccountCard).join(''));
  _twRenderedCount += next.length;
  if (_twSortedCache.length > _twRenderedCount) {
    _twGridObs = _attachGridSentinel(grid, _appendTwAccountCards);
  }
}

function renderTwAccounts() {
  if (_twGridObs) { _twGridObs.disconnect(); _twGridObs = null; }
  const grid = document.getElementById('twChannelsGrid');
  if (!grid) return;
  const filtered   = _filteredTwAccounts();
  const isFiltered = twFilter.stat !== 'all' || twFilter.star !== 'all' || !!twSearch;
  const countEl    = document.getElementById('twAccountCount');
  if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${twAccounts.length}` : twAccounts.length;

  if (!twAccounts.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No accounts tracked yet.</div>';
    _twRenderedCount = 0;
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No accounts match this filter.</div>'
      + _ghostCards(Math.min(twAccounts.length, _TW_CARD_BATCH));
    _twRenderedCount = 0;
    return;
  }

  _twSortedCache   = _sortedTwAccounts();
  const toShow     = Math.min(Math.max(_TW_CARD_BATCH, _twRenderedCount), _twSortedCache.length);
  const slice      = _twSortedCache.slice(0, toShow);
  grid.innerHTML   = slice.map(_renderTwAccountCard).join('')
    + (toShow < _TW_CARD_BATCH ? _ghostCards(_TW_CARD_BATCH - toShow) : '');
  _twRenderedCount = slice.length;

  if (_twSortedCache.length > _twRenderedCount) {
    _twGridObs = _attachGridSentinel(grid, _appendTwAccountCards);
  }
}

async function loadTwAccounts() {
  const { ok, data } = await apiJSON('/api/twitter/channels');
  if (ok) { twAccounts = data; renderTwAccounts(); }
}

async function twRunAccount(id)           { return _creatorRun('/api/twitter/channels', id, () => twRunQueue, q => { twRunQueue = q; }, renderTwAccounts); }
async function twRunAccountUpdate(id)     { return _creatorRunProfile('/api/twitter/channels', id, () => twRunQueue, q => { twRunQueue = q; }, renderTwAccounts); }
async function twRemoveAccount(id, label) { return _creatorRemove('/api/twitter/channels', id, label, loadTwAccounts); }
async function twToggleStar(id)           { return _creatorToggleStar('/api/twitter/channels', id, twAccounts, 'channel_id', renderTwAccounts); }

// ── Account tracking toggle ───────────────────────────────────────────────────

async function twSetTracking(channelId, enabled) {
  const { ok, data } = await apiJSON(`/api/twitter/channels/${channelId}/tracking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!ok) { showToast(data.error || 'Failed to update tracking', { type: 'error' }); return; }
  const ch = twAccounts.find(c => c.channel_id === channelId);
  if (ch) ch.tracking_enabled = enabled ? 1 : 0;
  if (_twModalAccountId === channelId && _twModalAccount) {
    _twModalAccount.tracking_enabled = enabled ? 1 : 0;
    _renderTwModalHeader(_twModalAccount);
  }
  renderTwAccounts();
}

// ── Account detail modal ──────────────────────────────────────────────────────

let _twModalAccountId       = null;
let _twModalAccount         = null;
let _twModalPendingHighlight = null;

let _twPhistData  = [];
let _twPhistField = 'all';
let _twPhistChId  = null;

function twOpenModalAndHighlight(channelId, videoId, filter, sortField, sortDir) {
  _twModalPendingHighlight = {
    videoId,
    filter:    filter    || 'all',
    sortField: sortField || 'upload_date',
    sortDir:   sortDir   || 'desc',
  };
  twOpenModal(channelId);
}

function twOpenModal(channelId) {
  const ch = twAccounts.find(c => c.channel_id === channelId);
  if (!ch) return;
  _twModalAccountId = channelId;
  _twModalAccount   = ch;
  Object.assign(_twAccountState, {
    videos: [], filter: 'all', typeFilter: 'all', search: '',
    sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, toolbarExpanded: false,
    view: window.innerWidth <= 640 ? 'grid' : 'list',
  });
  if (_twAccountState.obs) { _twAccountState.obs.disconnect(); _twAccountState.obs = null; }

  _twPhistData  = [];
  _twPhistField = 'all';
  _twPhistChId  = null;
  document.getElementById('twPhistPanel').style.display     = 'none';
  document.getElementById('twModalVideoList').style.display = '';

  document.getElementById('twModalBackdrop').style.display = 'flex';
  _lockScroll();

  _renderTwModalHeader(ch);
  _mRenderToolbar(_TW_MODAL_CFG, []);
  document.getElementById('twModalVideoList').innerHTML =
    '<div class="vlist-loading">Loading tweets…</div>';

  _twLoadModalVideos(channelId);
}

function twOpenModalWithHistory(channelId, field) {
  twOpenModal(channelId);
  twOpenProfileHistory(field);
}

function twCloseModal() {
  document.getElementById('twModalBackdrop').style.display = 'none';
  _unlockScroll();
  if (_twAccountState.obs) { _twAccountState.obs.disconnect(); _twAccountState.obs = null; }
  _twModalAccountId = null;
  _twModalAccount   = null;
  _twAccountState.videos = [];
}

async function _twLoadModalVideos(channelId) {
  const { ok, data } = await apiJSON(`/api/twitter/channels/${channelId}/videos`);
  if (!ok || _twModalAccountId !== channelId) return;
  _twAccountState.videos = data.map(v => ({ ...v, description: v.title || v.description }));

  if (_twModalPendingHighlight) {
    const { videoId, filter, sortField, sortDir } = _twModalPendingHighlight;
    _twModalPendingHighlight   = null;
    _twAccountState.view       = 'list';
    _twAccountState.filter     = filter;
    _twAccountState.sort       = { field: sortField, dir: sortDir };
    _mRenderColHdrs(_TW_MODAL_CFG);
    _mRenderToolbar(_TW_MODAL_CFG, _twAccountState.videos);
    _mRenderList(_TW_MODAL_CFG);
    const row = document.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('video-row-highlight');
      row.addEventListener('mouseenter', () => row.classList.remove('video-row-highlight'), { once: true });
    }
  } else {
    const historyOpen = document.getElementById('twPhistPanel').style.display !== 'none';
    if (!historyOpen) {
      _mRenderToolbar(_TW_MODAL_CFG, _twAccountState.videos);
      _mRenderList(_TW_MODAL_CFG);
    }
  }
}

function _renderTwModalHeader(ch) {
  const isInactive = ch.tracking_enabled === 0;
  const { cls: trackingCls, label: trackingLbl } = _trackingBadge(ch.tracking_enabled);
  const checked    = _fmtLastChecked(ch.last_checked);
  const follStr    = ch.subscriber_count != null ? `${_fmtLarge(ch.subscriber_count)} followers` : '';
  const twUrl      = `https://twitter.com/${esc(ch.handle)}`;

  document.getElementById('twModalHeader').innerHTML = `
    <div class="modal-avatar-wrap">
      <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
      ${ch.avatar_cached ? `<img class="modal-avatar" src="/api/twitter/channels/${esc(ch.channel_id)}/avatar" alt=""
           onerror="this.style.display='none'"
           onclick="openImgModalUrl('/api/twitter/channels/${esc(ch.channel_id)}/avatar')">` : ''}
    </div>
    <div class="modal-user-body">
      <div class="modal-name-row">
        <span class="modal-name">${esc(ch.display_name || ch.handle)}</span>
        <span class="account-status ${trackingCls}">${trackingLbl}</span>
        <label class="tracking-toggle" title="${isInactive ? 'Tweet tracking off' : 'Tweet tracking on'}">
          <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="twSetTracking('${esc(ch.channel_id)}', this.checked)">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">Track tweets</span>
        </label>
      </div>
      <div class="modal-handle">
        <a href="${twUrl}" target="_blank" rel="noopener" class="tt-link">@${esc(ch.handle)}</a>
        <span style="color:var(--muted);font-size:12px;margin-left:6px">${esc(ch.channel_id)}</span>
      </div>
      <div class="modal-stats-row">
        ${follStr ? `<span><strong>${esc(follStr)}</strong></span>` : ''}
        <span><strong>${ch.video_total || 0}</strong> saved locally</span>
        ${ch.video_deleted   ? `<span style="color:var(--red)"><strong>${ch.video_deleted}</strong> deleted</span>` : ''}
        ${ch.video_undeleted ? `<span style="color:var(--yellow)"><strong>${ch.video_undeleted}</strong> restored</span>` : ''}
        <span style="color:var(--muted)">${esc(checked)}</span>
      </div>
      ${ch.description ? `<div class="modal-bio" onclick="this.classList.toggle('expanded')">${esc(ch.description)}</div>` : ''}
      <div style="display:flex;align-items:flex-start;gap:6px;margin-top:8px">
        <textarea placeholder="Add a note about this account…"
          onblur="twSaveComment('${esc(ch.channel_id)}', this.value)"
          style="flex:1;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;
                 background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                 color:var(--text);font-family:inherit;line-height:1.5"
        >${esc(ch.comment || '')}</textarea>
      </div>
    </div>
  `;
}

async function twSaveComment(id, value) {
  const ok = await _saveCreatorComment('/api/twitter/channels', id, value, twAccounts, 'channel_id');
  if (ok && _twModalAccount && _twModalAccount.channel_id === id) _twModalAccount.comment = value.trim() || null;
}

// Modal engine delegates

function twSetModalFilter(f)       { _mSetFilter(_TW_MODAL_CFG, f); }
function twSetModalTypeFilter(t)   { _mSetTypeFilter(_TW_MODAL_CFG, t); }
function twToggleModalToolbar()    { _mToggleToolbar(_TW_MODAL_CFG); }
function twSetModalSort(f)         { _mSetSort(_TW_MODAL_CFG, f); }
function twSetModalView(view) {
  _twAccountState.view = view;
  const toolbar = document.getElementById('twModalToolbar');
  toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === view);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _mRenderList(_TW_MODAL_CFG);
}
function twOnModalSearch(val) {
  _twAccountState.search = val.trim();
  _mRenderToolbar(_TW_MODAL_CFG, _twAccountState.videos);
  _mRenderList(_TW_MODAL_CFG);
}

// ── Profile history panel ─────────────────────────────────────────────────────

const _TW_PHIST_FIELD_LABELS = {
  handle: 'Handle', display_name: 'Display name', description: 'Bio', avatar: 'Avatar',
};

async function twOpenProfileHistory(field) {
  if (!_twModalAccountId) return;
  const panel   = document.getElementById('twPhistPanel');
  const vidList = document.getElementById('twModalVideoList');
  if (!panel || !vidList) return;

  vidList.style.display = 'none';
  panel.style.display   = '';

  _twPhistField = field || 'all';
  _twPhistChId  = _twModalAccountId;

  panel.innerHTML = '<div class="vlist-loading">Loading history…</div>';

  const { ok, data } = await apiJSON(`/api/twitter/channels/${_twModalAccountId}/profile-history`);
  if (!ok || _twPhistChId !== _twModalAccountId) return;
  _twPhistData = data;
  _twRenderPhistPanel();
}

function twCloseProfileHistory() {
  const panel   = document.getElementById('twPhistPanel');
  const vidList = document.getElementById('twModalVideoList');
  if (panel)   panel.style.display   = 'none';
  if (vidList) vidList.style.display = '';
  _twPhistData  = [];
  _twPhistField = 'all';
}

function _twRenderPhistPanel() {
  const panel = document.getElementById('twPhistPanel');
  if (!panel) return;

  const entries = _twPhistField === 'all'
    ? _twPhistData
    : _twPhistData.filter(e => e.field === _twPhistField);

  const fields  = [...new Set(_twPhistData.map(e => e.field))];
  const fieldPills = ['all', ...fields].map(f => {
    const active = _twPhistField === f ? ' active' : '';
    const label  = f === 'all' ? 'All' : (_TW_PHIST_FIELD_LABELS[f] || f);
    return `<button class="filter-pill${active}" onclick="twPhistSetField('${esc(f)}')">${label}</button>`;
  }).join('');

  const ch = _twModalAccount;

  panel.innerHTML = `
    <div class="phist-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
      <div class="filter-pills" style="flex:1">${fieldPills}</div>
      <button class="btn-ghost" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="twCloseProfileHistory()">Back to tweets</button>
    </div>
    ${entries.length
      ? entries.map(e => _twPhistEntryHtml(e, ch)).join('')
      : `<div style="color:var(--muted);font-size:13px;padding:12px 0">No profile changes recorded${_twPhistField !== 'all' ? ' for this field' : ''}.</div>`}
  `;
  panel.querySelectorAll('.filter-pills').forEach(_placeGlider);
}

function _twPhistEntryHtml(e, ch) {
  const dateStr    = _dtFmt.format(new Date(e.changed_at * 1000));
  const fieldLabel = _TW_PHIST_FIELD_LABELS[e.field] || e.field;

  if (e.field === 'avatar') {
    const chId   = esc(ch ? ch.channel_id : _twPhistChId || '');
    const oldSrc = `/api/twitter/channels/${chId}/avatar-history/${encodeURIComponent(e.old_value)}`;
    const img    = (src, label) =>
      `<div class="phist-avatar-col">
        <span class="phist-side-label">${label}</span>
        <img class="phist-avatar-lg" src="${src}" alt="${label}"
             onerror="this.style.visibility='hidden'"
             onclick="openImgModalUrl('${src}')">
      </div>`;
    return `<div class="phist-entry">
      <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
      <div class="phist-avatar-diff">
        ${img(oldSrc, 'Old')}
        <div class="phist-arrow">→</div>
        ${img(`/api/twitter/channels/${chId}/avatar`, 'Current')}
      </div>
    </div>`;
  }

  const valHtml = v => v
    ? `<div class="phist-value">${esc(v)}</div>`
    : `<div class="phist-value empty">(empty)</div>`;
  return `<div class="phist-entry">
    <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
    <div class="phist-diff">
      <div class="phist-side"><div class="phist-side-hdr"><span class="phist-side-label">Old</span></div>${valHtml(e.old_value)}</div>
      <div class="phist-arrow">→</div>
      <div class="phist-side"><div class="phist-side-hdr"><span class="phist-side-label">New</span></div>${valHtml(null)}</div>
    </div>
  </div>`;
}

function twPhistSetField(field) {
  _twPhistField = field;
  _twRenderPhistPanel();
}

// ── Log panel ─────────────────────────────────────────────────────────────────

let _twTrackingView = 'accounts';

function twSetTrackingView(view) {
  _twTrackingView = view;
  const searchEl = document.getElementById('twSearch');
  if (searchEl) {
    searchEl.style.display = view === 'log' ? 'none' : '';
    if (view !== 'log') searchEl.value = '';
  }
  const countEl = document.getElementById('twAccountCount');
  if (countEl) countEl.style.display = view === 'log' ? 'none' : '';
  twSearch = '';
  document.getElementById('twTvAccounts').classList.toggle('active', view === 'accounts');
  document.getElementById('twTvLog').classList.toggle('active', view === 'log');
  const grid   = document.getElementById('twChannelsGrid');
  const logPnl = document.getElementById('twLogPanel');
  const ctrl   = document.getElementById('twControls');
  if (grid)   grid.style.display   = view === 'accounts' ? '' : 'none';
  if (logPnl) logPnl.style.display = view === 'log'      ? '' : 'none';
  if (ctrl)   ctrl.style.display   = view === 'accounts' ? '' : 'none';
  if (view === 'accounts') renderTwAccounts();
  _placeGlider(document.getElementById('twTvAccounts').closest('.filter-pills'));
}

// ── Keyboard handler (Escape) ─────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('twModalBackdrop')?.style.display !== 'none') {
    twCloseModal();
  }
}, true);

// ── Init ──────────────────────────────────────────────────────────────────────

loadTwAccounts();
loadTwStatus();
loadTwStats();
loadTwRecent();
twLoadQueue();
loadTwSettings();

setInterval(loadTwStatus,   5000);
setInterval(loadTwAccounts, 15000);
setInterval(loadTwStats,    60000);
setInterval(loadTwRecent,   30000);
setInterval(twLoadQueue,     3000);
