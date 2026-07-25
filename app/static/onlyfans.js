// OnlyFans app: config for the shared channel engine (channels.js).

initChannelApp({
  id:                'onlyfans',
  prefix:            'of',
  api:               '/api/onlyfans',
  creatorNoun:       'creator',
  creatorNounPlural: 'creators',
  itemNoun:          'post',
  itemNounPlural:    'posts',
  subLabelCard:      'subscribers',
  subLabelModal:     'subscribers',
  subLabelSort:      'Subscribers',
  uploadDateLabel:   'Posted',
  loopLabel:         'Creator Loop',
  addPlaceholder:    '@username or profile URL',
  addAriaLabel:      'OnlyFans username',
  profileUrl:        h => `https://onlyfans.com/${h}`,
  videoUrl:          (v, ch) => `https://onlyfans.com/${ch.handle}`,
  settings: {
    account: {
      html: _cookiesPaneHtml('ofCookie', {
        site: 'onlyfans.com',
        uploadFn: 'ofUploadCookies',
        deleteFn: 'ofDeleteCookies',
        note: `Upload an <code>auth.json</code> from a logged-in OnlyFans session (cookie with auth_id and sess, plus x_bc and user_agent). A plain cookies.txt is not enough: OnlyFans keeps x-bc outside cookies.`,
      }),
      onShow: () => ofLoadCookies(),
    },
    diag: {
      html: _diagPaneHtml('ofDiag', {
        note: 'Run API calls and inspect the response. Requires uploaded OnlyFans auth.',
        placeholder: 'OnlyFans username or profile URL',
        runFn: 'ofDiagRun', copyFn: 'ofDiagCopy',
        actions: [{ value: 'profile', label: 'Profile info' }, { value: 'posts', label: 'First 5 posts' }],
      }),
    },
  },
});

// Settings (cookies)
async function ofLoadCookies()        { return _cookiesLoad('onlyfans', 'ofCookie'); }
async function ofUploadCookies(/** @type {any} */ input) { return _cookiesUpload('onlyfans', 'ofCookie', input); }
async function ofDeleteCookies()      { return _cookiesDelete('onlyfans', 'ofCookie'); }

// Diagnostics
function ofDiagRun()  { _platformDiagRun('onlyfans', 'ofDiag'); }
function ofDiagCopy() { _platformDiagCopy('ofDiag'); }

// Load cookie state at startup
ofLoadCookies();
