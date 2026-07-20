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

// ── Settings (cookies + schedule) ─────────────────────────────────────────────

async function igLoadCookies()        { return _cookiesLoad('instagram', 'igCookie'); }
async function igUploadCookies(input) { return _cookiesUpload('instagram', 'igCookie', input); }
async function igDeleteCookies()      { return _cookiesDelete('instagram', 'igCookie'); }

async function loadIgSettings() {
  igLoadCookies();
  return _scheduleSettingsLoad('instagram', 'igSettings');
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

function igDiagRun()  { _platformDiagRun('instagram', 'igDiag'); }
function igDiagCopy() { _platformDiagCopy('igDiag'); }

// Load cookie state at startup so the header auth pill is correct.
igLoadCookies();
