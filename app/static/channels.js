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
 * @property {string} [viewsLabel]       Video table views column (default 'Views'; Instagram/OnlyFans use 'Likes')
 * @property {boolean} [uploadDateOnly]  Render dates without time (YouTube)
 * @property {boolean} [hasBanner]       Show the banner slot in the detail modal
 * @property {Object<string, string>} [fieldLabels]     profile_history field -> label
 * @property {{key: string, label: string, defaults?: string[], dropdown?: boolean, options: {key: string, label: string}[], test: (ch: Object, active: Set<string>) => boolean}[]} [extraFilterGroups]
 * @property {{key: string, label: string, controlsHtml?: string, emptyLabel?: string, show: (search: string) => void}[]} [extraViews]
 * @property {{key: string, icon: string, title: string, label?: string}[]} [viewKeys]  Video-type filter tabs in the detail modal (label is the tab text)
 * @property {(view: string, vids: Object[]) => Object[]} [viewVideoFilter]
 * @property {(raw: string, addToasts: Object) => (boolean|Promise<boolean>)} [addHandler]  Return true when fully handled
 * @property {(state: Object) => void} [onStatus]       Called after every status render
 * @property {Object<string, () => void>} [extraDomainLoaders]  Platform panels refetched on SSE 'changed' domains (TikTok: sounds)
 * @property {() => void} [onCreatorsRefetched]  Called after the SSE creators domain refetches (TikTok: refresh the open sound modal)
 * @property {(state: Object) => boolean} [statusActive]  Extra 'running' signal for the header badge
 * @property {string} [statusActiveLabel]  What statusActive means, as a noun for the badge ("sound loop")
 * @property {() => (string|null)} [currentActivity]  Extra-loop activity line for the log bar (TikTok: sound loop stage)
 * @property {(state: Object) => {iso: string, label: string}[]} [nextRunCandidates]
 * @property {boolean} [hasStories]     Platform saves stories: adds the Stories card stat and sort option
 * @property {(s: Object) => Object[]} [statsRows]      Rows for the stat strip
 * @property {(item: Object) => string} [recentFallback]  Recent-feed line for disabled creators
 * @property {(ch: Object) => string} [gridClassFn]
 * @property {(v: Object) => string} [typeIconFn]
 * @property {(v: Object) => string} [thumbBadge]
 * @property {Function} [videoActionBtnsFn]
 * @property {(v: Object, ch: Object) => string} [videoUrl]  Original post URL on the platform (drives the Link buttons)
 * @property {(v: Object) => {label: string, danger?: boolean, disabled?: boolean, onclick: () => void}[]} [videoMenuItemsFn]  Items for the mobile row ••• menu
 * @property {{account?: {html: string, onShow?: () => void}, schedule?: {html: string, onShow?: () => void}, network?: {html: string, onShow?: () => void, onHide?: () => void}, jobs?: {html?: string, onShow?: () => void, onHide?: () => void, onRender?: () => void}, diag?: {html: string, onShow?: () => void}}} [settings]  Settings pane overrides and extras; Account/Schedule/Jobs/Database always exist, Network and Diagnostics only when provided
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

  /* The engine records these fields on every platform, so the defaults must
     cover them all; a platform map only overrides the wording */
  const FIELD_LABELS = Object.assign({
    handle: 'Handle', display_name: 'Display name', description: 'Bio', avatar: 'Avatar',
    bio_link: 'Bio link', account_status: 'Account status', privacy_status: 'Privacy', banner: 'Banner',
  }, cfg.fieldLabels || {});

  const EXTRA_FILTER_GROUPS = cfg.extraFilterGroups || [];
  const EXTRA_VIEWS         = cfg.extraViews || [];

  // ── Section HTML ──────────────────────────────────────────────────────────

  const _bmOutline = `<svg class="ic" viewBox="1.8 1.8 20.4 20.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.5L6 21V3z"/></svg>`;
  const _lockIcon   = `<svg class="ic" viewBox="0.9 0.9 22.2 22.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const _unlockIcon = `<svg class="ic" viewBox="0.9 0.9 22.2 22.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
  const _LOCK_TIP   = 'List scrolls with the page. Tap to scroll the list itself.';
  const _UNLOCK_TIP = 'List scrolls independently. Tap to lock it to the page.';
  const _bmFilled  = `<svg class="ic" viewBox="2 2 20 20" fill="currentColor"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-5.5L5 22V3a1 1 0 0 1 1-1z"/></svg>`;

  // The modal header's action row, shared verbatim by the desktop and mobile
  // headers: star, bookmark, Quick, Full, and the overflow menu
  const _modalActionBtns = (ch, runDisabled) => `<button class="btn-star${ch.starred ? ' starred' : ''}" onclick="${P}ToggleStarModal('${esc(ch.channel_id)}')" title="${ch.starred ? 'Unstar' : 'Star'}">${_starIcon(ch.starred)}</button>
          ${_bookmarkBtn(ch)}
          <button id="${P}ModalRunQuickBtn" class="btn-run" ${runDisabled} title="Quick check: the newest posts only, no deletion detection" onclick="${P}RunCreatorQuick('${esc(ch.channel_id)}')">${_refreshIcon} Quick</button>
          <button id="${P}ModalRunFullBtn" class="btn-run" ${runDisabled} title="Full check: the whole catalog, detects deletions" onclick="${P}RunCreator('${esc(ch.channel_id)}')">${_refreshIcon} Full</button>
          <button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Run profile',onclick:()=>${P}RunCreatorProfile('${esc(ch.channel_id)}')},{label:'Edit note',onclick:()=>${P}EditNote()},{label:'${ch.pinned_at ? 'Remove from Quick access' : 'Add to Quick access'}',onclick:()=>${P}TogglePinModal('${esc(ch.channel_id)}')},{label:'Remove',danger:true,onclick:()=>{${P}CloseModal();${P}RemoveCreator('${esc(ch.channel_id)}','@${esc(ch.handle)}')}}])">${_dotsIcon}</button>`;
  const _bookmarkBtn = ch => `<button class="btn-bookmark${ch.bookmarked ? ' bookmarked' : ''}"
      data-action="bookmark" data-id="${esc(ch.channel_id)}"
      aria-pressed="${ch.bookmarked ? 'true' : 'false'}" title="${ch.bookmarked ? (ch.starred ? `Starred ${CREATORS} stay bookmarked` : 'Remove bookmark') : 'Bookmark'}">${ch.bookmarked ? _bmFilled : _bmOutline}</button>`;

  // Shimmer placeholder rows reserve the dashboard lists' layout until the
  // first page of feed/history data lands (same idea as the grid skeletons).
  // Bar widths cycle through a fixed pattern so the rows read as organic.
  const _SKEL_W = [62, 45, 71, 38, 55, 67, 43, 58];
  const _RF_SKEL = _SKEL_W.map(w => `<div class="rf-row skel-row" aria-hidden="true">
      <span class="skel-dot" style="width:13px;height:13px"></span>
      <span class="skel-dot" style="width:20px;height:20px"></span>
      <span class="skel-bar" style="width:${w}%"></span>
      <span class="skel-bar" style="width:48px"></span>
      <span class="skel-bar" style="width:76px;justify-self:end"></span>
    </div>`).join('');
  const _AH_SKEL = _SKEL_W.slice(0, 6).map(w => `<div class="ah-row" aria-hidden="true"><div class="ah-row-content skel-row">
      <span class="skel-dot" style="width:13px;height:13px"></span>
      <span class="skel-bar" style="width:${Math.min(w, 58)}%"></span>
      <span class="skel-bar" style="width:44px"></span>
      <span class="skel-bar" style="width:76px;justify-self:end"></span>
    </div></div>`).join('');

  function _sectionHtml() {
    return `
  <div class="add-bar">
    <div class="add-bar-input-row">
      <div class="add-bar-input" id="${P}HandleInput" contenteditable="true" role="textbox"
           aria-label="${cfg.addAriaLabel}" data-placeholder="${cfg.addPlaceholder}"
           data-placeholder-short="@username or link" spellcheck="false"></div>
      <button class="add-bar-paste-btn" onclick="${P}AddPaste()" aria-label="Paste">Paste</button>
    </div>
    <button class="btn-primary" onclick="${P}AddCreator()">Add</button>
  </div>

  <div class="qa-panel">
    <button class="qa-title" onclick="${P}OpenQaList()" title="Manage Quick access">Quick access</button>
    <!-- Placeholder slots reserve the row height until the creators load,
         so the avatars swap in without shifting the page (5 = _QA_MIN_SLOTS) -->
    <div class="qa-row" id="${P}QuickAccess">${'<span class="conn-slot conn-slot-empty"></span>'.repeat(5)}</div>
  </div>

  <!-- Desktop renders the strip directly (display:contents); on mobile the
       panel becomes a collapsible with the Statistics toggle, closed by default -->
  <div class="stats-area">
    <button class="stats-toggle" onclick="${P}ToggleStats(this)">Stats <span class="stats-caret">${_caretIcon}</span></button>
    <div class="stat-strip-wrap" id="${P}StatsWrap">
      <div class="stat-strip" id="${P}StatsGrid"></div>
    </div>
  </div>

  <div class="dash-row">
  <div class="panel-card recent-card">
    <div class="panel-header">
      <span class="section-title">Recent activity</span>
      <div class="edge-fade hdr-filter" id="${P}RecentFilterRow">
        <div class="filter-pills multi hdr-pills" onpointerenter="${P}PrefetchFeedKinds()">
          <button class="filter-pill active" id="${P}Rf_all"     onclick="${P}SetRecentFilter('all')">All</button>
          <button class="filter-pill"        id="${P}Rf_saved"   onclick="${P}SetRecentFilter('saved')">Saved</button>
          ${cfg.hasStories ? `<button class="filter-pill" id="${P}Rf_story" onclick="${P}SetRecentFilter('story')">Stories</button>` : ''}
          <button class="filter-pill"        id="${P}Rf_deleted" onclick="${P}SetRecentFilter('deleted')">Deleted</button>
          <button class="filter-pill"        id="${P}Rf_changed" onclick="${P}SetRecentFilter('changed')">Changes</button>
          <button class="filter-pill" id="${P}Rf_banned" onclick="${P}SetRecentFilter('banned')">Bans</button>
        </div>
        <span style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn-star" id="${P}RfStar" onclick="${P}ToggleRfStar()" title="Only starred ${CREATORS}">${_starIcon(false)}</button>
          <button class="btn-bookmark" id="${P}RfBook" onclick="${P}ToggleRfBook()" title="Only bookmarked ${CREATORS}">${_bmOutline}</button>
          <button class="btn-reset-filter" onclick="${P}ResetRecentFilters()" title="Reset filters">${_xCircleIcon}</button>
        </span>
      </div>
      <button class="btn-reset-filter panel-scroll-lock" id="${P}RfLock" onclick="${P}ToggleScrollLock('${P}RecentFeed', this)" aria-pressed="true" title="${_LOCK_TIP}">${_lockIcon}</button>
    </div>
    <div class="recent-feed scroll-locked" id="${P}RecentFeed">${_RF_SKEL}</div>
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
        <div id="${P}LoopSessions" class="loop-sessions">${'<span class="loop-session-pill skel-pill">00:00</span>'.repeat(3)}</div>
        <div class="loop-actions">
          <div style="display:flex;gap:5px">
            <button class="btn-run btn-trigger" id="${P}TriggerNextBtn"    onclick="${P}TriggerNext()">${_refreshIcon} Next</button>
            <button class="btn-run btn-trigger" id="${P}TriggerStarredBtn" onclick="${P}TriggerStarred()">${_refreshIcon} Starred</button>
            <button class="btn-run btn-trigger" id="${P}TriggerHalfBtn"    onclick="${P}TriggerHalf()">${_refreshIcon} Half</button>
            <button class="btn-run btn-trigger" id="${P}TriggerAllBtn"     onclick="${P}TriggerAll()">${_refreshIcon} All</button>
          </div>
          <button class="btn-danger btn-trigger" id="${P}StopBtn" onclick="${P}StopLoop()" disabled>Stop</button>
        </div>
      </div>
      ${cfg.extraLoopHtml ? `<div id="${P}LoopBlockExtra" style="display:none">${cfg.extraLoopHtml}</div>` : ''}
    </div>
  </div>
  <div class="panel-card ah-card">
    <div class="panel-header"><span class="section-title">Add history</span>
      <button class="btn-reset-filter panel-scroll-lock" style="margin-left:auto" id="${P}AhLock" onclick="${P}ToggleScrollLock('${P}AddHistory', this)" aria-pressed="false" title="${_LOCK_TIP}">${_lockIcon}</button>
    </div>
    <div class="add-history scroll-locked" id="${P}AddHistory">${_AH_SKEL}</div>
  </div>
  </div>
  </div>

  <section>
    <div style="margin-bottom:12px;">
      <div class="view-tabs-row">
        <div class="view-tabs">
          <button class="tab active" id="${P}TvCreators" onclick="${P}SetTrackingView('creators')">${CreatorsCap}</button>
          ${EXTRA_VIEWS.map(v => `<button class="tab" id="${P}Tv_${v.key}" onclick="${P}SetTrackingView('${v.key}')">${v.label}</button>`).join('')}
          <button class="tab"        id="${P}TvLog"      onclick="${P}SetTrackingView('log')">Log</button>
        </div>
        <span id="${P}Count" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
        <span class="search-row">
          <input id="${P}Search" class="tracking-search" type="search" placeholder="Search…" oninput="${P}OnSearch(this.value)">
          <button class="sort-dir-btn search-reset" id="${P}SearchReset" onclick="${P}ResetFilters()" title="Reset filters and sort">Reset</button>
        </span>
      </div>
      <div id="${P}Controls" class="filter-control-group edge-fade" style="margin-top:10px">
        <div class="filter-row">
          <span class="filter-row-label">Flags</span>
          <div class="filter-pills multi">
            <button class="filter-pill" id="${P}fStarStarred" onclick="${P}SetFilter('star','starred')">Starred</button>
            <button class="filter-pill" id="${P}fBookBookmarked" onclick="${P}SetFilter('book','bookmarked')">Bookmarked</button>
          </div>
        </div>
        ${EXTRA_FILTER_GROUPS.map(g => `
        <div class="filter-row">
          <span class="filter-row-label">${g.label}</span>
          ${g.dropdown ? _fdHtml(g) : `<div class="filter-pills multi">
            ${g.options.map(o => `<button class="filter-pill${(g.defaults || []).includes(o.key) ? ' active' : ''}" id="${P}f_${g.key}_${o.key}" onclick="${P}SetFilter('${g.key}','${o.key}')">${o.label}</button>`).join('')}
          </div>`}
        </div>`).join('')}
        <div class="filter-row">
          <span class="filter-row-label">Tracking</span>
          <div class="filter-pills multi">
            <button class="filter-pill active" id="${P}fStatActive" onclick="${P}SetFilter('stat','active')">Active</button>
            <button class="filter-pill" id="${P}fStatInactive" onclick="${P}SetFilter('stat','inactive')">Inactive</button>
          </div>
        </div>
        <div class="filter-row">
          <span class="filter-row-label">Sort</span>
          <div class="sort-controls">
            ${_ddHtml(`${P}SortField`, [
              { value: 'random',           label: 'Random' },
              { value: 'handle',           label: 'Handle' },
              { value: 'display_name',     label: 'Display name' },
              { value: 'subscriber_count', label: cfg.subLabelSort },
              { value: 'video_total',      label: `Saved ${ITEMS}` },
              { value: 'video_deleted',    label: `Deleted ${ITEMS}` },
              ...(cfg.hasStories ? [{ value: 'story_count', label: 'Stories' }] : []),
              { value: 'media_size_bytes', label: 'Storage' },
              { value: 'added_at',         label: 'Date added' },
              { value: 'last_checked',     label: 'Last checked' },
              { value: 'last_saved',       label: 'Last saved' },
            ], { value: 'random', onchange: `${P}SetSortField(_ddValue('${P}SortField'))` })}
            <button class="sort-dir-btn" id="${P}SortDirBtn" onclick="${P}ToggleSortDir()">Shuffle</button>
            <button class="sort-dir-btn controls-reset" onclick="${P}ResetFilters()" title="Reset filters and sort">Reset</button>
          </div>
        </div>
      </div>
      ${EXTRA_VIEWS.map(v => `<div id="${P}Controls_${v.key}" class="filter-control-group edge-fade" style="display:none;margin-top:10px">${v.controlsHtml || ''}</div>`).join('')}
    </div>
    <div class="users-grid" id="${P}Grid">
      ${Array(6).fill('<div class="user-card skeleton-card" aria-hidden="true"></div>').join('')}
    </div>
    ${EXTRA_VIEWS.map(v => `<div class="users-grid" id="${P}Grid_${v.key}" style="display:none">${Array(6).fill('<div class="user-card skeleton-card" aria-hidden="true"></div>').join('')}</div>`).join('')}
    <div id="${P}LogPanel" style="display:none">
      <div class="log-panel">
        <div class="log-header">
          <div style="display:flex;align-items:center;gap:12px;">
            <label class="tracking-toggle">
              <input type="checkbox" id="${P}AutoScroll" checked>
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">Auto-scroll</span>
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
    return _modalShellHtml(`${P}Modal`, `${P}CloseModal`, {
      bannerHtml: cfg.hasBanner ? `<div class="yt-modal-banner" id="${P}ModalBanner" style="display:none"></div>` : '',
      panelsHtml: `
    <div class="phist-panel"      id="${P}PhistPanel" style="display:none"></div>
    <div class="stories-panel"    id="${P}StoriesPanel" style="display:none"></div>
    <div class="stats-panel"      id="${P}StatsPanel" style="display:none"></div>`,
      scrollTopFn: `${P}ScrollModalTop`,
      afterHtml: `
  <dialog class="about-modal" id="${P}AboutModal" onclick="if(event.target===this)${P}CloseAbout()">
    <div class="about-card">
      <button class="modal-close" onclick="${P}CloseAbout()" aria-label="Close">${_xIcon}</button>
      <h3 class="about-title">About</h3>
      <div id="${P}AboutBody"></div>
    </div>
  </dialog>`,
    });
  }

  document.getElementById(`platform-${cfg.id}`).innerHTML = _sectionHtml();
  document.body.insertAdjacentHTML('beforeend', _modalHtml());
  // Delegated clicks for the creator grid and modal header: buttons carry
  // data-action/data-id, so re-renders never rebuild handlers and no closure
  // is serialized into an attribute. Handlers resolve through window at click
  // time (the X() exports are defined later in this closure).
  _delegate(document.getElementById(`${P}Grid`), {
    open: (d, el, e) => {
      if (e.target instanceof Element && e.target.closest('button')) return;
      window[`${P}OpenModal`](el.getAttribute('data-channelid'));
    },
    stories:  d => window[`${P}OpenStories`](d.id),
    avatar:   d => openImgModalUrl(`${API}/channels/${d.id}/avatar`),
    star:     d => window[`${P}ToggleStar`](d.id),
    bookmark: d => window[`${P}ToggleBookmark`](d.id),
    quick:    d => window[`${P}RunCreatorQuick`](d.id),
    full:     d => window[`${P}RunCreator`](d.id),
    menu:     (d, el) => _openCardMenu(el, [
      { label: 'Run profile', onclick: () => window[`${P}RunCreatorProfile`](d.id) },
      { label: 'Remove', danger: true, onclick: () => window[`${P}RemoveCreator`](d.id, `@${d.handle}`) },
    ]),
  });
  _delegate(document.getElementById(`${P}ModalHeader`), {
    bookmark: d => window[`${P}ToggleBookmark`](d.id),
  });

  // Creator-modal close cleanup runs on every close path (button, backdrop
  // click, native Escape)
  _dlgWire(`${P}ModalBackdrop`, () => {
    if (_creatorState.obs) { _creatorState.obs.disconnect(); _creatorState.obs = null; }
    modalCreatorId = null;
    modalCreator   = null;
    _creatorState.videos = [];
  });

  // Compact list modal behind the connections panel's more/manage button:
  // every connected creator with avatar and names, click opens their modal,
  // the x detaches the connection (both directions, it is one link).
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="conn-backdrop" id="${P}ConnListModal" onclick="if(event.target===this)${P}CloseConnList()">
      <div class="conn-list">
        <div class="conn-list-head">
          <span>Connected ${CREATORS}</span>
          <button class="modal-close" onclick="${P}CloseConnList()" title="Close" aria-label="Close">${_xIcon}</button>
        </div>
        <div class="conn-list-rows" id="${P}ConnListRows"></div>
        <div class="conn-list-foot">
          <button class="btn-sm" onclick="${P}ConnectAdd()">Connect a ${CREATOR}…</button>
        </div>
      </div>
    </dialog>`);

  // Same list modal shape for managing Quick Access pins (opened from the
  // panel title); rows open the creator's modal, the x unpins.
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="conn-backdrop" id="${P}QaListModal" onclick="if(event.target===this)${P}CloseQaList()">
      <div class="conn-list">
        <div class="conn-list-head">
          <span>Quick access</span>
          <button class="modal-close" onclick="${P}CloseQaList()" title="Close" aria-label="Close">${_xIcon}</button>
        </div>
        <div class="conn-list-rows" id="${P}QaListRows"></div>
        <div class="conn-list-foot">
          <button class="btn-sm" onclick="${P}QuickAccessAdd()">Add a ${CREATOR}…</button>
        </div>
      </div>
    </dialog>`);

  // ── State ─────────────────────────────────────────────────────────────────

  let creators       = [];
  let sort           = { field: 'random', dir: 'asc' };
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
  let currentStage   = null;   // what the current check is doing right now, for the activity bar
  let pendingRescans = {};     // {channel_id: fires_at_unix_secs} for large-spike midpoint re-scans
  let logSeq           = 0;    // log_seq from last server response (monotonic, resets on app restart)
  let logClearSeq      = 0;    // lines before this seq were cleared; don't re-render them
  let logClearRestored = false;
  let sleepUntil     = null;   // Unix timestamp (ms) when current sleep ends; null = no sleep
  let sleepNext      = null;   // Label for what runs after the sleep
  let nextRuns       = [];     // [{iso, label}] upcoming scheduled runs for the activity bar
  let cleanupPoll    = null;

  const SORT_DIR_LABELS = {
    random:           { asc: 'Shuffle',      desc: 'Shuffle'      },
    handle:           { asc: 'A → Z',        desc: 'Z → A'        },
    display_name:     { asc: 'A → Z',        desc: 'Z → A'        },
    subscriber_count: { asc: 'Low → High',   desc: 'High → Low'   },
    video_total:      { asc: 'Low → High',   desc: 'High → Low'   },
    video_deleted:    { asc: 'Low → High',   desc: 'High → Low'   },
    story_count:      { asc: 'Low → High',   desc: 'High → Low'   },
    media_size_bytes: { asc: 'Smallest',     desc: 'Largest'      },
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
      ${v.duration ? `<span class="thumb-dur">${fmtDur(v.duration)}</span>` : ''}
    </div>`;
  }

  // Pre-rendered details HTML carried on viewer slides: a sidebar right of
  // the media on desktop, an overlay behind the topbar info button on mobile.
  // Rows render only when the platform populates the field.
  function _mvInfoFor(v) {
    const { label: statusLabel } = _videoStatus(v);
    const rows = [
      ['Status', statusLabel],
      [cfg.viewsLabel || 'Views', v.view_count != null ? fmtCount(v.view_count) : null],
      ['Likes', v.like_count != null ? fmtCount(v.like_count) : null],
      ['Comments', v.comment_count != null ? fmtCount(v.comment_count) : null],
      ['Duration', v.duration ? fmtDur(v.duration) : null],
      ['Resolution', v.width && v.height ? `${v.width}x${v.height}` : null],
      ['Uploaded', v.upload_date ? fmt.date(v.upload_date) : null],
      ['Downloaded', v.download_date ? fmt.date(v.download_date) : null],
      ['Deleted', v.deleted_at ? fmt.date(v.deleted_at) : null],
      ['Post ID', esc(v.video_id)],
    ].filter(([, val]) => val != null);
    return `<div class="mv-info-title">Details</div>
      ${v.description ? `<div class="mv-info-desc">${esc(v.description)}</div>` : ''}
      ${rows.map(([l, val]) => _hgRow(l, val)).join('')}`;
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

  // Original post URL for the Link buttons; null (greyed button) for deleted
  // posts, whose URL is dead by definition.
  function _videoUrl(v) {
    if (!cfg.videoUrl || !modalCreator || v.status === 'deleted') return null;
    return cfg.videoUrl(v, modalCreator);
  }

  // Overflow (•••) menu for a post row, mirroring the channel-card menu. Currently
  // just Download; the list is here so future per-post actions slot straight in.
  function _downloadVideo(id, name) {
    const a = document.createElement('a');
    a.href = `${API}/videos/${encodeURIComponent(id)}/file`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function _videoMenuItems(v) {
    const items = [];
    if (v.file_path) {
      const id   = esc(v.video_id);
      const ext  = _mediaExt(v) || 'mp4';
      const name = _isMulti(v) ? (v.file_path.split('/').pop()) : `${id}.${ext}`;
      items.push({ label: 'Download', onclick: () => _downloadVideo(v.video_id, name) });
    }
    if (cfg.videoUrl) {
      const link = _videoUrl(v);
      items.push({ label: 'Open link', disabled: !link,
                   onclick: () => { if (link) window.open(link, '_blank', 'noopener'); } });
    }
    return items;
  }
  X('VideoMenu', (btn, vid) => {
    const v = _creatorState.videos.find(x => x.video_id === vid);
    if (!v) return;
    const items = (cfg.videoMenuItemsFn || _videoMenuItems)(v);
    if (items.length) _openCardMenu(btn, items);
  });

  X('OpenImgModal', videoId => {
    openImgModalUrl(`${API}/videos/${encodeURIComponent(videoId)}/thumbnail`);
  });

  // Normal video playback goes through the shared media viewer as a single
  // video slide (play/pause, mute, and seek chrome; no nav arrows).
  X('OpenVidModal', videoId => {
    const v   = _creatorState.videos.find(x => x.video_id === videoId);
    const ext = (v && _mediaExt(v)) || 'mp4';
    openMediaViewer([{
      url:  `${API}/videos/${encodeURIComponent(videoId)}/file`,
      type: 'video',
      name: `${videoId}.${ext}`,
      link: v ? _videoUrl(v) : null,
      info: v ? _mvInfoFor(v) : null,
    }]);
  });

  X('OpenCarousel', async videoId => {
    const { ok, data } = await apiJSON(`${API}/videos/${encodeURIComponent(videoId)}/files`);
    if (!ok || !data.files || !data.files.length) return;
    const v    = _creatorState.videos.find(x => x.video_id === videoId);
    const link = v ? _videoUrl(v) : null;
    const info = v ? _mvInfoFor(v) : null;
    openMediaViewer(data.files.map(f => ({ ...f, link, info })));
  });

  // Story row to viewer slide; name feeds the viewer's Download action (the
  // stories file route serves .mp4 for videos and .avif for photos).
  const _storySlide = s => ({
    url:  s.url,
    type: s.content_type === 'photo' ? 'image' : 'video',
    name: `${s.story_id}.${s.content_type === 'photo' ? 'avif' : 'mp4'}`,
    // Fire-and-forget viewed stamp; the write bumps the creators SSE domain,
    // so the avatar rings grey out on the next refetch without a reload
    onView: () => { apiJSON(`${API}/stories/${encodeURIComponent(s.story_id)}/viewed`, { method: 'POST' }); },
  });

  // Open a creator's live stories in the story viewer, oldest first. Reached
  // from the ringed avatars; the ring only renders when live_stories > 0, but
  // a story can expire between the poll and the click, hence the fallback.
  X('OpenStories', async channelId => {
    openMediaViewerPending();  // overlay + spinner on the click itself
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(channelId)}/stories`);
    if (!_mvIsOpen()) return;  // closed while the list loaded
    if (!ok) { closeMediaViewer(); return; }
    const live = (data || []).filter(s => s.live).reverse();
    if (!live.length) {
      closeMediaViewer();
      showToast('No live stories right now.');
      return;
    }
    openStoryViewer(live.map(_storySlide));
  });

  // ── Detail modal config ───────────────────────────────────────────────────

  const VCOLS = [
    { field: null,            label: '' },
    { field: null,            label: cfg.titleColLabel || 'Title' },
    { field: 'status',        label: 'Status' },
    { field: 'view_count',    label: cfg.viewsLabel || 'Views' },
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
  const _historyIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3.5 2"/></svg>`;
  const _storiesTabIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" stroke-dasharray="3.2 2.6"/><polygon points="10,8.5 16.5,12 10,15.5" fill="currentColor" stroke="none"/></svg>`;
  const _statsTabIcon   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,17 9,11 13,14 21,6"/><polyline points="15,6 21,6 21,12"/></svg>`;
  /* The list tab is labeled with the platform's own item noun (Tweets, Posts,
     Videos); the grid key is 'grid' so it cannot collide with YouTube's
     'videos' view key */
  const _baseViewKeys = cfg.viewKeys || [
    { key: 'list', icon: _listViewIcon, title: 'List view', label: ItemsCap },
    { key: 'grid', icon: _gridViewIcon, title: 'Grid view', label: 'Grid' },
  ];
  // History is always offered; Stories on any stories-capable platform (even
  // with no saved stories yet). label is the mobile tab text.
  const _modalViewKeys = () => {
    const keys = [..._baseViewKeys,
      { key: 'stats',   icon: _statsTabIcon, title: 'Statistics',      label: 'Stats' },
      { key: 'history', icon: _historyIcon,  title: 'Profile history', label: 'History' }];
    // Stories tab shows on any stories-capable platform, even with no saved stories yet.
    if (cfg.hasStories)
      keys.push({ key: 'stories', icon: _storiesTabIcon, title: 'Stories', label: 'Stories' });
    return keys;
  };

  const MODAL_CFG = {
    st:             _creatorState,
    itemNoun:       ITEM,
    itemNounPlural: ITEMS,
    listElId:       `${P}ModalVideoList`,
    toolbarElId:    `${P}ModalToolbar`,
    cols:           VCOLS,
    colsCls:        'vcols',
    pageSize:       50,
    // Date plus time of day by default; platforms whose API only provides a
    // calendar date (YouTube) set cfg.uploadDateOnly
    uploadDateFmt:  cfg.uploadDateOnly ? fmtDateOnly : fmtDateShort,
    viewsNoun:      (cfg.viewsLabel || 'Views').toLowerCase(),  // mobile row meta text
    filterFn:     `${P}SetModalFilter`,
    typeFilterFn: `${P}SetModalTypeFilter`,
    sortFn:       `${P}SetModalSort`,
    toggleFn:     `${P}ToggleModalToolbar`,
    searchFn:     `${P}OnModalSearch`,
    authorCol:    null,
    hasSearch:    true,
    hasViewToggle: true,
    desktopTabs:  true,   // left-aligned underline tab header on desktop (like mobile, not full-width)
    mobileRows:   true,   // render the list as YouTube-style card rows on mobile
    mobileToolbar: true,  // text tabs + filter/sort dropdowns on mobile
    filtersHostId: `${P}ModalFilters`,  // mobile filter row lives in its own scroll-flow element
    mSortFn:      `${P}MSort`,
    mStatusFn:    `${P}MStatus`,
    mTypeFn:      `${P}MType`,
    viewFn:       `${P}SetModalView`,
    viewKeys:     _modalViewKeys,
    // History swaps the post filters for a Fields dropdown, rendered into the
    // toolbar's context-filter area (desktop) or the mobile filter row; both
    // non-media views report their count line via viewCount.
    contextFilters: _modalContextFilters,
    mobileFilters:  _modalContextFilters,
    viewCount:      _modalViewCount,
    viewVideoFilter: cfg.viewVideoFilter || ((view, vids) => vids),
    gridClassFn:     cfg.gridClassFn || (() => ''),
    typeIconFn:      cfg.typeIconFn || (v => _isMulti(v) ? _vgridPhotoIcon : (v.type === 'photo' || _isImage(v)) ? _vgridImageIcon : _vgridPlayIcon),
    gridId:       `${P}VideoGrid`,
    thumbCellFn:  _thumbCell,
    actionBtnsFn: _videoActionBtns,
    videoUrlFn:   cfg.videoUrl ? _videoUrl : null,  // Link button beside Download in the actions cell
    videoMenuFn:  `${P}VideoMenu`,   // mobile list rows: ••• overflow menu (Download, ...)
    previewFn:    `${P}OpenImgModal`,
    gridThumbSrc: v => `${API}/videos/${esc(v.video_id)}/thumbnail`,
    gridCellOnclick: v => _isMulti(v)
      ? window[`${P}OpenCarousel`](v.video_id)
      : _isImage(v)
        ? openImgModalUrl(`${API}/videos/${encodeURIComponent(v.video_id)}/file`)
        : window[`${P}OpenVidModal`](v.video_id),
  };

  // ── Stats panel ───────────────────────────────────────────────────────────

  // Videos/Photos count individual media files on disk (one post can be 20
  // photos), unlike Saved which counts posts. Same layout as TikTok's bar.
  const _statsRows = cfg.statsRows || (s => [
    { label: `Tracked ${CREATORS}`, value: (s.channel_count || 0).toLocaleString() },
    { label: `Saved ${ITEMS}`,      value: (s.saved_count   || 0).toLocaleString() },
    { label: 'Video files',         value: (s.media_video_files || 0).toLocaleString() },
    { label: 'Photo files',         value: (s.media_photo_files || 0).toLocaleString() },
    { label: 'Deleted',             value: (s.deleted_count || 0).toLocaleString() },
    { label: 'Latest saved',        value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '–' },
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

  // ── Dashboard list plumbing ───────────────────────────────────────────────
  //
  // Both dashboard lists (recent activity, add history) refresh on every write
  // while a loop runs, so they render through `_reconcileRows` rather than an
  // innerHTML rewrite: see the helper in common.js for why. These two wrap the
  // parts that are not the row diff itself. `state` is the panel's `{obs,
  // hasMore, ...}` holder.

  // Placeholder states (skeleton, empty, error) replace the whole list, so they
  // bypass the row diff; the stash makes a repeat write a no-op.
  function _listPlaceholder(el, state, html) {
    if (el.dataset.ph === html) return;
    el.dataset.ph = html;
    if (state.obs) { state.obs.disconnect(); state.obs = null; }
    el.innerHTML = html;
  }

  // Re-arm the paging sentinel only when rows actually moved. An idle
  // re-render (the minute tick rolling relative day labels) leaves the armed
  // one alone; re-arming there would fire the observer again and page in
  // another block at the bottom of the list.
  function _listSentinel(el, state, changed, load) {
    if (!changed) return;
    if (state.obs) { state.obs.disconnect(); state.obs = null; }
    el.querySelector('.list-sentinel')?.remove();
    if (state.hasMore) state.obs = _attachSentinel(el, load);
  }

  // ── Recent panel ──────────────────────────────────────────────────────────

  // Usernames stay neutral (state lives in the row tint), with two exceptions:
  // a banned creator's name renders red, a soft-disabled one dims. Starred
  // creators get a gold star prefix.
  const _nameStyle = r => r.account_status === 'banned' ? 'style="color:var(--red)"'
    : r.enabled === 0 ? 'style="color:var(--text-dim)"' : '';
  // line-height 1 so the larger glyph cannot stretch the 12px row
  const _namePrefix = r => r.starred ? '<span style="color:var(--gold);font-size:15px;line-height:1">★</span> ' : '';

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
    saved:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16"/></svg>',
    story:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" stroke-dasharray="3.4 2.8"/><polygon points="10,8.5 16.5,12 10,15.5" fill="currentColor" stroke="none"/></svg>',
    deleted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    changed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L7 21H3v-4L17 3z"/></svg>',
    banned:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/></svg>',
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

  // Row identity for the keyed diff: kind, creator, event timestamp, plus the
  // field for profile changes since one check can write several at once.
  // Grouped events (saved/story/deleted) re-key when they absorb a newer post,
  // which is what we want: their count changed, so the row has to be rewritten.
  const _rfKeyOf = ev => `${ev.kind}|${ev.item.channel_id}|${ev.ts}|${ev.item.field || ''}`;

  function _rfAttrs(ev) {
    const it = ev.item;
    const onclick = ev.kind === 'saved' || ev.kind === 'deleted'
      ? _recentOnclick(it, ev.kind)
      : ev.kind === 'changed'
        ? `${P}OpenModalWithHistory('${esc(it.channel_id)}','${esc(it.field)}')`
        : `${P}OpenModal('${esc(it.channel_id)}')`;
    return { class: `rf-row rf-k-${ev.kind}`, onclick, title: `Open @${esc(it.handle)}` };
  }

  function _rfRow(ev, now) {
    const it = ev.item;
    const detail = ev.kind === 'saved'   ? `${it.count} saved`
                 : ev.kind === 'story'   ? `${it.count} ${it.count === 1 ? 'story' : 'stories'}`
                 : ev.kind === 'deleted' ? `${it.count} deleted`
                 : ev.kind === 'changed' ? esc(FIELD_LABELS[it.field] || it.field)
                 : 'Banned';
    return `<span class="rf-icon rf-${ev.kind}">${_RF_ICONS[ev.kind]}</span>
      <span class="rf-avatar-wrap"><img class="rf-avatar" src="${API}/channels/${esc(it.channel_id)}/avatar?size=thumb" loading="lazy" alt="" onerror="this.remove()"></span>
      <span class="rf-name" ${_nameStyle(it)}>${_namePrefix(it)}@${esc(it.handle)}</span>
      <span class="rf-detail rf-${ev.kind}">${detail}</span>
      <span class="rf-time">${_recentDate(ev.ts, now)}</span>`;
  }

  const _rfInitRow = node => { node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); };

  function _renderFeed(loading) {
    const el = document.getElementById(`${P}RecentFeed`);
    if (!el) return;
    if (!_rf.items.length) {
      _listPlaceholder(el, _rf, loading ? _RF_SKEL : '<div class="rf-empty">No activity yet</div>');
      return;
    }
    const now = new Date();
    delete el.dataset.ph;
    const changed = _reconcileRows(el, _rf.items.map(ev => ({
      key: _rfKeyOf(ev), html: _rfRow(ev, now), attrs: _rfAttrs(ev),
    })), _rfInitRow);
    _listSentinel(el, _rf, changed, _loadFeedMore);
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
    // A different filter is a different list, so this is the one case that
    // should jump back to the top; the row diff preserves scroll otherwise
    const el = document.getElementById(`${P}RecentFeed`);
    if (el) el.scrollTop = 0;
    _renderFeed(!c);
    loadRecent();
  }

  X('SetRecentFilter', f => {
    _recentFilter = f;
    ['all', 'saved', 'story', 'deleted', 'changed', 'banned'].forEach(k => {
      document.getElementById(`${P}Rf_${k}`)?.classList.toggle('active', k === f);
    });
    _applyFeedFilter();
  });

  // The flag toggles mirror the star and bookmark buttons on cards: same
  // classes, same filled/outline state swap
  X('ToggleRfStar', () => {
    _rfStar = !_rfStar;
    const b = document.getElementById(`${P}RfStar`);
    if (b) { b.classList.toggle('starred', _rfStar); b.innerHTML = _starIcon(_rfStar); }
    _applyFeedFilter();
  });

  X('ToggleRfBook', () => {
    _rfBook = !_rfBook;
    const b = document.getElementById(`${P}RfBook`);
    if (b) { b.classList.toggle('bookmarked', _rfBook); b.innerHTML = _rfBook ? _bmFilled : _bmOutline; }
    _applyFeedFilter();
  });

  // Mobile stats panel: slide the stat strip open/closed (CSS grid-rows transition)
  X('ToggleStats', btn => {
    btn.classList.toggle('open');
    document.getElementById(`${P}StatsWrap`)?.classList.toggle('open');
  });

  // Reset kind + flag filters in one go; SetRecentFilter re-applies the feed
  X('ResetRecentFilters', () => {
    _rfStar = false;
    _rfBook = false;
    const s = document.getElementById(`${P}RfStar`);
    if (s) { s.classList.remove('starred'); s.innerHTML = _starIcon(false); }
    const b = document.getElementById(`${P}RfBook`);
    if (b) { b.classList.remove('bookmarked'); b.innerHTML = _bmOutline; }
    window[`${P}SetRecentFilter`]('all');
  });

  // Warm the per-kind caches the first time the pointer reaches the filter
  // pills, so the first filter click is instant too
  X('PrefetchFeedKinds', async () => {
    for (const kind of ['saved', 'story', 'deleted', 'changed', 'banned']) {
      const key = `${kind}|0|0`;
      if (_rf.cache[key]) continue;
      const { ok, data } = await apiJSON(`${API}/recent/feed?limit=40&kind=${kind}`);
      if (ok) _rf.cache[key] = { items: data.items, hasMore: data.has_more, sig: JSON.stringify(data.items) };
    }
  });

  // Refreshes page one of the feed (SSE 'changed' while the tab is active, a
  // 30 s poll otherwise). Pages the user scrolled in are kept: page one is
  // authoritative for the newest window and every retained event older than
  // its last one carries over, so the two halves stitch back into one
  // contiguous list. Older pages load through the scroll sentinel.
  // ponytail: a grouped event can show twice for one refresh cycle, once fresh
  // above the split and once stale below it, if absorbing a new post moves it
  // across. That needs 40+ feed events inside the grouping window's 5 minutes,
  // and the next refresh clears it, so it does not earn a second request.
  const loadRecent = X('LoadRecent', async () => {
    const key = _rfKey();
    const { ok, data } = await apiJSON(_rfUrl());
    if (!ok) {
      if (!_rf.items.length) {
        const el = document.getElementById(`${P}RecentFeed`);
        if (el) _listPlaceholder(el, _rf, '<div class="rf-empty">Could not load activity. Retrying automatically.</div>');
      }
      return;
    }
    const sig = JSON.stringify(data.items);
    _rf.cache[key] = { items: data.items, hasMore: data.has_more, sig };
    if (key !== _rfKey()) return;   // filter changed while the fetch was in flight
    if (sig === _rf.sig) return;
    // An empty page one means an empty feed, so nothing carries over
    const cut = data.items.length ? data.items[data.items.length - 1].ts : -Infinity;
    // The tail only stitches on when the fresh page still reaches it. More new
    // events than fit in one page (a long-idle tab under a busy loop) push page
    // one clear past what is loaded, leaving a hole the tail cannot fill, so
    // there the list does reset to page one.
    const tail = _rf.items.length && _rf.items[0].ts >= cut
      ? _rf.items.filter(e => e.ts < cut)
      : [];
    _rf.sig     = sig;
    _rf.items   = data.items.concat(tail);
    // has_more describes page one's window; with a tail attached the last
    // sentinel fetch is the one that knows whether anything older is left
    _rf.hasMore = tail.length ? _rf.hasMore : data.has_more;
    _renderFeed();
  });

  // ── Loop status ───────────────────────────────────────────────────────────

  const _el = id => document.getElementById(P + id);

  function renderStatus(state) {
    loopRunning    = state.loop_running;
    currentCreator = state.loop_current_channel;
    currentStage   = state.loop_current_stage || null;
    runQueue       = state.run_queue  || [];
    runCurrent     = state.run_current || null;
    pendingRescans = state.pending_rescans || {};
    sleepUntil     = state.loop_sleep_until != null ? state.loop_sleep_until * 1000 : null;
    sleepNext      = state.loop_sleep_next || null;
    nextRuns       = (cfg.nextRunCandidates
      ? cfg.nextRunCandidates(state)
      : [state.loop_next ? { iso: state.loop_next, label: `${CREATOR} loop` } : null]
    ).filter(Boolean);

    // Text writes below are change-guarded: this runs on every status event
    // (each second or two during a session), an identical textContent write
    // still replaces the text node and repaints, and any repaint under an
    // open modal's backdrop blur forces a full re-blur.
    const meta = _el('LoopMeta');
    if (meta) {
      const parts = [];
      if (state.loop_last_start) parts.push(`Last: ${fmt.rel(state.loop_last_start)}`);
      else parts.push('Never run');
      const comp = state.loop_last_session_completed, total = state.loop_last_session_total;
      if (comp != null && total != null) parts.push(`${comp}/${total} ${CREATORS}`);
      if (state.loop_last_new_videos != null) parts.push(`${state.loop_last_new_videos} new`);
      if (state.loop_last_duration_secs != null) parts.push(fmt.dur(state.loop_last_duration_secs));
      const metaText = parts.join(' · ');
      if (meta.textContent !== metaText) meta.textContent = metaText;
    }
    loopPaused = !!state.loop_paused;
    const next = _el('LoopNext');
    if (next) {
      const nextText = loopRunning
        ? 'Running…'
        : loopPaused
          ? 'Paused'
          : (state.loop_next ? `Next: ${fmt.relFuture(state.loop_next)}` : '');
      if (next.textContent !== nextText) next.textContent = nextText;
    }
    _renderPauseState(_el('PauseBtn'), next, loopPaused);
    _renderSessionPills(_el('LoopSessions'), state.loop_sessions_today || [], loopRunning, state.loop_manual_run);
    for (const id of ['TriggerNextBtn', 'TriggerStarredBtn', 'TriggerHalfBtn', 'TriggerAllBtn']) {
      const btn = _el(id);
      if (btn) btn.disabled = loopRunning;
    }
    const stopBtn = _el('StopBtn');
    if (stopBtn) stopBtn.disabled = !loopRunning;

    // Broad states in sync with the loop panels: loop_running covers the whole
    // session including its sleeps, run_current covers worker manual runs, and
    // statusActive covers platform extra loops (TikTok sounds). The label is
    // reported per platform; the header pill renders the active tab's state.
    const manualHandle = runCurrent ? creators.find(c => c.channel_id === runCurrent)?.handle : null;
    setHdrStatus(cfg.id, loopRunning ? `Running ${CREATOR} loop`
      : runCurrent ? `Running manual run${manualHandle ? ` for @${manualHandle}` : ''}`
      : (cfg.statusActive && cfg.statusActive(state)) ? `Running ${cfg.statusActiveLabel || 'loop'}`
      : 'Idle');

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
    // Cap the DOM at the server deque's size so a long-lived tab never grows unboundedly
    while (body.childElementCount > 1000) body.firstElementChild.remove();
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
    // One global strip under the tab bar; only the active platform's tick
    // writes it, so background platforms never fight over it
    const bar = document.getElementById('nowStrip');
    if (!bar || _activePlatform !== cfg.id) return;
    const dur = secs => {
      const m = Math.floor(secs / 60), s = secs % 60;
      return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    let html;
    if (sleepUntil) {
      const rem = Math.max(0, Math.round((sleepUntil - Date.now()) / 1000));
      html = `sleeping ${dur(rem)}`
        + (sleepNext ? ` <span class="lab-next">· up next: ${esc(sleepNext)}</span>` : '');
    } else if (currentCreator) {
      // A check in progress (session or manual run) outranks any countdown:
      // the bar reports what is happening right now, stage from the server.
      html = `processing @${esc(currentCreator)}`
        + (currentStage ? ` <span class="lab-next">· ${esc(currentStage)}</span>` : '');
    } else if (cfg.currentActivity && cfg.currentActivity()) {
      html = esc(cfg.currentActivity());
    } else if (loopRunning) {
      html = 'session running';
    } else {
      const now = Date.now();
      const candidates = nextRuns
        .map(c => ({ ts: new Date(c.iso).getTime(), label: c.label }))
        .filter(c => c.ts > now)
        .sort((a, b) => a.ts - b.ts);
      const rem = candidates.length ? Math.max(0, Math.round((candidates[0].ts - now) / 1000)) : 0;
      html = candidates.length
        ? `waiting ${dur(rem)} <span class="lab-next">· up next: ${esc(candidates[0].label)}</span>`
        : 'idle';
    }
    // Skip the write when nothing changed: an unchanged 1 Hz innerHTML write
    // still repaints the strip, and any repaint under an open modal's
    // backdrop blur forces a full re-blur. Compared via dataset (not
    // innerHTML) because the serializer does not round-trip entities.
    if (bar.dataset.lastTick === html) return;
    bar.dataset.lastTick = html;
    bar.innerHTML = html;
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
    if (!ok) { showToast('Could not update pause state', { type: 'error' }); return; }
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
      showToast('Could not stop loop', { type: 'error' });
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
          label: `Done: ${data.removed} item${data.removed !== 1 ? 's' : ''} removed`,
          steps: data.steps,
        });
      }
    }, 800);
  });

  // ── Add creator form ──────────────────────────────────────────────────────

  const handleInput = _el('HandleInput');

  const HANDLE_CLEAN_RE = /[^a-zA-Z0-9_.@:/?=&%-]/g;
  handleInput.addEventListener('input', function() {
    const clean = this.textContent.replace(HANDLE_CLEAN_RE, '');
    if (this.textContent === clean) return;
    // Strip invalid chars but keep the caret where it was (minus what was
    // removed before it) instead of yanking it to the end
    const sel = window.getSelection();
    let caret = clean.length;
    if (sel && sel.rangeCount && this.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0).cloneRange();
      r.selectNodeContents(this);
      r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
      const before = r.toString();
      caret = before.replace(HANDLE_CLEAN_RE, '').length;
    }
    this.textContent = clean;
    const range = document.createRange();
    if (this.firstChild) range.setStart(this.firstChild, Math.min(caret, clean.length));
    else range.selectNodeContents(this);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
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
    else if (data.kind === 'duplicate') showToast(`This ${CREATOR} is already tracked.`, { type: 'success' });
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
    ok:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V13m0 3.5v.1"/></svg>',
  };

  function _ahRow(e) {
    const icon = e.status === 'pending'
      ? '<span class="spinner"></span>'
      : _AH_ICONS[e.status === 'error' ? 'error' : 'ok'];
    const status = e.status === 'pending'
      ? '<span class="ah-status ah-pending">Looking up…</span>'
      : e.status === 'error'
        ? `<span class="ah-status ah-error" title="${esc(e.error_detail || '')}">${esc(e.error_kind || 'error')}</span>`
        : '<span class="ah-status ah-ok">added</span>';
    const actions = e.status === 'error'
      ? `<button class="ah-btn" title="Try again" onclick="${P}AhRetry(${e.id})">${_refreshIcon}</button>
         <button class="ah-btn ah-btn-danger" title="Discard" onclick="${P}AhDiscard(${e.id})">${_xIcon}</button>`
      : '';
    return `<div class="ah-row-content">
      <span class="ah-icon ah-${esc(e.status)}">${icon}</span>
      <span class="ah-handle" onclick="${P}AhOpen('${esc(e.handle)}')" role="button" tabindex="0" title="Open @${esc(e.handle)}">@${esc(e.handle)}</span>
      ${status}
      <span class="ah-time">${_recentDate(e.updated_at)}</span>
    </div>
    ${actions ? `<span class="ah-actions">${actions}</span>` : ''}`;
  }

  // Resolve at click time (not render time), so rows rendered before the
  // creators list loads, or after a rename, still find the current creator
  X('AhOpen', handle => {
    const ch = creators.find(c => (c.handle || '').toLowerCase() === handle.toLowerCase());
    if (ch) window[`${P}OpenModal`](ch.channel_id);
    else showToast(`@${handle} is not tracked.`, { type: 'info' });
  });

  // Same keyed diff as the recent feed: every queue change refreshes this list,
  // so rewriting it would reset the scroll position and restart the pending
  // rows' spinners. Row ids are stable, so a pending row morphing into added
  // or error touches nothing else.
  function _renderAddHistory() {
    const el = document.getElementById(`${P}AddHistory`);
    if (!el) return;
    if (!_ah.items.length) {
      _listPlaceholder(el, _ah, `<div class="ah-empty">No ${CREATOR} adds yet</div>`);
      return;
    }
    delete el.dataset.ph;
    const changed = _reconcileRows(el, _ah.items.map(e => ({
      key: String(e.id), html: _ahRow(e), attrs: { class: `ah-row${e.status === 'error' ? ' has-actions' : ''}` },
    })));
    _listSentinel(el, _ah, changed, () => loadAddHistory(false));
  }

  const loadAddHistory = X('LoadAddHistory', async (reset) => {
    if (_ah.loading) return;
    _ah.loading = true;
    const last   = _ah.items[_ah.items.length - 1];
    const before = !reset && last ? `&before=${last.id}` : '';
    const { ok, data } = await apiJSON(`${API}/add-history?limit=30${before}`);
    _ah.loading = false;
    if (!ok) {
      if (!_ah.items.length) {
        const el = document.getElementById(`${P}AddHistory`);
        if (el) _listPlaceholder(el, _ah, '<div class="ah-empty">Could not load the add history.</div>');
      }
      return;
    }
    if (reset) {
      // Keep the pages the sentinel loaded, same split as the recent feed: the
      // fresh page owns the newest ids, retained entries everything below its
      // last one, and the tail is dropped when the fresh page no longer
      // reaches it. Ids are monotonic, so the split has no gap or duplicate.
      const cut  = data.items.length ? data.items[data.items.length - 1].id : 0;
      const tail = _ah.items.length && _ah.items[0].id >= cut
        ? _ah.items.filter(i => i.id < cut)
        : [];
      _ah.items   = data.items.concat(tail);
      _ah.hasMore = tail.length ? _ah.hasMore : data.has_more;
    } else {
      _ah.items.push(...data.items);
      _ah.hasMore = data.has_more;
    }
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
    if (!ok) { showToast(data.error || 'Could not discard entry', { type: 'error' }); return; }
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
    EXTRA_FILTER_GROUPS.forEach(g => { if (g.dropdown) _fdSyncLabel(g); });
  }

  X('SetFilter', (group, value) => {
    const set = filter[group];
    set.has(value) ? set.delete(value) : set.add(value);
    Object.entries(_filterPillIds(group)).forEach(([v, id]) => {
      document.getElementById(id)?.classList.toggle('active', set.has(v));
    });
    const g = EXTRA_FILTER_GROUPS.find(g => g.key === group);
    if (g && g.dropdown) _fdSyncLabel(g);
    renderCreators();
  });

  // Multi-select dropdown variant of a filter group (extraFilterGroups
  // dropdown: true). Options reuse the pill id scheme and SetFilter toggling,
  // so the active-class sync above covers them; clicking an option keeps the
  // menu open (only outside clicks and _ddPick close a .dd), and the button
  // label summarizes the selection. Function declarations: _sectionHtml runs
  // before this point in the closure.
  function _fdLabel(g, set) {
    const sel = g.options.filter(o => set.has(o.key));
    if (!sel.length) return 'Any';
    if (sel.length === g.options.length) return 'All';
    if (sel.length <= 2) return sel.map(o => o.label).join(', ');
    return `${sel[0].label} +${sel.length - 1}`;
  }

  function _fdHtml(g) {
    const sel = new Set(g.defaults || []);
    return `<div class="dd dd-multi" id="${P}Fd_${g.key}">
      <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" onclick="_ddToggle(this)">
        <span class="dd-label">${esc(_fdLabel(g, sel))}</span><span class="dd-caret">${_caretIcon}</span></button>
      <div class="dd-menu" role="listbox" popover>
        ${g.options.map(o => `<button type="button" class="dd-opt${sel.has(o.key) ? ' active' : ''}" role="option" id="${P}f_${g.key}_${o.key}" onclick="${P}SetFilter('${g.key}','${o.key}')">${esc(o.label)}</button>`).join('')}
      </div></div>`;
  }

  function _fdSyncLabel(g) {
    const el = document.querySelector(`#${P}Fd_${g.key} .dd-label`);
    if (el) el.textContent = _fdLabel(g, filter[g.key]);
  }

  X('SetSortField', field => {
    sort.field = field;
    sort.dir   = (field === 'handle' || field === 'display_name') ? 'asc' : 'desc';
    _updateSortBtn();
    renderCreators();
  });

  X('ToggleSortDir', () => {
    if (sort.field === 'random') _randKeys.clear();
    sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    _updateSortBtn();
    renderCreators();
  });

  function _updateSortBtn() {
    const btn = _el('SortDirBtn');
    if (btn) btn.textContent = SORT_DIR_LABELS[sort.field]?.[sort.dir] ?? sort.dir;
  }

  // Mobile scroll lock for the dashboard lists: locked lists scroll with the
  // page (their own overflow is hidden under 800px); the corner toggle frees
  // them. Desktop ignores the class and hides the button.
  X('ToggleScrollLock', (listId, btn) => {
    const list = document.getElementById(String(listId));
    if (!list || !(btn instanceof HTMLElement)) return;
    const locked = list.classList.toggle('scroll-locked');
    btn.innerHTML = locked ? _lockIcon : _unlockIcon;
    btn.title = locked ? _LOCK_TIP : _UNLOCK_TIP;
    btn.setAttribute('aria-pressed', String(locked));
  });

  // The empty-grid CTA: bring the add bar into view and put the caret in it
  X('FocusAdd', () => {
    const el = _el('HandleInput');
    if (!(el instanceof HTMLElement)) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  X('ResetFilters', () => {
    sort   = { field: 'random', dir: 'asc' };
    filter = _defaultFilter();
    search = '';
    const searchEl = _el('Search');
    if (searchEl) searchEl.value = '';
    _ddSetValue(`${P}SortField`, 'random');
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
      // A search always looks across all creators, ignoring the filter pills
      if (q) {
        const hay = [ch.handle, ch.display_name, ch.channel_id, ch.description,
                     ...(ch.old_handles || []), ...(ch.old_display_names || []), ...(ch.old_descriptions || [])]
                    .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      }
      for (const g of EXTRA_FILTER_GROUPS) {
        if (filter[g.key].size && !g.test(ch, filter[g.key])) return false;
      }
      if (filter.stat.size && !filter.stat.has(ch.tracking_enabled === 0 ? 'inactive' : 'active')) return false;
      if (filter.star.has('starred') && !ch.starred) return false;
      if (filter.book.has('bookmarked') && !ch.bookmarked) return false;
      return true;
    });
  }

  // Stable per-creator random keys so polls and paging don't reshuffle the grid;
  // cleared by the Shuffle button (ToggleSortDir) for a fresh order
  const _randKeys = new Map();
  const _randKey = id => _randKeys.get(id) ?? (_randKeys.set(id, Math.random()), _randKeys.get(id));

  function _sortedCreators() {
    const { field, dir } = sort;
    if (field === 'random') {
      return _filteredCreators().sort((a, b) => _randKey(a.channel_id) - _randKey(b.channel_id));
    }
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
    // Colored pills mark state that changes (bans, blocks); static
    // relationship descriptors are plain muted text
    if (ch.account_status === 'banned') return `<span class="privacy-status banned">Banned</span>`;
    if (ch.privacy_status === 'blocked') return `<span class="privacy-status banned">Blocked</span>`;
    if (ch.privacy_status === 'private_blocked') return `<span class="relation-text">Private</span>`;
    const rel = ch.relation;
    if (rel === 2) return `<span class="relation-text">Friends</span>`;
    if (rel === 1) return `<span class="relation-text">Following</span>`;
    if (rel === 6) return `<span class="relation-text">Follows you</span>`;
    if (rel === 0) return `<span class="relation-text">No relation</span>`;
    return '';
  }

  const _isPrivateAccount = ch => ['private_accessible', 'private_blocked', 'blocked'].includes(ch.privacy_status);

  // latestOnly: cards show just the most recent previous handle (the list is
  // oldest first); the modal header keeps the full history.
  const _oldNamesTag = (ch, latestOnly) => {
    const names    = latestOnly ? (ch.old_handles || []).slice(-1) : (ch.old_handles || []);
    const oldNames = names.map(n => `@${esc(n)}`).join(' · ');
    return oldNames ? ` <span class="user-old-names">· ${oldNames}</span>` : '';
  };

  const _cardMetaItems = ch => [
    { label: 'Added',   value: fmtDateOnly(ch.added_at) },
    { label: 'Checked', value: ch.last_checked ? fmt.rel(new Date(ch.last_checked * 1000).toISOString()) : 'never' },
    { label: 'Saved',   value: ch.last_saved   ? fmt.rel(new Date(ch.last_saved   * 1000).toISOString()) : 'never' },
    { label: 'Storage', value: _fmtBytes(ch.media_size_bytes || 0) },
  ];

  // Keyed card elements: one persistent node per creator, rebuilt only when
  // its data or run state changes, so polls never destroy hover or keyboard
  // focus on an unchanged card. Relative times are excluded from the
  // signature; _patchCardTimes keeps them current in place.
  const _cardEls = new Map();

  function _cardSig(ch) {
    return JSON.stringify(ch)
      + `|${runQueue.includes(ch.channel_id) || runCurrent === ch.channel_id ? 1 : 0}`
      + `|${!!currentCreator && ch.handle === currentCreator ? 1 : 0}`
      + `|${pendingRescans[ch.channel_id] || 0}`;
  }

  function _cardEl(ch) {
    const sig = _cardSig(ch);
    const got = _cardEls.get(ch.channel_id);
    if (got && got.sig === sig) return got.el;
    const holder = document.createElement('div');
    holder.innerHTML = _renderCreatorCard(ch);
    const el = /** @type {HTMLElement} */ (holder.firstElementChild);
    // A changed card that is on screen swaps in place so the reconcile walk
    // never sees a detached cursor
    if (got && got.el.isConnected) got.el.replaceWith(el);
    _cardEls.set(ch.channel_id, { el, sig });
    _markXtextClipped(el);
    return el;
  }

  // Minute clock tick: refresh the relative times on connected cards without
  // rebuilding them
  function _patchCardTimes() {
    for (const ch of creators) {
      const got = _cardEls.get(ch.channel_id);
      if (!got || !got.el.isConnected) continue;
      const meta = got.el.querySelector('.user-card-meta-footer');
      if (meta) meta.outerHTML = _cardMeta(_cardMetaItems(ch));
      const rescanAt = pendingRescans[ch.channel_id];
      const notice   = got.el.querySelector('.user-rescan-notice');
      if (notice && rescanAt) notice.textContent = `Re-scan ${fmt.rel(new Date(rescanAt * 1000).toISOString())}`;
    }
  }

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

    const classes = `${P}-creator-card${isCurrent ? ' user-card-current' : ''}`
      + `${isInactive || isBanned || isBlocked || isPrivBlk ? ' user-card-inactive' : ''}`
      + `${isBanned || isBlocked ? ' user-card-banned' : ''}${isPrivBlk ? ' user-card-private' : ''}`;

    const icon = `<div class="avatar-wrap${ch.live_stories ? ' story-ring' + (ch.unviewed_stories ? '' : ' story-seen') : ''}"${ch.live_stories ? ` title="${ch.live_stories} live ${ch.live_stories === 1 ? 'story' : 'stories'}${ch.unviewed_stories ? '' : ', viewed'}" data-action="stories" data-id="${esc(ch.channel_id)}"` : ''}>`
      + `<span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>`
      + `${ch.avatar_cached ? `<img class="user-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar?size=thumb" alt="" onerror="this.style.display='none'" ${ch.live_stories ? '' : `data-action="avatar" data-id="${esc(ch.channel_id)}"`}>` : ''}</div>`;

    const stats = (ch.subscriber_count != null ? _statChip(cfg.subLabelCard, (ch.subscriber_count || 0).toLocaleString()) : '')
      + _statChip('saved', ch.video_total || 0)
      + ((ch.video_deleted || 0) > 0 ? _statChip('deleted', ch.video_deleted, 'red') : '')
      + (ch.video_missing ? _statChip('missing', ch.video_missing, 'orange') : '')
      + (cfg.hasStories && ch.story_count ? _statChip('stories', ch.story_count, 'purple') : '');

    const footer = `<div style="display:flex;gap:6px;">`
      + _starBtn(ch.starred, ch.channel_id)
      + _bookmarkBtn(ch)
      + `<button class="btn-run" ${runDis} data-action="quick" data-id="${esc(ch.channel_id)}" title="Quick check: the newest posts only, no deletion detection">${_refreshIcon} Quick</button>`
      + `<button class="btn-run" ${runDis} data-action="full" data-id="${esc(ch.channel_id)}" title="Full check: the whole catalog, detects deletions">${_refreshIcon} Full</button>`
      + `<button class="btn-menu" data-action="menu" data-id="${esc(ch.channel_id)}" data-handle="${esc(ch.handle)}" title="More actions" aria-haspopup="menu">${_dotsIcon}</button>`
      + `</div>`;

    const meta = _cardMeta(_cardMetaItems(ch));

    return _cardShell({
      classes,
      dataAttr:   `data-channelid="${esc(ch.channel_id)}"`,
      icon,
      namePrefix: _isPrivateAccount(ch) ? LOCK_SVG : '',
      name:       ch.display_name || ch.handle,
      sub:        `@${esc(ch.handle)}${_oldNamesTag(ch, true)}`,
      badges:     `<span class="account-status ${trackingCls}">${trackingLabel}</span>${_relationPill(ch)}`,
      bio:        ch.description ? _expandableText(ch.description) : '<span class="no-bio">No bio</span>',
      stats,
      extra:      rescanBadge,
      footer,
      meta,
    });
  }

  function _appendCreatorCards() {
    const grid = _el('Grid');
    gridObs = null;
    const next = sortedCache.slice(renderedCount, renderedCount + CARD_BATCH);
    if (!next.length) return;
    for (const ch of next) grid.appendChild(_cardEl(ch));
    renderedCount += next.length;
    if (sortedCache.length > renderedCount) {
      gridObs = _attachGridSentinel(grid, _appendCreatorCards);
    }
  }

  function renderCreators() {
    const grid = _el('Grid');
    if (!grid) return;
    if (gridObs) { gridObs.disconnect(); gridObs = null; }
    const filtered   = _filteredCreators();
    const isFiltered = filter.stat.size > 0 || filter.star.size > 0 || filter.book.size > 0 || !!search
      || EXTRA_FILTER_GROUPS.some(g => filter[g.key].size > 0);
    const countEl    = _el('Count');
    if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${creators.length}` : `${creators.length}`;

    if (!creators.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${_emptyInner('inbox',
        `No ${CREATORS} tracked yet`,
        `<button class="btn-primary btn-sm" onclick="${P}FocusAdd()">Add your first ${CREATOR}</button>`)}</div>`;
      renderedCount = 0;
      return;
    }
    if (!filtered.length) {
      const cause = search ? 'search' : 'filter';
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${_emptyInner('search',
        `No ${CREATORS} match this ${cause}.`,
        `<button class="btn-ghost btn-sm" onclick="${P}ResetFilters()">Clear ${cause === 'search' ? 'search' : 'filters'}</button>`)}</div>`
        + _ghostCards(Math.min(creators.length, CARD_BATCH));
      renderedCount = 0;
      return;
    }

    sortedCache   = _sortedCreators();
    const toShow  = Math.min(Math.max(CARD_BATCH, renderedCount), sortedCache.length);
    // Minimal-move reconcile: walk the desired order against the live
    // children, inserting only out-of-place nodes; leftovers (stale cards,
    // ghosts, sentinels, empty states) are removed. An unchanged grid is
    // zero DOM operations.
    const els  = sortedCache.slice(0, toShow).map(_cardEl);
    let cursor = grid.firstElementChild;
    for (const el of els) {
      if (el === cursor) { cursor = cursor.nextElementSibling; continue; }
      grid.insertBefore(el, cursor);
    }
    while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
    if (toShow < CARD_BATCH) grid.insertAdjacentHTML('beforeend', _ghostCards(CARD_BATCH - toShow));
    renderedCount = toShow;
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
    if (!ok) {
      // First load: replace the skeletons so the failure is visible; later
      // polls keep the stale grid (stale beats flicker) and retry themselves
      if (!creators.length) {
        const grid = _el('Grid');
        if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Could not load ${CREATORS}. Retrying automatically.</div>`;
      }
      return;
    }
    const sig = JSON.stringify(data);
    if (sig === _creatorsSig) {
      // Unchanged data: keep the relative timestamps current, touch nothing else
      if (Date.now() - _lastGridRender >= 60000) { _lastGridRender = Date.now(); _patchCardTimes(); }
      return;
    }
    _creatorsSig    = sig;
    _lastGridRender = Date.now();
    creators = data;
    renderCreators();
    _renderQuickAccess();
    _qaMigrateLocal();
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
    if (!ok) { showToast(data.error || 'Could not update tracking', { type: 'error' }); return; }
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
  let _modalConnections     = null;  // null until the open creator's fetch lands
  let _connSig              = '';
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
    _modalConnections = null;
    _connSig          = '';
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
    _destroyStatsPanel();
    _el('ModalVideoList').style.display = '';

    _dlgOpen(`${P}ModalBackdrop`);
    { const mb = _el('ModalBase'), top = _el('ModalTop'); if (mb) mb.scrollTop = 0; if (top) top.style.display = 'none'; }

    _el('ModalHeader').className = 'modal-header';  // reset custom header classes
    (renderHeaderFn || _renderModalHeader)(ch);
    _mRenderToolbar(MODAL_CFG, []);
    _el('ModalVideoList').innerHTML =
      `<div class="vlist-loading">Loading ${ITEMS}…</div>`;

    _loadModalVideos(ch.channel_id);
    _loadConnections(ch.channel_id);
  }

  // ── Connected creators ──────────────────────────────────────────────────────
  // Two-way links between creators on this platform (a person's second
  // channel). A compact panel in the modal header shows up to 3 avatars; the
  // list modal shows everyone and holds the remove buttons.

  async function _loadConnections(id) {
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(id)}/connections`);
    if (!ok || modalCreatorId !== id) return;
    _applyConnections(data);
  }

  function _applyConnections(conns) {
    const sig = JSON.stringify(conns);
    if (sig === _connSig && _modalConnections !== null) return;
    _modalConnections = conns;
    _connSig          = sig;
    _renderConnPanel();
    _renderConnListRows();
  }

  const _connPlusIcon = `<svg class="ic" viewBox="3.8 3.8 16.4 16.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14M5 12h14"/></svg>`;

  function _connAvatar(c) {
    return `<span class="conn-avatar-wrap" role="button" tabindex="0" title="${esc(c.display_name || c.handle)} (@${esc(c.handle)})"
      onclick="${P}OpenModal('${esc(c.channel_id)}')">
      <span class="conn-letter">${esc((c.handle || '?')[0])}</span>
      ${c.avatar_cached ? `<img class="conn-avatar" src="${API}/channels/${esc(c.channel_id)}/avatar?size=thumb" loading="lazy" alt="" onerror="this.remove()">` : ''}
    </span>`;
  }

  // Minimal 2x2 connections square under the avatar: three fixed avatar
  // slots plus the always-present manage slot. Connections fill from the
  // left, the first free slot is the clickable Add placeholder, the rest are
  // faint placeholders; no title, the tooltips carry the labels. The manage
  // slot shows the overflow count once the visible slots are full.
  function _renderConnPanel() {
    const host = _el('ModalConnections');
    if (!host) return;
    const conns = _modalConnections || [];
    const SLOTS = 3;
    const slots = [];
    for (let i = 0; i < SLOTS; i++) {
      if (i < conns.length)        slots.push(_connAvatar(conns[i]));
      else if (i === conns.length) slots.push(`<button class="conn-slot conn-slot-add" onclick="${P}ConnectAdd()" title="Connect a ${CREATOR}">${_connPlusIcon}</button>`);
      else                         slots.push(`<span class="conn-slot conn-slot-empty"></span>`);
    }
    const more = `<button class="conn-slot conn-more" onclick="${P}OpenConnList()"
      title="Connected ${CREATORS}: ${conns.length > SLOTS ? `show all ${conns.length}` : 'view and manage'}">${
      conns.length > SLOTS ? `+${conns.length - SLOTS}` : _dotsIcon}</button>`;
    host.innerHTML = slots.join('') + more;
  }

  function _renderConnListRows() {
    const host = _el('ConnListRows');
    if (!host) return;
    const conns = _modalConnections || [];
    host.innerHTML = conns.length ? conns.map(c => `
      <div class="conn-row" role="button" tabindex="0" onclick="if(!event.target.closest('button')){${P}CloseConnList();${P}OpenModal('${esc(c.channel_id)}')}">
        ${_connAvatar(c)}
        <span class="conn-row-names">
          <span class="conn-row-name">${esc(c.display_name || c.handle)}</span>
          <span class="conn-row-handle">@${esc(c.handle)}</span>
        </span>
        <button class="conn-row-remove" onclick="${P}RemoveConnection('${esc(c.channel_id)}')" title="Remove connection">${_xIcon}</button>
      </div>`).join('')
    : `<div class="conn-empty">No connected ${CREATORS} yet</div>`;
  }

  X('OpenConnList', () => {
    _renderConnListRows();
    _dlgOpen(`${P}ConnListModal`);
    _lockScroll();
  });

  X('CloseConnList', () => {
    _dlgClose(`${P}ConnListModal`);
    _unlockScroll();
  });

  // Typeahead over the already-loaded creators list (instant, no network):
  // handle and display name substring match, prefix matches first, minus the
  // ids in `taken`. Shared by the Connect and Quick Access add prompts.
  function _creatorSuggest(taken) {
    const pool = creators.filter(c => !taken.has(c.channel_id));
    return q => {
      q = q.trim().replace(/^@/, '').toLowerCase();
      if (!q) return [];
      const scored = [];
      for (const c of pool) {
        const h = (c.handle || '').toLowerCase();
        const d = (c.display_name || '').toLowerCase();
        const hi = h.indexOf(q), di = d.indexOf(q);
        if (hi < 0 && di < 0) continue;
        scored.push({ rank: (hi === 0 || di === 0) ? 0 : 1, c });
      }
      scored.sort((a, b) => a.rank - b.rank || a.c.handle.localeCompare(b.c.handle));
      return scored.slice(0, 8).map(({ c }) => ({
        value:  c.handle,
        label:  c.display_name || c.handle,
        sub:    '@' + c.handle,
        avatar: c.avatar_cached ? `${API}/channels/${encodeURIComponent(c.channel_id)}/avatar?size=thumb` : null,
      }));
    };
  }

  X('ConnectAdd', async () => {
    if (!modalCreator) return;
    const id = modalCreator.channel_id;
    const raw = await openPrompt({
      title: `Connect a ${CREATOR}`, placeholder: `@handle of a tracked ${CREATOR}`,
      confirmLabel: 'Connect',
      suggest: _creatorSuggest(new Set([id, ...(_modalConnections || []).map(c => c.channel_id)])),
    });
    if (raw === null || !raw.trim()) return;
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(id)}/connections`, {
      method: 'POST',
      body: JSON.stringify({ handle: raw.trim() }),
    });
    if (!ok) { showToast(data.error || 'Could not connect', { type: 'error' }); return; }
    if (modalCreatorId === id) _applyConnections(data.connections);
  });

  X('RemoveConnection', async otherId => {
    if (!modalCreator) return;
    const id = modalCreator.channel_id;
    const { ok, data } = await apiJSON(
      `${API}/channels/${encodeURIComponent(id)}/connections/${encodeURIComponent(otherId)}`,
      { method: 'DELETE' });
    if (!ok) { showToast(data.error || 'Could not remove the connection', { type: 'error' }); return; }
    if (modalCreatorId === id) _applyConnections(data.connections);
  });

  // ── Quick Access ──────────────────────────────────────────────────────────
  // Pinned creators under the add bar; the avatar slots and add prompt mirror
  // the Connected panel. Clicking an avatar opens the creator modal, nothing
  // else reads the pins. Server-side state (channels.pinned_at, ordered by
  // pin time) so pins are the same on every device; the creators poll and SSE
  // refresh keep the row current.

  const _QA_MIN_SLOTS = 5;
  const _qaPinned = () => creators.filter(c => c.pinned_at)
    .sort((a, b) => a.pinned_at - b.pinned_at);
  let _qaSig = null;

  function _renderQuickAccess() {
    const host = _el('QuickAccess');
    if (!host) return;
    const pinned = _qaPinned();
    const sig = JSON.stringify(pinned.map(c => [c.channel_id, c.handle, c.display_name, c.avatar_cached]));
    if (sig === _qaSig) return;
    _qaSig = sig;
    const slots = pinned.map(c => _connAvatar(c));
    slots.push(`<button class="conn-slot conn-slot-add" onclick="${P}QuickAccessAdd()" title="Add a ${CREATOR} to Quick access">${_connPlusIcon}</button>`);
    while (slots.length < _QA_MIN_SLOTS) slots.push(`<span class="conn-slot conn-slot-empty"></span>`);
    host.innerHTML = slots.join('');
    _renderQaListRows();
  }

  function _renderQaListRows() {
    const host = _el('QaListRows');
    if (!host) return;
    const pinned = _qaPinned();
    host.innerHTML = pinned.length ? pinned.map(c => `
      <div class="conn-row" role="button" tabindex="0" onclick="if(!event.target.closest('button')){${P}CloseQaList();${P}OpenModal('${esc(c.channel_id)}')}">
        ${_connAvatar(c)}
        <span class="conn-row-names">
          <span class="conn-row-name">${esc(c.display_name || c.handle)}</span>
          <span class="conn-row-handle">@${esc(c.handle)}</span>
        </span>
        <button class="conn-row-remove" onclick="${P}QuickAccessRemove('${esc(c.channel_id)}')" title="Remove from Quick access">${_xIcon}</button>
      </div>`).join('')
    : `<div class="conn-empty">No pinned ${CREATORS} yet</div>`;
  }

  X('OpenQaList', () => {
    _renderQaListRows();
    _dlgOpen(`${P}QaListModal`);
    _lockScroll();
  });

  X('CloseQaList', () => {
    _dlgClose(`${P}QaListModal`);
    _unlockScroll();
  });

  async function _qaSetPin(id, pinned) {
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(id)}/pin`, {
      method: 'PATCH', body: JSON.stringify({ pinned }),
    });
    if (!ok) { showToast(data.error || 'Could not update Quick access', { type: 'error' }); return; }
    const ch = creators.find(c => c.channel_id === id);
    if (ch) ch.pinned_at = pinned ? Math.floor(Date.now() / 1000) : null;
    _renderQuickAccess();
  }

  // One-shot migration of the short-lived localStorage pins to the server
  async function _qaMigrateLocal() {
    const raw = localStorage.getItem(`${P}-quickAccess`);
    if (!raw || !creators.length) return;
    localStorage.removeItem(`${P}-quickAccess`);
    let ids = [];
    try { ids = JSON.parse(raw) || []; } catch { /* malformed, drop it */ }
    for (const id of ids) {
      if (creators.some(c => c.channel_id === id)) await _qaSetPin(id, true);
    }
  }

  X('QuickAccessAdd', async () => {
    const raw = await openPrompt({
      title: 'Add to Quick access', placeholder: `@handle of a tracked ${CREATOR}`,
      confirmLabel: 'Add', suggest: _creatorSuggest(new Set(_qaPinned().map(c => c.channel_id))),
    });
    if (raw === null || !raw.trim()) return;
    const handle = raw.trim().replace(/^@/, '').toLowerCase();
    const ch = creators.find(c => (c.handle || '').toLowerCase() === handle);
    if (!ch) { showToast(`No tracked ${CREATOR} matches @${handle}.`, { type: 'error' }); return; }
    if (!ch.pinned_at) _qaSetPin(ch.channel_id, true);
  });

  X('QuickAccessRemove', id => _qaSetPin(id, false));

  // Behind the header menu's Add to/Remove from Quick Access item; repaint the
  // header so the menu label flips (modalCreator can be a different object
  // than the creators entry _qaSetPin updates, so mirror the field onto it)
  X('TogglePinModal', async id => {
    const ch = creators.find(c => c.channel_id === id);
    await _qaSetPin(id, !(ch && ch.pinned_at));
    if (modalCreator && modalCreator.channel_id === id) {
      modalCreator.pinned_at = ch ? ch.pinned_at : null;
      _renderModalHeader(modalCreator);
    }
  });

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
  _modalShellScrollWiring(`${P}Modal`);

  // Mobile toolbar dropdown handlers + the History Fields dropdown.
  X('MSort',   f => _mMobSort(MODAL_CFG, f));
  X('MStatus', k => _mMobStatus(MODAL_CFG, k));
  X('MType',   k => _mMobType(MODAL_CFG, k));
  // Multi-select: each pill toggles its field; empty selection shows all.
  X('MToggleField', field => {
    phistField.has(field) ? phistField.delete(field) : phistField.add(field);
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // repaint the field pills
    _renderPhistPanel();
  });
  function _fieldsPills() {
    const fields = [...new Set(phistData.map(e => e.field))];
    if (!fields.length) return '';
    return `<div class="filter-pills multi">`
      + fields.map(f =>
          `<button class="filter-pill${phistField.has(f) ? ' active' : ''}" onclick="${P}MToggleField('${esc(f)}')">${FIELD_LABELS[f] || f}</button>`
        ).join('')
      + `</div>`;
  }

  // Toolbar context-filter content for the non-media views, shared by the
  // desktop toolbar (cfg.contextFilters) and the mobile filter row.
  function _modalContextFilters(view) {
    if (view === 'history') return _fieldsPills();
    if (view === 'stats')   return _statHistRows ? _statRangePills() : '';
    return '';
  }

  // Toolbar count line for the non-media views (cfg.viewCount): filtered change
  // count on History, saved-story total on Stories (blank until the load lands).
  function _modalViewCount(view) {
    if (view === 'history') {
      const shown = _phistFiltered().length;
      if (_creatorState.search) {
        const total = _phistFiltered(true).length;
        return `${shown.toLocaleString()} of ${total.toLocaleString()} changes`;
      }
      return shown === 1 ? '1 change' : `${shown.toLocaleString()} changes`;
    }
    if (view === 'stories') {
      if (_storyTotal == null) return '';
      return _storyTotal === 1 ? '1 story' : `${_storyTotal.toLocaleString()} stories`;
    }
    if (view === 'stats') {
      if (_statHistRows == null) return '';
      return _statHistRows.length === 1 ? '1 day tracked' : `${_statHistRows.length.toLocaleString()} days tracked`;
    }
    return '';
  }

  // About modal (mobile): full bio, link, and all stats + activity dates.
  // Per-creator media folder size, fetched lazily when the Info panel or header
  // renders (a folder walk is too costly to run on the channel list). Cached per
  // channel so header re-renders on status polls do not refetch.
  const _storageCache = {};      // chId -> bytes
  const _mediaCountCache = {};   // chId -> {photos, videos}: individual files on disk
  const _storageTileVal = chId =>
    _storageCache[chId] != null ? _fmtBytes(_storageCache[chId]) : '<span class="storage-val">…</span>';
  const _mediaCountVal = (chId, key) =>
    _mediaCountCache[chId] ? _mediaCountCache[chId][key].toLocaleString() : `<span class="${key}-val">…</span>`;
  async function _fillStorage(chId) {
    if (_storageCache[chId] != null && _mediaCountCache[chId]) return;
    // The channel list's cached walk already carries the size for tracked
    // creators; show it immediately while the route computes the file counts.
    const listed = creators.find(c => c.channel_id === chId);
    if (_storageCache[chId] == null && listed && listed.media_size_bytes != null) {
      _storageCache[chId] = listed.media_size_bytes;
      document.querySelectorAll('.storage-val').forEach(el => { el.textContent = _fmtBytes(listed.media_size_bytes); });
    }
    const { ok, data } = await apiJSON(`${API}/channels/${chId}/storage`);
    if (!ok || !data || modalCreatorId !== chId) return;
    _storageCache[chId]    = data.bytes || 0;
    _mediaCountCache[chId] = { photos: data.photo_files || 0, videos: data.video_files || 0 };
    document.querySelectorAll('.storage-val').forEach(el => { el.textContent = _fmtBytes(_storageCache[chId]); });
    document.querySelectorAll('.videos-val').forEach(el => { el.textContent = _mediaCountCache[chId].videos.toLocaleString(); });
    document.querySelectorAll('.photos-val').forEach(el => { el.textContent = _mediaCountCache[chId].photos.toLocaleString(); });
  }

  X('OpenAbout', () => {
    const ch = modalCreator; if (!ch) return;
    const platformLabel = (PLATFORMS.find(p => p.id === cfg.id) || {}).label || cfg.id;
    const _iso = u => new Date(u * 1000).toISOString();
    const nextCheckVal = (ch.enabled === 0 || ch.tracking_enabled === 0) ? '–'
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
    statTiles.push({ v: _mediaCountVal(ch.channel_id, 'videos'), l: 'Videos' });
    statTiles.push({ v: _mediaCountVal(ch.channel_id, 'photos'), l: 'Photos' });
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
    _dlgOpen(`${P}AboutModal`);
    _fillStorage(ch.channel_id);
  });
  X('CloseAbout', () => _dlgClose(`${P}AboutModal`));

  X('CloseModal', () => _dlgClose(`${P}ModalBackdrop`));

  let _modalVidsSig = null;

  function _setModalVideos(data) {
    _modalVidsSig = JSON.stringify(data);
    _creatorState.videos = data.map(v => ({ ...v, description: v.title || v.description,
      type: (v.content_type === 'image' || _isImage(v)) ? 'photo' : 'video' }));
  }

  // Live refresh of the open modal, hooked to the SSE creators domain (its
  // tables cover everything the modal shows). Each section is gated on a JSON
  // signature so an unchanged payload never touches the DOM; a real change
  // re-renders (which resets list paging, hence the gates matter).
  async function _refreshOpenModal() {
    if (!modalCreatorId) return;
    const id = modalCreatorId;
    // Header + storage chip from the already-fresh creators array. Untracked
    // creators (custom headers) are not in the list and are left alone.
    const ch = creators.find(c => c.channel_id === id);
    if (ch && JSON.stringify(ch) !== JSON.stringify(modalCreator)) {
      modalCreator = ch;
      if (ch.media_size_bytes != null) _storageCache[id] = ch.media_size_bytes;
      const hdr = _el('ModalHeader');
      if (!hdr || !hdr.contains(document.activeElement)) _renderModalHeader(ch);
    }
    _loadConnections(id);  // signature-gated inside _applyConnections
    const { ok, data } = await apiJSON(`${API}/channels/${id}/videos`);
    if (ok && modalCreatorId === id && JSON.stringify(data) !== _modalVidsSig) {
      _setModalVideos(data);
      _mRenderToolbar(MODAL_CFG, _creatorState.videos);
      if (_mIsMediaView(_creatorState.view))
        _mRenderList(MODAL_CFG, { preserve: true });
    }
    if (modalCreatorId !== id) return;
    if (_creatorState.view === 'history')      await _refreshPhist(id);
    else if (_creatorState.view === 'stories') await _refreshStoriesCal(id);
    else if (_creatorState.view === 'stats')   await _refreshStatsPanel(id);
  }

  async function _refreshPhist(id) {
    const { ok, data } = await apiJSON(`${API}/channels/${id}/profile-history`);
    if (!ok || modalCreatorId !== id || _creatorState.view !== 'history') return;
    if (JSON.stringify(data) === JSON.stringify(phistData)) return;
    phistData = data;
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
    _renderPhistPanel();
  }

  async function _refreshStoriesCal(id) {
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(id)}/stories/calendar`);
    if (!ok || modalCreatorId !== id || _creatorState.view !== 'stories') return;
    if (JSON.stringify(data || {}) === _storyCalSig) return;
    if (_storyCal) { try { _storyCal.destroy(); } catch { /* already gone */ } _storyCal = null; }
    _renderStoriesPanel(data || {});
  }

  async function _loadModalVideos(channelId) {
    const { ok, data } = await apiJSON(`${API}/channels/${channelId}/videos`);
    if (modalCreatorId !== channelId) return;
    if (!ok) {
      _el('ModalVideoList').innerHTML =
        `<div class="vlist-empty">Could not load ${ITEMS}. Close and reopen to retry.</div>`;
      return;
    }
    _setModalVideos(data);

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
        // Scrolling the row under a stationary cursor makes the browser
        // synthesize a mouseenter, which dismissed the highlight before it
        // ever painted. Arm the dismiss only after a grace period; it then
        // fades slowly via the fade class stretching the background
        // transition, cleaned up so normal hover snaps again
        setTimeout(() => {
          row.addEventListener('mouseenter', () => {
            row.classList.add('video-row-hl-fade');
            row.classList.remove('video-row-highlight');
            row.addEventListener('transitionend', () => row.classList.remove('video-row-hl-fade'), { once: true });
          }, { once: true });
        }, 100);
      }
    } else {
      // On History/Stories the list stays hidden; still refresh the toolbar so
      // the tab set and post counts reflect the loaded videos.
      _mRenderToolbar(MODAL_CFG, _creatorState.videos);
      if (_mIsMediaView(_creatorState.view))
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
    const nextCheckVal = (ch.enabled === 0 || ch.tracking_enabled === 0) ? '–'
      : (!ch.next_check_at || ch.next_check_at * 1000 <= Date.now()) ? 'next session'
      : fmt.relFuture(_iso(ch.next_check_at));

    // The header's right side is one structured data block: three titled
    // groups of label/value ledger rows. Every row is a fixed slot (zero or
    // missing values render dimmed instead of despawning), so the header
    // height is a constant per platform regardless of the creator's data.
    const _num  = v => v != null ? _fmtLarge(v || 0) : '–';
    const _zero = v => v == null || !v ? ' tzero' : '';
    const activityRows =
        _hgRow('Added',   fmtDateOnly(ch.added_at))
      + _hgRow('Checked', ch.last_checked ? fmt.rel(_iso(ch.last_checked)) : 'never')
      + _hgRow('Saved',   ch.last_saved   ? fmt.rel(_iso(ch.last_saved))   : 'never')
      + _hgRow('Next',    nextCheckVal);
    const updates = ch.profile_history_count || 0;
    const platformRows =
        _hgRow(cfg.subLabelModal, _num(ch.subscriber_count), _zero(ch.subscriber_count))
      + _hgRow('Following',       _num(ch.following_count),  _zero(ch.following_count))
      + _hgRow('Posts',           _num(ch.video_count),      _zero(ch.video_count))
      + _hgRow('Updates',         String(updates),
               updates ? ' tlink' : ' tzero',
               updates ? `${P}SetModalView('history')` : '');
    const archiveRows =
        _hgRow('Saved',    _fmtLarge(ch.video_total || 0),   _zero(ch.video_total))
      + _hgRow('Videos',   _mediaCountVal(ch.channel_id, 'videos'))
      + _hgRow('Photos',   _mediaCountVal(ch.channel_id, 'photos'))
      + _hgRow('Deleted',  String(ch.video_deleted || 0),    ch.video_deleted   ? ' tred'    : ' tzero')
      + _hgRow('Restored', String(ch.video_undeleted || 0),  ch.video_undeleted ? ' tyellow' : ' tzero')
      + (cfg.hasStories ? _hgRow('Stories', _fmtLarge(ch.story_count || 0), _zero(ch.story_count)) : '')
      + _hgRow('Storage', _storageTileVal(ch.channel_id));

    _el('ModalHeader').innerHTML = `
      <div class="modal-header-left">
        <div class="modal-avatar-col">
          <div class="modal-avatar-wrap${ch.live_stories ? ' story-ring' + (ch.unviewed_stories ? '' : ' story-seen') : ''}"${ch.live_stories ? ` title="${ch.live_stories} live ${ch.live_stories === 1 ? 'story' : 'stories'}${ch.unviewed_stories ? '' : ', viewed'}" onclick="${P}OpenStories('${esc(ch.channel_id)}')"` : ''}>
            <span class="avatar-letter">${esc((ch.handle || '?')[0])}</span>
            ${ch.avatar_cached ? `<img class="modal-avatar" src="${API}/channels/${esc(ch.channel_id)}/avatar" alt=""
                 onerror="this.style.display='none'"
                 ${ch.live_stories ? '' : `onclick="openImgModalUrl('${API}/channels/${esc(ch.channel_id)}/avatar')"`}>` : ''}
          </div>
          <div class="conn-square" id="${P}ModalConnections"></div>
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
            ${banCountdownStr ? `<span class="modal-ban-countdown modal-ban-inline">${banCountdownStr}</span>` : ''}
          </div>
          <div class="modal-bio">${ch.description ? _expandableText(ch.description) : _xtextPlaceholderHtml('No bio')}</div>
          <div class="modal-note-link-row">
            ${_noteFieldHtml(ch.comment, `${P}EditNote`, 0)}
            <div class="modal-bio-link">${ch.bio_link
              ? `<a href="${esc(ch.bio_link)}" target="_blank" rel="noopener noreferrer">${esc(ch.bio_link.replace(/^https?:\/\//, ''))}</a>`
              : '<span class="no-bio-link">No link</span>'}</div>
          </div>
          <div class="modal-actions-group">
            ${_modalActionBtns(ch, runDisabled)}
          </div>
        </div>
      </div>
      <div class="hdr-data">
        <div class="hdr-group"><div class="hg-title">Activity</div>${activityRows}</div>
        <div class="hdr-group"><div class="hg-title">Platform</div>${platformRows}</div>
        <div class="hdr-group"><div class="hg-title">Archive</div>${archiveRows}</div>
      </div>
    `;

    _fillStorage(ch.channel_id);
    _renderModalBanner(ch);
    _renderConnPanel();  // header re-renders wipe the panel; refill from state
    _markXtextClipped(_el('ModalHeader'));
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
    const bioText = desc ? (long ? esc(desc.slice(0, N).trim()) + '… ' : esc(desc) + ' ') : '<span class="no-bio">No bio</span> ';
    const moreLbl = long ? '…more' : 'Details';
    _el('ModalHeader').innerHTML = `
      <div class="mh">
        <div class="mh-top">
          <div class="modal-avatar-wrap${ch.live_stories ? ' story-ring' + (ch.unviewed_stories ? '' : ' story-seen') : ''}"${ch.live_stories ? ` title="${ch.live_stories} live ${ch.live_stories === 1 ? 'story' : 'stories'}${ch.unviewed_stories ? '' : ', viewed'}" onclick="${P}OpenStories('${esc(ch.channel_id)}')"` : ''}>
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
          ${_modalActionBtns(ch, runDisabled)}
          <label class="tracking-toggle" title="${isInactive ? `${ItemsCap} tracking off (profile changes still tracked)` : `${ItemsCap} tracking on`}" style="margin-left:auto">
            <input type="checkbox" ${isInactive ? '' : 'checked'} onchange="${P}SetTracking('${esc(ch.channel_id)}', this.checked)">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">Track</span>
          </label>
        </div>
        ${_noteFieldHtml(ch.comment, `${P}EditNote`, 4)}
        <div class="conn-square" id="${P}ModalConnections"></div>
      </div>`;
    _renderConnPanel();
    _markXtextClipped(_el('ModalHeader'));
  }

  // Note editor behind both the empty field's "Click to add a note" and the
  // header menu's Edit note item. Saves via the same comment PATCH the old
  // inline textarea used, then repaints the header so the field re-renders.
  X('EditNote', async () => {
    if (!modalCreator) return;
    const id  = modalCreator.channel_id;
    const val = await openPrompt({
      title: 'Edit note', value: modalCreator.comment || '',
      placeholder: `Note about this ${CREATOR}…`, confirmLabel: 'Save', multiline: true,
    });
    if (val === null) return;
    const ok = await _saveCreatorComment(`${API}/channels`, id, val, creators, 'channel_id');
    if (ok && modalCreator && modalCreator.channel_id === id) {
      modalCreator.comment = val.trim() || null;
      _renderModalHeader(modalCreator);
    }
  });

  X('ToggleStarModal', id => {
    // _creatorToggleStar flips the array item and re-renders the cards before
    // its PATCH resolves; mirror the new state onto modalCreator (which can be
    // a different object after a list refetch) and repaint the header right
    // away instead of after the network round-trip (ToggleBookmark pattern).
    const done = _creatorToggleStar(`${API}/channels`, id, creators, 'channel_id', renderCreators);
    _syncStarBookmark(id);
    const ch = creators.find(c => c.channel_id === id);
    if (ch && modalCreator && modalCreator.channel_id === id) {
      modalCreator.starred    = ch.starred;
      modalCreator.bookmarked = ch.bookmarked;
      _renderModalHeader(modalCreator);
    }
    return done;
  });

  // Bio popover: the full description opens over the content instead of expanding
  // inline. Clicks inside the popover don't close it (so the text stays selectable);
  // the X button or an outside click dismisses it.
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
    const stats   = _el('StatsPanel');
    if (view !== 'stories') _destroyStoriesPanel();
    if (view !== 'stats')   _destroyStatsPanel();
    if (vidList) vidList.style.display = _mIsMediaView(view) ? '' : 'none';
    if (phist)   phist.style.display   = view === 'history' ? '' : 'none';
    if (stories) stories.style.display = view === 'stories' ? '' : 'none';
    if (stats)   stats.style.display   = view === 'stats' ? '' : 'none';
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
    if (view === 'history')      await _loadPhist();
    else if (view === 'stories') await _loadStories();
    else if (view === 'stats')   await _loadStatsPanel();
    else _mRenderList(MODAL_CFG);
  });
  X('OnModalSearch', val => {
    _creatorState.search = val.trim();
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
    if (_creatorState.view === 'history') _renderPhistPanel();
    else _mRenderList(MODAL_CFG);
  });

  // ── Profile history view ──────────────────────────────────────────────────
  // Fetches once per creator (cached by phistChId); the Fields dropdown lives
  // on the toolbar (cfg.contextFilters) so it re-renders there after the load.

  async function _loadPhist() {
    const panel = _el('PhistPanel');
    if (!panel || !modalCreatorId) return;
    if (phistChId !== modalCreatorId) {
      phistChId = modalCreatorId;
      phistData = [];
      panel.innerHTML = '<div class="vlist-loading">Loading history…</div>';
      const { ok, data } = await apiJSON(`${API}/channels/${modalCreatorId}/profile-history`);
      if (phistChId !== modalCreatorId || _creatorState.view !== 'history') return;
      if (!ok) {
        phistChId = null;  // retry on the next view switch
        panel.innerHTML = '<div class="vlist-empty">Could not load the change history.</div>';
        return;
      }
      phistData = data;
      _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // field list now known
    }
    _renderPhistPanel();
  }

  // ── Stories history calendar (Cal-Heatmap month intensity view) ───────────

  let _storyCal = null;
  let _calTip = null;
  let _storyTotal = null;     // saved-story count for the toolbar line; null until loaded
  let _storyCalSig = null;    // rendered day-counts signature; gates live repaints
  let _storyCalOffset = 0;    // months paged back from the current month at the right edge

  function _calTipShow(target, text) {
    if (!_calTip) {
      _calTip = document.createElement('div');
      _calTip.className = 'cal-tip';
      // Child of the modal dialog, not body: a body child would paint under
      // the dialog's top layer
      (_el('ModalBackdrop') || document.body).appendChild(_calTip);
    }
    _calTip.textContent = text;
    _calTip.style.display = 'block';
    const r = target.getBoundingClientRect();
    const tr = _calTip.getBoundingClientRect();
    _calTip.style.left = `${Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 6))}px`;
    _calTip.style.top = `${r.top - tr.height - 8}px`;
  }

  function _calTipHide() { if (_calTip) _calTip.style.display = 'none'; }

  function _destroyStoriesPanel() {
    if (_storyCal) { try { _storyCal.destroy(); } catch { /* already gone */ } _storyCal = null; }
    _calTipHide();
    _storyTotal     = null;
    _storyCalSig    = null;
    _storyCalOffset = 0;
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
    if (chId !== modalCreatorId || _creatorState.view !== 'stories') return;
    if (!ok) { panel.innerHTML = '<div class="vlist-empty">Could not load stories. Close and reopen to retry.</div>'; return; }
    _renderStoriesPanel(data || {});
  }

  X('StoriesCalStep', dir => {
    if (!_storyCal) return;
    // Forward paging clamps at the present: the rightmost slot never shows a
    // month later than the current one.
    if (dir > 0 && _storyCalOffset <= 0) return;
    if (dir < 0) { _storyCalOffset++; _storyCal.previous(); }
    else         { _storyCalOffset--; _storyCal.next(); }
    const fwd = _el('StoriesCalFwd');
    if (fwd) fwd.disabled = _storyCalOffset <= 0;
  });

  X('PlayStoriesOfDay', async day => {
    if (!modalCreatorId) return;
    openMediaViewerPending();  // overlay + spinner on the click itself
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(modalCreatorId)}/stories`);
    if (!_mvIsOpen()) return;  // closed while the list loaded
    if (!ok) { closeMediaViewer(); return; }
    const slides = (data || [])
      .filter(s => s.posted_at && new Date(s.posted_at * 1000).toLocaleDateString('sv') === day)
      .sort((a, b) => a.posted_at - b.posted_at)
      .map(_storySlide);
    if (slides.length) openStoryViewer(slides);
    else closeMediaViewer();
  });

  function _renderStoriesPanel(dayCounts) {
    const panel = _el('StoriesPanel');
    if (!panel) return;
    if (typeof CalHeatmap === 'undefined') {
      panel.innerHTML = '<div class="vlist-loading">Calendar library failed to load.</div>';
      return;
    }
    // GitHub's dark-mode contribution greens, verbatim, on every platform.
    // The darkest step is deliberately subtle against the box background,
    // GitHub-style; the empty cells sit a notch above it (var(--hdr) on a
    // var(--nav) box, GitHub's #151b23 on #0d1117) so filled days read
    // against their empty neighbours.
    const ramp = ['#033a16', '#196c2e', '#2ea043', '#56d364'];
    const BUCKETS = ['1', '2', '3-4', '5+'];

    _storyCalSig = JSON.stringify(dayCounts);
    _storyTotal  = Object.values(dayCounts).reduce((a, b) => a + b, 0);
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // story count now known
    panel.innerHTML = `
      <div class="stories-cal-box">
        <div class="stories-cal" id="${P}StoriesCal"></div>
        <div class="stories-cal-foot">
          <div class="stories-cal-nav">
            <button class="filter-pill" onclick="${P}StoriesCalStep(-1)" title="Earlier months"><svg class="ic" viewBox="4.8 4.8 14.4 14.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
            <button class="filter-pill" id="${P}StoriesCalFwd" disabled onclick="${P}StoriesCalStep(1)" title="Later months"><svg class="ic" viewBox="4.8 4.8 14.4 14.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
          </div>
          <div class="stories-cal-legend">
            <span>Less</span>
            <i style="background:var(--hdr)" title="No stories"></i>
            ${BUCKETS.map((label, i) => `<i style="background:${ramp[i]}" title="${label} ${label === '1' ? 'story' : 'stories'}"></i>`).join('')}
            <span>More</span>
          </div>
        </div>
      </div>`;

    const source = Object.entries(dayCounts).map(([date, value]) => ({ date, value }));
    // Paint more months than the 540px viewport can show so the content always
    // overflows off the left edge: the fade mask then always bites into cells
    // instead of empty background (4 months of 5-week columns total ~455px,
    // which left a bare gap). The window ends at the current month, so the
    // rightmost slot is always the present.
    const RANGE  = 6;
    const start  = new Date();
    // Anchor mid-month: the 1st at local midnight is the previous month in
    // UTC, and Cal-Heatmap resolves the instant in UTC, which shifted the
    // whole window one month back (June ended up rightmost instead of July).
    // The 15th resolves to the same month in every timezone, and also can't
    // overflow when stepping back from a 31st.
    start.setDate(15);
    start.setMonth(start.getMonth() - (RANGE - 1));
    _storyCalOffset = 0;

    _storyCal = new CalHeatmap();
    _storyCal.paint({
      itemSelector: `#${P}StoriesCal`,
      theme:     'dark',
      domain:    { type: 'month', gutter: 21, label: { text: 'MMM YYYY', textAlign: 'start', position: 'top' } },
      subDomain: { type: 'day', radius: 3, width: 15, height: 15, gutter: 4.5 }, // GitHub's 10px/2px/3px geometry scaled 1.5x
      date:      { start, highlight: [new Date()] },
      range:     RANGE,
      data:      { source, x: 'date', y: 'value' },
      scale:     { color: { type: 'threshold', domain: [2, 3, 5], range: ramp } },
    });
    _storyCal.on('click', (event, timestamp) => {
      const day = new Date(timestamp).toLocaleDateString('sv');
      if (dayCounts[day]) window[`${P}PlayStoriesOfDay`](day);
    });
    // GitHub-style hover detail: "3 stories on April 16th."
    _storyCal.on('mouseover', (event, timestamp, value) => {
      const d = new Date(timestamp);
      const n = value || 0;
      const day = d.getDate();
      const ord = day + (day > 3 && day < 21 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] || 'th');
      const year = d.getFullYear() === new Date().getFullYear() ? '' : `, ${d.getFullYear()}`;
      const month = d.toLocaleDateString('en-US', { month: 'long' });
      _calTipShow(event.target, `${n || 'No'} ${n === 1 ? 'story' : 'stories'} on ${month} ${ord}${year}.`);
    });
    _storyCal.on('mouseout', _calTipHide);
  }

  // ── Profile stats graphs (Stats view) ─────────────────────────────────────
  // Daily snapshots from /stats-history rendered as small-multiple line charts
  // by the shared _renderStatsCharts (common.js). Signature-gated live repaints
  // ride the same SSE creators domain as the other modal views.

  let _statHistRows   = null;   // fetched snapshot rows; null until loaded
  let _statHistSig    = null;   // JSON signature; gates live repaints
  let _statHistCharts = [];     // live uPlot instances, destroyed on leave
  let _statRange      = 14;     // max days shown in the graphs (snapshots are one per day)

  // Last n snapshots; one row per day, so this is the last n tracked days.
  const _statRangeRows = () => _statHistRows && _statHistRows.slice(-_statRange);

  X('MStatsRange', n => {
    _statRange = n;
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // repaint the active pill
    if (_creatorState.view !== 'stats' || !_statHistRows) return;
    _destroyStatsCharts();
    _statHistCharts = _renderStatsCharts(_el('StatsPanel'), _statRangeRows());
  });

  function _statRangePills() {
    return `<div class="filter-pills multi">`
      + [14, 30, 60, 90].map(n =>
          `<button class="filter-pill${_statRange === n ? ' active' : ''}" onclick="${P}MStatsRange(${n})">${n}d</button>`
        ).join('')
      + `</div>`;
  }

  function _destroyStatsCharts() {
    _statHistCharts.forEach(c => { try { c.destroy(); } catch { /* already gone */ } });
    _statHistCharts = [];
  }

  function _destroyStatsPanel() {
    _destroyStatsCharts();
    _statHistRows = null;
    _statHistSig  = null;
    _statRange    = 14;
    const panel = _el('StatsPanel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  }

  async function _loadStatsPanel() {
    const panel = _el('StatsPanel');
    if (!panel || !modalCreatorId) return;
    panel.style.display = '';
    panel.innerHTML = '<div class="vlist-loading">Loading stats…</div>';
    const chId = modalCreatorId;
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(chId)}/stats-history`);
    if (chId !== modalCreatorId || _creatorState.view !== 'stats') return;
    if (!ok) { panel.innerHTML = '<div class="vlist-empty">Could not load stats. Close and reopen to retry.</div>'; return; }
    _statHistRows = data || [];
    _statHistSig  = JSON.stringify(data);
    _statHistCharts = _renderStatsCharts(panel, _statRangeRows());
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);  // day count now known
  }

  async function _refreshStatsPanel(id) {
    const { ok, data } = await apiJSON(`${API}/channels/${encodeURIComponent(id)}/stats-history`);
    if (!ok || modalCreatorId !== id || _creatorState.view !== 'stats') return;
    if (JSON.stringify(data) === _statHistSig) return;
    _statHistSig  = JSON.stringify(data);
    _statHistRows = data || [];
    _destroyStatsCharts();
    _statHistCharts = _renderStatsCharts(_el('StatsPanel'), _statRangeRows());
    _mRenderToolbar(MODAL_CFG, _creatorState.videos);
  }

  // Charts size to the panel at render; re-render on a real resize (rotation,
  // window change) while the Stats view is open, debounced.
  let _statHistResizeT = null;
  window.addEventListener('resize', () => {
    if (_creatorState.view !== 'stats' || !_statHistRows) return;
    clearTimeout(_statHistResizeT);
    _statHistResizeT = setTimeout(() => {
      if (_creatorState.view !== 'stats' || !_statHistRows) return;
      _destroyStatsCharts();
      _statHistCharts = _renderStatsCharts(_el('StatsPanel'), _statRangeRows());
    }, 200);
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

  // History entries after the Fields dropdown and the toolbar search box;
  // skipSearch backs the "x of y changes" count the same way _mFiltered does.
  function _phistFiltered(skipSearch = false) {
    let entries = phistField.size
      ? phistData.filter(e => phistField.has(e.field))
      : phistData;
    if (!skipSearch && _creatorState.search) {
      const q = _creatorState.search.toLowerCase();
      const newValMap = _phistNewValMap();
      entries = entries.filter(e =>
        (FIELD_LABELS[e.field] || e.field).toLowerCase().includes(q) ||
        String(e.old_value ?? '').toLowerCase().includes(q) ||
        String(newValMap.get(e) ?? '').toLowerCase().includes(q));
    }
    return entries;
  }

  function _renderPhistPanel() {
    const panel = _el('PhistPanel');
    if (!panel) return;

    const entries = _phistFiltered();
    const newValMap = _phistNewValMap();

    panel.innerHTML = entries.length
      ? entries.map(e => _phistEntryHtml(e, newValMap.get(e))).join('')
      : `<div class="phist-empty">No profile changes recorded${phistField.size || _creatorState.search ? ' matching the current filters' : ''}</div>`;
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

    // Bio edits are usually small adjustments, so render a line-aligned diff
    // grid highlighting the words that changed (deletions on Old, insertions
    // on New, gap rows keeping the columns aligned). Other text fields
    // (display name, handle) change wholesale and keep the plain view.
    const isBio = e.field === 'description' || e.field === 'bio';
    if (isBio && e.old_value && newVal) {
      const grid = _lineDiffHtml(e.old_value, newVal);
      if (grid) return `<div class="phist-entry">
        <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
        <div class="ld-wrap">
          <div class="ld-hdr"><span class="phist-side-label">Old</span><span class="phist-side-label">New</span></div>
          ${grid}
        </div>
      </div>`;
    }
    const diff = isBio && e.old_value && newVal ? _wordDiff(e.old_value, newVal) : null;

    const isStatusField = e.field === 'account_status' || e.field === 'privacy_status';
    const valHtml = (v, dh) => v
      ? `<div class="phist-value${dh ? ' diff-mono' : ''}">${dh || esc(isStatusField ? (_PHIST_STATUS_LABELS[v] || v) : v)}</div>`
      : `<div class="phist-value empty">(empty)</div>`;
    return `<div class="phist-entry">
      <div class="phist-entry-hdr"><strong>${esc(fieldLabel)}</strong> <span class="phist-date">· Changed ${dateStr}</span></div>
      <div class="phist-diff">
        <div class="phist-side"><div class="phist-side-hdr"><span class="phist-side-label">Old</span></div>${valHtml(e.old_value, diff && diff.oldHtml)}</div>
        <div class="phist-arrow">→</div>
        <div class="phist-side"><div class="phist-side-hdr"><span class="phist-side-label">New</span></div>${valHtml(newVal, diff && diff.newHtml)}</div>
      </div>
    </div>`;
  }

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
    const searchRst = _el('SearchReset');
    if (searchRst) searchRst.style.visibility = view === 'log' ? 'hidden' : '';
    // Mobile drops the search row to its own full-width line, so an invisible
    // box there is just an empty gap: the class hides it outright under 640px
    searchEl?.closest('.search-row')?.classList.toggle('search-row-hidden', view === 'log');
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
      _tickActivityBar(); // fill the bar now; the 1 s interval skips it while hidden
    }
    if (view === 'creators') renderCreators();
    const extra = EXTRA_VIEWS.find(v => v.key === view);
    if (extra) extra.show(search);
    const activeCtrl = extra ? _el(`Controls_${extra.key}`) : ctrl;
    if (activeCtrl) activeCtrl.querySelectorAll('.filter-pills').forEach(_placeGlider);
  });

  // ── Keyboard handlers ─────────────────────────────────────────────────────

  // Cards open on Enter/Space via the global role="button" keydown in common.js

  // Slash focuses the search box on the active platform tab
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    const searchEl = _el('Search');
    // offsetParent is null while this platform's tab is hidden, and the box
    // itself is visibility-hidden on the Log view
    if (!searchEl || !searchEl.offsetParent || searchEl.style.visibility === 'hidden') return;
    e.preventDefault();
    searchEl.focus();
  });

  // Escape on every overlay is the native <dialog> cancel; the top layer
  // orders stacked overlays (About over the creator modal, confirm over
  // everything), so the old per-platform Escape handler is gone.

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
    // The creators domain's tables also back the open detail modal (channel
    // row, videos, profile history, stories), so its refetch pulls the modal
    // along; platforms hook their own modals via onCreatorsRefetched.
    creators: async () => {
      await loadCreators();
      _refreshOpenModal();
      if (cfg.onCreatorsRefetched) cfg.onCreatorsRefetched();
    },
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
  // clock: patch cards in place once a minute, no fetch; the feed re-render
  // is skipped while focus is inside it.
  setInterval(() => {
    if (!_es) return;
    _patchCardTimes();
    const feed = document.getElementById(`${P}RecentFeed`);
    if (!feed || !feed.contains(document.activeElement)) _renderFeed();
  }, 60000);

  // ── Settings pane registration ────────────────────────────────────────────
  // Every platform gets Account, Schedule, Jobs, and Database sections by
  // default; cfg.settings overrides or extends them. The Jobs section always
  // ends with the engine's DB cleanup card, and the Database section is the
  // shared query pane.
  {
    const S = cfg.settings || {};
    const platformLabel = (PLATFORMS.find(p => p.id === cfg.id) || {}).label || cfg.id;
    const cleanupCard = `
      <div class="job-card">
        <div class="job-card-hdr">
          <div style="flex:1">
            <div class="job-card-title">Database cleanup</div>
            <div class="job-card-desc">
              Removes orphaned thumbnails and cached images left behind when
              ${CREATORS} are removed from tracking. Also runs VACUUM on the
              ${platformLabel} SQLite database to compact freed space.
            </div>
          </div>
          <button class="btn-primary" id="job-${P}-cleanup-btn" onclick="${P}TriggerCleanup()" style="flex-shrink:0;align-self:flex-start">Run</button>
        </div>
        <div class="job-status" id="job-${P}-cleanup-status" style="display:none">
          <div id="job-${P}-cleanup-bar-wrap"><div class="job-bar-track"><div class="job-bar-fill" id="job-${P}-cleanup-bar"></div></div></div>
          <div class="job-status-text" id="job-${P}-cleanup-text"></div>
          <div class="job-steps" id="job-${P}-cleanup-steps"></div>
        </div>
      </div>`;
    const sections = [];
    sections.push({
      id: 'account', label: 'Account',
      html:   S.account?.html ?? `<p class="settings-note">${platformLabel} fetches public data and needs no account.</p>`,
      onShow: S.account?.onShow,
    });
    sections.push({
      id: 'schedule', label: 'Schedule',
      html:   S.schedule?.html ?? _schedulePaneHtml(`${P}Settings`, `${P}SaveLoopSettings`, CREATORS),
      onShow: S.schedule?.onShow ?? (() => _scheduleSettingsLoad(cfg.id, `${P}Settings`)),
    });
    if (S.network) sections.push({ id: 'network', label: 'Network', ...S.network });
    sections.push({
      id: 'jobs', label: 'Jobs',
      html:     (S.jobs?.html || '') + cleanupCard,
      onShow:   S.jobs?.onShow,
      onHide:   S.jobs?.onHide,
      onRender: S.jobs?.onRender,
    });
    if (S.diag) sections.push({ id: 'diag', label: 'Diagnostics', diagFill: true, ...S.diag });
    sections.push({
      id: 'database', label: 'Database',
      html: `<div id="database-${cfg.id}"></div>`,
      onRender: () => initDbQueryPane(cfg.id),
    });
    _settingsRegister(cfg.id, platformLabel, sections);
  }

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
