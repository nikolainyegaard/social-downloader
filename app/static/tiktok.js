// TikTok app: config over the shared channel engine (channels.js) plus
// TikTok-only extras: the sounds catalog and sound detail modal, the
// untracked-user modal flow for sound-discovered authors, the sound loop
// panel, stats backfill, cookies, jobs, diagnostics, and DB migration wiring.

// ── Cookie management ─────────────────────────────────────────────────────────
// The static settings markup references these by name (see index.html).

function renderCookies(info)        { _cookiesRender('tiktok', 'cookie', info); }
async function uploadCookies(input) { return _cookiesUpload('tiktok', 'cookie', input); }
async function deleteCookies()      { return _cookiesDelete('tiktok', 'cookie'); }
async function loadCookies()        { return _cookiesLoad('tiktok', 'cookie'); }

// ── Sounds state ──────────────────────────────────────────────────────────────

let sounds          = [];
let soundRunCurrent = null;
let soundRunQueue   = [];
const _defaultSoundFilter = () => ({ stat: new Set(['active']), star: new Set() });
let soundFilter   = _defaultSoundFilter();
let soundSort     = { field: 'label', dir: 'asc' };
let _soundSearch  = '';

const _SOUND_SORT_DIR_LABELS = {
  label:       { asc: 'A → Z',        desc: 'Z → A'        },
  video_count: { asc: 'Low → High',   desc: 'High → Low'   },
  added_at:    { asc: 'Oldest first', desc: 'Newest first' },
};

// ── Engine config pieces ──────────────────────────────────────────────────────

const _TT_SOUND_CONTROLS_HTML = `
  <div class="filter-row">
    <span class="filter-row-label">Tracking</span>
    <div class="filter-pills multi">
      <button class="filter-pill active" id="sfStatActive"   onclick="setSoundFilter('stat','active')">Active</button>
      <button class="filter-pill" id="sfStatInactive" onclick="setSoundFilter('stat','inactive')">Inactive</button>
    </div>
  </div>
  <div class="filter-row">
    <span class="filter-row-label">Starred</span>
    <div class="filter-pills multi">
      <button class="filter-pill" id="sfStarStarred" onclick="setSoundFilter('star','starred')">Starred</button>
    </div>
  </div>
  <div class="filter-row">
    <span class="filter-row-label">Sort</span>
    <div class="sort-controls">
      <select class="sort-select" id="soundSortField" onchange="setSoundSortField(this.value)">
        <option value="label">Label</option>
        <option value="video_count">Saved videos</option>
        <option value="added_at">Date added</option>
      </select>
      <button class="sort-dir-btn" id="soundSortDirBtn" onclick="toggleSoundSortDir()">A → Z</button>
      <button class="sort-dir-btn" onclick="resetSoundFilters()" title="Reset all filters and sort to default">Reset</button>
    </div>
  </div>`;

const _TT_SOUND_LOOP_HTML = `
  <div class="loop-block">
    <div class="loop-block-header">
      <span class="loop-section-label">Sound Loop</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span id="soundLoopNext" class="loop-next"></span>
        <button class="loop-pause-btn" id="soundPauseBtn" onclick="toggleSoundPause()" title="Pause scheduled sessions">${_pauseIcon}</button>
      </span>
    </div>
    <div id="soundLoopMeta" class="loop-meta">Never run</div>
    <div id="soundLoopSessions" class="loop-sessions"></div>
    <div class="loop-actions">
      <button class="btn-run btn-trigger" id="triggerSoundBtn" onclick="triggerSoundLoop()">Run Now</button>
      <button class="btn-danger btn-trigger" id="stopSoundBtn" onclick="stopSoundLoop()" disabled>Stop</button>
    </div>
  </div>`;

// Numeric IDs and music/sound URLs go to the sound tracker, everything else
// is treated as a username or profile URL
function _isSoundInput(val) {
  if (/\/music\/|\/sound\//.test(val)) return true;
  if (/^\d+$/.test(val.trim())) return true;
  return false;
}

async function _ttAddHandler(val, addToasts) {
  if (_isSoundInput(val)) {
    const t = showToast('Adding sound…', { spinner: true, duration: 0 });
    const { ok, data } = await apiJSON('/api/tiktok/sounds', {
      method: 'POST',
      body: JSON.stringify({ sound_id: val, label: null }),
    });
    if (ok) {
      t.update(`Sound ${data.sound_id} added.`, { type: 'success' });
      loadSounds();
    } else {
      t.update(data.error || 'Could not add sound.', { type: 'error', duration: 8000 });
    }
    return true;
  }

  // Direct post URL: save one video/photo post, e.g. subscriber-only posts
  // that never appear in profile listings
  const postMatch = val.match(/tiktok\.com\/(?:@[^/]+\/)?(?:video|photo)\/(\d+)/);
  if (postMatch) {
    const t = showToast(`Fetching post ${postMatch[1]}…`, { spinner: true, duration: 0 });
    const { ok, data } = await apiJSON('/api/tiktok/videos/direct', {
      method: 'POST',
      body: JSON.stringify({ url: val }),
    });
    if (ok && data.already_saved) {
      t.update(`Post ${data.video_id} was already saved; now exempt from deletion checks.`, { type: 'success' });
    } else if (ok && data.in_progress) {
      t.update(`Post ${data.video_id} is already being fetched. Progress shows in the Log view.`, { type: 'success' });
    } else if (ok) {
      t.update(`Post ${data.video_id} queued. Progress shows in the Log view.`, { type: 'success' });
    } else {
      t.update(data.error || 'Could not fetch post.', { type: 'error', duration: 8000 });
    }
    return true;
  }

  const urlMatch = val.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
  const name = urlMatch ? urlMatch[1] : val.replace(/^@/, '').replace(/[^a-zA-Z0-9_.]/g, '');
  if (!name) { showToast('Invalid username.', { type: 'error' }); return true; }

  const { ok, data } = await apiJSON('/api/tiktok/channels', {
    method: 'POST',
    body: JSON.stringify({ handle: name }),
  });
  if (ok) addToasts.start(data.handle || name);
  else showToast(data.error || 'Could not add user.', { type: 'error' });
  return true;
}

// Videos download as mp4, photo posts as a zip of all images
function _ttVideoActionBtns(v) {
  const id = esc(v.video_id);
  if (v.type === 'video' && v.file_path) {
    return `<a class="play-btn" href="/api/tiktok/videos/${id}/file" download="${id}.mp4"
             onclick="event.stopPropagation()" title="Download video">${_dlIcon}</a>`;
  } else if (v.type === 'photo' && v.file_path) {
    return `<a class="play-btn" href="/api/tiktok/videos/${id}/photos/zip" download="${id}_photos.zip"
             onclick="event.stopPropagation()" title="Download all photos as zip">${_dlIcon}</a>`;
  }
  return '';
}

// Sound loop card, backfill counters, and sound run queue, rendered from the
// TikTok status extras on every engine status poll
function _ttOnStatus(state) {
  soundRunQueue   = state.sound_run_queue   || [];
  soundRunCurrent = state.sound_run_current || null;

  const el = id => document.getElementById(id);

  const sMeta = el('soundLoopMeta');
  if (sMeta) {
    const parts = [];
    if (state.sound_loop_last_start) parts.push(`Last: ${fmt.rel(state.sound_loop_last_start)}`);
    else parts.push('Never run');
    if (state.sound_loop_last_new_videos != null) parts.push(`${state.sound_loop_last_new_videos} new`);
    if (state.sound_loop_last_duration_secs != null) parts.push(fmt.dur(state.sound_loop_last_duration_secs));
    sMeta.textContent = parts.join(' · ');
  }
  _soundLoopPaused = !!state.sound_loop_paused;
  const sNext = el('soundLoopNext');
  if (sNext) sNext.textContent = state.sound_loop_running
    ? 'Running…'
    : _soundLoopPaused
      ? 'Paused'
      : (state.sound_loop_next ? `Next: ${fmt.relFuture(state.sound_loop_next)}` : '');
  _renderPauseState(el('soundPauseBtn'), sNext, _soundLoopPaused);

  const sSessions = el('soundLoopSessions');
  if (sSessions) {
    const nextIso    = state.sound_loop_next;
    const intervalMs = (state.sound_loop_interval_minutes || 60) * 60 * 1000;
    if (nextIso && intervalMs) {
      const nowMs  = Date.now();
      const nextMs = new Date(nextIso).getTime();
      const times  = [nextMs, nextMs + intervalMs, nextMs + 2 * intervalMs, nextMs + 3 * intervalMs];
      let   foundNext = false;
      sSessions.innerHTML = times.map(ts => {
        const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        let cls = 'loop-session-pill';
        if (state.sound_loop_running && !foundNext && ts >= nowMs) {
          foundNext = true; cls += ' running';
        } else if (ts < nowMs) {
          cls += ' done';
        } else if (!foundNext) {
          foundNext = true; cls += ' next';
        }
        return `<span class="${cls}">${time}</span>`;
      }).join('');
    } else {
      sSessions.innerHTML = '';
    }
  }
  const sBtn     = el('triggerSoundBtn');
  const sStopBtn = el('stopSoundBtn');
  if (sBtn)     sBtn.disabled     = state.sound_loop_running;
  if (sStopBtn) sStopBtn.disabled = !state.sound_loop_running;

  const missing = el('missingStatsCount');
  if (missing) {
    const n = state.missing_stats_count ?? 0;
    missing.textContent = n > 0 ? `${n.toLocaleString()} missing` : '';
  }
  const failed = el('statsFailedCount');
  if (failed) {
    const f = state.stats_failed_count ?? 0;
    failed.textContent   = f > 0 ? `${f.toLocaleString()} unavailable` : '';
    failed.style.display = f > 0 ? '' : 'none';
    const retryBtn = el('retryFailedBtn');
    if (retryBtn) retryBtn.style.display = f > 0 ? '' : 'none';
  }

  // Header backfill pill, visible only when there's work to do
  const bfPill  = el('hdrBackfillPill');
  const bfCount = el('hdrBackfillCount');
  if (bfPill && bfCount) {
    const n = state.missing_stats_count ?? 0;
    bfCount.textContent  = n.toLocaleString();
    bfPill.style.display = n > 0 ? '' : 'none';
  }

  _patchSoundRunStates();
}

function _patchSoundRunStates() {
  document.querySelectorAll('.user-card[data-soundid]').forEach(card => {
    const id      = card.dataset.soundid;
    const inQueue = soundRunQueue.includes(id);
    const isCur   = soundRunCurrent === id;
    const btn     = card.querySelector('.btn-run');
    if (!btn) return;
    btn.textContent = isCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
    btn.disabled    = inQueue || isCur;
  });
}

// ── App init ──────────────────────────────────────────────────────────────────

const tt = initChannelApp({
  id:                'tiktok',
  prefix:            'tt',
  api:               '/api/tiktok',
  creatorNoun:       'user',
  creatorNounPlural: 'users',
  itemNoun:          'video',
  itemNounPlural:    'videos',
  subLabelCard:      'followers',
  subLabelModal:     'followers',
  subLabelSort:      'Followers',
  uploadDateLabel:   'Uploaded',
  titleColLabel:     'Description',
  loopLabel:         'User Loop',
  loopsTitle:        'Loops',
  addPlaceholder:    '@username, sound ID, or URL',
  addAriaLabel:      'TikTok username, sound ID, or URL',
  profileUrl:        h => `https://www.tiktok.com/@${h}`,
  fieldLabels: {
    username: 'Handle', handle: 'Handle', display_name: 'Display name',
    bio: 'Bio', description: 'Bio', bio_link: 'Bio link', avatar: 'Avatar',
    account_status: 'Account status', privacy_status: 'Privacy',
  },
  hasBans: true,
  statsRows: s => [
    { label: 'Tracked users', value: (s.channel_count || 0).toLocaleString() },
    { label: 'Saved posts',   value: (s.saved_count   || 0).toLocaleString() },
    { label: 'Videos',        value: (s.video_count   || 0).toLocaleString() },
    { label: 'Photos',        value: (s.photo_count   || 0).toLocaleString() },
    { label: 'Deleted',       value: (s.deleted_count || 0).toLocaleString() },
    { label: 'Latest saved',  value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
    { label: 'Storage',       value: _fmtBytes(s.media_size_bytes || 0) },
  ],
  extraFilterGroups: [{
    key: 'priv', label: 'Privacy',
    options: [
      { key: 'public',  label: 'Public'  },
      { key: 'private', label: 'Private' },
      { key: 'blocked', label: 'Blocked' },
      { key: 'banned',  label: 'Banned'  },
    ],
    defaults: ['public', 'private'],
    test: (u, set) => {
      const key = u.account_status === 'banned' ? 'banned'
        : u.privacy_status === 'blocked' ? 'blocked'
        : ['private_accessible', 'private_blocked'].includes(u.privacy_status) ? 'private'
        : 'public';  // includes not-yet-checked users so new adds show under the default filter
      return set.has(key);
    },
  }],
  extraViews: [{
    key: 'sounds', label: 'Sounds',
    emptyLabel: 'No sounds tracked yet.',
    controlsHtml: _TT_SOUND_CONTROLS_HTML,
    show: q => { _soundSearch = q || ''; renderSounds(); },
  }],
  extraLoopHtml:     _TT_SOUND_LOOP_HTML,
  extraLoopLabel:    'Sounds',
  addHandler:        _ttAddHandler,
  videoActionBtnsFn: _ttVideoActionBtns,
  recentFallback:    item => item.sound_id
    ? `openSoundModalAndHighlight('${esc(item.sound_id)}','${esc(item.video_id)}')`
    : '',
  statusActive:      state => state.sound_loop_running || !!state.sound_run_current,
  nextRunCandidates: state => [
    state.loop_next       ? { iso: state.loop_next,       label: 'user loop'  } : null,
    state.sound_loop_next ? { iso: state.sound_loop_next, label: 'sound loop' } : null,
  ],
  onStatus:          _ttOnStatus,
});

// ── Sound loop triggers ───────────────────────────────────────────────────────

function triggerSoundLoop() { return _triggerLoop('triggerSoundBtn', '/api/tiktok/trigger/sounds', 'Could not trigger sound loop'); }

let _soundLoopPaused = false;

async function toggleSoundPause() {
  const paused = !_soundLoopPaused;
  const { ok } = await apiJSON('/api/tiktok/pause/sounds', {
    method: 'POST',
    body: JSON.stringify({ paused }),
  });
  if (!ok) { showToast('Could not update pause state.', { type: 'error' }); return; }
  _soundLoopPaused = paused;
  _renderPauseState(document.getElementById('soundPauseBtn'),
                    document.getElementById('soundLoopNext'), paused);
  showToast(paused ? 'Sound loop paused: scheduled runs will be skipped.' : 'Sound loop resumed.');
}

async function stopSoundLoop() {
  const btn = document.getElementById('stopSoundBtn');
  if (btn) btn.disabled = true;
  const { ok } = await apiJSON('/api/tiktok/stop/sounds', { method: 'POST' });
  if (!ok) {
    if (btn) btn.disabled = false;
    showToast('Could not stop sound loop.', { type: 'error' });
  }
}

// ── Sounds catalog ────────────────────────────────────────────────────────────

function setSoundFilter(group, value) {
  const set = soundFilter[group];
  set.has(value) ? set.delete(value) : set.add(value);
  const map = group === 'stat' ? SOUND_STAT_IDS : SOUND_STAR_IDS;
  Object.entries(map).forEach(([v, id]) => {
    document.getElementById(id)?.classList.toggle('active', set.has(v));
  });
  renderSounds();
}

function setSoundSortField(field) {
  soundSort.field = field;
  soundSort.dir   = (field === 'label') ? 'asc' : 'desc';
  _updateSoundSortBtn();
  renderSounds();
}

function toggleSoundSortDir() {
  soundSort.dir = soundSort.dir === 'asc' ? 'desc' : 'asc';
  _updateSoundSortBtn();
  renderSounds();
}

function _updateSoundSortBtn() {
  const btn = document.getElementById('soundSortDirBtn');
  if (btn) btn.textContent = _SOUND_SORT_DIR_LABELS[soundSort.field]?.[soundSort.dir] ?? soundSort.dir;
}

function resetSoundFilters() {
  soundFilter  = _defaultSoundFilter();
  soundSort    = { field: 'label', dir: 'asc' };
  _soundSearch = '';
  const searchEl = tt.el('Search');
  if (searchEl) searchEl.value = '';
  const sel = document.getElementById('soundSortField');
  if (sel) sel.value = 'label';
  _updateSoundSortBtn();
  Object.entries(SOUND_STAT_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', soundFilter.stat.has(v)));
  Object.entries(SOUND_STAR_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', soundFilter.star.has(v)));
  renderSounds();
}

function renderSounds() {
  const grid = tt.el('Grid_sounds');
  if (!grid) return;
  const q = _soundSearch.toLowerCase();
  let filtered = sounds;
  if (soundFilter.stat.size)           filtered = filtered.filter(s => soundFilter.stat.has(s.tracking_enabled === 0 ? 'inactive' : 'active'));
  if (soundFilter.star.has('starred')) filtered = filtered.filter(s => s.starred);
  if (q) filtered = filtered.filter(s => `${s.label || ''} ${s.sound_id}`.toLowerCase().includes(q));
  const isFiltered = soundFilter.stat.size > 0 || soundFilter.star.size > 0 || !!_soundSearch;
  if (tt.getTrackingView() === 'sounds') {
    const countEl = tt.el('Count');
    if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${sounds.length}` : sounds.length;
  }
  const { field, dir } = soundSort;
  filtered = [...filtered].sort((a, b) => {
    const av = field === 'label' ? (a.label || a.sound_id) : (a[field] ?? 0);
    const bv = field === 'label' ? (b.label || b.sound_id) : (b[field] ?? 0);
    return _cmp(av, bv, dir);
  });
  if (!sounds.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No sounds tracked yet.</div>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No sounds match this search.</div>' + _ghostCards(9);
    return;
  }
  grid.innerHTML = filtered.map(s => {
    const label      = s.label || s.sound_id;
    const ttUrl      = `https://www.tiktok.com/music/-${s.sound_id}`;
    const checked    = _fmtLastChecked(s.last_checked);
    const saved      = s.last_saved ? ` · Last saved ${fmt.rel(new Date(s.last_saved * 1000).toISOString())}` : '';
    const inQueue    = soundRunQueue.includes(s.sound_id);
    const isCurrent  = soundRunCurrent === s.sound_id;
    const runLabel   = isCurrent ? 'Running…' : inQueue ? 'Queued' : 'Run';
    const runDis     = (inQueue || isCurrent) ? 'disabled' : '';
    const { cls: sTrackingCls, label: sTrackingLabel } = _trackingBadge(s.tracking_enabled);
    const isInactive = s.tracking_enabled === 0;
    return `
      <div class="user-card${isInactive ? ' user-card-inactive' : ''}" data-soundid="${esc(s.sound_id)}" onclick="if(!event.target.closest('button,a'))openSoundModal('${esc(s.sound_id)}')" role="button" tabindex="0">
        <div class="user-card-top">
          <div class="sound-icon-wrap"><span class="sound-icon-letter">♫</span></div>
          <div class="user-identity">
            <div class="user-display-name">${esc(label)}</div>
            <div class="user-handle">
              <a href="${esc(ttUrl)}" target="_blank" rel="noopener"
                 onclick="event.stopPropagation()" class="tt-link"
              >${esc(s.sound_id)}</a>
            </div>
          </div>
          <div class="user-badges">
            <span class="account-status ${sTrackingCls}">${sTrackingLabel}</span>
          </div>
        </div>
        <div class="user-bio-area"></div>
        <div class="user-stats">
          <span class="stat-item"><span class="stat-item-label">saved</span><span class="stat-item-value">${s.video_count || 0}</span></span>
          ${s.video_deleted   ? `<span class="stat-item"><span class="stat-item-label">deleted</span><span class="stat-item-value" style="color:var(--red)">${s.video_deleted}</span></span>` : ''}
          ${s.video_undeleted ? `<span class="stat-item"><span class="stat-item-label">restored</span><span class="stat-item-value" style="color:var(--yellow)">${s.video_undeleted}</span></span>` : ''}
        </div>
        <div class="user-card-footer">
          <span class="user-checked">${checked}${saved}</span>
          <div style="display:flex;gap:6px;align-items:center;">
            <label class="tracking-toggle" title="${isInactive ? 'Sound tracking disabled' : 'Sound tracking enabled'}" onclick="event.stopPropagation()">
              <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="setSoundTracking('${esc(s.sound_id)}', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
            <button class="btn-star${s.starred ? ' starred' : ''}" onclick="event.stopPropagation();toggleSoundStar('${esc(s.sound_id)}')" title="${s.starred ? 'Unstar' : 'Star'}">${s.starred ? '★' : '☆'}</button>
            <button class="btn-run" ${runDis} onclick="event.stopPropagation();runSound('${esc(s.sound_id)}')">${runLabel}</button>
            <button class="btn-danger" onclick="event.stopPropagation();removeSound('${esc(s.sound_id)}','${esc(label)}')">Remove</button>
          </div>
        </div>
      </div>`;
  }).join('') + _ghostCards(Math.max(0, 9 - filtered.length));
}

async function loadSounds() {
  const { ok, data } = await apiJSON('/api/tiktok/sounds');
  if (ok) { sounds = data; renderSounds(); }
}

async function removeSound(soundId, label) {
  if (!confirm(`Remove sound "${label}" (${soundId})?\n\nVideos already downloaded will not be deleted.`)) return;
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}`, { method: 'DELETE' });
  if (!ok) { showToast(data.error || 'Failed to remove sound.', { type: 'error' }); return; }
  if (_soundModalId === soundId) closeSoundModal();
  loadSounds();
}

async function toggleSoundStar(soundId) {
  const sound = sounds.find(s => s.sound_id === soundId);
  if (!sound) return;
  const newVal = !sound.starred;
  sound.starred = newVal ? 1 : 0;
  renderSounds();
  await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/star`, {
    method: 'PATCH',
    body: JSON.stringify({ starred: newVal }),
  });
}

async function runSound(soundId) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/run`, { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start sound run.', { type: 'error' }); return; }
  soundRunQueue = [...soundRunQueue, soundId];
  renderSounds();
}

async function setSoundTracking(soundId, enabled) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/tracking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!ok) { showToast(data.error || 'Failed to update tracking', { type: 'error' }); return; }
  const s = sounds.find(s => s.sound_id === soundId);
  if (s) s.tracking_enabled = enabled ? 1 : 0;
  if (_soundModal && _soundModal.sound_id === soundId) {
    _soundModal.tracking_enabled = enabled ? 1 : 0;
    _renderSoundModalHeader(_soundModal);
  }
  renderSounds();
}

async function saveSoundComment(id, value) {
  const ok = await _saveCreatorComment('/api/tiktok/sounds', id, value, sounds, 'sound_id');
  if (ok && _soundModal && _soundModal.sound_id === id) _soundModal.comment = value.trim() || null;
}

async function editSoundLabel(soundId) {
  const s = sounds.find(s => s.sound_id === soundId);
  const newLabel = prompt('Edit label for this sound:', s?.label || '');
  if (newLabel === null) return;
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label: newLabel.trim() || null }),
  });
  if (!ok) { showToast(data.error || 'Failed to update label.', { type: 'error' }); return; }
  await loadSounds();
  if (_soundModalId === soundId) {
    _soundModal = sounds.find(s => s.sound_id === soundId);
    if (_soundModal) _renderSoundModalHeader(_soundModal);
  }
}

// ── Sound detail modal ────────────────────────────────────────────────────────

const SOUND_VCOLS = [
  { field: null,             label: '' },
  { field: null,             label: 'Description' },
  { field: null,             label: 'Author' },
  { field: 'status',         label: 'Status' },
  { field: 'view_count',     label: 'Views' },
  { field: 'upload_date',    label: 'Uploaded' },
  { field: 'download_date',  label: 'Downloaded' },
  { field: 'deleted_at',     label: 'Deleted' },
  { field: null,             label: '' },
];

const _soundState = { videos:[], filter:new Set(), typeFilter:new Set(), search:'', sort:{field:'upload_date',dir:'desc'}, loaded:0, obs:null, toolbarExpanded:false, view:'list' };

function _soundThumbCell(v) {
  const id    = esc(v.video_id);
  const badge = v.type === 'video' ? _playBadge : v.type === 'photo' ? (v.multi ? _photoBadge : _imageBadge) : '';
  const action = v.type === 'video'
    ? `onclick="event.stopPropagation();ttOpenVidModal('${id}')" title="Play video" style="cursor:pointer"`
    : v.type === 'photo'
      ? `onclick="event.stopPropagation();ttOpenCarousel('${id}')" title="View photos" style="cursor:pointer"`
      : 'style="cursor:default"';
  return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
    <img class="video-thumb" src="/api/tiktok/videos/${id}/thumbnail" alt="" loading="lazy"
         onerror="this.style.opacity='.15'"
         ${action}>${badge}</div>`;
}

const _SOUND_MODAL_CFG = {
  st: _soundState, listElId: 'soundModalVideoList', toolbarElId: 'soundModalToolbar',
  cols: SOUND_VCOLS, colsCls: 'sound-vcols', pageSize: 50,
  filterFn: 'setSoundModalFilter', typeFilterFn: 'setSoundModalTypeFilter',
  sortFn: 'setSoundModalSort', toggleFn: 'toggleSoundModalToolbar', searchFn: 'onSoundModalSearch',
  authorCol: v => {
    const name = v.author_handle || v.channel_id || '?';
    return v.author_enabled === 1
      ? `<span class="author-chip" onclick="event.stopPropagation();closeSoundModal();ttOpenModal('${esc(v.channel_id)}')">@${esc(name)}</span>`
      : `<span class="author-chip untracked" onclick="event.stopPropagation();closeSoundModal();openUntrackedUserModal('${esc(v.channel_id)}','${esc(name)}')">@${esc(name)}</span>`;
  },
  hasSearch: true, hasViewToggle: true, viewFn: 'setSoundModalView',
  gridId: 'soundVideoGrid', hasPhistBtn: false,
  thumbCellFn:  v => _soundThumbCell(v),
  actionBtnsFn: v => _ttVideoActionBtns(v),
  previewFn:    'ttOpenImgModal',
  typeIconFn:   v => v.type === 'video' ? _vgridPlayIcon : v.type === 'photo' ? (v.multi ? _vgridPhotoIcon : _vgridImageIcon) : '',
  gridThumbSrc: v => `/api/tiktok/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => { if (v.type === 'video') ttOpenVidModal(v.video_id); else if (v.type === 'photo') ttOpenCarousel(v.video_id); },
};

let _soundModalId               = null;
let _soundModal                 = null;
let _soundModalPendingHighlight = null; // { videoId, filter? }

function openSoundModal(soundId) {
  const s = sounds.find(s => s.sound_id === soundId);
  if (!s) return;
  _soundModalId = soundId;
  _soundModal   = s;
  Object.assign(_soundState, {
    videos: [], filter: new Set(), typeFilter: new Set(), search: '',
    sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, toolbarExpanded: false, view: 'list',
  });
  if (_soundState.obs) { _soundState.obs.disconnect(); _soundState.obs = null; }

  document.getElementById('soundModalBackdrop').style.display = 'flex';
  _lockScroll();

  _renderSoundModalHeader(s);
  _mRenderToolbar(_SOUND_MODAL_CFG, []);
  document.getElementById('soundModalVideoList').innerHTML =
    '<div class="vlist-loading">Loading videos…</div>';

  _loadSoundModalVideos(soundId);
}

function openSoundModalAndHighlight(soundId, videoId, filter) {
  _soundModalPendingHighlight = { videoId, filter: filter && filter !== 'all' ? new Set([filter]) : null };
  openSoundModal(soundId);
}

function closeSoundModal() {
  document.getElementById('soundModalBackdrop').style.display = 'none';
  _unlockScroll();
  if (_soundState.obs) { _soundState.obs.disconnect(); _soundState.obs = null; }
  _soundModalId      = null;
  _soundModal        = null;
  _soundState.videos = [];
}

function _renderSoundModalHeader(s) {
  const label  = s.label || s.sound_id;
  const ttUrl  = `https://www.tiktok.com/music/-${esc(s.sound_id)}`;
  const checked = _fmtLastChecked(s.last_checked);
  const { cls: sSoundTrackingCls, label: sSoundTrackingLbl } = _trackingBadge(s.tracking_enabled);
  const sSoundInactive = s.tracking_enabled === 0;
  document.getElementById('soundModalHeader').innerHTML = `
    <div class="modal-avatar-wrap">
      <div class="sound-icon-wrap" style="width:56px;height:56px">
        <span class="sound-icon-letter" style="font-size:26px">♫</span>
      </div>
    </div>
    <div class="modal-user-body">
      <div class="modal-name-row">
        <span class="modal-name">${esc(label)}</span>
        <button class="btn-ghost" style="font-size:11px;padding:3px 8px;margin-left:4px"
          onclick="editSoundLabel('${esc(s.sound_id)}')">Edit label</button>
        <span class="account-status ${sSoundTrackingCls}">${sSoundTrackingLbl}</span>
        <label class="tracking-toggle" title="${sSoundInactive ? 'Sound tracking disabled' : 'Sound tracking enabled'}">
          <input type="checkbox" ${sSoundInactive ? '' : 'checked'} onchange="setSoundTracking('${esc(s.sound_id)}', this.checked)">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">Track videos</span>
        </label>
      </div>
      <div class="modal-handle">
        <a href="${ttUrl}" target="_blank" rel="noopener"
           class="tt-link">${esc(s.sound_id)}</a>
      </div>
      <div class="modal-stats-row">
        <span><strong>${s.video_count || 0}</strong> saved locally</span>
        ${s.video_deleted   ? `<span style="color:var(--red)"><strong>${s.video_deleted}</strong> deleted</span>` : ''}
        ${s.video_undeleted ? `<span style="color:var(--yellow)"><strong>${s.video_undeleted}</strong> restored</span>` : ''}
        <span style="color:var(--muted)">${esc(checked)}</span>
      </div>
      <div style="display:flex;align-items:flex-start;gap:6px;margin-top:8px">
        <textarea placeholder="Add a note about this sound…"
          onblur="saveSoundComment('${esc(s.sound_id)}', this.value)"
          style="flex:1;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;
                 background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                 color:var(--text);font-family:inherit;line-height:1.5"
        >${esc(s.comment || '')}</textarea>
      </div>
    </div>
  `;
}

function setSoundModalFilter(f)     { _mSetFilter(_SOUND_MODAL_CFG, f); }
function setSoundModalTypeFilter(t) { _mSetTypeFilter(_SOUND_MODAL_CFG, t); }
function toggleSoundModalToolbar()  { _mToggleToolbar(_SOUND_MODAL_CFG); }
function setSoundModalSort(f)       { _mSetSort(_SOUND_MODAL_CFG, f); }

function setSoundModalView(view) {
  _soundState.view = view;
  const toolbar = document.getElementById('soundModalToolbar');
  toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === view);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _mRenderList(_SOUND_MODAL_CFG);
}

function onSoundModalSearch(val) {
  _soundState.search = val.trim();
  _mRenderToolbar(_SOUND_MODAL_CFG, _soundState.videos);
  _mRenderList(_SOUND_MODAL_CFG);
}

async function _loadSoundModalVideos(soundId) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/videos`);
  if (!ok || _soundModalId !== soundId) return;
  // Engine vocabulary: expose content_type/title under the names the renderers use
  data.forEach(v => { v.type = v.content_type; v.description = v.title; });
  _soundState.videos = data;
  if (_soundModalPendingHighlight) {
    const { videoId, filter } = _soundModalPendingHighlight;
    _soundModalPendingHighlight = null;
    if (filter) {
      _soundState.filter = filter;
      _soundState.sort   = { field: 'deleted_at', dir: 'desc' };
      _mRenderColHdrs(_SOUND_MODAL_CFG);
    }
    _mRenderToolbar(_SOUND_MODAL_CFG, data);
    _mRenderList(_SOUND_MODAL_CFG);
    const row = document.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('video-row-highlight');
      row.addEventListener('mouseenter', () => row.classList.remove('video-row-highlight'), { once: true });
    }
  } else {
    _mRenderToolbar(_SOUND_MODAL_CFG, data);
    _mRenderList(_SOUND_MODAL_CFG);
  }
}

// ── Untracked user modal (sound-discovered authors) ───────────────────────────

function openUntrackedUserModal(tiktokId, username) {
  tt.openModalRaw({ channel_id: tiktokId, handle: username, enabled: 0 },
                  () => _renderUntrackedHeader(tiktokId, username));
}

function _renderUntrackedHeader(tiktokId, username) {
  const hdr = tt.el('ModalHeader');
  hdr.classList.add('modal-header-untracked');
  hdr.innerHTML = `
    <div class="modal-avatar-wrap">
      <span class="avatar-letter">${esc((username || '?')[0])}</span>
    </div>
    <div class="modal-name-row">
      <span class="modal-name">@${esc(username)}</span>
    </div>
    <div class="modal-user-meta">
      <div class="modal-handle">@${esc(username)}</div>
      <div class="modal-id-line">id:${esc(tiktokId)}</div>
      <div class="modal-stats-row">
        <span><strong>-</strong> followers</span>
        <span><strong>-</strong> following</span>
        <span><strong>-</strong> on TikTok</span>
        <span><strong>0</strong> saved locally</span>
      </div>
    </div>
    <div class="modal-untracked-overlay" id="untrackedOverlay">
      <div class="modal-untracked-content">
        <div class="modal-untracked-identity">@${esc(username)}</div>
        <button class="btn-run btn-track-user"
                onclick="_trackUser('${esc(tiktokId)}','${esc(username)}')">Track user</button>
      </div>
    </div>`;
}

async function _trackUser(tiktokId, username) {
  const overlay = document.getElementById('untrackedOverlay');
  if (!overlay) return;
  overlay.innerHTML = '<div class="modal-untracked-spinner"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>';

  const { ok, data } = await apiJSON(
    `/api/tiktok/channels/${encodeURIComponent(tiktokId)}/track`,
    { method: 'POST' }
  );
  if (!ok) {
    overlay.innerHTML = `<div class="modal-untracked-error">${esc(data?.error || 'Failed to start tracking')}</div>`;
    return;
  }
  _pollUntilTracked(tiktokId, data.handle, overlay);
}

function _pollUntilTracked(tiktokId, username, overlay) {
  const iv = setInterval(async () => {
    const { ok: qOk, data: queue } = await apiJSON('/api/tiktok/queue');
    if (!qOk) return;
    const entry = queue[username];
    if (entry?.status === 'error') {
      clearInterval(iv);
      overlay.innerHTML = `<div class="modal-untracked-error">${esc(entry.message || 'Tracking failed')}</div>`;
      return;
    }
    if (!entry) {
      clearInterval(iv);
      await tt.loadCreators();
      const u = tt.getCreators().find(u => u.channel_id === tiktokId);
      if (u) {
        tt.setModalCreator(u);
        const hdr = tt.el('ModalHeader');
        tt.renderModalHeader(u);  // replaces innerHTML; overlay detached, class + position:relative kept
        const fadeEl = document.createElement('div');
        fadeEl.className = 'modal-untracked-overlay';
        hdr.appendChild(fadeEl);
        requestAnimationFrame(() => {
          fadeEl.style.transition = 'opacity 0.3s';
          fadeEl.style.opacity    = '0';
        });
        setTimeout(() => {
          fadeEl.remove();
          hdr.classList.remove('modal-header-untracked');
        }, 320);
        tt.loadModalVideos(tiktokId);
      } else {
        overlay.innerHTML = '<div class="modal-untracked-error">User data not found after tracking.</div>';
      }
    }
  }, 2000);
}

// ── Settings modal ────────────────────────────────────────────────────────────

let _settingsSection = 'accounts';

function openSettings(section) {
  const _OLD_TO_NEW = { cookies: 'accounts', loops: 'schedules', backfill: 'jobs', utils: 'jobs', migrate: 'jobs', auth: 'access' };
  const target = _OLD_TO_NEW[section] || section || _settingsSection;
  if (PLATFORMS.some(p => p.id === target)) {
    // A platform id (gear button, header auth pill) selects that platform
    // globally and lands on its Accounts section
    switchSettingsPlatform(target);
    switchSettingsSection('accounts');
  } else {
    switchSettingsSection(target);
  }
  document.getElementById('settingsBackdrop').style.display = 'flex';
  _lockScroll();
}

function closeSettings() {
  // Capture running state before _stopJobsPoll() nulls out _jobsPoll
  const avifRunning = _jobsPoll !== null;
  _stopJobsPoll();
  document.getElementById('settingsBackdrop').style.display = 'none';
  _unlockScroll();
  // Clear finished job widgets so reopening the panel shows a clean state
  if (!avifRunning)    { _avifWidget.hide();     document.getElementById('job-avif-btn').disabled     = false; }
  if (!_cleanupPoll)   { _cleanupWidget.hide();  document.getElementById('job-cleanup-btn').disabled  = false; }
  if (!_audioPoll)     { _audioWidget.hide();     document.getElementById('job-audio-btn').disabled    = false; }
  if (!_filecheckPoll) { _filecheckWidget.hide(); _filecheckReport.hide(); _setFilecheckBtns(false); }
  if (!_backfillPoll)  { document.getElementById('backfillStatus').textContent = ''; }
}

function switchSettingsSection(name) {
  _settingsSection = name;
  // Every settings section needs an entry here or its ssec-* div will never be shown.
  // When adding a new section: add the id to this list AND add ssec-*/snav-* elements in index.html.
  ['accounts', 'schedules', 'jobs', 'diag', 'database', 'access'].forEach(s => {
    document.getElementById(`ssec-${s}`).style.display    = s === name ? '' : 'none';
    document.getElementById(`snav-${s}`).classList.toggle('active', s === name);
  });
  document.querySelector('.settings-content').classList.toggle('diag-fill', name === 'diag');
  // The global platform selector applies to every section except Access
  const ptabs = document.getElementById('settingsPlatformTabs');
  if (ptabs) ptabs.style.display = name === 'access' ? 'none' : '';
  if (name === 'accounts')  { loadCookies(); twLoadCookies(); loadIgSessionStatus(); }
  if (name === 'schedules') { loadSettings(); loadYtSettings(); _scheduleSettingsLoad('twitter', 'twSettings'); _scheduleSettingsLoad('instagram', 'igSettings'); }
  if (name === 'access')    { loadAuthSettings(); }
  if (name === 'jobs')      { _avifLoadStatus(); _startJobsPoll(); }
  else                      { _stopJobsPoll(); }
  if (name === 'diag')      { diagSourceChanged(); }
}

async function loadSettings() {
  const { ok, data } = await apiJSON('/api/tiktok/settings');
  if (!ok) return;
  const _sv = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  _sv('settingsSessionsPerDay',    data.sessions_per_day);
  _sv('settingsHighPriorityHours', data.high_priority_check_hours);
  _sv('settingsActiveHours',       data.active_check_hours);
  _sv('settingsInactiveHours',     data.inactive_check_hours);
  _sv('settingsStatsRefreshDays',  data.stats_refresh_days);
  _sv('soundLoopIntervalInput',    data.sound_loop_interval_minutes);
}

async function saveLoopSettings() {
  const _iv = id => { const el = document.getElementById(id); return el ? parseInt(el.value, 10) : null; };
  const body = {
    sessions_per_day:          _iv('settingsSessionsPerDay'),
    high_priority_check_hours: _iv('settingsHighPriorityHours'),
    active_check_hours:        _iv('settingsActiveHours'),
    inactive_check_hours:      _iv('settingsInactiveHours'),
    stats_refresh_days:        _iv('settingsStatsRefreshDays'),
    sound_loop_interval_minutes: _iv('soundLoopIntervalInput'),
  };
  if (Object.values(body).some(v => !v || v < 1)) {
    showToast('All values must be positive integers.', { type: 'warning', duration: 4000 });
    return;
  }
  const { ok, data } = await apiJSON('/api/tiktok/settings', { method: 'PATCH', body: JSON.stringify(body) });
  if (!ok) { showToast(data.error || 'Could not save settings', { type: 'error' }); return; }
  showToast('Settings saved.', { type: 'success', duration: 2500 });
}

// ── Migration helpers ─────────────────────────────────────────────────────────

async function loadMigratePreview() {
  const previewEl  = document.getElementById('migrate-preview');
  const statusEl   = document.getElementById('migrateStatus');
  const runBtn     = document.getElementById('migrateRunBtn');
  previewEl.textContent = 'Scanning…';
  statusEl.textContent  = '';
  runBtn.style.display  = 'none';
  try {
    const { ok, data } = await apiJSON('/api/migrate/preview');
    if (!ok) { previewEl.textContent = data.error || 'Scan failed.'; return; }
    const total    = data.total_legacy || 0;
    const prefixes = data.prefixes     || {};
    const mediaDir = data.media_dir    || '';
    if (total === 0) {
      previewEl.innerHTML = '<span style="color:var(--green)">No legacy paths found. Database is already up to date.</span>';
      return;
    }
    let html = `<div style="margin-bottom:8px;">Found <strong>${total}</strong> record${total !== 1 ? 's' : ''} with paths outside <code>${esc(mediaDir)}</code>:</div>`;
    for (const [prefix, count] of Object.entries(prefixes)) {
      html += `<div style="font-size:12px;color:var(--muted);margin-bottom:3px"><code>${esc(prefix)}</code> &mdash; ${count} record${count !== 1 ? 's' : ''}</div>`;
    }
    previewEl.innerHTML = html;
    const oldInput = document.getElementById('migrateOldPrefix');
    const newInput = document.getElementById('migrateNewPrefix');
    if (!oldInput.value) oldInput.value = Object.keys(prefixes)[0] || '';
    if (!newInput.value) newInput.value = mediaDir.replace(/\/$/, '') + '/tiktok';
    runBtn.style.display = '';
  } catch (e) {
    previewEl.textContent = 'Scan failed: ' + e.message;
  }
}

async function runMigration() {
  const oldPrefix = (document.getElementById('migrateOldPrefix').value || '').trim().replace(/\/$/, '');
  const newPrefix = (document.getElementById('migrateNewPrefix').value || '').trim().replace(/\/$/, '');
  const statusEl  = document.getElementById('migrateStatus');
  const runBtn    = document.getElementById('migrateRunBtn');
  if (!oldPrefix || !newPrefix) {
    statusEl.textContent = 'Both path prefixes are required.';
    return;
  }
  if (!confirm(`Rewrite all DB paths?\n\n${oldPrefix}  →  ${newPrefix}\n\nA backup is made automatically before changes.`)) return;
  runBtn.disabled = true;
  statusEl.textContent = 'Running migration…';
  try {
    const { ok, data } = await apiJSON('/api/migrate/run', {
      method: 'POST',
      body: JSON.stringify({ old_prefix: oldPrefix, new_prefix: newPrefix }),
    });
    runBtn.disabled = false;
    if (!ok) { statusEl.textContent = data.error || 'Migration failed.'; return; }
    statusEl.textContent = `Done. ${data.updated} record${data.updated !== 1 ? 's' : ''} updated. Backup: ${data.backup}`;
    loadMigratePreview();
  } catch (e) {
    runBtn.disabled = false;
    statusEl.textContent = 'Migration failed: ' + e.message;
  }
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

let _jobsPoll    = null;
let _cleanupPoll = null;
let _audioPoll   = null;

const _avifWidget      = _makeJobWidget('avif');
const _cleanupWidget   = _makeJobWidget('cleanup');
const _audioWidget     = _makeJobWidget('audio');
const _filecheckWidget = _makeJobWidget('filecheck');

// AVIF converter

const _PHASE_LABELS = { startup: 'Checking…', counting: 'Counting…', photos: 'Photo posts…', thumbnails: 'Thumbnails…', avatars: 'Avatars…' };

async function _avifLoadStatus() {
  const { ok, data } = await apiJSON('/api/tiktok/jobs/photo-converter/status');
  if (!ok) return;
  const btn = document.getElementById('job-avif-btn');
  const isPending = data.phase === 'startup';
  btn.disabled = data.running || isPending;
  const total = data.total || 0;
  const done  = data.done  || 0;
  const pct   = total > 0 ? Math.round(done / total * 100) : (data.running || isPending ? 0 : 100);
  if (data.running || isPending) {
    const count = total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)` : '';
    _avifWidget.update({ barPct: pct, label: [_PHASE_LABELS[data.phase] || '', count].filter(Boolean).join('  ') });
  } else if (done > 0 || data.errors > 0) {
    const parts = [];
    if (done > 0)        parts.push(`${done.toLocaleString()} converted`);
    if (data.errors > 0) parts.push(`${data.errors} error${data.errors !== 1 ? 's' : ''}`);
    _avifWidget.update({ barPct: 100, label: parts.join(' · ') });
  } else {
    _avifWidget.update({ barPct: 100, label: total === 0 ? 'All images already in AVIF.' : '' });
  }
  if (!data.running && !isPending) _stopJobsPoll();
}

async function triggerAvifJob() {
  const btn = document.getElementById('job-avif-btn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/jobs/photo-converter/start', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); btn.disabled = false; return; }
  _avifLoadStatus();
  _startJobsPoll();
}

function _startJobsPoll() {
  if (_jobsPoll) return;
  _jobsPoll = setInterval(_avifLoadStatus, 1500);
}
function _stopJobsPoll() {
  if (_jobsPoll) { clearInterval(_jobsPoll); _jobsPoll = null; }
}

// Database cleanup

async function triggerCleanup() {
  const btn = document.getElementById('job-cleanup-btn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/db/cleanup', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start cleanup', { type: 'error' }); btn.disabled = false; return; }
  _cleanupWidget.update({ barPct: null, label: 'Running…' });
  if (_cleanupPoll) return;
  _cleanupPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/tiktok/db/cleanup');
    if (!ok) return;
    if (data.running) {
      _cleanupWidget.update({ barPct: null, label: data.current || 'Running…', steps: data.steps });
    } else {
      clearInterval(_cleanupPoll); _cleanupPoll = null;
      document.getElementById('job-cleanup-btn').disabled = false;
      _cleanupWidget.update({
        barPct: 100,
        label: `Done: ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
        steps: data.steps,
      });
    }
  }, 800);
}

// Audio cleanup

async function triggerAudioCleanup() {
  const btn = document.getElementById('job-audio-btn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/jobs/audio-cleanup/start', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); btn.disabled = false; return; }
  _audioWidget.update({ barPct: null, label: 'Running…' });
  if (_audioPoll) return;
  _audioPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/tiktok/jobs/audio-cleanup/status');
    if (!ok) return;
    if (data.running) {
      _audioWidget.update({ barPct: null, label: `Running… ${data.deleted} deleted, ${data.db_removed} removed from DB` });
    } else if (data.last_run) {
      clearInterval(_audioPoll); _audioPoll = null;
      document.getElementById('job-audio-btn').disabled = false;
      if (data.found === 0) {
        _audioWidget.update({ label: 'No audio files found.' });
      } else {
        const parts = [`Found ${data.found}`, `deleted ${data.deleted}`, `removed ${data.db_removed} from DB`];
        if (data.errors) parts.push(`${data.errors} error${data.errors !== 1 ? 's' : ''}`);
        _audioWidget.update({ label: parts.join(' · ') + ` (${data.last_run})` });
      }
    }
  }, 1000);
}

// Utilities: clear avatars and thumbnails

async function _runDeleteJob(btnId, statusId, textId, apiPath, bodyFn, resultFn) {
  const btn    = document.getElementById(btnId);
  const status = document.getElementById(statusId);
  const text   = document.getElementById(textId);
  btn.disabled = true;
  status.style.display = '';
  text.textContent = 'Deleting…';
  const opts = { method: 'POST' };
  if (bodyFn) opts.body = JSON.stringify(bodyFn());
  const { ok, data } = await apiJSON(apiPath, opts);
  btn.disabled = false;
  if (!ok) { text.textContent = data.error || 'Request failed.'; return; }
  text.textContent = resultFn(data);
}

function triggerClearAvatars() {
  const includeBanned = document.getElementById('util-clear-avatars-include-banned').checked;
  return _runDeleteJob(
    'util-clear-avatars-btn', 'util-clear-avatars-status', 'util-clear-avatars-text',
    '/api/tiktok/utils/clear-avatars',
    () => ({ include_banned: includeBanned }),
    d => `Deleted ${d.deleted} avatar file${d.deleted !== 1 ? 's' : ''}.`
  );
}

function triggerClearThumbnails() {
  return _runDeleteJob(
    'util-clear-thumbs-btn', 'util-clear-thumbs-status', 'util-clear-thumbs-text',
    '/api/tiktok/utils/clear-thumbnails',
    null,
    d => `Deleted ${d.deleted} thumbnail file${d.deleted !== 1 ? 's' : ''}.`
  );
}

// Missing file check

let _filecheckPoll       = null;
let _filecheckReportFile = null;
const _filecheckReport   = _makeReportWidget('filecheck', '/api/tiktok/reports');

function _setFilecheckBtns(disabled) {
  document.getElementById('job-filecheck-scan-btn').disabled  = disabled;
  document.getElementById('job-filecheck-purge-btn').disabled = disabled;
}

function _startFilecheckPoll() {
  if (_filecheckPoll) return;
  _filecheckPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/status');
    if (!ok) return;
    if (data.running) {
      const label = data.mode === 'purge' ? 'Purging...' : 'Scanning...';
      _filecheckWidget.update({ barPct: null, label });
      return;
    }
    clearInterval(_filecheckPoll); _filecheckPoll = null;
    _setFilecheckBtns(false);
    _filecheckReportFile = data.report_file || null;

    if (data.mode === 'scan') {
      if (data.found === 0) {
        _filecheckWidget.update({ label: `All files present. ${data.last_run}` });
        _filecheckReport.hide();
      } else {
        _filecheckWidget.update({ label: `${data.found} missing file${data.found !== 1 ? 's' : ''} found. ${data.last_run}` });
        _filecheckReport.show(data.report_file, data.preview, data.found);
      }
    } else if (data.mode === 'purge') {
      if (data.removed === 0) {
        _filecheckWidget.update({ label: `No missing files. Nothing removed. ${data.last_run}` });
        _filecheckReport.hide();
      } else {
        _filecheckWidget.update({ label: `${data.removed} record${data.removed !== 1 ? 's' : ''} removed from DB. ${data.last_run}` });
        _filecheckReport.show(data.report_file, data.preview, data.removed);
      }
    }
  }, 1000);
}

async function triggerFileScan() {
  _setFilecheckBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/scan', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); _setFilecheckBtns(false); return; }
  _filecheckWidget.update({ barPct: null, label: 'Scanning...' });
  _filecheckReport.hide();
  _startFilecheckPoll();
}

async function triggerFilePurge() {
  if (!confirm('Remove all DB records for files that are missing on disk?\nThis cannot be undone.')) return;
  _setFilecheckBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/purge', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); _setFilecheckBtns(false); return; }
  _filecheckWidget.update({ barPct: null, label: 'Purging...' });
  _filecheckReport.hide();
  _startFilecheckPoll();
}

// ── Diagnostics ────────────────────────────────────────────────────────────────

const _DIAG_ACTIONS = {
  get_video_details: [{ value: "",                 label: "Fetch post details (paste TikTok URL)" }],
  ytdlp:            [{ value: "user_videos",       label: "List user videos (paste channel_id)" },
                     { value: "video_info",        label: "Raw video info (paste TikTok URL)" }],
  tiktokapi:        [{ value: "user_info",            label: "User profile by username (paste @username)" },
                     { value: "resolve_username",    label: "Resolve username to channel_id + sec_uid (raw)" },
                     { value: "user_info_by_id",     label: "User profile by ID (paste channel_id:sec_uid)" },
                     { value: "item_list_username",  label: "item_list by username (library resolves sec_uid)" },
                     { value: "item_list_by_id",     label: "item_list by channel_id:sec_uid" },
                     { value: "item_list_from_db",   label: "item_list from DB (mirrors loop -- paste @username)" },
                     { value: "user_stories",        label: "Live stories for a tracked user (paste @username)" },
                     { value: "sound_raw",           label: "Sound raw API output (paste sound_id or URL)" }],
};

function diagSourceChanged() {
  const source   = document.getElementById('diagSource').value;
  const actionEl = document.getElementById('diagAction');
  actionEl.innerHTML = (_DIAG_ACTIONS[source] || [])
    .map(a => `<option value="${a.value}">${a.label}</option>`).join('');
  diagActionChanged();
}

function diagActionChanged() {
  const source = document.getElementById('diagSource').value;
  const action = document.getElementById('diagAction').value;
  const placeholders = {
    'get_video_details:':          'https://www.tiktok.com/@user/video/123…',
    'ytdlp:user_videos':           'channel_id (numeric)',
    'ytdlp:video_info':            'https://www.tiktok.com/@user/video/123…',
    'tiktokapi:user_info':              '@username or username',
    'tiktokapi:resolve_username':       '@username or username',
    'tiktokapi:user_info_by_id':        'channel_id:sec_uid',
    'tiktokapi:item_list_username':     '@username or username',
    'tiktokapi:item_list_by_id':        'channel_id:sec_uid',
    'tiktokapi:item_list_from_db':      '@username (must exist in DB)',
    'tiktokapi:user_stories':           '@username of a tracked user',
    'tiktokapi:sound_raw':              'sound_id (numeric) or TikTok sound URL',
  };
  document.getElementById('diagInput').placeholder =
    placeholders[`${source}:${action}`] || '';
}

async function diagRun() {
  const source  = document.getElementById('diagSource').value;
  const action  = document.getElementById('diagAction').value;
  const inp     = document.getElementById('diagInput').value.trim();
  const outEl   = document.getElementById('diagOutput');
  const btn     = document.getElementById('diagRunBtn');
  const hint    = document.getElementById('diagResolveHint');

  if (!inp) { outEl.textContent = 'Error: enter a URL or ID first.'; return; }

  hint.style.display = 'none';
  btn.disabled  = true;
  const isSlowAction = action.startsWith('item_list') || action === 'sound_raw';
  outEl.textContent = isSlowAction
    ? 'Running... paginates with delays -- allow several minutes for large sounds/accounts'
    : 'Running... (this may take up to 30 s for TikTokApi calls)';

  const { ok, data } = await apiJSON('/api/tiktok/debug/fetch', {
    method: 'POST',
    body: JSON.stringify({ source, action, input: inp }),
  });

  btn.disabled = false;
  outEl.textContent = ok ? (data.output ?? JSON.stringify(data, null, 2))
                         : (data?.output || data?.error || 'Request failed');

  if (ok && action === 'resolve_username') {
    try {
      const parsed  = JSON.parse(data.output);
      const user    = parsed?.userInfo?.user;
      const id      = user?.id;
      const secUid  = user?.secUid;
      if (id && secUid) {
        hint.innerHTML = `<a href="#" onclick="diagSendToProfileById('${esc(id)}','${esc(secUid)}');return false">→ fetch full profile via User profile by ID</a>`;
        hint.style.display = '';
      }
    } catch (_) {}
  }
}

function diagSendToProfileById(tiktokId, secUid) {
  document.getElementById('diagSource').value = 'tiktokapi';
  diagSourceChanged();
  document.getElementById('diagAction').value = 'user_info_by_id';
  diagActionChanged();
  document.getElementById('diagInput').value = `${tiktokId}:${secUid}`;
  diagRun();
}

function diagCopy() {
  const text = document.getElementById('diagOutput').textContent;
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ── Stats backfill ────────────────────────────────────────────────────────────

let _backfillPoll = null;

async function triggerBackfill() {
  const btn = document.getElementById('backfillBtn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/backfill', { method: 'POST' });
  if (!ok) {
    showToast(data.error || 'Could not start backfill', { type: 'error' });
    btn.disabled = false;
    return;
  }
  _startBackfillPoll();
}

async function retryFailed() {
  const btn = document.getElementById('retryFailedBtn');
  const statusEl = document.getElementById('backfillStatus');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/backfill/reset-errors', { method: 'POST' });
  btn.disabled = false;
  if (!ok) { statusEl.textContent = data.error || 'Failed.'; return; }
  statusEl.textContent = `${data.reset} video(s) cleared, ready to retry.`;
  setTimeout(() => { statusEl.textContent = ''; }, 8000);
  // Reload status so the counts update
  ttLoadStatus();
}

let _failedListOpen = false;

async function toggleFailedList() {
  const el = document.getElementById('failedList');
  _failedListOpen = !_failedListOpen;
  if (!_failedListOpen) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.textContent = 'Loading…';
  const { ok, data } = await apiJSON('/api/tiktok/backfill/failed');
  if (!ok) { el.textContent = 'Failed to load.'; return; }
  if (!data.length) { el.textContent = 'None.'; return; }
  el.innerHTML = data.map(v =>
    `<div><code style="user-select:all">${esc(v.video_id)}</code>`
    + ` · @${esc(v.handle)}`
    + (v.stats_last_error ? ` · <span style="color:var(--red)">${esc(v.stats_last_error)}</span>` : '')
    + `</div>`
  ).join('');
}

function _startBackfillPoll() {
  if (_backfillPoll) return;
  _backfillPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/tiktok/backfill');
    if (!ok) return;
    const btn      = document.getElementById('backfillBtn');
    const statusEl = document.getElementById('backfillStatus');
    if (data.running) {
      btn.disabled = true;
      statusEl.textContent = `Backfilling… ${data.done}/${data.total}`;
    } else {
      clearInterval(_backfillPoll);
      _backfillPoll = null;
      btn.disabled = false;
      const ok2 = data.done - data.errors;
      statusEl.textContent = data.total === 0
        ? 'Nothing to backfill'
        : `Done: ${ok2} updated, ${data.errors} failed`;
      setTimeout(() => { statusEl.textContent = ''; }, 12000);
    }
  }, 2000);
}

// Reset backfill: two-step confirmation

let _resetBackfillConfirming = false;
let _resetBackfillTimer = null;

function resetBackfillStep() {
  const btn = document.getElementById('resetBackfillBtn');
  const statusEl = document.getElementById('resetBackfillStatus');

  if (!_resetBackfillConfirming) {
    // First click enters the confirm state
    _resetBackfillConfirming = true;
    btn.textContent = 'Click again to confirm';
    btn.style.background = 'var(--red-bg)';
    statusEl.textContent = 'This will queue all videos for re-backfill.';
    statusEl.style.color = 'var(--red)';
    // Auto-cancel after 5 s
    _resetBackfillTimer = setTimeout(() => {
      _resetBackfillConfirming = false;
      btn.textContent = 'Reset all backfill status';
      btn.style.background = '';
      statusEl.textContent = '';
    }, 5000);
  } else {
    // Second click executes
    clearTimeout(_resetBackfillTimer);
    _resetBackfillConfirming = false;
    btn.disabled = true;
    btn.textContent = 'Reset all backfill status';
    btn.style.background = '';
    statusEl.textContent = 'Resetting…';
    statusEl.style.color = 'var(--muted)';

    apiJSON('/api/tiktok/backfill/reset', { method: 'POST' }).then(({ ok, data }) => {
      btn.disabled = false;
      if (!ok) {
        statusEl.textContent = data.error || 'Failed.';
        statusEl.style.color = 'var(--red)';
      } else {
        statusEl.textContent = `Done. ${data.reset.toLocaleString()} videos marked for re-backfill.`;
        statusEl.style.color = 'var(--green)';
        setTimeout(() => { statusEl.textContent = ''; }, 12000);
      }
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadCookies();
loadSounds();
setInterval(loadCookies, 30000);
setInterval(loadSounds,  60000);
_initAllGliders();

// Global settings platform selector
initSettingsPlatformTabs();
PLATFORMS.forEach(p => initDbQueryPane(p.id));

// Resume backfill poll if it was running before page load
(async () => {
  const { ok, data } = await apiJSON('/api/tiktok/backfill');
  if (ok && data.running) {
    document.getElementById('backfillBtn').disabled = true;
    document.getElementById('backfillStatus').textContent = `Backfilling… ${data.done}/${data.total}`;
    _startBackfillPoll();
  }
})();

// Migration warning

(async function checkMigrationStatus() {
  try {
    const { ok, data } = await apiJSON('/api/migrate/preview');
    if (!ok || !data.total_legacy) return;
    const n = data.total_legacy;
    showToast(
      `${n.toLocaleString()} post${n !== 1 ? 's' : ''} have paths that need migration.`,
      {
        type: 'warning',
        duration: 0,
        action: { label: 'Open Migration Settings', onclick: () => openSettings('migrate') },
      }
    );
  } catch (_) {}
})();

// ── Back to top ───────────────────────────────────────────────────────────────
(function() {
  const btn = document.getElementById('backToTopBtn');
  window.addEventListener('scroll', () => {
    btn.style.display = window.scrollY > 200 ? 'flex' : 'none';
  }, { passive: true });
})();
