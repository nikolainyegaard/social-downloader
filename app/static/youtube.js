// ── State ─────────────────────────────────────────────────────────────────────

let ytChannels        = [];
let ytChSort          = { field: 'handle', dir: 'asc' };
let ytChFilter        = { stat: 'all', star: 'all' };
let ytChSearch        = '';
let ytPending         = {};
const ytDismissed     = new Set();
let ytRunQueue        = [];
let ytRunCurrent      = null;
let ytLoopRunning     = false;
let ytCurrentChannel  = null;
let ytLogLines        = [];
let ytLogClearIndex   = 0;
let ytCleanupPoll     = null;

// ── Sort direction labels ─────────────────────────────────────────────────────

const _YT_SORT_DIR_LABELS = {
  handle:           { asc: 'A → Z',      desc: 'Z → A'      },
  display_name:     { asc: 'A → Z',      desc: 'Z → A'      },
  subscriber_count: { asc: 'Low → High', desc: 'High → Low' },
  video_total:      { asc: 'Low → High', desc: 'High → Low' },
  video_deleted:    { asc: 'Low → High', desc: 'High → Low' },
  added_at:         { asc: 'Oldest first',    desc: 'Newest first'    },
  starred:          { asc: 'Unstarred first', desc: 'Starred first'   },
};

// ── YouTube-specific icons and badges ─────────────────────────────────────────

const _wideGridIcon   = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5"><rect x=".75" y="2" width="5.25" height="3" rx=".5"/><rect x="7" y="2" width="5.25" height="3" rx=".5"/><rect x=".75" y="8" width="5.25" height="3" rx=".5"/><rect x="7" y="8" width="5.25" height="3" rx=".5"/></svg>`;
const _vgridShortIcon = `<svg width="12" height="12" viewBox="0 0 9 9" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.2"><rect x="1.5" y=".5" width="6" height="8" rx=".75"/><polygon fill="rgba(255,255,255,.9)" stroke="none" points="3,2.5 7,4.5 3,6.5"/></svg>`;
const _ytShortsBadge  = `<span style="position:absolute;bottom:4px;right:4px;color:#fff;pointer-events:none;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))"><svg width="18" height="18" viewBox="0 0 9 9" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.2"><rect x="1.5" y=".5" width="6" height="8" rx=".75"/><polygon fill="rgba(255,255,255,.9)" stroke="none" points="3,2.5 7,4.5 3,6.5"/></svg></span>`;

// ── YouTube-specific render helpers ───────────────────────────────────────────

function _ytThumbCell(v) {
  const id = esc(v.video_id);
  const badge = v.content_type === 'short' ? _ytShortsBadge : _playBadge;
  return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
    <img class="video-thumb" src="/api/youtube/videos/${id}/thumbnail" alt="" loading="lazy"
         onerror="this.style.opacity='.15'"
         onclick="event.stopPropagation();ytOpenVidModal('${id}')" title="Play video" style="cursor:pointer">
    ${badge}
  </div>`;
}

function _ytVideoActionBtns(v) {
  const id = esc(v.video_id);
  if (v.file_path) {
    return `<a class="play-btn" href="/api/youtube/videos/${id}/file" download="${id}.mp4"
             onclick="event.stopPropagation()" title="Download video">${_dlIcon}</a>`;
  }
  return '';
}

function ytOpenImgModal(videoId) {
  openImgModalUrl(`/api/youtube/videos/${encodeURIComponent(videoId)}/thumbnail`);
}

function ytOpenVidModal(videoId) {
  const vid = document.getElementById('vidModalPlayer');
  vid.src = `/api/youtube/videos/${encodeURIComponent(videoId)}/file`;
  document.getElementById('vidModal').style.display = 'flex';
  _lockScroll();
  vid.play().catch(() => {});
}

// ── YouTube video column config ───────────────────────────────────────────────

const YT_VCOLS = [
  { field: null,            label: '' },
  { field: null,            label: 'Title' },
  { field: 'status',        label: 'Status' },
  { field: 'view_count',    label: 'Views' },
  { field: 'upload_date',   label: 'Uploaded' },
  { field: 'download_date', label: 'Saved' },
  { field: 'deleted_at',    label: 'Deleted' },
  { field: null,            label: '' },
];

const _ytChState = {
  videos: [], filter: 'all', typeFilter: 'all', search: '',
  sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, obs: null,
  toolbarExpanded: false, view: 'list',
};

const _YT_CH_MODAL_CFG = {
  st:             _ytChState,
  listElId:       'ytChModalVideoList',
  toolbarElId:    'ytChModalToolbar',
  cols:           YT_VCOLS,
  colsCls:        'vcols',
  pageSize:       50,
  uploadDateFmt:  fmtDateOnly,
  filterFn:     'ytSetChModalFilter',
  typeFilterFn: 'ytSetChModalTypeFilter',
  sortFn:       'ytSetChModalSort',
  toggleFn:     'ytToggleChModalToolbar',
  searchFn:     'ytOnChModalSearch',
  authorCol:    null,
  hasSearch:    true,
  hasViewToggle: true,
  viewFn:       'ytSetChModalView',
  viewKeys: [
    { key: 'list',   icon: _listViewIcon,  title: 'List view' },
    { key: 'videos', icon: _wideGridIcon,  title: 'Videos grid' },
    { key: 'shorts', icon: _gridViewIcon,  title: 'Shorts grid' },
  ],
  viewVideoFilter: (view, vids) => {
    if (view === 'videos') return vids.filter(v => v.content_type !== 'short');
    if (view === 'shorts') return vids.filter(v => v.content_type === 'short');
    return vids;
  },
  gridClassFn: view => view === 'videos' ? 'video-grid--wide' : '',
  typeIconFn:  v => v.content_type === 'short' ? _vgridShortIcon : _vgridPlayIcon,
  gridId:       'ytChVideoGrid',
  hasPhistBtn:  true,
  phistBtnFn:   'ytOpenProfileHistory',
  thumbCellFn:  _ytThumbCell,
  actionBtnsFn: _ytVideoActionBtns,
  previewFn:    'ytOpenImgModal',
  gridThumbSrc: v => `/api/youtube/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => ytOpenVidModal(v.video_id),
};

// ── Stats panel ───────────────────────────────────────────────────────────────

function renderYtStats(s) {
  const grid = document.getElementById('ytStatsGrid');
  if (!grid) return;
  const items = [
    { label: 'Tracked channels', value: (s.channel_count  || 0).toLocaleString() },
    { label: 'Saved videos',     value: (s.saved_count    || 0).toLocaleString() },
    { label: 'Deleted',          value: (s.deleted_count  || 0).toLocaleString() },
    { label: 'Latest saved',     value: s.latest_download
        ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
    { label: 'Total views',      value: _fmtLarge(s.total_views || 0) },
  ];
  grid.innerHTML = items.map(it =>
    `<div class="stat-item">
       <span class="stat-value">${esc(it.value)}</span>
       <span class="stat-label">${esc(it.label)}</span>
     </div>`
  ).join('');
}

async function loadYtStats() {
  const { ok, data } = await apiJSON('/api/youtube/stats');
  if (ok) renderYtStats(data);
}

// ── Recent panel ──────────────────────────────────────────────────────────────

const _YT_FIELD_LABELS = {
  handle: 'Handle', display_name: 'Display name', description: 'Description', avatar: 'Avatar',
};

function renderYtRecent(data) {
  const leftEl  = document.getElementById('ytRecentLeft');
  const rightEl = document.getElementById('ytRecentRight');
  if (!leftEl || !rightEl) return;
  const now = new Date();

  let left = '';

  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px">Recently deleted</div>`;
  if (data.deletions && data.deletions.length) {
    left += data.deletions.map(d => {
      const onclick = `ytOpenChModal('${esc(d.channel_id)}')`;
      return `<div class="recent-entry" onclick="${onclick}" title="Open @${esc(d.handle)}">
        <span class="recent-date">${_recentDate(d.deleted_at, now)}</span>
        <span class="recent-name">@${esc(d.handle)}</span>
        <span class="recent-detail">${esc((d.video_id || '').slice(0, 11))}</span>
      </div>`;
    }).join('');
  } else {
    left += `<div class="recent-empty">No deleted videos yet</div>`;
  }
  left += `</div>`;

  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px">Recently changed profile</div>`;
  if (data.profile_changes && data.profile_changes.length) {
    left += data.profile_changes.map(p =>
      `<div class="recent-entry" onclick="ytOpenChModalWithHistory('${esc(p.channel_id)}','${esc(p.field)}')" title="Open @${esc(p.handle)}">
        <span class="recent-date">${_recentDate(p.changed_at, now)}</span>
        <span class="recent-name">@${esc(p.handle)}</span>
        <span class="recent-detail">${esc(_YT_FIELD_LABELS[p.field] || p.field)}</span>
      </div>`
    ).join('');
  } else {
    left += `<div class="recent-empty">No profile changes recorded yet</div>`;
  }
  left += `</div>`;

  leftEl.innerHTML = left;

  let right = '';
  right += `<div class="recent-section">`;
  right += `<div class="recent-section-hdr" style="margin-bottom:2px">Recently saved</div>`;
  if (data.saved && data.saved.length) {
    right += data.saved.map(g =>
      `<div class="recent-entry" onclick="ytOpenChModal('${esc(g.channel_id)}')" title="Open @${esc(g.handle)}">
        <span class="recent-date">${_recentDate(g.download_date, now)}</span>
        <span class="recent-name">@${esc(g.handle)}</span>
        <span class="recent-detail">${g.count}x</span>
      </div>`
    ).join('');
  } else {
    right += `<div class="recent-empty">No videos saved yet</div>`;
  }
  right += `</div>`;

  rightEl.innerHTML = right;
}

async function loadYtRecent() {
  const { ok, data } = await apiJSON('/api/youtube/recent');
  if (ok) renderYtRecent(data);
}

// ── Loop status ───────────────────────────────────────────────────────────────

const _ytEl = {
  last:     () => document.getElementById('ytLoopLast'),
  duration: () => document.getElementById('ytLoopDuration'),
  next:     () => document.getElementById('ytLoopNext'),
  newVids:  () => document.getElementById('ytLoopNewVideos'),
  btn:      () => document.getElementById('ytTriggerBtn'),
};

function renderYtStatus(state) {
  ytLoopRunning    = state.loop_running;
  ytCurrentChannel = state.loop_current_channel;
  ytRunQueue       = state.run_queue  || [];
  ytRunCurrent     = state.run_current || null;

  const el = _ytEl;
  if (el.last())     el.last().textContent     = state.loop_last_end ? `Last: ${fmt.rel(state.loop_last_end)}` : 'Never run';
  if (el.duration()) el.duration().textContent = state.loop_last_duration_secs != null ? fmt.dur(state.loop_last_duration_secs) : '';
  if (el.next())     el.next().textContent     = state.loop_next ? `Next: ${fmt.relFuture(state.loop_next)}` : '';
  if (el.newVids())  el.newVids().textContent  = state.loop_last_new_videos != null ? `${state.loop_last_new_videos} new` : '';
  if (el.btn())      el.btn().disabled         = ytLoopRunning;

  // Update header badge when on YouTube tab
  const badge = document.getElementById('statusBadge');
  const text  = document.getElementById('statusText');
  const active = location.hash === '#youtube';
  if (active && badge && text) {
    const anyActive = ytLoopRunning || !!ytRunCurrent;
    badge.className  = `status-badge${anyActive ? ' running' : ''}`;
    text.textContent = anyActive
      ? (ytCurrentChannel ? `Downloading @${ytCurrentChannel}` : 'Running…')
      : 'Idle';
  }

  // Render logs
  const logBody = document.getElementById('ytLogBody');
  if (logBody && state.logs) {
    const newLines = state.logs.slice(ytLogClearIndex);
    if (newLines.length !== ytLogLines.length || (ytLogLines.length && ytLogLines[ytLogLines.length - 1] !== newLines[newLines.length - 1])) {
      ytLogLines = newLines;
      const auto = document.getElementById('ytAutoScroll')?.checked !== false;
      logBody.innerHTML = ytLogLines.map(l => `<div class="log-line">${esc(l)}</div>`).join('');
      if (auto) logBody.scrollTop = logBody.scrollHeight;
    }
  }

  updateYtRunStates();
}

function updateYtRunStates() {
  document.querySelectorAll('.yt-channel-card[data-channelid]').forEach(card => {
    const id      = card.dataset.channelid;
    const inQueue = ytRunQueue.includes(id);
    const isCur   = ytRunCurrent === id;
    const btn     = card.querySelector('.btn-run');
    if (!btn) return;
    btn.textContent = isCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
    btn.disabled    = inQueue || isCur;
  });
}

async function loadYtStatus() {
  const { ok, data } = await apiJSON('/api/youtube/status');
  if (ok) renderYtStatus(data);
}

function ytClearLog() {
  ytLogClearIndex = (document.getElementById('ytLogBody')?.children.length || 0) + ytLogClearIndex;
  ytLogLines = [];
  const logBody = document.getElementById('ytLogBody');
  if (logBody) logBody.innerHTML = '';
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadYtSettings() {
  const { ok, data } = await apiJSON('/api/youtube/settings');
  if (!ok) return;
  const el = document.getElementById('ytLoopIntervalInput');
  if (el) el.value = data.loop_interval_minutes;
}

async function ytSaveLoopSettings() {
  const val = parseInt(document.getElementById('ytLoopIntervalInput')?.value, 10);
  if (!val || val < 1) { showToast('Interval must be a positive integer.', { type: 'warning', duration: 4000 }); return; }
  const { ok, data } = await apiJSON('/api/youtube/settings', {
    method: 'PATCH',
    body: JSON.stringify({ loop_interval_minutes: val }),
  });
  if (!ok) { showToast(data.error || 'Could not save settings', { type: 'error' }); return; }
  showToast('Settings saved.', { type: 'success', duration: 2500 });
}

async function ytTriggerLoop() {
  const btn = document.getElementById('ytTriggerBtn');
  if (btn) btn.disabled = true;
  const { ok, data } = await apiJSON('/api/youtube/trigger', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not trigger loop', { type: 'error' }); if (btn) btn.disabled = false; }
}

// ── DB cleanup ────────────────────────────────────────────────────────────────

const _ytCleanupWidget = _makeJobWidget('yt-cleanup');

async function ytTriggerCleanup() {
  const btn = document.getElementById('yt-job-cleanup-btn');
  if (btn) btn.disabled = true;
  const { ok, data } = await apiJSON('/api/youtube/db/cleanup', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start cleanup', { type: 'error' }); if (btn) btn.disabled = false; return; }
  _ytCleanupWidget.update({ barPct: null, label: 'Running…' });
  if (ytCleanupPoll) return;
  ytCleanupPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/youtube/db/cleanup');
    if (!ok) return;
    if (data.running) {
      _ytCleanupWidget.update({ barPct: null, label: data.current || 'Running…', steps: data.steps });
    } else {
      clearInterval(ytCleanupPoll); ytCleanupPoll = null;
      if (btn) btn.disabled = false;
      _ytCleanupWidget.update({
        barPct: 100,
        label: `Done - ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
        steps: data.steps,
      });
    }
  }, 800);
}

// ── Add channel form ──────────────────────────────────────────────────────────

document.getElementById('ytHandleInput').addEventListener('input', function() {
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

document.getElementById('ytHandleInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); ytAddChannel(); }
});

document.getElementById('ytHandleInput').addEventListener('paste', function(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

async function ytAddChannel() {
  const input   = document.getElementById('ytHandleInput');
  const statusEl = document.getElementById('ytAddStatus');
  const raw     = input.textContent.trim();
  if (!raw) return;
  input.textContent = '';
  input.focus();

  statusEl.className   = 'add-status info';
  statusEl.textContent = 'Adding…';

  const { ok, data } = await apiJSON('/api/youtube/channels', {
    method: 'POST',
    body: JSON.stringify({ handle: raw }),
  });
  if (ok) {
    const handle = data.handle || raw.replace(/^@/, '');
    ytDismissed.delete(handle);
    ytPending[handle] = { status: 'pending' };
    statusEl.className   = 'add-status ok';
    statusEl.textContent = `@${handle} queued.`;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'add-status'; }, 5000);
    renderYtPending();
  } else {
    statusEl.className   = 'add-status error';
    statusEl.textContent = data.error || 'Failed.';
  }
}

async function ytLoadQueue() {
  const { ok, data } = await apiJSON('/api/youtube/queue');
  if (!ok) return;
  let anyResolved = false;
  for (const h of Object.keys(ytPending)) {
    if (!(h in data) && !ytDismissed.has(h)) {
      delete ytPending[h];
      anyResolved = true;
    }
  }
  for (const [h, info] of Object.entries(data)) {
    if (!ytDismissed.has(h)) ytPending[h] = info;
  }
  renderYtPending();
  if (anyResolved) loadYtChannels();
}

function renderYtPending() {
  const container = document.getElementById('ytPendingList');
  if (!container) return;
  const entries = Object.entries(ytPending).filter(([h]) => !ytDismissed.has(h));
  if (!entries.length) { container.innerHTML = ''; return; }
  container.innerHTML = entries.map(([handle, info]) => {
    if (info.status === 'pending') {
      return `<div class="pending-item"><span class="spinner"></span>Looking up @${esc(handle)}…</div>`;
    }
    return `<div class="pending-item error">Failed to add @${esc(handle)}: ${esc(info.message)} <button onclick="ytDismissPending('${esc(handle)}')" title="Dismiss">×</button></div>`;
  }).join('');
}

async function ytDismissPending(handle) {
  await apiJSON(`/api/youtube/queue/${encodeURIComponent(handle)}`, { method: 'DELETE' });
  delete ytPending[handle];
  renderYtPending();
}

// ── Channel filters and sort ──────────────────────────────────────────────────

const YT_CH_STAT_IDS = { all: 'yfStatAll', active: 'yfStatActive', inactive: 'yfStatInactive' };
const YT_CH_STAR_IDS = { all: 'yfStarAll', starred: 'yfStarStarred' };

function setYtChFilter(group, value) {
  ytChFilter[group] = value;
  const map = group === 'stat' ? YT_CH_STAT_IDS : YT_CH_STAR_IDS;
  Object.entries(map).forEach(([v, id]) => {
    document.getElementById(id)?.classList.toggle('active', v === value);
  });
  renderYtChannels();
  const anchorId = group === 'stat' ? 'yfStatAll' : 'yfStarAll';
  _placeGlider(document.getElementById(anchorId).closest('.filter-pills'));
}

function setYtChSortField(field) {
  ytChSort.field = field;
  ytChSort.dir   = (field === 'handle' || field === 'display_name') ? 'asc' : 'desc';
  _updateYtSortBtn();
  renderYtChannels();
}

function toggleYtChSortDir() {
  ytChSort.dir = ytChSort.dir === 'asc' ? 'desc' : 'asc';
  _updateYtSortBtn();
  renderYtChannels();
}

function _updateYtSortBtn() {
  const btn = document.getElementById('ytChSortDirBtn');
  if (btn) btn.textContent = _YT_SORT_DIR_LABELS[ytChSort.field]?.[ytChSort.dir] ?? ytChSort.dir;
}

function resetYtChFilters() {
  ytChSort   = { field: 'handle', dir: 'asc' };
  ytChFilter = { stat: 'all', star: 'all' };
  ytChSearch = '';
  const searchEl = document.getElementById('ytChSearch');
  if (searchEl) searchEl.value = '';
  const sel = document.getElementById('ytChSortField');
  if (sel) sel.value = 'handle';
  _updateYtSortBtn();
  Object.entries(YT_CH_STAT_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  Object.entries(YT_CH_STAR_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  renderYtChannels();
  _placeGlider(document.getElementById('yfStatAll').closest('.filter-pills'));
  _placeGlider(document.getElementById('yfStarAll').closest('.filter-pills'));
}

function onYtChSearch(val) {
  ytChSearch = val.trim();
  renderYtChannels();
}

function _filteredYtChannels() {
  const q = ytChSearch.toLowerCase();
  return ytChannels.filter(ch => {
    if (ytChFilter.stat === 'active'   && ch.tracking_enabled === 0) return false;
    if (ytChFilter.stat === 'inactive' && ch.tracking_enabled !== 0) return false;
    if (ytChFilter.star === 'starred'  && !ch.starred)               return false;
    if (q) {
      const hay = [ch.handle, ch.display_name, ch.channel_id, ch.description]
                  .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function _sortedYtChannels() {
  const { field, dir } = ytChSort;
  return _filteredYtChannels().sort((a, b) => {
    const av = field === 'display_name' ? (a.display_name || a.handle) : (a[field] ?? (field === 'handle' ? '' : 0));
    const bv = field === 'display_name' ? (b.display_name || b.handle) : (b[field] ?? (field === 'handle' ? '' : 0));
    return _cmp(av, bv, dir);
  });
}

// ── Channel cards ─────────────────────────────────────────────────────────────

function renderYtChannels() {
  const grid     = document.getElementById('ytChannelsGrid');
  if (!grid) return;
  const filtered = _filteredYtChannels();
  const isFiltered = ytChFilter.stat !== 'all' || ytChFilter.star !== 'all' || !!ytChSearch;
  const countEl = document.getElementById('ytChCount');
  if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${ytChannels.length}` : ytChannels.length;

  if (!ytChannels.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No channels tracked yet.</div>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No channels match this filter.</div>'
      + _ghostCards(Math.min(ytChannels.length, 9));
    return;
  }

  const sorted = _sortedYtChannels();
  grid.innerHTML = sorted.map(ch => {
    const isCurrent  = !!ytCurrentChannel && ch.handle === ytCurrentChannel;
    const isInactive = ch.tracking_enabled === 0;
    const { cls: trackingCls, label: trackingLabel } = _trackingBadge(ch.tracking_enabled);
    const checked    = _fmtLastChecked(ch.last_checked);
    const inQueue    = ytRunQueue.includes(ch.channel_id);
    const isRunCur   = ytRunCurrent === ch.channel_id;
    const runLabel   = isRunCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
    const runDis     = (inQueue || isRunCur) ? 'disabled' : '';
    const subStr     = ch.subscriber_count != null ? `${_fmtLarge(ch.subscriber_count)} subs` : '';

    return `
      <div class="user-card yt-channel-card${isCurrent ? ' user-card-current' : ''}${isInactive ? ' user-card-inactive' : ''}"
           data-channelid="${esc(ch.channel_id)}"
           onclick="if(!event.target.closest('button'))ytOpenChModal('${esc(ch.channel_id)}')"
           role="button" tabindex="0">
        <div class="user-card-top">
          <div class="avatar-wrap">
            <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
            ${ch.avatar_cached ? `<img class="user-avatar" src="/api/youtube/channels/${esc(ch.channel_id)}/avatar" alt=""
                 onerror="this.style.display='none'"
                 onclick="event.stopPropagation();openImgModalUrl('/api/youtube/channels/${esc(ch.channel_id)}/avatar')">` : ''}
          </div>
          <div class="user-identity">
            <div class="user-display-name">${esc(ch.display_name || ch.handle)}</div>
            <div class="user-handle">@${esc(ch.handle)}</div>
            ${subStr ? `<div class="user-id-line">${esc(subStr)}</div>` : `<div class="user-id-line">${esc(ch.channel_id)}</div>`}
          </div>
          <div class="user-badges">
            <span class="account-status ${trackingCls}">${trackingLabel}</span>
          </div>
        </div>

        <div class="user-bio-area">
          ${ch.description ? `<div class="user-bio">${esc(ch.description)}</div>` : ''}
        </div>

        <div class="user-stats">
          ${subStr ? `<span class="stat-item"><span class="stat-item-label">subs</span><span class="stat-item-value">${_fmtLarge(ch.subscriber_count)}</span></span>` : ''}
          <span class="stat-item"><span class="stat-item-label">saved</span><span class="stat-item-value">${ch.video_total || 0}</span></span>
          ${ch.video_deleted   ? `<span class="stat-item"><span class="stat-item-label">deleted</span><span class="stat-item-value" style="color:var(--red)">${ch.video_deleted}</span></span>` : ''}
          ${ch.video_missing   ? `<span class="stat-item"><span class="stat-item-label">missing</span><span class="stat-item-value" style="color:#ff9800">${ch.video_missing}</span></span>` : ''}
          ${ch.video_undeleted ? `<span class="stat-item"><span class="stat-item-label">restored</span><span class="stat-item-value" style="color:var(--yellow)">${ch.video_undeleted}</span></span>` : ''}
        </div>

        <div class="user-card-footer">
          <span class="user-checked">${checked}</span>
          <div style="display:flex;gap:6px">
            <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="event.stopPropagation();ytToggleChStar('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
            <button class="btn-run" ${runDis} onclick="event.stopPropagation();ytRunChannel('${esc(ch.channel_id)}')">${runLabel}</button>
            <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>ytRunChProfile('${esc(ch.channel_id)}')},{label:'Remove',danger:true,onclick:()=>ytRemoveChannel('${esc(ch.channel_id)}','@${esc(ch.handle)}')}])">•••</button>
          </div>
        </div>
      </div>
    `;
  }).join('') + _ghostCards(Math.max(0, Math.min(ytChannels.length, 9) - sorted.length));
}

async function loadYtChannels() {
  const { ok, data } = await apiJSON('/api/youtube/channels');
  if (ok) { ytChannels = data; renderYtChannels(); }
}

async function ytRunChannel(channelId) {
  const { ok, data } = await apiJSON(`/api/youtube/channels/${channelId}/run`, { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not queue run', { type: 'error' }); return; }
  ytRunQueue = [...ytRunQueue, channelId];
  renderYtChannels();
}

async function ytRunChProfile(channelId) {
  const { ok, data } = await apiJSON(`/api/youtube/channels/${channelId}/run-profile`, { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not queue profile run', { type: 'error' }); return; }
  ytRunQueue = [...ytRunQueue, channelId];
  renderYtChannels();
}

async function ytRemoveChannel(channelId, label) {
  if (!confirm(`Stop tracking ${label}?\n(Downloaded files will not be deleted.)`)) return;
  await apiJSON(`/api/youtube/channels/${channelId}`, { method: 'DELETE' });
  loadYtChannels();
}

async function ytToggleChStar(channelId) {
  const ch = ytChannels.find(c => c.channel_id === channelId);
  if (!ch) return;
  const newVal = !ch.starred;
  ch.starred = newVal ? 1 : 0;
  renderYtChannels();
  await apiJSON(`/api/youtube/channels/${channelId}/star`, {
    method: 'PATCH',
    body: JSON.stringify({ starred: newVal }),
  });
}

// ── Channel tracking toggle (in modal) ───────────────────────────────────────

async function ytSetChTracking(channelId, enabled) {
  const { ok, data } = await apiJSON(`/api/youtube/channels/${channelId}/tracking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!ok) { showToast(data.error || 'Failed to update tracking', { type: 'error' }); return; }
  const ch = ytChannels.find(c => c.channel_id === channelId);
  if (ch) ch.tracking_enabled = enabled ? 1 : 0;
  if (_ytModalChannelId === channelId && _ytModalChannel) {
    _ytModalChannel.tracking_enabled = enabled ? 1 : 0;
    _renderYtChModalHeader(_ytModalChannel);
  }
  renderYtChannels();
}

// ── Channel detail modal ──────────────────────────────────────────────────────

let _ytModalChannelId        = null;
let _ytModalChannel          = null;
let _ytModalPendingHighlight = null;

let _ytPhistData   = [];
let _ytPhistField  = 'all';
let _ytPhistChId   = null;

function ytOpenChModal(channelId) {
  const ch = ytChannels.find(c => c.channel_id === channelId);
  if (!ch) return;
  _ytModalChannelId = channelId;
  _ytModalChannel   = ch;
  Object.assign(_ytChState, {
    videos: [], filter: 'all', typeFilter: 'all', search: '',
    sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, toolbarExpanded: false,
    view: window.innerWidth <= 640 ? 'grid' : 'list',
  });
  if (_ytChState.obs) { _ytChState.obs.disconnect(); _ytChState.obs = null; }

  _ytPhistData  = [];
  _ytPhistField = 'all';
  _ytPhistChId  = null;
  document.getElementById('ytPhistPanel').style.display      = 'none';
  document.getElementById('ytChModalVideoList').style.display = '';

  document.getElementById('ytChModalBackdrop').style.display = 'flex';
  _lockScroll();

  _renderYtChModalHeader(ch);
  _mRenderToolbar(_YT_CH_MODAL_CFG, []);
  document.getElementById('ytChModalVideoList').innerHTML =
    '<div class="vlist-loading">Loading videos…</div>';

  _ytLoadChModalVideos(channelId);
}

function ytOpenChModalWithHistory(channelId, field) {
  ytOpenChModal(channelId);
  ytOpenProfileHistory(field);
}

function ytCloseChModal() {
  document.getElementById('ytChModalBackdrop').style.display = 'none';
  _unlockScroll();
  if (_ytChState.obs) { _ytChState.obs.disconnect(); _ytChState.obs = null; }
  _ytModalChannelId = null;
  _ytModalChannel   = null;
  _ytChState.videos = [];
}

async function _ytLoadChModalVideos(channelId) {
  const { ok, data } = await apiJSON(`/api/youtube/channels/${channelId}/videos`);
  if (!ok || _ytModalChannelId !== channelId) return;
  _ytChState.videos = data.map(v => ({ ...v, description: v.title || v.description }));

  if (_ytModalPendingHighlight) {
    const { videoId, filter, sortField, sortDir } = _ytModalPendingHighlight;
    _ytModalPendingHighlight   = null;
    _ytChState.view            = 'list';
    _ytChState.filter          = filter;
    _ytChState.sort            = { field: sortField, dir: sortDir };
    _mRenderColHdrs(_YT_CH_MODAL_CFG);
    _mRenderToolbar(_YT_CH_MODAL_CFG, _ytChState.videos);
    _mRenderList(_YT_CH_MODAL_CFG);
    const row = document.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('video-row-highlight');
      row.addEventListener('mouseenter', () => row.classList.remove('video-row-highlight'), { once: true });
    }
  } else {
    const historyOpen = document.getElementById('ytPhistPanel').style.display !== 'none';
    if (!historyOpen) {
      _mRenderToolbar(_YT_CH_MODAL_CFG, _ytChState.videos);
      _mRenderList(_YT_CH_MODAL_CFG);
    }
  }
}

function _renderYtChModalHeader(ch) {
  const isInactive = ch.tracking_enabled === 0;
  const { cls: trackingCls, label: trackingLbl } = _trackingBadge(ch.tracking_enabled);
  const checked     = _fmtLastChecked(ch.last_checked);
  const subStr      = ch.subscriber_count != null ? `${_fmtLarge(ch.subscriber_count)} subscribers` : '';
  const ytUrl       = `https://www.youtube.com/@${esc(ch.handle)}`;

  const bannerEl = document.getElementById('ytChModalBanner');
  if (bannerEl) {
    if (ch.banner_cached) {
      bannerEl.style.display = '';
      bannerEl.style.backgroundImage = `url('/api/youtube/channels/${esc(ch.channel_id)}/banner')`;
      bannerEl.style.cursor = 'pointer';
      bannerEl.onclick = () => openImgModalUrl(`/api/youtube/channels/${ch.channel_id}/banner`);
    } else {
      bannerEl.style.display = 'none';
      bannerEl.style.backgroundImage = '';
      bannerEl.style.cursor = '';
      bannerEl.onclick = null;
    }
  }

  document.getElementById('ytChModalHeader').innerHTML = `
    <div class="modal-avatar-wrap">
      <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
      ${ch.avatar_cached ? `<img class="modal-avatar" src="/api/youtube/channels/${esc(ch.channel_id)}/avatar" alt=""
           onerror="this.style.display='none'"
           onclick="openImgModalUrl('/api/youtube/channels/${esc(ch.channel_id)}/avatar')">` : ''}
    </div>
    <div class="modal-user-body">
      <div class="modal-name-row">
        <span class="modal-name">${esc(ch.display_name || ch.handle)}</span>
        <span class="account-status ${trackingCls}">${trackingLbl}</span>
        <label class="tracking-toggle" title="${isInactive ? 'Video tracking off' : 'Video tracking on'}">
          <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="ytSetChTracking('${esc(ch.channel_id)}', this.checked)">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">Track videos</span>
        </label>
      </div>
      <div class="modal-handle">
        <a href="${ytUrl}" target="_blank" rel="noopener" class="tt-link">@${esc(ch.handle)}</a>
        <span style="color:var(--muted);font-size:12px;margin-left:6px">${esc(ch.channel_id)}</span>
      </div>
      <div class="modal-stats-row">
        ${subStr ? `<span><strong>${esc(subStr)}</strong></span>` : ''}
        <span><strong>${ch.video_total || 0}</strong> saved locally</span>
        ${ch.video_deleted   ? `<span style="color:var(--red)"><strong>${ch.video_deleted}</strong> deleted</span>` : ''}
        ${ch.video_undeleted ? `<span style="color:var(--yellow)"><strong>${ch.video_undeleted}</strong> restored</span>` : ''}
        <span style="color:var(--muted)">${esc(checked)}</span>
      </div>
      <div style="display:flex;align-items:flex-start;gap:6px;margin-top:8px">
        <textarea placeholder="Add a note about this channel…"
          onblur="ytSaveChComment('${esc(ch.channel_id)}', this.value)"
          style="flex:1;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;
                 background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                 color:var(--text);font-family:inherit;line-height:1.5"
        >${esc(ch.comment || '')}</textarea>
      </div>
    </div>
  `;
}

async function ytSaveChComment(channelId, value) {
  const { ok } = await apiJSON(`/api/youtube/channels/${channelId}/comment`, {
    method: 'PATCH',
    body: JSON.stringify({ comment: value }),
  });
  if (!ok) return;
  const ch = ytChannels.find(c => c.channel_id === channelId);
  if (ch) ch.comment = value.trim() || null;
  if (_ytModalChannel && _ytModalChannel.channel_id === channelId) _ytModalChannel.comment = value.trim() || null;
  showToast('Saved.', { type: 'success', duration: 2000 });
}

// Modal engine delegates

function ytSetChModalFilter(f)       { _mSetFilter(_YT_CH_MODAL_CFG, f); }
function ytSetChModalTypeFilter(t)   { _mSetTypeFilter(_YT_CH_MODAL_CFG, t); }
function ytToggleChModalToolbar()    { _mToggleToolbar(_YT_CH_MODAL_CFG); }
function ytSetChModalSort(f)         { _mSetSort(_YT_CH_MODAL_CFG, f); }
function ytSetChModalView(view) {
  _ytChState.view = view;
  const toolbar = document.getElementById('ytChModalToolbar');
  toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === view);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _mRenderList(_YT_CH_MODAL_CFG);
}
function ytOnChModalSearch(val) {
  _ytChState.search = val.trim();
  _mRenderToolbar(_YT_CH_MODAL_CFG, _ytChState.videos);
  _mRenderList(_YT_CH_MODAL_CFG);
}

// ── Profile history panel ─────────────────────────────────────────────────────

const _YT_PHIST_FIELD_LABELS = {
  handle: 'Handle', display_name: 'Display name', description: 'Description', avatar: 'Avatar',
};

async function ytOpenProfileHistory(field) {
  if (!_ytModalChannelId) return;
  const panel  = document.getElementById('ytPhistPanel');
  const vidList = document.getElementById('ytChModalVideoList');
  if (!panel || !vidList) return;

  vidList.style.display = 'none';
  panel.style.display   = '';

  _ytPhistField = field || 'all';
  _ytPhistChId  = _ytModalChannelId;

  panel.innerHTML = '<div class="vlist-loading">Loading history…</div>';

  const { ok, data } = await apiJSON(`/api/youtube/channels/${_ytModalChannelId}/profile-history`);
  if (!ok || _ytPhistChId !== _ytModalChannelId) return;
  _ytPhistData = data;
  _ytRenderPhistPanel();
}

function ytCloseProfileHistory() {
  const panel   = document.getElementById('ytPhistPanel');
  const vidList = document.getElementById('ytChModalVideoList');
  if (panel)   panel.style.display   = 'none';
  if (vidList) vidList.style.display = '';
  _ytPhistData = [];
  _ytPhistField = 'all';
}

function _ytRenderPhistPanel() {
  const panel = document.getElementById('ytPhistPanel');
  if (!panel) return;

  const entries = _ytPhistField === 'all'
    ? _ytPhistData
    : _ytPhistData.filter(e => e.field === _ytPhistField);

  const fields  = [...new Set(_ytPhistData.map(e => e.field))];
  const fieldPills = ['all', ...fields].map(f => {
    const active = _ytPhistField === f ? ' active' : '';
    const label  = f === 'all' ? 'All' : (_YT_PHIST_FIELD_LABELS[f] || f);
    return `<button class="filter-pill${active}" onclick="ytPhistSetField('${esc(f)}')">${label}</button>`;
  }).join('');

  const ch = _ytModalChannel;

  panel.innerHTML = `
    <div class="phist-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
      <div class="filter-pills" style="flex:1">${fieldPills}</div>
      <button class="btn-ghost" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="ytCloseProfileHistory()">Back to videos</button>
    </div>
    ${entries.length
      ? entries.map(e => _ytPhistEntryHtml(e, ch)).join('')
      : `<div style="color:var(--muted);font-size:13px;padding:12px 0">No profile changes recorded${_ytPhistField !== 'all' ? ' for this field' : ''}.</div>`}
  `;
  panel.querySelectorAll('.filter-pills').forEach(_placeGlider);
}

function _ytPhistEntryHtml(e, ch) {
  const dateStr    = _dtFmt.format(new Date(e.changed_at * 1000));
  const fieldLabel = _YT_PHIST_FIELD_LABELS[e.field] || e.field;

  if (e.field === 'avatar') {
    const chId   = esc(ch ? ch.channel_id : _ytPhistChId || '');
    const oldSrc = `/api/youtube/channels/${chId}/avatar-history/${encodeURIComponent(e.old_value)}`;
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
        ${img(`/api/youtube/channels/${chId}/avatar`, 'Current')}
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

function ytPhistSetField(field) {
  _ytPhistField = field;
  _ytRenderPhistPanel();
}

// ── Log panel ─────────────────────────────────────────────────────────────────

let _ytTrackingView = 'channels';

function ytSetTrackingView(view) {
  _ytTrackingView = view;
  const searchEl = document.getElementById('ytChSearch');
  if (searchEl) {
    searchEl.style.display = view === 'log' ? 'none' : '';
    if (view !== 'log') searchEl.value = '';
  }
  const countEl = document.getElementById('ytChCount');
  if (countEl) countEl.style.display = view === 'log' ? 'none' : '';
  ytChSearch = '';
  document.getElementById('ytTvChannels').classList.toggle('active', view === 'channels');
  document.getElementById('ytTvLog').classList.toggle('active', view === 'log');
  const grid   = document.getElementById('ytChannelsGrid');
  const logPnl = document.getElementById('ytLogPanel');
  const chCtrl = document.getElementById('ytChControls');
  if (grid)   grid.style.display   = view === 'channels' ? '' : 'none';
  if (logPnl) logPnl.style.display = view === 'log'      ? '' : 'none';
  if (chCtrl) chCtrl.style.display = view === 'channels' ? '' : 'none';
  if (view === 'channels') renderYtChannels();
  _placeGlider(document.getElementById('ytTvChannels').closest('.filter-pills'));
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

async function ytDiagRun() {
  const input  = document.getElementById('ytDiagInput');
  const output = document.getElementById('ytDiagOutput');
  const btn    = document.getElementById('ytDiagRunBtn');
  let val = (input?.value || '').trim().replace(/^@/, '');
  if (!val) { showToast('Enter a channel ID or @handle.', { type: 'warning', duration: 4000 }); return; }

  if (!val.startsWith('UC')) {
    const ch = ytChannels.find(c => c.handle.toLowerCase() === val.toLowerCase());
    if (!ch) { showToast(`@${val} not found in tracked channels. Enter the channel ID (UCxxx) directly or add the channel first.`, { type: 'warning', duration: 6000 }); return; }
    val = ch.channel_id;
  }

  btn.disabled = true;
  output.textContent = 'Running...';
  const { ok, data } = await apiJSON('/api/youtube/debug/channel-videos', {
    method: 'POST',
    body: JSON.stringify({ channel_id: val }),
  });
  btn.disabled = false;
  output.textContent = JSON.stringify(data, null, 2);
}

function ytDiagCopy() {
  const output = document.getElementById('ytDiagOutput');
  navigator.clipboard.writeText(output?.textContent || '').catch(() => {});
}

// ── Keyboard handler (Escape) ─────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('ytChModalBackdrop')?.style.display !== 'none') {
    ytCloseChModal();
  }
}, true);  // capture phase so it runs before tiktok.js handler

// ── Init ──────────────────────────────────────────────────────────────────────

loadYtChannels();
loadYtStatus();
loadYtStats();
loadYtRecent();
ytLoadQueue();
loadYtSettings();

setInterval(loadYtStatus,   5000);
setInterval(loadYtChannels, 15000);
setInterval(loadYtStats,    60000);
setInterval(loadYtRecent,   30000);
setInterval(ytLoadQueue,     3000);
