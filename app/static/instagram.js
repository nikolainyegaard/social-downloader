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
  viewsLabel:        'Likes',   // the feed API has no view counts (reels-only play_count); likes fill the column
  loopLabel:         'Profile loop',
  addPlaceholder:    '@username or profile URL',
  addAriaLabel:      'Instagram username',
  profileUrl:        h => `https://www.instagram.com/${h}`,
  videoUrl:          v => `https://www.instagram.com/p/${v.video_id}/`,
  hasStories:        true,
  settings: {
    account: {
      html: _cookiesPaneHtml('igCookie', {
        site: 'instagram.com',
        uploadFn: 'igUploadCookies',
        deleteFn: 'igDeleteCookies',
        note: `The file must be in Netscape format and include the <code>sessionid</code> and <code>csrftoken</code> cookies.
          Instagram rate limits sessions created by password logins from tools, so cookies exported from a real
          browser session are the reliable way in. Profile lookups, post fetching, and stories all need them.`,
      }),
      onShow: () => igLoadCookies(),
    },
    diag: {
      html: _diagPaneHtml('igDiag', {
        note: 'Run raw instaloader API calls and inspect the response. Requires a public account.',
        placeholder: 'Instagram handle or profile URL',
        runFn: 'igDiagRun', copyFn: 'igDiagCopy',
        actions: [{ value: 'profile', label: 'Profile info' }, { value: 'posts', label: 'First 5 posts' }],
      }),
    },
  },
});

// ── Settings (cookies) ────────────────────────────────────────────────────────

async function igLoadCookies()        { return _cookiesLoad('instagram', 'igCookie'); }
async function igUploadCookies(input) { return _cookiesUpload('instagram', 'igCookie', input); }
async function igDeleteCookies()      { return _cookiesDelete('instagram', 'igCookie'); }

// ── Diagnostics ───────────────────────────────────────────────────────────────

function igDiagRun()  { _platformDiagRun('instagram', 'igDiag'); }
function igDiagCopy() { _platformDiagCopy('igDiag'); }

// Load cookie state at startup so the header auth pill is correct.
igLoadCookies();
