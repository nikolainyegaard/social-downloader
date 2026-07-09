// Twitter app: thin config over the shared channel engine (channels.js).
// All cards, modals, filters, loop panel, and polling live in initChannelApp;
// only Twitter's authentication (cookies) and diagnostics wiring lives here.

initChannelApp({
  id:                'twitter',
  prefix:            'tw',
  api:               '/api/twitter',
  creatorNoun:       'account',
  creatorNounPlural: 'accounts',
  itemNoun:          'tweet',
  itemNounPlural:    'tweets',
  subLabelCard:      'followers',
  subLabelModal:     'followers',
  subLabelSort:      'Followers',
  uploadDateLabel:   'Posted',
  loopLabel:         'Account Loop',
  addPlaceholder:    '@username or profile URL',
  addAriaLabel:      'Twitter username',
  profileUrl:        h => `https://twitter.com/${h}`,
});

// ── Settings (cookies + schedule) ─────────────────────────────────────────────

async function twLoadCookies()        { return _cookiesLoad('twitter', 'twCookie'); }
async function twUploadCookies(input) { return _cookiesUpload('twitter', 'twCookie', input); }
async function twDeleteCookies()      { return _cookiesDelete('twitter', 'twCookie'); }

async function loadTwSettings() {
  twLoadCookies();
  return _scheduleSettingsLoad('twitter', 'twSettings');
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

function twDiagRun()  { _platformDiagRun('twitter', 'twDiag'); }
function twDiagCopy() { _platformDiagCopy('twDiag'); }

// Load cookie state at startup so the header auth pill is correct.
twLoadCookies();
