// YouTube app: thin config over the shared channel engine (channels.js).
// All cards, modals, filters, loop panel, and polling live in initChannelApp;
// YouTube adds shorts-aware grid views, the channel banner, and its own
// diagnostics wiring.

const _wideGridIcon   = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x=".75" y="2" width="5.25" height="3" rx=".5"/><rect x="7" y="2" width="5.25" height="3" rx=".5"/><rect x=".75" y="8" width="5.25" height="3" rx=".5"/><rect x="7" y="8" width="5.25" height="3" rx=".5"/></svg>`;
const _vgridShortIcon = `<svg width="12" height="12" viewBox="0 0 9 9" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.2"><rect x="1.5" y=".5" width="6" height="8" rx=".75"/><polygon fill="rgba(255,255,255,.9)" stroke="none" points="3,2.5 7,4.5 3,6.5"/></svg>`;
const _ytShortsBadge  = `<span style="position:absolute;bottom:4px;right:4px;color:#fff;pointer-events:none;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))"><svg width="18" height="18" viewBox="0 0 9 9" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.2"><rect x="1.5" y=".5" width="6" height="8" rx=".75"/><polygon fill="rgba(255,255,255,.9)" stroke="none" points="3,2.5 7,4.5 3,6.5"/></svg></span>`;

initChannelApp({
  id:                'youtube',
  prefix:            'yt',
  api:               '/api/youtube',
  creatorNoun:       'channel',
  creatorNounPlural: 'channels',
  itemNoun:          'video',
  itemNounPlural:    'videos',
  subLabelCard:      'subscribers',
  subLabelModal:     'subscribers',
  subLabelSort:      'Subscribers',
  uploadDateLabel:   'Uploaded',
  loopLabel:         'Channel Loop',
  addPlaceholder:    '@handle or channel URL',
  addAriaLabel:      'YouTube channel handle or URL',
  profileUrl:        h => `https://www.youtube.com/@${h}`,
  videoUrl:          v => `https://www.youtube.com/watch?v=${v.video_id}`,
  fieldLabels: {
    handle: 'Handle', display_name: 'Display name', description: 'Description',
    avatar: 'Avatar', banner: 'Banner',
  },
  hasBanner:  true,
  // yt-dlp only provides a calendar date for uploads, no time of day
  uploadDateOnly: true,
  thumbBadge: v => v.content_type === 'short' ? _ytShortsBadge : _playBadge,
  viewKeys: [
    { key: 'list',   icon: _listViewIcon, title: 'List view' },
    { key: 'videos', icon: _wideGridIcon, title: 'Videos grid' },
    { key: 'shorts', icon: _gridViewIcon, title: 'Shorts grid' },
  ],
  viewVideoFilter: (view, vids) => {
    if (view === 'videos') return vids.filter(v => v.content_type !== 'short');
    if (view === 'shorts') return vids.filter(v => v.content_type === 'short');
    return vids;
  },
  gridClassFn: view => view === 'videos' ? 'video-grid--wide' : '',
  typeIconFn:  v => v.content_type === 'short' ? _vgridShortIcon : _vgridPlayIcon,
  settings: {
    account: {
      html: `<p class="settings-note" style="margin-top:4px">YouTube fetches public data with yt-dlp and needs no login.</p>`,
    },
    diag: {
      html: _diagPaneHtml('ytDiag', {
        note: `Runs yt-dlp flat extraction on a channel and returns the first 5 entries per tab
          (Videos, Shorts, Streams) with all raw fields. Useful for checking which date
          fields yt-dlp returns.`,
        placeholder: 'Channel ID (UCxxx) or @handle',
        runFn: 'ytDiagRun', copyFn: 'ytDiagCopy',
      }),
    },
  },
});

// ── Diagnostics ───────────────────────────────────────────────────────────────

async function ytDiagRun() {
  const input  = document.getElementById('ytDiagInput');
  const output = document.getElementById('ytDiagOutput');
  const btn    = document.getElementById('ytDiagRunBtn');
  let val = (input?.value || '').trim().replace(/^@/, '');
  if (!val) { showToast('Enter a channel ID or @handle.', { type: 'warning', duration: 4000 }); return; }

  if (!val.startsWith('UC')) {
    const ch = ytGetCreators().find(c => c.handle.toLowerCase() === val.toLowerCase());
    if (!ch) { showToast(`@${val} not found in tracked channels. Enter the channel ID (UCxxx) directly or add the channel first.`, { type: 'warning', duration: 6000 }); return; }
    val = ch.channel_id;
  }

  btn.disabled = true;
  output.textContent = 'Running…';
  const { ok, data } = await apiJSON('/api/youtube/debug/channel-videos', {
    method: 'POST',
    body: JSON.stringify({ channel_id: val }),
  });
  btn.disabled = false;
  output.textContent = JSON.stringify(data, null, 2);
}

function ytDiagCopy() {
  copyText(document.getElementById('ytDiagOutput')?.textContent || '');
}
