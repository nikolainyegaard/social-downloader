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
  videoUrl:          (v, ch) => `https://x.com/${ch.handle}/status/${v.video_id}`,
  settings: {
    account: {
      html: _cookiesPaneHtml('twCookie', {
        site: 'x.com',
        uploadFn: 'twUploadCookies',
        deleteFn: 'twDeleteCookies',
        note: `The file must be in Netscape format and include the <code>auth_token</code> and <code>ct0</code> cookies.
          Twitter requires a logged-in session for timeline access; to fetch sensitive media the account
          must have "Display media that may contain sensitive content" enabled in its settings.`,
      }),
      onShow: () => twLoadCookies(),
    },
    diag: {
      html: _diagPaneHtml('twDiag', {
        note: 'Run raw gallery-dl API calls and inspect the response. Requires uploaded Twitter cookies.',
        placeholder: 'Twitter handle or profile URL',
        runFn: 'twDiagRun', copyFn: 'twDiagCopy',
        actions: [{ value: 'profile', label: 'Profile info' }, { value: 'posts', label: 'First 5 posts' }],
      }),
    },
  },
});

// ── Settings (cookies) ────────────────────────────────────────────────────────

async function twLoadCookies()        { return _cookiesLoad('twitter', 'twCookie'); }
async function twUploadCookies(input) { return _cookiesUpload('twitter', 'twCookie', input); }
async function twDeleteCookies()      { return _cookiesDelete('twitter', 'twCookie'); }

// ── Diagnostics ───────────────────────────────────────────────────────────────

function twDiagRun()  { _platformDiagRun('twitter', 'twDiag'); }
function twDiagCopy() { _platformDiagCopy('twDiag'); }

// Load cookie state at startup so the header auth pill is correct.
twLoadCookies();
