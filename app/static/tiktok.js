// TikTok app: config over the shared channel engine (channels.js) plus
// TikTok-only extras: the sounds catalog and sound detail modal, the
// untracked-user modal flow for sound-discovered authors, the sound loop
// panel, stats backfill, cookies, jobs, diagnostics, and DB migration wiring.

// ── Cookie management ─────────────────────────────────────────────────────────
// The static settings markup references these by name (see index.html).

async function loadCookies()        { return _cookiesLoad('tiktok', 'cookie'); }

// Full sign-out: deletes the persistent browser identity and cookies.txt, so
// the next QR sign-in starts as a brand-new device. Also the recovery move
// when the identity is deeply flagged.
async function ttResetSession() {
  if (!await openConfirm({ title: 'Reset the TikTok session?', message: 'This signs out, deletes the browser identity, and requires a new QR sign-in.', confirmLabel: 'Reset session' })) return;
  const { ok, data } = await apiJSON('/api/tiktok/login/session', { method: 'DELETE' });
  showToast((data && (data.message || data.error)) || (ok ? 'Session reset' : 'Reset failed'),
            { type: ok ? 'info' : 'error' });
  loadCookies();
}

// ── QR login ──────────────────────────────────────────────────────────────────
// Signs in inside the persistent browser profile. The backend streams the QR
// page as screenshots and this poll shows them until a terminal state.

let _qrTimer = null;
let _qrLastStatus = null;

async function ttQrStart() {
  const btn = document.getElementById('ttQrBtn');
  btn.disabled = true;
  _qrLastStatus = null;   // a fresh attempt may toast a fresh error
  const { ok, data } = await apiJSON('/api/tiktok/login/qr', { method: 'POST' });
  if (!ok) {
    btn.disabled = false;
    _qrRender({ status: 'error', message: (data && data.error) || 'Could not start QR login' });
    return;
  }
  if (_qrTimer) clearInterval(_qrTimer);
  _qrTimer = setInterval(ttQrPoll, 2000);
  ttQrPoll();
}

async function ttQrPoll() {
  const { ok, data } = await apiJSON('/api/tiktok/login/qr');
  if (ok && data) _qrRender(data);
}

function _qrRender(state) {
  const img    = document.getElementById('ttQrImg');
  const status = document.getElementById('ttQrStatus');
  const labels = {
    starting: 'Opening the browser…',
    waiting:  state.qr ? 'Scan the code with the TikTok app on your phone'
                       : (state.message || 'Loading the login page') + '…',
    success:  'Signed in',         // the full message (cookie count) goes to a toast
    expired:  state.message || 'Login window timed out. Generate a new code to retry',
    error:    'QR login failed',   // the full (often long) error goes to a toast
  };
  const loading = state.status === 'starting' || (state.status === 'waiting' && !state.qr);
  status.style.display = '';
  status.classList.toggle('loading', loading);
  if (loading) status.innerHTML = '<span class="spinner"></span>' + esc(labels[state.status]);
  else status.textContent = labels[state.status] || '';
  status.style.color   = state.status === 'success' ? 'var(--green)'
                       : (state.status === 'error' || state.status === 'expired') ? 'var(--red)' : '';
  img.style.display = state.qr ? '' : 'none';
  if (state.qr) img.src = state.qr;
  if (['success', 'expired', 'error', 'idle'].includes(state.status)) {
    if (_qrTimer) { clearInterval(_qrTimer); _qrTimer = null; }
    document.getElementById('ttQrBtn').disabled = false;
    if (state.status === 'success') loadCookies();
    // An in-flight poll can re-render the terminal state; toast only on the
    // transition into it
    if (_qrLastStatus !== state.status) {
      if (state.status === 'error')   showToast(state.message || 'QR login failed', { type: 'error' });
      if (state.status === 'success') showToast(state.message || 'Signed in', { type: 'success' });
    }
  }
  _qrLastStatus = state.status;
}

// ── Live browser viewer ────────────────────────────────────────────────────────
// Streams JPEG frames of the headed TikTok browser display and forwards mouse
// input to it, so a captcha or verification wall can be solved by hand. The
// display is a fixed 1920x1080 (matches the container Xvfb), so pointer
// coordinates map from the rendered image rect onto that space directly.

const _VIEWER_W = 1920, _VIEWER_H = 1080;
let _viewerOn = false;
let _viewerQueue = [];
let _viewerFlushTimer = null;
let _viewerDown = false;

function ttViewerOpen() {
  const modal = document.getElementById('ttViewer');
  modal.style.display = 'flex';
  _lockScroll();
  _viewerOn = true;
  _viewerNextFrame();
}

function ttViewerClose() {
  _viewerOn = false;
  _viewerDown = false;
  document.getElementById('ttViewer').style.display = 'none';
  _unlockScroll();
}

function _viewerNextFrame() {
  if (!_viewerOn) return;
  const img    = document.getElementById('ttViewerImg');
  const status = document.getElementById('ttViewerStatus');
  const next = new Image();
  next.onload = () => {
    if (!_viewerOn) return;
    img.src = next.src;
    status.textContent = '';
    setTimeout(_viewerNextFrame, 300);
  };
  next.onerror = () => {
    if (!_viewerOn) return;
    status.textContent = 'No live session running. Start a QR login or trigger a check, then it appears here.';
    setTimeout(_viewerNextFrame, 1500);
  };
  next.src = '/api/tiktok/screen?t=' + Date.now();
}

function _viewerCoords(ev) {
  const r = document.getElementById('ttViewerImg').getBoundingClientRect();
  return {
    x: Math.round((ev.clientX - r.left) / r.width  * _VIEWER_W),
    y: Math.round((ev.clientY - r.top)  / r.height * _VIEWER_H),
  };
}

function _viewerFlush() {
  _viewerFlushTimer = null;
  if (!_viewerQueue.length) return;
  const events = _viewerQueue;
  _viewerQueue = [];
  apiJSON('/api/tiktok/screen/input', { method: 'POST', body: JSON.stringify({ events }) });
}

function _viewerSend(type, ev, immediate) {
  const { x, y } = _viewerCoords(ev);
  _viewerQueue.push({ type, x, y });
  if (immediate) { if (_viewerFlushTimer) { clearTimeout(_viewerFlushTimer); } _viewerFlush(); }
  else if (!_viewerFlushTimer) { _viewerFlushTimer = setTimeout(_viewerFlush, 60); }
}

// Wired once the DOM is ready (the viewer img is static markup)
document.addEventListener('DOMContentLoaded', () => {
  const img = document.getElementById('ttViewerImg');
  if (!img) return;
  img.addEventListener('pointerdown', (ev) => { ev.preventDefault(); _viewerDown = true; _viewerSend('down', ev, true); });
  img.addEventListener('pointermove', (ev) => { if (_viewerDown) _viewerSend('move', ev, false); });
  window.addEventListener('pointerup', (ev) => { if (_viewerDown) { _viewerDown = false; _viewerSend('up', ev, true); } });
  // Escape closes the topmost TikTok overlay first (capture, before the
  // shared overlay handlers): the WireGuard parse modal sits above all, then
  // the browser viewer
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const parse = document.getElementById('ttWgParse');
    if (parse && parse.style.display !== 'none') { ev.stopPropagation(); ttWgParseClose(); return; }
    if (_viewerOn) { ev.stopPropagation(); ttViewerClose(); }
  }, true);
});

// ── VPN proxy ─────────────────────────────────────────────────────────────────
// Settings > Network > TikTok: route all TikTok traffic through an HTTP proxy.
// Gluetun mode uses the fixed sidecar address and shows the WireGuard panel;
// custom mode takes any proxy URL. Everything persists in the TikTok settings.

let _ttProxyCustomUrl = '';   // last saved custom URL, restored when leaving gluetun mode
let _ttProxyGluetunUrl = 'http://gluetun:8888';

function _ttHelpToggle(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function _ttProxyApplyMode(mode) {
  const gluetun = mode === 'gluetun';
  const input   = document.getElementById('ttProxyUrl');
  document.getElementById('ttProxyModeGluetun').classList.toggle('active', gluetun);
  document.getElementById('ttProxyModeCustom').classList.toggle('active', !gluetun);
  document.getElementById('ttProxySaveBtn').style.display = gluetun ? 'none' : '';
  document.getElementById('ttWgGroup').style.display      = gluetun ? '' : 'none';
  input.disabled = gluetun;
  input.value    = gluetun ? _ttProxyGluetunUrl : _ttProxyCustomUrl;
}

async function ttProxyLoad() {
  const { ok, data } = await apiJSON('/api/tiktok/proxy');
  if (!ok) return;
  _ttProxyCustomUrl  = data.url || '';
  _ttProxyGluetunUrl = data.gluetun_url || _ttProxyGluetunUrl;
  _ttProxyApplyMode(data.mode);
  document.getElementById('ttProxyEnabled').checked = !!data.enabled;
  ttWgLoad();
}

async function ttProxySetMode(mode) {
  const { ok, data } = await apiJSON('/api/tiktok/proxy', { method: 'PATCH', body: JSON.stringify({ mode }) });
  if (!ok) { showToast((data && data.error) || 'Could not switch the proxy mode', { type: 'error' }); ttProxyLoad(); return; }
  _ttProxyApplyMode(mode);
}

async function ttProxySave() {
  const url = document.getElementById('ttProxyUrl').value.trim();
  const { ok, data } = await apiJSON('/api/tiktok/proxy', { method: 'PATCH', body: JSON.stringify({ url }) });
  if (!ok) { showToast((data && data.error) || 'Could not save the proxy URL', { type: 'error' }); return; }
  _ttProxyCustomUrl = url;
  showToast('Proxy URL saved. Takes effect from the next browser session.', { type: 'success' });
}

async function ttProxyToggle() {
  const box     = document.getElementById('ttProxyEnabled');
  const enabled = box.checked;
  const { ok, data } = await apiJSON('/api/tiktok/proxy', { method: 'PATCH', body: JSON.stringify({ enabled }) });
  if (!ok) {
    box.checked = !enabled;
    showToast((data && data.error) || 'Could not change the VPN state', { type: 'error' });
    return;
  }
  showToast(enabled ? 'VPN on. All TikTok traffic now leaves through the configured proxy, starting with the next browser session.'
                    : 'VPN off. TikTok uses the server\'s own connection.', { type: 'success' });
}

async function ttProxyTest() {
  const btn = document.getElementById('ttProxyTestBtn');
  btn.disabled = true;
  const t = showToast('Testing the connection…', { spinner: true, duration: 0 });
  const { ok, data } = await apiJSON('/api/tiktok/proxy/test', { method: 'POST' });
  btn.disabled = false;
  if (!ok || !data.ok) {
    t.update('Test failed: ' + ((data && data.error) || 'request error'), { type: 'error' });
    return;
  }
  let msg = `Proxy works. Exit IP ${data.proxy_ip}, ${data.latency_ms} ms.`;
  if (data.same_ip) {
    msg += ' Warning: that is the same IP the server has directly, so the proxy is not changing the exit address.';
  } else if (data.direct_ip) {
    msg += ` The server's own IP is ${data.direct_ip}.`;
  }
  t.update(msg, { type: data.same_ip ? 'warning' : 'success', duration: 8000 });
}

// WireGuard config for the gluetun container, managed as four fields; the
// backend composes a clean wg0.conf under the app's data volume, which
// gluetun mounts as /gluetun. "Paste full config" fills the fields from a
// pasted file, discarding comments and IPv6.

const _WG_FIELD_IDS = { private_key: 'ttWgPrivateKey', address: 'ttWgAddress',
                        public_key: 'ttWgPublicKey', endpoint: 'ttWgEndpoint' };
let _ttWgCanRestart = false;   // Docker socket mounted, so the app can restart gluetun itself
const _eyeIcon    = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const _eyeOffIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// Feedback toast for a saved or removed WireGuard config: gluetun only reads
// its config at startup, so the toast carries the restart action when the
// Docker socket makes that possible and stays until acted on or dismissed
function _ttWgSavedToast(msg) {
  if (_ttWgCanRestart) {
    showToast(msg, { type: 'success', duration: 0,
                     action: { label: 'Restart gluetun now', onclick: ttGluetunRestart } });
  } else {
    showToast(msg + ' Restart the gluetun container to apply the change.', { type: 'success', duration: 8000 });
  }
}

async function ttGluetunRestart() {
  const t = showToast('Restarting gluetun…', { spinner: true, duration: 0 });
  const { ok, data } = await apiJSON('/api/tiktok/proxy/gluetun/restart', { method: 'POST' });
  if (!ok) { t.update((data && data.error) || 'Could not restart gluetun', { type: 'error' }); return; }
  t.update('Gluetun restarted. Give it a few seconds to connect, then Test connection shows the new exit IP.', { type: 'success', duration: 8000 });
}

function ttWgToggleKey() {
  const input = document.getElementById('ttWgPrivateKey');
  const eye   = document.getElementById('ttWgKeyEye');
  const show  = input.type === 'password';
  input.type    = show ? 'text' : 'password';
  eye.innerHTML = show ? _eyeOffIcon : _eyeIcon;
  eye.title     = show ? 'Hide the key' : 'Show the key';
}

async function ttWgLoad() {
  const eye = document.getElementById('ttWgKeyEye');
  if (eye && !eye.innerHTML) eye.innerHTML = _eyeIcon;
  const { ok, data } = await apiJSON('/api/tiktok/proxy/wireguard');
  if (!ok) return;
  _ttWgCanRestart = !!data.restart_available;
  const meta = document.getElementById('ttWgMeta');
  document.getElementById('ttWgDeleteBtn').style.display = data.present ? '' : 'none';
  for (const [field, id] of Object.entries(_WG_FIELD_IDS)) {
    document.getElementById(id).value = (data.present && data[field]) || '';
  }
  meta.textContent = data.present
    ? 'Config saved' + (data.updated_at ? ', updated ' + fmtDateShort(data.updated_at) : '')
    : 'No config saved yet. Fill the fields or use Paste full config.';
}

async function ttWgSave() {
  const body = {};
  for (const [field, id] of Object.entries(_WG_FIELD_IDS)) {
    body[field] = document.getElementById(id).value.trim();
  }
  const { ok, data } = await apiJSON('/api/tiktok/proxy/wireguard', { method: 'POST', body: JSON.stringify(body) });
  if (!ok) { showToast((data && data.error) || 'Could not save the config', { type: 'error' }); return; }
  _ttWgSavedToast('WireGuard config saved.');
  ttWgLoad();
}

async function ttWgDelete() {
  if (!await openConfirm({ title: 'Remove WireGuard config?', message: 'Gluetun keeps using it until that container restarts.', confirmLabel: 'Remove' })) return;
  const { ok } = await apiJSON('/api/tiktok/proxy/wireguard', { method: 'DELETE' });
  if (!ok) { showToast('Could not remove the config', { type: 'error' }); return; }
  _ttWgSavedToast('WireGuard config removed.');
  ttWgLoad();
}

// Parse modal: extract the four fields from a pasted WireGuard config

function ttWgParseOpen() {
  document.getElementById('ttWgParse').style.display = 'flex';
  document.getElementById('ttWgParseStatus').style.display = 'none';
  _lockScroll();
  document.getElementById('ttWgParseText').focus();
}

function ttWgParseClose() {
  document.getElementById('ttWgParse').style.display = 'none';
  document.getElementById('ttWgParseText').value = '';
  _unlockScroll();
}

function ttWgParseApply() {
  const text  = document.getElementById('ttWgParseText').value;
  const found = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0].trim();   // comments end the line
    const eq   = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (!val) continue;
    if (key === 'privatekey') found.private_key = val;
    else if (key === 'publickey') found.public_key = val;
    else if (key === 'address') {
      // keep only the IPv4 entries of a comma-separated list
      const v4 = val.split(',').map(a => a.trim()).filter(a => a && !a.includes(':'));
      if (v4.length) found.address = v4.join(', ');
    }
    else if (key === 'endpoint' && !val.startsWith('[')) found.endpoint = val;
  }
  const missing = Object.keys(_WG_FIELD_IDS).filter(f => !found[f]);
  if (missing.length) {
    const el = document.getElementById('ttWgParseStatus');
    el.style.display = '';
    el.textContent   = 'Could not find: ' + missing.map(f => f.replace('_', ' ')).join(', ');
    return;
  }
  for (const [field, id] of Object.entries(_WG_FIELD_IDS)) {
    document.getElementById(id).value = found[field];
  }
  ttWgParseClose();
  showToast('Fields filled from the pasted config. Review them and press Save config.', { type: 'success' });
}

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
      ${_ddHtml('soundSortField', [
        { value: 'label',       label: 'Label' },
        { value: 'video_count', label: 'Saved videos' },
        { value: 'added_at',    label: 'Date added' },
      ], { value: 'label', onchange: "setSoundSortField(_ddValue('soundSortField'))" })}
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
  // Share/short links (vm./vt.tiktok.com, tiktok.com/t/...) hide the real path
  // behind a redirect the browser cannot follow cross-origin; expand them
  // server-side first, then the URL matching below routes the canonical URL.
  if (/^https?:\/\/(?:vm|vt)\.tiktok\.com\/|^https?:\/\/(?:www\.)?tiktok\.com\/t\//.test(val)) {
    const t = showToast('Resolving link…', { spinner: true, duration: 0 });
    const { ok, data } = await apiJSON('/api/tiktok/resolve-url', {
      method: 'POST',
      body: JSON.stringify({ url: val }),
    });
    if (ok && data.url) { val = data.url; t.dismiss(); }
    else { t.update('Could not resolve that TikTok link.', { type: 'error' }); return true; }
  }

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
      t.update(data.error || 'Could not add sound.', { type: 'error' });
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
      t.update(data.error || 'Could not fetch post.', { type: 'error' });
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
  hasStories:        true,
  fieldLabels: {
    username: 'Handle', handle: 'Handle', display_name: 'Display name',
    bio: 'Bio', description: 'Bio', bio_link: 'Bio link', avatar: 'Avatar',
    account_status: 'Account status', privacy_status: 'Privacy',
  },
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
  extraDomainLoaders: { sounds: () => loadSounds() },
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
  _ddSetValue('soundSortField', 'label');
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
  // A search always looks across all sounds, ignoring the filter pills
  if (q) {
    filtered = filtered.filter(s => `${s.label || ''} ${s.sound_id}`.toLowerCase().includes(q));
  } else {
    if (soundFilter.stat.size)           filtered = filtered.filter(s => soundFilter.stat.has(s.tracking_enabled === 0 ? 'inactive' : 'active'));
    if (soundFilter.star.has('starred')) filtered = filtered.filter(s => s.starred);
  }
  const isFiltered = soundFilter.stat.size > 0 || soundFilter.star.size > 0 || !!_soundSearch;
  if (tt.getTrackingView() === 'sounds') {
    const countEl = tt.el('Count');
    if (countEl) countEl.textContent = isFiltered ? `${filtered.length} of ${sounds.length}` : `${sounds.length}`;
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
    const inQueue    = soundRunQueue.includes(s.sound_id);
    const isCurrent  = soundRunCurrent === s.sound_id;
    const runLabel   = isCurrent ? 'Running…' : inQueue ? 'Queued' : 'Run';
    const runDis     = (inQueue || isCurrent) ? 'disabled' : '';
    const { cls: sTrackingCls, label: sTrackingLabel } = _trackingBadge(s.tracking_enabled);
    const isInactive = s.tracking_enabled === 0;

    const stats = _statChip('saved', s.video_count || 0)
      + (s.video_deleted   ? _statChip('deleted', s.video_deleted, 'red') : '')
      + (s.video_undeleted ? _statChip('restored', s.video_undeleted, 'yellow') : '');

    // Same footer shape as the channel card: star + run button(s) + overflow menu.
    // Tracking (a sound-only control) lives in the menu instead of an inline toggle.
    const footer = `<div style="display:flex;gap:6px;">`
      + _starBtn(s.starred, `toggleSoundStar('${esc(s.sound_id)}')`)
      + `<button class="btn-run" ${runDis} onclick="event.stopPropagation();runSound('${esc(s.sound_id)}')">${_refreshIcon} ${runLabel}</button>`
      + `<button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'${isInactive ? 'Enable tracking' : 'Disable tracking'}',onclick:()=>setSoundTracking('${esc(s.sound_id)}',${isInactive})},{label:'Remove',danger:true,onclick:()=>removeSound('${esc(s.sound_id)}')}])">${_dotsIcon}</button>`
      + `</div>`;

    const meta = _cardMeta([
      { label: 'Added',        value: fmtDateOnly(s.added_at) },
      { label: 'Last checked', value: s.last_checked ? fmt.rel(new Date(s.last_checked * 1000).toISOString()) : 'never' },
      { label: 'Last saved',   value: s.last_saved   ? fmt.rel(new Date(s.last_saved   * 1000).toISOString()) : 'never' },
    ]);

    return _cardShell({
      classes:  isInactive ? 'user-card-inactive' : '',
      dataAttr: `data-soundid="${esc(s.sound_id)}"`,
      onclick:  `if(!event.target.closest('button'))openSoundModal('${esc(s.sound_id)}')`,
      icon:     `<div class="sound-icon-wrap"><span class="sound-icon-letter">♫</span></div>`,
      name:     label,
      sub:      esc(s.sound_id),
      badges:   `<span class="account-status ${sTrackingCls}">${sTrackingLabel}</span>`,
      stats,
      footer,
      meta,
    });
  }).join('') + _ghostCards(Math.max(0, 9 - filtered.length));
}

let _soundsSig = null;
async function loadSounds() {
  const { ok, data } = await apiJSON('/api/tiktok/sounds');
  if (!ok) return;
  const sig = JSON.stringify(data);
  if (sig === _soundsSig) return;
  _soundsSig = sig;
  sounds = data;
  renderSounds();
}

async function removeSound(soundId) {
  const s = sounds.find(x => x.sound_id === soundId);
  const label = s ? (s.label || s.sound_id) : soundId;
  if (!await openConfirm({ title: `Remove sound "${label}"?`, message: `${soundId}\n\nVideos already downloaded will not be deleted.`, confirmLabel: 'Remove' })) return;
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
  const newLabel = await openPrompt({ title: 'Edit sound label', value: s?.label || '', placeholder: 'Label for this sound', confirmLabel: 'Save' });
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
  gridId: 'soundVideoGrid',
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
                 background:var(--raised);border:1px solid var(--border);border-radius:6px;
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

  // The /track POST feeds the engine add queue. Rather than poll, ride the live
  // queue snapshots (SSE-pushed on the active tab, poll fallback otherwise) and
  // finish when this handle resolves. A resolved add stays in the queue as
  // status 'ok' -- that is the completion signal, not the entry disappearing
  // (the old poll waited for it to vanish, which never happened, so the spinner
  // hung forever).
  const handle = data.handle;
  let unsub = null;
  const onQueue = async (queue) => {
    const entry = queue[handle];
    if (!entry) return;                                              // not in the snapshot yet
    if (entry.status !== 'ok' && entry.status !== 'error') return;   // still pending
    if (unsub) unsub();
    const ov = document.getElementById('untrackedOverlay');
    if (!ov) return;                                                 // modal was closed
    if (entry.status === 'error') {
      ov.innerHTML = `<div class="modal-untracked-error">${esc(entry.message || 'Tracking failed')}</div>`;
      return;
    }
    await tt.loadCreators();
    const u = tt.getCreators().find(c => c.channel_id === tiktokId);
    if (!u) {
      ov.innerHTML = '<div class="modal-untracked-error">User data not found after tracking.</div>';
      return;
    }
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
  };
  unsub = tt.onQueue(onQueue);
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
  ['accounts', 'schedules', 'network', 'jobs', 'diag', 'database', 'access'].forEach(s => {
    document.getElementById(`ssec-${s}`).style.display    = s === name ? '' : 'none';
    document.getElementById(`snav-${s}`).classList.toggle('active', s === name);
  });
  document.querySelector('.settings-content').classList.toggle('diag-fill', name === 'diag');
  // The global platform selector applies to every section except Access
  const ptabs = document.getElementById('settingsPlatformTabs');
  if (ptabs) ptabs.style.display = name === 'access' ? 'none' : '';
  if (name === 'accounts')  { loadCookies(); twLoadCookies(); igLoadCookies(); }
  if (name === 'network')   { ttProxyLoad(); }  // also refreshes the WireGuard meta
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
  if (!await openConfirm({ title: 'Rewrite all DB paths?', message: `${oldPrefix}  →  ${newPrefix}\n\nA backup is made automatically before changes.`, confirmLabel: 'Rewrite' })) return;
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
  if (!await openConfirm({ title: 'Remove missing-file records?', message: 'Remove all DB records for files that are missing on disk?\nThis cannot be undone.', confirmLabel: 'Remove records' })) return;
  _setFilecheckBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/purge', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); _setFilecheckBtns(false); return; }
  _filecheckWidget.update({ barPct: null, label: 'Purging...' });
  _filecheckReport.hide();
  _startFilecheckPoll();
}

// ── Corrupted story recovery (toast-only; no inline status on the card) ─────
let _storyfixPoll = null;

function _setStoryfixBtns(disabled) {
  document.getElementById('job-storyfix-scan-btn').disabled = disabled;
  document.getElementById('job-storyfix-redl-btn').disabled = disabled;
}

const _nStory = n => `${n} ${n === 1 ? 'story' : 'stories'}`;

function _storyfixPollUntilDone(mode, toast) {
  if (_storyfixPoll) clearInterval(_storyfixPoll);
  _storyfixPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/tiktok/jobs/story-recovery/status');
    if (!ok) return;
    if (data.running) {
      if (mode === 'redownload' && (data.recovered || data.still_failing)) {
        toast.update(`Re-downloading stories… ${data.recovered} done`,
                     { type: 'info', duration: 0, spinner: true });
      }
      return;
    }
    clearInterval(_storyfixPoll); _storyfixPoll = null;
    _setStoryfixBtns(false);

    if (mode === 'scan') {
      const afflicted = (data.corrupt || 0) + (data.missing || 0);
      if (!afflicted) {
        toast.update('No corrupted or missing stories found.', { type: 'success' });
        return;
      }
      const parts = [];
      if (data.live_video) parts.push(`${data.live_video} live video re-downloadable`);
      if (data.live_photo) parts.push(`${data.live_photo} live photo (recovered on next check)`);
      if (data.expired)    parts.push(`${data.expired} expired`);
      toast.update(`${_nStory(afflicted)} corrupted or missing: ${parts.join(', ')}.`,
                   { type: 'warning', duration: 0 });
      return;
    }

    // redownload
    if (data.recovered) {
      toast.update(`${_nStory(data.recovered)} re-downloaded.`, { type: 'success' });
    } else {
      toast.dismiss();
    }
    if (data.purged) showToast(`${_nStory(data.purged)} expired and unrecoverable, removed from the library.`, { type: 'info' });
    if (data.still_failing) showToast(`${_nStory(data.still_failing)} failed to re-download.`, { type: 'error', duration: 0 });
    else if (!data.recovered && !data.purged) {
      const note = data.live_photo
        ? `No video stories to re-download; ${data.live_photo} live photo left for the next check.`
        : 'No corrupted stories to re-download.';
      showToast(note, { type: 'info' });
    }
  }, 1500);
}

async function triggerStoryScan() {
  _setStoryfixBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/story-recovery/scan', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); _setStoryfixBtns(false); return; }
  const toast = showToast('Scanning saved stories…', { spinner: true, duration: 0 });
  _storyfixPollUntilDone('scan', toast);
}

async function triggerStoryRedownload() {
  _setStoryfixBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/story-recovery/redownload', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); _setStoryfixBtns(false); return; }
  const toast = showToast('Re-downloading corrupted stories…', { spinner: true, duration: 0 });
  _storyfixPollUntilDone('redownload', toast);
}

// ── Fix blank thumbnails (toast-only; no inline status on the card) ─────────
let _thumbfixPoll = null;
const _nThumb = n => `${n} ${n === 1 ? 'thumbnail' : 'thumbnails'}`;

async function triggerThumbnailRepair() {
  const btn = document.getElementById('job-thumbfix-btn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/jobs/thumbnail-repair/start', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Failed to start', { type: 'error' }); btn.disabled = false; return; }
  const toast = showToast('Scanning thumbnails…', { spinner: true, duration: 0 });
  if (_thumbfixPoll) clearInterval(_thumbfixPoll);
  _thumbfixPoll = setInterval(async () => {
    const { ok, data } = await apiJSON('/api/tiktok/jobs/thumbnail-repair/status');
    if (!ok) return;
    if (data.running) {
      toast.update(`Fixing thumbnails… ${data.scanned}/${data.total} scanned, ${data.repaired} fixed`,
                   { type: 'info', duration: 0 });
      return;
    }
    clearInterval(_thumbfixPoll); _thumbfixPoll = null;
    btn.disabled = false;
    if (data.repaired) toast.update(`${_nThumb(data.repaired)} fixed.`, { type: 'success' });
    else if (!data.broken) toast.update('No blank thumbnails found.', { type: 'success' });
    else toast.dismiss();
    if (data.failed) showToast(`${_nThumb(data.failed)} could not be rebuilt (source file missing).`,
                               { type: 'error', duration: 0 });
  }, 1500);
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
  const source = _ddValue('diagSource');
  _ddSetOptions('diagAction', _DIAG_ACTIONS[source] || [], { onchange: 'diagActionChanged()' });
  diagActionChanged();
}

function diagActionChanged() {
  const source = _ddValue('diagSource');
  const action = _ddValue('diagAction');
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
  const source  = _ddValue('diagSource');
  const action  = _ddValue('diagAction');
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
  _ddSetValue('diagSource', 'tiktokapi');
  diagSourceChanged();
  _ddSetValue('diagAction', 'user_info_by_id');
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
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/backfill/reset-errors', { method: 'POST' });
  btn.disabled = false;
  if (!ok) { showToast(data.error || 'Could not clear failed videos', { type: 'error' }); return; }
  showToast(`${data.reset} video(s) cleared, ready to retry.`, { type: 'success' });
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
      statusEl.textContent = '';
      const ok2 = data.done - data.errors;
      if (data.total === 0) showToast('Nothing to backfill', { type: 'info' });
      else showToast(`Stats backfill done: ${ok2} updated, ${data.errors} failed`,
                     { type: data.errors ? 'warning' : 'success' });
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
    statusEl.textContent = '';
    const t = showToast('Resetting…', { spinner: true, duration: 0 });

    apiJSON('/api/tiktok/backfill/reset', { method: 'POST' }).then(({ ok, data }) => {
      btn.disabled = false;
      if (!ok) t.update(data.error || 'Could not reset the backfill status', { type: 'error' });
      else t.update(`Done. ${data.reset.toLocaleString()} videos marked for re-backfill.`, { type: 'success' });
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadCookies();
loadSounds();
// These live at module level (outside the initChannelApp closure), so gate
// them on the TikTok tab being active instead of polling from every tab
const _ttTabActive = () => (location.hash.slice(1) || 'tiktok') === 'tiktok';
setInterval(() => { if (_ttTabActive()) loadCookies(); }, 30000);
// Sounds arrive via the SSE 'changed' event while the stream is open; this
// poll is the no-stream fallback
setInterval(() => { if (_ttTabActive() && !tt.isLive()) loadSounds(); }, 60000);
window.addEventListener('hashchange', () => { if (_ttTabActive()) { loadCookies(); loadSounds(); } });
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
