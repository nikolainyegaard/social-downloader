const PLATFORMS = ['tiktok', 'youtube'];

function switchPlatform(name) {
  if (!PLATFORMS.includes(name)) name = 'tiktok';
  history.replaceState(null, '', '#' + name);
  document.querySelectorAll('.platform-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.platform === name);
  });
  PLATFORMS.forEach(p => {
    const el = document.getElementById('platform-' + p);
    if (el) el.style.display = p === name ? '' : 'none';
  });
  const app = document.querySelector('.app');
  PLATFORMS.forEach(p => app.classList.remove('theme-' + p));
  app.classList.add('theme-' + name);
  if (typeof _initAllGliders === 'function') _initAllGliders();
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
