// OnlyFans app: config for the shared channel engine (channels.js).

initChannelApp({
  id:                'onlyfans',
  prefix:            'of',
  api:               '/api/onlyfans',
  creatorNoun:       'creator',
  creatorNounPlural: 'creators',
  itemNoun:          'post',
  itemNounPlural:    'posts',
  hasStories:        true,
  subLabelCard:      'subscribers',
  subLabelModal:     'subscribers',
  subLabelSort:      'Subscribers',
  uploadDateLabel:   'Posted',
  loopLabel:         'Creator Loop',
  addPlaceholder:    '@username or profile URL',
  addAriaLabel:      'OnlyFans username',
  profileUrl:        h => `https://onlyfans.com/${h}`,
  videoUrl:          (v, ch) => `https://onlyfans.com/${v.video_id}/${ch.handle}`,
  settings: {
    account: {
      html: _cookiesPaneHtml('ofCookie', {
        site: 'onlyfans.com',
        uploadFn: 'ofUploadCookies',
        deleteFn: 'ofDeleteCookies',
        uploadLabel: 'Upload auth.json',
        accept: '.json,application/json',
        extBlock: `Generate an <code>auth.json</code> from a logged-in onlyfans.com session using the <strong>OF-DL Auth Helper</strong> extension:
          <div style="display:flex;gap:8px;margin:10px 0 8px;flex-wrap:wrap">
            <a href="https://github.com/whimsical-c4lic0/OF-DL-Auth-Helper/releases" class="browser-ext-link" target="_blank" rel="noopener noreferrer">OF-DL Auth Helper (Chrome / Firefox)</a>
          </div>`,
        note: `The file carries a cookie with auth_id and sess, plus x_bc and user_agent. A plain cookies.txt is not enough: OnlyFans keeps x-bc outside cookies.`,
      }),
      onShow: () => ofLoadCookies(),
    },
    jobs: {
      html: `
        <div class="job-card">
          <div class="job-card-hdr">
            <div style="flex:1">
              <div class="job-card-title">Strip stored HTML</div>
              <div class="job-card-desc">
                Rewrites creator bios and post titles saved before the HTML
                cleanup existed: br and p tags become line breaks, entities
                like &amp;lt;3 are decoded. Already-clean rows are left
                untouched, so this is safe to run repeatedly.
              </div>
            </div>
            <button class="btn-primary" id="job-of-cleanhtml-btn" onclick="ofCleanHtml()" style="flex-shrink:0;align-self:flex-start">Run</button>
          </div>
          <div class="job-status" id="job-of-cleanhtml-status" style="display:none">
            <div class="job-status-text" id="job-of-cleanhtml-text"></div>
          </div>
        </div>`,
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

// Jobs
async function ofCleanHtml() {
  const btn    = document.getElementById('job-of-cleanhtml-btn');
  const status = document.getElementById('job-of-cleanhtml-status');
  const text   = document.getElementById('job-of-cleanhtml-text');
  btn.disabled = true;
  const { ok, data } = await apiJSON('/api/onlyfans/jobs/clean-html', { method: 'POST' });
  btn.disabled = false;
  status.style.display = '';
  if (!ok) { text.textContent = data.error || 'Job failed'; return; }
  text.textContent = data.rewrote
    ? `Rewrote ${data.rewrote} row${data.rewrote === 1 ? '' : 's'} (${data.results.filter(r => r.dirty).map(r => `${r.column}: ${r.dirty}`).join(', ')})`
    : 'Nothing to rewrite: all stored rows are clean';
}

// Diagnostics
function ofDiagRun()  { _platformDiagRun('onlyfans', 'ofDiag'); }
function ofDiagCopy() { _platformDiagCopy('ofDiag'); }

// Load cookie state at startup
ofLoadCookies();
