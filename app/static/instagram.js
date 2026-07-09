// ── State ─────────────────────────────────────────────────────────────────────

let igProfiles        = [];
let igSort            = { field: 'handle', dir: 'asc' };
let igFilter          = { stat: 'all', star: 'all' };
let igSearch          = '';
let igPending         = {};
const igDismissed     = new Set();
let igRunQueue        = [];
let igRunCurrent      = null;
let igLoopRunning     = false;
let igCurrentProfile  = null;
let igLogLines        = [];
let igLogClearIndex   = 0;
let _igLogClearRestored = false;
let igCleanupPoll     = null;

// ── Sort direction labels ─────────────────────────────────────────────────────

const _IG_SORT_DIR_LABELS = {
  handle:           { asc: 'A → Z',      desc: 'Z → A'      },
  display_name:     { asc: 'A → Z',      desc: 'Z → A'      },
  subscriber_count: { asc: 'Low → High', desc: 'High → Low' },
  video_total:      { asc: 'Low → High', desc: 'High → Low' },
  video_deleted:    { asc: 'Low → High', desc: 'High → Low' },
  added_at:         { asc: 'Oldest first', desc: 'Newest first' },
};

// ── Instagram-specific render helpers ────────────────────────────────────────

function _igThumbCell(v) {
  const id = esc(v.video_id);
  return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
    <img class="video-thumb" src="/api/instagram/videos/${id}/thumbnail" alt="" loading="lazy"
         onerror="this.style.opacity='.15'"
         onclick="event.stopPropagation();igOpenVidModal('${id}')" title="Play video" style="cursor:pointer">
    ${_playBadge}
  </div>`;
}

function _igVideoActionBtns(v) {
  const id = esc(v.video_id);
  if (v.file_path) {
    return `<a class="play-btn" href="/api/instagram/videos/${id}/file" download="${id}.mp4"
             onclick="event.stopPropagation()" title="Download video">${_dlIcon}</a>`;
  }
  return '';
}

function igOpenImgModal(videoId) {
  openImgModalUrl(`/api/instagram/videos/${encodeURIComponent(videoId)}/thumbnail`);
}

function igOpenVidModal(videoId) {
  const vid = document.getElementById('vidModalPlayer');
  vid.src = `/api/instagram/videos/${encodeURIComponent(videoId)}/file`;
  document.getElementById('vidModal').style.display = 'flex';
  _lockScroll();
  vid.play().catch(() => {});
}

// ── Instagram video column config ─────────────────────────────────────────────

const IG_VCOLS = [
  { field: null,            label: '' },
  { field: null,            label: 'Title' },
  { field: 'status',        label: 'Status' },
  { field: 'view_count',    label: 'Views' },
  { field: 'upload_date',   label: 'Uploaded' },
  { field: 'download_date', label: 'Saved' },
  { field: 'deleted_at',    label: 'Deleted' },
  { field: null,            label: '' },
];

const _igProfileState = {
  videos: [], filter: 'all', typeFilter: 'all', search: '',
  sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, obs: null,
  toolbarExpanded: false, view: 'list',
};

const _IG_MODAL_CFG = {
  st:             _igProfileState,
  listElId:       'igModalVideoList',
  toolbarElId:    'igModalToolbar',
  cols:           IG_VCOLS,
  colsCls:        'vcols',
  pageSize:       50,
  uploadDateFmt:  fmtDateOnly,
  filterFn:     'igSetModalFilter',
  typeFilterFn: 'igSetModalTypeFilter',
  sortFn:       'igSetModalSort',
  toggleFn:     'igToggleModalToolbar',
  searchFn:     'igOnModalSearch',
  authorCol:    null,
  hasSearch:    true,
  hasViewToggle: true,
  viewFn:       'igSetModalView',
  viewKeys: [
    { key: 'list',   icon: _listViewIcon, title: 'List view' },
    { key: 'videos', icon: _gridViewIcon, title: 'Grid view' },
  ],
  viewVideoFilter: (view, vids) => vids,
  gridClassFn: () => '',
  typeIconFn:  () => _playBadge,
  gridId:       'igVideoGrid',
  hasPhistBtn:  true,
  phistBtnFn:   'igOpenProfileHistory',
  thumbCellFn:  _igThumbCell,
  actionBtnsFn: _igVideoActionBtns,
  previewFn:    'igOpenImgModal',
  gridThumbSrc: v => `/api/instagram/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => igOpenVidModal(v.video_id),
};

// ── Stats panel ───────────────────────────────────────────────────────────────

function renderIgStats(s) {
  _renderStatGrid('igStatsGrid', [
    { label: 'Tracked profiles', value: (s.channel_count  || 0).toLocaleString() },
    { label: 'Saved posts',      value: (s.saved_count    || 0).toLocaleString() },
    { label: 'Deleted',          value: (s.deleted_count  || 0).toLocaleString() },
    { label: 'Latest saved',     value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
    { label: 'Total views',      value: _fmtLarge(s.total_views || 0) },
  ]);
}

async function loadIgStats() {
  const { ok, data } = await apiJSON('/api/instagram/stats');
  if (ok) renderIgStats(data);
}

// ── Recent panel ──────────────────────────────────────────────────────────────

const _IG_FIELD_LABELS = {
  handle: 'Handle', display_name: 'Display name', description: 'Description', avatar: 'Avatar',
};

const _IG_RECENT_LOG_TITLES = {
  'deletions':       'All Deleted Posts',
  'profile-changes': 'All Profile Changes',
  'saved':           'All Saved Posts',
};

function _igRenderSavedRow(g, now) {
  const row = document.createElement('div');
  row.className = 'recent-entry';
  row.title = `Open @${g.handle}`;
  row.onclick = () => igOpenModal(g.channel_id);
  row.innerHTML = `
    <span class="recent-date">${_recentDate(g.download_date, now)}</span>
    <span class="recent-name">@${esc(g.handle)}</span>
    <span class="recent-detail">${g.count}x</span>`;
  return row;
}

function _igRenderOtherRow(item, type, now) {
  const row = document.createElement('div');
  row.className = 'recent-entry';
  if (type === 'deletions') {
    row.title = `Open @${item.handle}`;
    row.onclick = () => igOpenModalAndHighlight(item.channel_id, item.video_id);
    row.innerHTML = `
      <span class="recent-date">${_recentDate(item.deleted_at, now)}</span>
      <span class="recent-name">@${esc(item.handle)}</span>
      <span class="recent-detail">${esc((item.video_id || '').slice(0, 11))}</span>`;
  } else {
    const label = _IG_FIELD_LABELS[item.field] || item.field;
    row.title = `Open @${item.handle} · ${label} history`;
    row.onclick = () => igOpenModalWithHistory(item.channel_id, item.field);
    row.innerHTML = `
      <span class="recent-date">${_recentDate(item.changed_at, now)}</span>
      <span class="recent-name">@${esc(item.handle)}</span>
      <span class="recent-detail">${esc(label)}</span>`;
  }
  return row;
}

function igOpenRecentLog(type) {
  _openRecentLogModal(type, {
    apiBase:     '/api/instagram/recent',
    titles:      _IG_RECENT_LOG_TITLES,
    groupKey:    'channel_id',
    renderSaved: _igRenderSavedRow,
    renderOther: _igRenderOtherRow,
  });
}

function renderIgRecent(data) {
  const leftEl  = document.getElementById('igRecentLeft');
  const rightEl = document.getElementById('igRecentRight');
  if (!leftEl || !rightEl) return;
  const now = new Date();

  let left = '';

  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="igOpenRecentLog('deletions')" title="View all deleted posts">Recently deleted</div>`;
  if (data.deletions && data.deletions.length) {
    left += data.deletions.map(d => {
      const onclick = `igOpenModalAndHighlight('${esc(d.channel_id)}','${esc(d.video_id)}')`;
      return `<div class="recent-entry" onclick="${onclick}" title="Open @${esc(d.handle)}">
        <span class="recent-date">${_recentDate(d.deleted_at, now)}</span>
        <span class="recent-name">@${esc(d.handle)}</span>
        <span class="recent-detail">${esc((d.video_id || '').slice(0, 11))}</span>
      </div>`;
    }).join('');
  } else {
    left += `<div class="recent-empty">No deleted posts yet</div>`;
  }
  left += `</div>`;

  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="igOpenRecentLog('profile-changes')" title="View all profile changes">Recently changed profile</div>`;
  if (data.profile_changes && data.profile_changes.length) {
    left += data.profile_changes.map(p =>
      `<div class="recent-entry" onclick="igOpenModalWithHistory('${esc(p.channel_id)}','${esc(p.field)}')" title="Open @${esc(p.handle)}">
        <span class="recent-date">${_recentDate(p.changed_at, now)}</span>
        <span class="recent-name">@${esc(p.handle)}</span>
        <span class="recent-detail">${esc(_IG_FIELD_LABELS[p.field] || p.field)}</span>
      </div>`
    ).join('');
  } else {
    left += `<div class="recent-empty">No profile changes recorded yet</div>`;
  }
  left += `</div>`;

  leftEl.innerHTML = left;

  let right = '';
  right += `<div class="recent-section">`;
  right += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="igOpenRecentLog('saved')" title="View all saved posts">Recently saved</div>`;
  if (data.saved && data.saved.length) {
    right += data.saved.map(g =>
      `<div class="recent-entry" onclick="igOpenModal('${esc(g.channel_id)}')" title="Open @${esc(g.handle)}">
        <span class="recent-date">${_recentDate(g.download_date, now)}</span>
        <span class="recent-name">@${esc(g.handle)}</span>
        <span class="recent-detail">${g.count}x</span>
      </div>`
    ).join('');
  } else {
    right += `<div class="recent-empty">No posts saved yet</div>`;
  }
  right += `</div>`;

  rightEl.innerHTML = right;
}

async function loadIgRecent() {
  const { ok, data } = await apiJSON('/api/instagram/recent');
  if (ok) renderIgRecent(data);
}

// ── Loop status ───────────────────────────────────────────────────────────────

const _igEl = {
  last:     () => document.getElementById('igLoopLast'),
  duration: () => document.getElementById('igLoopDuration'),
  next:     () => document.getElementById('igLoopNext'),
  newVids:  () => document.getElementById('igLoopNewVideos'),
  btn:      () => document.getElementById('igTriggerBtn'),
  stopBtn:  () => document.getElementById('igStopBtn'),
};

function renderIgStatus(state) {
  igLoopRunning   = state.loop_running;
  igCurrentProfile = state.loop_current_channel;
  igRunQueue      = state.run_queue  || [];
  igRunCurrent    = state.run_current || null;

  const el = _igEl;
  if (el.last())     el.last().textContent     = state.loop_last_end ? `Last: ${fmt.rel(state.loop_last_end)}` : 'Never run';
  if (el.duration()) el.duration().textContent = state.loop_last_duration_secs != null ? fmt.dur(state.loop_last_duration_secs) : '';
  if (el.next())     el.next().textContent     = state.loop_next ? `Next: ${fmt.relFuture(state.loop_next)}` : '';
  if (el.newVids())  el.newVids().textContent  = state.loop_last_new_videos != null ? `${state.loop_last_new_videos} new` : '';
  if (el.btn())     el.btn().disabled     = igLoopRunning;
  if (el.stopBtn()) el.stopBtn().disabled = !igLoopRunning;

  const badge = document.getElementById('statusBadge');
  const text  = document.getElementById('statusText');
  const active = location.hash === '#instagram';
  if (active && badge && text) {
    const anyActive = igLoopRunning || !!igRunCurrent;
    badge.className  = `status-badge${anyActive ? ' running' : ''}`;
    text.textContent = anyActive
      ? (igCurrentProfile ? `Downloading @${igCurrentProfile}` : 'Running…')
      : 'Idle';
  }

  const logBody = document.getElementById('igLogBody');
  if (logBody && state.logs) {
    if (!_igLogClearRestored) {
      _igLogClearRestored = true;
      const mark = localStorage.getItem('ig-logClearWatermark');
      if (mark) {
        const lines = state.logs;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] === mark) { igLogClearIndex = i + 1; break; }
        }
      }
    }
    const newLines = state.logs.slice(igLogClearIndex);
    if (newLines.length !== igLogLines.length || (igLogLines.length && igLogLines[igLogLines.length - 1] !== newLines[newLines.length - 1])) {
      igLogLines = newLines;
      const auto = document.getElementById('igAutoScroll')?.checked !== false;
      logBody.innerHTML = igLogLines.map(l => `<div class="log-line">${esc(l)}</div>`).join('');
      if (auto) logBody.scrollTop = logBody.scrollHeight;
    }
  }

  updateIgRunStates();
}

function updateIgRunStates() {
  document.querySelectorAll('.ig-profile-card[data-channelid]').forEach(card => {
    const id      = card.dataset.channelid;
    const inQueue = igRunQueue.includes(id);
    const isCur   = igRunCurrent === id;
    const btn     = card.querySelector('.btn-run');
    if (!btn) return;
    btn.textContent = isCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
    btn.disabled    = inQueue || isCur;
  });
}

async function loadIgStatus() {
  const { ok, data } = await apiJSON('/api/instagram/status');
  if (ok) renderIgStatus(data);
}

function igClearLog() {
  const lastLine = igLogLines[igLogLines.length - 1];
  if (lastLine) {
    localStorage.setItem('ig-logClearWatermark', lastLine);
  } else {
    localStorage.removeItem('ig-logClearWatermark');
  }
  igLogClearIndex = 0;
  igLogLines = [];
  const logBody = document.getElementById('igLogBody');
  if (logBody) logBody.innerHTML = '';
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadIgSessionStatus() {
  const { ok, data } = await apiJSON('/api/instagram/session');
  if (!ok) return;
  setHdrAuth('instagram', !!data.logged_in, data.logged_in ? 'Logged in' : 'Not logged in');
  const pill      = document.getElementById('igSessionPill');
  const pillTxt   = document.getElementById('igSessionPillText');
  const logoutBtn = document.getElementById('igSessionLogoutBtn');
  const loginForm = document.getElementById('igLoginForm');
  if (!pill) return;
  if (data.logged_in) {
    pill.className      = 'cookie-pill present';
    pillTxt.textContent = `Logged in as @${data.username}`;
    if (logoutBtn) logoutBtn.style.display = '';
    if (loginForm) loginForm.style.display = 'none';
  } else {
    pill.className      = 'cookie-pill absent';
    pillTxt.textContent = data.saved_username ? `Session saved (@${data.saved_username})` : 'Not logged in';
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (loginForm) loginForm.style.display = '';
  }
}

async function igSessionLogin() {
  const user     = (document.getElementById('igLoginUser')?.value || '').trim();
  const pass     = document.getElementById('igLoginPass')?.value || '';
  const btn      = document.getElementById('igLoginBtn');
  const statusEl = document.getElementById('igLoginStatus');
  if (!user || !pass) { if (statusEl) statusEl.textContent = 'Enter username and password.'; return; }
  btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Logging in...'; statusEl.style.color = 'var(--muted)'; }
  const { ok, data } = await apiJSON('/api/instagram/session', {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  btn.disabled = false;
  if (ok) {
    if (statusEl) statusEl.textContent = '';
    const passEl = document.getElementById('igLoginPass');
    if (passEl) passEl.value = '';
    loadIgSessionStatus();
    showToast(`Logged in as @${data.username}`, { type: 'success', duration: 3000 });
  } else {
    if (statusEl) { statusEl.textContent = data.error || 'Login failed.'; statusEl.style.color = 'var(--red)'; }
  }
}

async function igSessionLogout() {
  const { ok } = await apiJSON('/api/instagram/session', { method: 'DELETE' });
  if (ok) {
    loadIgSessionStatus();
    showToast('Logged out.', { type: 'success', duration: 2500 });
  }
}

async function loadIgSettings() {
  loadIgSessionStatus();
  const { ok, data } = await apiJSON('/api/instagram/settings');
  if (!ok) return;
  const el = document.getElementById('igLoopIntervalInput');
  if (el) el.value = data.loop_interval_minutes;
}

async function igSaveLoopSettings() {
  const val = parseInt(document.getElementById('igLoopIntervalInput')?.value, 10);
  if (!val || val < 1) { showToast('Interval must be a positive integer.', { type: 'warning', duration: 4000 }); return; }
  const { ok, data } = await apiJSON('/api/instagram/settings', {
    method: 'PATCH',
    body: JSON.stringify({ loop_interval_minutes: val }),
  });
  if (!ok) { showToast(data.error || 'Could not save settings', { type: 'error' }); return; }
  showToast('Settings saved.', { type: 'success', duration: 2500 });
}

function igTriggerLoop() { return _triggerLoop('igTriggerBtn', '/api/instagram/trigger', 'Could not trigger loop'); }

async function igStopLoop() {
  const btn = document.getElementById('igStopBtn');
  if (btn) btn.disabled = true;
  const { ok } = await apiJSON('/api/instagram/stop', { method: 'POST' });
  if (!ok) {
    if (btn) btn.disabled = false;
    showToast('Could not stop loop.', { type: 'error' });
  }
}

// ── DB cleanup ────────────────────────────────────────────────────────────────

const _igCleanupWidget = _makeJobWidget('ig-cleanup');

async function igTriggerCleanup() {
  const btn = document.getElementById('job-ig-cleanup-btn');
  if (btn) btn.disabled = true;
  const { ok, data } = await apiJSON('/api/instagram/db/cleanup', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start cleanup', { type: 'error' }); if (btn) btn.disabled = false; return; }
  _igCleanupWidget.update({ barPct: null, label: 'Running…' });
  if (igCleanupPoll) return;
  igCleanupPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/instagram/db/cleanup');
    if (!ok) return;
    if (data.running) {
      _igCleanupWidget.update({ barPct: null, label: data.current || 'Running…', steps: data.steps });
    } else {
      clearInterval(igCleanupPoll); igCleanupPoll = null;
      if (btn) btn.disabled = false;
      _igCleanupWidget.update({
        barPct: 100,
        label: `Done - ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
        steps: data.steps,
      });
    }
  }, 800);
}

// ── Add profile form ──────────────────────────────────────────────────────────

document.getElementById('igHandleInput').addEventListener('input', function() {
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

document.getElementById('igHandleInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); igAddProfile(); }
});

document.getElementById('igHandleInput').addEventListener('paste', function(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

async function igAddProfile() {
  const input    = document.getElementById('igHandleInput');
  const statusEl = document.getElementById('igAddStatus');
  const raw      = input.textContent.trim();
  if (!raw) return;
  input.textContent = '';
  input.focus();

  statusEl.className   = 'add-status info';
  statusEl.textContent = 'Adding…';

  const { ok, data } = await apiJSON('/api/instagram/channels', {
    method: 'POST',
    body: JSON.stringify({ handle: raw }),
  });
  if (ok) {
    const handle = data.handle || raw.replace(/^@/, '');
    igDismissed.delete(handle);
    igPending[handle] = { status: 'pending' };
    statusEl.className   = 'add-status ok';
    statusEl.textContent = `@${handle} queued.`;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'add-status'; }, 5000);
    renderIgPending();
  } else {
    statusEl.className   = 'add-status error';
    statusEl.textContent = data.error || 'Failed.';
  }
}

async function igLoadQueue() {
  const { ok, data } = await apiJSON('/api/instagram/queue');
  if (!ok) return;
  let anyResolved = false;
  for (const h of Object.keys(igPending)) {
    if (!(h in data) && !igDismissed.has(h)) {
      delete igPending[h];
      anyResolved = true;
    }
  }
  for (const [h, info] of Object.entries(data)) {
    if (!igDismissed.has(h)) igPending[h] = info;
  }
  renderIgPending();
  if (anyResolved) loadIgProfiles();
}

function renderIgPending() {
  const container = document.getElementById('igPendingList');
  if (!container) return;
  const entries = Object.entries(igPending).filter(([h]) => !igDismissed.has(h));
  if (!entries.length) { container.innerHTML = ''; return; }
  container.innerHTML = entries.map(([handle, info]) => {
    if (info.status === 'pending') {
      return `<div class="pending-item"><span class="spinner"></span>Looking up @${esc(handle)}…</div>`;
    }
    return `<div class="pending-item error">Failed to add @${esc(handle)}: ${esc(info.message)} <button onclick="igDismissPending('${esc(handle)}')" title="Dismiss">×</button></div>`;
  }).join('');
}

async function igDismissPending(handle) {
  await apiJSON(`/api/instagram/queue/${encodeURIComponent(handle)}`, { method: 'DELETE' });
  delete igPending[handle];
  renderIgPending();
}

// ── Profile filters and sort ──────────────────────────────────────────────────

const IG_STAT_IDS = { all: 'igfStatAll', active: 'igfStatActive', inactive: 'igfStatInactive' };
const IG_STAR_IDS = { all: 'igfStarAll', starred: 'igfStarStarred' };

function setIgFilter(group, value) {
  igFilter[group] = value;
  const map = group === 'stat' ? IG_STAT_IDS : IG_STAR_IDS;
  Object.entries(map).forEach(([v, id]) => {
    document.getElementById(id)?.classList.toggle('active', v === value);
  });
  renderIgProfiles();
  const anchorId = group === 'stat' ? 'igfStatAll' : 'igfStarAll';
  _placeGlider(document.getElementById(anchorId).closest('.filter-pills'));
}

function setIgSortField(field) {
  igSort.field = field;
  igSort.dir   = (field === 'handle' || field === 'display_name') ? 'asc' : 'desc';
  _updateIgSortBtn();
  renderIgProfiles();
}

function toggleIgSortDir() {
  igSort.dir = igSort.dir === 'asc' ? 'desc' : 'asc';
  _updateIgSortBtn();
  renderIgProfiles();
}

function _updateIgSortBtn() {
  const btn = document.getElementById('igSortDirBtn');
  if (btn) btn.textContent = _IG_SORT_DIR_LABELS[igSort.field]?.[igSort.dir] ?? igSort.dir;
}

function resetIgFilters() {
  igSort   = { field: 'handle', dir: 'asc' };
  igFilter = { stat: 'all', star: 'all' };
  igSearch = '';
  const searchEl = document.getElementById('igSearch');
  if (searchEl) searchEl.value = '';
  const sel = document.getElementById('igSortField');
  if (sel) sel.value = 'handle';
  _updateIgSortBtn();
  Object.entries(IG_STAT_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  Object.entries(IG_STAR_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  renderIgProfiles();
  _placeGlider(document.getElementById('igfStatAll').closest('.filter-pills'));
  _placeGlider(document.getElementById('igfStarAll').closest('.filter-pills'));
}

function onIgSearch(val) {
  igSearch = val.trim();
  renderIgProfiles();
}

function _filteredIgProfiles() {
  const q = igSearch.toLowerCase();
  return igProfiles.filter(ch => {
    if (igFilter.stat === 'active'   && ch.tracking_enabled === 0) return false;
    if (igFilter.stat === 'inactive' && ch.tracking_enabled !== 0) return false;
    if (igFilter.star === 'starred'  && !ch.starred)               return false;
    if (q) {
      const hay = [ch.handle, ch.display_name, ch.channel_id, ch.description]
                  .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function _sortedIgProfiles() {
  const { field, dir } = igSort;
  return _filteredIgProfiles().sort((a, b) => {
    const av = field === 'display_name' ? (a.display_name || a.handle) : (a[field] ?? (field === 'handle' ? '' : 0));
    const bv = field === 'display_name' ? (b.display_name || b.handle) : (b[field] ?? (field === 'handle' ? '' : 0));
    return _cmp(av, bv, dir);
  });
}

// ── Profile cards ─────────────────────────────────────────────────────────────

const _IG_CARD_BATCH = 9;
let _igGridObs       = null;
let _igRenderedCount = 0;
let _igSortedCache   = [];

function _renderIgProfileCard(ch) {
  const isCurrent  = !!igCurrentProfile && ch.handle === igCurrentProfile;
  const isInactive = ch.tracking_enabled === 0;
  const { cls: trackingCls, label: trackingLabel } = _trackingBadge(ch.tracking_enabled);
  const checked    = _fmtLastChecked(ch.last_checked);
  const inQueue    = igRunQueue.includes(ch.channel_id);
  const isRunCur   = igRunCurrent === ch.channel_id;
  const runLabel   = isRunCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
  const runDis     = (inQueue || isRunCur) ? 'disabled' : '';
  const follStr    = ch.subscriber_count != null ? `${_fmtLarge(ch.subscriber_count)} followers` : '';

  return `
    <div class="user-card ig-profile-card${isCurrent ? ' user-card-current' : ''}${isInactive ? ' user-card-inactive' : ''}"
         data-channelid="${esc(ch.channel_id)}"
         onclick="if(!event.target.closest('button'))igOpenModal('${esc(ch.channel_id)}')"
         role="button" tabindex="0">
      <div class="user-card-top">
        <div class="avatar-wrap">
          <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
          ${ch.avatar_cached ? `<img class="user-avatar" src="/api/instagram/channels/${esc(ch.channel_id)}/avatar" alt=""
               onerror="this.style.display='none'"
               onclick="event.stopPropagation();openImgModalUrl('/api/instagram/channels/${esc(ch.channel_id)}/avatar')">` : ''}
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
          <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="event.stopPropagation();igToggleStar('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
          <button class="btn-run" ${runDis} onclick="event.stopPropagation();igRunProfile('${esc(ch.channel_id)}')">${runLabel}</button>
          <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>igRunProfileUpdate('${esc(ch.channel_id)}')},{label:'Remove',danger:true,onclick:()=>igRemoveProfile('${esc(ch.channel_id)}','@${esc(ch.handle)}')}])">&#x2022;&#x2022;&#x2022;</button>
        </div>
      </div>
    </div>
  `;
}

function _appendIgProfileCards() {
  const grid = document.getElementById('igChannelsGrid');
  _igGridObs = null;
  const next = _igSortedCache.slice(_igRenderedCount, _igRenderedCount + _IG_CARD_BATCH);
  if (!next.length) return;
  grid.insertAdjacentHTML('beforeend', next.map(_renderIgProfileCard).join(''));
  _igRenderedCount += next.length;
  if (_igSortedCache.length > _igRenderedCount) {
    _igGridObs = _attachGridSentinel(grid, _appendIgProfileCards);
  }
}

function renderIgProfiles() {
  if (_igGridObs) { _igGridObs.disconnect(); _igGridObs = null; }
  const grid = document.getElementById('igChannelsGrid');
  if (!grid) return;
  const filtered   = _filteredIgProfiles();
  const isFiltered = igFilter.stat !== 'all' || igFilter.star !== 'all' || !!igSearch;
  const countEl    = document.getElementById('igProfileCount');
  if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${igProfiles.length}` : igProfiles.length;

  if (!igProfiles.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No profiles tracked yet.</div>';
    _igRenderedCount = 0;
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No profiles match this filter.</div>'
      + _ghostCards(Math.min(igProfiles.length, _IG_CARD_BATCH));
    _igRenderedCount = 0;
    return;
  }

  _igSortedCache   = _sortedIgProfiles();
  const toShow     = Math.min(Math.max(_IG_CARD_BATCH, _igRenderedCount), _igSortedCache.length);
  const slice      = _igSortedCache.slice(0, toShow);
  grid.innerHTML   = slice.map(_renderIgProfileCard).join('')
    + (toShow < _IG_CARD_BATCH ? _ghostCards(_IG_CARD_BATCH - toShow) : '');
  _igRenderedCount = slice.length;

  if (_igSortedCache.length > _igRenderedCount) {
    _igGridObs = _attachGridSentinel(grid, _appendIgProfileCards);
  }
}

async function loadIgProfiles() {
  const { ok, data } = await apiJSON('/api/instagram/channels');
  if (ok) { igProfiles = data; renderIgProfiles(); }
}

async function igRunProfile(id)            { return _creatorRun('/api/instagram/channels', id, () => igRunQueue, q => { igRunQueue = q; }, renderIgProfiles); }
async function igRunProfileUpdate(id)      { return _creatorRunProfile('/api/instagram/channels', id, () => igRunQueue, q => { igRunQueue = q; }, renderIgProfiles); }
async function igRemoveProfile(id, label)  { return _creatorRemove('/api/instagram/channels', id, label, loadIgProfiles); }
async function igToggleStar(id)            { return _creatorToggleStar('/api/instagram/channels', id, igProfiles, 'channel_id', renderIgProfiles); }

// ── Profile tracking toggle ───────────────────────────────────────────────────

async function igSetTracking(channelId, enabled) {
  const { ok, data } = await apiJSON(`/api/instagram/channels/${channelId}/tracking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!ok) { showToast(data.error || 'Failed to update tracking', { type: 'error' }); return; }
  const ch = igProfiles.find(c => c.channel_id === channelId);
  if (ch) ch.tracking_enabled = enabled ? 1 : 0;
  if (_igModalProfileId === channelId && _igModalProfile) {
    _igModalProfile.tracking_enabled = enabled ? 1 : 0;
    _renderIgModalHeader(_igModalProfile);
  }
  renderIgProfiles();
}

// ── Profile detail modal ──────────────────────────────────────────────────────

let _igModalProfileId       = null;
let _igModalProfile         = null;
let _igModalPendingHighlight = null;

let _igPhistData  = [];
let _igPhistField = 'all';
let _igPhistChId  = null;

function igOpenModalAndHighlight(channelId, videoId, filter, sortField, sortDir) {
  _igModalPendingHighlight = {
    videoId,
    filter:    filter    || 'all',
    sortField: sortField || 'upload_date',
    sortDir:   sortDir   || 'desc',
  };
  igOpenModal(channelId);
}

function igOpenModal(channelId) {
  const ch = igProfiles.find(c => c.channel_id === channelId);
  if (!ch) return;
  _igModalProfileId = channelId;
  _igModalProfile   = ch;
  Object.assign(_igProfileState, {
    videos: [], filter: 'all', typeFilter: 'all', search: '',
    sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, toolbarExpanded: false,
    view: window.innerWidth <= 640 ? 'grid' : 'list',
  });
  if (_igProfileState.obs) { _igProfileState.obs.disconnect(); _igProfileState.obs = null; }

  _igPhistData  = [];
  _igPhistField = 'all';
  _igPhistChId  = null;
  document.getElementById('igPhistPanel').style.display      = 'none';
  document.getElementById('igModalVideoList').style.display  = '';

  document.getElementById('igModalBackdrop').style.display = 'flex';
  _lockScroll();

  _renderIgModalHeader(ch);
  _mRenderToolbar(_IG_MODAL_CFG, []);
  document.getElementById('igModalVideoList').innerHTML =
    '<div class="vlist-loading">Loading posts…</div>';

  _igLoadModalVideos(channelId);
}

function igOpenModalWithHistory(channelId, field) {
  igOpenModal(channelId);
  igOpenProfileHistory(field);
}

function igCloseModal() {
  document.getElementById('igModalBackdrop').style.display = 'none';
  _unlockScroll();
  if (_igProfileState.obs) { _igProfileState.obs.disconnect(); _igProfileState.obs = null; }
  _igModalProfileId = null;
  _igModalProfile   = null;
  _igProfileState.videos = [];
}

async function _igLoadModalVideos(channelId) {
  const { ok, data } = await apiJSON(`/api/instagram/channels/${channelId}/videos`);
  if (!ok || _igModalProfileId !== channelId) return;
  _igProfileState.videos = data.map(v => ({ ...v, description: v.title || v.description }));

  if (_igModalPendingHighlight) {
    const { videoId, filter, sortField, sortDir } = _igModalPendingHighlight;
    _igModalPendingHighlight   = null;
    _igProfileState.view       = 'list';
    _igProfileState.filter     = filter;
    _igProfileState.sort       = { field: sortField, dir: sortDir };
    _mRenderColHdrs(_IG_MODAL_CFG);
    _mRenderToolbar(_IG_MODAL_CFG, _igProfileState.videos);
    _mRenderList(_IG_MODAL_CFG);
    const row = document.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('video-row-highlight');
      row.addEventListener('mouseenter', () => row.classList.remove('video-row-highlight'), { once: true });
    }
  } else {
    const historyOpen = document.getElementById('igPhistPanel').style.display !== 'none';
    if (!historyOpen) {
      _mRenderToolbar(_IG_MODAL_CFG, _igProfileState.videos);
      _mRenderList(_IG_MODAL_CFG);
    }
  }
}

function _renderIgModalHeader(ch) {
  const isInactive = ch.tracking_enabled === 0;
  const { cls: trackingCls, label: trackingLbl } = _trackingBadge(ch.tracking_enabled);
  const checked    = _fmtLastChecked(ch.last_checked);
  const follStr    = ch.subscriber_count != null ? `${_fmtLarge(ch.subscriber_count)} followers` : '';
  const igUrl      = `https://www.instagram.com/${esc(ch.handle)}`;

  document.getElementById('igModalHeader').innerHTML = `
    <div class="modal-avatar-wrap">
      <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
      ${ch.avatar_cached ? `<img class="modal-avatar" src="/api/instagram/channels/${esc(ch.channel_id)}/avatar" alt=""
           onerror="this.style.display='none'"
           onclick="openImgModalUrl('/api/instagram/channels/${esc(ch.channel_id)}/avatar')">` : ''}
    </div>
    <div class="modal-user-body">
      <div class="modal-name-row">
        <span class="modal-name">${esc(ch.display_name || ch.handle)}</span>
        <span class="account-status ${trackingCls}">${trackingLbl}</span>
        <label class="tracking-toggle" title="${isInactive ? 'Post tracking off' : 'Post tracking on'}">
          <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="igSetTracking('${esc(ch.channel_id)}', this.checked)">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">Track posts</span>
        </label>
      </div>
      <div class="modal-handle">
        <a href="${igUrl}" target="_blank" rel="noopener" class="tt-link">@${esc(ch.handle)}</a>
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
        <textarea placeholder="Add a note about this profile…"
          onblur="igSaveComment('${esc(ch.channel_id)}', this.value)"
          style="flex:1;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;
                 background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                 color:var(--text);font-family:inherit;line-height:1.5"
        >${esc(ch.comment || '')}</textarea>
      </div>
    </div>
  `;
}

async function igSaveComment(id, value) {
  const ok = await _saveCreatorComment('/api/instagram/channels', id, value, igProfiles, 'channel_id');
  if (ok && _igModalProfile && _igModalProfile.channel_id === id) _igModalProfile.comment = value.trim() || null;
}

// Modal engine delegates

function igSetModalFilter(f)       { _mSetFilter(_IG_MODAL_CFG, f); }
function igSetModalTypeFilter(t)   { _mSetTypeFilter(_IG_MODAL_CFG, t); }
function igToggleModalToolbar()    { _mToggleToolbar(_IG_MODAL_CFG); }
function igSetModalSort(f)         { _mSetSort(_IG_MODAL_CFG, f); }
function igSetModalView(view) {
  _igProfileState.view = view;
  const toolbar = document.getElementById('igModalToolbar');
  toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === view);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _mRenderList(_IG_MODAL_CFG);
}
function igOnModalSearch(val) {
  _igProfileState.search = val.trim();
  _mRenderToolbar(_IG_MODAL_CFG, _igProfileState.videos);
  _mRenderList(_IG_MODAL_CFG);
}

// ── Profile history panel ─────────────────────────────────────────────────────

const _IG_PHIST_FIELD_LABELS = {
  handle: 'Handle', display_name: 'Display name', description: 'Bio', avatar: 'Avatar',
};

async function igOpenProfileHistory(field) {
  if (!_igModalProfileId) return;
  const panel   = document.getElementById('igPhistPanel');
  const vidList = document.getElementById('igModalVideoList');
  if (!panel || !vidList) return;

  vidList.style.display = 'none';
  panel.style.display   = '';

  _igPhistField = field || 'all';
  _igPhistChId  = _igModalProfileId;

  panel.innerHTML = '<div class="vlist-loading">Loading history…</div>';

  const { ok, data } = await apiJSON(`/api/instagram/channels/${_igModalProfileId}/profile-history`);
  if (!ok || _igPhistChId !== _igModalProfileId) return;
  _igPhistData = data;
  _igRenderPhistPanel();
}

function igCloseProfileHistory() {
  const panel   = document.getElementById('igPhistPanel');
  const vidList = document.getElementById('igModalVideoList');
  if (panel)   panel.style.display   = 'none';
  if (vidList) vidList.style.display = '';
  _igPhistData  = [];
  _igPhistField = 'all';
}

function _igRenderPhistPanel() {
  const panel = document.getElementById('igPhistPanel');
  if (!panel) return;

  const entries = _igPhistField === 'all'
    ? _igPhistData
    : _igPhistData.filter(e => e.field === _igPhistField);

  const fields  = [...new Set(_igPhistData.map(e => e.field))];
  const fieldPills = ['all', ...fields].map(f => {
    const active = _igPhistField === f ? ' active' : '';
    const label  = f === 'all' ? 'All' : (_IG_PHIST_FIELD_LABELS[f] || f);
    return `<button class="filter-pill${active}" onclick="igPhistSetField('${esc(f)}')">${label}</button>`;
  }).join('');

  const ch = _igModalProfile;

  panel.innerHTML = `
    <div class="phist-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
      <div class="filter-pills" style="flex:1">${fieldPills}</div>
      <button class="btn-ghost" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="igCloseProfileHistory()">Back to posts</button>
    </div>
    ${entries.length
      ? entries.map(e => _igPhistEntryHtml(e, ch)).join('')
      : `<div style="color:var(--muted);font-size:13px;padding:12px 0">No profile changes recorded${_igPhistField !== 'all' ? ' for this field' : ''}.</div>`}
  `;
  panel.querySelectorAll('.filter-pills').forEach(_placeGlider);
}

function _igPhistEntryHtml(e, ch) {
  const dateStr    = _dtFmt.format(new Date(e.changed_at * 1000));
  const fieldLabel = _IG_PHIST_FIELD_LABELS[e.field] || e.field;

  if (e.field === 'avatar') {
    const chId   = esc(ch ? ch.channel_id : _igPhistChId || '');
    const oldSrc = `/api/instagram/channels/${chId}/avatar-history/${encodeURIComponent(e.old_value)}`;
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
        ${img(`/api/instagram/channels/${chId}/avatar`, 'Current')}
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

function igPhistSetField(field) {
  _igPhistField = field;
  _igRenderPhistPanel();
}

// ── Log panel ─────────────────────────────────────────────────────────────────

let _igTrackingView = 'profiles';

function igSetTrackingView(view) {
  _igTrackingView = view;
  const searchEl = document.getElementById('igSearch');
  if (searchEl) {
    searchEl.style.display = view === 'log' ? 'none' : '';
    if (view !== 'log') searchEl.value = '';
  }
  const countEl = document.getElementById('igProfileCount');
  if (countEl) countEl.style.display = view === 'log' ? 'none' : '';
  igSearch = '';
  document.getElementById('igTvProfiles').classList.toggle('active', view === 'profiles');
  document.getElementById('igTvLog').classList.toggle('active', view === 'log');
  const grid   = document.getElementById('igChannelsGrid');
  const logPnl = document.getElementById('igLogPanel');
  const ctrl   = document.getElementById('igControls');
  if (grid)   grid.style.display   = view === 'profiles' ? '' : 'none';
  if (logPnl) logPnl.style.display = view === 'log'      ? '' : 'none';
  if (ctrl)   ctrl.style.display   = view === 'profiles' ? '' : 'none';
  if (view === 'profiles') renderIgProfiles();
  _placeGlider(document.getElementById('igTvProfiles').closest('.filter-pills'));
}

// ── Keyboard handler (Escape) ─────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('igModalBackdrop')?.style.display !== 'none') {
    igCloseModal();
  }
}, true);

// ── Diagnostics ───────────────────────────────────────────────────────────────

function igDiagRun()  { _platformDiagRun('instagram', 'igDiag'); }
function igDiagCopy() { _platformDiagCopy('igDiag'); }

// ── Init ──────────────────────────────────────────────────────────────────────

loadIgProfiles();
loadIgStatus();
loadIgStats();
loadIgRecent();
igLoadQueue();
loadIgSettings();

setInterval(loadIgStatus,   5000);
setInterval(loadIgProfiles, 15000);
setInterval(loadIgStats,    60000);
setInterval(loadIgRecent,   30000);
setInterval(igLoadQueue,     3000);
