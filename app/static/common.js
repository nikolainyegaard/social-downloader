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

// ── Health banner ─────────────────────────────────────────────────────────────

function _showHealthBanner(issues) {
  const existing = document.getElementById('_healthBanner');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = '_healthBanner';
  el.className = 'health-banner';
  for (const iss of issues) {
    const p = document.createElement('p');
    p.textContent = iss.message;
    el.appendChild(p);
  }
  document.body.prepend(el);
}

async function checkHealth() {
  try {
    const data = await fetch('/api/health').then(r => r.json());
    if (!data.ok && data.issues && data.issues.length) {
      _showHealthBanner(data.issues);
    } else {
      const el = document.getElementById('_healthBanner');
      if (el) el.remove();
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
