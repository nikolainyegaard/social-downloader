// ── State ────────────────────────────────────────────────────────────────────

let users         = [];
let currentUser   = null;
let isRunning     = false;
let logLines      = [];
let _deletionConfirmThreshold = 3;  // synced from /api/status
let logClearIndex = 0;
let _logClearRestored = false;
let pending       = {};
const dismissed   = new Set();
let runQueue      = [];   // tiktok_ids queued for manual run
let runCurrent    = null; // tiktok_id currently being run manually
let userSort      = { field: 'username', dir: 'asc' };
let userFilter    = { priv: 'all', stat: 'all', star: 'all' };

// ── Cookie management ─────────────────────────────────────────────────────────

function renderCookies(info) {
  const timeStr = (info.present && info.updated_at)
    ? `Uploaded ${(() => { const h = Math.round((Date.now() - info.updated_at * 1000) / 3600000); return h < 24 ? `${h}h ago` : `${Math.round(h/24)}d ago`; })()}`
    : '';
  const metaStr = info.present
    ? [timeStr, `${(info.size_bytes / 1024).toFixed(1)} KB`].filter(Boolean).join('  ·  ')
    : '';

  // Settings modal elements
  const pill    = document.getElementById('cookiePill');
  const pillTxt = document.getElementById('cookiePillText');
  const meta    = document.getElementById('cookieMeta');
  const delBtn  = document.getElementById('cookieDeleteBtn');
  if (pill)    { pill.className = info.present ? 'cookie-pill present' : 'cookie-pill absent'; }
  if (pillTxt) { pillTxt.textContent = info.present ? 'Cookies loaded' : 'No cookies file'; }
  if (meta)    { meta.textContent = metaStr; }
  if (delBtn)  { delBtn.style.display = info.present ? '' : 'none'; }

  // Header pill
  const hdrPill    = document.getElementById('hdrCookiePill');
  const hdrPillTxt = document.getElementById('hdrCookiePillText');
  if (hdrPill)    { hdrPill.className = `cookie-pill ${info.present ? 'present' : 'absent'}`; }
  if (hdrPillTxt) { hdrPillTxt.textContent = info.present ? 'Cookies' : 'No cookies'; }
}

async function uploadCookies(input) {
  if (!input.files.length) return;
  const form = new FormData();
  form.append('file', input.files[0]);
  input.value = '';

  const r    = await fetch('/api/tiktok/cookies', { method: 'POST', body: form });
  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    renderCookies(data);
  } else {
    showToast(data.error || 'Upload failed', { type: 'error' });
  }
}

async function deleteCookies() {
  if (!confirm('Remove the stored cookies file?')) return;
  const { ok } = await apiJSON('/api/tiktok/cookies', { method: 'DELETE' });
  if (ok) loadCookies();
}

async function loadCookies() {
  const { ok, data } = await apiJSON('/api/tiktok/cookies');
  if (ok) renderCookies(data);
}

// ── Statistics panel ─────────────────────────────────────────────────────────

function renderStats(s) {
  _renderStatGrid('statsGrid', [
    { label: 'Tracked users', value: (s.user_count    || 0).toLocaleString() },
    { label: 'Saved videos',  value: (s.saved_count   || 0).toLocaleString() },
    { label: 'Video posts',   value: (s.video_count   || 0).toLocaleString() },
    { label: 'Photo posts',   value: (s.photo_count   || 0).toLocaleString() },
    { label: 'Deleted',       value: (s.deleted_count || 0).toLocaleString() },
    { label: 'Latest saved',  value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
    { label: 'Total views',   value: _fmtLarge(s.total_views || 0) },
    { label: 'Total likes',   value: _fmtLarge(s.total_likes || 0) },
  ]);
}

async function loadStats() {
  const { ok, data } = await apiJSON('/api/tiktok/stats');
  if (ok) renderStats(data);
}

// ── Recent panel ──────────────────────────────────────────────────────────────

const _FIELD_LABELS = {
  username: 'Username', display_name: 'Display name', bio: 'Bio', avatar: 'Avatar',
  account_status: 'Account status', privacy_status: 'Privacy',
};

function _recentDate(ts, now = new Date()) {
  const d        = new Date(ts * 1000);
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dDay     = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - dDay) / 86400000);
  const timeStr  = _dtFmtTime.format(d);
  if (diffDays === 0) return `Today, ${timeStr}`;
  if (diffDays === 1) return `Yesterday, ${timeStr}`;
  return _dtFmtRecent.format(d);
}

function renderRecent(data) {
  const leftEl  = document.getElementById('recentLeft');
  const rightEl = document.getElementById('recentRight');
  if (!leftEl || !rightEl) return;
  const now = new Date();

  // ── Left column ───────────────────────────────────────────────────────────

  let left = '';

  // Recently deleted
  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="openRecentLog('deletions')" title="View all deleted videos">Recently deleted</div>`;
  if (data.deletions.length) {
    left += data.deletions.map(d => {
      const onclick = d.enabled !== 0
        ? `openUserModalAndHighlight('${esc(d.tiktok_id)}','${esc(d.video_id)}')`
        : d.sound_id ? `openSoundModalAndHighlight('${esc(d.sound_id)}','${esc(d.video_id)}','deleted')` : '';
      return `<div class="recent-entry" onclick="${onclick}" title="Open @${esc(d.username)}">
        <span class="recent-date">${_recentDate(d.deleted_at, now)}</span>
        <span class="recent-name" ${d.enabled !== 0 ? '' : 'style="color:var(--text-dim)"'}>@${esc(d.username)}</span>
        <span class="recent-detail">${esc(d.video_id.slice(0, 10))}\u2026</span>
      </div>`;
    }).join('');
  } else {
    left += `<div class="recent-empty">No deleted videos yet</div>`;
  }
  left += `</div>`;

  // Recently changed profile
  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="openRecentLog('profile-changes')" title="View all profile changes">Recently changed profile</div>`;
  if (data.profile_changes.length) {
    left += data.profile_changes.map(p =>
      `<div class="recent-entry" onclick="openUserModalWithHistory('${esc(p.tiktok_id)}','${esc(p.field)}')" title="Open @${esc(p.username)} · ${esc(_FIELD_LABELS[p.field] || p.field)} history">
        <span class="recent-date">${_recentDate(p.changed_at, now)}</span>
        <span class="recent-name">@${esc(p.username)}</span>
        <span class="recent-detail">${esc(_FIELD_LABELS[p.field] || p.field)}</span>
      </div>`
    ).join('');
  } else {
    left += `<div class="recent-empty">No profile changes recorded yet</div>`;
  }
  left += `</div>`;

  // Recently banned
  left += `<div class="recent-section">`;
  left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="openRecentLog('bans')" title="View all banned accounts">Recently banned</div>`;
  if (data.bans && data.bans.length) {
    const b = data.bans[0];
    left += `<div class="recent-entry" onclick="openUserModal('${esc(b.tiktok_id)}')" title="Open @${esc(b.username)}">
      <span class="recent-date">${_recentDate(b.banned_at, now)}</span>
      <span class="recent-name">@${esc(b.username)}</span>
      <span class="recent-detail" style="color:var(--red)">Banned</span>
    </div>`;
  } else {
    left += `<div class="recent-empty">No banned accounts</div>`;
  }
  left += `</div>`;

  leftEl.innerHTML = left;

  // ── Right column: Recently saved ──────────────────────────────────────────

  let right = '';
  right += `<div class="recent-section">`;
  right += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="openRecentLog('saved')" title="View all saved videos">Recently saved</div>`;
  if (data.saved && data.saved.length) {
    right += data.saved.map(g => {
      const onclick = g.enabled !== 0
        ? (g.count === 1
            ? `openUserModalAndHighlight('${esc(g.tiktok_id)}','${esc(g.video_id)}','all','download_date','desc')`
            : `openUserModal('${esc(g.tiktok_id)}')`)
        : g.sound_id ? `openSoundModalAndHighlight('${esc(g.sound_id)}','${esc(g.video_id)}')` : '';
      const nameStyle = g.enabled !== 0 ? '' : 'style="color:var(--text-dim)"';
      return `<div class="recent-entry" onclick="${onclick}" title="Open @${esc(g.username)}">
        <span class="recent-date">${_recentDate(g.download_date, now)}</span>
        <span class="recent-name" ${nameStyle}>@${esc(g.username)}</span>
        <span class="recent-detail">${g.count}x</span>
      </div>`;
    }).join('');
  } else {
    right += `<div class="recent-empty">No videos saved yet</div>`;
  }
  right += `</div>`;

  rightEl.innerHTML = right;
}

async function loadRecent() {
  const { ok, data } = await apiJSON('/api/tiktok/recent');
  if (ok) renderRecent(data);
}

// ── Recent log modal ──────────────────────────────────────────────────────────

const _RECENT_LOG_TITLES = {
  'deletions':       'All Deleted Videos',
  'profile-changes': 'All Profile Changes',
  'bans':            'All Banned Accounts',
  'saved':           'All Saved Videos',
};

let _recentLogType      = null;
let _recentLogOffset    = 0;
let _recentLogDone      = false;
let _recentLogLoading   = false;
let _recentLogObs       = null;
let _recentLogLastGroup = null; // cross-batch stitch for 'saved' collapsing

function openRecentLog(type) {
  _recentLogType      = type;
  _recentLogOffset    = 0;
  _recentLogDone      = false;
  _recentLogLoading   = false;
  _recentLogLastGroup = null;

  document.getElementById('recentLogTitle').textContent = _RECENT_LOG_TITLES[type] || type;
  document.getElementById('recentLogBody').innerHTML = '';
  document.getElementById('recentLogBackdrop').style.display = 'flex';
  _lockScroll();

  _setupRecentLogScroll();
  // Initial load is triggered by the IntersectionObserver firing on the
  // newly-added sentinel (which is immediately visible in the empty container).
  // No explicit call here to avoid a double-fetch race.
}

function closeRecentLog() {
  document.getElementById('recentLogBackdrop').style.display = 'none';
  _unlockScroll();
  if (_recentLogObs) { _recentLogObs.disconnect(); _recentLogObs = null; }
  _recentLogLastGroup = null;
  _recentLogType    = null;
  _recentLogLoading = false;
}

function _setupRecentLogScroll() {
  if (_recentLogObs) _recentLogObs.disconnect();
  const sentinel = document.createElement('div');
  sentinel.id = 'recentLogSentinel';
  sentinel.style.height = '1px';
  document.getElementById('recentLogBody').appendChild(sentinel);
  _recentLogObs = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && !_recentLogDone) _loadRecentLogBatch();
  }, { threshold: 0 });
  _recentLogObs.observe(sentinel);
}

async function _loadRecentLogBatch() {
  if (_recentLogDone || !_recentLogType || _recentLogLoading) return;
  _recentLogLoading = true;
  const url = `/api/tiktok/recent/${_recentLogType}?offset=${_recentLogOffset}&limit=50`;
  const { ok, data } = await apiJSON(url);
  if (!ok || !_recentLogType) { _recentLogLoading = false; return; }

  // 'saved' returns {items, rows_consumed}; all other types return a plain array.
  const items   = _recentLogType === 'saved' ? data.items        : data;
  const advance = _recentLogType === 'saved' ? data.rows_consumed : data.length;

  if (!items.length) { _recentLogDone = true; _recentLogLoading = false; return; }
  _recentLogOffset += advance;
  if (items.length < 50) _recentLogDone = true;

  const body = document.getElementById('recentLogBody');
  const sentinel = document.getElementById('recentLogSentinel');
  const frag = document.createDocumentFragment();
  const now = new Date();

  if (_recentLogType === 'saved') {
    // Server returns pre-grouped consecutive runs; stitch across batch boundaries.
    let i = 0;
    if (_recentLogLastGroup && items.length > 0 && _recentLogLastGroup.tiktok_id === items[0].tiktok_id) {
      // First group of this batch continues the last group of the previous batch.
      const merged = _recentLogLastGroup.count + items[0].count;
      _recentLogLastGroup.count = merged;
      const detailEl = _recentLogLastGroup.el.querySelector('.recent-detail');
      if (detailEl) detailEl.textContent = `${merged}x`;
      i = 1;
    }
    for (; i < items.length; i++) {
      const g = items[i];
      const row = document.createElement('div');
      row.className = 'recent-entry';
      row.title = `Open @${g.username}`;
      if (g.enabled !== 0) {
        row.onclick = g.count === 1
          ? () => openUserModalAndHighlight(g.tiktok_id, g.video_id, 'all', 'download_date', 'desc')
          : () => openUserModal(g.tiktok_id);
      } else if (g.sound_id) {
        row.onclick = () => { openSoundModalAndHighlight(g.sound_id, g.video_id); };
      }
      row.innerHTML = `
        <span class="recent-date">${_recentDate(g.download_date, now)}</span>
        <span class="recent-name" ${g.enabled !== 0 ? '' : 'style="color:var(--text-dim)"'}>@${esc(g.username)}</span>
        <span class="recent-detail">${g.count}x</span>`;
      frag.appendChild(row);
      _recentLogLastGroup = { tiktok_id: g.tiktok_id, el: row, count: g.count };
    }
  } else {
    data.forEach(item => {
      const row = document.createElement('div');
      row.className = 'recent-entry';
      if (_recentLogType === 'deletions') {
        row.title = `Open @${item.username}`;
        if (item.enabled !== 0) {
          row.onclick = () => { openUserModalAndHighlight(item.tiktok_id, item.video_id); };
        } else if (item.sound_id) {
          row.onclick = () => { openSoundModalAndHighlight(item.sound_id, item.video_id, 'deleted'); };
        }
        row.innerHTML = `
          <span class="recent-date">${_recentDate(item.deleted_at, now)}</span>
          <span class="recent-name" ${item.enabled !== 0 ? '' : 'style="color:var(--text-dim)"'}>@${esc(item.username)}</span>
          <span class="recent-detail">${esc(item.video_id)}</span>`;
      } else if (_recentLogType === 'profile-changes') {
        const label = _FIELD_LABELS[item.field] || item.field;
        row.title = `Open @${item.username} · ${label} history`;
        row.onclick = () => { openUserModalWithHistory(item.tiktok_id, item.field); };
        row.innerHTML = `
          <span class="recent-date">${_recentDate(item.changed_at, now)}</span>
          <span class="recent-name">@${esc(item.username)}</span>
          <span class="recent-detail">${esc(label)}</span>`;
      } else {
        row.title = `Open @${item.username}`;
        row.onclick = () => { openUserModal(item.tiktok_id); };
        row.innerHTML = `
          <span class="recent-date">${_recentDate(item.banned_at, now)}</span>
          <span class="recent-name">@${esc(item.username)}</span>
          <span class="recent-detail" style="color:var(--red)">Banned</span>`;
      }
      frag.appendChild(row);
    });
  }

  body.insertBefore(frag, sentinel);
  _recentLogLoading = false;
}

// ── Settings modal ────────────────────────────────────────────────────────────

let _settingsSection = 'tiktok';

function openSettings(section) {
  const _OLD_TO_NEW = { cookies: 'tiktok', loops: 'tiktok', backfill: 'tiktok', utils: 'tiktok', migrate: 'tiktok' };
  switchSettingsSection(_OLD_TO_NEW[section] || section || _settingsSection);
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
  ['tiktok', 'youtube', 'jobs', 'diag', 'database'].forEach(s => {
    document.getElementById(`ssec-${s}`).style.display    = s === name ? '' : 'none';
    document.getElementById(`snav-${s}`).classList.toggle('active', s === name);
  });
  if (name === 'tiktok') { loadSettings(); }
  if (name === 'jobs')   { _avifLoadStatus(); _startJobsPoll(); }
  else                   { _stopJobsPoll(); }
  if (name === 'diag')   { diagSourceChanged(); }
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
    statusEl.textContent = 'Both fields are required.';
    statusEl.style.color = 'var(--red)';
    return;
  }
  if (!confirm(`Rewrite all file paths starting with "${oldPrefix}" to "${newPrefix}"?`)) return;
  runBtn.disabled      = true;
  statusEl.textContent = 'Rewriting…';
  statusEl.style.color = 'var(--muted)';
  try {
    const { ok, data } = await apiJSON('/api/migrate', { method: 'POST', body: JSON.stringify({ old_prefix: oldPrefix, new_prefix: newPrefix }) });
    if (!ok) {
      statusEl.textContent = data.error || 'Failed.';
      statusEl.style.color = 'var(--red)';
    } else {
      statusEl.textContent = `Done. ${data.updated} record${data.updated !== 1 ? 's' : ''} updated.`;
      statusEl.style.color = 'var(--green)';
      await loadMigratePreview();
    }
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.style.color = 'var(--red)';
  } finally {
    runBtn.disabled = false;
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
        label: `Done — ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
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
        _audioWidget.update({ label: parts.join(' · ') + ` — ${data.last_run}` });
      }
    }
  }, 1000);
}

// Utilities — clear avatars

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
  ytdlp:            [{ value: "user_videos",       label: "List user videos (paste tiktok_id)" },
                     { value: "video_info",        label: "Raw video info (paste TikTok URL)" }],
  tiktokapi:        [{ value: "user_info",            label: "User profile by username (paste @username)" },
                     { value: "user_info_by_id",     label: "User profile by ID (paste tiktok_id:sec_uid)" },
                     { value: "item_list_username",  label: "item_list by username (library resolves sec_uid)" },
                     { value: "item_list_by_id",     label: "item_list by tiktok_id:sec_uid" },
                     { value: "item_list_from_db",   label: "item_list from DB (mirrors loop — paste @username)" }],
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
    'ytdlp:user_videos':           'tiktok_id (numeric)',
    'ytdlp:video_info':            'https://www.tiktok.com/@user/video/123…',
    'tiktokapi:user_info':              '@username or username',
    'tiktokapi:user_info_by_id':        'tiktok_id:sec_uid',
    'tiktokapi:item_list_username':     '@username or username',
    'tiktokapi:item_list_by_id':        'tiktok_id:sec_uid',
    'tiktokapi:item_list_from_db':      '@username (must exist in DB)',
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

  if (!inp) { outEl.textContent = 'Error: enter a URL or ID first.'; return; }

  btn.disabled  = true;
  const isItemList = action.startsWith('item_list');
  outEl.textContent = isItemList
    ? 'Running… item_list paginates with delays — allow several minutes for large accounts'
    : 'Running… (this may take up to 30 s for TikTokApi calls)';

  const { ok, data } = await apiJSON('/api/tiktok/debug/fetch', {
    method: 'POST',
    body: JSON.stringify({ source, action, input: inp }),
  });

  btn.disabled = false;
  outEl.textContent = ok ? (data.output ?? JSON.stringify(data, null, 2))
                         : (data?.output || data?.error || 'Request failed');
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


// ── Users ─────────────────────────────────────────────────────────────────────

const _SORT_DIR_LABELS = {
  username:       { asc: 'A → Z',           desc: 'Z → A'           },
  display_name:   { asc: 'A → Z',           desc: 'Z → A'           },
  follower_count: { asc: 'Low → High',      desc: 'High → Low'      },
  video_total:    { asc: 'Low → High',      desc: 'High → Low'      },
  video_deleted:  { asc: 'Low → High',      desc: 'High → Low'      },
  added_at:       { asc: 'Oldest first',    desc: 'Newest first'    },
  starred:        { asc: 'Unstarred first', desc: 'Starred first'   },
  label:          { asc: 'A → Z',           desc: 'Z → A'           },
  video_count:    { asc: 'Low → High',      desc: 'High → Low'      },
};

let _trackingView   = 'users';
let _trackingSearch = '';
function setTrackingView(view) {
  _trackingView   = view;
  _trackingSearch = '';
  const searchEl = document.getElementById('trackingSearch');
  if (searchEl) { searchEl.value = ''; searchEl.style.display = view === 'log' ? 'none' : ''; }
  document.getElementById('tvUsers').classList.toggle('active', view === 'users');
  document.getElementById('tvSounds').classList.toggle('active', view === 'sounds');
  document.getElementById('tvLog').classList.toggle('active', view === 'log');
  document.getElementById('usersGrid').style.display  = view === 'users'  ? '' : 'none';
  document.getElementById('soundsGrid').style.display = view === 'sounds' ? '' : 'none';
  document.getElementById('logPanel').style.display   = view === 'log'    ? '' : 'none';
  document.getElementById('userControls').style.display    = view === 'users' ? '' : 'none';
  document.getElementById('soundControls').style.display   = view === 'sounds' ? 'flex' : 'none';
  renderUsers();
  renderSounds();
  _placeGlider(document.getElementById('tvUsers').closest('.filter-pills'));
  const activeControls = document.getElementById(view === 'sounds' ? 'soundControls' : 'userControls');
  activeControls.querySelectorAll('.filter-pills').forEach(_placeGlider);
}

function onTrackingSearch(val) {
  _trackingSearch = val.trim();
  if (_trackingView === 'users')  renderUsers();
  if (_trackingView === 'sounds') renderSounds();
}

function setUserFilter(group, value) {
  userFilter[group] = value;
  const map = group === 'priv' ? USER_PRIV_IDS : group === 'stat' ? USER_STAT_IDS : USER_STAR_IDS;
  Object.entries(map).forEach(([v, id]) => {
    document.getElementById(id)?.classList.toggle('active', v === value);
  });
  renderUsers();
  const anchorId = group === 'priv' ? 'ufPrivAll' : group === 'stat' ? 'ufStatAll' : 'ufStarAll';
  _placeGlider(document.getElementById(anchorId).closest('.filter-pills'));
}

function setUserSortField(field) {
  userSort.field = field;
  userSort.dir   = (field === 'username' || field === 'display_name') ? 'asc' : 'desc';
  _updateSortBtn('userSortDirBtn', userSort);
  renderUsers();
}

function resetUserFilters() {
  userSort   = { field: 'username', dir: 'asc' };
  userFilter = { priv: 'all', stat: 'all', star: 'all' };
  _trackingSearch = '';
  const searchEl = document.getElementById('trackingSearch');
  if (searchEl) searchEl.value = '';
  const sel = document.getElementById('userSortField');
  if (sel) sel.value = 'username';
  _updateSortBtn('userSortDirBtn', userSort);
  Object.entries(USER_PRIV_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  Object.entries(USER_STAT_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  Object.entries(USER_STAR_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  renderUsers();
  _placeGlider(document.getElementById('ufPrivAll').closest('.filter-pills'));
  _placeGlider(document.getElementById('ufStatAll').closest('.filter-pills'));
  _placeGlider(document.getElementById('ufStarAll').closest('.filter-pills'));
}

function toggleUserSortDir() {
  userSort.dir = userSort.dir === 'asc' ? 'desc' : 'asc';
  _updateSortBtn('userSortDirBtn', userSort);
  renderUsers();
}

function _updateSortBtn(btnId, sortState) {
  const btn = document.getElementById(btnId);
  if (btn) btn.textContent = _SORT_DIR_LABELS[sortState.field]?.[sortState.dir] ?? sortState.dir;
}

function _filteredUsers() {
  const q = _trackingSearch.toLowerCase();
  return users.filter(u => {
    if (userFilter.priv === 'public'   && (u.privacy_status !== 'public' || u.account_status === 'banned')) return false;
    if (userFilter.priv === 'private'  && (!['private_accessible','private_blocked'].includes(u.privacy_status) || u.account_status === 'banned')) return false;
    if (userFilter.priv === 'banned'   && u.account_status !== 'banned') return false;
    if (userFilter.stat === 'active'   && u.tracking_enabled === 0) return false;
    if (userFilter.stat === 'inactive' && u.tracking_enabled !== 0) return false;
    if (userFilter.star === 'starred'  && !u.starred) return false;
    if (q) {
      const hay = [u.username, u.display_name, u.tiktok_id,
                   ...(u.old_usernames || []), ...(u.old_display_names || []), ...(u.old_bios || [])]
                  .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function _sortedUsers() {
  const { field, dir } = userSort;
  return _filteredUsers().sort((a, b) => {
    const av = field === 'display_name' ? (a.display_name || a.username) : (a[field] ?? (field === 'username' ? '' : 0));
    const bv = field === 'display_name' ? (b.display_name || b.username) : (b[field] ?? (field === 'username' ? '' : 0));
    return _cmp(av, bv, dir);
  });
}

const _GHOST_CARD = '<div class="user-card" aria-hidden="true" style="visibility:hidden;pointer-events:none;min-height:220px"></div>';
function _ghostCards(n) { return n > 0 ? Array(n).fill(_GHOST_CARD).join('') : ''; }

function renderUsers() {
  const grid     = document.getElementById('usersGrid');
  const filtered = _filteredUsers();
  const isFiltered = userFilter.priv !== 'all' || userFilter.stat !== 'all' || userFilter.star !== 'all' || !!_trackingSearch;
  document.getElementById('userCount').textContent =
    isFiltered ? `${filtered.length} of ${users.length}` : users.length;
  const _tvPills = document.getElementById('tvUsers')?.closest('.filter-pills');
  if (_tvPills) _placeGlider(_tvPills);

  if (!users.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No users tracked yet.</div>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No users match this filter.</div>' + _ghostCards(Math.min(users.length, 9));
    return;
  }

  const _sorted = _sortedUsers();
  grid.innerHTML = _sorted.map(u => {
    const isCurrent  = u.username === currentUser;
    const isInactive = u.tracking_enabled === 0;
    const isBanned   = u.account_status === 'banned';

    const { cls: trackingCls, label: trackingLabel } = _trackingBadge(u.tracking_enabled);
    const accountBadge = u.account_status === 'banned'
      ? `<span class="privacy-status banned">Banned</span>`
      : (PRIVACY_MAP[u.privacy_status]
          ? `<span class="privacy-status ${PRIVACY_MAP[u.privacy_status][0]}">${PRIVACY_MAP[u.privacy_status][1]}</span>`
          : '');
    const checked = _fmtLastChecked(u.last_checked);

    const oldNames   = (u.old_usernames || []).map(n => `@${esc(n)}`).join(' · ');
    const oldNameTag = oldNames ? ` <span class="user-old-names">· ${oldNames}</span>` : '';
    const idLine     = `id:${esc(u.tiktok_id)}`;

    const inRunQueue   = runQueue.includes(u.tiktok_id);
    const isRunCurrent = runCurrent === u.tiktok_id;
    const runLabel     = isRunCurrent ? 'Running…' : inRunQueue ? 'Queued' : 'Run';
    const runDisabled  = (inRunQueue || isRunCurrent) ? 'disabled' : '';

    return `
      <div class="user-card${isCurrent ? ' user-card-current' : ''}${isInactive || isBanned ? ' user-card-inactive' : ''}${isBanned ? ' user-card-banned' : ''}" data-userid="${esc(u.tiktok_id)}" onclick="if(!event.target.closest('button'))openUserModal('${esc(u.tiktok_id)}')" role="button" tabindex="0">
        <div class="user-card-top">
          <div class="avatar-wrap">
            <span class="avatar-letter">${esc((u.username||'?')[0])}</span>
            ${u.avatar_cached ? `<img class="user-avatar" src="/api/tiktok/users/${esc(u.tiktok_id)}/avatar" alt=""
                 onerror="this.style.display='none'"
                 onclick="event.stopPropagation();openImgModalUrl('/api/tiktok/users/${esc(u.tiktok_id)}/avatar')">` : ''}
          </div>
          <div class="user-identity">
            <div class="user-display-name">${esc(u.display_name || u.username)}</div>
            <div class="user-handle">@${esc(u.username)}${oldNameTag}</div>
            <div class="user-id-line">${idLine}</div>
          </div>
          <div class="user-badges">
            <span class="account-status ${trackingCls}">${trackingLabel}</span>
            ${accountBadge}
          </div>
        </div>

        <div class="user-bio-area">
          ${u.bio ? `<div class="user-bio">${esc(u.bio)}</div>` : ''}
        </div>

        <div class="user-stats">
          <span class="stat-item"><span class="stat-item-label">followers</span><span class="stat-item-value">${(u.follower_count||0).toLocaleString()}</span></span>
          <span class="stat-item"><span class="stat-item-label">saved</span><span class="stat-item-value">${u.video_total||0}</span></span>
          ${u.video_deleted   ? `<span class="stat-item"><span class="stat-item-label">deleted</span><span class="stat-item-value" style="color:var(--red)">${u.video_deleted}</span></span>` : ''}
          ${u.video_missing   ? `<span class="stat-item"><span class="stat-item-label">missing</span><span class="stat-item-value" style="color:#ff9800">${u.video_missing}</span></span>` : ''}
          ${u.video_undeleted ? `<span class="stat-item"><span class="stat-item-label">restored</span><span class="stat-item-value" style="color:var(--yellow)">${u.video_undeleted}</span></span>` : ''}
        </div>

        <div class="user-card-footer">
          <span class="user-checked">${checked}</span>
          <div style="display:flex;gap:6px;">
            <button class="btn-star${u.starred ? ' starred' : ''}" onclick="event.stopPropagation();toggleUserStar('${esc(u.tiktok_id)}')" title="${u.starred ? 'Unstar' : 'Star'}">${u.starred ? '★' : '☆'}</button>
            <button class="btn-run" ${runDisabled} onclick="event.stopPropagation();runUser('${esc(u.tiktok_id)}')">${runLabel}</button>
            <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>runUserProfile('${esc(u.tiktok_id)}')},{label:'Remove',danger:true,onclick:()=>removeUser('${esc(u.tiktok_id)}','@${esc(u.username)}')}])">•••</button>
          </div>
        </div>
      </div>
    `;
  }).join('') + _ghostCards(Math.max(0, Math.min(users.length, 9) - _sorted.length));
}

function renderPending() {
  const container = document.getElementById('pendingList');
  const entries   = Object.entries(pending).filter(([u]) => !dismissed.has(u));
  if (!entries.length) { container.innerHTML = ''; return; }
  container.innerHTML = entries.map(([uname, info]) => {
    if (info.status === 'pending') {
      return `<div class="pending-item"><span class="spinner"></span>Looking up @${esc(uname)}…</div>`;
    }
    return `<div class="pending-item error">Failed to add @${esc(uname)}: ${esc(info.message)} <button onclick="dismissPending('${esc(uname)}')" title="Dismiss">×</button></div>`;
  }).join('');
}

async function dismissPending(username) {
  await apiJSON(`/api/tiktok/queue/${encodeURIComponent(username)}`, { method: 'DELETE' });
  delete pending[username];
  renderPending();
}

async function loadQueue() {
  const { ok, data } = await apiJSON('/api/tiktok/queue');
  if (!ok) return;
  // Remove entries that are no longer in server pending (successfully added)
  let anyResolved = false;
  for (const u of Object.keys(pending)) {
    if (!(u in data) && !dismissed.has(u)) {
      delete pending[u];
      anyResolved = true;
    }
  }
  // Merge in current server state
  for (const [u, info] of Object.entries(data)) {
    if (!dismissed.has(u)) pending[u] = info;
  }
  renderPending();
  // A pending lookup just completed; refresh the user list immediately
  // rather than waiting for the next 15-second interval.
  if (anyResolved) loadUsers();
}

// Sanitise contenteditable input: strip invalid chars, keep cursor at end
function _sanitiseHandle(el) {
  const clean = el.textContent.replace(/[^a-zA-Z0-9_.@]/g, '');
  if (el.textContent !== clean) {
    el.textContent = clean;
    // move cursor to end
    const range = document.createRange();
    const sel   = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

document.getElementById('handleInput').addEventListener('input', function() {
  _sanitiseHandle(this);
});

document.getElementById('handleInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addUser(); }
});

// Prevent paste from bringing in rich text
document.getElementById('handleInput').addEventListener('paste', function(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

// Mobile smart add bar
document.getElementById('mobileAddInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); mobileAddSubmit(); }
});

function _isSoundInput(val) {
  if (/\/music\/|\/sound\//.test(val)) return true;
  if (/^\d+$/.test(val.trim())) return true;
  return false;
}

async function mobileAddPaste() {
  const input = document.getElementById('mobileAddInput');
  try {
    const text = await navigator.clipboard.readText();
    input.value = text.trim();
    input.focus();
  } catch {
    input.focus();
  }
}

async function mobileAddSubmit() {
  const input    = document.getElementById('mobileAddInput');
  const statusEl = document.getElementById('mobileAddStatus');
  const val = input.value.trim();
  if (!val) return;

  statusEl.textContent = 'Adding...';
  statusEl.className = 'mobile-add-status';

  if (_isSoundInput(val)) {
    const { ok, data } = await apiJSON('/api/tiktok/sounds', {
      method: 'POST',
      body: JSON.stringify({ sound_id: val, label: null }),
    });
    if (ok) {
      input.value = '';
      statusEl.className = 'mobile-add-status ok';
      statusEl.textContent = `Sound ${data.sound_id} added.`;
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'mobile-add-status'; }, 5000);
      loadSounds();
    } else {
      statusEl.className = 'mobile-add-status error';
      statusEl.textContent = data.error || 'Failed.';
    }
  } else {
    const name = val.replace(/^@/, '').replace(/[^a-zA-Z0-9_.]/g, '');
    if (!name) {
      statusEl.className = 'mobile-add-status error';
      statusEl.textContent = 'Invalid username.';
      input.focus();
      return;
    }
    const { ok, data } = await apiJSON('/api/tiktok/users', {
      method: 'POST',
      body: JSON.stringify({ username: name }),
    });
    if (ok) {
      input.value = '';
      dismissed.delete(name);
      pending[name] = { status: 'pending' };
      statusEl.className = 'mobile-add-status ok';
      statusEl.textContent = `@${name} queued.`;
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'mobile-add-status'; }, 5000);
      renderPending();
    } else {
      statusEl.className = 'mobile-add-status error';
      statusEl.textContent = data.error || 'Failed.';
    }
  }
  input.focus();
}

async function addUser() {
  const input = document.getElementById('handleInput');
  const name  = input.textContent.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_.]/g, '');
  if (!name) return;

  input.textContent = '';
  input.focus();

  const { ok, data } = await apiJSON('/api/tiktok/users', {
    method: 'POST',
    body: JSON.stringify({ username: name }),
  });

  if (ok) {
    dismissed.delete(name);
    pending[name] = { status: 'pending' };
  } else {
    pending[name] = { status: 'error', message: data.error || 'Request failed' };
  }
  renderPending();
}

async function runUser(id)             { return _creatorRun('/api/tiktok/users', id, () => runQueue, q => { runQueue = q; }, renderUsers); }
async function runUserProfile(id)      { return _creatorRunProfile('/api/tiktok/users', id, () => runQueue, q => { runQueue = q; }, renderUsers); }
async function removeUser(id, label)   { return _creatorRemove('/api/tiktok/users', id, label, loadUsers); }
async function toggleUserStar(id)      { return _creatorToggleStar('/api/tiktok/users', id, users, 'tiktok_id', renderUsers); }

async function loadUsers() {
  const { ok, data } = await apiJSON('/api/tiktok/users');
  if (ok) { users = data; renderUsers(); }
}

// ── Sounds ────────────────────────────────────────────────────────────────────

let sounds        = [];
let soundRunCurrent = null;
let soundRunQueue   = [];
let soundFilter   = { stat: 'all', star: 'all' };
let soundSort     = { field: 'label', dir: 'asc' };

function setSoundFilter(group, value) {
  soundFilter[group] = value;
  const map = group === 'stat' ? SOUND_STAT_IDS : SOUND_STAR_IDS;
  Object.entries(map).forEach(([v, id]) => {
    document.getElementById(id)?.classList.toggle('active', v === value);
  });
  renderSounds();
  const anchorId = group === 'stat' ? 'sfStatAll' : 'sfStarAll';
  _placeGlider(document.getElementById(anchorId).closest('.filter-pills'));
}

function setSoundSortField(field) {
  soundSort.field = field;
  soundSort.dir   = (field === 'label') ? 'asc' : 'desc';
  _updateSortBtn('soundSortDirBtn', soundSort);
  renderSounds();
}

function toggleSoundSortDir() {
  soundSort.dir = soundSort.dir === 'asc' ? 'desc' : 'asc';
  _updateSortBtn('soundSortDirBtn', soundSort);
  renderSounds();
}


function resetSoundFilters() {
  soundFilter = { stat: 'all', star: 'all' };
  soundSort   = { field: 'label', dir: 'asc' };
  _trackingSearch = '';
  const searchEl = document.getElementById('trackingSearch');
  if (searchEl) searchEl.value = '';
  const sel = document.getElementById('soundSortField');
  if (sel) sel.value = 'label';
  _updateSortBtn('soundSortDirBtn', soundSort);
  Object.entries(SOUND_STAT_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  Object.entries(SOUND_STAR_IDS).forEach(([v, id]) => document.getElementById(id)?.classList.toggle('active', v === 'all'));
  renderSounds();
  _placeGlider(document.getElementById('sfStatAll').closest('.filter-pills'));
  _placeGlider(document.getElementById('sfStarAll').closest('.filter-pills'));
}

function renderSounds() {
  const grid    = document.getElementById('soundsGrid');
  const countEl = document.getElementById('soundCount');
  const q = _trackingSearch.toLowerCase();
  let filtered = sounds;
  if (soundFilter.stat === 'active')   filtered = filtered.filter(s => s.tracking_enabled !== 0);
  if (soundFilter.stat === 'inactive') filtered = filtered.filter(s => s.tracking_enabled === 0);
  if (soundFilter.star === 'starred')  filtered = filtered.filter(s => s.starred);
  if (q) filtered = filtered.filter(s => `${s.label || ''} ${s.sound_id}`.toLowerCase().includes(q));
  const isFiltered = soundFilter.stat !== 'all' || soundFilter.star !== 'all' || !!_trackingSearch;
  countEl.textContent = isFiltered ? `${filtered.length} of ${sounds.length}` : sounds.length;
  const { field, dir } = soundSort;
  filtered = [...filtered].sort((a, b) => {
    const av = field === 'label' ? (a.label || a.sound_id) : (a[field] ?? 0);
    const bv = field === 'label' ? (b.label || b.sound_id) : (b[field] ?? 0);
    return _cmp(av, bv, dir);
  });
  const _tvPills = document.getElementById('tvUsers')?.closest('.filter-pills');
  if (_tvPills) _placeGlider(_tvPills);
  if (!sounds.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No sounds tracked yet.</div>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No sounds match this search.</div>' + _ghostCards(Math.min(sounds.length, 9));
    return;
  }
  grid.innerHTML = filtered.map(s => {
    const label      = s.label || s.sound_id;
    const ttUrl      = `https://www.tiktok.com/music/-${s.sound_id}`;
    const checked    = _fmtLastChecked(s.last_checked);
    const inQueue      = soundRunQueue.includes(s.sound_id);
    const isCurrent    = soundRunCurrent === s.sound_id;
    const runLabel     = isCurrent ? 'Running…' : inQueue ? 'Queued' : 'Run';
    const runDis       = (inQueue || isCurrent) ? 'disabled' : '';
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
          <span class="user-checked">${checked}</span>
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
  }).join('') + _ghostCards(Math.max(0, Math.min(sounds.length, 9) - filtered.length));
}

async function loadSounds() {
  const { ok, data } = await apiJSON('/api/tiktok/sounds');
  if (ok) { sounds = data; renderSounds(); }
}

async function addSound() {
  const input      = document.getElementById('soundInput');
  const labelInput = document.getElementById('soundLabelInput');
  const statusEl   = document.getElementById('soundAddStatus');
  const raw        = input.value.trim();
  const label      = labelInput.value.trim() || null;
  if (!raw) { statusEl.className = 'add-status info'; statusEl.textContent = 'Enter a sound ID or URL.'; return; }

  statusEl.className = 'add-status info'; statusEl.textContent = 'Adding…';
  const { ok, data } = await apiJSON('/api/tiktok/sounds', {
    method: 'POST',
    body: JSON.stringify({ sound_id: raw, label }),
  });
  if (!ok) {
    statusEl.className = 'add-status error'; statusEl.textContent = data.error || 'Failed.';
  } else {
    input.value      = '';
    labelInput.value = '';
    statusEl.className = 'add-status ok'; statusEl.textContent = `Sound ${data.sound_id} added.`;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'add-status'; }, 5000);
    loadSounds();
  }
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

document.getElementById('soundInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') addSound();
});

// ── Modal engine ──────────────────────────────────────────────────────────────

const VCOLS = [
  { field: null,            label: '' },
  { field: null,            label: 'Description' },
  { field: 'status',        label: 'Status' },
  { field: 'view_count',    label: 'Views' },
  { field: 'upload_date',   label: 'Uploaded' },
  { field: 'download_date', label: 'Saved' },
  { field: 'deleted_at',    label: 'Deleted' },
  { field: null,            label: '' },
];
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

const _userState  = { videos:[], filter:'all', typeFilter:'all', search:'', sort:{field:'upload_date',dir:'desc'}, loaded:0, obs:null, toolbarExpanded:false, view:'list' };
const _soundState = { videos:[], filter:'all', typeFilter:'all', search:'', sort:{field:'upload_date',dir:'desc'}, loaded:0, obs:null, toolbarExpanded:false, view:'list' };

const _USER_MODAL_CFG = {
  st: _userState, listElId: 'modalVideoList', toolbarElId: 'modalToolbar',
  cols: VCOLS, colsCls: 'vcols', pageSize: 50,
  filterFn: 'setModalFilter', typeFilterFn: 'setModalTypeFilter',
  sortFn: 'setModalSort', toggleFn: 'toggleModalToolbar', searchFn: 'onModalSearch',
  authorCol: null, hasSearch: true, hasViewToggle: true, viewFn: 'setModalView',
  gridId: 'videoGrid', hasPhistBtn: true,
  thumbCellFn:  v => _thumbCell(v),
  actionBtnsFn: v => _videoActionBtns(v),
  previewFn:    'openImgModal',
  typeIconFn:   v => v.type === 'video' ? _vgridPlayIcon : v.type === 'photo' ? _vgridPhotoIcon : '',
  gridThumbSrc: v => `/api/tiktok/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => { if (v.type === 'video') openVidModal(v.video_id); else if (v.type === 'photo') openCarousel(v.video_id); },
};
const _SOUND_MODAL_CFG = {
  st: _soundState, listElId: 'soundModalVideoList', toolbarElId: 'soundModalToolbar',
  cols: SOUND_VCOLS, colsCls: 'sound-vcols', pageSize: 50,
  filterFn: 'setSoundModalFilter', typeFilterFn: 'setSoundModalTypeFilter',
  sortFn: 'setSoundModalSort', toggleFn: 'toggleSoundModalToolbar', searchFn: 'onSoundModalSearch',
  authorCol: v => {
    const name = v.author_username || v.tiktok_id || '?';
    return v.author_enabled === 1
      ? `<span class="author-chip" onclick="event.stopPropagation();closeSoundModal();openUserModal('${esc(v.tiktok_id)}')">@${esc(name)}</span>`
      : `<span class="author-chip untracked">@${esc(name)}</span>`;
  },
  hasSearch: true, hasViewToggle: true, viewFn: 'setSoundModalView',
  gridId: 'soundVideoGrid', hasPhistBtn: false,
  thumbCellFn:  v => _thumbCell(v),
  actionBtnsFn: v => _videoActionBtns(v),
  previewFn:    'openImgModal',
  typeIconFn:   v => v.type === 'video' ? _vgridPlayIcon : v.type === 'photo' ? _vgridPhotoIcon : '',
  gridThumbSrc: v => `/api/tiktok/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => { if (v.type === 'video') openVidModal(v.video_id); else if (v.type === 'photo') openCarousel(v.video_id); },
};


// ── Sound modal ────────────────────────────────────────────────────────────────

let _soundModalId               = null;
let _soundModal                 = null;
let _soundModalPendingHighlight = null; // { videoId, filter? }

function openSoundModal(soundId) {
  const s = sounds.find(s => s.sound_id === soundId);
  if (!s) return;
  _soundModalId = soundId;
  _soundModal   = s;
  Object.assign(_soundState, {
    videos: [], filter: 'all', typeFilter: 'all', search: '',
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
  _soundModalPendingHighlight = { videoId, filter: filter || null };
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

async function _loadSoundModalVideos(soundId) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/videos`);
  if (!ok || _soundModalId !== soundId) return;
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

// ── Loop ──────────────────────────────────────────────────────────────────────

// Cached element refs for renderStatus — queried once, reused every 5 s
const _sEl = {
  badge:      document.getElementById('statusBadge'),
  text:       document.getElementById('statusText'),
  uLast:      document.getElementById('userLoopLast'),
  uNext:      document.getElementById('userLoopNext'),
  uBtn:       document.getElementById('triggerUserBtn'),
  uDur:       document.getElementById('userLoopDuration'),
  uNewVids:   document.getElementById('userLoopNewVideos'),
  sLast:      document.getElementById('soundLoopLast'),
  sDur:       document.getElementById('soundLoopDuration'),
  sNext:      document.getElementById('soundLoopNext'),
  sBtn:       document.getElementById('triggerSoundBtn'),
  sNewVids:   document.getElementById('soundLoopNewVideos'),
  missing:    document.getElementById('missingStatsCount'),
  failed:     document.getElementById('statsFailedCount'),
  retryBtn:   document.getElementById('retryFailedBtn'),
  bfPill:     document.getElementById('hdrBackfillPill'),
  bfCount:    document.getElementById('hdrBackfillCount'),
};

function renderStatus(state) {
  isRunning   = state.user_loop_running;
  currentUser = state.user_loop_current_user;
  if (state.deletion_confirm_threshold != null) _deletionConfirmThreshold = state.deletion_confirm_threshold;
  runQueue         = state.run_queue         || [];
  runCurrent       = state.run_current       || null;
  soundRunQueue    = state.sound_run_queue   || [];
  soundRunCurrent  = state.sound_run_current || null;

  const anyActive = isRunning || state.sound_loop_running || !!runCurrent || !!soundRunCurrent;
  _sEl.badge.className  = `status-badge${anyActive ? ' running' : ''}`;
  _sEl.text.textContent = anyActive
    ? (currentUser ? `Downloading @${currentUser}` : 'Running…')
    : 'Idle';

  // User loop card
  if (_sEl.uLast)    _sEl.uLast.textContent    = state.user_loop_last_end ? `Last: ${fmt.rel(state.user_loop_last_end)}` : 'Never run';
  if (_sEl.uDur)     _sEl.uDur.textContent     = state.user_loop_last_duration_secs != null ? fmt.dur(state.user_loop_last_duration_secs) : '';
  if (_sEl.uNewVids) _sEl.uNewVids.textContent = state.user_loop_last_new_videos    != null ? `${state.user_loop_last_new_videos} new` : '';
  if (_sEl.uNext)    _sEl.uNext.textContent    = state.user_loop_running
    ? 'Running…'
    : (state.user_loop_next ? `Next: ${fmt.relFuture(state.user_loop_next)}` : '');
  if (_sEl.uBtn) _sEl.uBtn.disabled = state.user_loop_running;

  // Sound loop card
  if (_sEl.sLast)    _sEl.sLast.textContent    = state.sound_loop_last_end ? `Last: ${fmt.rel(state.sound_loop_last_end)}` : 'Never run';
  if (_sEl.sDur)     _sEl.sDur.textContent     = state.sound_loop_last_duration_secs != null ? fmt.dur(state.sound_loop_last_duration_secs) : '';
  if (_sEl.sNewVids) _sEl.sNewVids.textContent = state.sound_loop_last_new_videos    != null ? `${state.sound_loop_last_new_videos} new` : '';
  if (_sEl.sNext)    _sEl.sNext.textContent    = state.sound_loop_running
    ? 'Running…'
    : (state.sound_loop_next ? `Next: ${fmt.relFuture(state.sound_loop_next)}` : '');
  if (_sEl.sBtn) _sEl.sBtn.disabled = state.sound_loop_running;

  if (_sEl.missing) {
    const n = state.missing_stats_count ?? 0;
    _sEl.missing.textContent = n > 0 ? `${n.toLocaleString()} missing` : '';
  }
  if (_sEl.failed) {
    const f = state.stats_failed_count ?? 0;
    _sEl.failed.textContent   = f > 0 ? `${f.toLocaleString()} unavailable` : '';
    _sEl.failed.style.display = f > 0 ? '' : 'none';
    if (_sEl.retryBtn) _sEl.retryBtn.style.display = f > 0 ? '' : 'none';
  }

  // Header backfill pill — visible only when there's work to do
  if (_sEl.bfPill && _sEl.bfCount) {
    const n = state.missing_stats_count ?? 0;
    _sEl.bfCount.textContent  = n.toLocaleString();
    _sEl.bfPill.style.display = n > 0 ? '' : 'none';
  }
}

function clearLog() {
  logClearIndex = logLines.length;
  document.getElementById('logBody').innerHTML = '';
  if (logLines.length > 0) {
    localStorage.setItem('logClearWatermark', logLines[logLines.length - 1]);
  } else {
    localStorage.removeItem('logClearWatermark');
  }
}

function renderLogs(lines) {
  if (!lines?.length) return;
  if (!_logClearRestored) {
    _logClearRestored = true;
    const mark = localStorage.getItem('logClearWatermark');
    if (mark) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i] === mark) { logClearIndex = i + 1; break; }
      }
    }
  }
  const start    = Math.max(logLines.length, logClearIndex);
  const newLines = lines.slice(start);
  logLines = lines;
  if (!newLines.length) return;

  const body       = document.getElementById('logBody');
  const autoScroll = document.getElementById('autoScroll').checked;

  newLines.forEach(line => {
    const span = document.createElement('span');
    if      (/=== .+ (started|complete)/i.test(line))                               span.className = 'log-sep';
    else if (/\] Processing @/.test(line) || /\[sound\] Processing sound/i.test(line)) span.className = 'log-user';
    else if (/error|failed|unexpected/i.test(line))                                  span.className = 'log-err';
    else if (/warn|deleted|corrupt/i.test(line))                                     span.className = 'log-warn';
    else if (/download|saved/i.test(line))                                           span.className = 'log-dl';
    else if (/Profile change:|avatar changed|\[sound\] Discovered/i.test(line))      span.className = 'log-profile';
    span.textContent = line + '\n';
    body.appendChild(span);
  });

  if (autoScroll) body.scrollTop = body.scrollHeight;
}

async function setUserTracking(tiktokId, enabled) {
  const { ok, data } = await apiJSON(`/api/tiktok/users/${encodeURIComponent(tiktokId)}/tracking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!ok) { showToast(data.error || 'Failed to update tracking', { type: 'error' }); return; }
  const u = users.find(u => u.tiktok_id === tiktokId);
  if (u) u.tracking_enabled = enabled ? 1 : 0;
  if (_modalUser && _modalUser.tiktok_id === tiktokId) {
    _modalUser.tracking_enabled = enabled ? 1 : 0;
    _renderModalHeader(_modalUser);
  }
  renderUsers();
}

async function saveUserComment(id, value) {
  const ok = await _saveCreatorComment('/api/tiktok/users', id, value, users, 'tiktok_id');
  if (ok && _modalUser && _modalUser.tiktok_id === id) _modalUser.comment = value.trim() || null;
}

async function saveSoundComment(id, value) {
  const ok = await _saveCreatorComment('/api/tiktok/sounds', id, value, sounds, 'sound_id');
  if (ok && _soundModal && _soundModal.sound_id === id) _soundModal.comment = value.trim() || null;
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

function triggerUserLoop()  { return _triggerLoop('triggerUserBtn',  '/api/tiktok/trigger',        'Could not trigger user loop'); }
function triggerSoundLoop() { return _triggerLoop('triggerSoundBtn', '/api/tiktok/trigger/sounds', 'Could not trigger sound loop'); }

async function loadSettings() {
  const { ok, data } = await apiJSON('/api/tiktok/settings');
  if (!ok) return;
  const uEl = document.getElementById('userLoopIntervalInput');
  const sEl = document.getElementById('soundLoopIntervalInput');
  if (uEl) uEl.value = data.user_loop_interval_minutes;
  if (sEl) sEl.value = data.sound_loop_interval_minutes;
}

async function saveLoopSettings() {
  const uVal = parseInt(document.getElementById('userLoopIntervalInput')?.value, 10);
  const sVal = parseInt(document.getElementById('soundLoopIntervalInput')?.value, 10);
  if (!uVal || !sVal || uVal < 1 || sVal < 1) {
    showToast('Intervals must be positive integers.', { type: 'warning', duration: 4000 });
    return;
  }
  const { ok, data } = await apiJSON('/api/tiktok/settings', {
    method: 'PATCH',
    body: JSON.stringify({ user_loop_interval_minutes: uVal, sound_loop_interval_minutes: sVal }),
  });
  if (!ok) { showToast(data.error || 'Could not save settings', { type: 'error' }); return; }
  showToast('Settings saved.', { type: 'success', duration: 2500 });
}

function updateRunStates() {
  // Patch only the dynamic run-state parts of existing cards without rebuilding DOM.
  document.querySelectorAll('.user-card[data-userid]').forEach(card => {
    const id      = card.dataset.userid;
    const inQueue = runQueue.includes(id);
    const isCur   = runCurrent === id;
    const uObj    = users.find(u => u.tiktok_id === id);
    card.classList.toggle('user-card-current', !!(uObj && uObj.username === currentUser));
    const btn = card.querySelector('.btn-run');
    if (!btn) return;
    btn.textContent = isCur ? 'Running…' : inQueue ? 'Queued' : 'Run';
    btn.disabled    = inQueue || isCur;
  });
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

async function loadStatus() {
  const { ok, data } = await apiJSON('/api/tiktok/status');
  if (ok) {
    renderStatus(data);
    renderLogs(data.logs);
    updateRunStates();
  }
}

// ── User detail modal ─────────────────────────────────────────────────────────

let _modalUserId           = null;
let _modalUser             = null;   // full user object for the open modal
let _modalPendingHighlight = null;   // { videoId, filter, sortField, sortDir } or null

function openUserModal(tiktokId) {
  const u = users.find(u => u.tiktok_id === tiktokId);
  if (!u) return;
  _modalUserId = tiktokId;
  _modalUser   = u;
  Object.assign(_userState, {
    videos: [], filter: 'all', typeFilter: 'all', search: '',
    sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, toolbarExpanded: false,
    view: window.innerWidth <= 640 ? 'grid' : 'list',
  });
  if (_userState.obs) { _userState.obs.disconnect(); _userState.obs = null; }

  // Reset history panel state
  _phistData   = [];
  _phistField  = 'all';
  _phistUserId = null;
  document.getElementById('phistPanel').style.display     = 'none';
  document.getElementById('modalVideoList').style.display = '';

  document.getElementById('modalBackdrop').style.display = 'flex';
  _lockScroll();

  _renderModalHeader(u);
  _mRenderToolbar(_USER_MODAL_CFG, []);
  document.getElementById('modalVideoList').innerHTML =
    '<div class="vlist-loading">Loading videos…</div>';

  _loadModalVideos(tiktokId);
}

function openUserModalAndHighlight(tiktokId, videoId, filter, sortField, sortDir) {
  _modalPendingHighlight = {
    videoId,
    filter:    filter    || 'deleted',
    sortField: sortField || 'deleted_at',
    sortDir:   sortDir   || 'desc',
  };
  openUserModal(tiktokId);
}

function openUserModalWithHistory(tiktokId, field) {
  openUserModal(tiktokId);
  openProfileHistory(field);
}

function closeModal() {
  document.getElementById('modalBackdrop').style.display = 'none';
  _unlockScroll();
  if (_userState.obs) { _userState.obs.disconnect(); _userState.obs = null; }
  _modalUserId       = null;
  _modalUser         = null;
  _userState.videos  = [];
}

function handleBackdropClick(e) {
  if (e.target === e.currentTarget) closeModal();
}

document.addEventListener('keydown', e => {
  if (document.getElementById('carouselModal').style.display !== 'none') {
    if (e.key === 'ArrowLeft')  { carouselStep(-1); return; }
    if (e.key === 'ArrowRight') { carouselStep(1);  return; }
    if (e.key === 'Escape')     { closeCarousel();  return; }
    return;
  }
  if (e.key !== 'Escape') return;
  if (document.getElementById('imgModal').style.display !== 'none') {
    closeImgModal(); return;
  }
  if (document.getElementById('vidModal').style.display !== 'none') {
    closeVidModal(); return;
  }
  if (document.getElementById('soundModalBackdrop').style.display !== 'none') {
    closeSoundModal(); return;
  }
  if (document.getElementById('modalBackdrop').style.display !== 'none') {
    closeModal(); return;
  }
  if (document.getElementById('recentLogBackdrop').style.display !== 'none') {
    closeRecentLog(); return;
  }
  if (document.getElementById('settingsBackdrop').style.display !== 'none') {
    closeSettings();
  }
});

// ── Image preview modal ───────────────────────────────────────────────────

function openImgModal(videoId) {
  openImgModalUrl(`/api/tiktok/videos/${encodeURIComponent(videoId)}/thumbnail`);
}

// ── Video player modal ────────────────────────────────────────────────────

function openVidModal(videoId) {
  const vid = document.getElementById('vidModalPlayer');
  vid.src = `/api/tiktok/videos/${encodeURIComponent(videoId)}/file`;
  document.getElementById('vidModal').style.display = 'flex';
  _lockScroll();
  vid.play().catch(() => {});
}

function closeVidModal() {
  const vid = document.getElementById('vidModalPlayer');
  vid.pause();
  vid.src = '';
  document.getElementById('vidModal').style.display = 'none';
  _unlockScroll();
}

// ── Photo carousel modal ──────────────────────────────────────────────────

let _carouselUrls = [];
let _carouselIdx  = 0;

async function openCarousel(videoId) {
  const { ok, data } = await apiJSON(`/api/tiktok/videos/${encodeURIComponent(videoId)}/photos`);
  if (!ok || !data.urls || !data.urls.length) return;
  _carouselUrls = data.urls;
  _showCarouselSlide(0);
  document.getElementById('carouselModal').style.display = 'flex';
  _lockScroll();
}

function _showCarouselSlide(idx) {
  _carouselIdx = idx;
  document.getElementById('carouselImg').src = _carouselUrls[idx];
  document.getElementById('carouselCounter').textContent =
    _carouselUrls.length > 1 ? `${idx + 1} / ${_carouselUrls.length}` : '';
  document.getElementById('carouselPrev').disabled = idx === 0;
  document.getElementById('carouselNext').disabled = idx === _carouselUrls.length - 1;
}

function carouselStep(dir) {
  const next = _carouselIdx + dir;
  if (next < 0 || next >= _carouselUrls.length) return;
  _showCarouselSlide(next);
}

function closeCarousel() {
  document.getElementById('carouselModal').style.display = 'none';
  document.getElementById('carouselImg').src = '';
  _carouselUrls = [];
  _carouselIdx  = 0;
  _unlockScroll();
}

async function _loadModalVideos(tiktokId) {
  const { ok, data } = await apiJSON(`/api/tiktok/users/${tiktokId}/videos`);
  if (!ok || _modalUserId !== tiktokId) return;
  _userState.videos = data;

  if (_modalPendingHighlight) {
    const { videoId, filter, sortField, sortDir } = _modalPendingHighlight;
    _modalPendingHighlight   = null;
    _userState.view          = 'list';
    _userState.filter        = filter;
    _userState.typeFilter    = 'all';
    _userState.sort          = { field: sortField, dir: sortDir };
    _mRenderColHdrs(_USER_MODAL_CFG);
    _mRenderToolbar(_USER_MODAL_CFG, data);
    _mRenderList(_USER_MODAL_CFG);
    const row = document.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('video-row-highlight');
      row.addEventListener('mouseenter', () => row.classList.remove('video-row-highlight'), { once: true });
    }
  } else {
    // Don't overwrite the toolbar/list if profile history is already open
    const historyOpen = document.getElementById('phistPanel').style.display !== 'none';
    if (!historyOpen) {
      _mRenderToolbar(_USER_MODAL_CFG, data);
      _mRenderList(_USER_MODAL_CFG);
    }
  }
}

function setModalFilter(f)       { _mSetFilter(_USER_MODAL_CFG, f); }
function setModalTypeFilter(t)   { _mSetTypeFilter(_USER_MODAL_CFG, t); }
function toggleModalToolbar()    { _mToggleToolbar(_USER_MODAL_CFG); }
function setModalSort(f)         { _mSetSort(_USER_MODAL_CFG, f); }
function onModalSearch(val) {
  _userState.search = val.trim();
  _mRenderToolbar(_USER_MODAL_CFG, _userState.videos);
  _mRenderList(_USER_MODAL_CFG);
}
function onSoundModalSearch(val) {
  _soundState.search = val.trim();
  _mRenderToolbar(_SOUND_MODAL_CFG, _soundState.videos);
  _mRenderList(_SOUND_MODAL_CFG);
}

function _renderModalHeader(u) {
  const oldNames = (u.old_usernames || []).map(n => `@${esc(n)}`).join(' · ');

  const isInactive = u.tracking_enabled === 0;
  const { cls: trackingCls, label: trackingLbl } = _trackingBadge(u.tracking_enabled);
  const accountBadge = u.account_status === 'banned'
    ? `<span class="privacy-status banned">Banned</span>`
    : (PRIVACY_MAP[u.privacy_status]
        ? `<span class="privacy-status ${PRIVACY_MAP[u.privacy_status][0]}">${PRIVACY_MAP[u.privacy_status][1]}</span>`
        : '');

  const joinStr = u.join_date
    ? ' · Joined ' + _dtFmtMonthYear.format(new Date(u.join_date * 1000))
    : '';

  const banCountdownStr = (() => {
    if (u.account_status !== 'banned' || !u.banned_at || u.tracking_enabled === 0) return '';
    const daysElapsed = Math.floor((Date.now() / 1000 - u.banned_at) / 86400);
    const daysLeft    = 14 - daysElapsed;
    if (daysLeft <= 0) return '';
    return `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} until inactive`;
  })();

  document.getElementById('modalHeader').innerHTML = `
    <div class="modal-avatar-wrap">
      <span class="avatar-letter">${esc((u.username||'?')[0])}</span>
      ${u.avatar_cached ? `<img class="modal-avatar" src="/api/tiktok/users/${esc(u.tiktok_id)}/avatar" alt=""
           onerror="this.style.display='none'"
           onclick="openImgModalUrl('/api/tiktok/users/${esc(u.tiktok_id)}/avatar')">` : ''}
    </div>
    <div class="modal-name-row">
      <span class="modal-name">${esc(u.display_name || u.username)}</span>
      ${u.verified ? '<span class="modal-verified">✓ Verified</span>' : ''}
      <span class="account-status ${trackingCls}">${trackingLbl}</span>
      ${accountBadge}
      <label class="tracking-toggle" title="${isInactive ? 'Video tracking off (profile changes still tracked)' : 'Video tracking on'}">
        <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="setUserTracking('${esc(u.tiktok_id)}', this.checked)">
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
        <span class="toggle-label">Track videos</span>
      </label>
    </div>
    <div class="modal-user-meta">
      <div class="modal-handle">
        @${esc(u.username)}
        ${oldNames ? `<span class="user-old-names">· ${oldNames}</span>` : ''}
      </div>
      <div class="modal-id-line">id:${esc(u.tiktok_id)}${joinStr}</div>
      ${banCountdownStr ? `<div class="modal-ban-countdown">${banCountdownStr}</div>` : ''}
      ${u.bio ? `<div class="modal-bio" onclick="this.classList.toggle('expanded')">${esc(u.bio)}</div>` : ''}
      <div class="modal-stats-row">
        <span><strong>${(u.follower_count || 0).toLocaleString()}</strong> followers</span>
        ${u.following_count != null ? `<span><strong>${u.following_count.toLocaleString()}</strong> following</span>` : ''}
        ${u.video_count     != null ? `<span><strong>${u.video_count.toLocaleString()}</strong> on TikTok</span>` : ''}
        <span><strong>${u.video_total || 0}</strong> saved locally</span>
        ${u.video_deleted   ? `<span style="color:var(--red)"><strong>${u.video_deleted}</strong> deleted</span>` : ''}
        ${u.video_missing   ? `<span style="color:#ff9800"><strong>${u.video_missing}</strong> missing</span>` : ''}
        ${u.video_undeleted ? `<span style="color:var(--yellow)"><strong>${u.video_undeleted}</strong> restored</span>` : ''}
        ${u.profile_history_count ? `<span style="cursor:pointer;text-decoration:underline dotted" onclick="openProfileHistory()" title="Open profile change history"><strong>${u.profile_history_count}</strong> profile ${u.profile_history_count === 1 ? 'update' : 'updates'}</span>` : ''}
      </div>
      <div style="display:flex;align-items:flex-start;gap:6px;margin-top:8px">
        <textarea placeholder="Add a note about this user…"
          onblur="saveUserComment('${esc(u.tiktok_id)}', this.value)"
          style="flex:1;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;
                 background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                 color:var(--text);font-family:inherit;line-height:1.5"
        >${esc(u.comment || '')}</textarea>
      </div>
    </div>
  `;
}

// ── Profile history ──────────────────────────────────────────────────────────

let _phistField  = 'all';
let _phistData   = [];
let _phistUserId = null;

const _PHIST_FIELD_LABELS = {
  all:            'All',
  username:       'Username',
  display_name:   'Display name',
  bio:            'Bio',
  avatar:         'Avatar',
  account_status: 'Account status',
  privacy_status: 'Privacy',
};

const _STATUS_LABELS = {
  active:              'Active',
  banned:              'Banned',
  public:              'Public',
  private_accessible:  'Private (accessible)',
  private_blocked:     'Private',
};

async function openProfileHistory(field) {
  _phistUserId = _modalUserId;
  if (!_phistUserId) return;
  if (field) _phistField = field;

  // Toggle off if already open
  if (document.getElementById('phistPanel').style.display !== 'none') {
    _closeProfileHistory();
    return;
  }

  document.getElementById('phistPanel').style.display = '';
  document.getElementById('modalVideoList').style.display = 'none';
  document.getElementById('phistPanel').innerHTML = '<div class="phist-empty">Loading…</div>';

  _renderHistoryToolbar();

  const { ok, data } = await apiJSON(`/api/tiktok/users/${encodeURIComponent(_phistUserId)}/profile-history`);
  if (!ok) {
    document.getElementById('phistPanel').innerHTML = '<div class="phist-empty">Failed to load history.</div>';
    return;
  }
  _phistData = data;
  // keep _phistField if it was pre-set by openUserModalWithHistory, otherwise default to 'all'
  if (!field) _phistField = 'all';
  _renderHistoryToolbar();
  _renderHistoryEntries();
}

function _closeProfileHistory() {
  document.getElementById('phistPanel').style.display     = 'none';
  document.getElementById('modalVideoList').style.display = '';
  if (_userState.videos.length) {
    _mRenderToolbar(_USER_MODAL_CFG, _userState.videos);
    _mRenderList(_USER_MODAL_CFG);
  }
  // If _userState.videos is still empty the load is still in flight; the
  // historyOpen guard in _loadModalVideos will now pass and render normally.
}

function setHistoryField(field) {
  _phistField = field;
  const toolbar = document.getElementById('modalToolbar');
  toolbar.querySelectorAll('[data-hist-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.histKey === field);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _renderHistoryEntries();
}

function _renderHistoryToolbar() {
  const fields = ['all', 'username', 'display_name', 'bio', 'avatar', 'account_status', 'privacy_status'];
  const pills  = fields.map(f => {
    const active = _phistField === f ? ' active' : '';
    return `<button class="filter-pill${active}" data-hist-key="${f}" onclick="setHistoryField('${f}')">${_PHIST_FIELD_LABELS[f]}</button>`;
  }).join('');
  document.getElementById('modalToolbar').innerHTML =
    `<div class="filter-pills">${pills}</div>`
    + `<button class="filter-pill" style="margin-left:auto" onclick="_closeProfileHistory()">← Videos</button>`;
  document.getElementById('modalToolbar').querySelectorAll('.filter-pills').forEach(_placeGlider);
}

function _renderHistoryEntries() {
  const panel   = document.getElementById('phistPanel');
  const entries = _phistField === 'all'
    ? _phistData
    : _phistData.filter(e => e.field === _phistField);

  if (!entries.length) {
    panel.innerHTML = '<div class="phist-empty">No history recorded for this field yet.</div>';
    return;
  }

  // Pre-compute the "new" value for each entry.
  // _phistData is newest-first. For each field, the most-recent entry's "new"
  // value is the current profile value; older entries' "new" value is the
  // old_value of the next-newer entry for that same field.
  const u = _modalUser;
  const _currentVal = {
    username:       u?.username       || null,
    display_name:   u?.display_name   || null,
    bio:            u?.bio            || null,
    avatar:         '__current__',
    account_status: u?.account_status || null,
    privacy_status: u?.privacy_status || null,
  };
  const newValMap = new Map();
  ['username', 'display_name', 'bio', 'avatar', 'account_status', 'privacy_status'].forEach(field => {
    const fe = _phistData.filter(e => e.field === field); // newest-first
    fe.forEach((e, fi) => {
      newValMap.set(e, fi === 0 ? _currentVal[field] : fe[fi - 1].old_value);
    });
  });

  const sideHdr = (side) =>
    `<div class="phist-side-hdr"><span class="phist-side-label">${side}</span></div>`;

  panel.innerHTML = entries.map(e => {
    const dateStr = _dtFmt.format(new Date(e.changed_at * 1000));
    const fieldLabel = _PHIST_FIELD_LABELS[e.field] || e.field;
    const newVal = newValMap.get(e);

    if (e.field === 'avatar') {
      const oldSrc = `/api/tiktok/users/${encodeURIComponent(_phistUserId)}/avatar-history/${encodeURIComponent(e.old_value)}`;
      const newSrc = newVal === '__current__'
        ? `/api/tiktok/users/${encodeURIComponent(_phistUserId)}/avatar?t=${e.changed_at}`
        : `/api/tiktok/users/${encodeURIComponent(_phistUserId)}/avatar-history/${encodeURIComponent(newVal)}`;
      const img = (src, label) =>
        `<div class="phist-avatar-col">
          <span class="phist-side-label">${label}</span>
          <img class="phist-avatar-lg" src="${src}" alt="${label}"
               onerror="this.style.visibility='hidden';this.style.cursor='default';this.onclick=null"
               onclick="openImgModalUrl('${src}')">
        </div>`;
      return `<div class="phist-entry">
        <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
        <div class="phist-avatar-diff">
          ${img(oldSrc, 'Old')}
          <div class="phist-arrow">→</div>
          ${img(newSrc, 'New')}
        </div>
      </div>`;
    }

    const isStatusField = e.field === 'account_status' || e.field === 'privacy_status';
    const valHtml = (v) => v
      ? `<div class="phist-value">${esc(isStatusField ? (_STATUS_LABELS[v] || v) : v)}</div>`
      : `<div class="phist-value empty">(empty)</div>`;
    return `<div class="phist-entry">
      <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
      <div class="phist-diff">
        <div class="phist-side">${sideHdr('Old')}${valHtml(e.old_value)}</div>
        <div class="phist-arrow">→</div>
        <div class="phist-side">${sideHdr('New')}${valHtml(newVal)}</div>
      </div>
    </div>`;
  }).join('');
}


const _vgridPlayIcon  = `<svg width="12" height="12" viewBox="0 0 9 9" fill="rgba(255,255,255,.9)"><polygon points="1.5,0.5 8.5,4.5 1.5,8.5"/></svg>`;
const _vgridPhotoIcon = `<svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x=".75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x=".75" y="7.75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y="7.75" width="4.5" height="4.5" rx=".75"/></svg>`;
const _photoBadge = `<span style="${_badgeStyle}"><svg width="18" height="18" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x=".75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x=".75" y="7.75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y="7.75" width="4.5" height="4.5" rx=".75"/></svg></span>`;

function _thumbCell(v) {
  const id    = esc(v.video_id);
  const badge = v.type === 'video' ? _playBadge : v.type === 'photo' ? _photoBadge : '';
  return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
    <img class="video-thumb" src="/api/tiktok/videos/${id}/thumbnail" alt="" loading="lazy"
         onerror="this.style.opacity='.15'"
         ${_videoThumbAction(v)}>${badge}</div>`;
}

function _videoThumbAction(v) {
  const id = esc(v.video_id);
  if (v.type === 'video') return `onclick="event.stopPropagation();openVidModal('${id}')" title="Play video" style="cursor:pointer"`;
  if (v.type === 'photo') return `onclick="event.stopPropagation();openCarousel('${id}')" title="View photos" style="cursor:pointer"`;
  return `style="cursor:default"`;
}

function _videoActionBtns(v) {
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


function setModalView(view) {
  _userState.view = view;
  const toolbar = document.getElementById('modalToolbar');
  toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === view);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _mRenderList(_USER_MODAL_CFG);
}

function setSoundModalView(view) {
  _soundState.view = view;
  const toolbar = document.getElementById('soundModalToolbar');
  toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === view);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  _mRenderList(_SOUND_MODAL_CFG);
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
  loadStatus();
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
    + ` · @${esc(v.username)}`
    + (v.stats_last_error ? ` — <span style="color:var(--red)">${esc(v.stats_last_error)}</span>` : '')
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


// ── Init ──────────────────────────────────────────────────────────────────────

resetUserFilters();   // clear any browser-restored form state
_initAllGliders();
loadCookies();
loadUsers();
loadSounds();
loadStatus();
loadQueue();
loadStats();
loadRecent();
setInterval(loadCookies, 30000);
setInterval(loadUsers,   15000);
setInterval(loadSounds,  60000);
setInterval(loadStatus,   5000);
setInterval(loadQueue,    3000);
setInterval(loadStats,   60000);
setInterval(loadRecent,  30000);

// Reset backfill — two-step confirmation
let _resetBackfillConfirming = false;
let _resetBackfillTimer = null;

function resetBackfillStep() {
  const btn = document.getElementById('resetBackfillBtn');
  const statusEl = document.getElementById('resetBackfillStatus');

  if (!_resetBackfillConfirming) {
    // First click — enter confirm state
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
    // Second click — execute
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
        statusEl.textContent = `Done — ${data.reset.toLocaleString()} videos marked for re-backfill.`;
        statusEl.style.color = 'var(--green)';
        setTimeout(() => { statusEl.textContent = ''; }, 12000);
      }
    });
  }
}

// Resume backfill poll if it was running before page load
(async () => {
  const { ok, data } = await apiJSON('/api/tiktok/backfill');
  if (ok && data.running) {
    document.getElementById('backfillBtn').disabled = true;
    document.getElementById('backfillStatus').textContent = `Backfilling… ${data.done}/${data.total}`;
    _startBackfillPoll();
  }
})();

// ── Settings platform tabs init ───────────────────────────────────────────────
['jobs', 'diag', 'database'].forEach(s => initSettingsPlatformTabs(s));
PLATFORMS.forEach(p => initDbQueryPane(p.id));

// ── Migration warning ─────────────────────────────────────────────────────────

(async function checkMigrationStatus() {
  try {
    const { ok, data } = await apiJSON('/api/migrate/preview');
    if (!ok || !data.total_legacy) return;
    const n = data.total_legacy;
    showToast(
      `${n} video${n !== 1 ? 's' : ''} have paths that need migration.`,
      {
        type: 'warning',
        duration: 0,
        action: { label: 'Open Migration Settings', onclick: () => openSettings('tiktok') },
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
