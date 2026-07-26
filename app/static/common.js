// Platform list served by the backend (registry order, with enabled flags),
// injected as window.__PLATFORMS__ by index.html before this script loads.
// PLATFORMS is the enabled subset every tab, poll, and pane renders from;
// disabled platforms only appear in the Settings > General toggle list.
const _ALL_PLATFORMS = window.__PLATFORMS__ || [];
const PLATFORMS = _ALL_PLATFORMS.filter(p => p.enabled);

// ── Header auth pill ──────────────────────────────────────────────────────────
// Each platform app reports its auth state via setHdrAuth(); the header pill
// shows the state for the active platform tab. Platforms that never call
// setHdrAuth (YouTube needs no authentication) get no pill.

/** @type {Object<string, {present: boolean, label: string}>} */
const _hdrAuth = {};  // platform -> {present, label}
let _activePlatform = PLATFORMS[0]?.id || '';

function setHdrAuth(platform, present, label) {
  _hdrAuth[platform] = { present, label };
  _updateHdrAuthPill();
}

// ── Per-platform loop status ──────────────────────────────────────────────────
// Each platform app reports its latest loop-status label via setHdrStatus().
// The old header Idle/Running badge is gone (the now strip owns live state);
// the map stays as the cross-platform activity source for chrome indicators
// (e.g. the platform tab activity dots).

/** @type {Object<string, string>} */
const _hdrStatus = {};  // platform -> latest status label

function setHdrStatus(platform, label) {
  _hdrStatus[platform] = label;
  // Pulse the platform's tab dot while its loop is doing anything. Hidden
  // tabs report through their 15 s status polls, the active tab over SSE.
  const tab = document.querySelector(`.platform-tabs .tab[data-platform="${platform}"]`);
  if (tab) tab.classList.toggle('loop-active', label !== 'Idle');
}

function _updateHdrAuthPill() {
  const pill = document.getElementById('hdrCookiePill');
  const txt  = document.getElementById('hdrCookiePillText');
  if (!pill) return;
  const state = _hdrAuth[_activePlatform];
  // Only warn: cookies present is the normal state and needs no header pill
  // (the status pill in Settings still shows it).
  if (!state || state.present) { pill.style.display = 'none'; return; }
  pill.style.display = '';
  pill.className     = 'cookie-pill absent';
  if (txt) txt.textContent = state.label;
}

function switchPlatform(name) {
  if (!PLATFORMS.some(p => p.id === name)) name = PLATFORMS[0]?.id;
  if (!name) return;  // every platform disabled; only Settings > General is usable
  _activePlatform = name;
  _updateHdrAuthPill();
  history.replaceState(null, '', '#' + name);
  document.querySelectorAll('.platform-tabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.platform === name);
  });
  PLATFORMS.forEach(p => {
    const el = document.getElementById('platform-' + p.id);
    if (el) el.style.display = p.id === name ? '' : 'none';
  });
  const app = document.querySelector('.app');
  PLATFORMS.forEach(p => app.classList.remove('theme-' + p.id));
  app.classList.add('theme-' + name);
  _placeTabGlider();
  if (typeof _initAllGliders === 'function') _initAllGliders();
}

// Sliding underline for the platform tabs: an absolute element inside the
// scrolling nav, moved to the active tab on every switch and on resize.
function _placeTabGlider() {
  const nav = document.querySelector('.platform-tabs');
  if (!nav) return;
  const active = nav.querySelector('.tab.active');
  let g = nav.querySelector('.tab-glider');
  if (!(active instanceof HTMLElement)) { if (g instanceof HTMLElement) g.style.width = '0'; return; }
  if (!g) { g = document.createElement('span'); g.className = 'tab-glider'; nav.appendChild(g); }
  if (g instanceof HTMLElement) {
    g.style.left  = active.offsetLeft + 'px';
    g.style.width = active.offsetWidth + 'px';
  }
}
window.addEventListener('resize', () => _placeTabGlider());

// ── Settings modal ────────────────────────────────────────────────────────────
// The modal is fully generated: a nav rail with General plus one entry per
// enabled platform, and a lazily built pane per nav target. Platforms register
// their pane through _settingsRegister (initChannelApp does this from the
// platform cfg), so a new platform gets its settings for free and a disabled
// platform simply never registers.
//
// Section shape: { id, label, html, onShow?, onHide?, onRender?, diagFill? }
//   html      pane markup (wiring functions are referenced by name on window)
//   onRender  called once, right after the section's html first enters the DOM
//   onShow    called every time the section becomes visible
//   onHide    called when the section is left, or on modal close while active
//   diagFill  section stretches to fill the modal height (diagnostics panes)

/** @typedef {{id: string, label: string, html: string, onShow?: () => void, onHide?: () => void, onRender?: () => void, diagFill?: boolean}} SettingsSection */
/** @type {{id: string, label: string, sections: SettingsSection[]}[]} */
const _settingsRegistry = [];
let _settingsTarget = '';           // 'general' or a platform id
/** @type {Object<string, string>} */
const _settingsSectionByTarget = {};  // target id -> last active section id

const _settingsNavMobile = () => window.matchMedia('(max-width: 640px)').matches;

function _settingsRegister(id, label, sections) {
  _settingsRegistry.push({ id, label, sections });
  // Nav order: General first, then platforms in the served (registry) order
  const order = t => t.id === 'general' ? -1 : PLATFORMS.findIndex(p => p.id === t.id);
  _settingsRegistry.sort((a, b) => order(a) - order(b));
}

function toggleSettingsNav() {
  document.querySelector('.settings-modal').classList.toggle('nav-collapsed');
}

function _settingsRenderNav() {
  const nav = document.getElementById('settingsNav');
  if (!nav) return;
  const item = t => `
    <div class="settings-nav-item${t.id === _settingsTarget ? ' active' : ''}" id="snav-${t.id}" title="${esc(t.label)}" onclick="switchSettingsTarget('${t.id}')">
      ${t.id === 'general'
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
        : `<span class="snav-badge">${esc(t.label.charAt(0))}</span>`}
      <span class="snav-label">${esc(t.label)}</span>
    </div>`;
  const general   = _settingsRegistry.filter(t => t.id === 'general');
  const platforms = _settingsRegistry.filter(t => t.id !== 'general');
  nav.innerHTML = `
    <button class="settings-nav-burger" onclick="toggleSettingsNav()" title="Menu" aria-label="Expand or collapse the navigation menu">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <div class="settings-nav-group">App</div>
    ${general.map(item).join('')}
    ${platforms.length ? '<div class="settings-nav-group">Platforms</div>' : ''}
    ${platforms.map(item).join('')}`;
}

// Build (once) and return the pane element for a nav target.
function _settingsPaneEl(target) {
  let pane = document.getElementById(`spane-${target.id}`);
  if (pane) return pane;
  pane = document.createElement('div');
  pane.className = 'settings-pane';
  pane.id = `spane-${target.id}`;
  pane.style.display = 'none';
  pane.innerHTML = `
    <div class="settings-section-title">${esc(target.label)}</div>
    <div class="settings-sub-tabs">${target.sections.map(s =>
      `<button class="tab" id="stab-${target.id}-${s.id}" onclick="switchSettingsSection('${s.id}')">${esc(s.label)}</button>`).join('')}</div>
    ${target.sections.map(s =>
      `<div class="${s.diagFill ? 'ssec-diag' : ''}" id="ssec-${target.id}-${s.id}" style="display:none">${s.html}</div>`).join('')}`;
  document.getElementById('settingsContent').appendChild(pane);
  target.sections.forEach(s => s.onRender?.());
  return pane;
}

function switchSettingsSection(name) {
  const target = _settingsRegistry.find(t => t.id === _settingsTarget);
  if (!target) return;
  const prev = target.sections.find(s => s.id === _settingsSectionByTarget[target.id]);
  const next = target.sections.find(s => s.id === name) || target.sections[0];
  if (prev && prev !== next) prev.onHide?.();
  _settingsSectionByTarget[target.id] = next.id;
  target.sections.forEach(s => {
    const el = document.getElementById(`ssec-${target.id}-${s.id}`);
    if (el) el.style.display = s === next ? '' : 'none';
    document.getElementById(`stab-${target.id}-${s.id}`)?.classList.toggle('active', s === next);
  });
  document.querySelector('.settings-content').classList.toggle('diag-fill', !!next.diagFill);
  next.onShow?.();
}

function switchSettingsTarget(id) {
  const target = _settingsRegistry.find(t => t.id === id) || _settingsRegistry[0];
  if (!target) return;
  if (_settingsTarget && _settingsTarget !== target.id) {
    const prevT = _settingsRegistry.find(t => t.id === _settingsTarget);
    prevT?.sections.find(s => s.id === _settingsSectionByTarget[prevT.id])?.onHide?.();
    const prevPane = document.getElementById(`spane-${_settingsTarget}`);
    if (prevPane) prevPane.style.display = 'none';
  }
  _settingsTarget = target.id;
  _settingsRegistry.forEach(t =>
    document.getElementById(`snav-${t.id}`)?.classList.toggle('active', t.id === target.id));
  _settingsPaneEl(target).style.display = '';
  // Mobile drawer behavior: picking a target collapses the overlay back to the rail
  if (_settingsNavMobile()) document.querySelector('.settings-modal').classList.add('nav-collapsed');
  switchSettingsSection(_settingsSectionByTarget[target.id] || target.sections[0].id);
}

function openSettings(target, section) {
  // Aliases from older markup, toasts, and bookmarked behaviors
  /** @type {Object<string, [string, string?]>} */
  const ALIAS = {
    backfill: ['tiktok', 'jobs'],  migrate: ['tiktok', 'jobs'],
    auth: ['general', 'access'],   access: ['general', 'access'],
    cookies: [_activePlatform, 'account'],  accounts: [_activePlatform, 'account'],
    loops: [_activePlatform, 'schedule'],   schedules: [_activePlatform, 'schedule'],
    utils: [_activePlatform, 'jobs'],       jobs: [_activePlatform, 'jobs'],
    network: [_activePlatform, 'network'],  diag: [_activePlatform, 'diag'],
    database: [_activePlatform, 'database'],
  };
  if (target && ALIAS[target]) [target, section] = ALIAS[target];
  const known = _settingsRegistry.some(t => t.id === target);
  const id = known ? target : (_settingsTarget || _settingsRegistry[0]?.id);
  if (!id) return;
  if (section) _settingsSectionByTarget[id] = section;
  _settingsRenderNav();
  // Nav starts as the icon rail on mobile, expanded on desktop
  document.querySelector('.settings-modal').classList.toggle('nav-collapsed', _settingsNavMobile());
  _dlgWire('settingsBackdrop', () => {
    const t = _settingsRegistry.find(x => x.id === _settingsTarget);
    t?.sections.find(s => s.id === _settingsSectionByTarget[t.id])?.onHide?.();
  });
  _dlgOpen('settingsBackdrop');
  switchSettingsTarget(id);
}

function closeSettings() {
  _dlgClose('settingsBackdrop');
}

// ── Settings > General ────────────────────────────────────────────────────────
// App-wide settings that belong to no platform: the platform on/off toggles
// and the app's own OIDC login.

function _generalPlatformsHtml() {
  return `
    <p class="settings-note">
      Turn platforms on or off. Disabling a platform stops all of its checks,
      loops, and background work immediately, and removes its tab and settings
      until it is enabled again. Saved media and tracked creators are kept.
    </p>
    <div class="settings-group" style="margin-top:16px">
      ${_ALL_PLATFORMS.map(p => `
        <label class="tracking-toggle lg" style="margin-bottom:12px">
          <input type="checkbox" id="ptoggle-${p.id}" ${p.enabled ? 'checked' : ''} onchange="_platformToggle('${p.id}', this)">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label" style="font-size:13px;color:var(--text)">${esc(p.label)}</span>
        </label>`).join('')}
    </div>
    <p class="settings-note">Changes apply immediately; the page reloads to update the tabs.</p>
    <hr class="hr-divider">
    <p class="settings-note" style="margin-bottom:0">Social Downloader <span class="version-tag">v${esc(window.__VERSION__ || 'dev')}</span></p>`;
}

async function _platformToggle(id, input) {
  const label   = _ALL_PLATFORMS.find(p => p.id === id)?.label || id;
  const enabled = input.checked;
  if (!enabled) {
    const go = await openConfirm({
      title: `Disable ${label}?`,
      message: 'All checks, loops, and background work for this platform stop immediately, and its tab disappears until re-enabled. Saved media and tracked creators are kept.',
      confirmLabel: 'Disable',
    });
    if (!go) { input.checked = true; return; }
  }
  input.disabled = true;
  const { ok, data } = await apiJSON(`/api/platforms/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  if (!ok) {
    input.disabled = false;
    input.checked  = !enabled;
    showToast(data.error || `Could not update ${label}.`, { type: 'error' });
    return;
  }
  showToast(`${label} ${enabled ? 'enabled' : 'disabled'}. Reloading…`, { type: 'success', duration: 1500 });
  setTimeout(() => location.reload(), 600);
}

const _GENERAL_ACCESS_HTML = `
  <p style="font-size:13px;color:var(--text-dim);line-height:1.5;margin-bottom:4px">
    Require login before accessing the app via any OIDC provider (Authentik, Keycloak, etc.).
  </p>
  <p style="font-size:13px;color:var(--text-dim);line-height:1.5;margin-bottom:20px">
    <strong>Changes take effect after restarting the container.</strong>
    The secret key and session files are managed automatically.
  </p>
  <div id="authForceDisabledBanner" style="display:none;background:var(--raised);border:1px solid var(--red);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--red)">
    <strong>OAUTH_FORCE_DISABLE=true</strong> is set in your environment. Auth enforcement is bypassed regardless of the toggle below. Remove it to re-enable enforcement after fixing your configuration.
  </div>
  <div id="authRestartBanner" style="display:none;background:var(--raised);border:1px solid var(--accent);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--accent)">
    Saved settings differ from the running configuration. Restart the container to apply.
  </div>
  <label class="tracking-toggle lg" style="margin-bottom:20px">
    <input type="checkbox" id="authEnabled">
    <span class="toggle-track"><span class="toggle-thumb"></span></span>
    <span class="toggle-label" style="font-size:13px;color:var(--text)">Enable OAuth login</span>
  </label>
  <div style="display:flex;flex-direction:column;gap:14px;max-width:500px;margin-bottom:20px">
    <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
      <span>Discovery URL <span style="color:var(--red)">*</span></span>
      <input type="text" id="authDiscoveryUrl" class="text-input" required aria-required="true" placeholder="https://auth.example.com/application/o/my-app/.well-known/openid-configuration" spellcheck="false">
      <span style="font-size:11px;color:var(--muted)">Authentik: application provider settings &gt; OpenID Configuration URL</span>
    </label>
    <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
      <span>Client ID <span style="color:var(--red)">*</span></span>
      <input type="text" id="authClientId" class="text-input" required aria-required="true" placeholder="your-client-id" autocomplete="off" spellcheck="false">
    </label>
    <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
      <span>Client secret <span style="color:var(--red)">*</span></span>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="password" id="authClientSecret" class="text-input" style="flex:1" placeholder="leave blank to keep existing" autocomplete="new-password" spellcheck="false">
        <button id="authSecretToggle" onclick="toggleAuthSecretVisibility()" style="flex-shrink:0;font-size:12px;padding:5px 10px;background:var(--raised);border:1px solid var(--border);border-radius:6px;color:var(--text-dim);cursor:pointer">Show</button>
      </div>
      <span id="authSecretStatus" style="font-size:11px;color:var(--muted)"></span>
    </label>
    <label class="settings-label">
      <span>Session lifetime</span>
      <div class="loop-interval-field">
        <input type="number" id="authSessionDays" min="1" max="365" class="loop-interval-input" value="7">
        <span>days</span>
      </div>
    </label>
  </div>
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px">
    <button class="btn-primary btn-sm" onclick="saveAuthSettings()">Save</button>
  </div>
  <hr style="border:none;border-top:1px solid var(--border);margin-bottom:16px">
  <div class="settings-subtitle">Locked out?</div>
  <p style="font-size:12px;color:var(--text-dim);line-height:1.6;margin:0">
    If the OIDC provider is unreachable and you cannot log in, add
    <code>OAUTH_FORCE_DISABLE: "true"</code> to your docker-compose.yml environment
    block and restart. This bypasses auth enforcement so you can access Settings and
    fix the configuration, then remove the override and restart again.
  </p>`;

_settingsRegister('general', 'General', [
  { id: 'platforms', label: 'Platforms', html: _generalPlatformsHtml() },
  { id: 'access',    label: 'Access',    html: _GENERAL_ACCESS_HTML, onShow: loadAuthSettings },
]);

// ── Cookies panel (shared by cookies-based platforms) ─────────────────────────
// Renders into elements named {idPrefix}Pill, {idPrefix}PillText, {idPrefix}Meta,
// {idPrefix}DeleteBtn. Also feeds the header auth pill.

function _cookiesRender(platform, idPrefix, info) {
  const timeStr = (info.present && info.updated_at)
    ? `Updated ${(() => { const h = Math.round((Date.now() - info.updated_at * 1000) / 3600000); return h < 24 ? `${h}h ago` : `${Math.round(h/24)}d ago`; })()}`
    : '';
  const metaStr = info.present
    ? [timeStr, `${(info.size_bytes / 1024).toFixed(1)} KB`].filter(Boolean).join('  ·  ')
    : '';

  const pill    = document.getElementById(idPrefix + 'Pill');
  const pillTxt = document.getElementById(idPrefix + 'PillText');
  const meta    = document.getElementById(idPrefix + 'Meta');
  const delBtn  = document.getElementById(idPrefix + 'DeleteBtn');
  if (pill)    { pill.className = info.present ? 'cookie-pill present' : 'cookie-pill absent'; }
  if (pillTxt) { pillTxt.textContent = info.present ? 'Cookies loaded' : 'No cookies file'; }
  if (meta)    { meta.textContent = metaStr; }
  if (delBtn)  { delBtn.style.display = info.present ? '' : 'none'; }

  setHdrAuth(platform, !!info.present, info.present ? 'Cookies' : 'No cookies');
}

async function _cookiesLoad(platform, idPrefix) {
  const { ok, data } = await apiJSON(`/api/${platform}/cookies`);
  if (ok) _cookiesRender(platform, idPrefix, data);
}

async function _cookiesUpload(platform, idPrefix, input) {
  if (!input.files.length) return;
  const form = new FormData();
  form.append('file', input.files[0]);
  input.value = '';

  const { ok, data } = await apiJSON(`/api/${platform}/cookies`, { method: 'POST', body: form });
  if (ok) {
    _cookiesRender(platform, idPrefix, data);
  } else {
    showToast(data.error || 'Could not upload the file.', { type: 'error' });
  }
}

async function _cookiesDelete(platform, idPrefix) {
  if (!await openConfirm({ title: 'Remove cookies?', message: 'Remove the stored cookies file?', confirmLabel: 'Remove' })) return;
  const { ok } = await apiJSON(`/api/${platform}/cookies`, { method: 'DELETE' });
  if (ok) _cookiesLoad(platform, idPrefix);
}

// Settings account pane for cookies-based platforms (Twitter, Instagram).
// opts: { site, uploadFn, deleteFn, note }; note is trailing html inside the
// cookie-note block, after the shared extension links. Optional overrides:
// uploadLabel + accept (file button), extBlock (replaces the cookies.txt
// export line + extension links, for platforms that upload something else).
function _cookiesPaneHtml(idPrefix, opts) {
  const ext = (href, icon, label) =>
    `<a href="${href}" class="browser-ext-link" target="_blank" rel="noopener noreferrer"><img src="/static/icons/${icon}.svg" width="16" height="16" alt="">${label}</a>`;
  const extBlock = opts.extBlock || `
      Export cookies from a logged-in ${opts.site} session using the <strong>Get cookies.txt LOCALLY</strong> extension:
      <div style="display:flex;gap:8px;margin:10px 0 8px;flex-wrap:wrap">
        ${ext('https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc', 'chrome', 'Chrome')}
        ${ext('https://microsoftedge.microsoft.com/addons/detail/get-cookies-txt/ebbdheafhjncoeidpdijmfmkicnejelp', 'edge', 'Edge')}
        ${ext('https://addons.mozilla.org/en-US/firefox/addon/get-cookies-txt-locally/', 'firefox', 'Firefox')}
      </div>`;
  return `
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px;">
      <span class="cookie-pill absent" id="${idPrefix}Pill">
        <span class="dot"></span>
        <span id="${idPrefix}PillText">No cookies file</span>
      </span>
      <span class="cookie-meta" id="${idPrefix}Meta"></span>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <label class="cookie-upload-label">
          <input type="file" id="${idPrefix}FileInput" accept="${opts.accept || '.txt,text/plain'}" style="display:none" onchange="${opts.uploadFn}(this)">
          ${opts.uploadLabel || 'Upload cookies.txt'}
        </label>
        <button class="btn-danger" id="${idPrefix}DeleteBtn" onclick="${opts.deleteFn}()" style="display:none">Remove</button>
      </div>
    </div>
    <div class="cookie-note">
      ${extBlock}
      ${opts.note}
    </div>`;
}

// ── Loop schedule settings (shared by session-scheduled platforms) ────────────
// Elements: {idPrefix}SessionsPerDay, {idPrefix}HighPriorityHours,
// {idPrefix}ActiveHours, {idPrefix}InactiveHours.

const _SCHEDULE_FIELDS = [
  ['sessions_per_day',          'SessionsPerDay'],
  ['high_priority_check_hours', 'HighPriorityHours'],
  ['active_check_hours',        'ActiveHours'],
  ['inactive_check_hours',      'InactiveHours'],
  ['full_refresh_days',         'FullRefreshDays'],
];

async function _scheduleSettingsLoad(platform, idPrefix) {
  const { ok, data } = await apiJSON(`/api/${platform}/settings`);
  if (!ok) { showToast('Could not load the schedule settings.', { type: 'error' }); return; }
  for (const [key, suffix] of _SCHEDULE_FIELDS) {
    const el = document.getElementById(idPrefix + suffix);
    if (el && data[key] !== undefined) el.value = data[key];
  }
}

async function _scheduleSettingsSave(platform, idPrefix) {
  const body = {};
  for (const [key, suffix] of _SCHEDULE_FIELDS) {
    const el = document.getElementById(idPrefix + suffix);
    if (!el) continue;
    const val = parseInt(el.value, 10);
    if (!val || val < 1) { showToast('All schedule values must be positive integers.', { type: 'warning', duration: 4000 }); return; }
    body[key] = val;
  }
  const { ok, data } = await apiJSON(`/api/${platform}/settings`, { method: 'PATCH', body: JSON.stringify(body) });
  if (!ok) { showToast(data.error || 'Could not save settings', { type: 'error' }); return; }
  showToast('Settings saved.', { type: 'success', duration: 2500 });
}

// Settings schedule pane for session-scheduled platforms; field ids match
// _scheduleSettingsLoad/_scheduleSettingsSave ({idPrefix}SessionsPerDay, ...).
function _schedulePaneHtml(idPrefix, saveFn, creatorNounPlural) {
  const field = (label, suffix, min, max, unit, title) => `
    <label class="settings-label"${title ? ` title="${title}"` : ''}>
      <span>${label}</span>
      <div class="loop-interval-field">
        <input type="number" id="${idPrefix}${suffix}" min="${min}" max="${max}" class="loop-interval-input">
        <span>${unit}</span>
      </div>
    </label>`;
  return `
    <p class="settings-note">
      Check sessions are spread randomly across each 24 hour window. Each session
      processes only the ${creatorNounPlural} whose check interval has come due.
      Changes take effect at the next scheduled session.
    </p>
    <div class="settings-group">
      ${field('Sessions per day',        'SessionsPerDay',    1, 24,  '')}
      ${field('Starred check interval',  'HighPriorityHours', 1, 168, 'h')}
      ${field('Active check interval',   'ActiveHours',       1, 168, 'h')}
      ${field('Inactive check interval', 'InactiveHours',     1, 720, 'h')}
      ${field('Full check interval',     'FullRefreshDays',   1, 90,  'd',
              'Scheduled checks run quick (newest posts only) between full checks; a full check runs the complete deletion-detecting diff')}
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:14px">
      <button class="btn-primary btn-sm" onclick="${saveFn}()">Save</button>
    </div>`;
}

const _vgridPlayIcon = `<svg width="12" height="12" viewBox="0 0 9 9" fill="rgba(255,255,255,.9)"><polygon points="1.5,0.5 8.5,4.5 1.5,8.5"/></svg>`;
const _vgridPhotoIcon = `<svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x=".75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x=".75" y="7.75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y="7.75" width="4.5" height="4.5" rx=".75"/></svg>`;
const _vgridImageIcon = `<svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x=".75" y=".75" width="11.5" height="11.5" rx="1.5"/><circle cx="4.4" cy="4.4" r="1" fill="rgba(255,255,255,.9)" stroke="none"/><path d="M1.5 9.75 L4.75 6.75 L7 9 L8.75 7.25 L11.5 10"/></svg>`;

// ── Loop panel helpers (shared) ───────────────────────────────────────────────

// Render session-time pills into el: at most the next 4 upcoming sessions,
// so panels look the same regardless of how many sessions a day is set to.
// The first pill is highlighted: running (loop active) or next.
function _renderSessionPills(el, sessions, running, manualRun) {
  if (!el) return;
  const nowMs    = Date.now();
  const upcoming = (sessions || []).filter(s => new Date(s).getTime() >= nowMs).slice(0, 4);
  if (!upcoming.length) { el.innerHTML = ''; return; }
  el.innerHTML = upcoming.map((isoStr, i) => {
    const time = new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    let cls = 'loop-session-pill';
    if (i === 0) cls += running && !manualRun ? ' running' : ' next';
    return `<span class="${cls}">${time}</span>`;
  }).join('');
}

// Toast factory for the Next/Starred/Half/All trigger buttons.
function _makeTriggerToast(noun) {
  return d => {
    const n = d.queued ?? 0;
    if (n === 0) {
      const msg = d.message || `No ${noun}s are due for a check; loop not started`;
      console.info(msg);
      showToast(msg);
      return;
    }
    showToast(`${n} ${noun}${n === 1 ? '' : 's'} queued for check`);
  };
}

// ── API diagnostics pane (shared) ─────────────────────────────────────────────
// Elements: {idPrefix}Input, {idPrefix}Action, {idPrefix}RunBtn, {idPrefix}Output.

function _platformDiagRun(platform, idPrefix) {
  const handle = (document.getElementById(idPrefix + 'Input').value || '').trim();
  const action = _ddValue(idPrefix + 'Action');
  const btn    = document.getElementById(idPrefix + 'RunBtn');
  const out    = document.getElementById(idPrefix + 'Output');
  if (!handle) { out.textContent = 'Enter a handle first.'; return; }
  btn.disabled    = true;
  btn.textContent = 'Running…';
  out.textContent = 'Fetching…';
  apiJSON(`/api/${platform}/diagnostics`, {
    method: 'POST',
    body:   JSON.stringify({ handle, action }),
  })
    .then(({ data }) => { out.textContent = JSON.stringify(data, null, 2); })
    .catch(e         => { out.textContent = 'Error: ' + e; })
    .finally(()      => { btn.disabled = false; btn.textContent = 'Run'; });
}

function _platformDiagCopy(idPrefix) {
  copyText(document.getElementById(idPrefix + 'Output').textContent || '');
}

// One clipboard write with the select-and-copy fallback for insecure
// contexts; briefly morphs btn's label to Copied when given.
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

// Settings diagnostics pane driven by _platformDiagRun/_platformDiagCopy
// (Twitter, Instagram). opts: { note, placeholder, runFn, copyFn,
// actions: [{value, label}] }; element ids follow the {idPrefix}Diag* shape.
function _diagPaneHtml(idPrefix, opts) {
  const dd = opts.actions && opts.actions.length ? `
    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div class="dd" id="${idPrefix}Action" data-value="${opts.actions[0].value}" style="flex:1;min-width:160px">
        <button type="button" class="dd-btn" onclick="_ddToggle(this)"><span class="dd-label">${opts.actions[0].label}</span><span class="dd-caret">▾</span></button>
        <div class="dd-menu" role="listbox" popover>
          ${opts.actions.map((a, i) =>
            `<button type="button" class="dd-opt${i === 0 ? ' active' : ''}" data-value="${a.value}" role="option" onclick="_ddPick(this)">${a.label}</button>`).join('')}
        </div>
      </div>
    </div>` : '';
  return `
    <div style="font-size:12px;color:var(--muted);margin-bottom:16px;">${opts.note}</div>
    ${dd}
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <input id="${idPrefix}Input" class="text-input" type="text" placeholder="${opts.placeholder}" style="flex:1">
      <button class="btn-primary" id="${idPrefix}RunBtn" onclick="${opts.runFn}()" style="flex-shrink:0">Run</button>
    </div>
    <div id="${idPrefix}OutputWrap" style="position:relative">
      <pre id="${idPrefix}Output" class="diag-output">No output yet.</pre>
      <button onclick="${opts.copyFn}()" title="Copy output" class="diag-copy-btn">Copy</button>
    </div>`;
}

window.addEventListener('hashchange', () => {
  switchPlatform(location.hash.slice(1) || _activePlatform);
});

switchPlatform(location.hash.slice(1) || _activePlatform);

// The platform tab row clips on narrow screens; scroll it with the fade mask.
_attachEdgeFade(document.querySelector('.platform-tabs'));

// ── Health check ──────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const { data } = await apiJSON('/api/health');
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
//   duration: ms before auto-dismiss; 0 = persistent
//             (default: 5000, except errors: persistent until dismissed, so
//             there is time to read and copy the message)
//   action:   { label: string, onclick: fn }              (optional)
// Error toasts clamp the message to a two-line preview; clicking one opens
// the error dialog with the full text and a Copy button.
// Returns { dismiss, update } for programmatic dismissal and morphing.

function showToast(message, { type = 'info', duration = type === 'error' ? 0 : 5000, action = null, spinner = false } = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    // Live region: toasts are the app's primary feedback channel, so screen
    // readers must hear them
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    // Manual popover: toasts live in the top layer so they paint above open
    // <dialog> overlays (z-index cannot reach the top layer)
    container.popover = 'manual';
    document.body.appendChild(container);
  }
  _topToasts();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  if (type === 'error') toast.setAttribute('role', 'alert');

  let spin = null;
  if (spinner) {
    spin = document.createElement('span');
    spin.className = 'spinner';
    toast.appendChild(spin);
  }

  const body = document.createElement('div');
  body.className = 'toast-body';
  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  body.appendChild(msg);

  // The full message survives the CSS preview clamp and update() morphs, so
  // the error dialog always gets the complete text
  let fullMessage = message;
  if (type === 'error') msg.title = 'Show the full error';
  body.onclick = (ev) => {
    if (ev.target instanceof Element && ev.target.closest('button')) return;
    if (toast.classList.contains('toast-error')) openErrorModal(fullMessage);
  };

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
  let timer = duration > 0 ? setTimeout(dismiss, duration) : null;

  // Morph this toast in place (e.g. loading spinner into a result). If the
  // user already dismissed it, the result is shown as a fresh toast instead.
  function update(newMessage, { type: newType = 'info', duration: newDuration = newType === 'error' ? 0 : 5000 } = {}) {
    if (!toast.isConnected) { showToast(newMessage, { type: newType, duration: newDuration }); return; }
    fullMessage = newMessage;
    msg.textContent = newMessage;
    msg.title = newType === 'error' ? 'Show the full error' : '';
    toast.className = `toast toast-${newType}`;
    if (spin) { spin.remove(); spin = null; }
    if (timer) clearTimeout(timer);
    timer = newDuration > 0 ? setTimeout(dismiss, newDuration) : null;
  }

  return { dismiss, update };
}

// ── Native <dialog> plumbing ────────────────────────────────────────────────────
// Every overlay is a <dialog> styled as its own full-viewport backdrop (the
// element itself paints the tint; ::backdrop is unused). showModal() gives
// top-layer stacking, focus containment and restore, and native Escape.
// Cleanup that must also run on Escape lives in a 'close' listener registered
// via _dlgWire; the scroll lock pairs with it automatically.

function _dlg(id) { return /** @type {HTMLDialogElement|null} */ (document.getElementById(id)); }

function _dlgOpen(id) {
  const el = _dlg(id);
  if (!el || el.open) return el;
  _dlgWire(id);
  el.showModal();
  _lockScroll();
  _topToasts();  // keep toasts above the newly topmost dialog
  return el;
}

function _dlgClose(id) {
  const el = _dlg(id);
  if (el && el.open) el.close();
}

function _dlgIsOpen(id) {
  const el = _dlg(id);
  return !!(el && el.open);
}

// Register per-dialog close cleanup once. The scroll unlock is automatic;
// onClose runs after it on every close path (button, backdrop click, Escape).
// Dialogs with cleanup must be wired before their first open.
function _dlgWire(id, onClose) {
  const el = _dlg(id);
  if (!el || el.dataset.dlgWired) return;
  el.dataset.dlgWired = '1';
  el.addEventListener('close', () => { _unlockScroll(); onClose?.(); });
}

// Re-promote the toast container to the top of the top layer so toasts stay
// above every open dialog.
function _topToasts() {
  const c = document.getElementById('toast-container');
  if (!c) return;
  try {
    if (c.matches(':popover-open')) c.hidePopover();
    c.showPopover();
  } catch (_) { /* popover API missing: toasts fall back to normal stacking */ }
}

// ── Error dialog ────────────────────────────────────────────────────────────────
// Full text behind a truncated error toast: selectable, with a Copy button.

function openErrorModal(text) {
  document.getElementById('errorModalText').textContent = text;
  _dlgOpen('errorModal');
}

function closeErrorModal() {
  _dlgClose('errorModal');
}

function copyErrorModal() {
  copyText(document.getElementById('errorModalText').textContent || '',
           document.getElementById('errorModalCopy'));
}

// ── Confirm / prompt dialog ─────────────────────────────────────────────────────
// Themed replacement for the browser's blocking confirm()/prompt(). Both return
// a promise: openConfirm resolves true/false, openPrompt resolves the string or
// null on cancel. One shared #confirmModal element, driven by _confirmState.

let _confirmState = null;

function _openDialog(o) {
  return new Promise(resolve => {
    _confirmState = { resolve, isPrompt: !!o.isPrompt, multiline: !!o.multiline, hasCheckbox: !!o.checkbox,
                      suggest: null, suggestItems: [], result: undefined };
    document.getElementById('confirmTitle').textContent = o.title || '';
    const msgEl = document.getElementById('confirmMessage');
    msgEl.textContent   = o.message || '';
    msgEl.style.display = o.message ? '' : 'none';

    const chkWrap = document.getElementById('confirmCheckWrap');
    const chk     = document.getElementById('confirmCheck');
    const warn    = document.getElementById('confirmWarn');
    if (o.checkbox) {
      chkWrap.style.display = '';
      document.getElementById('confirmCheckLabel').textContent = o.checkbox.label || '';
      chk.checked   = false;
      warn.textContent   = o.checkbox.warn || '';
      warn.style.display = 'none';
      // Reveal the red warning only while the option is on.
      chk.onchange = () => { warn.style.display = chk.checked && o.checkbox.warn ? '' : 'none'; };
    } else {
      chkWrap.style.display = 'none';
      warn.style.display    = 'none';
    }

    // Prompts use the single-line input by default; multiline prompts (notes)
    // swap in the textarea so Enter inserts a newline instead of accepting.
    const inp = document.getElementById('confirmInput');
    const ta  = document.getElementById('confirmTextarea');
    const field = o.multiline ? ta : inp;
    if (o.isPrompt) {
      field.style.display = '';
      (o.multiline ? inp : ta).style.display = 'none';
      field.value       = o.value || '';
      field.placeholder = o.placeholder || '';
    } else {
      inp.style.display = 'none';
      ta.style.display  = 'none';
    }
    // Optional typeahead under the input: o.suggest(query) returns
    // [{value, label, sub, avatar}] rendered as clickable rows; picking one
    // fills the input and accepts. Single-line prompts only.
    _confirmState.suggest = (o.isPrompt && !o.multiline && o.suggest) || null;
    inp.oninput = _confirmState.suggest ? () => _confirmRenderSuggest(inp.value) : null;
    _confirmRenderSuggest('');
    const ok = document.getElementById('confirmOk');
    ok.textContent = o.confirmLabel || 'Confirm';
    ok.classList.toggle('danger', !!o.danger);
    // Resolution lives in the close listener so a native Escape (dialog
    // cancel) and the backdrop click resolve as a dismissal too
    _dlgWire('confirmModal', () => {
      const s = _confirmState;
      if (!s) return;
      _confirmState = null;
      document.getElementById('confirmSuggest').style.display = 'none';
      document.getElementById('confirmInput').oninput = null;
      if (s.result !== undefined) s.resolve(s.result);
      else s.resolve(s.hasCheckbox ? { confirmed: false, checked: false } : (s.isPrompt ? null : false));
    });
    _dlgOpen('confirmModal');
    (o.isPrompt ? field : ok).focus();
  });
}

function openConfirm({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true } = {}) {
  return _openDialog({ title, message, confirmLabel, danger, isPrompt: false });
}

function openPrompt({ title = '', message = '', value = '', placeholder = '', confirmLabel = 'Save', multiline = false, suggest = null } = {}) {
  return _openDialog({ title, message, value, placeholder, confirmLabel, multiline, suggest, danger: false, isPrompt: true });
}

// Confirm with an extra opt-in checkbox. Resolves { confirmed, checked }.
// checkboxWarn is shown in red only while the box is ticked.
function openConfirmOption({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true, checkboxLabel = '', checkboxWarn = '' } = {}) {
  return _openDialog({ title, message, confirmLabel, danger, checkbox: { label: checkboxLabel, warn: checkboxWarn } });
}

function _confirmAccept() {
  const s = _confirmState;
  if (!s) return;
  if (s.hasCheckbox)    s.result = { confirmed: true, checked: document.getElementById('confirmCheck').checked };
  else if (s.isPrompt)  s.result = document.getElementById(s.multiline ? 'confirmTextarea' : 'confirmInput').value;
  else                  s.result = true;
  _dlgClose('confirmModal');
}

function _confirmDismiss() {
  _dlgClose('confirmModal');
}

// Typeahead rows for a prompt with a suggest hook. Re-rendered on every
// keystroke from the hook's (local, instant) results; empty query or no
// matches hides the list.
function _confirmRenderSuggest(q) {
  const s   = _confirmState;
  const sug = document.getElementById('confirmSuggest');
  if (!s || !s.suggest) { sug.style.display = 'none'; return; }
  const items = s.suggest(q) || [];
  s.suggestItems = items;
  sug.innerHTML = items.map((it, i) => `
    <button class="cs-row" onclick="_confirmPickSuggest(${i})">
      <span class="cs-avatar">${it.avatar ? `<img src="${esc(it.avatar)}" loading="lazy" alt="" onerror="this.remove()">` : esc((it.sub || it.value || '?').replace(/^@/, '')[0] || '?')}</span>
      <span class="cs-label">${esc(it.label || it.value)}</span>
      ${it.sub ? `<span class="cs-sub">${esc(it.sub)}</span>` : ''}
    </button>`).join('');
  sug.style.display = items.length ? '' : 'none';
}

function _confirmPickSuggest(i) {
  const s  = _confirmState;
  const it = s && s.suggestItems && s.suggestItems[i];
  if (!it) return;
  document.getElementById('confirmInput').value = it.value;
  _confirmAccept();
}

// ── Custom dropdown ─────────────────────────────────────────────────────────────
// Themed replacement for a native <select> whose option list the OS draws. The
// selected value lives in the .dd element's data-value; read it with _ddValue,
// set it programmatically with _ddSetValue, rebuild the options with _ddSetOptions.
// Each option's own onclick calls _ddPick(this) then any handler, so no eval.

function _ddOptsHtml(opts, onchange) {
  return opts.map(o =>
    `<button type="button" class="dd-opt" data-value="${esc(o.value)}" role="option"` +
    ` onclick="_ddPick(this)${onchange ? ';' + onchange : ''}">${esc(o.label)}</button>`
  ).join('');
}

// Build a complete dropdown. value defaults to the first option.
/**
 * @param {string} id
 * @param {{value: string, label: string}[]} opts
 * @param {{value?: string, onchange?: string, className?: string}} [o]
 */
function _ddHtml(id, opts, { value, onchange, className = '' } = {}) {
  const cur = opts.find(o => o.value === value) || opts[0] || { value: '', label: '' };
  return `<div class="dd${className ? ' ' + className : ''}" id="${id}" data-value="${esc(cur.value)}">` +
    `<button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" onclick="_ddToggle(this)">` +
    `<span class="dd-label">${esc(cur.label)}</span><span class="dd-caret">▾</span></button>` +
    `<div class="dd-menu" role="listbox" popover>${_ddOptsHtml(opts, onchange)}</div></div>`;
}

function _ddCloseAll() {
  document.querySelectorAll('.dd-menu, .m-dd-menu').forEach(m => {
    if (m.matches(':popover-open')) /** @type {HTMLElement} */ (m).hidePopover();
  });
}

// Open a popover menu as a fixed box under (or above) its trigger, clamped to
// the viewport. The top layer escapes masked/transformed ancestors (the old
// portal-to-body) and open dialogs; light dismiss and Escape are native.
function _menuOpenAt(btn, menu) {
  // Safety net for hand-written menu markup missing the popover attribute
  if (!menu.hasAttribute('popover')) menu.setAttribute('popover', '');
  if (menu.matches(':popover-open')) { menu.hidePopover(); return false; }
  // Clicking the trigger while its menu is open: light dismiss already closed
  // the menu on pointerdown, so this click must not instantly reopen it
  if (Date.now() - (+menu.dataset.closedAt || 0) < 250) return false;
  if (!menu.dataset.menuWired) {
    menu.dataset.menuWired = '1';
    // beforetoggle, not toggle: toggle is dispatched async, which would stamp
    // closedAt after the trigger's click handler already reopened the menu
    menu.addEventListener('beforetoggle', e => {
      const open = /** @type {ToggleEvent} */ (e).newState === 'open';
      btn.setAttribute('aria-expanded', String(open));
      if (!open) menu.dataset.closedAt = String(Date.now());
    });
  }
  menu.showPopover();
  const M = 8;  // min gap from any window edge
  const r = btn.getBoundingClientRect();
  // Cap width to the window so the menu can never exceed both edges, then clamp
  // its left so it stays fully on-screen wherever the button sits.
  menu.style.maxWidth = `min(320px, ${window.innerWidth - M * 2}px)`;
  menu.style.minWidth = r.width + 'px';
  menu.style.top      = (r.bottom + 5) + 'px';
  const w = menu.offsetWidth;
  menu.style.left = Math.max(M, Math.min(r.left, window.innerWidth - M - w)) + 'px';
  const h = menu.offsetHeight;
  if (r.bottom + 5 + h > window.innerHeight && r.top - 5 - h > 0)
    menu.style.top = (r.top - 5 - h) + 'px';
  _menuFocus(menu);
  return true;
}

function _ddToggle(btn) {
  const dd = btn.parentNode;
  if (!(dd instanceof Element)) return;
  const menu = /** @type {HTMLElement|null} */ (dd.querySelector('.dd-menu'));
  if (!menu) return;
  if (!menu.dataset.ddWired) {
    menu.dataset.ddWired = '1';
    menu.addEventListener('toggle', () => dd.classList.toggle('open', menu.matches(':popover-open')));
  }
  _menuOpenAt(btn, menu);
}

function _ddPick(opt) {
  const menu = opt.closest('.dd-menu');
  const dd = opt.closest('.dd');
  if (!dd || !menu) return;
  dd.dataset.value = opt.dataset.value;
  dd.querySelector('.dd-label').textContent = opt.textContent;
  menu.querySelectorAll('.dd-opt').forEach(o => o.classList.toggle('active', o === opt));
  if (menu.matches(':popover-open')) menu.hidePopover();
}

function _ddValue(id) {
  return document.getElementById(id)?.dataset.value ?? '';
}

// Set the selection without firing any onchange (mirrors `select.value = x`).
function _ddSetValue(id, value) {
  const dd = document.getElementById(id);
  if (!dd) return;
  const opt = dd.querySelector(`.dd-opt[data-value="${CSS.escape(String(value))}"]`);
  if (!opt) return;
  dd.dataset.value = value;
  dd.querySelector('.dd-label').textContent = opt.textContent;
  dd.querySelectorAll('.dd-opt').forEach(o => o.classList.toggle('active', o === opt));
}

// Rebuild the option list (for a dependent dropdown), then select `value`.
/**
 * @param {string} id
 * @param {{value: string, label: string}[]} opts
 * @param {{value?: string, onchange?: string}} [o]
 */
function _ddSetOptions(id, opts, { value, onchange } = {}) {
  const dd = document.getElementById(id);
  if (!dd) return;
  dd.querySelector('.dd-menu').innerHTML = _ddOptsHtml(opts, onchange);
  _ddSetValue(id, value ?? (opts[0] && opts[0].value));
}

// ── Add-lookup toasts ─────────────────────────────────────────────────────────
// Adding a creator is asynchronous: POST /channels enqueues a lookup that a
// worker resolves seconds later into the persistent add_queue table. Each
// platform polls its /queue (newest state per handle: pending lookups plus
// recent resolutions); this manager shows one sticky spinner toast per pending
// lookup (including lookups already in flight when the page loads) and morphs
// it into a success or error toast on resolution. Errors it never spun for
// are not toasted. They stay visible in the Add history panel.
function _makeAddToasts(onAdded) {
  const active = new Map();   // handle -> toast controller

  function start(handle) {
    if (!active.has(handle)) {
      active.set(handle, showToast(`Looking up @${handle}…`, { spinner: true, duration: 0 }));
    }
  }

  function sync(queue) {
    for (const [handle, info] of Object.entries(queue)) {
      if (info.status === 'pending') start(handle);
    }
    let resolvedOk = false;
    for (const [handle, t] of [...active]) {
      const info = queue[handle];
      if (!info || info.status === 'pending') continue;
      active.delete(handle);
      if (info.status === 'error' && info.kind === 'duplicate') {
        // Already tracked is not a failure; show it as a friendly green toast
        t.update(`@${handle} is already tracked.`, { type: 'success' });
      } else if (info.status === 'error') {
        t.update(`Failed to add @${handle}: ${info.message || info.kind || 'lookup failed'}`,
                 { type: 'error' });
      } else {
        t.update(`@${handle} added.`, { type: 'success' });
        resolvedOk = true;
      }
    }
    if (resolvedOk && onAdded) onAdded();
  }

  return { start, sync };
}

// ── HTML escape helper ─────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Event delegation ──────────────────────────────────────────────────────────
// One click listener per re-rendered container: interactive elements carry
// data-action (+ data-* args) instead of interpolated onclick strings, so
// re-renders never rebuild handlers and untrusted text (labels, display
// names) never lands inside an attribute-embedded expression.
// actions: { name: (dataset, el, event) => void }
function _delegate(container, actions) {
  if (!container) return;
  container.addEventListener('click', e => {
    const t = e.target instanceof Element && e.target.closest('[data-action]');
    if (!t || !container.contains(t) || t.matches('button:disabled')) return;
    const fn = actions[t.getAttribute('data-action') || ''];
    if (fn) fn(/** @type {HTMLElement} */ (t).dataset, /** @type {HTMLElement} */ (t), e);
  });
}

// ── Card action menu ──────────────────────────────────────────────────────────
// _openCardMenu(triggerEl, items)
//   triggerEl: the ••• button element
//   items: [{ label, onclick, danger? }]
// A popover menu anchored above the trigger button: light dismiss (outside
// click) and Escape are native, and the top layer keeps it above any open
// dialog. Closes when any item is chosen.

let _cardMenuEl = null;

function _closeCardMenu() {
  if (!_cardMenuEl) return;
  const menu = _cardMenuEl;
  _cardMenuEl = null;
  if (menu.matches(':popover-open')) menu.hidePopover();
  menu.remove();
}

function _openCardMenu(triggerEl, items) {
  _closeCardMenu();
  // Clicking the trigger while its menu is open: light dismiss already closed
  // it on pointerdown, so this click must not instantly reopen it
  if (Date.now() - (+triggerEl.dataset.menuClosedAt || 0) < 250) return;

  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'card-menu-item' + (item.danger ? ' card-menu-item-danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.disabled) btn.disabled = true;
    else btn.onclick = () => { _closeCardMenu(); item.onclick(); };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  _cardMenuEl = menu;
  // beforetoggle, not toggle: toggle is dispatched async, which would stamp
  // menuClosedAt after the trigger's click handler already reopened the menu
  menu.addEventListener('beforetoggle', e => {
    if (/** @type {ToggleEvent} */ (e).newState === 'closed') {
      triggerEl.setAttribute('aria-expanded', 'false');
      triggerEl.dataset.menuClosedAt = String(Date.now());
      if (_cardMenuEl === menu) _cardMenuEl = null;
      // Removal waits a tick: removing mid-dismiss would cancel the event
      setTimeout(() => menu.remove(), 0);
    }
  });
  menu.showPopover();
  triggerEl.setAttribute('aria-expanded', 'true');

  // Position above the trigger, right-aligned to its right edge; flip below
  // when there's no room above (e.g. the header user menu)
  const rect = triggerEl.getBoundingClientRect();
  const menuH = menu.offsetHeight;
  menu.style.right  = `${window.innerWidth - rect.right}px`;
  const top = rect.top - menuH - 4;
  menu.style.top = `${top < 4 ? rect.bottom + 4 : top}px`;

  _menuFocus(menu);
}

// Arrow-key navigation shared by every popover menu (card menu, .dd, .m-dd);
// options are plain buttons, so Enter/Space activate natively and the popover
// restores focus to the trigger on close.
function _menuFocus(menu) {
  if (!menu.dataset.menuKeys) {
    menu.dataset.menuKeys = '1';
    menu.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const opts = [...menu.querySelectorAll('button:not(:disabled)')];
      if (!opts.length) return;
      e.preventDefault();
      const i = opts.indexOf(document.activeElement);
      (e.key === 'ArrowDown' ? opts[Math.min(i + 1, opts.length - 1)]
        : e.key === 'ArrowUp' ? opts[Math.max(i - 1, 0)]
        : e.key === 'Home' ? opts[0] : opts[opts.length - 1]).focus();
    });
  }
  const first = menu.querySelector('button.active:not(:disabled)') || menu.querySelector('button:not(:disabled)');
  if (first instanceof HTMLElement) first.focus();
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
  document.getElementById('reportViewBody').textContent  = 'Loading…';
  _dlgOpen('reportViewBackdrop');
  const { ok, text } = await apiText(`${base}/${encodeURIComponent(filename)}`);
  document.getElementById('reportViewBody').textContent =
    ok ? text : 'Could not load the report.';
}

function closeReportView() {
  _dlgClose('reportViewBackdrop');
}

// ── DB query pane (one shared widget, rendered per platform) ───────────────────

const _dbqReportFiles = {};
const _dbqWidgets     = {};

function initDbQueryPane(platform) {
  const pane = document.getElementById('database-' + platform);
  if (!pane) return;
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  const id    = 'dbq-' + platform;
  const ph = 'SELECT * FROM channels LIMIT 10;';
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
  summary.textContent = 'Running…';
  error.style.display = 'none';
  _dbqWidgets[platform]?.hide();
  const { ok, data } = await apiJSON(`/api/${platform}/db/query`, {
    method: 'POST', body: JSON.stringify({ sql }),
  });
  if (!ok || !data.ok) {
    summary.textContent = '';
    error.textContent   = data.error || 'Could not run the query.';
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

let _loginRedirectPending = false;

// Expired session: send the browser to log in (once; concurrent polls must
// not each overwrite the OAuth state)
function _auth401(r) {
  if (r.status !== 401) return false;
  if (!_loginRedirectPending) {
    _loginRedirectPending = true;
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
  }
  return true;
}

async function apiJSON(path, opts = {}) {
  const isForm  = opts.body instanceof FormData;
  const headers = opts.body && !isForm ? { 'Content-Type': 'application/json', ...opts.headers } : { ...opts.headers };
  const r = await fetch(path, { ...opts, headers });
  if (_auth401(r)) return { ok: false, status: 401, data: {} };
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

// Text-response variant with the same 401-to-login behavior (report files)
async function apiText(path) {
  const r = await fetch(path);
  if (_auth401(r)) return { ok: false, text: '' };
  return { ok: r.ok, text: await r.text().catch(() => '') };
}

// ── Authentication settings ───────────────────────────────────────────────────

async function loadAuthSettings() {
  const { ok, data } = await apiJSON('/api/auth/config');
  if (!ok) return;

  document.getElementById('authEnabled').checked          = data.enabled;
  document.getElementById('authDiscoveryUrl').value       = data.discovery_url || '';
  document.getElementById('authClientId').value           = data.client_id || '';
  document.getElementById('authClientSecret').value       = '';
  document.getElementById('authSessionDays').value        = data.session_lifetime_days || 7;
  document.getElementById('authSecretStatus').textContent = data.client_secret_set
    ? 'A client secret is saved.'
    : 'No client secret saved.';

  // Warn when the saved config differs from what is currently running
  const pendingChange = data.enabled !== data.enabled_runtime;
  document.getElementById('authRestartBanner').style.display = pendingChange ? '' : 'none';

  // Warn when the force-disable override is active
  document.getElementById('authForceDisabledBanner').style.display = data.force_disabled ? '' : 'none';
}

function toggleAuthSecretVisibility() {
  const input = document.getElementById('authClientSecret');
  const btn   = document.getElementById('authSecretToggle');
  if (input.type === 'password') {
    input.type      = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type      = 'password';
    btn.textContent = 'Show';
  }
}

async function saveAuthSettings() {
  const enabled      = document.getElementById('authEnabled').checked;
  const discoveryUrl = document.getElementById('authDiscoveryUrl').value.trim();
  const clientId     = document.getElementById('authClientId').value.trim();
  const clientSecret = document.getElementById('authClientSecret').value;
  const sessionDays  = parseInt(document.getElementById('authSessionDays').value, 10) || 7;

  if (enabled && (!discoveryUrl || !clientId)) {
    showToast('Discovery URL and Client ID are required to enable OAuth.', { type: 'warning' });
    return;
  }

  const body = { enabled, discovery_url: discoveryUrl, client_id: clientId, session_lifetime_days: sessionDays };
  if (clientSecret) body.client_secret = clientSecret;

  const { ok, data } = await apiJSON('/api/auth/config', { method: 'PATCH', body: JSON.stringify(body) });

  if (ok) {
    showToast('Authentication settings saved.', { type: 'success' });
    document.getElementById('authClientSecret').value       = '';
    document.getElementById('authClientSecret').type        = 'password';
    document.getElementById('authSecretToggle').textContent = 'Show';
    if (clientSecret) document.getElementById('authSecretStatus').textContent = 'A client secret is saved.';
    // Show restart banner any time settings are saved, since all changes require a restart
    document.getElementById('authRestartBanner').style.display = '';
  } else {
    showToast((data && data.error) || 'Could not save.', { type: 'error' });
  }
}

// ── Relative-time formatters ──────────────────────────────────────────────────

const fmt = {
  rel: ts => {
    if (!ts) return '–';
    const diff = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60)       return `${diff}s ago`;
    if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  { const h = Math.floor(diff / 3600),   m = Math.floor((diff % 3600) / 60);          return m > 0 ? `${h}h ${m}m ago`   : `${h}h ago`;   }
    if (diff < 30*86400) { const d = Math.floor(diff / 86400), h = Math.floor((diff % 86400) / 3600);       return h > 0 ? `${d}d ${h}h ago`   : `${d}d ago`;   }
    const mo = Math.floor(diff / (30*86400)), d = Math.floor((diff % (30*86400)) / 86400);
    return d > 0 ? `${mo}mo ${d}d ago` : `${mo}mo ago`;
  },
  relFuture: ts => {
    if (!ts) return '–';
    const diff = Math.round((new Date(ts).getTime() - Date.now()) / 1000);
    if (diff <= 0)       return 'soon';
    if (diff < 60)       return `in ${diff}s`;
    if (diff < 3600)     return `in ${Math.floor(diff / 60)}m`;
    if (diff < 86400)  { const h = Math.floor(diff / 3600),   m = Math.floor((diff % 3600) / 60);          return m > 0 ? `in ${h}h ${m}m`    : `in ${h}h`;    }
    if (diff < 30*86400) { const d = Math.floor(diff / 86400), h = Math.floor((diff % 86400) / 3600);       return h > 0 ? `in ${d}d ${h}h`    : `in ${d}d`;    }
    const mo = Math.floor(diff / (30*86400)), d = Math.floor((diff % (30*86400)) / 86400);
    return d > 0 ? `in ${mo}mo ${d}d` : `in ${mo}mo`;
  },
  date: unix => {
    if (!unix) return '–';
    return new Date(unix * 1000).toLocaleString();
  },
  dur: secs => {
    if (secs == null) return '';
    if (secs < 60) return `took ${secs}s`;
    if (secs < 3600) {
      const m = Math.floor(secs / 60), s = secs % 60;
      return s > 0 ? `took ${m}m ${s}s` : `took ${m}m`;
    }
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    if (s > 0) return `took ${h}h ${m}m ${s}s`;
    return m > 0 ? `took ${h}h ${m}m` : `took ${h}h`;
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

function _fmtBytes(n) {
  if (n >= 1024 ** 3) return _fmtSuffix(n, 1024 ** 3, ' GB');
  return _fmtSuffix(n, 1024 ** 2, ' MB');
}

// Loop pause toggle icons (loop panel headers)
const _pauseIcon  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>`;
const _resumeIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l14 8-14 8z"/></svg>`;

// Shared pause-button render: swaps icon and title, dims the Next label
function _renderPauseState(btn, nextEl, paused) {
  if (btn) {
    btn.innerHTML = paused ? _resumeIcon : _pauseIcon;
    btn.title     = paused ? 'Resume scheduled sessions' : 'Pause scheduled sessions';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    btn.classList.toggle('paused', paused);
  }
  if (nextEl) nextEl.classList.toggle('loop-next-paused', paused);
}

// Pluralize: _n(3, 'story', 'stories') -> "3 stories"
const _n = (n, noun, plural) => `${n} ${n === 1 ? noun : (plural || noun + 's')}`;

function fmtCount(n) {
  if (n == null) return '–';
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
  if (!unix) return '–';
  return _dtFmt.format(new Date(unix * 1000));
}

function fmtDateOnly(unix) {
  if (!unix) return '–';
  return _dtFmtDateOnly.format(new Date(unix * 1000));
}

// ── Shared render helpers ─────────────────────────────────────────────────────

const SOUND_STAT_IDS = { active: 'sfStatActive', inactive: 'sfStatInactive' };
const SOUND_STAR_IDS = { starred: 'sfStarStarred' };

function _videoStatus(v) {
  const cls   = v.status === 'deleted'   ? 'deleted'
              : v.status === 'undeleted' ? 'undeleted'
              :                           'up';
  const label = v.status === 'deleted'   ? 'Deleted'
              : v.status === 'undeleted' ? 'Restored'
              :                           'Active';
  return { cls, label };
}

const _GHOST_CARD = '<div class="user-card" aria-hidden="true" style="visibility:hidden;pointer-events:none;min-height:220px"></div>';
function _ghostCards(n) { return n > 0 ? Array(n).fill(_GHOST_CARD).join('') : ''; }

// Empty states carry a next action: icon ('inbox' for nothing-here, 'search'
// for filtered-to-zero), message, and at most one CTA button. Renders inside
// the .empty-state (grids) and .vlist-empty (modal lists) wrappers.
const _emptyInboxIcon  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const _emptySearchIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
function _emptyInner(icon, msg, btnHtml = '') {
  return `<div class="empty-inner">${icon === 'search' ? _emptySearchIcon : _emptyInboxIcon}<div class="empty-msg">${msg}</div>${btnHtml}</div>`;
}

// Modal list/grid empty block: distinguishes "nothing saved" from "filters
// hide everything"; the Clear button is bound by _mWireEmptyClear (a real
// listener with the cfg closure, so no global function name is needed).
function _mEmptyInner(cfg) {
  const noun = cfg.itemNounPlural || 'posts';
  if (!cfg.st.videos.length) return _emptyInner('inbox', `No ${noun} saved yet.`);
  const cause = cfg.st.search ? 'search' : 'filter';
  return _emptyInner('search', `No ${noun} match this ${cause}.`,
    `<button class="btn-ghost btn-sm vlist-clear">Clear ${cause === 'search' ? 'search' : 'filters'}</button>`);
}
function _mWireEmptyClear(cfg, root) {
  const btn = root.querySelector('.vlist-clear');
  if (!btn) return;
  btn.addEventListener('click', () => {
    cfg.st.search = '';
    cfg.st.filter.clear();
    cfg.st.typeFilter.clear();
    const s = document.getElementById('modalVideoSearch');
    if (s instanceof HTMLInputElement) s.value = '';
    _mRenderToolbar(cfg, cfg.st.videos);
    _mRenderList(cfg);
  });
}

// Shared catalog card skeleton. Both the channel card (channels.js) and the
// TikTok sound card (tiktok.js) fill these slots so the card structure lives in
// one place. All slot values are raw HTML except `name`, which is escaped here.
function _cardShell(o) {
  return `
    <div class="user-card${o.classes ? ' ' + o.classes : ''}" ${o.dataAttr || ''}${o.onclick ? ` onclick="${o.onclick}"` : ' data-action="open"'} role="button" tabindex="0">
      <div class="user-card-top">
        ${o.icon || ''}
        <div class="user-identity">
          <div class="user-display-name">${o.namePrefix || ''}${esc(o.name || '')}</div>
          <div class="user-handle">${o.sub || ''}</div>
          ${o.idLine ? `<div class="user-id-line">${esc(o.idLine)}</div>` : ''}
        </div>
        <div class="user-badges">${o.badges || ''}</div>
      </div>
      <div class="user-bio-area">${o.bio || ''}</div>
      <div class="user-stats">${o.stats || ''}</div>
      ${o.extra || ''}
      <div class="user-card-footer">${o.footer || ''}</div>
      ${o.meta || ''}
    </div>`;
}

// Shared card pieces so neither card builder hand-writes the same markup.
function _statChip(label, value, color) {
  return `<span class="stat-item"><span class="stat-item-label">${esc(label)}</span>` +
    `<span class="stat-item-value"${color ? ` style="color:var(--${color})"` : ''}>${esc(String(value))}</span></span>`;
}
function _starBtn(starred, id) {
  return `<button class="btn-star${starred ? ' starred' : ''}" data-action="star" data-id="${esc(id)}" ` +
    `aria-pressed="${starred ? 'true' : 'false'}" title="${starred ? 'Unstar' : 'Star'}">${_starIcon(starred)}</button>`;
}
// Meta footer row from [{label, value}] pairs (value is preformatted text).
function _cardMeta(items) {
  return `<div class="user-card-meta-footer">` + items.map(m =>
    `<div class="user-card-meta-item"><span class="meta-label">${esc(m.label)}</span>` +
    `<span class="meta-value">${esc(m.value)}</span></div>`).join('') + `</div>`;
}

// Expandable text: one clamped line with an ellipsis that pops the full text over
// itself in a hovering box on click. Extracted from the modal bio so any card or
// panel can reuse it. Stops propagation so it works inside a clickable card.
const _xCloseIcon = `<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"><path d="M1 1L9 9M9 1L1 9"/></svg>`;
// X inside a circle: reset-filters buttons
const _xCircleIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`;
const _xExpandIcon = `<svg class="xtext-exp" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
// Read-only text (bios, video descriptions) renders plain; boxed adds the
// input-style field chrome and is reserved for the editable note field, so
// boxed = editable, plain + expand glyph = readable/copyable.
function _expandableText(text, boxed = false) {
  if (!text) return '';
  const t = esc(text);
  return `<div class="xtext${boxed ? ' xtext-boxed' : ''}" onclick="event.stopPropagation();_xtextToggle(this)" role="button" tabindex="0">` +
    `<div class="xtext-line"><span class="xtext-text">${t}</span>${_xExpandIcon}</div>` +
    `<div class="xtext-pop" onclick="event.stopPropagation()">` +
    `<button class="xtext-close" onclick="_xtextClose(this)" aria-label="Close">${_xCloseIcon}</button>${t}</div></div>`;
}
// Always-present note field under a detail modal's action row. A populated
// note renders as the same expandable xtext block as bios (click to expand);
// an empty one is a muted italic "Click to add a note" that opens the note
// editor (editFn, also behind the header menu's Edit note item) directly.
// One ledger row of a modal header's data block (see .hdr-data): muted label
// left, right-aligned semibold tabular value. cls carries the value state
// (' tred' / ' tyellow' / ' tlink' / ' tzero' dim), click an optional handler.
function _hgRow(label, value, cls = '', click = '') {
  return `<div class="hg-row"><span class="hg-l">${label}</span>` +
    `<span class="hg-v${cls}"${click ? ` onclick="${click}" role="button" tabindex="0" title="Open profile change history"` : ''}>${value}</span></div>`;
}

// Static plain placeholder (not clickable): keeps empty read-only fields like
// a missing bio in the same plain language as populated ones.
function _xtextPlaceholderHtml(label) {
  return `<div class="xtext xtext-static"><div class="xtext-line"><span class="xtext-text note-empty">${esc(label)}</span></div></div>`;
}

function _noteFieldHtml(note, editFn, marginTop) {
  // Both states carry the boxed field chrome (outline, fill, hover): the note
  // is the one editable field, and the box is what signals editable.
  const inner = note
    ? _expandableText(note, true)
    : `<div class="xtext xtext-boxed" onclick="event.stopPropagation();${editFn}()" role="button" tabindex="0">` +
      `<div class="xtext-line"><span class="xtext-text note-empty">Click to add a note</span></div></div>`;
  return `<div class="modal-note" style="margin-top:${marginTop}px">${inner}</div>`;
}

// Enter and Space activate any role="button" element that is not a real
// button (cards, feed rows, ledger links, expandable text, grid cells)
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!(t instanceof HTMLElement) || t.getAttribute('role') !== 'button') return;
  if (['BUTTON', 'A', 'INPUT', 'TEXTAREA'].includes(t.tagName) || t.isContentEditable) return;
  e.preventDefault();
  t.click();
});

function _xtextToggle(el) { el.classList.toggle('open'); }
function _xtextClose(btn) { btn.closest('.xtext')?.classList.remove('open'); }
// Capture phase: the xtext toggles and many card controls stopPropagation, so a
// bubble listener never saw those clicks and an open box stayed open when
// another one was clicked. Capture runs before any of that.
document.addEventListener('click', e => {
  document.querySelectorAll('.xtext.open').forEach(x => { if (e.target instanceof Node && !x.contains(e.target)) x.classList.remove('open'); });
}, true);
// The box is always clickable; the overflow icon only shows when the single line
// is actually truncated. Measure the text (scrollWidth > clientWidth) and toggle
// .is-clipped. Call after any render that emits _expandableText; also runs on resize.
function _markXtextClipped(root) {
  (root || document).querySelectorAll('.xtext').forEach(x => {
    const t = x.querySelector('.xtext-text');
    if (t) x.classList.toggle('is-clipped', t.scrollWidth - t.clientWidth > 1);
  });
}
let _xtextResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_xtextResizeTimer);
  _xtextResizeTimer = setTimeout(() => _markXtextClipped(document), 150);
});

// Word-level diff for profile history bio entries: LCS over word+whitespace
// tokens, rendered as per-side highlights (deletions marked on Old, insertions
// on New). Returns {oldHtml, newHtml}, both fully escaped.
function _wordDiff(oldStr, newStr) {
  const a = String(oldStr).split(/(\s+)/).filter(t => t !== '');
  const b = String(newStr).split(/(\s+)/).filter(t => t !== '');
  const n = a.length, m = b.length;
  // ponytail: O(n*m) LCS; bios are tiny. Plain text past ~400 tokens per side.
  if (n * m > 160000) return { oldHtml: esc(oldStr), newHtml: esc(newStr) };
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, oldHtml = '', newHtml = '', delBuf = [], insBuf = [];
  const flush = () => {
    if (delBuf.length) { oldHtml += `<span class="diff-del">${esc(delBuf.join(''))}</span>`; delBuf = []; }
    if (insBuf.length) { newHtml += `<span class="diff-ins">${esc(insBuf.join(''))}</span>`; insBuf = []; }
  };
  while (i < n && j < m) {
    if (a[i] === b[j])                 { flush(); const t = esc(a[i]); oldHtml += t; newHtml += t; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) delBuf.push(a[i++]);
    else                                   insBuf.push(b[j++]);
  }
  while (i < n) delBuf.push(a[i++]);
  while (j < m) insBuf.push(b[j++]);
  flush();
  return { oldHtml, newHtml };
}

// Line-aligned diff view (diffchecker-style) built on _wordDiff. Lines are
// LCS-matched; a changed block pairs old/new lines index-wise and word-diffs
// within each pair; an unpaired line gets a hatched gap cell on the other side
// so the two columns stay row-aligned. Edited rows carry a light full-row tint
// with the stronger word tint inside; whole added/removed lines get the strong
// tint across the row. Returns the grid HTML, or null when the text is too
// large (caller falls back to the flat word diff).
function _lineDiffHtml(oldStr, newStr) {
  const a = String(oldStr).split('\n'), b = String(newStr).split('\n');
  const n = a.length, m = b.length;
  if (n * m > 250000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const cells = [];
  const cell = (cls, html) => `<div class="ld-cell${cls ? ' ' + cls : ''}">${html}</div>`;
  let i = 0, j = 0, dels = [], inss = [];
  const flush = () => {
    for (let x = 0; x < Math.max(dels.length, inss.length); x++) {
      const o = dels[x], nl = inss[x];
      if (o !== undefined && nl !== undefined) {
        const d = _wordDiff(o, nl);
        cells.push(cell('ld-del', d.oldHtml), cell('ld-ins', d.newHtml));
      } else if (o !== undefined) {
        cells.push(cell('ld-del ld-full', esc(o)), cell('ld-gap', ''));
      } else {
        cells.push(cell('ld-gap', ''), cell('ld-ins ld-full', esc(nl)));
      }
    }
    dels = []; inss = [];
  };
  while (i < n && j < m) {
    if (a[i] === b[j])                     { flush(); const t = esc(a[i]); cells.push(cell('', t), cell('', t)); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) dels.push(a[i++]);
    else                                   inss.push(b[j++]);
  }
  while (i < n) dels.push(a[i++]);
  while (j < m) inss.push(b[j++]);
  flush();
  return `<div class="ld-grid">${cells.join('')}</div>`;
}

function _trackingBadge(tracking_enabled) {
  return tracking_enabled === 0
    ? { cls: 'inactive', label: 'Untracked' }
    : { cls: 'active',   label: 'Tracked' };
}

// Log console line colorization, shared by the TikTok and channel platform log viewers.
function _logLineClass(line) {
  if (/=== .+ (started|complete|aborted|stopped|\(inserted\))/i.test(line))               return 'log-sep';
  if (/\]\s+Processing @/.test(line) || /\[sound\] Processing sound/i.test(line))         return 'log-user';
  if (/error|failed|unexpected/i.test(line))                                              return 'log-err';
  if (/warn|deleted|corrupt/i.test(line))                                                 return 'log-warn';
  if (/download|saved/i.test(line))                                                       return 'log-dl';
  if (/Profile change:|Username changed:|Handle changed:|avatar changed|Account (banned|restored|recovered)|Private account|\[sound\] Discovered/i.test(line)) return 'log-profile';
  return '';
}

const LOCK_SVG = `<svg class="lock-icon" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><path d="M24 8.5a5.5 5.5 0 0 1 5.5 5.5v4.5h-11V14A5.5 5.5 0 0 1 24 8.5Zm8.5 10V14a8.5 8.5 0 0 0-17 0v4.5H11A2.5 2.5 0 0 0 8.5 21v19a2.5 2.5 0 0 0 2.5 2.5h26a2.5 2.5 0 0 0 2.5-2.5V21a2.5 2.5 0 0 0-2.5-2.5h-4.5Zm-21 3h25v18h-25v-18Z"/></svg>`;

function _fmtLastChecked(ts) {
  return ts
    ? `Last checked ${fmt.rel(new Date(ts * 1000).toISOString())}`
    : 'Never checked';
}

function _pill(key, label, activeSet, onclickFn, counts) {
  const active = activeSet.has(key) ? ' active' : '';
  const n      = counts[key];
  return `<button class="filter-pill${active}" data-filter-key="${key}" onclick="${onclickFn}('${key}')">`
       + `${label}${n ? ` <span style="opacity:.65">(${n})</span>` : ''}</button>`;
}

function _typePill(key, label, activeSet, onclickFn) {
  const active = activeSet.has(key) ? ' active' : '';
  return `<button class="filter-pill${active}" data-type-key="${key}" onclick="${onclickFn}('${key}')">${label}</button>`;
}

function _cmp(av, bv, dir) {
  if (typeof av === 'string') av = av.toLowerCase();
  if (typeof bv === 'string') bv = bv.toLowerCase();
  return av < bv ? (dir === 'asc' ? -1 : 1) : av > bv ? (dir === 'asc' ? 1 : -1) : 0;
}

// Status sort rank: active=0, restored=2, deleted=3
function _statusSortVal(v) {
  if (v.status === 'deleted')   return 3;
  if (v.status === 'undeleted') return 2;
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
// padding-right compensates for the scrollbar gutter that overflow:hidden removes,
// keeping layout stable. scrollbar-gutter:stable on html handles the non-modal case.
let _scrollLockDepth = 0;
function _lockScroll() {
  if (++_scrollLockDepth === 1) {
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    if (gutter > 0) document.documentElement.style.paddingRight = `${gutter}px`;
    document.documentElement.classList.add('modal-open');
  }
}
function _unlockScroll() {
  if (--_scrollLockDepth === 0) {
    document.documentElement.classList.remove('modal-open');
    document.documentElement.style.paddingRight = '';
  }
}

// ── Pill glider ───────────────────────────────────────────────────────────────

function _placeGlider(container) {
  if (container.classList.contains('multi')) return;
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

// Viewport-based sentinel for full-page grids (cards, channels).
// Unlike _attachSentinel, root is null so the browser viewport is used.
function _attachGridSentinel(gridEl, callback) {
  const s = document.createElement('div');
  s.style.cssText = 'height:1px;grid-column:1/-1';
  gridEl.appendChild(s);
  const obs = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    obs.disconnect();
    s.remove();
    callback();
  }, { rootMargin: '400px' });
  obs.observe(s);
  return obs;
}

// Horizontal-scroll edge fade: toggles fade-l/fade-r classes on a scrollable
// row so the clipped edge gets a fade-out mask (see the .edge-fade class).
function _attachEdgeFade(el) {
  if (!el) return;
  const update = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('fade-l', max > 1 && el.scrollLeft > 1);
    el.classList.toggle('fade-r', max > 1 && el.scrollLeft < max - 1);
  };
  el.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(el);
  update();
  return update;
}

// Attach the edge fade to a modal toolbar once, then re-run its update after
// every re-render (innerHTML changes the scroll width but not the element size,
// so the ResizeObserver alone would not catch it).
const _toolbarFadeUpdaters = new WeakMap();
function _mEnsureToolbarFade(el) {
  let update = _toolbarFadeUpdaters.get(el);
  if (!update) {
    el.classList.add('edge-fade');
    update = _attachEdgeFade(el) || (() => {});
    _toolbarFadeUpdaters.set(el, update);
  }
  update();
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
// _makeJobWidget(id): returns { update({barPct, label, steps}), hide() }
//
// barPct: null  = indeterminate animated bar
//         0-100 = determinate bar (100 snaps to .done state)
//         undefined = no bar shown
// label:  status text shown below the bar
// steps:  array of completed-step strings (optional; shown as green lines)

function _makeJobWidget(id) {
  // Element lookups are lazy: widgets are created at script load, but the
  // settings pane holding their markup only renders on first open.
  const el = suffix => document.getElementById(`job-${id}-${suffix}`);
  return {
    /** @param {{barPct?: number, label?: string, steps?: string[]}} [state] */
    update({ barPct, label, steps } = {}) {
      const statusEl = el('status');
      const barWrap  = el('bar-wrap');
      const barEl    = el('bar');
      const textEl   = el('text');
      const stepsEl  = el('steps');
      if (!statusEl) return;
      statusEl.style.display = '';
      const hasBar = barPct !== undefined;
      if (barWrap) barWrap.style.display = hasBar ? '' : 'none';
      if (barEl && hasBar) {
        const track = barEl.parentElement;
        if (track) {
          track.setAttribute('role', 'progressbar');
          track.setAttribute('aria-valuemin', '0');
          track.setAttribute('aria-valuemax', '100');
        }
        if (barPct === null) {
          barEl.className = 'job-bar-fill indeterminate';
          barEl.style.width = '';
          track?.removeAttribute('aria-valuenow');
        } else {
          barEl.className = `job-bar-fill${barPct >= 100 ? ' done' : ''}`;
          barEl.style.width = Math.min(barPct, 100) + '%';
          track?.setAttribute('aria-valuenow', String(Math.min(barPct, 100)));
        }
      }
      if (textEl) textEl.textContent = label ?? '';
      if (stepsEl) stepsEl.innerHTML = (steps || []).map(s => `<div class="job-step">${esc(s)}</div>`).join('');
    },
    hide() { const statusEl = el('status'); if (statusEl) statusEl.style.display = 'none'; },
  };
}

// ── Loop trigger ──────────────────────────────────────────────────────────────

async function _triggerLoop(btnId, apiPath, errMsg, onSuccess) {
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = true;
  const { ok, data } = await apiJSON(apiPath, { method: 'POST' });
  if (!ok) { showToast(data.error || errMsg, { type: 'error' }); if (btn) btn.disabled = false; }
  else {
    if (onSuccess) onSuccess(data);
    // Nothing queued means no run will start, so no status change will ever
    // re-enable the button; free it here.
    if (btn && data && data.queued === 0) btn.disabled = false;
  }
}

// ── Image preview modal ───────────────────────────────────────────────────────

function openImgModalUrl(url) {
  document.getElementById('imgModalImg').src = url;
  _dlgWire('imgModal', () => { document.getElementById('imgModalImg').src = ''; });
  _dlgOpen('imgModal');
}

function closeImgModal() {
  _dlgClose('imgModal');
}

// ── Media viewer modal ────────────────────────────────────────────────────────
// The one media viewer: photo posts, multi-media posts, normal video playback,
// and stories. Slides are plain image URL strings (TikTok photo posts) or
// {url, type: 'image'|'video'} objects.
//
// Two entry points parameterize the behavior: openMediaViewer is the plain
// viewer (nav arrows on multi-slide sets, play/pause + mute + seek chrome on
// videos), openStoryViewer is story mode (progress bars, auto-advance,
// 20/60/20 tap zones, no button chrome; a center tap toggles pause and
// flashes the state icon over the media).

let _mvSlides = [];
let _mvIdx    = 0;
let _mvMuted  = false;  // sticky across slides within one open, reset on close

const _STORY_IMAGE_SECS = 5;
let _storyMode     = false;
let _storyTimer    = null;
let _storyPaused   = false;
let _storyEndsAt   = 0;     // when the armed advance timer fires (ms epoch)
let _storyRemainMs = 0;     // captured at pause, drives the resume timer
let _storySlideCtx = null;  // {isVid, vid, fill} of the running slide

// Instant shell for async opens (the story-list fetch takes a beat on
// mobile): the dark overlay and a spinner appear on the click itself, and the
// caller swaps in slides when the data lands, or closes the viewer on
// failure. _mvIsOpen lets the caller detect a close during the fetch.
function openMediaViewerPending() {
  _mvOpen();
  document.getElementById('mvSpinner').style.display = '';
}

function _mvIsOpen() {
  return _dlgIsOpen('mvModal');
}

// Open the viewer dialog; teardown runs from the close listener so a native
// Escape tears the viewer (and story mode) down exactly like the close button
function _mvOpen() {
  _dlgWire('mvModal', _mvTeardown);
  _dlgOpen('mvModal');
}

function openMediaViewer(slides) {
  if (!slides || !slides.length) return;
  _mvSlides = slides;
  // Single-slide sets (normal video playback, lone photos) drop the nav
  // arrows and let the media use the released width
  document.getElementById('mvModal').classList.toggle('mv-single', slides.length === 1);
  _mvShowSlide(0);
  _mvOpen();
  document.getElementById('mvSpinner').style.display = 'none';
}

function openStoryViewer(slides) {
  if (!slides || !slides.length) return;
  _storyMode = true;
  document.getElementById('mvModal').classList.add('story-mode');
  const bar = document.getElementById('storyProgress');
  bar.innerHTML = slides.map(() =>
    '<span class="story-progress-seg"><span class="story-progress-fill"></span></span>').join('');
  bar.style.display = '';
  openMediaViewer(slides);
}
const _mvPlayIcon  = `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 5.2v13.6c0 .8.9 1.3 1.6.9l10.4-6.8c.6-.4.6-1.4 0-1.8L10.1 4.3c-.7-.4-1.6.1-1.6.9z"/></svg>`;
const _mvPauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="6.4" y="5" width="3.8" height="14" rx="1.2"/><rect x="13.8" y="5" width="3.8" height="14" rx="1.2"/></svg>`;
const _soundIcon = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M4 9.5v5a1 1 0 0 0 1 1h2.8l4.6 3.7c.65.52 1.6.06 1.6-.78V5.58c0-.84-.95-1.3-1.6-.78L7.8 8.5H5a1 1 0 0 0-1 1z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M16.5 9a4.4 4.4 0 0 1 0 6M18.8 6.8a7.6 7.6 0 0 1 0 10.4"/></svg>`;
const _mutedIcon = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M4 9.5v5a1 1 0 0 0 1 1h2.8l4.6 3.7c.65.52 1.6.06 1.6-.78V5.58c0-.84-.95-1.3-1.6-.78L7.8 8.5H5a1 1 0 0 0-1 1z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M16.3 9.7l5 5M21.3 9.7l-5 5"/></svg>`;

// Play/pause and mute glyphs on the video's lower edge plus the seek bar:
// plain-video slides only. Story mode has no chrome; its feedback is the
// flash overlay. The play glyph shows the actionable action (a pause symbol
// while playing); the mute glyph shows the current state (crossed speaker
// while muted, sound waves while audible).
function _mvSync() {
  const vid  = document.getElementById('mvVid');
  const show = vid.style.display !== 'none' && !_storyMode;
  const playBtn = document.getElementById('mvPlayBtn');
  const muteBtn = document.getElementById('mvMuteBtn');
  playBtn.style.display = muteBtn.style.display =
    document.getElementById('mvSeek').style.display = show ? '' : 'none';
  if (!show) return;
  const playing = !(vid.paused || vid.ended);
  playBtn.innerHTML = playing ? _mvPauseIcon : _mvPlayIcon;
  playBtn.title     = playing ? 'Pause' : 'Play';
  playBtn.setAttribute('aria-label', playBtn.title);
  muteBtn.innerHTML = vid.muted ? _mutedIcon : _soundIcon;
  muteBtn.title     = vid.muted ? 'Unmute' : 'Mute';
  muteBtn.setAttribute('aria-label', muteBtn.title);
}

// Momentary center overlay flashing what just happened. Only manual toggles
// call this; playback starting on open never flashes.
function _mvFlash(icon) {
  const el = document.getElementById('mvFlash');
  el.innerHTML = icon;
  el.classList.remove('on');
  void el.offsetWidth;  // restart the animation
  el.classList.add('on');
}

function mvTogglePlay() {
  if (_storyMode) {
    const pausing = !_storyPaused;
    pausing ? _storyPause() : _storyResume();
    _mvFlash(pausing ? _mvPauseIcon : _mvPlayIcon);
    return;
  }
  const vid = document.getElementById('mvVid');
  if (vid.style.display === 'none') return;
  if (vid.paused) {
    if (vid.ended) vid.currentTime = 0;
    vid.play().catch(() => {});
    _mvFlash(_mvPlayIcon);
  } else {
    vid.pause();
    _mvFlash(_mvPauseIcon);
  }
}

function mvToggleMute() {
  const vid = document.getElementById('mvVid');
  _mvMuted = vid.muted = !vid.muted;
}

// Seek bar (plain video only): input drags set the position, timeupdate
// events keep the bar tracking playback.
function mvSeek(val) {
  const vid = document.getElementById('mvVid');
  if (isFinite(vid.duration) && vid.duration > 0)
    vid.currentTime = (Number(val) / 1000) * vid.duration;
}

function _mvSeekSync() {
  if (_storyMode) return;
  const vid = document.getElementById('mvVid');
  if (isFinite(vid.duration) && vid.duration > 0)
    document.getElementById('mvSeek').value =
      String(Math.round(vid.currentTime / vid.duration * 1000));
}

// Same anchor-click download as the Videos list-view Download button; works
// on every slide shape (string slides let the browser derive the filename).
function mvDownloadCurrent() {
  const slide = _mvSlides[_mvIdx];
  if (!slide) return;
  const a = document.createElement('a');
  a.href = typeof slide === 'string' ? slide : slide.url;
  a.download = (typeof slide !== 'string' && slide.name) || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Opens the current slide's original post URL in a new tab. The button is
// disabled by _mvShowSlide when the slide has no link, so this only fires
// with one present.
function mvOpenLink() {
  const slide = _mvSlides[_mvIdx];
  const link  = (slide && typeof slide !== 'string') ? slide.link : null;
  if (link) window.open(link, '_blank', 'noopener');
}

function _storyClearTimer() {
  if (_storyTimer) { clearTimeout(_storyTimer); _storyTimer = null; }
}

// Every advance timer goes through here so pause can read how long remains.
function _storyArm(ms) {
  _storyClearTimer();
  _storyEndsAt = Date.now() + ms;
  _storyTimer  = setTimeout(_storyAdvance, ms);
}

function _storyPause() {
  if (!_storyMode || _storyPaused || !_storySlideCtx) return;
  _storyPaused   = true;
  _storyRemainMs = Math.max(0, _storyEndsAt - Date.now());
  _storyClearTimer();
  const { isVid, vid, fill } = _storySlideCtx;
  if (fill) {
    // Freeze the bar where the animation currently has it
    const w = getComputedStyle(fill).width;
    fill.style.transition = 'none';
    fill.style.width      = w;
  }
  if (isVid) vid.pause();
}

function _storyResume() {
  if (!_storyMode || !_storyPaused || !_storySlideCtx) return;
  _storyPaused = false;
  const { isVid, vid, fill } = _storySlideCtx;
  let ms = _storyRemainMs;
  if (isVid) {
    // Sync bar and timer to the actual playback position when known; the
    // timer keeps the metadata path's 5 s pad since ended drives the advance
    if (isFinite(vid.duration) && vid.duration > 0) {
      const left = Math.max(0, vid.duration - vid.currentTime);
      if (fill) {
        void fill.offsetWidth;
        fill.style.transition = `width ${left}s linear`;
        fill.style.width      = '100%';
      }
      ms = (left + 5) * 1000;
    }
    vid.play().catch(() => {});
  } else if (fill) {
    void fill.offsetWidth;
    fill.style.transition = `width ${ms / 1000}s linear`;
    fill.style.width      = '100%';
  }
  _storyArm(ms);
}

function _storyAdvance() {
  _storyClearTimer();
  if (_mvIdx >= _mvSlides.length - 1) closeMediaViewer();
  else _mvShowSlide(_mvIdx + 1);
}

function _storyBeginSlide(idx, isVid, vid) {
  _storyClearTimer();
  _storyPaused = false;
  const fills = document.querySelectorAll('#storyProgress .story-progress-fill');
  fills.forEach((f, i) => {
    f.style.transition = 'none';
    f.style.width      = i < idx ? '100%' : '0';
  });
  const fill = fills[idx];
  _storySlideCtx = { isVid, vid, fill };
  const run  = secs => {
    if (fill) {
      void fill.offsetWidth;  // land the reset width before the animated one
      fill.style.transition = `width ${secs}s linear`;
      fill.style.width      = '100%';
    }
    _storyArm(secs * 1000);
  };
  if (!isVid) { run(_STORY_IMAGE_SECS); return; }
  // Video slides: the bar tracks the video duration and advance follows the
  // ended event; a video that errors advances instead of stalling the story
  vid.onended = () => { if (_storyMode) _storyAdvance(); };
  vid.onerror = () => {
    if (!_storyMode) return;
    // Verbose diagnostics: the MediaError says how playback failed, the HEAD
    // probe says what the server actually returned (404 = row without file,
    // 200 video/* = file exists but does not decode, other content-type =
    // wrong bytes served). Full detail in the console and behind Details.
    const slide = _mvSlides[_mvIdx];
    const url   = vid.currentSrc || (typeof slide === 'string' ? slide : slide?.url) || '';
    const me    = vid.error;
    const CODES = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    const base  = [
      `Story video failed to play (slide ${_mvIdx + 1}/${_mvSlides.length}).`,
      `URL: ${url}`,
      `MediaError: ${me ? `code ${me.code} ${CODES[me.code] || '?'}${me.message ? ` (${me.message})` : ''}` : 'none reported'}`,
      `networkState=${vid.networkState} readyState=${vid.readyState}`,
    ];
    fetch(url, { method: 'HEAD' }).then(
      r => base.push(`HTTP HEAD: ${r.status}, content-type ${r.headers.get('content-type') || '?'}, ${r.headers.get('content-length') || '?'} bytes`),
      e => base.push(`HTTP HEAD failed: ${e}`),
    ).finally(() => {
      const detail = base.join('\n');
      console.error('[story]', detail);
      showToast('A story video failed to play; skipping it.', {
        type: 'warning',
        duration: 8000,
        action: { label: 'Details', onclick: () => openErrorModal(detail) },
      });
    });
    _storyAdvance();
  };
  vid.onloadedmetadata = () => {
    if (!_storyMode || _storyPaused) return;
    const secs = (isFinite(vid.duration) && vid.duration > 0) ? vid.duration : 30;
    if (fill) {
      fill.style.transition = `width ${secs}s linear`;
      fill.style.width      = '100%';
    }
    // Fallback in case ended never fires (stalled stream)
    _storyArm((secs + 5) * 1000);
  };
  // Until metadata arrives (or if it never does), do not stall forever
  _storyArm(15 * 1000);
}

function _mvShowSlide(idx) {
  _mvIdx = idx;
  const slide = _mvSlides[idx];
  const url   = typeof slide === 'string' ? slide : slide.url;
  const isVid = typeof slide !== 'string' && slide.type === 'video';
  const img   = document.getElementById('mvImg');
  const vid   = document.getElementById('mvVid');
  // Detach the previous slide's handlers BEFORE touching src: unloading via
  // src = '' (and replacing a loading src) fires error/abort events, which
  // used to hit the old slide's onerror and phantom-skip photo slides with a
  // spurious "failed to play" warning. closeMediaViewer does the same dance.
  vid.onended = vid.onerror = vid.onloadedmetadata = null;
  vid.pause();
  if (isVid) {
    img.style.display = 'none';
    img.src = '';
    vid.style.display = '';
    vid.muted = _mvMuted;
    vid.src = url;
    vid.play().catch(() => {});
  } else {
    vid.style.display = 'none';
    vid.src = '';
    img.style.display = '';
    img.src = url;
  }
  document.getElementById('mvSeek').value = '0';
  document.getElementById('mvCounter').textContent =
    (!_storyMode && _mvSlides.length > 1) ? `${idx + 1} / ${_mvSlides.length}` : '';
  document.getElementById('mvPrev').disabled = idx === 0;
  document.getElementById('mvNext').disabled = idx === _mvSlides.length - 1;
  // Link-out button follows the slide: enabled only when the slide carries
  // the post's original URL (deleted posts and stories never do).
  const linkBtn = document.getElementById('mvLinkBtn');
  if (linkBtn) linkBtn.disabled = !(typeof slide !== 'string' && slide.link);
  if (_storyMode) _storyBeginSlide(idx, isVid, vid);
  _mvSync();
}

function mvStep(dir) {
  const next = _mvIdx + dir;
  if (next < 0) {
    // Tapping back on the first story slide restarts it from the beginning
    if (_storyMode) _mvShowSlide(0);
    return;
  }
  if (next >= _mvSlides.length) {
    // Tapping forward on the last story slide closes, like the platforms do
    if (_storyMode) closeMediaViewer();
    return;
  }
  _mvShowSlide(next);
}

function closeMediaViewer() {
  _dlgClose('mvModal');
}

// Full viewer teardown, run from the mvModal close listener (every close
// path: close button, backdrop click, native Escape)
function _mvTeardown() {
  _storyClearTimer();
  const vid = document.getElementById('mvVid');
  vid.onended = vid.onerror = vid.onloadedmetadata = null;
  vid.pause();
  vid.src = '';
  vid.muted = _mvMuted = false;
  _storyPaused   = false;
  _storySlideCtx = null;
  if (_storyMode) {
    _storyMode = false;
    document.getElementById('mvModal').classList.remove('story-mode');
    const bar = document.getElementById('storyProgress');
    bar.innerHTML = '';
    bar.style.display = 'none';
  }
  for (const id of ['mvPlayBtn', 'mvMuteBtn', 'mvSeek', 'mvSpinner'])
    document.getElementById(id).style.display = 'none';
  // Clear the flash: a leftover .on replays its animation when the modal next
  // returns from display:none, which looked like a phantom pause on open
  const flash = document.getElementById('mvFlash');
  flash.classList.remove('on');
  flash.innerHTML = '';
  document.getElementById('mvModal').classList.remove('mv-single');
  document.getElementById('mvImg').src = '';
  _mvSlides = [];
  _mvIdx    = 0;
}

// ── Global overlay keyboard handling ──────────────────────────────────────────
// Media viewer arrow keys only. Escape is the native <dialog> cancel on every
// overlay, and the top layer orders stacked overlays, so the old Escape
// priority chain is gone.

document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!_dlgIsOpen('mvModal') || _dlgIsOpen('confirmModal') || _dlgIsOpen('errorModal')) return;
  mvStep(e.key === 'ArrowLeft' ? -1 : 1);
});

// ── Shared icons and badges ───────────────────────────────────────────────────

// UI chrome icons target the same rendered stroke (~1.3px at rest size):
// stroke-width = 1.3 * viewBox / display size. The .ic class sizes and
// block-aligns them; media overlay badges are a separate, heavier family.
function _starIcon(filled) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M12 2.5l3.09 6.26L22 9.77l-5 4.87 1.18 6.88L12 18.27l-6.18 3.25L7 14.64 2 9.77l6.91-1.01z"/></svg>`;
}
const _xIcon    = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const _dotsIcon = `<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;

const _dlIcon         = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12L12 16M12 16L16 12M12 16V4M4 20H20"/></svg>`;
const _linkIcon       = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

// Link-out button for a post row: opens the post's original URL in a new tab.
// A null url (deleted post, or the source row was not resolvable) renders the
// same button greyed out and inert.
function _videoLinkBtn(url) {
  if (url) {
    return `<a class="play-btn" href="${esc(url)}" target="_blank" rel="noopener"
             onclick="event.stopPropagation()" title="Open original post">${_linkIcon}</a>`;
  }
  return `<span class="play-btn disabled" title="Deleted; no live URL"
           onclick="event.stopPropagation()">${_linkIcon}</span>`;
}
const _refreshIcon    = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12C21 16.9706 16.9706 21 12 21C9.69494 21 7.59227 20.1334 6 18.7083L3 16M3 12C3 7.02944 7.02944 3 12 3C14.3051 3 16.4077 3.86656 18 5.29168L21 8M3 21V16M3 16H8M21 3V8M21 8H16"/></svg>`;
const _imgPreviewIcon = `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><g transform="translate(-124,-1319)" fill="currentColor" fill-rule="evenodd"><path d="M136,1329.07849 C136,1328.52795 136.448,1328.08114 137,1328.08114 C137.552,1328.08114 138,1328.52795 138,1329.07849 C138,1329.62903 137.552,1330.07585 137,1330.07585 C136.448,1330.07585 136,1329.62903 136,1329.07849 L136,1329.07849 Z M136.75,1332.0187 L140,1335.95527 L128,1335.95527 L132.518,1330.02399 L135.354,1334.06528 L136.75,1332.0187 Z M128,1325.9817 L128,1323.98699 C128,1323.43644 128.448,1322.98963 129,1322.98963 L133,1322.98963 C133.552,1322.98963 134,1323.43644 134,1323.98699 L134,1325.9817 C134,1326.53324 133.552,1326.97906 133,1326.97906 L129,1326.97906 C128.448,1326.97906 128,1326.53324 128,1325.9817 L128,1325.9817 Z M142,1336.05999 C142,1336.61053 141.552,1336.95263 141,1336.95263 L127,1336.95263 C126.448,1336.95263 126,1336.61053 126,1336.05999 L126,1322.09699 C126,1321.54645 126.448,1320.99491 127,1320.99491 L136,1320.99491 L136,1325.08906 C136,1326.19015 136.895,1326.97906 138,1326.97906 L142,1326.97906 L142,1336.05999 Z M143.707,1324.77091 L138.293,1319.34429 C138.105,1319.15778 137.851,1319.0002 137.586,1319.0002 L126,1319.0002 L126,1319.05306 C124.895,1319.05306 124,1319.97163 124,1321.07371 L124,1321.09964 L124,1337.05735 C124,1338.15843 124.895,1339.0002 126,1339.0002 L126,1338.94734 L142,1338.94734 L142,1339.0002 C143.105,1339.0002 144,1338.1325 144,1337.03142 L144,1325.50197 C144,1325.23767 143.895,1324.95741 143.707,1324.77091 L143.707,1324.77091 Z"/></g></svg>`;
const _listViewIcon   = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="4" y1="3.5" x2="12" y2="3.5"/><line x1="4" y1="6.5" x2="12" y2="6.5"/><line x1="4" y1="9.5" x2="12" y2="9.5"/><circle cx="1.5" cy="3.5" r=".8" fill="currentColor" stroke="none"/><circle cx="1.5" cy="6.5" r=".8" fill="currentColor" stroke="none"/><circle cx="1.5" cy="9.5" r=".8" fill="currentColor" stroke="none"/></svg>`;
const _gridViewIcon   = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x=".75" y=".75" width="4.5" height="4.5" rx=".5"/><rect x="7.75" y=".75" width="4.5" height="4.5" rx=".5"/><rect x=".75" y="7.75" width="4.5" height="4.5" rx=".5"/><rect x="7.75" y="7.75" width="4.5" height="4.5" rx=".5"/></svg>`;
const _badgeStyle     = `position:absolute;bottom:4px;right:4px;color:#fff;pointer-events:none;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))`;
const _playBadge      = `<span style="${_badgeStyle}"><svg width="18" height="18" viewBox="0 0 9 9" fill="currentColor"><polygon points="1.5,0.5 8.5,4.5 1.5,8.5"/></svg></span>`;
const _photoBadge = `<span style="${_badgeStyle}"><svg width="18" height="18" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x=".75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y=".75" width="4.5" height="4.5" rx=".75"/><rect x=".75" y="7.75" width="4.5" height="4.5" rx=".75"/><rect x="7.75" y="7.75" width="4.5" height="4.5" rx=".75"/></svg></span>`;
const _imageBadge = `<span style="${_badgeStyle}"><svg width="18" height="18" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x=".75" y=".75" width="11.5" height="11.5" rx="1.5"/><circle cx="4.4" cy="4.4" r="1" fill="currentColor" stroke="none"/><path d="M1.5 9.75 L4.75 6.75 L7 9 L8.75 7.25 L11.5 10"/></svg></span>`;

// ── Modal engine ──────────────────────────────────────────────────────────────

const _STATUS_FILTER_KEY = { up: 'active', deleted: 'deleted', undeleted: 'restored' };

function _mFiltered(cfg, skipSearch = false) {
  let vids = cfg.st.videos;
  if (cfg.st.filter.size)     vids = vids.filter(v => cfg.st.filter.has(_STATUS_FILTER_KEY[v.status]));
  if (cfg.st.typeFilter.size) vids = vids.filter(v => cfg.st.typeFilter.has(v.type));
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

// Shared detail-modal shell: one markup source for the engine's creator modal
// and the TikTok sound modal, so structure and classes (creator-modal styling,
// the mobile filter host, the back-to-top button) can never drift apart.
// `base` prefixes every element id (base 'ttModal' gives ttModalBackdrop,
// ttModalHeader, ...); opts slot in the platform extras.
function _modalShellHtml(base, closeFn, { bannerHtml = '', panelsHtml = '', afterHtml = '', scrollTopFn = null } = {}) {
  return `
<dialog id="${base}Backdrop" class="modal-backdrop" onclick="if(event.target===this)${closeFn}()">
  <div class="modal modal-base creator-modal" id="${base}Base">
    <button class="modal-close" onclick="${closeFn}()" aria-label="Close"></button>
    ${bannerHtml}
    <div class="modal-header"     id="${base}Header"></div>
    <div class="modal-toolbar"    id="${base}Toolbar"></div>
    <div class="m-filters"        id="${base}Filters" style="display:none"></div>
    ${panelsHtml}
    <div class="modal-video-list" id="${base}VideoList"></div>
    ${scrollTopFn ? `<button class="back-to-top modal-top" id="${base}Top" style="display:none" onclick="${scrollTopFn}()" title="Back to top">↑</button>` : ''}
  </div>
  ${afterHtml}
</dialog>`;
}

// Back-to-top visibility plus the mobile filter row's quick-return behavior
// (hide on scroll down once the toolbar is pinned, reveal on scroll up),
// shared by every modal built on _modalShellHtml.
function _modalShellScrollWiring(base) {
  const mb = document.getElementById(`${base}Base`);
  if (!mb) return;
  const top = document.getElementById(`${base}Top`);
  const tabsHost = document.getElementById(`${base}Toolbar`);
  const filt = document.getElementById(`${base}Filters`);
  let lastY = 0;
  mb.addEventListener('scroll', () => {
    const y = mb.scrollTop;
    if (top) top.style.display = y > 200 ? 'flex' : 'none';
    if (filt && _mIsMobile()) {
      const tabs = tabsHost && tabsHost.querySelector('.m-tabs');
      const pinned = tabs && tabs.getBoundingClientRect().top <= mb.getBoundingClientRect().top + 1;
      if (!pinned || y < lastY - 6) filt.classList.remove('filters-hidden');
      else if (y > lastY + 6) filt.classList.add('filters-hidden');
    }
    lastY = y;
  }, { passive: true });
}

// Media views show the post list with search/filters; History, Stories, and
// Stats are the non-media panel views. One predicate so a new panel view only
// needs adding here.
function _mIsMediaView(view) {
  return view !== 'history' && view !== 'stories' && view !== 'stats';
}

// ── Profile stats graphs (the modal's Stats view) ───────────────────────────
// Small-multiple line charts over the daily snapshots from /stats-history,
// one single-series chart per metric (the card title carries identity, so no
// legend), drawn with the vendored uPlot and themed from the CSS variables at
// render time. Metrics a platform never reports (all-null column) are skipped.

const _STAT_METRICS = [
  { field: 'subscriber_count', label: 'Followers' },
  { field: 'following_count',  label: 'Following' },
  { field: 'video_count',      label: 'Posts on platform' },
  { field: 'saved_count',      label: 'Posts saved' },
];

// canvas needs a resolved color; derive a translucent area fill from a hex accent
function _hexFade(hex, alpha) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

function _renderStatsCharts(host, rows) {
  host.innerHTML = '';
  if (!rows || rows.length < 2) {
    host.innerHTML = `<div class="vlist-empty">${rows && rows.length === 1
      ? 'First snapshot recorded. Graphs appear from the second day of data.'
      : 'No stats recorded yet. A snapshot is stored on every profile check, one per day.'}</div>`;
    return [];
  }
  const css    = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const muted  = css.getPropertyValue('--muted').trim();
  const border = css.getPropertyValue('--border').trim();
  // The app font lives on body, not :root; the root's computed font is the
  // browser's serif default, which uPlot would paint onto the axis labels
  const font   = '11px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
  const xs     = rows.map(r => r.ts);
  const charts = [];
  for (const m of _STAT_METRICS) {
    const ys = rows.map(r => r[m.field]);
    if (!ys.some(v => v != null)) continue;
    const nonNull = ys.filter(v => v != null);
    const cur     = nonNull[nonNull.length - 1];
    const prev    = nonNull.length > 1 ? nonNull[nonNull.length - 2] : null;
    const delta   = prev != null ? cur - prev : null;
    const deltaHtml = delta
      ? `<span class="stat-chart-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta.toLocaleString()}</span>`
      : '';
    const card = document.createElement('div');
    card.className = 'stat-chart-card';
    card.innerHTML = `
      <div class="stat-chart-hdr">
        <span class="stat-chart-title">${m.label}</span>
        <span class="stat-chart-cur">${_fmtLarge(cur)}</span>${deltaHtml}
      </div>
      <div class="stat-chart-plot"></div>`;
    host.appendChild(card);
    const plotEl = card.querySelector('.stat-chart-plot');
    charts.push(new uPlot({
      width:  Math.max(plotEl.clientWidth, 240),
      height: 130,
      series: [
        {},
        { label: m.label, stroke: accent, width: 2,
          fill: _hexFade(accent, 0.08) || undefined,
          points: { show: rows.length <= 30, size: 5 }, spanGaps: true },
      ],
      axes: [
        { stroke: muted, font, grid: { show: false }, ticks: { show: false } },
        { stroke: muted, font, size: 52, ticks: { show: false },
          grid: { stroke: _hexFade(border.startsWith('#') ? border : '#333a45', 0.5) || border, width: 1 },
          values: (u, vals) => vals.map(v => _fmtLarge(v)) },
      ],
      cursor: { y: false, points: { size: 7 } },
      scales: { x: { time: true } },
    }, [xs, ys], plotEl));
  }
  return charts;
}

function _mRenderToolbar(cfg, vids) {
  if (cfg.mobileToolbar && _mIsMobile()) { _mRenderToolbarMobile(cfg, vids); return; }
  const _fh = cfg.filtersHostId && document.getElementById(cfg.filtersHostId);
  if (_fh) { _fh.innerHTML = ''; _fh.style.display = 'none'; }  // desktop: no separate filter row
  const counts     = { all: 0, active: 0, deleted: 0, restored: 0 };
  const typeCounts = { video: 0, photo: 0 };
  vids.forEach(v => {
    counts.all++;
    if      (v.status === 'up')        counts.active++;
    else if (v.status === 'deleted')   counts.deleted++;
    else if (v.status === 'undeleted') counts.restored++;
    if      (v.type === 'video') typeCounts.video++;
    else if (v.type === 'photo') typeCounts.photo++;
  });
  const hasMultipleTypes = typeCounts.video > 0 && typeCounts.photo > 0;
  const pill     = (key, label) => _pill(key, label, cfg.st.filter,     cfg.filterFn,     counts);
  const typePill = (key, label) => _typePill(key, label, cfg.st.typeFilter, cfg.typeFilterFn);
  // History, Stories, and Stats are non-media views: they hide the post
  // search/filters and (History) swap in their own field filters via
  // cfg.contextFilters, which sits in the same context-filter area of the nav
  // bar as the post filters.
  const isMedia = _mIsMediaView(cfg.st.view);
  // History keeps the search box (it filters the change entries); Stories has
  // no search. Non-media count labels ("n changes", "n stories") come from the
  // cfg.viewCount hook since their data lives with the platform code.
  const searchable = isMedia || cfg.st.view === 'history';
  const shown = _mFiltered(cfg).length;
  const total = _mFiltered(cfg, true).length;
  const countLabel = isMedia
    ? _mCountLabel(cfg)
    : (cfg.viewCount ? cfg.viewCount(cfg.st.view) || '' : '');
  const toolbar = document.getElementById(cfg.toolbarElId);
  const searchWasFocused = cfg.hasSearch && searchable &&
    document.activeElement === toolbar.querySelector('#modalVideoSearch');
  const searchSelEnd = searchWasFocused ? document.activeElement.selectionEnd : 0;
  const viewKeys = (typeof cfg.viewKeys === 'function' ? cfg.viewKeys() : cfg.viewKeys) || [
    { key: 'list', icon: _listViewIcon, title: 'List view' },
    { key: 'grid', icon: _gridViewIcon, title: 'Grid view' },
  ];
  // Left-aligned underline tab header (opt-in via cfg.desktopTabs), mirroring the
  // mobile .m-tabs bar but not stretched full-width. Reuses the shared .tab style.
  // Modals without the flag (sound modal) keep the inline icon-pill view toggle.
  const useTabs = !!(cfg.desktopTabs && cfg.hasViewToggle);
  toolbar.classList.toggle('has-tab-bar', useTabs);
  let html = '';
  if (useTabs) {
    html += `<div class="modal-tab-bar">`
      + viewKeys.map(vk =>
          `<button class="tab${cfg.st.view === vk.key ? ' active' : ''}" onclick="${cfg.viewFn}('${vk.key}')" title="${vk.title}">${vk.label || (vk.title || '').replace(/ view$/, '') || vk.key}</button>`
        ).join('')
      + `</div><div class="modal-toolbar-controls">`;
  }
  html += `<div class="toolbar-main-row">`;
  if (cfg.hasViewToggle && !useTabs) {
    html += `<div class="filter-pills">`
      + viewKeys.map(vk =>
          `<button class="filter-pill${cfg.st.view === vk.key ? ' active' : ''}" data-view-key="${vk.key}" onclick="${cfg.viewFn}('${vk.key}')" title="${vk.title}">${vk.icon}</button>`
        ).join('')
      + `</div>`;
  }
  if (countLabel) html += `<span class="modal-vid-count">${countLabel}</span>`;
  if (cfg.hasSearch && searchable) {
    html += `<input id="modalVideoSearch" class="modal-video-search" type="search" value="${esc(cfg.st.search)}" placeholder="Search ${isMedia ? (cfg.itemNounPlural || 'posts') : 'history'}…" oninput="${cfg.searchFn}(this.value)">`;
  }
  html += `</div>`
    + `<div class="toolbar-filter-wrap">`;
  if (isMedia && cfg.mSortFn) {
    // Modals that wired up the mobile filter functions (creator modal) use the
    // same Sort/Status/Type dropdowns on desktop; others (sound modal) keep pills.
    html += _mFilterDds(cfg, counts, typeCounts);
  } else if (isMedia) {
    html += `<div class="filter-pills multi">`
      + pill('active', 'Active')
      + (counts.deleted  ? pill('deleted',  'Deleted')  : '')
      + (counts.restored ? pill('restored', 'Restored') : '')
      + `</div>`
      + (hasMultipleTypes
          ? `<div class="filter-pills multi">`
            + typePill('video', `Videos (${typeCounts.video.toLocaleString()})`)
            + typePill('photo', `Photos (${typeCounts.photo.toLocaleString()})`)
            + `</div>`
          : '');
  } else if (cfg.contextFilters) {
    html += cfg.contextFilters(cfg.st.view);
  }
  html += `</div>`;
  if (useTabs) html += `</div>`;  // close .modal-toolbar-controls
  toolbar.innerHTML = html;
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  if (searchWasFocused) {
    const el = toolbar.querySelector('#modalVideoSearch');
    if (el) { el.focus(); el.setSelectionRange(searchSelEnd, searchSelEnd); }
  }
  _mEnsureToolbarFade(toolbar);
}

// ── Mobile creator-modal toolbar: text tabs + filter/sort dropdowns ──
// Single-select Status/Type/Sort dropdowns drive the same st.filter/typeFilter/
// sort the desktop toolbar uses; History delegates to cfg.mobileFilters.
function _mDd(label, menu) {
  return `<div class="m-dd"><button class="m-dd-btn" aria-haspopup="listbox" aria-expanded="false" onclick="_mDdToggle(this)">${label} <span class="m-dd-caret">▾</span></button><div class="m-dd-menu" popover>${menu}</div></div>`;
}
function _mDdToggle(btn) {
  const dd = btn.parentNode;
  const menu = dd instanceof Element && dd.querySelector('.m-dd-menu');
  if (menu) _menuOpenAt(btn, menu);
}
// A fixed menu does not track its button, so close on any scroll (capture, to
// catch nested scroll containers like the settings modal body). Ignore scrolls
// originating inside the menu itself so a long menu stays scrollable.
// Outside clicks and Escape are the popover's native light dismiss.
window.addEventListener('scroll', e => {
  if (e.target instanceof Element && e.target.closest('.dd-menu, .m-dd-menu')) return;
  _ddCloseAll();
}, true);
function _mMobSort(cfg, field)  { cfg.st.sort = _doSort(cfg.st.sort, field); _mRenderToolbar(cfg, cfg.st.videos); _mRenderList(cfg); }
function _mMobStatus(cfg, key)  { cfg.st.filter     = key ? new Set([key]) : new Set(); _mRenderToolbar(cfg, cfg.st.videos); _mRenderList(cfg); }
function _mMobType(cfg, key)    { cfg.st.typeFilter = key ? new Set([key]) : new Set(); _mRenderToolbar(cfg, cfg.st.videos); _mRenderList(cfg); }

// Sort / Status / Type single-select dropdowns, shared by the mobile toolbar and
// the desktop modal toolbar. Driven by cfg.mSortFn / mStatusFn / mTypeFn.
function _mFilterDds(cfg, counts, typeCounts) {
  const sortCols = (cfg.cols || []).filter(c => c.field && c.field !== 'status');
  const sf = sortCols.find(c => c.field === cfg.st.sort.field);
  const arrow = cfg.st.sort.dir === 'asc' ? '↑' : '↓';
  const sortMenu = sortCols.map(c =>
    `<button class="m-dd-opt${c.field === cfg.st.sort.field ? ' active' : ''}" onclick="${cfg.mSortFn}('${c.field}')">${c.label}<span>${c.field === cfg.st.sort.field ? arrow : ''}</span></button>`).join('');
  let out = _mDd(sf ? `${sf.label} ${arrow}` : 'Sort', sortMenu);
  const statusOpts = [{ k: '', l: 'All' }, { k: 'active', l: 'Active' }];
  if (counts.deleted)  statusOpts.push({ k: 'deleted',  l: 'Deleted' });
  if (counts.restored) statusOpts.push({ k: 'restored', l: 'Restored' });
  const curS = statusOpts.find(o => o.k && cfg.st.filter.has(o.k)) || statusOpts[0];
  const statusMenu = statusOpts.map(o =>
    `<button class="m-dd-opt${o === curS ? ' active' : ''}" onclick="${cfg.mStatusFn}('${o.k}')">${o.l}<span>${o === curS ? '✓' : ''}</span></button>`).join('');
  out += _mDd(curS.k ? curS.l : 'Status', statusMenu);
  if (typeCounts.video > 0 && typeCounts.photo > 0) {
    const typeOpts = [{ k: '', l: 'All' }, { k: 'video', l: 'Videos' }, { k: 'photo', l: 'Photos' }];
    const curT = typeOpts.find(o => o.k && cfg.st.typeFilter.has(o.k)) || typeOpts[0];
    const typeMenu = typeOpts.map(o =>
      `<button class="m-dd-opt${o === curT ? ' active' : ''}" onclick="${cfg.mTypeFn}('${o.k}')">${o.l}<span>${o === curT ? '✓' : ''}</span></button>`).join('');
    out += _mDd(curT.k ? curT.l : 'Type', typeMenu);
  }
  return out;
}

function _mRenderToolbarMobile(cfg, vids) {
  const counts = { active: 0, deleted: 0, restored: 0 };
  const typeCounts = { video: 0, photo: 0 };
  vids.forEach(v => {
    if      (v.status === 'up')        counts.active++;
    else if (v.status === 'deleted')   counts.deleted++;
    else if (v.status === 'undeleted') counts.restored++;
    if      (v.type === 'video') typeCounts.video++;
    else if (v.type === 'photo') typeCounts.photo++;
  });
  const toolbar = document.getElementById(cfg.toolbarElId);
  toolbar.classList.remove('filters-hidden');  // always reveal on a fresh render
  toolbar.classList.remove('has-tab-bar');      // desktop-only layout class
  const viewKeys = (typeof cfg.viewKeys === 'function' ? cfg.viewKeys() : cfg.viewKeys) || [];
  const tabs = viewKeys.map(vk =>
    `<button class="tab${cfg.st.view === vk.key ? ' active' : ''}" onclick="${cfg.viewFn}('${vk.key}')">${vk.label || (vk.title || '').replace(/ view$/, '') || vk.key}</button>`).join('');
  const isMedia = _mIsMediaView(cfg.st.view);
  let filters = '';
  if (isMedia) filters = _mFilterDds(cfg, counts, typeCounts);
  else if (cfg.mobileFilters) filters = cfg.mobileFilters(cfg.st.view);
  toolbar.innerHTML = `<div class="m-tabs">${tabs}</div>`;
  // Filter row lives in its own element in the scroll flow (a sibling after the
  // toolbar), so its slot scrolls away naturally and hiding it never shifts the
  // list or leaves a blank gap.
  const fh = cfg.filtersHostId && document.getElementById(cfg.filtersHostId);
  if (fh) {
    fh.classList.remove('filters-hidden');
    fh.innerHTML = filters;
    fh.style.display = filters ? 'flex' : 'none';
  }
}

function _mSetFilter(cfg, key) {
  cfg.st.filter.has(key) ? cfg.st.filter.delete(key) : cfg.st.filter.add(key);
  const toolbar = document.getElementById(cfg.toolbarElId);
  toolbar.querySelectorAll('[data-filter-key]').forEach(btn => {
    btn.classList.toggle('active', cfg.st.filter.has(btn.dataset.filterKey));
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  const shown = _mFiltered(cfg).length;
  const total = _mFiltered(cfg, true).length;
  const countEl = toolbar.querySelector('.modal-vid-count');
  if (countEl) countEl.textContent = _mCountLabel(cfg);
  const toggleBtn = toolbar.querySelector('.toolbar-toggle');
  if (toggleBtn) {
    const hasActive = cfg.st.filter.size > 0 || cfg.st.typeFilter.size > 0;
    toggleBtn.textContent = (cfg.st.toolbarExpanded ? '▲' : '▼') + (hasActive ? ' Filters •' : ' Filters');
  }
  _mRenderList(cfg);
}

// Item-count line for the modal toolbar, in the platform's own noun
function _mCountLabel(cfg) {
  const noun   = cfg.itemNoun || 'post';
  const plural = cfg.itemNounPlural || noun + 's';
  const shown  = _mFiltered(cfg).length;
  const total  = _mFiltered(cfg, true).length;
  return cfg.st.search
    ? `${shown.toLocaleString()} of ${total.toLocaleString()} ${plural}`
    : (shown === 1 ? `1 ${noun}` : `${shown.toLocaleString()} ${plural}`);
}

function _mSetTypeFilter(cfg, key) {
  cfg.st.typeFilter.has(key) ? cfg.st.typeFilter.delete(key) : cfg.st.typeFilter.add(key);
  const toolbar = document.getElementById(cfg.toolbarElId);
  toolbar.querySelectorAll('[data-type-key]').forEach(btn => {
    btn.classList.toggle('active', cfg.st.typeFilter.has(btn.dataset.typeKey));
  });
  toolbar.querySelectorAll('.filter-pills').forEach(_placeGlider);
  const shown = _mFiltered(cfg).length;
  const total = _mFiltered(cfg, true).length;
  const countEl = toolbar.querySelector('.modal-vid-count');
  if (countEl) countEl.textContent = _mCountLabel(cfg);
  const toggleBtn = toolbar.querySelector('.toolbar-toggle');
  if (toggleBtn) {
    const hasActive = cfg.st.filter.size > 0 || cfg.st.typeFilter.size > 0;
    toggleBtn.textContent = (cfg.st.toolbarExpanded ? '▲' : '▼') + (hasActive ? ' Filters •' : ' Filters');
  }
  _mRenderList(cfg);
}

function _mToggleToolbar(cfg) {
  cfg.st.toolbarExpanded = _doToggleToolbar(
    cfg.st.toolbarExpanded, cfg.toolbarElId,
    () => cfg.st.filter.size > 0 || cfg.st.typeFilter.size > 0
  );
}

function _mSetSort(cfg, field) {
  cfg.st.sort = _doSort(cfg.st.sort, field);
  const list = document.getElementById(cfg.listElId);
  const sx = list.scrollLeft;
  _mRenderToolbar(cfg, cfg.st.videos);  // keep the Sort dropdown label in sync
  _mRenderList(cfg);
  list.scrollLeft = sx;
}

function _mIsMobile() { return window.matchMedia('(max-width: 640px)').matches; }

function _mRenderColHdrs(cfg) {
  if (cfg.mobileRows && _mIsMobile()) return;  // mobile uses card rows, no column header
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

// preserve: re-render for a live data refresh, keeping the pages the user
// already scrolled in and the scroll position (a plain render resets both;
// that stays the right behavior for filter and sort changes).
function _mRenderList(cfg, { preserve = false } = {}) {
  if (cfg.hasViewToggle && cfg.st.view !== 'list') { _renderModalVideoGrid(cfg, { preserve }); return; }
  const target  = preserve ? Math.max(cfg.st.loaded, cfg.pageSize) : cfg.pageSize;
  cfg.st.loaded = 0;
  if (cfg.st.obs) { cfg.st.obs.disconnect(); cfg.st.obs = null; }
  const list = document.getElementById(cfg.listElId);
  list.innerHTML = '';
  if (!preserve) list.scrollTop = 0;
  _mRenderColHdrs(cfg);
  const vids = _mFiltered(cfg);
  if (!vids.length) {
    list.insertAdjacentHTML('beforeend', `<div class="vlist-empty">${_mEmptyInner(cfg)}</div>`);
    _mWireEmptyClear(cfg, list);
    return;
  }
  _mAppendVideos(cfg, vids, target);
}

function _mAppendVideos(cfg, vids, count) {
  if (cfg.mobileRows && _mIsMobile()) { _mAppendVideosMobile(cfg, vids, count); return; }
  const list     = document.getElementById(cfg.listElId);
  const batch    = vids.slice(cfg.st.loaded, cfg.st.loaded + (count || cfg.pageSize));
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
          ? `<div class="video-desc">${_expandableText(v.description)}</div>`
          : `<div class="video-desc-empty">(no description)</div>`}</div>
      </div>
      ${authorCell}
      <div class="video-cell">
        <span class="vstatus ${statusCls}">${statusLabel}</span>${v.direct_added ? `<span class="vstatus direct" title="Added via direct URL; exempt from deletion checks">Direct</span>` : ''}
      </div>
      <div class="video-cell">${fmtCount(v.view_count)}</div>
      <div class="video-cell">${fmtUpload(v.upload_date)}</div>
      <div class="video-cell">${fmtDateShort(v.download_date)}</div>
      <div class="video-cell">${fmtDateShort(v.deleted_at)}</div>
      <div class="video-cell" style="padding:0;display:flex;align-items:center;justify-content:center;gap:2px">
        ${actionFn ? actionFn(v) : ''}${cfg.videoUrlFn ? _videoLinkBtn(cfg.videoUrlFn(v)) : ''}
      </div>
    </div>`;
  }).join('');
  list.insertAdjacentHTML('beforeend', html);
  _markXtextClipped(list);
  if (cfg.st.loaded < vids.length) {
    cfg.st.obs = _attachSentinel(list, () => {
      cfg.st.obs = null;
      _mAppendVideos(cfg, vids);
    });
  }
}

// YouTube-style mobile list rows: big thumbnail, 2-line title, one metadata line.
// Trimmed vs the desktop table; status shows only when not Active. Reuses the
// grid's cfg hooks (gridThumbSrc / typeIconFn / gridCellOnclick) so it stays
// platform-driven.
function _mAppendVideosMobile(cfg, vids, count) {
  const list  = document.getElementById(cfg.listElId);
  const batch = vids.slice(cfg.st.loaded, cfg.st.loaded + (count || cfg.pageSize));
  cfg.st.loaded += batch.length;
  const fmtUpload = cfg.uploadDateFmt || fmtDateShort;
  batch.forEach(v => {
    const { cls, label } = _videoStatus(v);
    const row = document.createElement('div');
    row.className = 'yt-row';
    row.dataset.videoId = v.video_id;
    const badge  = cfg.typeIconFn ? cfg.typeIconFn(v) : '';
    const thumb  = cfg.gridThumbSrc ? cfg.gridThumbSrc(v) : '';
    const status = cls !== 'up' ? `<span class="vstatus ${cls}">${label}</span>` : '';
    row.innerHTML = `
      <div class="yt-thumb${cls !== 'up' ? ' ' + cls : ''}"><img src="${thumb}" alt="" onerror="this.style.opacity='.15'"><span class="yt-thumb-badge">${badge}</span></div>
      <div class="yt-body">
        <div class="yt-title">${v.description ? _expandableText(v.description) : '<span class="yt-title-empty">(no description)</span>'}</div>
        <div class="yt-meta">${status}<span>${fmtCount(v.view_count)} ${cfg.viewsNoun || 'views'} · ${fmtUpload(v.upload_date)}</span></div>
      </div>
      ${cfg.videoMenuFn ? `<button class="btn-menu yt-row-menu" title="More" onclick="event.stopPropagation();${cfg.videoMenuFn}(this,'${esc(v.video_id)}')">${_dotsIcon}</button>` : ''}`;
    if (cfg.gridCellOnclick) row.onclick = () => cfg.gridCellOnclick(v);
    list.appendChild(row);
  });
  _markXtextClipped(list);
  if (cfg.st.loaded < vids.length) {
    cfg.st.obs = _attachSentinel(list, () => { cfg.st.obs = null; _mAppendVideosMobile(cfg, vids); });
  }
}

// ── Video grid ────────────────────────────────────────────────────────────────

function _renderModalVideoGrid(cfg, { preserve = false } = {}) {
  const target  = preserve ? Math.max(cfg.st.loaded, cfg.pageSize) : cfg.pageSize;
  cfg.st.loaded = 0;
  if (cfg.st.obs) { cfg.st.obs.disconnect(); cfg.st.obs = null; }
  const list = document.getElementById(cfg.listElId);
  list.innerHTML = '';
  if (!preserve) list.scrollTop = 0;
  let vids = _mFiltered(cfg);
  if (cfg.viewVideoFilter) vids = cfg.viewVideoFilter(cfg.st.view, vids);
  if (!vids.length) {
    list.innerHTML = `<div class="vlist-empty">${_mEmptyInner(cfg)}</div>`;
    _mWireEmptyClear(cfg, list);
    return;
  }
  const grid = document.createElement('div');
  const extraClass = cfg.gridClassFn ? cfg.gridClassFn(cfg.st.view) : '';
  grid.className = 'video-grid' + (extraClass ? ' ' + extraClass : '');
  grid.id = cfg.gridId;
  list.appendChild(grid);
  _appendModalGrid(cfg, vids, target);
}

function _appendModalGrid(cfg, vids, count) {
  const list  = document.getElementById(cfg.listElId);
  const grid  = document.getElementById(cfg.gridId);
  if (!grid) return;
  const batch = vids.slice(cfg.st.loaded, cfg.st.loaded + (count || cfg.pageSize));
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
    if (cfg.gridCellOnclick) {
      cell.onclick = () => cfg.gridCellOnclick(v);
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;
    }
    grid.appendChild(cell);
  });
  if (cfg.st.loaded < vids.length) {
    cfg.st.obs = _attachSentinel(list, () => {
      cfg.st.obs = null;
      _appendModalGrid(cfg, vids);
    });
  }
}

// ── Shared creator action helpers ─────────────────────────────────────────────

function _renderStatGrid(gridId, items) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = items.map(it =>
    `<div class="stat-item">
       <span class="stat-value">${esc(it.value)}</span>
       <span class="stat-label">${esc(it.label)}</span>
     </div>`
  ).join('');
}

async function _creatorRun(apiPath, id, getQueue, setQueue, render, mode) {
  const url = mode ? `${apiPath}/${id}/run?mode=${mode}` : `${apiPath}/${id}/run`;
  const { ok, data } = await apiJSON(url, { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not queue run', { type: 'error' }); return; }
  setQueue([...getQueue(), id]);
  render();
}

async function _creatorRunProfile(apiPath, id, getQueue, setQueue, render) {
  const { ok, data } = await apiJSON(`${apiPath}/${id}/run-profile`, { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not queue profile run', { type: 'error' }); return; }
  setQueue([...getQueue(), id]);
  render();
}

async function _creatorRemove(apiPath, id, label, load) {
  // Size the media folder up front so the opt-in warning can quote a real figure.
  const { ok: szOk, data: szData } = await apiJSON(`${apiPath}/${id}/storage`);
  const bytes   = szOk && szData ? (szData.bytes || 0) : 0;
  const sizeStr = _fmtBytes(bytes);

  const res = await openConfirmOption({
    title:        `Delete ${label}?`,
    message:      `This stops tracking and removes ${label} from your list. Downloaded media is kept unless you choose otherwise.`,
    confirmLabel: 'Delete',
    checkboxLabel: 'Also delete downloaded media files',
    checkboxWarn:  `${sizeStr} of downloaded media will be permanently deleted from disk.`,
  });
  if (!res.confirmed) return;

  // A second, unambiguous gate only when media is actually being destroyed.
  if (res.checked) {
    const sure = await openConfirm({
      title:        `Permanently delete ${sizeStr}?`,
      message:      `${label} and its ${sizeStr} of downloaded files will be erased from disk. This cannot be undone.`,
      confirmLabel: "Yes, delete everything",
    });
    if (!sure) return;
  }

  const { ok, data } = await apiJSON(`${apiPath}/${id}${res.checked ? '?delete_media=1' : ''}`, { method: 'DELETE' });
  if (!ok) { showToast(data.error || `Could not delete ${label}`, { type: 'error' }); return; }
  load();
}

// Optimistic toggle, reverted with an error toast if the PATCH fails
async function _creatorToggleStar(apiPath, id, items, idField, render) {
  const item = items.find(x => x[idField] === id);
  if (!item) return;
  const newVal = !item.starred;
  item.starred = newVal ? 1 : 0;
  render();
  const { ok, data } = await apiJSON(`${apiPath}/${id}/star`, { method: 'PATCH', body: JSON.stringify({ starred: newVal }) });
  if (!ok) {
    item.starred = newVal ? 0 : 1;
    render();
    showToast(data.error || 'Could not update star', { type: 'error' });
  }
}

async function _saveCreatorComment(apiPath, id, value, items, idField) {
  const { ok } = await apiJSON(`${apiPath}/${encodeURIComponent(id)}/comment`, {
    method: 'PATCH',
    body: JSON.stringify({ comment: value }),
  });
  if (!ok) return false;
  const item = items.find(x => x[idField] === id);
  if (item) item.comment = value.trim() || null;
  showToast('Saved.', { type: 'success', duration: 2000 });
  return true;
}

// ── Recent date formatting ─────────────────────────────────────────────────────

function _recentDate(ts, now = new Date()) {
  const d        = new Date(ts * 1000);
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dDay     = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - dDay.getTime()) / 86400000);
  const timeStr  = _dtFmtTime.format(d);
  if (diffDays === 0) return `Today, ${timeStr}`;
  if (diffDays === 1) return `Yesterday, ${timeStr}`;
  return _dtFmtRecent.format(d);
}
