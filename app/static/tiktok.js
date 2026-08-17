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
  if (!await openConfirm({ title: 'Reset the TikTok session?', message: 'This signs out, deletes the browser identity, and requires a new QR sign-in.', confirmLabel: 'Reset', danger: true })) return;
  const { ok, data } = await apiJSON('/api/tiktok/login/session', { method: 'DELETE' });
  showToast((data && (data.message || data.error)) || (ok ? 'Session reset' : 'Could not reset the session'),
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
  // The frame stream must stop on every close path, including native Escape
  _dlgWire('ttViewer', () => { _viewerOn = false; _viewerDown = false; });
  _dlgOpen('ttViewer');
  _viewerOn = true;
  _viewerNextFrame();
}

function ttViewerClose() {
  _dlgClose('ttViewer');
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
  // Escape ordering (WG parse over viewer over the rest) is the native
  // <dialog> top-layer stacking; no handler needed.
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
  if (!ok) { showToast('Could not load the proxy settings', { type: 'error' }); return; }
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
  if (!ok) { showToast('Could not load the WireGuard config.', { type: 'error' }); return; }
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
  if (!await openConfirm({ title: 'Remove WireGuard config?', message: 'Gluetun keeps using it until that container restarts.', confirmLabel: 'Remove', danger: true })) return;
  const { ok } = await apiJSON('/api/tiktok/proxy/wireguard', { method: 'DELETE' });
  if (!ok) { showToast('Could not remove the config', { type: 'error' }); return; }
  _ttWgSavedToast('WireGuard config removed.');
  ttWgLoad();
}

// Parse modal: extract the four fields from a pasted WireGuard config

function ttWgParseOpen() {
  _dlgWire('ttWgParse', () => { document.getElementById('ttWgParseText').value = ''; });
  document.getElementById('ttWgParseStatus').style.display = 'none';
  _dlgOpen('ttWgParse');
  document.getElementById('ttWgParseText').focus();
}

function ttWgParseClose() {
  _dlgClose('ttWgParse');
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
      <span class="loop-section-label">Sound loop</span>
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
    } else if (data.kind === 'duplicate') {
      t.update('This sound is already tracked.', { type: 'success' });
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

// Original post URL: photo posts live under /photo/, everything else under
// /video/. A wrong or stale handle is fine, TikTok redirects to the canonical
// URL ("user" is the same placeholder trick get_video_details uses).
function _ttVideoUrl(v, handle) {
  const kind = v.type === 'photo' ? 'photo' : 'video';
  return `https://www.tiktok.com/@${handle || 'user'}/${kind}/${v.video_id}`;
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
  _soundActivity  = (state.sound_loop_running || state.sound_run_current)
    ? (state.sound_loop_stage || 'sound loop running')
    : null;

  // Keep the open sound modal's Run button in step with the run queue, the
  // same way the engine's updateRunStates patches the creator modal buttons
  const _mRunBtn = document.getElementById('soundModalRunBtn');
  if (_mRunBtn && _soundModal) {
    _mRunBtn.disabled = soundRunQueue.includes(_soundModal.sound_id)
      || soundRunCurrent === _soundModal.sound_id;
  }

  const el = id => document.getElementById(id);

  // Text writes are change-guarded like the engine's renderStatus: this runs
  // on every status event, and an identical textContent write still repaints
  // (and re-blurs under an open modal's backdrop)
  const _setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };

  const sMeta = el('soundLoopMeta');
  if (sMeta) {
    const parts = [];
    if (state.sound_loop_last_start) parts.push(`Last: ${fmt.rel(state.sound_loop_last_start)}`);
    else parts.push('Never run');
    if (state.sound_loop_last_new_videos != null) parts.push(`${state.sound_loop_last_new_videos} new`);
    if (state.sound_loop_last_duration_secs != null) parts.push(fmt.dur(state.sound_loop_last_duration_secs));
    _setText(sMeta, parts.join(' · '));
  }
  _soundLoopPaused = !!state.sound_loop_paused;
  const sNext = el('soundLoopNext');
  _setText(sNext, state.sound_loop_running
    ? 'Running…'
    : _soundLoopPaused
      ? 'Paused'
      : (state.sound_loop_next ? `Next: ${fmt.relFuture(state.sound_loop_next)}` : ''));
  _renderPauseState(el('soundPauseBtn'), sNext, _soundLoopPaused);

  const sSessions = el('soundLoopSessions');
  if (sSessions) {
    const nextIso    = state.sound_loop_next;
    const intervalMs = (state.sound_loop_interval_minutes || 60) * 60 * 1000;
    // Fabricate the fixed-interval schedule and hand it to the shared
    // renderer the engine loop panels use (an empty list clears the row);
    // always going through it keeps its skip-if-unchanged stash coherent
    const nextMs   = nextIso ? new Date(nextIso).getTime() : 0;
    const sessions = nextIso && intervalMs
      ? [0, 1, 2, 3].map(i => new Date(nextMs + i * intervalMs).toISOString())
      : [];
    _renderSessionPills(sSessions, sessions, !!state.sound_loop_running, false);
  }
  const sBtn     = el('triggerSoundBtn');
  const sStopBtn = el('stopSoundBtn');
  if (sBtn)     sBtn.disabled     = state.sound_loop_running;
  if (sStopBtn) sStopBtn.disabled = !state.sound_loop_running;

  const missing = el('missingStatsCount');
  if (missing) {
    const n = state.missing_stats_count ?? 0;
    _setText(missing, n > 0 ? `${n.toLocaleString()} missing` : '');
  }
  const failed = el('statsFailedCount');
  if (failed) {
    const f = state.stats_failed_count ?? 0;
    _setText(failed, f > 0 ? `${f.toLocaleString()} unavailable` : '');
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

// ── Settings panes ────────────────────────────────────────────────────────────
// TikTok's settings markup, registered through the engine's cfg.settings hook.
// The wiring functions (QR login, viewer, proxy, WireGuard, jobs, diagnostics)
// live in this file; the pane html references them by name.

const _TT_SETTINGS_ACCOUNT_HTML = `
  <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px;">
    <span class="cookie-pill absent" id="cookiePill">
      <span class="dot"></span>
      <span id="cookiePillText">No cookies file</span>
    </span>
    <span class="cookie-meta" id="cookieMeta"></span>
    <button class="btn-danger" id="cookieDeleteBtn" onclick="ttResetSession()" style="display:none;margin-left:auto">Reset session</button>
  </div>
  <div class="settings-group">
    <span class="settings-label">Sign in with QR code</span>
    <div class="settings-note">
      Signs in inside the app's own browser, so the session is created with the
      fingerprint that will use it. Open TikTok on your phone, tap the scan icon
      in the top bar of your Profile tab, and scan the code.
      The session cookies are stored server-side on success.
    </div>
    <button class="btn-sm" id="ttQrBtn" onclick="ttQrStart()">Generate QR code</button>
    <div class="settings-note" id="ttQrStatus" style="display:none"></div>
    <img id="ttQrImg" style="display:none;width:220px;border-radius:var(--radius);margin-top:8px;image-rendering:pixelated" alt="TikTok login QR code">
  </div>
  <div class="settings-group">
    <span class="settings-label">Live browser view</span>
    <div class="settings-note">
      Opens a live view of the app's TikTok browser so you can solve a captcha or
      verification wall by hand. The view is black unless a session is running:
      start a QR login or trigger a check first, then watch and interact here.
    </div>
    <button class="btn-sm" id="ttViewerBtn" onclick="ttViewerOpen()">Open browser view</button>
  </div>`;

// Schedule pane: the shared _schedulePaneHtml renders it; these opts add the
// TikTok deltas (stats_refresh_days drives the batch refresh cycle instead of
// full_refresh_days, plus the sound loop's own interval field).
const _TT_SCHEDULE_OPTS = {
  subtitle: 'User loop',
  fullRefresh: { key: 'stats_refresh_days', suffix: 'StatsRefreshDays', label: 'Full refresh cycle', min: 1, max: 30, unit: 'days' },
  extraFields: { sound_loop_interval_minutes: 'soundLoopIntervalInput' },
  extraHtml: `
    <div class="settings-subtitle">Sound loop</div>
    <div class="settings-group">
      ${_scheduleFieldHtml('soundLoopIntervalInput', 'Sound loop interval', 1, 9999, 'min')}
    </div>`,
};

const _TT_SETTINGS_NETWORK_HTML = `
  <div class="settings-group">
    <label class="tracking-toggle lg">
      <input type="checkbox" id="ttProxyEnabled" onchange="ttProxyToggle()">
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="toggle-label">Enable VPN</span>
    </label>
    <div class="settings-note" style="margin-top:6px;margin-bottom:0">
      Route all TikTok traffic through a VPN or proxy. The rest of the app is unaffected.
    </div>
  </div>
  <div class="hr-divider"></div>
  <div class="settings-group">
    <span class="settings-label">Proxy</span>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:560px">
      <div class="filter-pills multi">
        <button class="filter-pill" id="ttProxyModeGluetun" onclick="ttProxySetMode('gluetun')">Gluetun VPN</button>
        <button class="filter-pill" id="ttProxyModeCustom" onclick="ttProxySetMode('custom')">Other proxy</button>
      </div>
      <input type="text" id="ttProxyUrl" class="text-input" style="flex:1;min-width:200px" placeholder="http://proxy:8888" autocomplete="off" spellcheck="false">
      <button class="btn-sm" id="ttProxySaveBtn" onclick="ttProxySave()">Save</button>
      <button class="btn-sm" id="ttProxyTestBtn" onclick="ttProxyTest()">Test connection</button>
    </div>
    <button type="button" class="hdr-link" style="margin-top:8px" onclick="_ttHelpToggle('ttProxyHelp')">How this works</button>
    <div class="settings-note" id="ttProxyHelp" style="display:none;margin-top:8px">
      With Enable VPN on, all TikTok traffic (the browser, page fetches, and
      downloads) leaves through the proxy configured here instead of the
      server's own connection. Gluetun VPN mode expects the gluetun container
      from the README example, reachable as <code>gluetun:8888</code> on the
      Docker network, and manages its WireGuard credentials below. Other proxy
      mode takes any HTTP proxy address instead. Changes apply from the next
      browser session, no restart needed. Test connection works either way,
      whether the VPN is enabled or not, and shows the exit IP the proxy
      provides.
    </div>
  </div>
  <div class="settings-group" id="ttWgGroup">
    <span class="settings-label">WireGuard config (gluetun)</span>
    <div class="settings-note" id="ttWgMeta" style="margin-bottom:10px"></div>
    <div style="display:flex;flex-direction:column;gap:12px;max-width:500px">
      <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
        <span>Private key</span>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="password" id="ttWgPrivateKey" class="text-input" style="flex:1" placeholder="from the [Interface] section" autocomplete="new-password" spellcheck="false">
          <button class="btn-sm" id="ttWgKeyEye" onclick="ttWgToggleKey()" title="Show the key" style="flex-shrink:0;padding:5px 8px"></button>
        </div>
      </label>
      <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
        <span>Address</span>
        <input type="text" id="ttWgAddress" class="text-input" placeholder="10.2.0.2/32" autocomplete="off" spellcheck="false">
      </label>
      <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
        <span>Server public key</span>
        <input type="text" id="ttWgPublicKey" class="text-input" placeholder="from the [Peer] section" autocomplete="off" spellcheck="false">
      </label>
      <label style="display:flex;flex-direction:column;gap:5px;font-size:13px">
        <span>Server endpoint</span>
        <input type="text" id="ttWgEndpoint" class="text-input" placeholder="146.70.170.18:51820" autocomplete="off" spellcheck="false">
      </label>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <button class="btn-sm" onclick="ttWgParseOpen()">Paste full config</button>
      <button class="btn-sm" onclick="ttWgSave()">Save config</button>
      <button class="btn-danger" id="ttWgDeleteBtn" onclick="ttWgDelete()" style="display:none">Remove</button>
    </div>
    <button type="button" class="hdr-link" style="margin-top:8px" onclick="_ttHelpToggle('ttWgHelp')">How this works</button>
    <div class="settings-note" id="ttWgHelp" style="display:none;margin-top:8px">
      These are the VPN credentials for the gluetun container behind the proxy
      above, from a WireGuard config file (ProtonVPN: account page &gt; Downloads
      &gt; WireGuard configuration). Paste full config fills the fields from a
      pasted file, keeping only what gluetun needs; comments and IPv6 entries are
      discarded automatically. Saving writes a clean
      <code>data/gluetun/wireguard/wg0.conf</code>, where gluetun's
      <code>./data/gluetun:/gluetun</code> volume reads it. Gluetun only loads the
      config at startup, so restart that container after saving. With the host's
      Docker socket mounted into the app container (see the README), the save
      notification offers a Restart gluetun now action that does that for you.
    </div>
  </div>`;

const _TT_SETTINGS_JOBS_HTML = `
  <div class="job-card">
    <div class="job-card-hdr">
      <div class="job-card-title">Stats backfill</div>
      <button class="btn-primary" id="backfillBtn" onclick="triggerBackfill()">Run</button>
    </div>
    <div class="job-card-desc">
      Fetches view counts, likes, and other metadata for downloaded videos that
      are missing stats.
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;min-height:16px">
      <span id="missingStatsCount" style="font-size:12px;color:var(--muted)"></span>
      <span id="statsFailedCount"  role="button" tabindex="0" style="font-size:12px;color:var(--red);display:none;cursor:pointer;text-decoration:underline dotted" onclick="toggleFailedList()" title="Click to see which videos"></span>
      <button id="retryFailedBtn" onclick="retryFailed()" style="display:none;font-size:12px;padding:3px 10px;background:var(--raised);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-dim);cursor:pointer" title="Clear error counts so these videos are retried on the next backfill run">Retry failed</button>
    </div>
    <div id="failedList" style="display:none;font-size:11px;color:var(--muted);line-height:1.7"></div>
    <div class="job-status" id="job-backfill-status" style="display:none">
      <div id="job-backfill-bar-wrap"><div class="job-bar-track"><div class="job-bar-fill" id="job-backfill-bar"></div></div></div>
      <div class="job-status-text" id="job-backfill-text"></div>
    </div>
    <div class="report-widget">
      <div class="job-card-desc" style="margin-bottom:8px">
        Reset marks every video as needing a stats backfill. Use it after adding new
        tracked columns; the next run will re-fetch all videos.
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button class="btn-danger" id="resetBackfillBtn" onclick="resetBackfillStep()">Reset all backfill status</button>
      </div>
    </div>
  </div>

  <div class="job-card">
    <div class="job-card-hdr">
      <div class="job-card-title">Missing file check</div>
      <div class="job-card-btns">
        <button class="btn-primary" id="job-filecheck-scan-btn" onclick="triggerFileScan()">Scan</button>
        <button class="btn-danger"  id="job-filecheck-purge-btn" onclick="triggerFilePurge()">Remove</button>
      </div>
    </div>
    <div class="job-card-desc">
      Scans saved video records for files no longer present on disk.
      Scan reports what would be removed. Purge removes the DB records,
      after which videos will be re-downloaded on the next loop run.
      Purge also runs automatically at midnight and noon.
    </div>
    <div class="job-status" id="job-filecheck-status" style="display:none">
      <div id="job-filecheck-bar-wrap"><div class="job-bar-track"><div class="job-bar-fill" id="job-filecheck-bar"></div></div></div>
      <div class="job-status-text" id="job-filecheck-text"></div>
      <div class="report-widget" id="job-filecheck-report" style="display:none">
        <div class="report-preview" id="job-filecheck-preview"></div>
        <div class="report-actions">
          <button class="btn-report" id="job-filecheck-view-btn" onclick="openReportView(_filecheckReportFile, 'Missing file check')">View full report</button>
          <a id="job-filecheck-download-link" class="btn-report" style="display:none">Download report</a>
        </div>
      </div>
    </div>
  </div>

  <div class="job-card">
    <div class="job-card-hdr">
      <div class="job-card-title">Corrupted story recovery</div>
      <div class="job-card-btns">
        <button class="btn-primary" id="job-storyfix-scan-btn" onclick="triggerStoryScan()">Scan</button>
        <button class="btn-primary" id="job-storyfix-redl-btn" onclick="triggerStoryRedownload()">Re-download</button>
      </div>
    </div>
    <div class="job-card-desc">
      Scans saved stories for missing or unplayable files. Re-download
      fetches fresh copies of the afflicted ones, but only while a story
      is still live: TikTok drops stories 24 hours after posting, and
      expired ones cannot be recovered, so Re-download removes them from
      the library instead (they would otherwise warn in the story viewer
      forever). Video stories only; photo stories are re-fetched by the
      next loop check of their user.
    </div>
    <div class="job-status" id="job-storyfix-status" style="display:none">
      <div id="job-storyfix-bar-wrap"><div class="job-bar-track"><div class="job-bar-fill" id="job-storyfix-bar"></div></div></div>
      <div class="job-status-text" id="job-storyfix-text"></div>
    </div>
  </div>

  <div class="job-card">
    <div class="job-card-hdr">
      <div class="job-card-title">Delete all avatars</div>
      <button class="btn-danger" id="util-clear-avatars-btn" onclick="triggerClearAvatars()">Delete</button>
    </div>
    <div class="job-card-desc">
      Deletes the current cached profile picture for tracked users. Archived avatar
      history is preserved. On the next loop run, avatars will be re-downloaded and
      saved without triggering a profile change event. Banned users are excluded by
      default; their avatars cannot be re-fetched from TikTok.
    </div>
    <label class="tracking-toggle" style="margin-top:8px">
      <input type="checkbox" id="util-clear-avatars-include-banned">
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="toggle-label">Include banned users</span>
    </label>
    <div class="job-status" id="job-clear-avatars-status" style="display:none">
      <div class="job-status-text" id="job-clear-avatars-text"></div>
    </div>
  </div>`;

// Diagnostics pane: shared scaffolding from _diagPaneHtml; the source+action
// dropdown pair is TikTok's own (diagSourceChanged populates the action menu).
const _TT_SETTINGS_DIAG_HTML = _diagPaneHtml('diag', {
  note: `Run raw API calls and inspect the response. Useful for debugging download issues.
      TikTokApi calls open a browser session and may take 10-30 seconds.`,
  placeholder: 'https://www.tiktok.com/@user/video/123... or user ID',
  runFn: 'diagRun',
  copyFn: 'diagCopy',
  ddRowHtml: `
    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div class="dd" id="diagSource" data-value="get_video_details" style="flex:1;min-width:160px">
        <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" onclick="_ddToggle(this)"><span class="dd-label">get_video_details</span><span class="dd-caret">${_caretIcon}</span></button>
        <div class="dd-menu" role="listbox" popover>
          <button type="button" class="dd-opt active" data-value="get_video_details" role="option" onclick="_ddPick(this);diagSourceChanged()">get_video_details</button>
          <button type="button" class="dd-opt" data-value="ytdlp" role="option" onclick="_ddPick(this);diagSourceChanged()">yt-dlp</button>
          <button type="button" class="dd-opt" data-value="tiktokapi" role="option" onclick="_ddPick(this);diagSourceChanged()">TikTokApi</button>
        </div>
      </div>
      <div class="dd" id="diagAction" data-value="" style="flex:1;min-width:160px">
        <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" onclick="_ddToggle(this)"><span class="dd-label">(paste a URL below)</span><span class="dd-caret">${_caretIcon}</span></button>
        <div class="dd-menu" role="listbox" popover></div>
      </div>
    </div>`,
  trailingHtml: `<div id="diagResolveHint" style="display:none;margin-top:8px;font-size:12px;color:var(--muted)"></div>`,
});

function _ttJobsShow() {
  // Jobs resume their poll only when still running server-side. The app-wide
  // jobs (AVIF, thumbnail repair, audio cleanup, path migration) live in
  // Settings > General > Jobs now.
  _jobResume('filecheck', '/api/tiktok/jobs/file-check/status',     _filecheckTick, 1000);
  _jobResume('storyfix',  '/api/tiktok/jobs/story-recovery/status', _storyfixTick,  1500);
  _jobResume('backfill',  '/api/tiktok/backfill',                   _backfillTick,  2000);
}

function _ttJobsHide() {
  // Finished jobs: clear their widgets so the pane opens clean next time.
  // Running jobs: keep the widget state; _ttJobsShow resumes their poll.
  const byId = id => document.getElementById(id);
  if (!_jobPolls['filecheck']) { _filecheckWidget.hide(); _filecheckReport.hide(); _setFilecheckBtns(false); }
  if (!_jobPolls['storyfix'])  { _storyfixWidget.hide();  _setStoryfixBtns(false); }
  if (!_jobPolls['backfill'])  { _backfillWidget.hide();  const b = byId('backfillBtn');      if (b) b.disabled = false; }
  _clearAvatarsWidget.hide();
  // No interval of this pane's outlives it
  ['filecheck', 'storyfix', 'backfill'].forEach(_jobPollStop);
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
  loopLabel:         'User loop',
  loopsTitle:        'Loops',
  addPlaceholder:    '@username, sound ID, or URL',
  addAriaLabel:      'TikTok username, sound ID, or URL',
  profileUrl:        h => `https://www.tiktok.com/@${h}`,
  videoUrl:          (v, ch) => _ttVideoUrl(v, ch.handle),
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
    { label: 'Latest saved',  value: s.latest_download ? fmt.rel(new Date(s.latest_download * 1000).toISOString()) : '–' },
    { label: 'Storage',       value: _fmtBytes(s.media_size_bytes || 0) },
  ],
  extraFilterGroups: [{
    key: 'priv', label: 'Privacy', dropdown: true,
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
  }, {
    key: 'rel', label: 'Relation', dropdown: true,
    options: [
      { key: 'friends',     label: 'Friends'     },
      { key: 'following',   label: 'Following'   },
      { key: 'follows_you', label: 'Follows you' },
      { key: 'none',        label: 'No relation' },
    ],
    // Same relation codes the card pills render; unknown relation only shows
    // while the filter is inactive
    test: (u, set) => set.has({ 2: 'friends', 1: 'following', 6: 'follows_you', 0: 'none' }[u.relation]),
  }],
  extraViews: [{
    key: 'sounds', label: 'Sounds',
    emptyLabel: 'No sounds tracked yet',
    controlsHtml: _TT_SOUND_CONTROLS_HTML,
    show: q => { _soundSearch = q || ''; renderSounds(); },
  }],
  extraLoopHtml:     _TT_SOUND_LOOP_HTML,
  extraLoopLabel:    'Sounds',
  addHandler:        _ttAddHandler,
  videoActionBtnsFn: _ttVideoActionBtns,
  // Sound modal data spans both domains: sound_videos discoveries bump
  // 'sounds', video status changes bump 'creators'.
  extraDomainLoaders: { sounds: () => loadSounds().then(_refreshOpenSoundModal) },
  onCreatorsRefetched: () => _refreshOpenSoundModal(),
  recentFallback:    item => item.sound_id
    ? `openSoundModalAndHighlight('${esc(item.sound_id)}','${esc(item.video_id)}')`
    : '',
  statusActive:      state => state.sound_loop_running || !!state.sound_run_current,
  statusActiveLabel: 'sound loop',
  currentActivity:   () => _soundActivity,
  nextRunCandidates: state => [
    state.loop_next       ? { iso: state.loop_next,       label: 'user loop'  } : null,
    state.sound_loop_next ? { iso: state.sound_loop_next, label: 'sound loop' } : null,
  ],
  onStatus:          _ttOnStatus,
  settings: {
    account:  { html: _TT_SETTINGS_ACCOUNT_HTML,  onShow: () => loadCookies() },
    schedule: { opts: _TT_SCHEDULE_OPTS },
    network:  { html: _TT_SETTINGS_NETWORK_HTML,  onShow: () => ttProxyLoad() },
    jobs:     { html: _TT_SETTINGS_JOBS_HTML, onShow: _ttJobsShow, onHide: _ttJobsHide },
    diag:     { html: _TT_SETTINGS_DIAG_HTML, onShow: () => diagSourceChanged() },
  },
});

// ── Sound loop triggers ───────────────────────────────────────────────────────

function triggerSoundLoop() { return _triggerLoop('triggerSoundBtn', '/api/tiktok/trigger/sounds', 'Could not trigger sound loop', () => showToast('Sound check queued')); }

let _soundLoopPaused = false;
let _soundActivity   = null;  // sound loop stage line for the log activity bar

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
  showToast(paused ? 'Sound loop paused: scheduled sessions will be skipped.' : 'Sound loop resumed.');
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
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${_emptyInner('inbox',
      'No sounds tracked yet. Paste a TikTok sound link in the add bar to track one.',
      '<button class="btn-primary btn-sm" onclick="ttFocusAdd()">Add a sound</button>')}</div>`;
    return;
  }
  if (!filtered.length) {
    const cause = _soundSearch ? 'search' : 'filter';
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${_emptyInner('search',
      `No sounds match this ${cause}.`,
      `<button class="btn-ghost btn-sm" onclick="resetSoundFilters()">Clear ${cause === 'search' ? 'search' : 'filters'}</button>`)}</div>` + _ghostCards(9);
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
      + _starBtn(s.starred, s.sound_id)
      + `<button class="btn-run" ${runDis} data-action="run" data-id="${esc(s.sound_id)}">${_refreshIcon} ${runLabel}</button>`
      + `<button class="btn-menu" data-action="menu" data-id="${esc(s.sound_id)}" title="More actions" aria-haspopup="menu">${_dotsIcon}</button>`
      + `</div>`;

    const meta = _cardMeta([
      { label: 'Added',   value: fmtDateOnly(s.added_at) },
      { label: 'Checked', value: s.last_checked ? fmt.rel(new Date(s.last_checked * 1000).toISOString()) : 'never' },
      { label: 'Saved',   value: s.last_saved   ? fmt.rel(new Date(s.last_saved   * 1000).toISOString()) : 'never' },
    ]);

    return _cardShell({
      classes:  isInactive ? 'user-card-inactive' : '',
      dataAttr: `data-soundid="${esc(s.sound_id)}"`,
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
  if (!ok) {
    if (!sounds.length) {
      const grid = document.getElementById('ttGrid_sounds');
      if (grid) grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Could not load sounds. Retrying automatically.</div>';
    }
    return;
  }
  const sig = JSON.stringify(data);
  if (sig === _soundsSig) return;
  _soundsSig = sig;
  sounds = data;
  renderSounds();
}

async function removeSound(soundId) {
  const s = sounds.find(x => x.sound_id === soundId);
  const label = s ? (s.label || s.sound_id) : soundId;
  if (!await openConfirm({ title: `Remove sound "${label}"?`, message: `${soundId}\n\nVideos already downloaded will not be deleted.`, confirmLabel: 'Remove', danger: true })) return;
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}`, { method: 'DELETE' });
  if (!ok) { showToast(data.error || 'Could not remove sound', { type: 'error' }); return; }
  if (_soundModalId === soundId) closeSoundModal();
  loadSounds();
}

// Optimistic toggle, reverted with an error toast if the PATCH fails
async function toggleSoundStar(soundId) {
  const sound = sounds.find(s => s.sound_id === soundId);
  if (!sound) return;
  const newVal = !sound.starred;
  sound.starred = newVal ? 1 : 0;
  renderSounds();
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/star`, {
    method: 'PATCH',
    body: JSON.stringify({ starred: newVal }),
  });
  if (!ok) {
    sound.starred = newVal ? 0 : 1;
    renderSounds();
    showToast(data.error || 'Could not update star', { type: 'error' });
  }
}

async function runSound(soundId) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/run`, { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start sound run', { type: 'error' }); return; }
  soundRunQueue = [...soundRunQueue, soundId];
  renderSounds();
}

async function setSoundTracking(soundId, enabled) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/tracking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!ok) { showToast(data.error || 'Could not update tracking', { type: 'error' }); return; }
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
  if (!ok) { showToast(data.error || 'Could not update label', { type: 'error' }); return; }
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
  { field: 'download_date',  label: 'Saved' },
  { field: 'deleted_at',     label: 'Deleted' },
  { field: null,             label: '' },
];

const _soundState = { videos:[], filter:new Set(), typeFilter:new Set(), search:'', sort:{field:'upload_date',dir:'desc'}, loaded:0, obs:null, toolbarExpanded:false, view:'list' };

function _soundThumbCell(v) {
  const id    = esc(v.video_id);
  const badge = v.type === 'video' ? _playBadge : v.type === 'photo' ? (v.multi ? _photoBadge : _imageBadge) : '';
  const action = v.type === 'video'
    ? `onclick="event.stopPropagation();_soundOpenVid('${id}')" title="Play video" style="cursor:pointer"`
    : v.type === 'photo'
      ? `onclick="event.stopPropagation();_soundOpenCarousel('${id}')" title="View photos" style="cursor:pointer"`
      : 'style="cursor:default"';
  return `<div style="position:relative;line-height:0;width:90px;flex-shrink:0">
    <img class="video-thumb" src="/api/tiktok/videos/${id}/thumbnail" alt="" loading="lazy"
         onerror="this.style.opacity='.15'"
         ${action}>${badge}</div>`;
}

// The sound modal uses the same shell markup and mobile treatment as the
// creator modals (shared _modalShellHtml + the engine's mobile toolbar/rows),
// so the two can never drift apart again.
document.body.insertAdjacentHTML('beforeend',
  _modalShellHtml('soundModal', 'closeSoundModal', { scrollTopFn: 'soundModalScrollTop' }));
_modalShellScrollWiring('soundModal');
// Sound-modal close cleanup runs on every close path (button, backdrop
// click, native Escape)
_dlgWire('soundModalBackdrop', () => {
  if (_soundState.obs) { _soundState.obs.disconnect(); _soundState.obs = null; }
  _soundModalId      = null;
  _soundModal        = null;
  _soundState.videos = [];
});

// Delegated clicks for the sounds grid and the sound modal's author chips
// (menu items and tracking labels are built at click time, never serialized
// into attributes)
_delegate(document.getElementById('ttGrid_sounds'), {
  open: (d, el, e) => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    openSoundModal(el.getAttribute('data-soundid'));
  },
  star: d => toggleSoundStar(d.id),
  run:  d => runSound(d.id),
  menu: (d, el) => {
    const snd = sounds.find(x => x.sound_id === d.id);
    const off = snd ? snd.tracking_enabled === 0 : false;
    _openCardMenu(el, [
      { label: off ? 'Enable tracking' : 'Disable tracking', onclick: () => setSoundTracking(d.id, off) },
      { label: 'Remove', danger: true, onclick: () => removeSound(d.id) },
    ]);
  },
});
_delegate(document.getElementById('soundModalVideoList'), {
  author: d => {
    closeSoundModal();
    if (d.tracked === '1') tt.openModal(d.id);
    else openUntrackedUserModal(d.id, d.name);
  },
});

function soundModalScrollTop() {
  const m = document.getElementById('soundModalBase');
  if (m) m.scrollTo({ top: 0, behavior: 'smooth' });
}
function soundMSort(f)   { _mMobSort(_SOUND_MODAL_CFG, f); }
function soundMStatus(k) { _mMobStatus(_SOUND_MODAL_CFG, k); }
function soundMType(k)   { _mMobType(_SOUND_MODAL_CFG, k); }
function _soundDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function _soundVideoUrl(v) {
  if (!v || v.status === 'deleted') return null;
  return _ttVideoUrl(v, v.author_handle);
}
function soundVideoMenu(btn, vid) {
  const v = _soundState.videos.find(x => x.video_id === vid);
  if (!v) return;
  const id    = esc(v.video_id);
  const items = [];
  if (v.file_path) {
    items.push({ label: 'Download', onclick: () => v.type === 'photo'
      ? _soundDownload(`/api/tiktok/videos/${id}/photos/zip`, `${id}_photos.zip`)
      : _soundDownload(`/api/tiktok/videos/${id}/file`, `${id}.mp4`) });
  }
  const link = _soundVideoUrl(v);
  items.push({ label: 'Open link', disabled: !link,
               onclick: () => { if (link) window.open(link, '_blank', 'noopener'); } });
  _openCardMenu(btn, items);
}

// Viewer openers for sound modal rows: same slides the engine's ttOpenVidModal
// and ttOpenCarousel build, but the row lookup happens in _soundState (the
// engine only knows the creator modal's videos), so the viewer's Link button
// gets the post URL here too.
function _soundOpenVid(vid) {
  const v = _soundState.videos.find(x => x.video_id === vid);
  openMediaViewer([{
    url:  `/api/tiktok/videos/${encodeURIComponent(vid)}/file`,
    type: 'video',
    name: `${vid}.mp4`,
    link: v ? _soundVideoUrl(v) : null,
  }]);
}
async function _soundOpenCarousel(vid) {
  const { ok, data } = await apiJSON(`/api/tiktok/videos/${encodeURIComponent(vid)}/files`);
  if (!ok || !data.files || !data.files.length) return;
  const v    = _soundState.videos.find(x => x.video_id === vid);
  const link = v ? _soundVideoUrl(v) : null;
  openMediaViewer(data.files.map(f => ({ ...f, link })));
}

const _SOUND_MODAL_CFG = {
  st: _soundState, itemNoun: 'video', itemNounPlural: 'videos',
  listElId: 'soundModalVideoList', toolbarElId: 'soundModalToolbar',
  cols: SOUND_VCOLS, colsCls: 'sound-vcols', pageSize: 50,
  filterFn: 'setSoundModalFilter', typeFilterFn: 'setSoundModalTypeFilter',
  sortFn: 'setSoundModalSort', toggleFn: 'toggleSoundModalToolbar', searchFn: 'onSoundModalSearch',
  mobileToolbar: true, mobileRows: true,
  filtersHostId: 'soundModalFilters',
  mSortFn: 'soundMSort', mStatusFn: 'soundMStatus', mTypeFn: 'soundMType',
  videoMenuFn: 'soundVideoMenu',
  videoUrlFn:  v => _soundVideoUrl(v),
  authorCol: v => {
    const name = v.author_handle || v.channel_id || '?';
    return `<span class="author-chip${v.author_enabled === 1 ? '' : ' untracked'}" role="button" tabindex="0" data-action="author" data-id="${esc(v.channel_id)}" data-name="${esc(name)}" data-tracked="${v.author_enabled === 1 ? 1 : 0}">@${esc(name)}</span>`;
  },
  hasSearch: true, hasViewToggle: true, viewFn: 'setSoundModalView',
  desktopTabs: true,
  viewKeys: [
    { key: 'list', icon: _listViewIcon, title: 'List view', label: 'Videos' },
    { key: 'grid', icon: _gridViewIcon, title: 'Grid view', label: 'Grid' },
  ],
  gridId: 'soundVideoGrid',
  thumbCellFn:  v => _soundThumbCell(v),
  actionBtnsFn: v => _ttVideoActionBtns(v),
  previewFn:    'ttOpenImgModal',
  typeIconFn:   v => v.type === 'video' ? _vgridPlayIcon : v.type === 'photo' ? (v.multi ? _vgridPhotoIcon : _vgridImageIcon) : '',
  gridThumbSrc: v => `/api/tiktok/videos/${esc(v.video_id)}/thumbnail`,
  gridCellOnclick: v => { if (v.type === 'video') _soundOpenVid(v.video_id); else if (v.type === 'photo') _soundOpenCarousel(v.video_id); },
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

  _dlgOpen('soundModalBackdrop');

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
  _dlgClose('soundModalBackdrop');
}

// Mirrors the engine's creator modal header: modal-header-left (avatar + name
// row + actions + hidden note area) with the date tiles and stat pairs on the
// right, and the mh card layout on mobile. Keep the class structure in sync
// with channels.js _renderModalHeader / _renderModalHeaderMobile.
const _soundAvatarHtml = `
    <div class="modal-avatar-wrap">
      <div class="sound-icon-wrap" style="width:56px;height:56px">
        <span class="sound-icon-letter" style="font-size:26px">♫</span>
      </div>
    </div>`;

function _soundHeaderMenu(s) {
  return `<button class="btn-menu" onclick="event.stopPropagation();_openCardMenu(this,[{label:'Edit label',onclick:()=>editSoundLabel('${esc(s.sound_id)}')},{label:'Edit note',onclick:()=>soundEditNote()}])">${_dotsIcon}</button>`;
}

function _soundRunBtn(s) {
  const busy = soundRunQueue.includes(s.sound_id) || soundRunCurrent === s.sound_id;
  return `<button id="soundModalRunBtn" class="btn-run" ${busy ? 'disabled' : ''} onclick="runSound('${esc(s.sound_id)}')">${_refreshIcon} Run</button>`;
}

function _soundNoteAreaHtml(s) {
  return _noteFieldHtml(s.comment, 'soundEditNote', 8);
}

// Same editor flow as the creator modals' EditNote: reached from the empty
// field's "Click to add a note" and the header menu's Edit note item.
async function soundEditNote() {
  if (!_soundModal) return;
  const id  = _soundModal.sound_id;
  const val = await openPrompt({
    title: 'Edit note', value: _soundModal.comment || '',
    placeholder: 'Note about this sound…', confirmLabel: 'Save', multiline: true,
  });
  if (val === null) return;
  await saveSoundComment(id, val);
  if (_soundModal && _soundModal.sound_id === id) _renderSoundModalHeader(_soundModal);
}

function _renderSoundModalHeader(s) {
  if (_mIsMobile()) return _renderSoundModalHeaderMobile(s);
  const label = s.label || s.sound_id;
  const ttUrl = `https://www.tiktok.com/music/-${esc(s.sound_id)}`;
  const { cls: trackingCls, label: trackingLbl } = _trackingBadge(s.tracking_enabled);
  const inactive = s.tracking_enabled === 0;
  const _iso = u => new Date(u * 1000).toISOString();
  // Same ledger-row data block as the creator header, with fixed slots
  const activityRows =
      _hgRow('Added',   fmtDateOnly(s.added_at))
    + _hgRow('Checked', s.last_checked ? fmt.rel(_iso(s.last_checked)) : 'never');
  const archiveRows =
      _hgRow('Saved',    _fmtLarge(s.video_count || 0),      s.video_count      ? '' : ' tzero')
    + _hgRow('Deleted',  String(s.video_deleted || 0),       s.video_deleted    ? ' tred'    : ' tzero')
    + _hgRow('Restored', String(s.video_undeleted || 0),     s.video_undeleted  ? ' tyellow' : ' tzero');
  document.getElementById('soundModalHeader').innerHTML = `
    <div class="modal-header-left">
      ${_soundAvatarHtml}
      <div class="modal-user-body">
        <div class="modal-name-row">
          <span class="modal-name">${esc(label)}</span>
          <span class="account-status ${trackingCls}">${trackingLbl}</span>
          <label class="tracking-toggle" title="${inactive ? 'Sound tracking disabled' : 'Sound tracking enabled'}">
            <input type="checkbox" ${inactive ? '' : 'checked'} onchange="setSoundTracking('${esc(s.sound_id)}', this.checked)">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">Track videos</span>
          </label>
        </div>
        <div class="modal-handle">
          <a href="${ttUrl}" target="_blank" rel="noopener" class="tt-link">${esc(s.sound_id)}</a>
        </div>
        <div class="modal-actions-group" style="margin-top:8px">
          ${_soundRunBtn(s)}
          ${_soundHeaderMenu(s)}
        </div>
        ${_soundNoteAreaHtml(s)}
      </div>
    </div>
    <div class="hdr-data">
      <div class="hdr-group"><div class="hg-title">Activity</div>${activityRows}</div>
      <div class="hdr-group"><div class="hg-title">Archive</div>${archiveRows}</div>
    </div>
  `;
  _markXtextClipped(document.getElementById('soundModalHeader'));
}

function _renderSoundModalHeaderMobile(s) {
  const label = s.label || s.sound_id;
  const ttUrl = `https://www.tiktok.com/music/-${esc(s.sound_id)}`;
  const inactive = s.tracking_enabled === 0;
  document.getElementById('soundModalHeader').innerHTML = `
    <div class="mh">
      <div class="mh-top">
        ${_soundAvatarHtml}
        <div class="mh-id">
          <div class="mh-name">${esc(label)}</div>
          <div class="mh-handle"><a href="${ttUrl}" target="_blank" rel="noopener" class="tt-link">${esc(s.sound_id)}</a></div>
          <div class="mh-uid">${(s.video_count || 0).toLocaleString()} saved · ${esc(_fmtLastChecked(s.last_checked))}</div>
        </div>
      </div>
      <div class="mh-actions">
        ${_soundRunBtn(s)}
        ${_soundHeaderMenu(s)}
        <label class="tracking-toggle" title="${inactive ? 'Sound tracking disabled' : 'Sound tracking enabled'}" style="margin-left:auto">
          <input type="checkbox" ${inactive ? '' : 'checked'} onchange="setSoundTracking('${esc(s.sound_id)}', this.checked)">
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">Track</span>
        </label>
      </div>
      ${_soundNoteAreaHtml(s)}
    </div>
  `;
  _markXtextClipped(document.getElementById('soundModalHeader'));
}

function setSoundModalFilter(f)     { _mSetFilter(_SOUND_MODAL_CFG, f); }
function setSoundModalTypeFilter(t) { _mSetTypeFilter(_SOUND_MODAL_CFG, t); }
function toggleSoundModalToolbar()  { _mToggleToolbar(_SOUND_MODAL_CFG); }
function setSoundModalSort(f)       { _mSetSort(_SOUND_MODAL_CFG, f); }

function setSoundModalView(view) {
  _soundState.view = view;
  // Full toolbar re-render so the tab bar's active state follows (same as the
  // engine's SetModalView)
  _mRenderToolbar(_SOUND_MODAL_CFG, _soundState.videos);
  _mRenderList(_SOUND_MODAL_CFG);
}

function onSoundModalSearch(val) {
  _soundState.search = val.trim();
  _mRenderToolbar(_SOUND_MODAL_CFG, _soundState.videos);
  _mRenderList(_SOUND_MODAL_CFG);
}

let _soundVidsSig = null;

// Live refresh of the open sound modal, driven by the SSE 'sounds' and
// 'creators' domains. Signature-gated like the engine's modal refresh.
async function _refreshOpenSoundModal() {
  if (!_soundModalId) return;
  const id = _soundModalId;
  // Header from the already-fresh sounds catalog; skipped while the note
  // textarea (or anything else in the header) holds focus
  const s   = sounds.find(x => x.sound_id === id);
  const hdr = document.getElementById('soundModalHeader');
  if (s && JSON.stringify(s) !== JSON.stringify(_soundModal)) {
    _soundModal = s;
    if (!hdr || !hdr.contains(document.activeElement)) _renderSoundModalHeader(s);
  }
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(id)}/videos`);
  if (!ok || _soundModalId !== id) return;
  const sig = JSON.stringify(data);
  if (sig === _soundVidsSig) return;
  _soundVidsSig = sig;
  data.forEach(v => { v.type = v.content_type; v.description = v.title; });
  _soundState.videos = data;
  _mRenderToolbar(_SOUND_MODAL_CFG, data);
  _mRenderList(_SOUND_MODAL_CFG, { preserve: true });
}

async function _loadSoundModalVideos(soundId) {
  const { ok, data } = await apiJSON(`/api/tiktok/sounds/${encodeURIComponent(soundId)}/videos`);
  if (_soundModalId !== soundId) return;
  if (!ok) {
    document.getElementById('soundModalVideoList').innerHTML =
      '<div class="vlist-empty">Could not load videos. Close and reopen to retry.</div>';
    return;
  }
  _soundVidsSig = JSON.stringify(data);
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
      // Same grace-then-fade dismiss as the engine modal: scrolling under a
      // stationary cursor synthesizes a mouseenter that would kill the
      // highlight before it ever painted
      setTimeout(() => {
        row.addEventListener('mouseenter', () => {
          row.classList.add('video-row-hl-fade');
          row.classList.remove('video-row-highlight');
          row.addEventListener('transitionend', () => row.classList.remove('video-row-hl-fade'), { once: true });
        }, { once: true });
      }, 100);
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
        <span><strong>–</strong> followers</span>
        <span><strong>–</strong> following</span>
        <span><strong>–</strong> on TikTok</span>
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
    overlay.innerHTML = `<div class="modal-untracked-error">${esc(data?.error || 'Could not start tracking')}</div>`;
    return;
  }

  // The /track POST feeds the engine add queue. Rather than poll, ride the live
  // queue snapshots (SSE-pushed on the active tab, poll fallback otherwise) and
  // finish when this handle resolves. A resolved add stays in the queue as
  // status 'ok': that is the completion signal, not the entry disappearing
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
      ov.innerHTML = `<div class="modal-untracked-error">${esc(entry.message || 'Could not start tracking')}</div>`;
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

// ── Jobs ──────────────────────────────────────────────────────────────────────
// One contract for every Jobs-pane job: progress and results render through
// _makeJobWidget, and every polling loop registers in _jobPolls (common.js) so
// the pane's onHide stops them. Jobs keep running server-side; reopening the
// pane resumes the poll of any job still live (_jobResume). The app-wide jobs
// (AVIF converter, thumbnail repair, audio cleanup, delete thumbnails, path
// migration) and their wiring live in common.js under Settings > General.

const _filecheckWidget    = _makeJobWidget('filecheck');
const _storyfixWidget     = _makeJobWidget('storyfix');
const _backfillWidget     = _makeJobWidget('backfill');
const _clearAvatarsWidget = _makeJobWidget('clear-avatars');

// Database cleanup runs through the engine's ttTriggerCleanup export
// (channels.js) on the engine-generated cleanup card.

async function triggerClearAvatars() {
  const includeBanned = document.getElementById('util-clear-avatars-include-banned').checked;
  if (!await openConfirm({
    title: 'Delete all avatars?',
    message: includeBanned
      ? 'Cached profile pictures for all tracked users, including banned users, are deleted from disk. Banned users\' avatars cannot be re-fetched from TikTok.'
      : 'Cached profile pictures for tracked users are deleted from disk and re-downloaded on the next loop run.',
    confirmLabel: 'Delete', danger: true,
  })) return;
  return _runDeleteJob(
    _clearAvatarsWidget, 'util-clear-avatars-btn',
    '/api/tiktok/utils/clear-avatars',
    () => ({ include_banned: includeBanned }),
    d => `Deleted ${d.deleted} avatar file${d.deleted !== 1 ? 's' : ''}.`
  );
}

// Missing file check

let _filecheckReportFile = null;
const _filecheckReport   = _makeReportWidget('filecheck', '/api/tiktok/reports');

function _setFilecheckBtns(disabled) {
  document.getElementById('job-filecheck-scan-btn').disabled  = disabled;
  document.getElementById('job-filecheck-purge-btn').disabled = disabled;
}

async function _filecheckTick() {
  const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/status');
  if (!ok) return;
  if (data.running) {
    _setFilecheckBtns(true);
    _filecheckWidget.update({ barPct: null, label: data.mode === 'purge' ? 'Removing…' : 'Scanning…' });
    return;
  }
  _jobPollStop('filecheck');
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
}

async function triggerFileScan() {
  _setFilecheckBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/scan', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start the job', { type: 'error' }); _setFilecheckBtns(false); return; }
  _filecheckWidget.update({ barPct: null, label: 'Scanning…' });
  _filecheckReport.hide();
  _jobPollStart('filecheck', _filecheckTick, 1000);
}

async function triggerFilePurge() {
  if (!await openConfirm({ title: 'Remove missing-file records?', message: 'All DB records for files missing on disk are removed. This cannot be undone.', confirmLabel: 'Remove', danger: true })) return;
  _setFilecheckBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/file-check/purge', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start the job', { type: 'error' }); _setFilecheckBtns(false); return; }
  _filecheckWidget.update({ barPct: null, label: 'Removing…' });
  _filecheckReport.hide();
  _jobPollStart('filecheck', _filecheckTick, 1000);
}

// ── Corrupted story recovery ─────────────────────────────────────────────────

function _setStoryfixBtns(disabled) {
  const scan = document.getElementById('job-storyfix-scan-btn');
  const redl = document.getElementById('job-storyfix-redl-btn');
  if (scan) scan.disabled = disabled;
  if (redl) redl.disabled = disabled;
}

const _nStory = n => _n(n, 'story', 'stories');

// Which action the current or last run was; the status payload has no mode
// field, so a poll resumed after a pane reopen assumes scan
let _storyfixMode = 'scan';

async function _storyfixTick() {
  const { ok, data } = await apiJSON('/api/tiktok/jobs/story-recovery/status');
  if (!ok) return;
  if (data.running) {
    _setStoryfixBtns(true);
    _storyfixWidget.update({ barPct: null, label: _storyfixMode === 'redownload'
      ? `Re-downloading stories… ${data.recovered || 0} done`
      : 'Scanning saved stories…' });
    return;
  }
  _jobPollStop('storyfix');
  _setStoryfixBtns(false);

  if (_storyfixMode === 'scan') {
    const afflicted = (data.corrupt || 0) + (data.missing || 0);
    if (!afflicted) { _storyfixWidget.update({ label: 'No corrupted or missing stories found.' }); return; }
    const parts = [];
    if (data.live_video) parts.push(`${data.live_video} live video re-downloadable`);
    if (data.live_photo) parts.push(`${data.live_photo} live photo (recovered on next check)`);
    if (data.expired)    parts.push(`${data.expired} expired`);
    _storyfixWidget.update({ label: `${_nStory(afflicted)} corrupted or missing: ${parts.join(', ')}.` });
    return;
  }
  const parts = [];
  if (data.recovered)     parts.push(`${_nStory(data.recovered)} re-downloaded`);
  if (data.purged)        parts.push(`${_nStory(data.purged)} expired and unrecoverable, removed from the library`);
  if (data.still_failing) parts.push(`${_nStory(data.still_failing)} failed to re-download`);
  if (!parts.length) {
    parts.push(data.live_photo
      ? `No video stories to re-download; ${data.live_photo} live photo left for the next check`
      : 'No corrupted stories to re-download');
  }
  _storyfixWidget.update({ label: parts.join(' · ') + '.' });
}

async function triggerStoryScan() {
  _setStoryfixBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/story-recovery/scan', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start the job', { type: 'error' }); _setStoryfixBtns(false); return; }
  _storyfixMode = 'scan';
  _storyfixWidget.update({ barPct: null, label: 'Scanning saved stories…' });
  _jobPollStart('storyfix', _storyfixTick, 1500);
}

async function triggerStoryRedownload() {
  if (!await openConfirm({
    title: 'Re-download corrupted stories?',
    message: 'Live corrupted stories are re-fetched. Expired corrupted stories cannot be recovered; their files and records are removed. This cannot be undone.',
    confirmLabel: 'Re-download', danger: true,
  })) return;
  _setStoryfixBtns(true);
  const { ok, data } = await apiJSON('/api/tiktok/jobs/story-recovery/redownload', { method: 'POST' });
  if (!ok) { showToast(data.error || 'Could not start the job', { type: 'error' }); _setStoryfixBtns(false); return; }
  _storyfixMode = 'redownload';
  _storyfixWidget.update({ barPct: null, label: 'Re-downloading corrupted stories…' });
  _jobPollStart('storyfix', _storyfixTick, 1500);
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
                     { value: "item_list_from_db",   label: "item_list from DB (mirrors the loop; paste @username)" },
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
    ? 'Running… paginates with delays; allow several minutes for large sounds/accounts'
    : 'Running… (this may take up to 30 s for TikTokApi calls)';

  const { ok, data } = await apiJSON('/api/tiktok/debug/fetch', {
    method: 'POST',
    body: JSON.stringify({ source, action, input: inp }),
  });

  btn.disabled = false;
  outEl.textContent = ok ? (data.output ?? JSON.stringify(data, null, 2))
                         : (data?.output || data?.error || 'Could not complete the request.');

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
  copyText(document.getElementById('diagOutput').textContent || '');
}

// ── Stats backfill ────────────────────────────────────────────────────────────

async function _backfillTick() {
  const { ok, data } = await apiJSON('/api/tiktok/backfill');
  if (!ok) return;
  const btn = document.getElementById('backfillBtn');
  if (data.running) {
    if (btn) btn.disabled = true;
    const total = data.total || 0;
    _backfillWidget.update({
      barPct: total ? Math.round((data.done || 0) / total * 100) : null,
      label:  `Backfilling… ${data.done}/${data.total}`,
    });
    return;
  }
  _jobPollStop('backfill');
  if (btn) btn.disabled = false;
  if (data.total === 0) {
    _backfillWidget.update({ label: 'Nothing to backfill.' });
  } else {
    const okCount = (data.done || 0) - (data.errors || 0);
    _backfillWidget.update({ barPct: 100, label: `Done: ${okCount} updated, ${data.errors || 0} failed` });
  }
}

async function triggerBackfill() {
  const btn = document.getElementById('backfillBtn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/backfill', { method: 'POST' });
  if (!ok) {
    showToast(data.error || 'Could not start backfill', { type: 'error' });
    btn.disabled = false;
    return;
  }
  _backfillWidget.update({ barPct: null, label: 'Starting…' });
  _jobPollStart('backfill', _backfillTick, 2000);
}

async function retryFailed() {
  const btn = document.getElementById('retryFailedBtn');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/tiktok/backfill/reset-errors', { method: 'POST' });
  btn.disabled = false;
  if (!ok) { showToast(data.error || 'Could not clear failed videos', { type: 'error' }); return; }
  showToast(`${_n(data.reset, 'video')} cleared, ready to retry.`, { type: 'success' });
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
  if (!ok) { el.textContent = 'Could not load.'; return; }
  if (!data.length) { el.textContent = 'None.'; return; }
  el.innerHTML = data.map(v =>
    `<div><code style="user-select:all">${esc(v.video_id)}</code>`
    + ` · @${esc(v.handle)}`
    + (v.stats_last_error ? ` · <span style="color:var(--red)">${esc(v.stats_last_error)}</span>` : '')
    + `</div>`
  ).join('');
}

async function resetBackfillStep() {
  if (!await openConfirm({
    title: 'Reset all backfill status?',
    message: 'Every video is marked as needing a stats backfill; the next run re-fetches all of them.',
    confirmLabel: 'Reset',
  })) return;
  const btn = document.getElementById('resetBackfillBtn');
  btn.disabled = true;
  const t = showToast('Resetting…', { spinner: true, duration: 0 });
  const { ok, data } = await apiJSON('/api/tiktok/backfill/reset', { method: 'POST' });
  btn.disabled = false;
  if (!ok) t.update(data.error || 'Could not reset the backfill status', { type: 'error' });
  else t.update(`Done. ${data.reset.toLocaleString()} videos marked for re-backfill.`, { type: 'success' });
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
window.addEventListener('platformswitch', () => { if (_ttTabActive()) { loadCookies(); loadSounds(); } });
_initAllGliders();
