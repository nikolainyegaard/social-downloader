// Instagram app: thin config over the shared channel engine (channels.js).
// All cards, modals, filters, loop panel, and polling live in initChannelApp;
// only Instagram's authentication (instaloader session) and diagnostics wiring
// lives here.

initChannelApp({
  id:                'instagram',
  prefix:            'ig',
  api:               '/api/instagram',
  creatorNoun:       'profile',
  creatorNounPlural: 'profiles',
  itemNoun:          'post',
  itemNounPlural:    'posts',
  subLabelCard:      'followers',
  subLabelModal:     'followers',
  subLabelSort:      'Followers',
  uploadDateLabel:   'Uploaded',
  loopLabel:         'Profile Loop',
  addPlaceholder:    '@username or profile URL',
  addAriaLabel:      'Instagram username',
  profileUrl:        h => `https://www.instagram.com/${h}`,
  hasStories:        true,
});

// ── Settings (session login + schedule) ───────────────────────────────────────

async function loadIgSessionStatus() {
  const { ok, data } = await apiJSON('/api/instagram/session');
  if (!ok) return;
  setHdrAuth('instagram', !!data.logged_in, data.logged_in ? 'Logged in' : 'Not logged in');
  const pill      = document.getElementById('igSessionPill');
  const pillTxt   = document.getElementById('igSessionPillText');
  const logoutBtn = document.getElementById('igSessionLogoutBtn');
  const loginForm = document.getElementById('igLoginForm');
  if (!pill) return;
  if (data.logged_in) {
    pill.className      = 'cookie-pill present';
    pillTxt.textContent = `Logged in as @${data.username}`;
    if (logoutBtn) logoutBtn.style.display = '';
    if (loginForm) loginForm.style.display = 'none';
  } else {
    pill.className      = 'cookie-pill absent';
    pillTxt.textContent = data.saved_username ? `Session saved (@${data.saved_username})` : 'Not logged in';
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (loginForm) loginForm.style.display = '';
  }
}

async function igSessionLogin() {
  const user = (document.getElementById('igLoginUser')?.value || '').trim();
  const pass = document.getElementById('igLoginPass')?.value || '';
  const btn  = document.getElementById('igLoginBtn');
  if (!user || !pass) { showToast('Enter username and password.', { type: 'warning' }); return; }
  btn.disabled = true;
  const t = showToast('Logging in…', { spinner: true, duration: 0 });
  const { ok, data } = await apiJSON('/api/instagram/session', {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  btn.disabled = false;
  if (ok) {
    const passEl = document.getElementById('igLoginPass');
    if (passEl) passEl.value = '';
    loadIgSessionStatus();
    t.update(`Logged in as @${data.username}`, { type: 'success' });
  } else {
    t.update(data.error || 'Login failed.', { type: 'error' });
  }
}

async function igCookieLogin() {
  const user    = (document.getElementById('igCookieUser')?.value || '').trim().replace(/^@/, '');
  const cookies = (document.getElementById('igCookieStr')?.value || '').trim();
  const btn     = document.getElementById('igCookieBtn');
  if (!user || !cookies) { showToast('Enter username and the cookie header.', { type: 'warning' }); return; }
  btn.disabled = true;
  const t = showToast('Checking session…', { spinner: true, duration: 0 });
  const { ok, data } = await apiJSON('/api/instagram/session', {
    method: 'POST',
    body: JSON.stringify({ username: user, cookies }),
  });
  btn.disabled = false;
  if (ok) {
    const cookieEl = document.getElementById('igCookieStr');
    if (cookieEl) cookieEl.value = '';
    loadIgSessionStatus();
    t.update(`Logged in as @${data.username}`, { type: 'success' });
  } else {
    t.update(data.error || 'Session import failed.', { type: 'error' });
  }
}

async function igSessionLogout() {
  const { ok } = await apiJSON('/api/instagram/session', { method: 'DELETE' });
  if (ok) {
    loadIgSessionStatus();
    showToast('Logged out.', { type: 'success', duration: 2500 });
  }
}

async function loadIgSettings() {
  loadIgSessionStatus();
  return _scheduleSettingsLoad('instagram', 'igSettings');
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

function igDiagRun()  { _platformDiagRun('instagram', 'igDiag'); }
function igDiagCopy() { _platformDiagCopy('igDiag'); }

// Load session state at startup so the header auth pill is correct.
loadIgSessionStatus();
