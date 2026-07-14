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

  const EXTRA_FILTER_GROUPS = cfg.extraFilterGroups || [];
  const EXTRA_VIEWS         = cfg.extraViews || [];

  // ── Section HTML ──────────────────────────────────────────────────────────

  const _triggerIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12C21 16.9706 16.9706 21 12 21C9.69494 21 7.59227 20.1334 6 18.7083L3 16M3 12C3 7.02944 7.02944 3 12 3C14.3051 3 16.4077 3.86656 18 5.29168L21 8M3 21V16M3 16H8M21 3V8M21 8H16"/></svg>`;

  function _sectionHtml() {
    return `
  <div class="add-bar">
    <div class="add-bar-input-row">
      <div class="add-bar-input" id="${P}HandleInput" contenteditable="true" role="textbox"
           aria-label="${cfg.addAriaLabel}" data-placeholder="${cfg.addPlaceholder}" spellcheck="false"></div>
      <button class="add-bar-paste-btn" onclick="${P}AddPaste()" aria-label="Paste">Paste</button>
    </div>
    <button class="btn-primary" onclick="${P}AddCreator()">Add</button>
  </div>

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

  <div class="mid-panels">
  <div class="panel-card">
    <div class="panel-header"><span class="section-title">Add history</span></div>
    <div class="panel-body" style="padding:0">
      <div class="add-history" id="${P}AddHistory"></div>
    </div>
  </div>
  <div class="panel-card loops-card">
    <div class="panel-header" style="position:relative">
      <span class="section-title">${cfg.loopsTitle || 'Loop'}</span>
      ${cfg.extraLoopHtml ? `<div class="filter-pills loop-view-toggle">
        <button class="filter-pill active" id="${P}LvMain"  onclick="${P}SetLoopView('main')">${CreatorsCap}</button>
        <button class="filter-pill"        id="${P}LvExtra" onclick="${P}SetLoopView('extra')">${cfg.extraLoopLabel || 'More'}</button>
      </div>` : ''}
    </div>
    <div class="panel-body" style="padding:12px 16px;flex-direction:column;gap:12px">
      <div class="loop-block" id="${P}LoopBlockMain">
        <div class="loop-block-header">
          <span class="loop-section-label">${cfg.loopLabel}</span>
          <span style="display:flex;align-items:center;gap:6px">
            <span id="${P}LoopNext" class="loop-next"></span>
            <button class="loop-pause-btn" id="${P}PauseBtn" onclick="${P}TogglePause()" title="Pause scheduled sessions">${_pauseIcon}</button>
          </span>
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
      ${cfg.extraLoopHtml ? `<div id="${P}LoopBlockExtra" style="display:none">${cfg.extraLoopHtml}</div>` : ''}
    </div>
  </div>
  </div>

  <section>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
      <div class="tracking-tab-row" style="display:flex;align-items:center;gap:8px;">
        <div class="filter-pills">
          <button class="filter-pill active" id="${P}TvCreators" onclick="${P}SetTrackingView('creators')">${CreatorsCap}</button>
          ${EXTRA_VIEWS.map(v => `<button class="filter-pill" id="${P}Tv_${v.key}" onclick="${P}SetTrackingView('${v.key}')">${v.label}</button>`).join('')}
          <button class="filter-pill"        id="${P}TvLog"      onclick="${P}SetTrackingView('log')">Log</button>
        </div>
        <span id="${P}Count" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
        <input id="${P}Search" class="tracking-search" type="search" placeholder="Search…" oninput="${P}OnSearch(this.value)"
               style="width:160px;font-size:12px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);outline:none;">
      </div>
      <div id="${P}Controls" class="filter-control-group">
        ${EXTRA_FILTER_GROUPS.map(g => `
        <div class="filter-row">
          <span class="filter-row-label">${g.label}</span>
          <div class="filter-pills multi">
            ${g.options.map(o => `<button class="filter-pill${(g.defaults || []).includes(o.key) ? ' active' : ''}" id="${P}f_${g.key}_${o.key}" onclick="${P}SetFilter('${g.key}','${o.key}')">${o.label}</button>`).join('')}
          </div>
        </div>`).join('')}
        <div class="filter-row">
          <span class="filter-row-label">Tracking</span>
          <div class="filter-pills multi">
            <button class="filter-pill active" id="${P}fStatActive" onclick="${P}SetFilter('stat','active')">Active</button>
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
              <option value="last_checked">Last checked</option>
              <option value="last_saved">Last saved</option>
            </select>
            <button class="sort-dir-btn" id="${P}SortDirBtn" onclick="${P}ToggleSortDir()">A → Z</button>
            <button class="sort-dir-btn" onclick="${P}ResetFilters()" title="Reset filters and sort">Reset</button>
          </div>
        </div>
      </div>
      ${EXTRA_VIEWS.map(v => `<div id="${P}Controls_${v.key}" class="filter-control-group" style="display:none">${v.controlsHtml || ''}</div>`).join('')}
    </div>
    <div class="users-grid" id="${P}Grid">
      ${Array(6).fill('<div class="user-card skeleton-card" aria-hidden="true"></div>').join('')}
    </div>
    ${EXTRA_VIEWS.map(v => `<div class="users-grid" id="${P}Grid_${v.key}" style="display:none"><div class="empty-state">${v.emptyLabel || ''}</div></div>`).join('')}
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
        <div id="${P}LogActivityBar" class="log-activity-bar"></div>
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
  // Default filter: hide inactive creators; Starred stays off
  const _defaultFilter = () => {
    const f = { stat: new Set(['active']), star: new Set() };
    EXTRA_FILTER_GROUPS.forEach(g => { f[g.key] = new Set(g.defaults || []); });
    return f;
  };
  let filter         = _defaultFilter();
  let search         = '';
  const addToasts    = _makeAddToasts(() => loadCreators());
  let runQueue       = [];
  let runCurrent     = null;
  let loopRunning    = false;
  let loopPaused     = false;
  let currentCreator = null;
  let pendingRescans = {};     // {channel_id: fires_at_unix_secs} for large-spike midpoint re-scans
  let logSeq           = 0;    // log_seq from last server response (monotonic, resets on app restart)
  let logClearSeq      = 0;    // lines before this seq were cleared; don't re-render them
  let logClearRestored = false;
  let sleepUntil     = null;   // Unix timestamp (ms) when current sleep ends; null = no sleep
  let sleepNext      = null;   // Label for what runs after the sleep
  let nextRuns       = [];     // [{iso, label}] upcoming scheduled runs for the activity bar
  let cleanupPoll    = null;

  const SORT_DIR_LABELS = {
    handle:           { asc: 'A → Z',        desc: 'Z → A'        },
    display_name:     { asc: 'A → Z',        desc: 'Z → A'        },
    subscriber_count: { asc: 'Low → High',   desc: 'High → Low'   },
    video_total:      { asc: 'Low → High',   desc: 'High → Low'   },
    video_deleted:    { asc: 'Low → High',   desc: 'High → Low'   },
    added_at:         { asc: 'Oldest first', desc: 'Newest first' },
    last_checked:     { asc: 'Oldest first', desc: 'Newest first' },
    last_saved:       { asc: 'Oldest first', desc: 'Newest first' },
  };

  // ── Video render helpers ──────────────────────────────────────────────────

  const thumbBadge = cfg.thumbBadge || (() => _playBadge);

  // Photo posts (e.g. Twitter images) are stored as .avif/.jpg; open them in the
  // image modal and download them under their real extension, not as .mp4.
  const _IMG_EXTS = ['avif', 'jpg', 'jpeg', 'png', 'webp', 'gif'];
  const _mediaExt = v => ((v.file_path || '').split('.').pop() || '').toLowerCase();
  const _isImage  = v => _IMG_EXTS.includes(_mediaExt(v));
  // Multi-media posts store {id}_01.ext as file_path with siblings on disk.
  // The videos endpoint annotates `multi` from disk (single photos are also
  // stored numbered, so the filename alone can't distinguish the two).
  const _isMulti  = v => v.multi !== undefined
    ? !!v.multi
    : (((v.file_path || '').split('/').pop()) || '').startsWith(`${v.video_id}_`);

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

  function _defaultVideoActionBtns(v) {
    const id = esc(v.video_id);
    if (v.file_path) {
      const ext  = _mediaExt(v) || 'mp4';
      const name = _isMulti(v) ? (v.file_path.split('/').pop()) : `${id}.${ext}`;
      return `<a class="play-btn" href="${API}/videos/${id}/file" download="${esc(name)}"
               onclick="event.stopPropagation()" title="${_isMulti(v) ? 'Download first file' : 'Download'}">${_dlIcon}</a>`;
    }
    return '';
  }

  const _videoActionBtns = cfg.videoActionBtnsFn || _defaultVideoActionBtns;

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
    { field: null,            label: cfg.titleColLabel || 'Title' },
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
    // Date plus time of day by default; platforms whose API only provides a
    // calendar date (YouTube) set cfg.uploadDateOnly
    uploadDateFmt:  cfg.uploadDateOnly ? fmtDateOnly : fmtDateShort,
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

  const _statsRows = cfg.statsRows || (s => [
    { label: `Tracked ${CREATORS}`, value: (s.channel_count || 0).toLocaleString() },
    { label: `Saved ${ITEMS}`,      value: (s.saved_count   || 0).toLocaleString() },
    { label: 'Deleted',             value: (s.deleted_count || 0).toLocaleString() },
    { label: 'Latest saved',        value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '—' },
    { label: 'Total views',         value: _fmtLarge(s.total_views || 0) },
    { label: 'Storage',             value: _fmtBytes(s.media_size_bytes || 0) },
  ]);

  function renderStats(s) {
    _renderStatGrid(`${P}StatsGrid`, _statsRows(s));
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
    'bans':            'All Banned Accounts',
  };

  const _nameStyle = r => r.enabled === 0 ? 'style="color:var(--text-dim)"'
    : r.starred ? 'style="color:var(--yellow)"'
    : r.account_status === 'banned' ? 'style="color:var(--red)"' : '';

  // Onclick string for a saved/deleted group: single-item groups jump straight
  // to the item; soft-disabled creators route through the platform fallback
  // (e.g. TikTok sound-discovered authors open the sound modal).
  function _recentOnclick(item, kind) {
    if (item.enabled === 0) return (cfg.recentFallback && cfg.recentFallback(item)) || '';
    if (item.count === 1 && item.video_id) {
      return kind === 'saved'
        ? `${P}OpenModalAndHighlight('${esc(item.channel_id)}','${esc(item.video_id)}','all','download_date','desc')`
        : `${P}OpenModalAndHighlight('${esc(item.channel_id)}','${esc(item.video_id)}')`;
    }
    return `${P}OpenModal('${esc(item.channel_id)}')`;
  }

  function _renderSavedRow(g, now) {
    const row = document.createElement('div');
    row.className = 'recent-entry';
    row.title = `Open @${g.handle}`;
    row.setAttribute('onclick', _recentOnclick(g, 'saved'));
    row.innerHTML = `
      <span class="recent-date">${_recentDate(g.download_date, now)}</span>
      <span class="recent-name" ${_nameStyle(g)}>@${esc(g.handle)}</span>
      <span class="recent-detail">${g.count}x</span>`;
    return row;
  }

  function _renderDeletedGroupRow(g, now) {
    const row = document.createElement('div');
    row.className = 'recent-entry';
    row.title = `Open @${g.handle}`;
    row.setAttribute('onclick', _recentOnclick(g, 'deleted'));
    row.innerHTML = `
      <span class="recent-date">${_recentDate(g.deleted_at, now)}</span>
      <span class="recent-name" ${_nameStyle(g)}>@${esc(g.handle)}</span>
      <span class="recent-detail">${g.count}x</span>`;
    return row;
  }

  function _renderOtherRow(item, type, now) {
    const row = document.createElement('div');
    row.className = 'recent-entry';
    if (type === 'deletions') {
      row.title = `Open @${item.handle}`;
      row.setAttribute('onclick', _recentOnclick({ ...item, count: 1 }, 'deleted'));
      row.innerHTML = `
        <span class="recent-date">${_recentDate(item.deleted_at, now)}</span>
        <span class="recent-name" ${_nameStyle(item)}>@${esc(item.handle)}</span>
        <span class="recent-detail">${esc((item.video_id || '').slice(0, 11))}</span>`;
    } else if (type === 'bans') {
      row.title = `Open @${item.handle}`;
      row.onclick = () => window[`${P}OpenModal`](item.channel_id);
      row.innerHTML = `
        <span class="recent-date">${_recentDate(item.banned_at, now)}</span>
        <span class="recent-name" ${item.starred ? 'style="color:var(--yellow)"' : 'style="color:var(--red)"'}>@${esc(item.handle)}</span>
        <span class="recent-detail" style="color:var(--red)">Banned</span>`;
    } else {
      const label = FIELD_LABELS[item.field] || item.field;
      row.title = `Open @${item.handle} · ${label} history`;
      row.onclick = () => window[`${P}OpenModalWithHistory`](item.channel_id, item.field);
      row.innerHTML = `
        <span class="recent-date">${_recentDate(item.changed_at, now)}</span>
        <span class="recent-name" ${_nameStyle(item)}>@${esc(item.handle)}</span>
        <span class="recent-detail">${esc(label)}</span>`;
    }
    return row;
  }

  X('OpenRecentLog', type => {
    _openRecentLogModal(type, {
      apiBase:       `${API}/recent`,
      titles:        RECENT_LOG_TITLES,
      groupKey:      'channel_id',
      renderSaved:   _renderSavedRow,
      renderGrouped: _renderDeletedGroupRow,
      renderOther:   _renderOtherRow,
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
      left += data.deletions.map(d =>
        `<div class="recent-entry" onclick="${_recentOnclick(d, 'deleted')}" title="Open @${esc(d.handle)}">
          <span class="recent-date">${_recentDate(d.deleted_at, now)}</span>
          <span class="recent-name" ${_nameStyle(d)}>@${esc(d.handle)}</span>
          <span class="recent-detail">${d.count}x</span>
        </div>`
      ).join('');
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
          <span class="recent-name" ${_nameStyle(p)}>@${esc(p.handle)}</span>
          <span class="recent-detail">${esc(FIELD_LABELS[p.field] || p.field)}</span>
        </div>`
      ).join('');
    } else {
      left += `<div class="recent-empty">No profile changes recorded yet</div>`;
    }
    left += `</div>`;

    if (cfg.hasBans) {
      left += `<div class="recent-section">`;
      left += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="${P}OpenRecentLog('bans')" title="View all banned accounts">Recently banned</div>`;
      if (data.bans && data.bans.length) {
        const b = data.bans[0];
        left += `<div class="recent-entry" onclick="${P}OpenModal('${esc(b.channel_id)}')" title="Open @${esc(b.handle)}">
          <span class="recent-date">${_recentDate(b.banned_at, now)}</span>
          <span class="recent-name" ${b.starred ? 'style="color:var(--yellow)"' : 'style="color:var(--red)"'}>@${esc(b.handle)}</span>
          <span class="recent-detail" style="color:var(--red)">Banned</span>
        </div>`;
      } else {
        left += `<div class="recent-empty">No banned accounts</div>`;
      }
      left += `</div>`;
    }

    leftEl.innerHTML = left;

    let right = '';
    right += `<div class="recent-section">`;
    right += `<div class="recent-section-hdr" style="margin-bottom:2px" onclick="${P}OpenRecentLog('saved')" title="View all saved ${ITEMS}">Recently saved</div>`;
    if (data.saved && data.saved.length) {
      right += data.saved.map(g =>
        `<div class="recent-entry" onclick="${_recentOnclick(g, 'saved')}" title="Open @${esc(g.handle)}">
          <span class="recent-date">${_recentDate(g.download_date, now)}</span>
          <span class="recent-name" ${_nameStyle(g)}>@${esc(g.handle)}</span>
          <span class="recent-detail">${g.count}x</span>
        </div>`
      ).join('');
    } else {
      right += `<div class="recent-empty">No ${ITEMS} saved yet</div>`;
    }
    right += `</div>`;

    rightEl.innerHTML = right;
  }

  let _lastRecentJson = null;
  const loadRecent = X('LoadRecent', async () => {
    const { ok, data } = await apiJSON(`${API}/recent`);
    if (!ok) return;
    renderRecent(data);
    // Warm the recent-log modal cache so the expanded lists open instantly;
    // refresh only when the panel data actually changed
    const j = JSON.stringify(data);
    if (j !== _lastRecentJson) {
      _lastRecentJson = j;
      _prefetchRecentLog(`${API}/recent`,
        ['saved', 'deletions', 'profile-changes', ...(cfg.hasBans ? ['bans'] : [])]);
    }
  });

  // ── Loop status ───────────────────────────────────────────────────────────

  const _el = id => document.getElementById(P + id);

  function renderStatus(state) {
    loopRunning    = state.loop_running;
    currentCreator = state.loop_current_channel;
    runQueue       = state.run_queue  || [];
    runCurrent     = state.run_current || null;
    pendingRescans = state.pending_rescans || {};
    sleepUntil     = state.loop_sleep_until != null ? state.loop_sleep_until * 1000 : null;
    sleepNext      = state.loop_sleep_next || null;
    nextRuns       = (cfg.nextRunCandidates
      ? cfg.nextRunCandidates(state)
      : [state.loop_next ? { iso: state.loop_next, label: `${CREATOR} loop` } : null]
    ).filter(Boolean);

    const meta = _el('LoopMeta');
    if (meta) {
      const parts = [];
      if (state.loop_last_start) parts.push(`Last: ${fmt.rel(state.loop_last_start)}`);
      else parts.push('Never run');
      const comp = state.loop_last_session_completed, total = state.loop_last_session_total;
      if (comp != null && total != null) parts.push(`${comp}/${total} ${CREATORS}`);
      if (state.loop_last_new_videos != null) parts.push(`${state.loop_last_new_videos} new`);
      if (state.loop_last_duration_secs != null) parts.push(fmt.dur(state.loop_last_duration_secs));
      meta.textContent = parts.join(' · ');
    }
    loopPaused = !!state.loop_paused;
    const next = _el('LoopNext');
    if (next) next.textContent = loopRunning
      ? 'Running…'
      : loopPaused
        ? 'Paused'
        : (state.loop_next ? `Next: ${fmt.relFuture(state.loop_next)}` : '');
    _renderPauseState(_el('PauseBtn'), next, loopPaused);
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
      const anyActive = loopRunning || !!runCurrent || !!(cfg.statusActive && cfg.statusActive(state));
      badge.className  = `status-badge${anyActive ? ' running' : ''}`;
      text.textContent = anyActive
        ? (currentCreator ? `Downloading @${currentCreator}` : 'Running…')
        : 'Idle';
    }

    _renderLogs(state.logs, state.log_seq);
    if (cfg.onStatus) cfg.onStatus(state);
    updateRunStates();
  }

  // Incremental log rendering keyed on the server's monotonic log_seq: only
  // lines newer than the last seen seq are appended, and a persisted clear
  // watermark survives reloads. log_seq resets when the app restarts; a
  // stale watermark above the counter is dropped so the console shows again.
  function _renderLogs(lines, seq) {
    if (!lines?.length || seq == null) return;
    if (!logClearRestored) {
      logClearRestored = true;
      const saved = localStorage.getItem(`${P}-logClearSeq`);
      if (saved != null) logClearSeq = parseInt(saved, 10) || 0;
    }
    if (logClearSeq > seq) {
      logClearSeq = 0;
      localStorage.removeItem(`${P}-logClearSeq`);
    }
    if (seq <= logSeq) return;  // nothing new

    // Sequence number of lines[i] = seq - lines.length + i
    const bufStart = seq - lines.length;
    const startIdx = Math.max(0, Math.max(logSeq, logClearSeq) - bufStart);
    const newLines = lines.slice(startIdx);
    logSeq = seq;
    if (!newLines.length) return;

    const body = _el('LogBody');
    if (!body) return;
    body.insertAdjacentHTML('beforeend',
      newLines.map(l => `<div class="log-line ${_logLineClass(l)}">${esc(l)}</div>`).join(''));
    if (_el('AutoScroll')?.checked !== false) body.scrollTop = body.scrollHeight;
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

  function _tickActivityBar() {
    const bar = _el('LogActivityBar');
    if (!bar) return;
    const dur = secs => {
      const m = Math.floor(secs / 60), s = secs % 60;
      return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    if (sleepUntil) {
      const rem = Math.max(0, Math.round((sleepUntil - Date.now()) / 1000));
      bar.innerHTML = `sleeping ${dur(rem)}`
        + (sleepNext ? ` <span class="lab-next">-- up next: ${esc(sleepNext)}</span>` : '');
      return;
    }
    const now = Date.now();
    const candidates = nextRuns
      .map(c => ({ ts: new Date(c.iso).getTime(), label: c.label }))
      .filter(c => c.ts > now)
      .sort((a, b) => a.ts - b.ts);
    if (candidates.length) {
      const rem = Math.max(0, Math.round((candidates[0].ts - now) / 1000));
      bar.innerHTML = `waiting ${dur(rem)} <span class="lab-next">-- up next: ${esc(candidates[0].label)}</span>`;
    } else {
      bar.innerHTML = 'idle';
    }
  }

  X('ClearLog', () => {
    logClearSeq = logSeq;
    localStorage.setItem(`${P}-logClearSeq`, String(logSeq));
    const logBody = _el('LogBody');
    if (logBody) logBody.innerHTML = '';
  });

  // ── Loop triggers ─────────────────────────────────────────────────────────

  const _triggerToast = _makeTriggerToast(CREATOR);
  X('TriggerNext',    () => _triggerLoop(`${P}TriggerNextBtn`,    `${API}/trigger/next`, 'Could not trigger loop', _triggerToast));
  X('TriggerStarred', () => _triggerLoop(`${P}TriggerStarredBtn`, `${API}/trigger`,      'Could not trigger loop', _triggerToast));
  X('TriggerHalf',    () => _triggerLoop(`${P}TriggerHalfBtn`,    `${API}/trigger/half`, 'Could not trigger loop', _triggerToast));
  X('TriggerAll',     () => _triggerLoop(`${P}TriggerAllBtn`,     `${API}/trigger/all`,  'Could not trigger loop', _triggerToast));

  X('TogglePause', async () => {
    const paused = !loopPaused;
    const { ok } = await apiJSON(`${API}/pause`, {
      method: 'POST',
      body: JSON.stringify({ paused }),
    });
    if (!ok) { showToast('Could not update pause state.', { type: 'error' }); return; }
    loopPaused = paused;
    _renderPauseState(_el('PauseBtn'), _el('LoopNext'), paused);
    showToast(paused ? `${cfg.loopLabel} paused: scheduled sessions will be skipped.` : `${cfg.loopLabel} resumed.`);
    loadStatus();
  });

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

  // Loops panel view toggle (platforms with a second loop, e.g. TikTok sounds)
  X('SetLoopView', which => {
    _el('LoopBlockMain').style.display  = which === 'extra' ? 'none' : '';
    _el('LoopBlockExtra').style.display = which === 'extra' ? '' : 'none';
    _el('LvMain').classList.toggle('active',  which !== 'extra');
    _el('LvExtra').classList.toggle('active', which === 'extra');
    _placeGlider(_el('LvMain').closest('.filter-pills'));
    localStorage.setItem(`${P}-loopView`, which);
  });
  if (cfg.extraLoopHtml && localStorage.getItem(`${P}-loopView`) === 'extra') {
    window[`${P}SetLoopView`]('extra');
  }

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
    const clean = this.textContent.replace(/[^a-zA-Z0-9_.@:/?=&%-]/g, '');
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

  // Long input: keep the end of the text visible when the field loses focus,
  // like a browser URL bar
  handleInput.addEventListener('blur', function() {
    this.scrollLeft = this.scrollWidth;
  });

  X('AddCreator', async () => {
    const raw = handleInput.textContent.trim();
    if (!raw) return;
    handleInput.textContent = '';
    handleInput.focus();

    // Platform hook: returns true when it fully handled the input
    // (e.g. TikTok routing sound IDs/URLs to the sound tracker)
    if (cfg.addHandler && await cfg.addHandler(raw, addToasts)) return;

    const { ok, data } = await apiJSON(`${API}/channels`, {
      method: 'POST',
      body: JSON.stringify({ handle: raw }),
    });
    if (ok) addToasts.start(data.handle || raw.replace(/^@/, ''));
    else showToast(data.error || `Could not add ${CREATOR}.`, { type: 'error' });
  });

  X('AddPaste', async () => {
    try {
      handleInput.textContent = (await navigator.clipboard.readText()).trim();
    } catch { /* clipboard permission denied; leave the field as is */ }
    handleInput.focus();
  });

  let _queueSig = null;
  const loadQueue = X('LoadQueue', async () => {
    const { ok, data } = await apiJSON(`${API}/queue`);
    if (!ok) return;
    addToasts.sync(data);
    // Any queue state change (new pending, resolution, retry) is also a
    // change to the top of the Add history, so refresh it.
    const sig = JSON.stringify(data);
    if (sig !== _queueSig) {
      if (_queueSig !== null) loadAddHistory(true);
      _queueSig = sig;
    }
  });

  // ── Add history panel ─────────────────────────────────────────────────────

  const _ah = { items: [], hasMore: false, obs: null, loading: false };

  function _ahRow(e) {
    const status = e.status === 'pending'
      ? '<span class="ah-status ah-pending">looking up…</span>'
      : e.status === 'error'
        ? `<span class="ah-status ah-error" title="${esc(e.error_detail || '')}">${esc(e.error_kind || 'error')}</span>`
        : '<span class="ah-status ah-ok">added</span>';
    const actions = e.status === 'error'
      ? `<span class="ah-actions">
           <button class="ah-btn" title="Try again" onclick="${P}AhRetry(${e.id})">${_triggerIcon}</button>
           <button class="ah-btn ah-btn-danger" title="Discard" onclick="${P}AhDiscard(${e.id})">✕</button>
         </span>`
      : '';
    return `<div class="ah-row">
      <span class="ah-handle">@${esc(e.handle)}</span>
      ${status}
      <span class="ah-time">${fmt.rel(e.updated_at * 1000)}</span>
      ${actions}
    </div>`;
  }

  function _renderAddHistory() {
    const el = document.getElementById(`${P}AddHistory`);
    if (!el) return;
    if (_ah.obs) { _ah.obs.disconnect(); _ah.obs = null; }
    el.innerHTML = _ah.items.length
      ? _ah.items.map(_ahRow).join('')
      : `<div class="ah-empty">No ${CREATOR} adds yet</div>`;
    if (_ah.hasMore) _ah.obs = _attachSentinel(el, () => loadAddHistory(false));
  }

  const loadAddHistory = X('LoadAddHistory', async (reset) => {
    if (_ah.loading) return;
    _ah.loading = true;
    const last   = _ah.items[_ah.items.length - 1];
    const before = !reset && last ? `&before=${last.id}` : '';
    const { ok, data } = await apiJSON(`${API}/add-history?limit=30${before}`);
    _ah.loading = false;
    if (!ok) return;
    if (reset) _ah.items = [];
    _ah.items.push(...data.items);
    _ah.hasMore = data.has_more;
    _renderAddHistory();
  });

  X('AhRetry', async (id) => {
    const entry = _ah.items.find(i => i.id === id);
    if (!entry) return;
    const { ok, data } = await apiJSON(`${API}/channels`, {
      method: 'POST',
      body: JSON.stringify({ handle: entry.handle }),
    });
    if (ok) { addToasts.start(data.handle || entry.handle); loadQueue(); }
    else showToast(data.error || `Could not retry @${entry.handle}.`, { type: 'error' });
  });

  X('AhDiscard', async (id) => {
    const { ok, data } = await apiJSON(`${API}/add-history/${id}`, { method: 'DELETE' });
    if (!ok) { showToast(data.error || 'Could not discard entry.', { type: 'error' }); return; }
    _ah.items = _ah.items.filter(i => i.id !== id);
    _renderAddHistory();
  });

  // ── Filters and sort ──────────────────────────────────────────────────────

  const STAT_IDS = { active: `${P}fStatActive`, inactive: `${P}fStatInactive` };
  const STAR_IDS = { starred: `${P}fStarStarred` };

  function _filterPillIds(group) {
    if (group === 'stat') return STAT_IDS;
    if (group === 'star') return STAR_IDS;
    const g = EXTRA_FILTER_GROUPS.find(g => g.key === group);
    return g ? Object.fromEntries(g.options.map(o => [o.key, `${P}f_${g.key}_${o.key}`])) : {};
  }

  function _syncFilterPills() {
    for (const group of ['stat', 'star', ...EXTRA_FILTER_GROUPS.map(g => g.key)]) {
      Object.entries(_filterPillIds(group)).forEach(([v, id]) => {
        document.getElementById(id)?.classList.toggle('active', filter[group].has(v));
      });
    }
  }

  X('SetFilter', (group, value) => {
    const set = filter[group];
    set.has(value) ? set.delete(value) : set.add(value);
    Object.entries(_filterPillIds(group)).forEach(([v, id]) => {
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
    filter = _defaultFilter();
    search = '';
    const searchEl = _el('Search');
    if (searchEl) searchEl.value = '';
    const sel = _el('SortField');
    if (sel) sel.value = 'handle';
    _updateSortBtn();
    _syncFilterPills();
    renderCreators();
  });

  // Debounced so fast typing coalesces into one grid rebuild
  let _searchTimer = null;
  X('OnSearch', val => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      search = val.trim();
      if (trackingView === 'creators') { renderCreators(); return; }
      const extra = EXTRA_VIEWS.find(v => v.key === trackingView);
      if (extra) extra.show(search);
    }, 150);
  });

  function _filteredCreators() {
    const q = search.toLowerCase();
    return creators.filter(ch => {
      for (const g of EXTRA_FILTER_GROUPS) {
        if (filter[g.key].size && !g.test(ch, filter[g.key])) return false;
      }
      if (filter.stat.size && !filter.stat.has(ch.tracking_enabled === 0 ? 'inactive' : 'active')) return false;
      if (filter.star.has('starred') && !ch.starred) return false;
      if (q) {
        const hay = [ch.handle, ch.display_name, ch.channel_id, ch.description,
                     ...(ch.old_handles || []), ...(ch.old_display_names || []), ...(ch.old_descriptions || [])]
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
  let gridAnimated   = false;   // staggered card entrance runs once, on first populate

  // Relation and privacy pill; only rendered when the platform's adapter
  // populates the fields (engine schema has them for every platform)
  function _relationPill(ch) {
    if (ch.account_status === 'banned') return `<span class="privacy-status banned">Banned</span>`;
    if (ch.privacy_status === 'blocked') return `<span class="privacy-status banned">Blocked</span>`;
    if (ch.privacy_status === 'private_blocked') return `<span class="relation-pill">Private</span>`;
    const rel = ch.relation;
    if (rel === 2) return `<span class="relation-pill">Friends</span>`;
    if (rel === 1) return `<span class="relation-pill">Following</span>`;
    if (rel === 6) return `<span class="relation-pill">Follows you</span>`;
    if (rel === 0) return `<span class="relation-pill">No relation</span>`;
    return '';
  }

  const _isPrivateAccount = ch => ['private_accessible', 'private_blocked', 'blocked'].includes(ch.privacy_status);

  const _oldNamesTag = ch => {
    const oldNames = (ch.old_handles || []).map(n => `@${esc(n)}`).join(' · ');
    return oldNames ? ` <span class="user-old-names">· ${oldNames}</span>` : '';
  };

  function _renderCreatorCard(ch) {
    const isCurrent  = !!currentCreator && ch.handle === currentCreator;
    const isInactive = ch.tracking_enabled === 0;
    const isBanned   = ch.account_status === 'banned';
    const isBlocked  = ch.privacy_status === 'blocked';
    const isPrivBlk  = ch.privacy_status === 'private_blocked';
    const { cls: trackingCls, label: trackingLabel } = _trackingBadge(ch.tracking_enabled);
    const inQueue    = runQueue.includes(ch.channel_id);
    const isRunCur   = runCurrent === ch.channel_id;
    const runDis     = (inQueue || isRunCur) ? 'disabled' : '';

    const rescanAt = pendingRescans[ch.channel_id];
    const rescanBadge = rescanAt
      ? `<div class="user-rescan-notice" title="Isolated full re-scan scheduled to verify deletion candidates">Re-scan ${fmt.rel(new Date(rescanAt * 1000).toISOString())}</div>`
      : '';

    return `
      <div class="user-card ${P}-creator-card${isCurrent ? ' user-card-current' : ''}${isInactive || isBanned || isBlocked || isPrivBlk ? ' user-card-inactive' : ''}${isBanned || isBlocked ? ' user-card-banned' : ''}${isPrivBlk ? ' user-card-private' : ''}"
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
            <div class="user-display-name">${_isPrivateAccount(ch) ? LOCK_SVG : ''}${esc(ch.display_name || ch.handle)}</div>
            <div class="user-handle">@${esc(ch.handle)}${_oldNamesTag(ch)}</div>
            <div class="user-id-line">${esc(ch.channel_id)}</div>
          </div>
          <div class="user-badges">
            <span class="account-status ${trackingCls}">${trackingLabel}</span>
            ${_relationPill(ch)}
            ${ch.starred ? '<span class="account-status priority" title="Starred: checked on the high-priority interval">★ Priority</span>' : ''}
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

        ${rescanBadge}

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
    if (!gridAnimated) {
      gridAnimated = true;
      grid.classList.add('grid-anim');
      setTimeout(() => grid.classList.remove('grid-anim'), 700);
    }

    if (sortedCache.length > renderedCount) {
      gridObs = _attachGridSentinel(grid, _appendCreatorCards);
    }
  }

  let _creatorsSig    = null;
  let _lastGridRender = 0;
  const loadCreators = X('LoadCreators', async () => {
    const { ok, data } = await apiJSON(`${API}/channels`);
    if (!ok) return;
    // Skip the full grid rebuild when nothing changed, to avoid avatar reflow
    // and hover flicker on the 15 s poll. Rebuild once a minute regardless so
    // the relative timestamps on cards stay current.
    const sig = JSON.stringify(data);
    if (sig === _creatorsSig && Date.now() - _lastGridRender < 60000) return;
    _creatorsSig    = sig;
    _lastGridRender = Date.now();
    creators = data;
    renderCreators();
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

  // Open the modal for a creator object that may not be in the tracked list
  // (e.g. a soft-disabled sound-discovered author). renderHeaderFn overrides
  // the default header, used by the TikTok untracked-user flow.
  function _openModalRaw(ch, renderHeaderFn) {
    modalCreatorId = ch.channel_id;
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

    _el('ModalHeader').className = 'modal-header';  // reset custom header classes
    (renderHeaderFn || _renderModalHeader)(ch);
    _mRenderToolbar(MODAL_CFG, []);
    _el('ModalVideoList').innerHTML =
      `<div class="vlist-loading">Loading ${ITEMS}…</div>`;

    _loadModalVideos(ch.channel_id);
  }

  X('OpenModal', channelId => {
    const ch = creators.find(c => c.channel_id === channelId);
    if (!ch) return;
    _openModalRaw(ch);
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

    const joinStr = ch.join_date
      ? ' · Joined ' + _dtFmtMonthYear.format(new Date(ch.join_date * 1000))
      : '';

    const banCountdownStr = (() => {
      if (ch.account_status !== 'banned' || !ch.banned_at || ch.tracking_enabled === 0) return '';
      const daysLeft = 14 - Math.floor((Date.now() / 1000 - ch.banned_at) / 86400);
      if (daysLeft <= 0) return '';
      return `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} until inactive`;
    })();

    const nextCheckStr = (() => {
      if (ch.enabled === 0 || ch.tracking_enabled === 0) return '';
      if (!ch.next_check_at || ch.next_check_at * 1000 <= Date.now()) return 'Next check: at next session';
      return `Next check ${fmt.relFuture(new Date(ch.next_check_at * 1000).toISOString())}`;
    })();

    _el('ModalHeader').innerHTML = `
      <div class="modal-avatar-wrap">
        <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
        ${ch.avatar_cached ? `<img class="modal-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar" alt=""
             onerror="this.style.display='none'"
             onclick="openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')">` : ''}
      </div>
      <div class="modal-user-body">
        <div class="modal-name-row">
          <span class="modal-name">${_isPrivateAccount(ch) ? LOCK_SVG : ''}${esc(ch.display_name || ch.handle)}</span>
          ${ch.verified ? '<span class="modal-verified">✓ Verified</span>' : ''}
          <span class="account-status ${trackingCls}">${trackingLbl}</span>
          ${_relationPill(ch)}
          <label class="tracking-toggle" title="${isInactive ? `${ItemsCap} tracking off (profile changes still tracked)` : `${ItemsCap} tracking on`}">
            <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="${P}SetTracking('${esc(ch.channel_id)}', this.checked)">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">Track ${ITEMS}</span>
          </label>
        </div>
        <div class="modal-handle">
          <a href="${extUrl}" target="_blank" rel="noopener" class="tt-link">@${esc(ch.handle)}</a>${_oldNamesTag(ch)}
          <span style="color:var(--muted);font-size:12px;margin-left:6px">${esc(ch.channel_id)}${joinStr}${nextCheckStr ? ` · ${nextCheckStr}` : ''}</span>
        </div>
        ${banCountdownStr ? `<div class="modal-ban-countdown">${banCountdownStr}</div>` : ''}
        <div class="modal-stats-row">
          ${ch.subscriber_count != null ? `<span><strong>${(ch.subscriber_count || 0).toLocaleString()}</strong> ${cfg.subLabelModal}</span>` : ''}
          ${ch.following_count != null ? `<span><strong>${ch.following_count.toLocaleString()}</strong> following</span>` : ''}
          ${ch.video_count != null ? `<span><strong>${(ch.video_count || 0).toLocaleString()}</strong> on ${esc(platformLabel)}</span>` : ''}
          <span><strong>${ch.video_total || 0}</strong> saved locally</span>
          ${(ch.video_deleted || 0) > 0 ? `<span style="color:var(--red)"><strong>${ch.video_deleted}</strong> deleted</span>` : ''}
          ${ch.video_undeleted ? `<span style="color:var(--yellow)"><strong>${ch.video_undeleted}</strong> restored</span>` : ''}
          ${ch.profile_history_count ? `<span style="cursor:pointer;text-decoration:underline dotted" onclick="${P}OpenProfileHistory()" title="Open profile change history"><strong>${ch.profile_history_count}</strong> profile ${ch.profile_history_count === 1 ? 'update' : 'updates'}</span>` : ''}
          <span style="color:var(--muted)">${esc(checked)}</span>
        </div>
        ${ch.description ? `<div class="modal-bio" onclick="this.classList.toggle('expanded')">${esc(ch.description)}</div>` : ''}
        ${ch.bio_link ? `<div class="modal-bio-link"><a href="${esc(ch.bio_link)}" target="_blank" rel="noopener noreferrer">${esc(ch.bio_link.replace(/^https?:\/\//, ''))}</a></div>` : ''}
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

    // Toggle off if already open (e.g. clicking the profile-updates stat again)
    if (panel.style.display !== 'none' && !field) {
      window[`${P}CloseProfileHistory`]();
      return;
    }

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

  const _PHIST_STATUS_LABELS = {
    active:              'Active',
    banned:              'Banned',
    public:              'Public',
    private_accessible:  'Private (accessible)',
    private_blocked:     'Private',
    blocked:             'Blocked',
  };

  // Current profile value per history field, used as the "New" side of the
  // most recent entry; older entries take the next-newer entry's old_value.
  const _PHIST_CURRENT = {
    handle:         ch => ch?.handle,
    username:       ch => ch?.handle,
    display_name:   ch => ch?.display_name,
    description:    ch => ch?.description,
    bio:            ch => ch?.description,
    bio_link:       ch => ch?.bio_link,
    avatar:         () => '__current__',
    account_status: ch => ch?.account_status,
    privacy_status: ch => ch?.privacy_status,
  };

  function _phistNewValMap() {
    const ch = modalCreator;
    const map = new Map();
    [...new Set(phistData.map(e => e.field))].forEach(field => {
      const fe = phistData.filter(e => e.field === field); // newest-first
      fe.forEach((e, fi) => {
        map.set(e, fi === 0 ? (_PHIST_CURRENT[field] ? _PHIST_CURRENT[field](ch) : null) : fe[fi - 1].old_value);
      });
    });
    return map;
  }

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

    const newValMap = _phistNewValMap();

    panel.innerHTML = `
      <div class="phist-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
        <div class="filter-pills multi" style="flex:1">${fieldPills}</div>
        <button class="btn-ghost" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="${P}CloseProfileHistory()">Back to ${ITEMS}</button>
      </div>
      ${entries.length
        ? entries.map(e => _phistEntryHtml(e, newValMap.get(e))).join('')
        : `<div style="color:var(--muted);font-size:13px;padding:12px 0">No profile changes recorded${phistField.size ? ' for the selected fields' : ''}.</div>`}
    `;
    panel.querySelectorAll('.filter-pills').forEach(_placeGlider);
  }

  function _phistEntryHtml(e, newVal) {
    const dateStr    = _dtFmt.format(new Date(e.changed_at * 1000));
    const fieldLabel = FIELD_LABELS[e.field] || e.field;

    if (e.field === 'avatar') {
      const chId   = esc(modalCreator ? modalCreator.channel_id : phistChId || '');
      const oldSrc = `${API}/channels/${chId}/avatar-history/${encodeURIComponent(e.old_value)}`;
      const newSrc = newVal === '__current__'
        ? `${API}/channels/${chId}/avatar?t=${e.changed_at}`
        : `${API}/channels/${chId}/avatar-history/${encodeURIComponent(newVal)}`;
      const img    = (src, label) =>
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
    const valHtml = v => v
      ? `<div class="phist-value">${esc(isStatusField ? (_PHIST_STATUS_LABELS[v] || v) : v)}</div>`
      : `<div class="phist-value empty">(empty)</div>`;
    return `<div class="phist-entry">
      <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
      <div class="phist-diff">
        <div class="phist-side"><div class="phist-side-hdr"><span class="phist-side-label">Old</span></div>${valHtml(e.old_value)}</div>
        <div class="phist-arrow">→</div>
        <div class="phist-side"><div class="phist-side-hdr"><span class="phist-side-label">New</span></div>${valHtml(newVal)}</div>
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
    EXTRA_VIEWS.forEach(v => _el(`Tv_${v.key}`)?.classList.toggle('active', view === v.key));
    const grid   = _el('Grid');
    const logPnl = _el('LogPanel');
    const ctrl   = _el('Controls');
    if (grid)   grid.style.display   = view === 'creators' ? '' : 'none';
    if (logPnl) logPnl.style.display = view === 'log'      ? '' : 'none';
    if (ctrl)   ctrl.style.display   = view === 'creators' ? '' : 'none';
    EXTRA_VIEWS.forEach(v => {
      const g = _el(`Grid_${v.key}`);
      const c = _el(`Controls_${v.key}`);
      if (g) g.style.display = view === v.key ? '' : 'none';
      if (c) c.style.display = view === v.key ? 'flex' : 'none';
    });
    if (view === 'log') {
      const body = _el('LogBody');
      if (body) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }
    if (view === 'creators') renderCreators();
    const extra = EXTRA_VIEWS.find(v => v.key === view);
    if (extra) extra.show(search);
    _placeGlider(_el('TvCreators').closest('.filter-pills'));
    const activeCtrl = extra ? _el(`Controls_${extra.key}`) : ctrl;
    if (activeCtrl) activeCtrl.querySelectorAll('.filter-pills').forEach(_placeGlider);
  });

  // ── Keyboard handlers ─────────────────────────────────────────────────────

  // Cards are focusable (role=button tabindex=0), so Enter and Space open them
  _el('Grid')?.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('user-card')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // Slash focuses the search box on the active platform tab
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ([...document.querySelectorAll('.modal-backdrop')].some(el => el.style.display !== 'none')) return;
    const searchEl = _el('Search');
    // offsetParent is null while this platform's tab or the search box is hidden
    if (!searchEl || !searchEl.offsetParent) return;
    e.preventDefault();
    searchEl.focus();
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Overlay modals (carousel, image, video, sound, recent log, settings) sit
    // on top of the creator modal and close themselves via their own handler;
    // don't close both at once.
    for (const id of ['carouselModal', 'imgModal', 'vidModal', 'soundModalBackdrop', 'recentLogBackdrop', 'settingsBackdrop']) {
      if (document.getElementById(id) && document.getElementById(id).style.display !== 'none') return;
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
  loadAddHistory(true);

  setInterval(loadStatus,   5000);
  setInterval(_tickActivityBar, 1000);
  setInterval(loadCreators, 15000);
  setInterval(loadStats,    60000);
  setInterval(loadRecent,   30000);
  setInterval(loadQueue,     3000);

  // App handle for platform extras (e.g. the TikTok sounds catalog and
  // untracked-user modal) that need to drive the engine-generated UI.
  return {
    prefix: P,
    api:    API,
    el:     _el,
    getCreators:       () => creators,
    loadCreators,
    renderCreators,
    updateRunStates,
    addToasts,
    openModal:         id => window[`${P}OpenModal`](id),
    closeModal:        () => window[`${P}CloseModal`](),
    openModalRaw:      _openModalRaw,
    renderModalHeader: _renderModalHeader,
    loadModalVideos:   _loadModalVideos,
    getModalCreator:   () => modalCreator,
    setModalCreator:   ch => { modalCreator = ch; modalCreatorId = ch.channel_id; },
    getTrackingView:   () => trackingView,
    getSearch:         () => search,
  };
}
