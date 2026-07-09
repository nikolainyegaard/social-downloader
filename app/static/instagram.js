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
  const user     = (document.getElementById('igLoginUser')?.value || '').trim();
  const pass     = document.getElementById('igLoginPass')?.value || '';
  const btn      = document.getElementById('igLoginBtn');
  const statusEl = document.getElementById('igLoginStatus');
  if (!user || !pass) { if (statusEl) statusEl.textContent = 'Enter username and password.'; return; }
  btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Logging in...'; statusEl.style.color = 'var(--muted)'; }
  const { ok, data } = await apiJSON('/api/instagram/session', {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  btn.disabled = false;
  if (ok) {
    if (statusEl) statusEl.textContent = '';
    const passEl = document.getElementById('igLoginPass');
    if (passEl) passEl.value = '';
    loadIgSessionStatus();
    showToast(`Logged in as @${data.username}`, { type: 'success', duration: 3000 });
  } else {
    if (statusEl) { statusEl.textContent = data.error || 'Login failed.'; statusEl.style.color = 'var(--red)'; }
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
