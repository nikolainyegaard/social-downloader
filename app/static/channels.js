// ── Channel platform app engine ───────────────────────────────────────────────
//
// One implementation of the creator cards, detail modal, filter bar, add form,
// recent panel, loop panel, and log view, shared by every channel platform
// (Twitter, Instagram, YouTube). Each platform calls initChannelApp(cfg) with
// its nouns, API base, and hooks; the engine generates the platform section
// and detail modal HTML and exposes its public functions on window with the
// platform prefix (e.g. twOpenModal) so generated onclick strings and the
// static settings/jobs markup can reference them.
//
// TikTok keeps its own implementation (sounds catalog plus TikTok-specific
// domain features) but shares the same building blocks from common.js, so the
// UI stays identical.

function initChannelApp(cfg) {
  const P    = cfg.prefix;                 // 'tw' | 'ig' | 'yt'
  const API  = cfg.api;                    // '/api/twitter'
  const X    = (name, fn) => { window[P + name] = fn; return fn; };

  const CREATOR   = cfg.creatorNoun;       // 'account' | 'profile' | 'channel'
  const CREATORS  = cfg.creatorNounPlural;
  const ITEM      = cfg.itemNoun;          // 'tweet' | 'post' | 'video'
  const ITEMS     = cfg.itemNounPlural;
  const ItemsCap  = ITEMS[0].toUpperCase() + ITEMS.slice(1);
  const CreatorsCap = CREATORS[0].toUpperCase() + CREATORS.slice(1);

  const FIELD_LABELS = cfg.fieldLabels || {
    handle: 'Handle', display_name: 'Display name', description: 'Bio', avatar: 'Avatar',
  };

  // ── Section HTML ──────────────────────────────────────────────────────────

  const _triggerIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12C21 16.9706 16.9706 21 12 21C9.69494 21 7.59227 20.1334 6 18.7083L3 16M3 12C3 7.02944 7.02944 3 12 3C14.3051 3 16.4077 3.86656 18 5.29168L21 8M3 21V16M3 16H8M21 3V8M21 8H16"/></svg>`;

  function _sectionHtml() {
    return `
  <div class="mobile-add-bar">
    <div class="mobile-add-input-row">
      <input type="text" id="${P}MobileAddInput" class="mobile-add-input"
             placeholder="${cfg.addPlaceholder}" autocomplete="off" spellcheck="false">
      <button class="mobile-add-paste-btn" onclick="${P}MobileAddPaste()" aria-label="Paste">Paste</button>
    </div>
    <button class="btn-primary" onclick="${P}MobileAddSubmit()">Add</button>
  </div>
  <div class="mobile-add-status" id="${P}MobileAddStatus"></div>

  <div class="top-panels">
    <div class="panel-card">
      <div class="panel-header"><span class="section-title">Statistics</span></div>
      <div class="panel-body" style="padding:8px">
        <div class="stat-grid" id="${P}StatsGrid"></div>
      </div>
    </div>
    <div class="panel-card">
      <div class="panel-header"><span class="section-title">Recent</span></div>
      <div class="panel-body" style="padding:12px 16px">
        <div class="recent-split">
          <div class="recent-col" id="${P}RecentLeft"><div style="color:var(--muted);font-size:12px">Loading…</div></div>
          <div class="recent-col" id="${P}RecentRight"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="track-panels">
    <section>
      <div class="section-title">Track a ${CREATOR}</div>
      <div class="add-form">
        <div class="handle-input" id="${P}HandleInput" contenteditable="true" role="textbox"
             aria-label="${cfg.addAriaLabel}" data-placeholder="${cfg.addPlaceholder}" spellcheck="false"></div>
        <button class="btn-primary" onclick="${P}AddCreator()">Add</button>
      </div>
      <div class="add-status" id="${P}AddStatus"></div>
      <div class="pending-list" id="${P}PendingList"></div>
    </section>

    <div class="panel-card loops-card">
      <div class="panel-header"><span class="section-title">Loop</span></div>
      <div class="panel-body" style="padding:12px 16px;flex-direction:column;gap:12px">
        <div class="loop-block">
          <div class="loop-block-header">
            <span class="loop-section-label">${cfg.loopLabel}</span>
            <span id="${P}LoopNext" class="loop-next"></span>
          </div>
          <div id="${P}LoopMeta" class="loop-meta">Never run</div>
          <div id="${P}LoopSessions" class="loop-sessions"></div>
          <div class="loop-actions">
            <div style="display:flex;gap:5px">
              <button class="btn-run btn-trigger" id="${P}TriggerNextBtn"    onclick="${P}TriggerNext()">${_triggerIcon} Next</button>
              <button class="btn-run btn-trigger" id="${P}TriggerStarredBtn" onclick="${P}TriggerStarred()">${_triggerIcon} Starred</button>
              <button class="btn-run btn-trigger" id="${P}TriggerHalfBtn"    onclick="${P}TriggerHalf()">${_triggerIcon} Half</button>
              <button class="btn-run btn-trigger" id="${P}TriggerAllBtn"     onclick="${P}TriggerAll()">${_triggerIcon} All</button>
            </div>
            <button class="btn-danger btn-trigger" id="${P}StopBtn" onclick="${P}StopLoop()" disabled>Stop</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <section>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="filter-pills">
          <button class="filter-pill active" id="${P}TvCreators" onclick="${P}SetTrackingView('creators')">${CreatorsCap}</button>
          <button class="filter-pill"        id="${P}TvLog"      onclick="${P}SetTrackingView('log')">Log</button>
        </div>
        <span id="${P}Count" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
        <input id="${P}Search" type="search" placeholder="Search…" oninput="${P}OnSearch(this.value)"
               style="width:160px;font-size:12px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);outline:none;">
      </div>
      <div id="${P}Controls" class="filter-control-group">
        <div class="filter-row">
          <span class="filter-row-label">Tracking</span>
          <div class="filter-pills multi">
            <button class="filter-pill" id="${P}fStatActive"   onclick="${P}SetFilter('stat','active')">Active</button>
            <button class="filter-pill" id="${P}fStatInactive" onclick="${P}SetFilter('stat','inactive')">Inactive</button>
          </div>
        </div>
        <div class="filter-row">
          <span class="filter-row-label">Starred</span>
          <div class="filter-pills multi">
            <button class="filter-pill" id="${P}fStarStarred" onclick="${P}SetFilter('star','starred')">Starred</button>
          </div>
        </div>
        <div class="filter-row">
          <span class="filter-row-label">Sort</span>
          <div class="sort-controls">
            <select class="sort-select" id="${P}SortField" onchange="${P}SetSortField(this.value)">
              <option value="handle">Handle</option>
              <option value="display_name">Display name</option>
              <option value="subscriber_count">${cfg.subLabelSort}</option>
              <option value="video_total">Saved ${ITEMS}</option>
              <option value="video_deleted">Deleted ${ITEMS}</option>
              <option value="added_at">Date added</option>
            </select>
            <button class="sort-dir-btn" id="${P}SortDirBtn" onclick="${P}ToggleSortDir()">A → Z</button>
            <button class="sort-dir-btn" onclick="${P}ResetFilters()" title="Reset filters and sort">Reset</button>
          </div>
        </div>
      </div>
    </div>
    <div class="users-grid" id="${P}Grid">
      <div class="empty-state">No ${CREATORS} tracked yet.</div>
    </div>
    <div id="${P}LogPanel" style="display:none">
      <div class="log-panel">
        <div class="log-header">
          <div style="display:flex;align-items:center;gap:12px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;">
              <input type="checkbox" id="${P}AutoScroll" checked style="accent-color:var(--accent)">
              Auto-scroll
            </label>
            <button class="btn-ghost" onclick="${P}ClearLog()" style="font-size:11px;padding:3px 8px;">Clear</button>
          </div>
        </div>
        <div class="log-body" id="${P}LogBody"></div>
      </div>
    </div>
  </section>`;
  }

  function _modalHtml() {
    return `
<div id="${P}ModalBackdrop" class="modal-backdrop" style="display:none" onclick="if(event.target===this)${P}CloseModal()">
  <div class="modal modal-base">
    <button class="modal-close" onclick="${P}CloseModal()"></button>
    ${cfg.hasBanner ? `<div class="yt-modal-banner" id="${P}ModalBanner" style="display:none"></div>` : ''}
    <div class="modal-header"     id="${P}ModalHeader"></div>
    <div class="modal-toolbar"    id="${P}ModalToolbar"></div>
    <div class="phist-panel"      id="${P}PhistPanel" style="display:none"></div>
    <div class="modal-video-list" id="${P}ModalVideoList"></div>
  </div>
</div>`;
  }

  document.getElementById(`platform-${cfg.id}`).innerHTML = _sectionHtml();
  document.body.insertAdjacentHTML('beforeend', _modalHtml());

  // ── State ─────────────────────────────────────────────────────────────────

  let creators       = [];
  let sort           = { field: 'handle', dir: 'asc' };
  let filter         = { stat: new Set(), star: new Set() };
  let search         = '';
  let pending        = {};
  const dismissed    = new Set();
  let runQueue       = [];
  let runCurrent     = null;
  let loopRunning    = false;
  let currentCreator = null;
  let logLines       = [];
  let logClearIndex  = 0;
  let logClearRestored = false;
  let cleanupPoll    = null;

  const SORT_DIR_LABELS = {
    handle:           { asc: 'A → Z',        desc: 'Z → A'        },
    display_name:     { asc: 'A → Z',        desc: 'Z → A'        },
    subscriber_count: { asc: 'Low → High',   desc: 'High → Low'   },
    video_total:      { asc: 'Low → High',   desc: 'High → Low'   },
    video_deleted:    { asc: 'Low → High',   desc: 'High → Low'   },
    added_at:         { asc: 'Oldest first', desc: 'Newest first' },
  };

  // ── Video render helpers ──────────────────────────────────────────────────

  const thumbBadge = cfg.thumbBadge || (() => _playBadge);

  // Photo posts (e.g. Twitter images) are stored as .avif/.jpg; open them in the
  // image modal and download them under their real extension, not as .mp4.
  const _IMG_EXTS = ['avif', 'jpg', 'jpeg', 'png', 'webp', 'gif'];
  const _mediaExt = v => ((v.file_path || '').split('.').pop() || '').toLowerCase();
  const _isImage  = v => _IMG_EXTS.includes(_mediaExt(v));
  // Multi-media posts store {id}_01.ext as file_path with siblings on disk.
  const _isMulti  = v => (((v.file_path || '').split('/').pop()) || '').startsWith(`${v.video_id}_`);

  function _openMediaFor(v) {
    const id = esc(v.video_id);
    if (_isMulti(v)) return `${P}OpenCarousel('${id}')`;
    return _isImage(v)
      ? `openImgModalUrl('${API}/videos/${id}/file')`
      : `${P}OpenVidModal('${id}')`;
  }

  function _thumbCell(v) {
    const id = esc(v.video_id);
    const isImg = _isImage(v);
    return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
      <img class="video-thumb" src="${API}/videos/${id}/thumbnail" alt="" loading="lazy"
           onerror="this.style.opacity='.15'"
           onclick="event.stopPropagation();${_openMediaFor(v)}" title="${_isMulti(v) ? 'View media' : isImg ? 'View photo' : 'Play video'}" style="cursor:pointer">
      ${_isMulti(v) ? _photoBadge : isImg ? _imageBadge : thumbBadge(v)}
    </div>`;
  }

  function _videoActionBtns(v) {
    const id = esc(v.video_id);
    if (v.file_path) {
      const ext  = _mediaExt(v) || 'mp4';
      const name = _isMulti(v) ? (v.file_path.split('/').pop()) : `${id}.${ext}`;
      return `<a class="play-btn" href="${API}/videos/${id}/file" download="${esc(name)}"
               onclick="event.stopPropagation()" title="${_isMulti(v) ? 'Download first file' : 'Download'}">${_dlIcon}</a>`;
    }
    return '';
  }

  X('OpenImgModal', videoId => {
    openImgModalUrl(`${API}/videos/${encodeURIComponent(videoId)}/thumbnail`);
  });

  X('OpenVidModal', videoId => {
    const vid = document.getElementById('vidModalPlayer');
    vid.src = `${API}/videos/${encodeURIComponent(videoId)}/file`;
    document.getElementById('vidModal').style.display = 'flex';
    _lockScroll();
    vid.play().catch(() => {});
  });

  X('OpenCarousel', async videoId => {
    const { ok, data } = await apiJSON(`${API}/videos/${encodeURIComponent(videoId)}/files`);
    if (!ok || !data.files || !data.files.length) return;
    openCarouselSlides(data.files);
  });

  // ── Detail modal config ───────────────────────────────────────────────────

  const VCOLS = [
    { field: null,            label: '' },
    { field: null,            label: 'Title' },
    { field: 'status',        label: 'Status' },
    { field: 'view_count',    label: 'Views' },
    { field: 'upload_date',   label: cfg.uploadDateLabel },
    { field: 'download_date', label: 'Saved' },
    { field: 'deleted_at',    label: 'Deleted' },
    { field: null,            label: '' },
  ];

  const _creatorState = {
    videos: [], filter: new Set(), typeFilter: new Set(), search: '',
    sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, obs: null,
    toolbarExpanded: false, view: 'list',
  };

  const MODAL_CFG = {
    st:             _creatorState,
    listElId:       `${P}ModalVideoList`,
    toolbarElId:    `${P}ModalToolbar`,
    cols:           VCOLS,
    colsCls:        'vcols',
    pageSize:       50,
    uploadDateFmt:  fmtDateOnly,
    filterFn:     `${P}SetModalFilter`,
    typeFilterFn: `${P}SetModalTypeFilter`,
    sortFn:       `${P}SetModalSort`,
    toggleFn:     `${P}ToggleModalToolbar`,
    searchFn:     `${P}OnModalSearch`,
    authorCol:    null,
    hasSearch:    true,
    hasViewToggle: true,
    viewFn:       `${P}SetModalView`,
    viewKeys: cfg.viewKeys || [
      { key: 'list',   icon: _listViewIcon, title: 'List view' },
      { key: 'videos', icon: _gridViewIcon, title: 'Grid view' },
    ],
    viewVideoFilter: cfg.viewVideoFilter || ((view, vids) => vids),
    gridClassFn:     cfg.gridClassFn || (() => ''),
    typeIconFn:      cfg.typeIconFn || (v => _isMulti(v) ? _vgridPhotoIcon : (v.type === 'photo' || _isImage(v)) ? _vgridImageIcon : _vgridPlayIcon),
    gridId:       `${P}VideoGrid`,
    hasPhistBtn:  true,
    phistBtnFn:   `${P}OpenProfileHistory`,
    thumbCellFn:  _thumbCell,
    actionBtnsFn: _videoActionBtns,
    previewFn:    `${P}OpenImgModal`,
    gridThumbSrc: v => `${API}/videos/${esc(v.video_id)}/thumbnail`,
    gridCellOnclick: v => _isMulti(v)
      ? window[`${P}OpenCarousel`](v.video_id)
      : _isImage(v)
        ? openImgModalUrl(`${API}/videos/${encodeURIComponent(v.video_id)}/file`)
        : window[`${P}OpenVidModal`](v.video_id),
  };

  // ── Stats panel ───────────────────────────────────────────────────────────

  function renderStats(s) {
    _renderStatGrid(`${P}StatsGrid`, [
      { label: `Tracked ${CREATORS}`, value: (s.channel_count || 0).toLocaleString() },
      { label: `Saved ${ITEMS}`,      value: (s.saved_count   || 0).toLocaleString() },
      { label: 'Deleted',             value: (s.deleted_count || 0).toLocaleString() },
      { label: 'Latest saved',        value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
      { label: 'Total views',         value: _fmtLarge(s.total_views || 0) },
      { label: 'Storage',             value: _fmtBytes(s.media_size_bytes || 0) },
    ]);
  }

  const loadStats = X('LoadStats', async () => {
    const { ok, data } = await apiJSON(`${API}/stats`);
    if (ok) renderStats(data);
  });

  // ── Recent panel ──────────────────────────────────────────────────────────

  const RECENT_LOG_TITLES = {
    'deletions':       `All Deleted ${ItemsCap}`,
    'profile-changes': 'All Profile Changes',
    'saved':           `All Saved ${ItemsCap}`,
  };

  function _renderSavedRow(g, now) {
    const row = document.createElement('div');
    row.className = 'recent-entry';
    row.title = `Open @${g.handle}`;
    row.onclick = () => window[`${P}OpenModal`](g.channel_id);
    row.innerHTML = `
      <span class="recent-date">${_recentDate(g.download_date, now)}</span>
      <span class="recent-name">@${esc(g.handle)}</span>
      <span class="recent-detail">${g.count}x</span>`;
    return row;
  }

  function _renderOtherRow(item, type, now) {
    const row = document.createElement('div');
    row.className = 'recent-entry';
    if (type === 'deletions') {
      row.title = `Open @${item.handle}`;
      row.onclick = () => window[`${P}OpenModalAndHighlight`](item.channel_id, item.video_id);
      row.innerHTML = `
        <span class="recent-date">${_recentDate(item.deleted_at, now)}</span>
        <span class="recent-name">@${esc(item.handle)}</span>
        <span class="recent-detail">${esc((item.video_id || '').slice(0, 11))}</span>`;
    } else {
      const label = FIELD_LABELS[item.field] || item.field;
      row.title = `Open @${item.handle} · ${label} history`;
      row.onclick = () => window[`${P}OpenModalWithHistory`](item.channel_id, item.field);
      row.innerHTML = `
        <span class="recent-date">${_recentDate(item.changed_at, now)}</span>
        <span class="recent-name">@${esc(item.handle)}</span>
        <span class="recent-detail">${esc(label)}</span>`;
    }
    return row;
  }

  X('OpenRecentLog', type => {
    _openRecentLogModal(type, {
      apiBase:     `${API}/recent`,
      titles:      RECENT_LOG_TITLES,
      groupKey:    'channel_id',
      renderSaved: _renderSavedRow,
      renderOther: _renderOtherRow,
    });
  });

  function renderRecent(data) {
    const leftEl  = document.getElementById(`${P}RecentLeft`);
    const rightEl = document.getElementById(`${P}RecentRight`);
    if (!leftEl || !rightEl) return;
    const now = new Date();

    let left = '';

    left += `<div class="recent-section">`;
    left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="${P}OpenRecentLog('deletions')" title="View all deleted ${ITEMS}">Recently deleted</div>`;
    if (data.deletions && data.deletions.length) {
      left += data.deletions.map(d => {
        const onclick = `${P}OpenModalAndHighlight('${esc(d.channel_id)}','${esc(d.video_id)}')`;
        return `<div class="recent-entry" onclick="${onclick}" title="Open @${esc(d.handle)}">
          <span class="recent-date">${_recentDate(d.deleted_at, now)}</span>
          <span class="recent-name">@${esc(d.handle)}</span>
          <span class="recent-detail">${esc((d.video_id || '').slice(0, 11))}</span>
        </div>`;
      }).join('');
    } else {
      left += `<div class="recent-empty">No deleted ${ITEMS} yet</div>`;
    }
    left += `</div>`;

    left += `<div class="recent-section">`;
    left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="${P}OpenRecentLog('profile-changes')" title="View all profile changes">Recently changed profile</div>`;
    if (data.profile_changes && data.profile_changes.length) {
      left += data.profile_changes.map(p =>
        `<div class="recent-entry" onclick="${P}OpenModalWithHistory('${esc(p.channel_id)}','${esc(p.field)}')" title="Open @${esc(p.handle)}">
          <span class="recent-date">${_recentDate(p.changed_at, now)}</span>
          <span class="recent-name">@${esc(p.handle)}</span>
          <span class="recent-detail">${esc(FIELD_LABELS[p.field] || p.field)}</span>
        </div>`
      ).join('');
    } else {
      left += `<div class="recent-empty">No profile changes recorded yet</div>`;
    }
    left += `</div>`;

    leftEl.innerHTML = left;

    let right = '';
    right += `<div class="recent-section">`;
    right += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="${P}OpenRecentLog('saved')" title="View all saved ${ITEMS}">Recently saved</div>`;
    if (data.saved && data.saved.length) {
      right += data.saved.map(g =>
        `<div class="recent-entry" onclick="${P}OpenModal('${esc(g.channel_id)}')" title="Open @${esc(g.handle)}">
          <span class="recent-date">${_recentDate(g.download_date, now)}</span>
          <span class="recent-name">@${esc(g.handle)}</span>
          <span class="recent-detail">${g.count}x</span>
        </div>`
      ).join('');
    } else {
      right += `<div class="recent-empty">No ${ITEMS} saved yet</div>`;
    }
    right += `</div>`;

    rightEl.innerHTML = right;
  }

  const loadRecent = X('LoadRecent', async () => {
    const { ok, data } = await apiJSON(`${API}/recent`);
    if (ok) renderRecent(data);
  });

  // ── Loop status ───────────────────────────────────────────────────────────

  const _el = id => document.getElementById(P + id);

  function renderStatus(state) {
    loopRunning    = state.loop_running;
    currentCreator = state.loop_current_channel;
    runQueue       = state.run_queue  || [];
    runCurrent     = state.run_current || null;

    const meta = _el('LoopMeta');
    if (meta) {
      const parts = [];
      if (state.loop_last_end) parts.push(`Last: ${fmt.rel(state.loop_last_end)}`);
      else parts.push('Never run');
      if (state.loop_last_new_videos != null) parts.push(`${state.loop_last_new_videos} new`);
      if (state.loop_last_duration_secs != null) parts.push(fmt.dur(state.loop_last_duration_secs));
      meta.textContent = parts.join(' · ');
    }
    const next = _el('LoopNext');
    if (next) next.textContent = loopRunning
      ? 'Running…'
      : (state.loop_next ? `Next: ${fmt.relFuture(state.loop_next)}` : '');
    _renderSessionPills(_el('LoopSessions'), state.loop_sessions_today || [], loopRunning, state.loop_manual_run);
    for (const id of ['TriggerNextBtn', 'TriggerStarredBtn', 'TriggerHalfBtn', 'TriggerAllBtn']) {
      const btn = _el(id);
      if (btn) btn.disabled = loopRunning;
    }
    const stopBtn = _el('StopBtn');
    if (stopBtn) stopBtn.disabled = !loopRunning;

    const badge  = document.getElementById('statusBadge');
    const text   = document.getElementById('statusText');
    const active = location.hash === `#${cfg.id}`;
    if (active && badge && text) {
      const anyActive = loopRunning || !!runCurrent;
      badge.className  = `status-badge${anyActive ? ' running' : ''}`;
      text.textContent = anyActive
        ? (currentCreator ? `Downloading @${currentCreator}` : 'Running…')
        : 'Idle';
    }

    const logBody = _el('LogBody');
    if (logBody && state.logs) {
      if (!logClearRestored) {
        logClearRestored = true;
        const mark = localStorage.getItem(`${P}-logClearWatermark`);
        if (mark) {
          const lines = state.logs;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i] === mark) { logClearIndex = i + 1; break; }
          }
        }
      }
      const newLines = state.logs.slice(logClearIndex);
      if (newLines.length !== logLines.length || (logLines.length && logLines[logLines.length - 1] !== newLines[newLines.length - 1])) {
        logLines = newLines;
        const auto = _el('AutoScroll')?.checked !== false;
        logBody.innerHTML = logLines.map(l => `<div class="log-line ${_logLineClass(l)}">${esc(l)}</div>`).join('');
        if (auto) logBody.scrollTop = logBody.scrollHeight;
      }
    }

    updateRunStates();
  }

  function updateRunStates() {
    // Patch only the dynamic run-state parts of existing cards without rebuilding DOM.
    document.querySelectorAll(`.${P}-creator-card[data-channelid]`).forEach(card => {
      const id   = card.dataset.channelid;
      const busy = runQueue.includes(id) || runCurrent === id;
      const ch   = creators.find(c => c.channel_id === id);
      card.classList.toggle('user-card-current', !!(ch && ch.handle === currentCreator));
      card.querySelectorAll('.btn-run').forEach(b => { b.disabled = busy; });
    });
    if (modalCreator) {
      const busy = runQueue.includes(modalCreator.channel_id) || runCurrent === modalCreator.channel_id;
      const qBtn = _el('ModalRunQuickBtn');
      const fBtn = _el('ModalRunFullBtn');
      if (qBtn) qBtn.disabled = busy;
      if (fBtn) fBtn.disabled = busy;
    }
  }

  const loadStatus = X('LoadStatus', async () => {
    const { ok, data } = await apiJSON(`${API}/status`);
    if (ok) renderStatus(data);
  });

  X('ClearLog', () => {
    const lastLine = logLines[logLines.length - 1];
    if (lastLine) {
      localStorage.setItem(`${P}-logClearWatermark`, lastLine);
    } else {
      localStorage.removeItem(`${P}-logClearWatermark`);
    }
    logClearIndex = 0;
    logLines = [];
    const logBody = _el('LogBody');
    if (logBody) logBody.innerHTML = '';
  });

  // ── Loop triggers ─────────────────────────────────────────────────────────

  const _triggerToast = _makeTriggerToast(CREATOR);
  X('TriggerNext',    () => _triggerLoop(`${P}TriggerNextBtn`,    `${API}/trigger/next`, 'Could not trigger loop', _triggerToast));
  X('TriggerStarred', () => _triggerLoop(`${P}TriggerStarredBtn`, `${API}/trigger`,      'Could not trigger loop', _triggerToast));
  X('TriggerHalf',    () => _triggerLoop(`${P}TriggerHalfBtn`,    `${API}/trigger/half`, 'Could not trigger loop', _triggerToast));
  X('TriggerAll',     () => _triggerLoop(`${P}TriggerAllBtn`,     `${API}/trigger/all`,  'Could not trigger loop', _triggerToast));

  X('StopLoop', async () => {
    const btn = _el('StopBtn');
    if (btn) btn.disabled = true;
    const { ok } = await apiJSON(`${API}/stop`, { method: 'POST' });
    if (!ok) {
      if (btn) btn.disabled = false;
      showToast('Could not stop loop.', { type: 'error' });
    }
  });

  X('SaveLoopSettings', () => _scheduleSettingsSave(cfg.id, `${P}Settings`));

  // ── DB cleanup ────────────────────────────────────────────────────────────

  const _cleanupWidget = _makeJobWidget(`${P}-cleanup`);

  X('TriggerCleanup', async () => {
    const btn = document.getElementById(`job-${P}-cleanup-btn`);
    if (btn) btn.disabled = true;
    const { ok, data } = await apiJSON(`${API}/db/cleanup`, { method: 'POST' });
    if (!ok) { showToast(data.error || 'Could not start cleanup', { type: 'error' }); if (btn) btn.disabled = false; return; }
    _cleanupWidget.update({ barPct: null, label: 'Running…' });
    if (cleanupPoll) return;
    cleanupPoll = setInterval(async () => {
      const { ok, data } = await apiJSON(`${API}/db/cleanup`);
      if (!ok) return;
      if (data.running) {
        _cleanupWidget.update({ barPct: null, label: data.current || 'Running…', steps: data.steps });
      } else {
        clearInterval(cleanupPoll); cleanupPoll = null;
        if (btn) btn.disabled = false;
        _cleanupWidget.update({
          barPct: 100,
          label: `Done - ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
          steps: data.steps,
        });
      }
    }, 800);
  });

  // ── Add creator form ──────────────────────────────────────────────────────

  const handleInput = _el('HandleInput');

  handleInput.addEventListener('input', function() {
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

  handleInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); window[`${P}AddCreator`](); }
  });

  handleInput.addEventListener('paste', function(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  async function _submitAdd(raw, statusEl, base) {
    statusEl.className   = `${base} info`;
    statusEl.textContent = 'Adding…';

    const { ok, data } = await apiJSON(`${API}/channels`, {
      method: 'POST',
      body: JSON.stringify({ handle: raw }),
    });
    if (ok) {
      const handle = data.handle || raw.replace(/^@/, '');
      dismissed.delete(handle);
      pending[handle] = { status: 'pending' };
      statusEl.className   = `${base} ok`;
      statusEl.textContent = `@${handle} queued.`;
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = base; }, 5000);
      renderPending();
    } else {
      statusEl.className   = `${base} error`;
      statusEl.textContent = data.error || 'Failed.';
    }
  }

  X('AddCreator', async () => {
    const raw = handleInput.textContent.trim();
    if (!raw) return;
    handleInput.textContent = '';
    handleInput.focus();
    await _submitAdd(raw, _el('AddStatus'), 'add-status');
  });

  X('MobileAddPaste', async () => {
    const input = _el('MobileAddInput');
    try {
      input.value = (await navigator.clipboard.readText()).trim();
    } catch { /* clipboard permission denied; leave the field as is */ }
    input.focus();
  });

  X('MobileAddSubmit', async () => {
    const input = _el('MobileAddInput');
    const raw   = input.value.trim();
    if (!raw) return;
    input.value = '';
    await _submitAdd(raw, _el('MobileAddStatus'), 'mobile-add-status');
    input.focus();
  });

  _el('MobileAddInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); window[`${P}MobileAddSubmit`](); }
  });

  const loadQueue = X('LoadQueue', async () => {
    const { ok, data } = await apiJSON(`${API}/queue`);
    if (!ok) return;
    let anyResolved = false;
    for (const h of Object.keys(pending)) {
      if (!(h in data) && !dismissed.has(h)) {
        delete pending[h];
        anyResolved = true;
      }
    }
    for (const [h, info] of Object.entries(data)) {
      if (!dismissed.has(h)) pending[h] = info;
    }
    renderPending();
    if (anyResolved) loadCreators();
  });

  function renderPending() {
    const container = _el('PendingList');
    if (!container) return;
    const entries = Object.entries(pending).filter(([h]) => !dismissed.has(h));
    if (!entries.length) { container.innerHTML = ''; return; }
    container.innerHTML = entries.map(([handle, info]) => {
      if (info.status === 'pending') {
        return `<div class="pending-item"><span class="spinner"></span>Looking up @${esc(handle)}…</div>`;
      }
      return `<div class="pending-item error">Failed to add @${esc(handle)}: ${esc(info.message)} <button onclick="${P}DismissPending('${esc(handle)}')" title="Dismiss">×</button></div>`;
    }).join('');
  }

  X('DismissPending', async handle => {
    await apiJSON(`${API}/queue/${encodeURIComponent(handle)}`, { method: 'DELETE' });
    delete pending[handle];
    renderPending();
  });

  // ── Filters and sort ──────────────────────────────────────────────────────

  const STAT_IDS = { active: `${P}fStatActive`, inactive: `${P}fStatInactive` };
  const STAR_IDS = { starred: `${P}fStarStarred` };

  X('SetFilter', (group, value) => {
    const set = filter[group];
    set.has(value) ? set.delete(value) : set.add(value);
    const map = group === 'stat' ? STAT_IDS : STAR_IDS;
    Object.entries(map).forEach(([v, id]) => {
      document.getElementById(id)?.classList.toggle('active', set.has(v));
    });
    renderCreators();
  });

  X('SetSortField', field => {
    sort.field = field;
    sort.dir   = (field === 'handle' || field === 'display_name') ? 'asc' : 'desc';
    _updateSortBtn();
    renderCreators();
  });

  X('ToggleSortDir', () => {
    sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    _updateSortBtn();
    renderCreators();
  });

  function _updateSortBtn() {
    const btn = _el('SortDirBtn');
    if (btn) btn.textContent = SORT_DIR_LABELS[sort.field]?.[sort.dir] ?? sort.dir;
  }

  X('ResetFilters', () => {
    sort   = { field: 'handle', dir: 'asc' };
    filter = { stat: new Set(), star: new Set() };
    search = '';
    const searchEl = _el('Search');
    if (searchEl) searchEl.value = '';
    const sel = _el('SortField');
    if (sel) sel.value = 'handle';
    _updateSortBtn();
    Object.values(STAT_IDS).forEach(id => document.getElementById(id)?.classList.remove('active'));
    Object.values(STAR_IDS).forEach(id => document.getElementById(id)?.classList.remove('active'));
    renderCreators();
  });

  X('OnSearch', val => {
    search = val.trim();
    renderCreators();
  });

  function _filteredCreators() {
    const q = search.toLowerCase();
    return creators.filter(ch => {
      if (filter.stat.size && !filter.stat.has(ch.tracking_enabled === 0 ? 'inactive' : 'active')) return false;
      if (filter.star.has('starred') && !ch.starred) return false;
      if (q) {
        const hay = [ch.handle, ch.display_name, ch.channel_id, ch.description]
                    .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function _sortedCreators() {
    const { field, dir } = sort;
    return _filteredCreators().sort((a, b) => {
      const av = field === 'display_name' ? (a.display_name || a.handle) : (a[field] ?? (field === 'handle' ? '' : 0));
      const bv = field === 'display_name' ? (b.display_name || b.handle) : (b[field] ?? (field === 'handle' ? '' : 0));
      return _cmp(av, bv, dir);
    });
  }

  // ── Creator cards ─────────────────────────────────────────────────────────

  const CARD_BATCH   = 9;
  let gridObs        = null;
  let renderedCount  = 0;
  let sortedCache    = [];

  function _renderCreatorCard(ch) {
    const isCurrent  = !!currentCreator && ch.handle === currentCreator;
    const isInactive = ch.tracking_enabled === 0;
    const { cls: trackingCls, label: trackingLabel } = _trackingBadge(ch.tracking_enabled);
    const inQueue    = runQueue.includes(ch.channel_id);
    const isRunCur   = runCurrent === ch.channel_id;
    const runDis     = (inQueue || isRunCur) ? 'disabled' : '';

    return `
      <div class="user-card ${P}-creator-card${isCurrent ? ' user-card-current' : ''}${isInactive ? ' user-card-inactive' : ''}"
           data-channelid="${esc(ch.channel_id)}"
           onclick="if(!event.target.closest('button'))${P}OpenModal('${esc(ch.channel_id)}')"
           role="button" tabindex="0">
        <div class="user-card-top">
          <div class="avatar-wrap">
            <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
            ${ch.avatar_cached ? `<img class="user-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar" alt=""
                 onerror="this.style.display='none'"
                 onclick="event.stopPropagation();openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')">` : ''}
          </div>
          <div class="user-identity">
            <div class="user-display-name">${esc(ch.display_name || ch.handle)}</div>
            <div class="user-handle">@${esc(ch.handle)}</div>
            <div class="user-id-line">${esc(ch.channel_id)}</div>
          </div>
          <div class="user-badges">
            <span class="account-status ${trackingCls}">${trackingLabel}</span>
          </div>
        </div>

        <div class="user-bio-area">
          ${ch.description ? `<div class="user-bio">${esc(ch.description)}</div>` : ''}
        </div>

        <div class="user-stats">
          ${ch.subscriber_count != null ? `<span class="stat-item"><span class="stat-item-label">${cfg.subLabelCard}</span><span class="stat-item-value">${(ch.subscriber_count || 0).toLocaleString()}</span></span>` : ''}
          <span class="stat-item"><span class="stat-item-label">saved</span><span class="stat-item-value">${ch.video_total || 0}</span></span>
          ${(ch.video_deleted || 0) > 0 ? `<span class="stat-item"><span class="stat-item-label">deleted</span><span class="stat-item-value" style="color:var(--red)">${ch.video_deleted}</span></span>` : ''}
          ${ch.video_missing   ? `<span class="stat-item"><span class="stat-item-label">missing</span><span class="stat-item-value" style="color:#ff9800">${ch.video_missing}</span></span>` : ''}
          ${ch.video_undeleted ? `<span class="stat-item"><span class="stat-item-label">restored</span><span class="stat-item-value" style="color:var(--yellow)">${ch.video_undeleted}</span></span>` : ''}
        </div>

        <div class="user-card-footer">
          <div style="display:flex;gap:6px;">
            <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="event.stopPropagation();${P}ToggleStar('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
            <button class="btn-run" ${runDis} onclick="event.stopPropagation();${P}RunCreatorQuick('${esc(ch.channel_id)}')">${_refreshIcon} Quick</button>
            <button class="btn-run" ${runDis} onclick="event.stopPropagation();${P}RunCreator('${esc(ch.channel_id)}')">${_refreshIcon} Full</button>
            <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>${P}RunCreatorProfile('${esc(ch.channel_id)}')},{label:'Remove',danger:true,onclick:()=>${P}RemoveCreator('${esc(ch.channel_id)}','@${esc(ch.handle)}')}])">&#x2022;&#x2022;&#x2022;</button>
          </div>
        </div>
        <div class="user-card-meta-footer">
          <div class="user-card-meta-item">
            <span class="meta-label">Added</span>
            <span class="meta-value">${fmtDateOnly(ch.added_at)}</span>
          </div>
          <div class="user-card-meta-item">
            <span class="meta-label">Last checked</span>
            <span class="meta-value">${ch.last_checked ? fmt.rel(new Date(ch.last_checked * 1000).toISOString()) : 'never'}</span>
          </div>
          <div class="user-card-meta-item">
            <span class="meta-label">Last saved</span>
            <span class="meta-value">${ch.last_saved ? fmt.rel(new Date(ch.last_saved * 1000).toISOString()) : 'never'}</span>
          </div>
        </div>
      </div>
    `;
  }

  function _appendCreatorCards() {
    const grid = _el('Grid');
    gridObs = null;
    const next = sortedCache.slice(renderedCount, renderedCount + CARD_BATCH);
    if (!next.length) return;
    grid.insertAdjacentHTML('beforeend', next.map(_renderCreatorCard).join(''));
    renderedCount += next.length;
    if (sortedCache.length > renderedCount) {
      gridObs = _attachGridSentinel(grid, _appendCreatorCards);
    }
  }

  function renderCreators() {
    if (gridObs) { gridObs.disconnect(); gridObs = null; }
    const grid = _el('Grid');
    if (!grid) return;
    const filtered   = _filteredCreators();
    const isFiltered = filter.stat.size > 0 || filter.star.size > 0 || !!search;
    const countEl    = _el('Count');
    if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${creators.length}` : creators.length;

    if (!creators.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No ${CREATORS} tracked yet.</div>`;
      renderedCount = 0;
      return;
    }
    if (!filtered.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No ${CREATORS} match this filter.</div>`
        + _ghostCards(Math.min(creators.length, CARD_BATCH));
      renderedCount = 0;
      return;
    }

    sortedCache   = _sortedCreators();
    const toShow  = Math.min(Math.max(CARD_BATCH, renderedCount), sortedCache.length);
    const slice   = sortedCache.slice(0, toShow);
    grid.innerHTML = slice.map(_renderCreatorCard).join('')
      + (toShow < CARD_BATCH ? _ghostCards(CARD_BATCH - toShow) : '');
    renderedCount = slice.length;

    if (sortedCache.length > renderedCount) {
      gridObs = _attachGridSentinel(grid, _appendCreatorCards);
    }
  }

  const loadCreators = X('LoadCreators', async () => {
    const { ok, data } = await apiJSON(`${API}/channels`);
    if (ok) { creators = data; renderCreators(); }
  });

  X('GetCreators', () => creators);

  X('RunCreator',        id => _creatorRun(`${API}/channels`, id, () => runQueue, q => { runQueue = q; }, () => { renderCreators(); updateRunStates(); }, 'full'));
  X('RunCreatorQuick',   id => _creatorRun(`${API}/channels`, id, () => runQueue, q => { runQueue = q; }, () => { renderCreators(); updateRunStates(); }, 'quick'));
  X('RunCreatorProfile', id => _creatorRunProfile(`${API}/channels`, id, () => runQueue, q => { runQueue = q; }, renderCreators));
  X('RemoveCreator',     (id, label) => _creatorRemove(`${API}/channels`, id, label, loadCreators));
  X('ToggleStar',        id => _creatorToggleStar(`${API}/channels`, id, creators, 'channel_id', renderCreators));

  // ── Tracking toggle ───────────────────────────────────────────────────────

  X('SetTracking', async (channelId, enabled) => {
    const { ok, data } = await apiJSON(`${API}/channels/${channelId}/tracking`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    if (!ok) { showToast(data.error || 'Failed to update tracking', { type: 'error' }); return; }
    const ch = creators.find(c => c.channel_id === channelId);
    if (ch) ch.tracking_enabled = enabled ? 1 : 0;
    if (modalCreatorId === channelId && modalCreator) {
      modalCreator.tracking_enabled = enabled ? 1 : 0;
      _renderModalHeader(modalCreator);
    }
    renderCreators();
  });

  // ── Creator detail modal ──────────────────────────────────────────────────

  let modalCreatorId        = null;
  let modalCreator          = null;
  let modalPendingHighlight = null;

  let phistData  = [];
  let phistField = new Set();
  let phistChId  = null;

  X('OpenModalAndHighlight', (channelId, videoId, mFilter, sortField, sortDir) => {
    modalPendingHighlight = {
      videoId,
      filter:    mFilter && mFilter !== 'all' ? new Set([mFilter]) : new Set(),
      sortField: sortField || 'upload_date',
      sortDir:   sortDir   || 'desc',
    };
    window[`${P}OpenModal`](channelId);
  });

  X('OpenModal', channelId => {
    const ch = creators.find(c => c.channel_id === channelId);
    if (!ch) return;
    modalCreatorId = channelId;
    modalCreator   = ch;
    Object.assign(_creatorState, {
      videos: [], filter: new Set(), typeFilter: new Set(), search: '',
      sort: { field: 'upload_date', dir: 'desc' }, loaded: 0, toolbarExpanded: false,
      view: window.innerWidth <= 640 ? 'grid' : 'list',
    });
    if (_creatorState.obs) { _creatorState.obs.disconnect(); _creatorState.obs = null; }

    phistData  = [];
    phistField = new Set();
    phistChId  = null;
    _el('PhistPanel').style.display     = 'none';
    _el('ModalVideoList').style.display = '';

    _el('ModalBackdrop').style.display = 'flex';
    _lockScroll();

    _renderModalHeader(ch);
    _mRenderToolbar(MODAL_CFG, []);
    _el('ModalVideoList').innerHTML =
      `<div class="vlist-loading">Loading ${ITEMS}…</div>`;

    _loadModalVideos(channelId);
  });

  X('OpenModalWithHistory', (channelId, field) => {
    window[`${P}OpenModal`](channelId);
    window[`${P}OpenProfileHistory`](field);
  });

  X('CloseModal', () => {
    _el('ModalBackdrop').style.display = 'none';
    _unlockScroll();
    if (_creatorState.obs) { _creatorState.obs.disconnect(); _creatorState.obs = null; }
    modalCreatorId = null;
    modalCreator   = null;
    _creatorState.videos = [];
  });

  async function _loadModalVideos(channelId) {
    const { ok, data } = await apiJSON(`${API}/channels/${channelId}/videos`);
    if (!ok || modalCreatorId !== channelId) return;
    _creatorState.videos = data.map(v => ({ ...v, description: v.title || v.description,
      type: (v.content_type === 'image' || _isImage(v)) ? 'photo' : 'video' }));

    if (modalPendingHighlight) {
      const { videoId, filter: mFilter, sortField, sortDir } = modalPendingHighlight;
      modalPendingHighlight = null;
      _creatorState.view    = 'list';
      _creatorState.filter  = mFilter;
      _creatorState.sort    = { field: sortField, dir: sortDir };
      _mRenderColHdrs(MODAL_CFG);
      _mRenderToolbar(MODAL_CFG, _creatorState.videos);
      _mRenderList(MODAL_CFG);
      const row = document.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('video-row-highlight');
        row.addEventListener('mouseenter', () => row.classList.remove('video-row-highlight'), { once: true });
      }
    } else {
      const historyOpen = _el('PhistPanel').style.display !== 'none';
      if (!historyOpen) {
        _mRenderToolbar(MODAL_CFG, _creatorState.videos);
        _mRenderList(MODAL_CFG);
      }
    }
  }

  function _renderModalHeader(ch) {
    const isInactive  = ch.tracking_enabled === 0;
    const { cls: trackingCls, label: trackingLbl } = _trackingBadge(ch.tracking_enabled);
    const checked     = _fmtLastChecked(ch.last_checked);
    const extUrl      = cfg.profileUrl(esc(ch.handle));
    const busy        = runQueue.includes(ch.channel_id) || runCurrent === ch.channel_id;
    const runDisabled = busy ? 'disabled' : '';
    const platformLabel = (PLATFORMS.find(p => p.id === cfg.id) || {}).label || cfg.id;

    _el('ModalHeader').innerHTML = `
      <div class="modal-avatar-wrap">
        <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
        ${ch.avatar_cached ? `<img class="modal-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar" alt=""
             onerror="this.style.display='none'"
             onclick="openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')">` : ''}
      </div>
      <div class="modal-user-body">
        <div class="modal-name-row">
          <span class="modal-name">${esc(ch.display_name || ch.handle)}</span>
          <span class="account-status ${trackingCls}">${trackingLbl}</span>
          <label class="tracking-toggle" title="${isInactive ? `${ItemsCap} tracking off` : `${ItemsCap} tracking on`}">
            <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="${P}SetTracking('${esc(ch.channel_id)}', this.checked)">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">Track ${ITEMS}</span>
          </label>
        </div>
        <div class="modal-handle">
          <a href="${extUrl}" target="_blank" rel="noopener" class="tt-link">@${esc(ch.handle)}</a>
          <span style="color:var(--muted);font-size:12px;margin-left:6px">${esc(ch.channel_id)}</span>
        </div>
        <div class="modal-stats-row">
          ${ch.subscriber_count != null ? `<span><strong>${(ch.subscriber_count || 0).toLocaleString()}</strong> ${cfg.subLabelModal}</span>` : ''}
          ${ch.video_count != null ? `<span><strong>${(ch.video_count || 0).toLocaleString()}</strong> on ${esc(platformLabel)}</span>` : ''}
          <span><strong>${ch.video_total || 0}</strong> saved locally</span>
          ${(ch.video_deleted || 0) > 0 ? `<span style="color:var(--red)"><strong>${ch.video_deleted}</strong> deleted</span>` : ''}
          ${ch.video_undeleted ? `<span style="color:var(--yellow)"><strong>${ch.video_undeleted}</strong> restored</span>` : ''}
          ${ch.profile_history_count ? `<span style="cursor:pointer;text-decoration:underline dotted" onclick="${P}OpenProfileHistory()" title="Open profile change history"><strong>${ch.profile_history_count}</strong> profile ${ch.profile_history_count === 1 ? 'update' : 'updates'}</span>` : ''}
          <span style="color:var(--muted)">${esc(checked)}</span>
        </div>
        ${ch.description ? `<div class="modal-bio" onclick="this.classList.toggle('expanded')">${esc(ch.description)}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
          <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="${P}ToggleStarModal('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
          <button id="${P}ModalRunQuickBtn" class="btn-run" ${runDisabled} onclick="${P}RunCreatorQuick('${esc(ch.channel_id)}')">${_refreshIcon} Quick</button>
          <button id="${P}ModalRunFullBtn" class="btn-run" ${runDisabled} onclick="${P}RunCreator('${esc(ch.channel_id)}')">${_refreshIcon} Full</button>
          <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>${P}RunCreatorProfile('${esc(ch.channel_id)}')},{label:'Add note',onclick:()=>${P}ToggleModalNote()},{label:'Remove',danger:true,onclick:()=>{${P}CloseModal();${P}RemoveCreator('${esc(ch.channel_id)}','@${esc(ch.handle)}')}}])">&#x2022;&#x2022;&#x2022;</button>
        </div>
        <div id="${P}ModalNoteArea" style="display:${ch.comment ? '' : 'none'};margin-top:8px">
          <textarea placeholder="Add a note about this ${CREATOR}…"
            onblur="${P}SaveComment('${esc(ch.channel_id)}', this.value)"
            style="width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;
                   background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                   color:var(--text);font-family:inherit;line-height:1.5"
          >${esc(ch.comment || '')}</textarea>
        </div>
      </div>
    `;

    if (cfg.hasBanner) {
      const bannerEl = _el('ModalBanner');
      if (bannerEl) {
        if (ch.banner_cached) {
          bannerEl.style.display = '';
          bannerEl.style.backgroundImage = `url('${API}/channels/${esc(ch.channel_id)}/banner')`;
          bannerEl.style.cursor = 'pointer';
          bannerEl.onclick = () => openImgModalUrl(`${API}/channels/${ch.channel_id}/banner`);
        } else {
          bannerEl.style.display = 'none';
          bannerEl.style.backgroundImage = '';
          bannerEl.style.cursor = '';
          bannerEl.onclick = null;
        }
      }
    }
  }

  X('SaveComment', async (id, value) => {
    const ok = await _saveCreatorComment(`${API}/channels`, id, value, creators, 'channel_id');
    if (ok && modalCreator && modalCreator.channel_id === id) modalCreator.comment = value.trim() || null;
  });

  X('ToggleStarModal', async id => {
    await _creatorToggleStar(`${API}/channels`, id, creators, 'channel_id', renderCreators);
    if (modalCreator && modalCreator.channel_id === id) _renderModalHeader(modalCreator);
  });

  X('ToggleModalNote', () => {
    const area = _el('ModalNoteArea');
    if (!area) return;
    const show = area.style.display === 'none';
    area.style.display = show ? '' : 'none';
    if (show) area.querySelector('textarea')?.focus();
  });

  // Modal engine delegates

  X('SetModalFilter',     f => _mSetFilter(MODAL_CFG, f));
  X('SetModalTypeFilter', t => _mSetTypeFilter(MODAL_CFG, t));
  X('ToggleModalToolbar', () => _mToggleToolbar(MODAL_CFG));
  X('SetModalSort',       f => _mSetSort(MODAL_CFG, f));
  X('SetModalView', view => {
    _creatorState.view = view;
    const toolbar = _el('ModalToolbar');
    toolbar.querySelectorAll('[data-view-key]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.viewKey === view);
    });
    toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
    _mRenderList(MODAL_CFG);
  });
  X('OnModalSearch', val => {
    _creatorState.search = val.trim();
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
    _mRenderList(MODAL_CFG);
  });

  // ── Profile history panel ─────────────────────────────────────────────────

  X('OpenProfileHistory', async field => {
    if (!modalCreatorId) return;
    const panel   = _el('PhistPanel');
    const vidList = _el('ModalVideoList');
    if (!panel || !vidList) return;

    vidList.style.display = 'none';
    panel.style.display   = '';

    phistField = field ? new Set([field]) : new Set();
    phistChId  = modalCreatorId;

    panel.innerHTML = '<div class="vlist-loading">Loading history…</div>';

    const { ok, data } = await apiJSON(`${API}/channels/${modalCreatorId}/profile-history`);
    if (!ok || phistChId !== modalCreatorId) return;
    phistData = data;
    _renderPhistPanel();
  });

  X('CloseProfileHistory', () => {
    const panel   = _el('PhistPanel');
    const vidList = _el('ModalVideoList');
    if (panel)   panel.style.display   = 'none';
    if (vidList) vidList.style.display = '';
    phistData  = [];
    phistField = new Set();
  });

  function _renderPhistPanel() {
    const panel = _el('PhistPanel');
    if (!panel) return;

    const entries = phistField.size
      ? phistData.filter(e => phistField.has(e.field))
      : phistData;

    const fields  = [...new Set(phistData.map(e => e.field))];
    const fieldPills = fields.map(f => {
      const active = phistField.has(f) ? ' active' : '';
      const label  = FIELD_LABELS[f] || f;
      return `<button class="filter-pill${active}" onclick="${P}PhistSetField('${esc(f)}')">${label}</button>`;
    }).join('');

    const ch = modalCreator;

    panel.innerHTML = `
      <div class="phist-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
        <div class="filter-pills multi" style="flex:1">${fieldPills}</div>
        <button class="btn-ghost" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="${P}CloseProfileHistory()">Back to ${ITEMS}</button>
      </div>
      ${entries.length
        ? entries.map(e => _phistEntryHtml(e, ch)).join('')
        : `<div style="color:var(--muted);font-size:13px;padding:12px 0">No profile changes recorded${phistField.size ? ' for the selected fields' : ''}.</div>`}
    `;
    panel.querySelectorAll('.filter-pills').forEach(_placeGlider);
  }

  function _phistEntryHtml(e, ch) {
    const dateStr    = _dtFmt.format(new Date(e.changed_at * 1000));
    const fieldLabel = FIELD_LABELS[e.field] || e.field;

    if (e.field === 'avatar') {
      const chId   = esc(ch ? ch.channel_id : phistChId || '');
      const oldSrc = `${API}/channels/${chId}/avatar-history/${encodeURIComponent(e.old_value)}`;
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
          ${img(`${API}/channels/${chId}/avatar`, 'Current')}
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

  X('PhistSetField', field => {
    phistField.has(field) ? phistField.delete(field) : phistField.add(field);
    _renderPhistPanel();
  });

  // ── Tracking view (creators / log) ────────────────────────────────────────

  let trackingView = 'creators';

  X('SetTrackingView', view => {
    trackingView = view;
    const searchEl = _el('Search');
    if (searchEl) {
      searchEl.style.display = view === 'log' ? 'none' : '';
      if (view !== 'log') searchEl.value = '';
    }
    const countEl = _el('Count');
    if (countEl) countEl.style.display = view === 'log' ? 'none' : '';
    search = '';
    _el('TvCreators').classList.toggle('active', view === 'creators');
    _el('TvLog').classList.toggle('active', view === 'log');
    const grid   = _el('Grid');
    const logPnl = _el('LogPanel');
    const ctrl   = _el('Controls');
    if (grid)   grid.style.display   = view === 'creators' ? '' : 'none';
    if (logPnl) logPnl.style.display = view === 'log'      ? '' : 'none';
    if (ctrl)   ctrl.style.display   = view === 'creators' ? '' : 'none';
    if (view === 'creators') renderCreators();
    _placeGlider(_el('TvCreators').closest('.filter-pills'));
  });

  // ── Keyboard handler (Escape) ─────────────────────────────────────────────

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Overlay modals (carousel, image, video) sit on top of the creator modal
    // and close themselves via their own handler; don't close both at once.
    for (const id of ['carouselModal', 'imgModal', 'vidModal']) {
      if (document.getElementById(id)?.style.display !== 'none') return;
    }
    if (_el('ModalBackdrop')?.style.display !== 'none') {
      window[`${P}CloseModal`]();
    }
  }, true);

  // ── Init ──────────────────────────────────────────────────────────────────

  loadCreators();
  loadStatus();
  loadStats();
  loadRecent();
  loadQueue();

  setInterval(loadStatus,   5000);
  setInterval(loadCreators, 15000);
  setInterval(loadStats,    60000);
  setInterval(loadRecent,   30000);
  setInterval(loadQueue,     3000);
}
