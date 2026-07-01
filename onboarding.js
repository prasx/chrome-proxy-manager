// ============= ONBOARDING — СЛАЙДЕР =============

const dots = document.querySelectorAll('.step-dot');
const slides = document.querySelectorAll('.slide');
let current = 0;

function goTo(idx) {
  slides.forEach((s, i) => s.classList.toggle('active', i === idx));
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === idx);
    d.classList.toggle('done', i < idx);
  });
  current = idx;
}

document.querySelectorAll('.next-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (current === 2) {
      const host = document.getElementById('onboardHost').value.trim();
      const port = parseInt(document.getElementById('onboardPort').value, 10);
      if (!host || !port || port < 1 || port > 65535) {
        const hint = document.getElementById('onboardHint');
        if (hint) hint.style.display = 'block';
        return;
      }
      const name = document.getElementById('onboardName').value.trim() || host;
      const type = document.getElementById('onboardType').value;
      const user = document.getElementById('onboardUser').value.trim();
      const pass = document.getElementById('onboardPass').value.trim();

      chrome.storage.local.get(['proxies'], (d) => {
        const proxies = d.proxies || [];
        const existing = proxies.find(p => p.host === host && p.port === port);
        if (existing) {
          Object.assign(existing, { name, host, port, type, username: user, password: pass, enabled: true });
        } else {
          proxies.unshift({ id: crypto.randomUUID(), name, host, port, type, enabled: true, username: user, password: pass });
        }
        chrome.storage.local.set({ proxies, activeProxyId: proxies[0].id }, () => {
          if (current < slides.length - 1) goTo(current + 1);
        });
      });
    } else {
      if (current < slides.length - 1) goTo(current + 1);
    }
  });
});

document.querySelectorAll('.prev-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (current > 0) goTo(current - 1);
  });
});

document.getElementById('finishBtn').addEventListener('click', () => {
  chrome.storage.local.set({ onboardingComplete: true }, () => {
    window.location.href = chrome.runtime.getURL('dashboard.html');
  });
});
