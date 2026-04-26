const PLATFORMS = [
  { id: 'tiktok',  label: 'TikTok'  },
  { id: 'youtube', label: 'YouTube' },
];

function switchPlatform(name) {
  if (!PLATFORMS.some(p => p.id === name)) name = 'tiktok';
  history.replaceState(null, '', '#' + name);
  document.querySelectorAll('.platform-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.platform === name);
  });
  PLATFORMS.forEach(p => {
    const el = document.getElementById('platform-' + p.id);
    if (el) el.style.display = p.id === name ? '' : 'none';
  });
  const app = document.querySelector('.app');
  PLATFORMS.forEach(p => app.classList.remove('theme-' + p.id));
  app.classList.add('theme-' + name);
  if (typeof _initAllGliders === 'function') _initAllGliders();
}

// ── Settings platform tabs ────────────────────────────────────────────────────
// Call initSettingsPlatformTabs(sectionId) once for any settings section that
// has per-platform panes. It renders the tab buttons from PLATFORMS and wires
// up switching. Panes must be <div id="{sectionId}-{platformId}">.

function initSettingsPlatformTabs(sectionId) {
  const container = document.getElementById(sectionId + '-tabs');
  if (!container) return;
  container.innerHTML = PLATFORMS.map((p, i) =>
    `<button class="settings-sub-tab${i === 0 ? ' active' : ''}" id="stab-${sectionId}-${p.id}" onclick="switchSettingsPlatformTab('${sectionId}','${p.id}')">${p.label}</button>`
  ).join('');
  PLATFORMS.forEach((p, i) => {
    const pane = document.getElementById(sectionId + '-' + p.id);
    if (pane) pane.style.display = i === 0 ? '' : 'none';
  });
}

function switchSettingsPlatformTab(sectionId, platformId) {
  PLATFORMS.forEach(p => {
    const btn  = document.getElementById(`stab-${sectionId}-${p.id}`);
    const pane = document.getElementById(`${sectionId}-${p.id}`);
    const active = p.id === platformId;
    if (btn)  btn.classList.toggle('active', active);
    if (pane) pane.style.display = active ? '' : 'none';
  });
}

window.addEventListener('hashchange', () => {
  switchPlatform(location.hash.slice(1) || 'tiktok');
});

switchPlatform(location.hash.slice(1) || 'tiktok');

// ── Health banner ─────────────────────────────────────────────────────────────

function _showHealthBanner(issues) {
  const existing = document.getElementById('_healthBanner');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = '_healthBanner';
  el.className = 'health-banner';
  for (const iss of issues) {
    const p = document.createElement('p');
    p.textContent = iss.message;
    el.appendChild(p);
  }
  document.body.prepend(el);
}

async function checkHealth() {
  try {
    const data = await fetch('/api/health').then(r => r.json());
    if (!data.ok && data.issues && data.issues.length) {
      _showHealthBanner(data.issues);
    } else {
      const el = document.getElementById('_healthBanner');
      if (el) el.remove();
    }
  } catch (_) {}
}

checkHealth();
