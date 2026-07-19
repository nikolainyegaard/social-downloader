// ── Channel platform app engine ───────────────────────────────────────────────
//
// One implementation of the creator cards, detail modal, filter bar, add form,
// recent panel, loop panel, and log view, shared by every channel platform
// (TikTok, Twitter, Instagram, YouTube). Each platform calls initChannelApp(cfg)
// with its nouns, API base, and hooks; the engine generates the platform section
// and detail modal HTML and exposes its public functions on window with the
// platform prefix (e.g. twOpenModal) so generated onclick strings and the
// static settings/jobs markup can reference them. TikTok layers its extras
// (sounds catalog, jobs, QR login) on top in tiktok.js.

/**
 * @typedef {Object} ChannelAppConfig
 * @property {string} id                 Platform id, also the tab hash ('tiktok' | 'twitter' | 'instagram' | 'youtube')
 * @property {string} prefix             Global-function prefix ('tt' | 'tw' | 'ig' | 'yt')
 * @property {string} api                API base, e.g. '/api/twitter'
 * @property {string} creatorNoun        'user' | 'account' | 'profile' | 'channel'
 * @property {string} creatorNounPlural
 * @property {string} itemNoun           'video' | 'tweet' | 'post'
 * @property {string} itemNounPlural
 * @property {string} addAriaLabel
 * @property {string} addPlaceholder
 * @property {(ch: Object) => string} profileUrl        Public URL of a creator on the platform
 * @property {string} loopLabel          Loop name in pause toasts and the loop panel
 * @property {string} [loopsTitle]       Loops panel header (default 'Loop')
 * @property {string} [extraLoopHtml]    Second loop block markup (TikTok sounds)
 * @property {string} [extraLoopLabel]   Toggle label for the extra loop block
 * @property {string} [subLabelCard]     Follower-count label on cards
 * @property {string} [subLabelModal]    Follower-count label in the detail modal
 * @property {string} [subLabelSort]     Follower-count label in the sort dropdown
 * @property {string} [titleColLabel]    Video table title column (default 'Title')
 * @property {string} [uploadDateLabel]  Video table date column
 * @property {boolean} [uploadDateOnly]  Render dates without time (YouTube)
 * @property {boolean} [hasBanner]       Show the banner slot in the detail modal
 * @property {Object<string, string>} [fieldLabels]     profile_history field -> label
 * @property {{key: string, label: string, defaults?: string[], options: {key: string, label: string}[], test: (ch: Object, active: Set<string>) => boolean}[]} [extraFilterGroups]
 * @property {{key: string, label: string, controlsHtml?: string, emptyLabel?: string, show: (search: string) => void}[]} [extraViews]
 * @property {{key: string, icon: string, title: string}[]} [viewKeys]  Video-type filter tabs in the detail modal
 * @property {(view: string, vids: Object[]) => Object[]} [viewVideoFilter]
 * @property {(raw: string, addToasts: Object) => (boolean|Promise<boolean>)} [addHandler]  Return true when fully handled
 * @property {(state: Object) => void} [onStatus]       Called after every status render
 * @property {Object<string, () => void>} [extraDomainLoaders]  Platform panels refetched on SSE 'changed' domains (TikTok: sounds)
 * @property {(state: Object) => boolean} [statusActive]  Extra 'running' signal for the header badge
 * @property {(state: Object) => {iso: string, label: string}[]} [nextRunCandidates]
 * @property {boolean} [hasStories]     Platform saves stories: adds the Stories card stat and sort option
 * @property {(s: Object) => Object[]} [statsRows]      Rows for the stat strip
 * @property {(item: Object) => string} [recentFallback]  Recent-feed line for disabled creators
 * @property {(ch: Object) => string} [gridClassFn]
 * @property {(v: Object) => string} [typeIconFn]
 * @property {(v: Object) => string} [thumbBadge]
 * @property {Function} [videoActionBtnsFn]
 */

/** @param {ChannelAppConfig} cfg */
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
  const _bmOutline = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.5L6 21V3z"/></svg>`;
  const _bmFilled  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-5.5L5 22V3a1 1 0 0 1 1-1z"/></svg>`;

  const _bookmarkBtn = (ch, stop) => `<button class="btn-bookmark${ch.bookmarked ? ' bookmarked' : ''}"
      onclick="${stop ? 'event.stopPropagation();' : ''}${P}ToggleBookmark('${esc(ch.channel_id)}')"
      title="${ch.bookmarked ? (ch.starred ? `Starred ${CREATORS} stay bookmarked` : 'Remove bookmark') : 'Bookmark'}">${ch.bookmarked ? _bmFilled : _bmOutline}</button>`;

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

  <div class="stat-strip" id="${P}StatsGrid"></div>

  <div class="dash-row">
  <div class="panel-card recent-card">
    <div class="panel-header">
      <span class="section-title">Recent activity</span>
      <div class="edge-fade hdr-filter" id="${P}RecentFilterRow">
        <div class="filter-pills multi hdr-pills" onpointerenter="${P}PrefetchFeedKinds()">
          <button class="filter-pill active" id="${P}Rf_all"     onclick="${P}SetRecentFilter('all')">All</button>
          <button class="filter-pill"        id="${P}Rf_saved"   onclick="${P}SetRecentFilter('saved')">Saved</button>
          <button class="filter-pill"        id="${P}Rf_deleted" onclick="${P}SetRecentFilter('deleted')">Deleted</button>
          <button class="filter-pill"        id="${P}Rf_changed" onclick="${P}SetRecentFilter('changed')">Changes</button>
          <button class="filter-pill" id="${P}Rf_banned" onclick="${P}SetRecentFilter('banned')">Bans</button>
        </div>
        <span style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn-star" id="${P}RfStar" onclick="${P}ToggleRfStar()" title="Only starred ${CREATORS}">☆</button>
          <button class="btn-bookmark" id="${P}RfBook" onclick="${P}ToggleRfBook()" title="Only bookmarked ${CREATORS}">${_bmOutline}</button>
        </span>
      </div>
    </div>
    <div class="recent-feed" id="${P}RecentFeed"><div class="rf-empty">Loading…</div></div>
  </div>
  <div class="dash-col">
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
  <div class="panel-card ah-card">
    <div class="panel-header"><span class="section-title">Add history</span></div>
    <div class="add-history" id="${P}AddHistory"></div>
  </div>
  </div>
  </div>

  <section>
    <div style="margin-bottom:12px;">
      <div class="view-tabs-row">
        <div class="view-tabs">
          <button class="view-tab active" id="${P}TvCreators" onclick="${P}SetTrackingView('creators')">${CreatorsCap}</button>
          ${EXTRA_VIEWS.map(v => `<button class="view-tab" id="${P}Tv_${v.key}" onclick="${P}SetTrackingView('${v.key}')">${v.label}</button>`).join('')}
          <button class="view-tab"        id="${P}TvLog"      onclick="${P}SetTrackingView('log')">Log</button>
        </div>
        <span id="${P}Count" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
        <input id="${P}Search" class="tracking-search" type="search" placeholder="Search…" oninput="${P}OnSearch(this.value)">
      </div>
      <div id="${P}Controls" class="filter-control-group edge-fade" style="margin-top:10px">
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
          <span class="filter-row-label">Flags</span>
          <div class="filter-pills multi">
            <button class="filter-pill" id="${P}fStarStarred" onclick="${P}SetFilter('star','starred')">Starred</button>
            <button class="filter-pill" id="${P}fBookBookmarked" onclick="${P}SetFilter('book','bookmarked')">Bookmarked</button>
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
              ${cfg.hasStories ? '<option value="story_count">Stories</option>' : ''}
              <option value="added_at">Date added</option>
              <option value="last_checked">Last checked</option>
              <option value="last_saved">Last saved</option>
            </select>
            <button class="sort-dir-btn" id="${P}SortDirBtn" onclick="${P}ToggleSortDir()">A → Z</button>
            <button class="sort-dir-btn" onclick="${P}ResetFilters()" title="Reset filters and sort">Reset</button>
          </div>
        </div>
      </div>
      ${EXTRA_VIEWS.map(v => `<div id="${P}Controls_${v.key}" class="filter-control-group edge-fade" style="display:none;margin-top:10px">${v.controlsHtml || ''}</div>`).join('')}
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
  <div class="modal modal-base creator-modal" id="${P}ModalBase">
    <button class="modal-close" onclick="${P}CloseModal()"></button>
    ${cfg.hasBanner ? `<div class="yt-modal-banner" id="${P}ModalBanner" style="display:none"></div>` : ''}
    <div class="modal-header"     id="${P}ModalHeader"></div>
    <div class="modal-toolbar"    id="${P}ModalToolbar"></div>
    <div class="m-filters"        id="${P}ModalFilters" style="display:none"></div>
    <div class="phist-panel"      id="${P}PhistPanel" style="display:none"></div>
    <div class="stories-panel"    id="${P}StoriesPanel" style="display:none"></div>
    <div class="modal-video-list" id="${P}ModalVideoList"></div>
    <button class="back-to-top modal-top" id="${P}ModalTop" style="display:none" onclick="${P}ScrollModalTop()" title="Back to top">↑</button>
  </div>
  <div class="about-modal" id="${P}AboutModal" style="display:none" onclick="if(event.target===this)${P}CloseAbout()">
    <div class="about-card">
      <button class="about-close" onclick="${P}CloseAbout()" aria-label="Close">✕</button>
      <h3 class="about-title">About</h3>
      <div id="${P}AboutBody"></div>
    </div>
  </div>
</div>`;
  }

  document.getElementById(`platform-${cfg.id}`).innerHTML = _sectionHtml();
  document.body.insertAdjacentHTML('beforeend', _modalHtml());

  // ── State ─────────────────────────────────────────────────────────────────

  let creators       = [];
  let sort           = { field: 'handle', dir: 'asc' };
  // Default filter: hide inactive creators; Starred and Bookmarked stay off
  const _defaultFilter = () => {
    const f = { stat: new Set(['active']), star: new Set(), book: new Set() };
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
    story_count:      { asc: 'Low → High',   desc: 'High → Low'   },
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

  // Open a creator's live stories in the story viewer, oldest first. Reached
  // from the ringed avatars; the ring only renders when live_stories > 0, but
  // a story can expire between the poll and the click, hence the fallback.
  X('OpenStories', async channelId => {
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(channelId)}/stories`);
    if (!ok) return;
    const live = (data || []).filter(s => s.live).reverse();
    if (!live.length) {
      showToast('No live stories right now.');
      return;
    }
    openStorySlides(live.map(s => ({
      url:  s.url,
      type: s.content_type === 'photo' ? 'image' : 'video',
    })));
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

  // View-tab icons for the two extra modal views (History and Stories) that sit
  // alongside the platform's media views (List/Grid) in the toolbar toggle.
  const _historyIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3.5 2"/></svg>`;
  const _storiesTabIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" stroke-dasharray="3.2 2.6"/><polygon points="10,8.5 16.5,12 10,15.5" fill="currentColor" stroke="none"/></svg>`;
  const _baseViewKeys = cfg.viewKeys || [
    { key: 'list',   icon: _listViewIcon, title: 'List view', label: 'Videos' },
    { key: 'videos', icon: _gridViewIcon, title: 'Grid view', label: 'Grid' },
  ];
  // History is always offered; Stories on any stories-capable platform (even
  // with no saved stories yet). label is the mobile tab text.
  const _modalViewKeys = () => {
    const keys = [..._baseViewKeys, { key: 'history', icon: _historyIcon, title: 'Profile history', label: 'History' }];
    // Stories tab shows on any stories-capable platform, even with no saved stories yet.
    if (cfg.hasStories)
      keys.push({ key: 'stories', icon: _storiesTabIcon, title: 'Stories', label: 'Stories' });
    return keys;
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
    mobileRows:   true,   // render the list as YouTube-style card rows on mobile
    mobileToolbar: true,  // text tabs + filter/sort dropdowns on mobile
    filtersHostId: `${P}ModalFilters`,  // mobile filter row lives in its own scroll-flow element
    mSortFn:      `${P}MSort`,
    mStatusFn:    `${P}MStatus`,
    mTypeFn:      `${P}MType`,
    viewFn:       `${P}SetModalView`,
    viewKeys:     _modalViewKeys,
    // History view swaps the post filters for its profile-change field pills,
    // rendered into the toolbar's context-filter area (desktop). On mobile it
    // becomes a Fields dropdown via mobileFilters.
    contextFilters: v => v === 'history' ? _phistFieldPillsHtml() : '',
    mobileFilters:  v => v === 'history' ? _mobileFieldsDd() : '',
    viewVideoFilter: cfg.viewVideoFilter || ((view, vids) => vids),
    gridClassFn:     cfg.gridClassFn || (() => ''),
    typeIconFn:      cfg.typeIconFn || (v => _isMulti(v) ? _vgridPhotoIcon : (v.type === 'photo' || _isImage(v)) ? _vgridImageIcon : _vgridPlayIcon),
    gridId:       `${P}VideoGrid`,
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
    { label: 'Storage',             value: _fmtBytes(s.media_size_bytes || 0) },
  ]);

  function renderStats(s) {
    _renderStatGrid(`${P}StatsGrid`, _statsRows(s));
  }
  // Render the strip with zero/placeholder values immediately so it reserves
  // its final height and the page does not shift down when the fetch lands.
  renderStats({});

  let _statsSig = null;
  const loadStats = X('LoadStats', async () => {
    const { ok, data } = await apiJSON(`${API}/stats`);
    if (!ok) return;
    const sig = JSON.stringify(data);
    if (sig === _statsSig) return;
    _statsSig = sig;
    renderStats(data);
  });

  // ── Recent panel ──────────────────────────────────────────────────────────

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

  // One chronological feed mixing every activity type, filterable from the
  // panel header. Server-paginated; older pages load through a scroll sentinel.

  const _RF_ICONS = {
    saved:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16"/></svg>',
    deleted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    changed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L7 21H3v-4L17 3z"/></svg>',
    banned:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/></svg>',
  };
  let _recentFilter = 'all';
  let _rfStar       = false;
  let _rfBook       = false;
  // Page-one cache per filter combination: switching filters renders instantly
  // from cache while a background fetch revalidates
  const _rf = { items: [], hasMore: false, obs: null, loading: false, sig: null, cache: {} };

  const _rfKey = () => `${_recentFilter}|${_rfStar ? 1 : 0}|${_rfBook ? 1 : 0}`;

  function _rfUrl(before) {
    const kind = _recentFilter === 'all' ? '' : `&kind=${_recentFilter}`;
    const flags = `${_rfStar ? '&starred=1' : ''}${_rfBook ? '&bookmarked=1' : ''}`;
    return `${API}/recent/feed?limit=40${kind}${flags}${before ? `&before=${before}` : ''}`;
  }

  function _rfRow(ev, now) {
    const it = ev.item;
    const detail = ev.kind === 'saved'   ? `${it.count} saved`
                 : ev.kind === 'deleted' ? `${it.count} deleted`
                 : ev.kind === 'changed' ? esc(FIELD_LABELS[it.field] || it.field)
                 : 'Banned';
    const onclick = ev.kind === 'saved' || ev.kind === 'deleted'
      ? _recentOnclick(it, ev.kind)
      : ev.kind === 'changed'
        ? `${P}OpenModalWithHistory('${esc(it.channel_id)}','${esc(it.field)}')`
        : `${P}OpenModal('${esc(it.channel_id)}')`;
    return `<div class="rf-row" onclick="${onclick}" title="Open @${esc(it.handle)}">
      <span class="rf-icon rf-${ev.kind}">${_RF_ICONS[ev.kind]}</span>
      <span class="rf-avatar-wrap"><img class="rf-avatar" src="${API}/channels/${esc(it.channel_id)}/avatar?size=thumb" loading="lazy" alt="" onerror="this.remove()"></span>
      <span class="rf-name" ${_nameStyle(it)}>@${esc(it.handle)}</span>
      <span class="rf-detail rf-${ev.kind}">${detail}</span>
      <span class="rf-time">${_recentDate(ev.ts, now)}</span>
    </div>`;
  }

  function _renderFeed(loading) {
    const el = document.getElementById(`${P}RecentFeed`);
    if (!el) return;
    if (_rf.obs) { _rf.obs.disconnect(); _rf.obs = null; }
    const now = new Date();
    el.innerHTML = _rf.items.length
      ? _rf.items.map(e => _rfRow(e, now)).join('')
      : `<div class="rf-empty">${loading ? 'Loading…' : 'No activity yet'}</div>`;
    if (_rf.hasMore) _rf.obs = _attachSentinel(el, _loadFeedMore);
  }

  async function _loadFeedMore() {
    if (_rf.loading || !_rf.items.length) return;
    _rf.loading = true;
    const { ok, data } = await apiJSON(_rfUrl(_rf.items[_rf.items.length - 1].ts));
    _rf.loading = false;
    if (!ok) return;
    _rf.items.push(...data.items);
    _rf.hasMore = data.has_more;
    _renderFeed();
  }

  // Stale-while-revalidate on filter change: render the cached page one for the
  // new combination immediately, then let loadRecent refresh it in the background
  function _applyFeedFilter() {
    const c = _rf.cache[_rfKey()];
    _rf.sig     = c ? c.sig : null;
    _rf.items   = c ? c.items.slice() : [];
    _rf.hasMore = c ? c.hasMore : false;
    _renderFeed(!c);
    loadRecent();
  }

  X('SetRecentFilter', f => {
    _recentFilter = f;
    ['all', 'saved', 'deleted', 'changed', 'banned'].forEach(k => {
      document.getElementById(`${P}Rf_${k}`)?.classList.toggle('active', k === f);
    });
    _applyFeedFilter();
  });

  // The flag toggles mirror the star and bookmark buttons on cards: same
  // classes, same filled/outline state swap
  X('ToggleRfStar', () => {
    _rfStar = !_rfStar;
    const b = document.getElementById(`${P}RfStar`);
    if (b) { b.classList.toggle('starred', _rfStar); b.textContent = _rfStar ? '★' : '☆'; }
    _applyFeedFilter();
  });

  X('ToggleRfBook', () => {
    _rfBook = !_rfBook;
    const b = document.getElementById(`${P}RfBook`);
    if (b) { b.classList.toggle('bookmarked', _rfBook); b.innerHTML = _rfBook ? _bmFilled : _bmOutline; }
    _applyFeedFilter();
  });

  // Warm the per-kind caches the first time the pointer reaches the filter
  // pills, so the first filter click is instant too
  X('PrefetchFeedKinds', async () => {
    for (const kind of ['saved', 'deleted', 'changed', 'banned']) {
      const key = `${kind}|0|0`;
      if (_rf.cache[key]) continue;
      const { ok, data } = await apiJSON(`${API}/recent/feed?limit=40&kind=${kind}`);
      if (ok) _rf.cache[key] = { items: data.items, hasMore: data.has_more, sig: JSON.stringify(data.items) };
    }
  });

  // The 30 s poll refreshes page one of the feed. Pages the user scrolled in
  // are reset only when page one actually changed, so idle polls never yank
  // the scroll position. Older pages load through the scroll sentinel.
  const loadRecent = X('LoadRecent', async () => {
    const key = _rfKey();
    const { ok, data } = await apiJSON(_rfUrl());
    if (!ok) return;
    const sig = JSON.stringify(data.items);
    _rf.cache[key] = { items: data.items, hasMore: data.has_more, sig };
    if (key !== _rfKey()) return;   // filter changed while the fetch was in flight
    if (sig === _rf.sig) return;
    _rf.sig     = sig;
    _rf.items   = data.items.slice();
    _rf.hasMore = data.has_more;
    _renderFeed();
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
    // offsetParent is null while the bar is hidden (platform tab not active,
    // or the Log view not selected); skip the countdown render entirely then
    if (!bar || bar.offsetParent === null) return;
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
    handleInput.blur();

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
  // Extras (the untracked-user modal) can watch queue snapshots to react when
  // an add/track resolves, instead of running their own poll. Fired from this
  // one funnel, so subscribers work over SSE pushes and the poll fallback alike.
  const _queueSubs = new Set();

  function _syncQueue(data) {
    addToasts.sync(data);
    // Any queue state change (new pending, resolution, retry) is also a
    // change to the top of the Add history, so refresh it.
    const sig = JSON.stringify(data);
    if (sig !== _queueSig) {
      if (_queueSig !== null) loadAddHistory(true);
      _queueSig = sig;
    }
    _queueSubs.forEach(cb => cb(data));
  }

  const loadQueue = X('LoadQueue', async () => {
    const { ok, data } = await apiJSON(`${API}/queue`);
    if (ok) _syncQueue(data);
  });

  // ── Add history panel ─────────────────────────────────────────────────────

  const _ah = { items: [], hasMore: false, obs: null, loading: false };

  const _AH_ICONS = {
    ok:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V13m0 3.5v.1"/></svg>',
  };

  function _ahRow(e) {
    const icon = e.status === 'pending'
      ? '<span class="spinner"></span>'
      : _AH_ICONS[e.status === 'error' ? 'error' : 'ok'];
    const status = e.status === 'pending'
      ? '<span class="ah-status ah-pending">looking up…</span>'
      : e.status === 'error'
        ? `<span class="ah-status ah-error" title="${esc(e.error_detail || '')}">${esc(e.error_kind || 'error')}</span>`
        : '<span class="ah-status ah-ok">added</span>';
    const actions = e.status === 'error'
      ? `<button class="ah-btn" title="Try again" onclick="${P}AhRetry(${e.id})">${_triggerIcon}</button>
         <button class="ah-btn ah-btn-danger" title="Discard" onclick="${P}AhDiscard(${e.id})">✕</button>`
      : '';
    return `<div class="ah-row${actions ? ' has-actions' : ''}">
      <div class="ah-row-content">
        <span class="ah-icon ah-${esc(e.status)}">${icon}</span>
        <span class="ah-handle">@${esc(e.handle)}</span>
        ${status}
        <span class="ah-time">${_recentDate(e.updated_at)}</span>
      </div>
      ${actions ? `<span class="ah-actions">${actions}</span>` : ''}
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
  const BOOK_IDS = { bookmarked: `${P}fBookBookmarked` };

  function _filterPillIds(group) {
    if (group === 'stat') return STAT_IDS;
    if (group === 'star') return STAR_IDS;
    if (group === 'book') return BOOK_IDS;
    const g = EXTRA_FILTER_GROUPS.find(g => g.key === group);
    return g ? Object.fromEntries(g.options.map(o => [o.key, `${P}f_${g.key}_${o.key}`])) : {};
  }

  function _syncFilterPills() {
    for (const group of ['stat', 'star', 'book', ...EXTRA_FILTER_GROUPS.map(g => g.key)]) {
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
      if (filter.book.has('bookmarked') && !ch.bookmarked) return false;
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
          <div class="avatar-wrap${ch.live_stories ? ' story-ring' : ''}"${ch.live_stories ? ` title="${ch.live_stories} live ${ch.live_stories === 1 ? 'story' : 'stories'}" onclick="event.stopPropagation();${P}OpenStories('${esc(ch.channel_id)}')"` : ''}>
            <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
            ${ch.avatar_cached ? `<img class="user-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar?size=thumb" alt=""
                 onerror="this.style.display='none'"
                 ${ch.live_stories ? '' : `onclick="event.stopPropagation();openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')"`}>` : ''}
          </div>
          <div class="user-identity">
            <div class="user-display-name">${_isPrivateAccount(ch) ? LOCK_SVG : ''}${esc(ch.display_name || ch.handle)}</div>
            <div class="user-handle">@${esc(ch.handle)}${_oldNamesTag(ch)}</div>
            <div class="user-id-line">${esc(ch.channel_id)}</div>
          </div>
          <div class="user-badges">
            <span class="account-status ${trackingCls}">${trackingLabel}</span>
            ${_relationPill(ch)}
          </div>
        </div>

        <div class="user-bio-area">
          ${ch.description ? `<div class="user-bio">${esc(ch.description)}</div>` : ''}
        </div>

        <div class="user-stats">
          ${ch.subscriber_count != null ? `<span class="stat-item"><span class="stat-item-label">${cfg.subLabelCard}</span><span class="stat-item-value">${(ch.subscriber_count || 0).toLocaleString()}</span></span>` : ''}
          <span class="stat-item"><span class="stat-item-label">saved</span><span class="stat-item-value">${ch.video_total || 0}</span></span>
          ${(ch.video_deleted || 0) > 0 ? `<span class="stat-item"><span class="stat-item-label">deleted</span><span class="stat-item-value" style="color:var(--red)">${ch.video_deleted}</span></span>` : ''}
          ${ch.video_missing   ? `<span class="stat-item"><span class="stat-item-label">missing</span><span class="stat-item-value" style="color:var(--orange)">${ch.video_missing}</span></span>` : ''}
          ${cfg.hasStories && ch.story_count ? `<span class="stat-item"><span class="stat-item-label">stories</span><span class="stat-item-value" style="color:var(--purple)">${ch.story_count}</span></span>` : ''}
        </div>

        ${rescanBadge}

        <div class="user-card-footer">
          <div style="display:flex;gap:6px;">
            <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="event.stopPropagation();${P}ToggleStar('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
            ${_bookmarkBtn(ch, true)}
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
    const isFiltered = filter.stat.size > 0 || filter.star.size > 0 || filter.book.size > 0 || !!search;
    const countEl    = _el('Count');
    if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${creators.length}` : `${creators.length}`;

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

  // Starring implies bookmarking (the server applies the same rule)
  function _syncStarBookmark(id) {
    const ch = creators.find(c => c.channel_id === id);
    if (ch && ch.starred && !ch.bookmarked) { ch.bookmarked = 1; renderCreators(); }
  }

  X('ToggleStar', async id => {
    await _creatorToggleStar(`${API}/channels`, id, creators, 'channel_id', renderCreators);
    _syncStarBookmark(id);
  });

  // Bookmark: a pure filter flag with no loop or scheduling side effects.
  // Optimistic toggle, reverted if the PATCH fails.
  X('ToggleBookmark', async id => {
    const ch = creators.find(c => c.channel_id === id);
    if (!ch) return;
    if (ch.starred && ch.bookmarked) {
      showToast(`Starred ${CREATORS} stay bookmarked.`);
      return;
    }
    const next = ch.bookmarked ? 0 : 1;
    ch.bookmarked = next;
    renderCreators();
    if (modalCreator && modalCreator.channel_id === id) {
      modalCreator.bookmarked = next;
      _renderModalHeader(modalCreator);
    }
    const { ok, data } = await apiJSON(`${API}/channels/${id}/bookmark`, {
      method: 'PATCH',
      body: JSON.stringify({ bookmarked: !!next }),
    });
    if (!ok) {
      ch.bookmarked = next ? 0 : 1;
      renderCreators();
      showToast(data.error || 'Could not update bookmark', { type: 'error' });
    }
  });

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
      // Mobile defaults to the grid view; use the real grid view key (e.g.
      // 'videos'), not the literal 'grid', so the toggle marks it active.
      view: window.innerWidth <= 640
        ? (_baseViewKeys.find(k => k.key !== 'list') || _baseViewKeys[0]).key
        : 'list',
    });
    if (_creatorState.obs) { _creatorState.obs.disconnect(); _creatorState.obs = null; }

    phistData  = [];
    phistField = new Set();
    phistChId  = null;
    _el('PhistPanel').style.display     = 'none';
    _destroyStoriesPanel();
    _el('ModalVideoList').style.display = '';

    _el('ModalBackdrop').style.display = 'flex';
    { const mb = _el('ModalBase'), top = _el('ModalTop'); if (mb) mb.scrollTop = 0; if (top) top.style.display = 'none'; }
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
    if (field) phistField = new Set([field]);
    window[`${P}SetModalView`]('history');
  });

  // Modal back-to-top: only the modal element itself scrolls on mobile (single
  // scroll container); on desktop the inner list scrolls, so this stays hidden.
  X('ScrollModalTop', () => { const m = _el('ModalBase'); if (m) m.scrollTo({ top: 0, behavior: 'smooth' }); });
  {
    const mb = _el('ModalBase'), top = _el('ModalTop'), tabsHost = _el('ModalToolbar'), filt = _el('ModalFilters');
    let lastY = 0;
    if (mb) mb.addEventListener('scroll', () => {
      const y = mb.scrollTop;
      if (top) top.style.display = y > 200 ? 'flex' : 'none';
      if (filt && _mIsMobile()) {
        const tabs = tabsHost && tabsHost.querySelector('.m-tabs');
        // Quick-return: only hide once the toolbar is pinned at the top (the
        // header has scrolled away). Until then the filter row scrolls off with
        // the page on its own, so there is no shift and no blank gap.
        const pinned = tabs && tabs.getBoundingClientRect().top <= mb.getBoundingClientRect().top + 1;
        if (!pinned || y < lastY - 6) filt.classList.remove('filters-hidden');
        else if (y > lastY + 6) filt.classList.add('filters-hidden');
      }
      lastY = y;
    }, { passive: true });
  }

  // Mobile toolbar dropdown handlers + the History Fields dropdown.
  X('MSort',   f => _mMobSort(MODAL_CFG, f));
  X('MStatus', k => _mMobStatus(MODAL_CFG, k));
  X('MType',   k => _mMobType(MODAL_CFG, k));
  // Single-choice: pick one field, or click the active one again to clear.
  X('MToggleField', field => {
    phistField = phistField.has(field) ? new Set() : new Set([field]);
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // rebuild the Fields dropdown
    _renderPhistPanel();
  });
  function _mobileFieldsDd() {
    const fields = [...new Set(phistData.map(e => e.field))];
    const menu = fields.map(f =>
      `<button class="m-dd-opt${phistField.has(f) ? ' active' : ''}" onclick="${P}MToggleField('${esc(f)}',this)">${FIELD_LABELS[f] || f}<span>${phistField.has(f) ? '✓' : ''}</span></button>`).join('');
    return _mDd('Fields', menu);
  }

  // About modal (mobile): full bio, link, and all stats + activity dates.
  // Per-creator media folder size, fetched lazily when the Info panel or header
  // renders (a folder walk is too costly to run on the channel list). Cached per
  // channel so header re-renders on status polls do not refetch.
  const _storageCache = {};
  const _storageTileVal = chId =>
    _storageCache[chId] != null ? _fmtBytes(_storageCache[chId]) : '<span class="storage-val">…</span>';
  async function _fillStorage(chId) {
    if (_storageCache[chId] != null) return;
    const { ok, data } = await apiJSON(`${API}/channels/${chId}/storage`);
    if (!ok || !data || modalCreatorId !== chId) return;
    _storageCache[chId] = data.bytes || 0;
    document.querySelectorAll('.storage-val').forEach(el => { el.textContent = _fmtBytes(_storageCache[chId]); });
  }

  X('OpenAbout', () => {
    const ch = modalCreator; if (!ch) return;
    const platformLabel = (PLATFORMS.find(p => p.id === cfg.id) || {}).label || cfg.id;
    const _iso = u => new Date(u * 1000).toISOString();
    const nextCheckVal = (ch.enabled === 0 || ch.tracking_enabled === 0) ? '—'
      : (!ch.next_check_at || ch.next_check_at * 1000 <= Date.now()) ? 'next session'
      : fmt.relFuture(_iso(ch.next_check_at));
    const dateTiles = [
      { v: fmtDateOnly(ch.added_at),                                   l: 'Added' },
      { v: ch.last_checked ? fmt.rel(_iso(ch.last_checked)) : 'never', l: 'Last checked' },
      { v: ch.last_saved   ? fmt.rel(_iso(ch.last_saved))   : 'never', l: 'Last saved' },
      { v: nextCheckVal,                                               l: 'Next check' },
    ];
    const statTiles = [];
    if (ch.subscriber_count != null) statTiles.push({ v: _fmtLarge(ch.subscriber_count || 0), l: cfg.subLabelModal });
    if (ch.following_count  != null) statTiles.push({ v: _fmtLarge(ch.following_count),       l: 'Following' });
    if (ch.video_count      != null) statTiles.push({ v: _fmtLarge(ch.video_count || 0),      l: `On ${esc(platformLabel)}` });
    statTiles.push({ v: _fmtLarge(ch.video_total || 0), l: 'Saved' });
    if ((ch.video_deleted || 0) > 0) statTiles.push({ v: ch.video_deleted,   l: 'Deleted',  cls: 'tred' });
    if (ch.video_undeleted)          statTiles.push({ v: ch.video_undeleted, l: 'Restored', cls: 'tyellow' });
    if (cfg.hasStories && ch.story_count) statTiles.push({ v: _fmtLarge(ch.story_count), l: 'Stories' });
    statTiles.push({ v: _storageTileVal(ch.channel_id), l: 'Storage' });
    if (ch.profile_history_count)    statTiles.push({ v: ch.profile_history_count, l: 'Updates', click: `${P}CloseAbout();${P}SetModalView('history')` });
    const tile = t => `<div class="tile${t.cls ? ' ' + t.cls : ''}${t.click ? ' tlink' : ''}"${t.click ? ` onclick="${t.click}"` : ''}><span class="tv">${t.v}</span><span class="tl">${t.l}</span></div>`;
    _el('AboutBody').innerHTML = `
      ${ch.description ? `<div class="about-bio">${esc(ch.description)}</div>` : ''}
      ${ch.bio_link ? `<a class="about-link" href="${esc(ch.bio_link)}" target="_blank" rel="noopener noreferrer">${esc(ch.bio_link.replace(/^https?:\/\//, ''))}</a>` : ''}
      <div class="about-sub">Stats</div>
      <div class="about-grid">${statTiles.map(tile).join('')}</div>
      <div class="about-sub">Activity</div>
      <div class="about-grid about-dates">${dateTiles.map(tile).join('')}</div>`;
    _el('AboutModal').style.display = 'flex';
    _fillStorage(ch.channel_id);
  });
  X('CloseAbout', () => { const a = _el('AboutModal'); if (a) a.style.display = 'none'; });

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
      // On History/Stories the list stays hidden; still refresh the toolbar so
      // the tab set and post counts reflect the loaded videos.
      _mRenderToolbar(MODAL_CFG, _creatorState.videos);
      if (_creatorState.view !== 'history' && _creatorState.view !== 'stories')
        _mRenderList(MODAL_CFG);
    }
  }

  function _renderModalHeader(ch) {
    if (_mIsMobile()) { _renderModalHeaderMobile(ch); _renderModalBanner(ch); return; }
    const isInactive  = ch.tracking_enabled === 0;
    const { cls: trackingCls, label: trackingLbl } = _trackingBadge(ch.tracking_enabled);
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

    const _iso = u => new Date(u * 1000).toISOString();
    const nextCheckVal = (ch.enabled === 0 || ch.tracking_enabled === 0) ? '—'
      : (!ch.next_check_at || ch.next_check_at * 1000 <= Date.now()) ? 'next session'
      : fmt.relFuture(_iso(ch.next_check_at));

    // Dates box (2x2) + stats box (paired chips). Stats are collected only from the
    // fields this platform actually has, then chunked into pairs, so the layout
    // stays even across TikTok / YouTube / Twitter / Instagram.
    const dateTiles = [
      { v: fmtDateOnly(ch.added_at),                                   l: 'Added' },
      { v: ch.last_checked ? fmt.rel(_iso(ch.last_checked)) : 'never', l: 'Last checked' },
      { v: ch.last_saved   ? fmt.rel(_iso(ch.last_saved))   : 'never', l: 'Last saved' },
      { v: nextCheckVal,                                               l: 'Next check' },
    ];
    const statTiles = [];
    if (ch.subscriber_count != null) statTiles.push({ v: _fmtLarge(ch.subscriber_count || 0), l: cfg.subLabelModal });
    if (ch.following_count  != null) statTiles.push({ v: _fmtLarge(ch.following_count),       l: 'Following' });
    if (ch.video_count      != null) statTiles.push({ v: _fmtLarge(ch.video_count || 0),      l: `On ${esc(platformLabel)}` });
    statTiles.push({ v: _fmtLarge(ch.video_total || 0), l: 'Saved' });
    if ((ch.video_deleted || 0) > 0) statTiles.push({ v: ch.video_deleted,   l: 'Deleted',  cls: 'tred' });
    if (ch.video_undeleted)          statTiles.push({ v: ch.video_undeleted, l: 'Restored', cls: 'tyellow' });
    if (cfg.hasStories && ch.story_count) statTiles.push({ v: _fmtLarge(ch.story_count), l: 'Stories' });
    statTiles.push({ v: _storageTileVal(ch.channel_id), l: 'Storage' });
    if (ch.profile_history_count)    statTiles.push({ v: ch.profile_history_count, l: 'Updates', click: `${P}SetModalView('history')` });

    const _tile = t => `<div class="tile${t.cls ? ' ' + t.cls : ''}${t.click ? ' tlink' : ''}"${t.click ? ` onclick="${t.click}" title="Open profile change history"` : ''}><span class="tv">${t.v}</span><span class="tl">${t.l}</span></div>`;
    let statPairs = '';
    for (let i = 0; i < statTiles.length; i += 2) statPairs += `<div class="stat-pair">${statTiles.slice(i, i + 2).map(_tile).join('')}</div>`;

    _el('ModalHeader').innerHTML = `
      <div class="modal-header-left">
        <div class="modal-avatar-wrap${ch.live_stories ? ' story-ring' : ''}"${ch.live_stories ? ` title="${ch.live_stories} live ${ch.live_stories === 1 ? 'story' : 'stories'}" onclick="${P}OpenStories('${esc(ch.channel_id)}')"` : ''}>
          <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
          ${ch.avatar_cached ? `<img class="modal-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar" alt=""
               onerror="this.style.display='none'"
               ${ch.live_stories ? '' : `onclick="openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')"`}>` : ''}
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
            <span style="color:var(--muted);font-size:12px;margin-left:6px">${esc(ch.channel_id)}${joinStr}</span>
          </div>
          ${banCountdownStr ? `<div class="modal-ban-countdown">${banCountdownStr}</div>` : ''}
          ${ch.description ? `<div class="modal-bio"><span class="modal-bio-line" onclick="${P}OpenBio(this.parentNode)">${esc(ch.description)}</span><div class="modal-bio-pop" onclick="event.stopPropagation()"><button class="modal-bio-close" onclick="${P}CloseBio(this)" aria-label="Close"><svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1 1L9 9M9 1L1 9"/></svg></button>${esc(ch.description)}</div></div>` : ''}
          ${ch.bio_link ? `<div class="modal-bio-link"><a href="${esc(ch.bio_link)}" target="_blank" rel="noopener noreferrer">${esc(ch.bio_link.replace(/^https?:\/\//, ''))}</a></div>` : ''}
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
            <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="${P}ToggleStarModal('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
            ${_bookmarkBtn(ch, false)}
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
      </div>
      <div class="modal-header-meta">${dateTiles.map(_tile).join('')}</div>
      <div class="modal-header-stats">${statPairs}</div>
    `;

    _fillStorage(ch.channel_id);
    _renderModalBanner(ch);
  }

  function _renderModalBanner(ch) {
    if (!cfg.hasBanner) return;
    const bannerEl = _el('ModalBanner');
    if (!bannerEl) return;
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

  // Mobile creator-modal header: avatar + names, a bio/links info block with a
  // ...more that opens the About modal (full bio, link, stats), then actions.
  function _renderModalHeaderMobile(ch) {
    const isInactive  = ch.tracking_enabled === 0;
    const extUrl      = cfg.profileUrl(esc(ch.handle));
    const busy        = runQueue.includes(ch.channel_id) || runCurrent === ch.channel_id;
    const runDisabled = busy ? 'disabled' : '';
    const banCountdownStr = (() => {
      if (ch.account_status !== 'banned' || !ch.banned_at || ch.tracking_enabled === 0) return '';
      const daysLeft = 14 - Math.floor((Date.now() / 1000 - ch.banned_at) / 86400);
      return daysLeft > 0 ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} until inactive` : '';
    })();
    const N = 90, desc = ch.description || '', long = desc.length > N;
    const bioText = desc ? (long ? esc(desc.slice(0, N).trim()) + '… ' : esc(desc) + ' ') : '';
    const moreLbl = long ? '…more' : 'Details';
    _el('ModalHeader').innerHTML = `
      <div class="mh">
        <div class="mh-top">
          <div class="modal-avatar-wrap${ch.live_stories ? ' story-ring' : ''}"${ch.live_stories ? ` title="${ch.live_stories} live ${ch.live_stories === 1 ? 'story' : 'stories'}" onclick="${P}OpenStories('${esc(ch.channel_id)}')"` : ''}>
            <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
            ${ch.avatar_cached ? `<img class="modal-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar" alt="" onerror="this.style.display='none'"${ch.live_stories ? '' : ` onclick="openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')"`}>` : ''}
          </div>
          <div class="mh-id">
            <div class="mh-name">${_isPrivateAccount(ch) ? LOCK_SVG : ''}${esc(ch.display_name || ch.handle)}${ch.verified ? '<span class="modal-verified">✓</span>' : ''}${_relationPill(ch)}</div>
            <div class="mh-handle"><a href="${extUrl}" target="_blank" rel="noopener" class="tt-link">@${esc(ch.handle)}</a>${_oldNamesTag(ch)}</div>
            <div class="mh-uid">${esc(ch.channel_id)}</div>
            ${banCountdownStr ? `<div class="modal-ban-countdown">${banCountdownStr}</div>` : ''}
          </div>
        </div>
        <div class="mh-info">
          <div class="mh-bio">${bioText}<button class="mh-more" onclick="${P}OpenAbout()">${moreLbl}</button></div>
          ${ch.bio_link ? `<div class="mh-link"><a href="${esc(ch.bio_link)}" target="_blank" rel="noopener noreferrer">${esc(ch.bio_link.replace(/^https?:\/\//, ''))}</a></div>` : ''}
        </div>
        <div class="mh-actions">
          <button class="btn-star${ch.starred ? ' starred' : ''}" onclick="${P}ToggleStarModal('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${ch.starred ? '★' : '☆'}</button>
          ${_bookmarkBtn(ch, false)}
          <button id="${P}ModalRunQuickBtn" class="btn-run" ${runDisabled} onclick="${P}RunCreatorQuick('${esc(ch.channel_id)}')">${_refreshIcon} Quick</button>
          <button id="${P}ModalRunFullBtn" class="btn-run" ${runDisabled} onclick="${P}RunCreator('${esc(ch.channel_id)}')">${_refreshIcon} Full</button>
          <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run Profile',onclick:()=>${P}RunCreatorProfile('${esc(ch.channel_id)}')},{label:'Add note',onclick:()=>${P}ToggleModalNote()},{label:'Remove',danger:true,onclick:()=>{${P}CloseModal();${P}RemoveCreator('${esc(ch.channel_id)}','@${esc(ch.handle)}')}}])">&#x2022;&#x2022;&#x2022;</button>
          <label class="tracking-toggle" title="${isInactive ? `${ItemsCap} tracking off (profile changes still tracked)` : `${ItemsCap} tracking on`}" style="margin-left:auto">
            <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="${P}SetTracking('${esc(ch.channel_id)}', this.checked)">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">Track</span>
          </label>
        </div>
        <div id="${P}ModalNoteArea" style="display:${ch.comment ? '' : 'none'};margin-top:4px">
          <textarea placeholder="Add a note about this ${CREATOR}…"
            onblur="${P}SaveComment('${esc(ch.channel_id)}', this.value)"
            style="width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;resize:vertical;min-height:48px;max-height:160px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:inherit;line-height:1.5"
          >${esc(ch.comment || '')}</textarea>
        </div>
      </div>`;
  }

  X('SaveComment', async (id, value) => {
    const ok = await _saveCreatorComment(`${API}/channels`, id, value, creators, 'channel_id');
    if (ok && modalCreator && modalCreator.channel_id === id) modalCreator.comment = value.trim() || null;
  });

  X('ToggleStarModal', async id => {
    await _creatorToggleStar(`${API}/channels`, id, creators, 'channel_id', renderCreators);
    _syncStarBookmark(id);
    if (modalCreator && modalCreator.channel_id === id) _renderModalHeader(modalCreator);
  });

  X('ToggleModalNote', () => {
    const area = _el('ModalNoteArea');
    if (!area) return;
    const show = area.style.display === 'none';
    area.style.display = show ? '' : 'none';
    if (show) area.querySelector('textarea')?.focus();
  });

  // Bio popover: the full description opens over the content instead of expanding
  // inline. Clicks inside the popover don't close it (so the text stays selectable);
  // the X button or an outside click dismisses it.
  X('OpenBio',  el  => el.classList.add('open'));
  X('CloseBio', btn => btn.closest('.modal-bio')?.classList.remove('open'));
  const _w = /** @type {any} */ (window);
  if (!_w._bioOutsideClose) {
    _w._bioOutsideClose = true;
    document.addEventListener('click', e => {
      document.querySelectorAll('.modal-bio.open').forEach(b => {
        if (!b.contains(/** @type {Node} */ (e.target))) b.classList.remove('open');
      });
    });
  }

  // Modal engine delegates

  X('SetModalFilter',     f => _mSetFilter(MODAL_CFG, f));
  X('SetModalTypeFilter', t => _mSetTypeFilter(MODAL_CFG, t));
  X('ToggleModalToolbar', () => _mToggleToolbar(MODAL_CFG));
  X('SetModalSort',       f => _mSetSort(MODAL_CFG, f));
  // Single entry point for the modal's view toggle. List/Grid show the post
  // list; History and Stories swap in their own panels and lazily load data.
  X('SetModalView', async view => {
    _creatorState.view = view;
    const vidList = _el('ModalVideoList');
    const phist   = _el('PhistPanel');
    const stories = _el('StoriesPanel');
    if (view !== 'stories') _destroyStoriesPanel();
    if (vidList) vidList.style.display = (view === 'history' || view === 'stories') ? 'none' : '';
    if (phist)   phist.style.display   = view === 'history' ? '' : 'none';
    if (stories) stories.style.display = view === 'stories' ? '' : 'none';
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
    if (view === 'history')      await _loadPhist();
    else if (view === 'stories') await _loadStories();
    else _mRenderList(MODAL_CFG);
  });
  X('OnModalSearch', val => {
    _creatorState.search = val.trim();
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
    _mRenderList(MODAL_CFG);
  });

  // ── Profile history view ──────────────────────────────────────────────────
  // Fetches once per creator (cached by phistChId); the field filter pills live
  // on the toolbar (cfg.contextFilters) so they re-render there after the load.

  async function _loadPhist() {
    const panel = _el('PhistPanel');
    if (!panel || !modalCreatorId) return;
    if (phistChId !== modalCreatorId) {
      phistChId = modalCreatorId;
      phistData = [];
      panel.innerHTML = '<div class="vlist-loading">Loading history…</div>';
      const { ok, data } = await apiJSON(`${API}/channels/${modalCreatorId}/profile-history`);
      if (!ok || phistChId !== modalCreatorId || _creatorState.view !== 'history') return;
      phistData = data;
      _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // field pills now known
    }
    _renderPhistPanel();
  }

  // Field filter pills for the History view, injected into the toolbar's
  // context-filter area by cfg.contextFilters.
  function _phistFieldPillsHtml() {
    const fields = [...new Set(phistData.map(e => e.field))];
    if (!fields.length) return '';
    const pills = fields.map(f => {
      const active = phistField.has(f) ? ' active' : '';
      return `<button class="filter-pill${active}" onclick="${P}PhistSetField('${esc(f)}')">${FIELD_LABELS[f] || f}</button>`;
    }).join('');
    return `<span class="col-hdr" style="margin-right:2px">Fields</span><div class="filter-pills multi">${pills}</div>`;
  }

  // ── Stories history calendar (Cal-Heatmap month intensity view) ───────────

  let _storyCal = null;

  function _destroyStoriesPanel() {
    if (_storyCal) { try { _storyCal.destroy(); } catch { /* already gone */ } _storyCal = null; }
    const panel = _el('StoriesPanel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  }

  async function _loadStories() {
    const panel = _el('StoriesPanel');
    if (!panel || !modalCreatorId) return;
    panel.style.display = '';
    panel.innerHTML     = '<div class="vlist-loading">Loading stories…</div>';
    const chId = modalCreatorId;
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(chId)}/stories/calendar`);
    if (!ok || chId !== modalCreatorId || _creatorState.view !== 'stories') return;
    _renderStoriesPanel(data || {});
  }

  X('StoriesCalStep', dir => {
    if (!_storyCal) return;
    if (dir < 0) _storyCal.previous();
    else _storyCal.next();
  });

  X('PlayStoriesOfDay', async day => {
    if (!modalCreatorId) return;
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(modalCreatorId)}/stories`);
    if (!ok) return;
    const slides = (data || [])
      .filter(s => s.posted_at && new Date(s.posted_at * 1000).toLocaleDateString('sv') === day)
      .sort((a, b) => a.posted_at - b.posted_at)
      .map(s => ({ url: s.url, type: s.content_type === 'photo' ? 'image' : 'video' }));
    if (slides.length) openStorySlides(slides);
  });

  function _renderStoriesPanel(dayCounts) {
    const panel = _el('StoriesPanel');
    if (!panel) return;
    if (typeof CalHeatmap === 'undefined') {
      panel.innerHTML = '<div class="vlist-loading">Calendar library failed to load.</div>';
      return;
    }
    const total = Object.values(dayCounts).reduce((a, b) => a + b, 0);
    panel.innerHTML = `
      <div class="stories-cal-hdr">
        <span class="stories-cal-title">${total.toLocaleString()} ${total === 1 ? 'story' : 'stories'} saved · click a day to play it</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="filter-pill" onclick="${P}StoriesCalStep(-1)" title="Earlier months">←</button>
          <button class="filter-pill" onclick="${P}StoriesCalStep(1)" title="Later months">→</button>
        </div>
      </div>
      <div class="stories-cal" id="${P}StoriesCal"></div>`;

    let accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(accent)) accent = '#4f8ef7';
    const source = Object.entries(dayCounts).map(([date, value]) => ({ date, value }));
    const start  = new Date();
    start.setDate(1);
    start.setMonth(start.getMonth() - 3);

    _storyCal = new CalHeatmap();
    _storyCal.paint({
      itemSelector: `#${P}StoriesCal`,
      theme:     'dark',
      domain:    { type: 'month', gutter: 14, label: { text: 'MMM YYYY', textAlign: 'start', position: 'top' } },
      subDomain: { type: 'day', radius: 2, width: 13, height: 13, gutter: 3 },
      date:      { start, highlight: [new Date()] },
      range:     4,
      data:      { source, x: 'date', y: 'value' },
      scale:     { color: { type: 'threshold', domain: [1, 2, 4], range: [`${accent}44`, `${accent}88`, `${accent}bb`, accent] } },
    });
    _storyCal.on('click', (event, timestamp) => {
      const day = new Date(timestamp).toLocaleDateString('sv');
      if (dayCounts[day]) window[`${P}PlayStoriesOfDay`](day);
    });
  }

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

    const newValMap = _phistNewValMap();

    panel.innerHTML = entries.length
      ? entries.map(e => _phistEntryHtml(e, newValMap.get(e))).join('')
      : `<div style="color:var(--muted);font-size:13px;padding:12px 0">No profile changes recorded${phistField.size ? ' for the selected fields' : ''}.</div>`;
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

  // Single-choice: pick one field, or click the active one again to clear.
  X('PhistSetField', field => {
    phistField = phistField.has(field) ? new Set() : new Set([field]);
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // reflect active pill on the toolbar
    _renderPhistPanel();
  });

  // ── Tracking view (creators / log) ────────────────────────────────────────

  let trackingView = 'creators';

  X('SetTrackingView', view => {
    trackingView = view;
    const searchEl = _el('Search');
    if (searchEl) {
      // visibility, not display: the box still occupies its slot on the Log
      // view so the tab row keeps its height and the page never shifts
      searchEl.style.visibility = view === 'log' ? 'hidden' : '';
      if (view !== 'log') searchEl.value = '';
    }
    const countEl = _el('Count');
    if (countEl) countEl.style.visibility = view === 'log' ? 'hidden' : '';
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
    // offsetParent is null while this platform's tab is hidden, and the box
    // itself is visibility-hidden on the Log view
    if (!searchEl || !searchEl.offsetParent || searchEl.style.visibility === 'hidden') return;
    e.preventDefault();
    searchEl.focus();
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Overlay modals (carousel, image, video, sound, recent log, settings) sit
    // on top of the creator modal and close themselves via their own handler;
    // don't close both at once.
    for (const id of ['carouselModal', 'imgModal', 'vidModal', 'soundModalBackdrop', 'settingsBackdrop']) {
      if (document.getElementById(id) && document.getElementById(id).style.display !== 'none') return;
    }
    if (_el('ModalBackdrop')?.style.display !== 'none') {
      window[`${P}CloseModal`]();
    }
  }, true);

  // ── Live events (SSE) ─────────────────────────────────────────────────────
  //
  // The active platform tab holds one EventSource on /events; the server
  // pushes status and queue snapshots the moment they change, plus a
  // 'changed' event naming the data panels whose tables were written.
  // Hidden tabs close their stream (browsers cap concurrent HTTP/1.1
  // connections per origin, and four idle streams would crowd out normal
  // fetches) and fall back to the slow polls below. EventSource reconnects
  // on its own after a dropped connection and re-sends full status/queue
  // snapshots on connect.

  // Loader per 'changed' domain. Each refetches its panel; every loader is
  // signature-gated, so a refetch that comes back identical never touches
  // the DOM. A change drops the recent feed's per-filter page-one caches
  // too, since those went stale with the data.
  const _domainLoaders = Object.assign({
    creators: loadCreators,
    stats:    loadStats,
    recent:   () => { _rf.cache = {}; return loadRecent(); },
  }, cfg.extraDomainLoaders || {});
  const _domainState = {};
  const _REFETCH_GAP_MS = 2000;

  // Leading edge fires at once (one write renders within ~1 s of the server
  // tick); while events keep arriving (a session saves something every few
  // seconds for minutes) each panel refetches at most once per gap, trailing
  // edge included so the final state always lands.
  function _refetchDomain(domain) {
    const load = _domainLoaders[domain];
    if (!load) return;
    const st  = _domainState[domain] || (_domainState[domain] = { last: 0, timer: null });
    const due = st.last + _REFETCH_GAP_MS - Date.now();
    if (due <= 0) {
      st.last = Date.now();
      load();
    } else if (!st.timer) {
      st.timer = setTimeout(() => { st.timer = null; st.last = Date.now(); load(); }, due);
    }
  }

  let _es = null;
  let _esHadOpen = false;
  const _isActiveTab = () => (location.hash.slice(1) || 'tiktok') === cfg.id;

  function _syncEvents() {
    if (_isActiveTab() && !_es && window.EventSource) {
      _es = new EventSource(`${API}/events`);
      _es.addEventListener('status',  e => renderStatus(JSON.parse(e.data)));
      _es.addEventListener('queue',   e => _syncQueue(JSON.parse(e.data)));
      _es.addEventListener('changed', e => JSON.parse(e.data).forEach(_refetchDomain));
      _es.onopen = () => {
        // Any open after the first (tab switched back, or a reconnect after
        // a drop) may have missed 'changed' events, so refetch every domain;
        // status and queue re-send themselves on connect.
        if (_esHadOpen) Object.keys(_domainLoaders).forEach(_refetchDomain);
        _esHadOpen = true;
      };
    } else if (!_isActiveTab() && _es) {
      _es.close();
      _es = null;
    }
  }

  window.addEventListener('hashchange', _syncEvents);

  // ── Init ──────────────────────────────────────────────────────────────────

  loadCreators();
  loadStatus();
  loadStats();
  loadRecent();
  loadQueue();
  loadAddHistory(true);
  _syncEvents();

  _attachEdgeFade(_el('Controls'));
  EXTRA_VIEWS.forEach(v => _attachEdgeFade(_el(`Controls_${v.key}`)));
  _attachEdgeFade(_el('RecentFilterRow'));

  // While this tab is active, everything arrives over SSE: status and queue
  // as pushed snapshots, creators / stats / recent (and platform extras) as
  // 'changed' refetches. The polls below only cover hidden tabs and the
  // no-EventSource fallback.
  setInterval(() => { if (!_es) loadStatus(); }, 15000);
  setInterval(() => { if (!_es) loadQueue();  }, 15000);
  setInterval(() => { if (!_es) { loadCreators(); loadStats(); loadRecent(); } }, 60000);
  setInterval(_tickActivityBar, 1000);
  // Relative timestamps ("3m ago" on cards and feed rows) still need a
  // clock: re-render from memory once a minute, no fetch.
  setInterval(() => { if (_es) { renderCreators(); _renderFeed(); } }, 60000);

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
    // True while the SSE stream is open (active tab): platform extras use it
    // to demote their own polls to a no-stream fallback
    isLive:            () => !!_es,
    // Subscribe to add/track queue snapshots (SSE-pushed, poll fallback).
    // Returns an unsubscribe function.
    onQueue:           cb => { _queueSubs.add(cb); return () => _queueSubs.delete(cb); },
  };
}
