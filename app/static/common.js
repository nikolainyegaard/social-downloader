const PLATFORMS = [
  { id: 'tiktok',  label: 'TikTok'  },
  { id: 'youtube', label: 'YouTube' },
];

function switchPlatform(name) {
  if (!PLATFORMS.some(p => p.id === name)) name = 'tiktok';
  history.replaceState(null, '', '#' + name);
  document.querySelectorAll('.platform-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.platform === name);
  });
  PLATFORMS.forEach(p => {
    const el = document.getElementById('platform-' + p.id);
    if (el) el.style.display = p.id === name ? '' : 'none';
  });
  const app = document.querySelector('.app');
  PLATFORMS.forEach(p => app.classList.remove('theme-' + p.id));
  app.classList.add('theme-' + name);
  if (typeof _initAllGliders === 'function') _initAllGliders();
}

// ── Settings platform tabs ────────────────────────────────────────────────────
// Call initSettingsPlatformTabs(sectionId) once for any settings section that
// has per-platform panes. It renders the tab buttons from PLATFORMS and wires
// up switching. Panes must be <div id="{sectionId}-{platformId}">.

function initSettingsPlatformTabs(sectionId) {
  const container = document.getElementById(sectionId + '-tabs');
  if (!container) return;
  container.innerHTML = PLATFORMS.map((p, i) =>
    `<button class="settings-sub-tab${i === 0 ? ' active' : ''}" id="stab-${sectionId}-${p.id}" onclick="switchSettingsPlatformTab('${sectionId}','${p.id}')">${p.label}</button>`
  ).join('');
  PLATFORMS.forEach((p, i) => {
    const pane = document.getElementById(sectionId + '-' + p.id);
    if (pane) pane.style.display = i === 0 ? '' : 'none';
  });
}

function switchSettingsPlatformTab(sectionId, platformId) {
  PLATFORMS.forEach(p => {
    const btn  = document.getElementById(`stab-${sectionId}-${p.id}`);
    const pane = document.getElementById(`${sectionId}-${p.id}`);
    const active = p.id === platformId;
    if (btn)  btn.classList.toggle('active', active);
    if (pane) pane.style.display = active ? '' : 'none';
  });
}

window.addEventListener('hashchange', () => {
  switchPlatform(location.hash.slice(1) || 'tiktok');
});

switchPlatform(location.hash.slice(1) || 'tiktok');

// ── Health check ──────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const data = await fetch('/api/health').then(r => r.json());
    if (!data.ok && data.issues && data.issues.length) {
      for (const iss of data.issues) {
        showToast(iss.message, { type: 'error', duration: 0 });
      }
    }
  } catch (_) {}
}

checkHealth();

// ── Toast notifications ────────────────────────────────────────────────────────
// showToast(message, { type, duration, action })
//   type:     'success' | 'warning' | 'error' | 'info'  (default: 'info')
//   duration: ms before auto-dismiss; 0 = persistent     (default: 5000)
//   action:   { label: string, onclick: fn }              (optional)
// Returns { dismiss } for programmatic dismissal.

function showToast(message, { type = 'info', duration = 5000, action = null } = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const body = document.createElement('div');
  body.className = 'toast-body';
  const msg = document.createElement('span');
  msg.textContent = message;
  body.appendChild(msg);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { dismiss(); action.onclick(); };
    body.appendChild(btn);
  }

  toast.appendChild(body);

  const x = document.createElement('button');
  x.className = 'toast-dismiss';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Dismiss');
  x.onclick = dismiss;
  toast.appendChild(x);

  function dismiss() {
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }

  container.appendChild(toast);
  if (duration > 0) setTimeout(dismiss, duration);
  return { dismiss };
}

// ── HTML escape helper ─────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Card action menu ──────────────────────────────────────────────────────────
// _openCardMenu(triggerEl, items)
//   triggerEl: the ••• button element
//   items: [{ label, onclick, danger? }]
// Opens a small dropdown anchored above the trigger button. Closes on outside
// click, ESC, or when any item is chosen.

let _cardMenuEl = null;

function _closeCardMenu() {
  if (_cardMenuEl) { _cardMenuEl.remove(); _cardMenuEl = null; }
}

function _openCardMenu(triggerEl, items) {
  _closeCardMenu();

  const menu = document.createElement('div');
  menu.className = 'card-menu';

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'card-menu-item' + (item.danger ? ' card-menu-item-danger' : '');
    btn.textContent = item.label;
    btn.onclick = () => { _closeCardMenu(); item.onclick(); };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  _cardMenuEl = menu;

  // Position above the trigger, right-aligned to its right edge
  const rect = triggerEl.getBoundingClientRect();
  const menuH = menu.offsetHeight;
  menu.style.right  = `${window.innerWidth - rect.right}px`;
  menu.style.top    = `${rect.top - menuH - 4}px`;

  setTimeout(() => document.addEventListener('click', _closeCardMenu, { once: true }), 0);
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeCardMenu(); });

// ── Report widget ──────────────────────────────────────────────────────────────
// Elements are looked up lazily so this can be called before the DOM is ready.
// id: base id string; reportsApiPath: e.g. '/api/tiktok/reports'

function _makeReportWidget(id, reportsApiPath) {
  return {
    show(filename, previewLines, totalCount) {
      const reportEl  = document.getElementById(`job-${id}-report`);
      const previewEl = document.getElementById(`job-${id}-preview`);
      const dlLink    = document.getElementById(`job-${id}-download-link`);
      if (!reportEl) return;
      reportEl.style.display = '';
      const shown = previewLines.length;
      const more  = totalCount - shown;
      let html = previewLines.map(p => esc(p)).join('\n');
      if (more > 0) html += `\n<span class="report-preview-more">...and ${more} more. View or download the full report.</span>`;
      previewEl.innerHTML = html || '<span style="opacity:.5">No entries.</span>';
      if (dlLink && filename && reportsApiPath) {
        dlLink.href     = `${reportsApiPath}/${encodeURIComponent(filename)}?download=1`;
        dlLink.download = filename;
        dlLink.style.display = '';
      }
    },
    hide() {
      const reportEl = document.getElementById(`job-${id}-report`);
      if (reportEl) reportEl.style.display = 'none';
    },
  };
}

// ── Report viewer modal ────────────────────────────────────────────────────────

async function openReportView(filename, title, apiBase) {
  if (!filename) return;
  const base = apiBase || '/api/tiktok/reports';
  document.getElementById('reportViewTitle').textContent = title;
  document.getElementById('reportViewSub').textContent   = filename;
  document.getElementById('reportViewBody').textContent  = 'Loading...';
  document.getElementById('reportViewBackdrop').style.display = 'flex';
  _lockScroll();
  const resp = await fetch(`${base}/${encodeURIComponent(filename)}`);
  document.getElementById('reportViewBody').textContent =
    resp.ok ? await resp.text() : 'Failed to load report.';
}

function closeReportView() {
  document.getElementById('reportViewBackdrop').style.display = 'none';
  _unlockScroll();
}

// ── DB query pane (one shared widget, rendered per platform) ───────────────────

const _dbqReportFiles = {};
const _dbqWidgets     = {};

function initDbQueryPane(platform) {
  const pane = document.getElementById('database-' + platform);
  if (!pane) return;
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  const id    = 'dbq-' + platform;
  const defaultSqls = { tiktok: 'SELECT * FROM users LIMIT 10;', youtube: 'SELECT * FROM channels LIMIT 10;' };
  const ph = defaultSqls[platform] || 'SELECT 1;';
  pane.innerHTML = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px">
      Run raw SQLite commands against the ${label} database.
      SELECT returns rows; other statements are committed immediately.
    </p>
    <textarea id="${id}-input" class="db-query-input" placeholder="${ph}"></textarea>
    <div class="db-query-controls">
      <button class="btn-primary" onclick="_dbqRun('${platform}')" style="font-size:12px;padding:5px 14px">Run</button>
      <span id="${id}-summary" class="db-query-summary"></span>
      <span id="${id}-error"   class="db-query-error" style="display:none"></span>
    </div>
    <div class="report-widget" id="job-${id}-report" style="display:none">
      <div class="report-preview" id="job-${id}-preview"></div>
      <div class="report-actions">
        <button class="btn-report" onclick="_dbqView('${platform}')">View full report</button>
        <a id="job-${id}-download-link" style="display:none">
          <button class="btn-report">Download report</button>
        </a>
      </div>
    </div>
  `;
  _dbqWidgets[platform] = _makeReportWidget(id, `/api/${platform}/reports`);
}

async function _dbqRun(platform) {
  const id      = 'dbq-' + platform;
  const sql     = (document.getElementById(id + '-input')?.value || '').trim();
  const summary = document.getElementById(id + '-summary');
  const error   = document.getElementById(id + '-error');
  if (!sql) return;
  summary.textContent = 'Running...';
  error.style.display = 'none';
  _dbqWidgets[platform]?.hide();
  const { ok, data } = await apiJSON(`/api/${platform}/db/query`, {
    method: 'POST', body: JSON.stringify({ sql }),
  });
  if (!ok || !data.ok) {
    summary.textContent = '';
    error.textContent   = data.error || 'Query failed.';
    error.style.display = '';
    return;
  }
  summary.textContent = data.summary || '';
  _dbqReportFiles[platform] = data.report_file || null;
  _dbqWidgets[platform]?.show(data.report_file, data.preview || [], data.total || 0);
}

function _dbqView(platform) {
  openReportView(_dbqReportFiles[platform], 'Database query', `/api/${platform}/reports`);
}

// ── API helper ────────────────────────────────────────────────────────────────

async function apiJSON(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json', ...opts.headers } : { ...opts.headers };
  const r = await fetch(path, { ...opts, headers });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

// ── Relative-time formatters ──────────────────────────────────────────────────

const fmt = {
  rel: ts => {
    if (!ts) return '—';
    const diff = Math.round((Date.now() - new Date(ts)) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.round(diff/60)}m ago`;
    return `${Math.round(diff/3600)}h ago`;
  },
  relFuture: ts => {
    if (!ts) return '—';
    const diff = Math.round((new Date(ts) - Date.now()) / 1000);
    if (diff <= 0)   return 'soon';
    if (diff < 60)   return `in ${diff}s`;
    if (diff < 3600) return `in ${Math.round(diff/60)}m`;
    return `in ${Math.round(diff/3600)}h`;
  },
  date: unix => {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString();
  },
  dur: secs => {
    if (secs == null) return '';
    if (secs < 60) return `took ${secs}s`;
    const m = Math.floor(secs / 60), s = secs % 60;
    return s > 0 ? `took ${m}m ${s}s` : `took ${m}m`;
  },
};

// ── Number formatters ─────────────────────────────────────────────────────────

function _fmtSuffix(n, div, sfx) { return (n / div).toFixed(1).replace(/\.0$/, '') + sfx; }

function _fmtLarge(n) {
  if (n >= 1_000_000_000) return _fmtSuffix(n, 1_000_000_000, 'B');
  if (n >= 1_000_000)     return _fmtSuffix(n, 1_000_000, 'M');
  if (n >= 1_000)         return _fmtSuffix(n, 1_000, 'K');
  return n.toLocaleString();
}

function fmtCount(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return _fmtSuffix(n, 1_000_000, 'M');
  if (n >= 1_000)     return _fmtSuffix(n, 1_000, 'K');
  return String(n);
}

// ── Date formatters ───────────────────────────────────────────────────────────

const _dtFmt          = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric',
                                                           hour: '2-digit', minute: '2-digit' });
const _dtFmtTime      = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const _dtFmtRecent    = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short',
                                                           hour: '2-digit', minute: '2-digit' });
const _dtFmtMonthYear = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
const _dtFmtDateOnly  = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function fmtDateShort(unix) {
  if (!unix) return '—';
  return _dtFmt.format(new Date(unix * 1000));
}

function fmtDateOnly(unix) {
  if (!unix) return '—';
  return _dtFmtDateOnly.format(new Date(unix * 1000));
}

// ── Shared render helpers ─────────────────────────────────────────────────────

const PRIVACY_MAP = {
  'public':             ['public',             'Public'],
  'private_accessible': ['private-accessible', 'Private'],
  'private_blocked':    ['private-blocked',    'Private'],
};

const USER_PRIV_IDS  = { all: 'ufPrivAll', public: 'ufPrivPublic', private: 'ufPrivPrivate', banned: 'ufPrivBanned' };
const USER_STAT_IDS  = { all: 'ufStatAll', active: 'ufStatActive', inactive: 'ufStatInactive' };
const USER_STAR_IDS  = { all: 'ufStarAll', starred: 'ufStarStarred' };
const SOUND_STAT_IDS = { all: 'sfStatAll', active: 'sfStatActive', inactive: 'sfStatInactive' };
const SOUND_STAR_IDS = { all: 'sfStarAll', starred: 'sfStarStarred' };

function _videoStatus(v) {
  const isMissing = v.status === 'up' && v.pending_deletion_count > 0;
  const cls   = v.status === 'deleted'   ? 'deleted'
              : v.status === 'undeleted' ? 'undeleted'
              : isMissing                ? 'missing'
              :                           'up';
  const label = v.status === 'deleted'   ? 'Deleted'
              : v.status === 'undeleted' ? 'Restored'
              : isMissing                ? 'Missing'
              :                           'Active';
  return { cls, label };
}

function _trackingBadge(tracking_enabled) {
  return tracking_enabled === 0
    ? { cls: 'inactive', label: 'Inactive' }
    : { cls: 'active',   label: 'Active' };
}

function _fmtLastChecked(ts) {
  return ts
    ? `Last checked ${fmt.rel(new Date(ts * 1000).toISOString())}`
    : 'Never checked';
}

function _pill(key, label, activeKey, onclickFn, counts) {
  const active = activeKey === key ? ' active' : '';
  const n      = counts[key];
  return `<button class="filter-pill${active}" data-filter-key="${key}" onclick="${onclickFn}('${key}')">`
       + `${label}${n ? ` <span style="opacity:.65">(${n})</span>` : ''}</button>`;
}

function _typePill(key, label, activeKey, onclickFn) {
  const active = activeKey === key ? ' active' : '';
  return `<button class="filter-pill${active}" data-type-key="${key}" onclick="${onclickFn}('${key}')">${label}</button>`;
}

function _cmp(av, bv, dir) {
  if (typeof av === 'string') av = av.toLowerCase();
  if (typeof bv === 'string') bv = bv.toLowerCase();
  return av < bv ? (dir === 'asc' ? -1 : 1) : av > bv ? (dir === 'asc' ? 1 : -1) : 0;
}

// Status sort rank: active=0, missing=1, restored=2, deleted=3
function _statusSortVal(v) {
  if (v.status === 'deleted')              return 3;
  if (v.status === 'undeleted')            return 2;
  if ((v.pending_deletion_count || 0) > 0) return 1;
  return 0;
}

function _sortByField(arr, field, dir) {
  return [...arr].sort((a, b) => {
    const av = field === 'status' ? _statusSortVal(a) : a[field] ?? (dir === 'asc' ? Infinity : -Infinity);
    const bv = field === 'status' ? _statusSortVal(b) : b[field] ?? (dir === 'asc' ? Infinity : -Infinity);
    return dir === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0)
                         : (av > bv ? -1 : av < bv ? 1 : 0);
  });
}

// Toggle sort direction or switch field (returns new sort state).
function _doSort(state, field) {
  return state.field === field
    ? { field, dir: state.dir === 'asc' ? 'desc' : 'asc' }
    : { field, dir: 'desc' };
}

// ── Scroll lock ───────────────────────────────────────────────────────────────
// Locks scroll on <html> (the actual scroll root when overflow-x:hidden is set).
// A counter handles nested modals: the lock stays until every opener has closed.
let _scrollLockDepth = 0;
function _lockScroll()   { if (++_scrollLockDepth === 1) document.documentElement.classList.add('modal-open'); }
function _unlockScroll() { if (--_scrollLockDepth === 0) document.documentElement.classList.remove('modal-open'); }

// ── Pill glider ───────────────────────────────────────────────────────────────

function _placeGlider(container) {
  let g = container.querySelector(':scope > .glider');
  const isNew = !g;
  if (isNew) {
    g = document.createElement('span');
    g.className = 'glider';
    container.appendChild(g);
    g.style.transition = 'none';
  }
  const active = container.querySelector(':scope > .filter-pill.active');
  if (!active) { g.style.opacity = '0'; return; }
  g.style.opacity = '1';
  g.style.top    = active.offsetTop + 'px';
  g.style.left   = active.offsetLeft + 'px';
  g.style.width  = active.offsetWidth + 'px';
  g.style.height = active.offsetHeight + 'px';
  if (isNew) requestAnimationFrame(() => { g.style.transition = ''; });
}

function _initAllGliders() {
  document.querySelectorAll('.filter-pills').forEach(_placeGlider);
}

// ── IntersectionObserver sentinel ─────────────────────────────────────────────
// Appends a 1px div, observes it, fires callback once when it scrolls into
// view, then disconnects and removes the sentinel. Returns the observer so
// the caller can store it for early cleanup on modal close.
function _attachSentinel(listEl, callback) {
  const s = document.createElement('div');
  s.style.height = '1px';
  listEl.appendChild(s);
  const obs = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    obs.disconnect();
    s.remove();
    callback();
  }, { root: listEl, rootMargin: '300px' });
  obs.observe(s);
  return obs;
}

// ── Toolbar helpers ───────────────────────────────────────────────────────────
// Shared toolbar expand/collapse body. Returns the new expanded value so
// the caller can write it back to its own state variable.
function _doToggleToolbar(expanded, toolbarId, hasActiveFn) {
  expanded = !expanded;
  const toolbar = document.getElementById(toolbarId);
  const wrap = toolbar?.querySelector('.toolbar-filter-wrap');
  const btn  = toolbar?.querySelector('.toolbar-toggle');
  if (wrap) {
    wrap.classList.toggle('collapsed', !expanded);
    if (expanded) wrap.querySelectorAll('.filter-pills').forEach(_placeGlider);
  }
  if (btn) btn.textContent = (expanded ? '▲' : '▼') + (hasActiveFn() ? ' Filters •' : ' Filters');
  return expanded;
}

// ── Job progress widget ───────────────────────────────────────────────────────
//
// _makeJobWidget(id) -- returns { update({barPct, label, steps}), hide() }
//
// barPct: null  = indeterminate animated bar
//         0-100 = determinate bar (100 snaps to .done state)
//         undefined = no bar shown
// label:  status text shown below the bar
// steps:  array of completed-step strings (optional; shown as green lines)

function _makeJobWidget(id) {
  const statusEl = document.getElementById(`job-${id}-status`);
  const barWrap  = document.getElementById(`job-${id}-bar-wrap`);
  const barEl    = document.getElementById(`job-${id}-bar`);
  const textEl   = document.getElementById(`job-${id}-text`);
  const stepsEl  = document.getElementById(`job-${id}-steps`);
  return {
    update({ barPct, label, steps } = {}) {
      statusEl.style.display = '';
      const hasBar = barPct !== undefined;
      if (barWrap) barWrap.style.display = hasBar ? '' : 'none';
      if (barEl && hasBar) {
        if (barPct === null) {
          barEl.className = 'job-bar-fill indeterminate';
          barEl.style.width = '';
        } else {
          barEl.className = `job-bar-fill${barPct >= 100 ? ' done' : ''}`;
          barEl.style.width = Math.min(barPct, 100) + '%';
        }
      }
      if (textEl) textEl.textContent = label ?? '';
      if (stepsEl) stepsEl.innerHTML = (steps || []).map(s => `<div class="job-step">${esc(s)}</div>`).join('');
    },
    hide() { statusEl.style.display = 'none'; },
  };
}

// ── Loop trigger ──────────────────────────────────────────────────────────────

async function _triggerLoop(btnId, apiPath, errMsg) {
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = true;
  const { ok, data } = await apiJSON(apiPath, { method: 'POST' });
  if (!ok) { showToast(data.error || errMsg, { type: 'error' }); if (btn) btn.disabled = false; }
}

// ── Image preview modal ───────────────────────────────────────────────────────

function openImgModalUrl(url) {
  document.getElementById('imgModalImg').src = url;
  document.getElementById('imgModal').style.display = 'flex';
  _lockScroll();
}

function closeImgModal() {
  document.getElementById('imgModal').style.display = 'none';
  document.getElementById('imgModalImg').src = '';
  _unlockScroll();
}

// ── Shared icons and badges ───────────────────────────────────────────────────

const _dlIcon         = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12L12 16M12 16L16 12M12 16V4M4 20H20"/></svg>`;
const _imgPreviewIcon = `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><g transform="translate(-124,-1319)" fill="currentColor" fill-rule="evenodd"><path d="M136,1329.07849 C136,1328.52795 136.448,1328.08114 137,1328.08114 C137.552,1328.08114 138,1328.52795 138,1329.07849 C138,1329.62903 137.552,1330.07585 137,1330.07585 C136.448,1330.07585 136,1329.62903 136,1329.07849 L136,1329.07849 Z M136.75,1332.0187 L140,1335.95527 L128,1335.95527 L132.518,1330.02399 L135.354,1334.06528 L136.75,1332.0187 Z M128,1325.9817 L128,1323.98699 C128,1323.43644 128.448,1322.98963 129,1322.98963 L133,1322.98963 C133.552,1322.98963 134,1323.43644 134,1323.98699 L134,1325.9817 C134,1326.53324 133.552,1326.97906 133,1326.97906 L129,1326.97906 C128.448,1326.97906 128,1326.53324 128,1325.9817 L128,1325.9817 Z M142,1336.05999 C142,1336.61053 141.552,1336.95263 141,1336.95263 L127,1336.95263 C126.448,1336.95263 126,1336.61053 126,1336.05999 L126,1322.09699 C126,1321.54645 126.448,1320.99491 127,1320.99491 L136,1320.99491 L136,1325.08906 C136,1326.19015 136.895,1326.97906 138,1326.97906 L142,1326.97906 L142,1336.05999 Z M143.707,1324.77091 L138.293,1319.34429 C138.105,1319.15778 137.851,1319.0002 137.586,1319.0002 L126,1319.0002 L126,1319.05306 C124.895,1319.05306 124,1319.97163 124,1321.07371 L124,1321.09964 L124,1337.05735 C124,1338.15843 124.895,1339.0002 126,1339.0002 L126,1338.94734 L142,1338.94734 L142,1339.0002 C143.105,1339.0002 144,1338.1325 144,1337.03142 L144,1325.50197 C144,1325.23767 143.895,1324.95741 143.707,1324.77091 L143.707,1324.77091 Z"/></g></svg>`;
const _listViewIcon   = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="3.5" x2="12" y2="3.5"/><line x1="4" y1="6.5" x2="12" y2="6.5"/><line x1="4" y1="9.5" x2="12" y2="9.5"/><circle cx="1.5" cy="3.5" r=".8" fill="currentColor" stroke="none"/><circle cx="1.5" cy="6.5" r=".8" fill="currentColor" stroke="none"/><circle cx="1.5" cy="9.5" r=".8" fill="currentColor" stroke="none"/></svg>`;
const _gridViewIcon   = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5"><rect x=".75" y=".75" width="4.5" height="4.5" rx=".5"/><rect x="7.75" y=".75" width="4.5" height="4.5" rx=".5"/><rect x=".75" y="7.75" width="4.5" height="4.5" rx=".5"/><rect x="7.75" y="7.75" width="4.5" height="4.5" rx=".5"/></svg>`;
const _badgeStyle     = `position:absolute;bottom:4px;right:4px;color:#fff;pointer-events:none;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))`;
const _playBadge      = `<span style="${_badgeStyle}"><svg width="18" height="18" viewBox="0 0 9 9" fill="currentColor"><polygon points="1.5,0.5 8.5,4.5 1.5,8.5"/></svg></span>`;

// ── Modal engine ──────────────────────────────────────────────────────────────

function _mFiltered(cfg, skipSearch = false) {
  let vids = cfg.st.videos;
  if (cfg.st.filter === 'active')   vids = vids.filter(v => v.status === 'up' && !(v.pending_deletion_count > 0));
  if (cfg.st.filter === 'missing')  vids = vids.filter(v => v.status === 'up' && v.pending_deletion_count > 0);
  if (cfg.st.filter === 'deleted')  vids = vids.filter(v => v.status === 'deleted');
  if (cfg.st.filter === 'restored') vids = vids.filter(v => v.status === 'undeleted');
  if (cfg.st.typeFilter === 'video') vids = vids.filter(v => v.type === 'video');
  if (cfg.st.typeFilter === 'photo') vids = vids.filter(v => v.type === 'photo');
  if (!skipSearch && cfg.st.search) {
    const q = cfg.st.search.toLowerCase();
    vids = vids.filter(v =>
      (v.video_id          || '').toLowerCase().includes(q) ||
      (v.description       || '').toLowerCase().includes(q) ||
      (v.author_username   || '').toLowerCase().includes(q) ||
      (v.author_display_name || '').toLowerCase().includes(q)
    );
  }
  const { field, dir } = cfg.st.sort;
  return _sortByField(vids, field, dir);
}

function _mRenderToolbar(cfg, vids) {
  const counts     = { all: 0, active: 0, missing: 0, deleted: 0, restored: 0 };
  const typeCounts = { video: 0, photo: 0 };
  vids.forEach(v => {
    counts.all++;
    if      (v.status === 'up' && !(v.pending_deletion_count > 0)) counts.active++;
    else if (v.status === 'up' &&   v.pending_deletion_count > 0)  counts.missing++;
    else if (v.status === 'deleted')                               counts.deleted++;
    else if (v.status === 'undeleted')                             counts.restored++;
    if      (v.type === 'video') typeCounts.video++;
    else if (v.type === 'photo') typeCounts.photo++;
  });
  const hasMultipleTypes = typeCounts.video > 0 && typeCounts.photo > 0;
  const pill     = (key, label) => _pill(key, label, cfg.st.filter,     cfg.filterFn,     counts);
  const typePill = (key, label) => _typePill(key, label, cfg.st.typeFilter, cfg.typeFilterFn);
  const shown = _mFiltered(cfg).length;
  const total = _mFiltered(cfg, true).length;
  const countLabel = cfg.st.search
    ? `${shown.toLocaleString()} of ${total.toLocaleString()} posts`
    : (shown === 1 ? '1 post' : `${shown.toLocaleString()} posts`);
  const hasActiveFilters = cfg.st.filter !== 'all' || cfg.st.typeFilter !== 'all';
  const toggleLabel = (cfg.st.toolbarExpanded ? '▲' : '▼') + (hasActiveFilters ? ' Filters •' : ' Filters');
  const toolbar = document.getElementById(cfg.toolbarElId);
  const searchWasFocused = cfg.hasSearch &&
    document.activeElement === toolbar.querySelector('#modalVideoSearch');
  const searchSelEnd = searchWasFocused ? document.activeElement.selectionEnd : 0;
  let html = `<div class="toolbar-main-row">`;
  if (cfg.hasViewToggle) {
    const viewKeys = cfg.viewKeys || [
      { key: 'list', icon: _listViewIcon, title: 'List view' },
      { key: 'grid', icon: _gridViewIcon, title: 'Grid view' },
    ];
    html += `<div class="filter-pills">`
      + viewKeys.map(vk =>
          `<button class="filter-pill${cfg.st.view === vk.key ? ' active' : ''}" data-view-key="${vk.key}" onclick="${cfg.viewFn}('${vk.key}')" title="${vk.title}">${vk.icon}</button>`
        ).join('')
      + `</div>`;
  }
  html += `<button class="filter-pill toolbar-toggle" onclick="${cfg.toggleFn}()">${toggleLabel}</button>`
    + `<span class="modal-vid-count">${countLabel}</span>`;
  if (cfg.hasSearch) {
    html += `<input id="modalVideoSearch" class="modal-video-search" type="search" value="${esc(cfg.st.search)}" placeholder="Search videos…" oninput="${cfg.searchFn}(this.value)">`;
  }
  if (cfg.hasPhistBtn) {
    const pfn = cfg.phistBtnFn || 'openProfileHistory';
    html += `<button class="filter-pill toolbar-phist-btn" onclick="${pfn}()">Profile history</button>`;
  }
  html += `</div>`
    + `<div class="toolbar-filter-wrap${cfg.st.toolbarExpanded ? '' : ' collapsed'}">`
    + `<div class="filter-pills">`
    + pill('all', 'All') + pill('active', 'Active')
    + (counts.missing  ? pill('missing',  'Missing')  : '')
    + (counts.deleted  ? pill('deleted',  'Deleted')  : '')
    + (counts.restored ? pill('restored', 'Restored') : '')
    + `</div>`
    + (hasMultipleTypes
        ? `<div class="filter-pills">`
          + typePill('all', 'All types')
          + typePill('video', `Videos (${typeCounts.video.toLocaleString()})`)
          + typePill('photo', `Photos (${typeCounts.photo.toLocaleString()})`)
          + `</div>`
        : '')
    + `</div>`;
  toolbar.innerHTML = html;
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  if (searchWasFocused) {
    const el = toolbar.querySelector('#modalVideoSearch');
    if (el) { el.focus(); el.setSelectionRange(searchSelEnd, searchSelEnd); }
  }
}

function _mSetFilter(cfg, filter) {
  cfg.st.filter = filter;
  const toolbar = document.getElementById(cfg.toolbarElId);
  toolbar.querySelectorAll('[data-filter-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filterKey === filter);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  const shown = _mFiltered(cfg).length;
  const total = _mFiltered(cfg, true).length;
  const countEl = toolbar.querySelector('.modal-vid-count');
  if (countEl) countEl.textContent = cfg.st.search
    ? `${shown.toLocaleString()} of ${total.toLocaleString()} posts`
    : (shown === 1 ? '1 post' : `${shown.toLocaleString()} posts`);
  const toggleBtn = toolbar.querySelector('.toolbar-toggle');
  if (toggleBtn) {
    const hasActive = cfg.st.filter !== 'all' || cfg.st.typeFilter !== 'all';
    toggleBtn.textContent = (cfg.st.toolbarExpanded ? '▲' : '▼') + (hasActive ? ' Filters •' : ' Filters');
  }
  _mRenderList(cfg);
}

function _mSetTypeFilter(cfg, type) {
  cfg.st.typeFilter = type;
  const toolbar = document.getElementById(cfg.toolbarElId);
  toolbar.querySelectorAll('[data-type-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.typeKey === type);
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  const shown = _mFiltered(cfg).length;
  const total = _mFiltered(cfg, true).length;
  const countEl = toolbar.querySelector('.modal-vid-count');
  if (countEl) countEl.textContent = cfg.st.search
    ? `${shown.toLocaleString()} of ${total.toLocaleString()} posts`
    : (shown === 1 ? '1 post' : `${shown.toLocaleString()} posts`);
  const toggleBtn = toolbar.querySelector('.toolbar-toggle');
  if (toggleBtn) {
    const hasActive = cfg.st.filter !== 'all' || cfg.st.typeFilter !== 'all';
    toggleBtn.textContent = (cfg.st.toolbarExpanded ? '▲' : '▼') + (hasActive ? ' Filters •' : ' Filters');
  }
  _mRenderList(cfg);
}

function _mToggleToolbar(cfg) {
  cfg.st.toolbarExpanded = _doToggleToolbar(
    cfg.st.toolbarExpanded, cfg.toolbarElId,
    () => cfg.st.filter !== 'all' || cfg.st.typeFilter !== 'all'
  );
}

function _mSetSort(cfg, field) {
  cfg.st.sort = _doSort(cfg.st.sort, field);
  const list = document.getElementById(cfg.listElId);
  const sx = list.scrollLeft;
  _mRenderList(cfg);
  list.scrollLeft = sx;
}

function _mRenderColHdrs(cfg) {
  if (cfg.hasViewToggle && cfg.st.view !== 'list') return;
  const list = document.getElementById(cfg.listElId);
  const existing = list.querySelector('.video-list-hdr');
  if (existing) existing.remove();
  list.insertAdjacentHTML('afterbegin',
    `<div class="video-list-hdr"><div class="${cfg.colsCls}">`
    + cfg.cols.map(col => {
        if (!col.field) return `<div class="col-hdr">${col.label}</div>`;
        const isSorted = cfg.st.sort.field === col.field;
        const cls = isSorted ? ` sort-${cfg.st.sort.dir}` : '';
        return `<div class="col-hdr sortable${cls}" onclick="${cfg.sortFn}('${col.field}')">${col.label}</div>`;
      }).join('')
    + '</div></div>');
}

function _mRenderList(cfg) {
  if (cfg.hasViewToggle && cfg.st.view !== 'list') { _renderModalVideoGrid(cfg); return; }
  cfg.st.loaded = 0;
  if (cfg.st.obs) { cfg.st.obs.disconnect(); cfg.st.obs = null; }
  const list = document.getElementById(cfg.listElId);
  list.innerHTML = '';
  list.scrollTop = 0;
  _mRenderColHdrs(cfg);
  const vids = _mFiltered(cfg);
  if (!vids.length) {
    const msg = cfg.st.search ? 'No posts match this search.' : 'No posts match this filter.';
    list.insertAdjacentHTML('beforeend', `<div class="vlist-empty">${msg}</div>`);
    return;
  }
  _mAppendVideos(cfg, vids);
}

function _mAppendVideos(cfg, vids) {
  const list     = document.getElementById(cfg.listElId);
  const batch    = vids.slice(cfg.st.loaded, cfg.st.loaded + cfg.pageSize);
  cfg.st.loaded += batch.length;
  const thumbFn   = cfg.thumbCellFn;
  const actionFn  = cfg.actionBtnsFn;
  const previewFn = cfg.previewFn;
  const fmtUpload = cfg.uploadDateFmt || fmtDateShort;
  const html = batch.map(v => {
    const { cls: statusCls, label: statusLabel } = _videoStatus(v);
    const authorCell = cfg.authorCol ? `<div class="video-cell">${cfg.authorCol(v)}</div>` : '';
    return `<div class="video-row ${cfg.colsCls}" data-video-id="${esc(v.video_id)}">
      ${thumbFn ? thumbFn(v) : ''}
      <div style="display:flex;align-items:center;gap:4px;min-width:0">
        ${previewFn ? `<button class="play-btn" onclick="event.stopPropagation();${previewFn}('${esc(v.video_id)}')" title="Preview thumbnail">${_imgPreviewIcon}</button>` : ''}
        <div style="flex:1;min-width:0">${v.description
          ? `<div class="video-desc">${esc(v.description)}</div>`
          : `<div class="video-desc-empty">(no description)</div>`}</div>
      </div>
      ${authorCell}
      <div class="video-cell">
        <span class="vstatus ${statusCls}">${statusLabel}</span>
      </div>
      <div class="video-cell">${fmtCount(v.view_count)}</div>
      <div class="video-cell">${fmtUpload(v.upload_date)}</div>
      <div class="video-cell">${fmtDateShort(v.download_date)}</div>
      <div class="video-cell">${fmtDateShort(v.deleted_at)}</div>
      <div class="video-cell" style="padding:0;display:flex;align-items:center;justify-content:center;gap:2px">
        ${actionFn ? actionFn(v) : ''}
      </div>
    </div>`;
  }).join('');
  list.insertAdjacentHTML('beforeend', html);
  if (cfg.st.loaded < vids.length) {
    cfg.st.obs = _attachSentinel(list, () => {
      cfg.st.obs = null;
      _mAppendVideos(cfg, vids);
    });
  }
}

// ── Video grid ────────────────────────────────────────────────────────────────

function _renderModalVideoGrid(cfg) {
  cfg.st.loaded = 0;
  if (cfg.st.obs) { cfg.st.obs.disconnect(); cfg.st.obs = null; }
  const list = document.getElementById(cfg.listElId);
  list.innerHTML = '';
  list.scrollTop = 0;
  let vids = _mFiltered(cfg);
  if (cfg.viewVideoFilter) vids = cfg.viewVideoFilter(cfg.st.view, vids);
  if (!vids.length) {
    list.innerHTML = `<div class="vlist-empty">${cfg.st.search ? 'No posts match this search.' : 'No posts match this filter.'}</div>`;
    return;
  }
  const grid = document.createElement('div');
  const extraClass = cfg.gridClassFn ? cfg.gridClassFn(cfg.st.view) : '';
  grid.className = 'video-grid' + (extraClass ? ' ' + extraClass : '');
  grid.id = cfg.gridId;
  list.appendChild(grid);
  _appendModalGrid(cfg, vids);
}

function _appendModalGrid(cfg, vids) {
  const list  = document.getElementById(cfg.listElId);
  const grid  = document.getElementById(cfg.gridId);
  if (!grid) return;
  const batch = vids.slice(cfg.st.loaded, cfg.st.loaded + cfg.pageSize);
  cfg.st.loaded += batch.length;
  batch.forEach(v => {
    const cell = document.createElement('div');
    const { cls } = _videoStatus(v);
    cell.className   = `vgrid-cell${cls !== 'up' ? ' ' + cls : ''}`;
    cell.dataset.videoId = v.video_id;
    const id         = esc(v.video_id);
    const viewsHtml  = v.view_count != null
      ? `<span class="vgrid-views">${fmtCount(v.view_count)}</span>`
      : '<span></span>';
    const typeIcon = cfg.typeIconFn ? cfg.typeIconFn(v) : '';
    const thumbSrc = cfg.gridThumbSrc ? cfg.gridThumbSrc(v) : '';
    cell.innerHTML = `<img src="${thumbSrc}" alt="" onerror="this.style.opacity='.15'">
      <div class="vgrid-overlay">${viewsHtml}${typeIcon}</div>`;
    if (cfg.gridCellOnclick) cell.onclick = () => cfg.gridCellOnclick(v);
    grid.appendChild(cell);
  });
  if (cfg.st.loaded < vids.length) {
    cfg.st.obs = _attachSentinel(list, () => {
      cfg.st.obs = null;
      _appendModalGrid(cfg, vids);
    });
  }
}
