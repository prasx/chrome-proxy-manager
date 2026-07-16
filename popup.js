// ============= POPUP — КЭШ =============

let cachedData = {
  proxyList: [], directList: [], proxies: [],
  activeProxyId: null, extensionEnabled: true, autoProxyEnabled: true
};

function domainInList(domain, list) {
  return list.some(s => s.value.toLowerCase() === domain.toLowerCase());
}

// ============= DOM =============

const $ = id => document.getElementById(id);
const toggleBtn = $('toggleBtn');
const statusDot = $('statusDot');
const statusText = $('statusText');
const proxyName = $('proxyName');
const proxyAddress = $('proxyAddress');
const latencyDot = $('latencyDot');
const latencyText = $('latencyText');
const dashboardBtn = $('dashboardBtn');
const modeChips = document.querySelectorAll('.mode-chip');
const statSessions = $('statSessions');
const statProxy = $('statProxy');
const statDirect = $('statDirect');

// ============= НАВИГАЦИЯ =============

dashboardBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));

// ============= ТОГГЛ =============

function updateMainToggle(enabled) {
  toggleBtn.classList.toggle('active', enabled);
  toggleBtn.querySelector('.toggle-label').textContent = enabled ? 'Вкл' : 'Выкл';
  statusDot.className = 'status-dot' + (enabled ? '' : ' disconnected');
  statusText.className = 'status-text' + (enabled ? '' : ' disconnected');
  statusText.textContent = enabled ? 'Подключено' : 'Отключено';
}

toggleBtn.addEventListener('click', () => {
  const newState = !cachedData.extensionEnabled;
  cachedData.extensionEnabled = newState;
  chrome.storage.local.set({ extensionEnabled: newState }, () => {
    updateMainToggle(newState);
    clearBadge();
    if (newState) {
      measureLatency();
      autoCheckIp();
    } else {
      const statusIp = $('statusIp');
      if (statusIp) { statusIp.textContent = ''; statusIp.title = ''; }
      latencyText.textContent = '—';
      latencyDot.className = 'latency-dot';
    }
  });
});

// ============= РЕЖИМЫ =============

function updateModeChips() {
  modeChips.forEach(chip => {
    const mode = chip.dataset.mode;
    const active = mode === 'auto' ? cachedData.autoProxyEnabled : !cachedData.autoProxyEnabled;
    chip.classList.toggle('active', active && cachedData.extensionEnabled);
  });
  const hint = $('modeHint');
  if (hint) {
    hint.textContent = !cachedData.extensionEnabled ? '' :
      cachedData.autoProxyEnabled ? 'Недоступные сайты автоматически добавляются в прокси' : 'Только сайты из списка прокси идут через прокси-сервер';
  }
}

modeChips.forEach(chip => {
  chip.addEventListener('click', () => {
    const mode = chip.dataset.mode;
    const autoProxyEnabled = mode === 'auto';
    cachedData.extensionEnabled = true;
    cachedData.autoProxyEnabled = autoProxyEnabled;
    chrome.storage.local.set({ extensionEnabled: true, autoProxyEnabled }, () => {
      updateMainToggle(true);
      updateModeChips();
      clearBadge();
    });
  });
});

// ============= ИНФО О ПРОКСИ =============

function updateProxyInfo() {
  const activeProxy = findProxyById(cachedData.proxies, cachedData.activeProxyId);
  if (activeProxy && activeProxy.host && String(activeProxy.host).trim()) {
    proxyName.textContent = activeProxy.name || '—';
    proxyAddress.textContent = activeProxy.host + ':' + activeProxy.port + ' · ' + activeProxy.type;
  } else {
    proxyName.textContent = 'Нет активного прокси';
    proxyAddress.textContent = '—';
  }
}

function measureLatency() {
  if (!cachedData.extensionEnabled) {
    latencyText.textContent = '—';
    latencyDot.className = 'latency-dot';
    return;
  }
  const activeProxy = findProxyById(cachedData.proxies, cachedData.activeProxyId);
  if (!activeProxy || !activeProxy.host || !activeProxy.port || String(activeProxy.host).trim() === '') {
    latencyText.textContent = '—';
    latencyDot.className = 'latency-dot';
    return;
  }
  latencyText.textContent = '...';
  const start = performance.now();
  fetch('https://httpbin.org/get', { signal: AbortSignal.timeout(10000) })
    .then(() => {
      const ms = Math.round(performance.now() - start);
      latencyText.textContent = ms + ' ms';
      latencyDot.className = 'latency-dot' + (ms > 500 ? ' critical' : ms > 200 ? ' high' : '');
    })
    .catch(() => {
      latencyText.textContent = '—';
      latencyDot.className = 'latency-dot critical';
    });
}

// ============= СТАТИСТИКА =============

function loadStats() {
  chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
    if (!response || !response.stats) return;
    const stats = response.stats;
    statSessions.textContent = (stats.proxy || 0) + (stats.direct || 0);
    statProxy.textContent = stats.proxy || 0;
    statDirect.textContent = stats.direct || 0;
  });
}

const IP_SERVICES = [
  'https://api.ipify.org?format=json',
  'https://api64.ipify.org?format=json',
  'https://httpbin.org/ip'
];

function fetchWithFallback(services, index = 0) {
  if (index >= services.length) return Promise.reject(new Error('All IP services failed'));
  return fetch(services[index], { signal: AbortSignal.timeout(6000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(data => data.ip || data.origin || (data.error ? Promise.reject(new Error(data.error)) : null))
    .then(ip => ip || Promise.reject(new Error('No IP in response')))
    .catch(err => fetchWithFallback(services, index + 1));
}

function autoCheckIp() {
  const statusIp = $('statusIp');
  if (!cachedData.extensionEnabled) { statusIp.textContent = ''; return; }

  const activeProxy = findProxyById(cachedData.proxies, cachedData.activeProxyId);
  const configured = activeProxy && activeProxy.host && String(activeProxy.host).trim() && activeProxy.port;

  if (!configured) {
    statusIp.textContent = '—';
    return;
  }

  statusIp.textContent = '...';
  chrome.runtime.sendMessage({ action: 'getActiveProxyIp' }, (response) => {
    if (response?.success && response.ip) {
      const ip = response.ip;
      statusIp.textContent = ip;
      statusIp.title = 'Внешний IP через ' + activeProxy.name;
      fetch('https://ipwho.is/' + ip, { signal: AbortSignal.timeout(4000) })
        .then(r => r.json())
        .then(geo => {
          if (geo.success !== false && geo.country_code) {
            statusIp.textContent = ip + ' · ' + geo.country_code;
            statusIp.title = geo.city ? geo.city + ', ' + geo.country : geo.country;
          }
        })
        .catch(() => {});
    } else {
      statusIp.textContent = 'Прокси недоступен';
      statusIp.title = response?.error || 'Ошибка подключения к прокси';
    }
  });
}

// ============= ЗАГРУЗКА ДАННЫХ =============

const loadData = debounce(() => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled'], (data) => {
    cachedData.proxyList = data.proxyList || [];
    cachedData.directList = data.directList || [];
    cachedData.proxies = data.proxies || [];
    cachedData.activeProxyId = data.activeProxyId;
    cachedData.extensionEnabled = data.extensionEnabled !== false;
    cachedData.autoProxyEnabled = data.autoProxyEnabled !== false;
    clearBadge();
    updateMainToggle(cachedData.extensionEnabled);
    updateModeChips();
    updateProxyInfo();
    loadStats();
    measureLatency();
    autoCheckIp();
  });
}, 50);

// ============= АНАЛИЗ СТРАНИЦЫ =============

let analyzeState = {};

function updateAnalyzeList() {
  const box = $('relatedDomainsBox');
  const entries = Object.entries(analyzeState);
  if (entries.length === 0) { box.innerHTML = ''; return; }

  const itemsHtml = entries.map(([domain, mode]) => {
    const proxyActive = mode === 'proxy';
    const directActive = mode === 'direct';
    return `<div data-domain="${domain.replace(/"/g, '&quot;')}" style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg);border-radius:6px;">
      <span style="flex:1;font:400 12px/1 var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${domain.replace(/</g, '&lt;')}</span>
      <button class="analyze-proxy-btn" data-domain="${domain.replace(/"/g, '&quot;')}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1px solid var(--success);border-radius:4px;background:${proxyActive ? 'var(--success)' : 'transparent'};color:${proxyActive ? '#fff' : 'var(--success)'};cursor:pointer;">Proxy</button>
      <button class="analyze-direct-btn" data-domain="${domain.replace(/"/g, '&quot;')}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1px solid ${directActive ? 'var(--muted)' : 'var(--border)'};border-radius:4px;background:${directActive ? 'var(--muted)' : 'transparent'};color:${directActive ? '#fff' : 'var(--muted)'};cursor:pointer;">Direct</button>
    </div>`;
  }).join('');

  box.innerHTML = itemsHtml +
    '<div style="display:flex;gap:6px;margin-top:8px;">' +
    '<button class="btn btn-primary" style="flex:1;padding:6px;font-size:11px;" id="analyzeApply">Применить</button>' +
    '<button class="btn btn-secondary" style="flex:1;padding:6px;font-size:11px;" id="analyzeClear">Очистить</button></div>';

  box.querySelectorAll('.analyze-proxy-btn, .analyze-direct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.domain;
      const isProxy = btn.classList.contains('analyze-proxy-btn');
      analyzeState[d] = analyzeState[d] === (isProxy ? 'proxy' : 'direct') ? null : (isProxy ? 'proxy' : 'direct');
      updateAnalyzeList();
    });
  });

  $('analyzeApply')?.addEventListener('click', () => {
    const proxyAdds = [], directAdds = [];
    Object.entries(analyzeState).forEach(([domain, mode]) => {
      if (mode === 'proxy') proxyAdds.push(domain);
      else if (mode === 'direct') directAdds.push(domain);
    });
    if (proxyAdds.length === 0 && directAdds.length === 0) return;

    chrome.storage.local.get(['proxyList', 'directList'], (d) => {
      let proxyList = d.proxyList || [], directList = d.directList || [];
      proxyAdds.forEach(domain => {
        directList = directList.filter(s => s.value.toLowerCase() !== domain.toLowerCase());
        if (!domainInList(domain, proxyList)) proxyList.push({ id: crypto.randomUUID(), value: domain, enabled: true });
      });
      directAdds.forEach(domain => {
        proxyList = proxyList.filter(s => s.value.toLowerCase() !== domain.toLowerCase());
        if (!domainInList(domain, directList)) directList.push({ id: crypto.randomUUID(), value: domain, enabled: true });
      });
      chrome.storage.local.set({ proxyList, directList }, () => {
        analyzeState = {};
        loadData();
        $('relatedDomainsBox').innerHTML = '<div style="padding:8px;font-size:12px;color:var(--success);">Добавлено: ' + proxyAdds.length + ' в прокси, ' + directAdds.length + ' напрямую</div>';
      });
    });
  });

  $('analyzeClear')?.addEventListener('click', () => {
    analyzeState = {};
    updateAnalyzeList();
  });
}

$('analyzeBtn')?.addEventListener('click', () => {
  const box = $('relatedDomainsBox');
  box.style.display = 'block';
  box.innerHTML = '<div style="text-align:center;padding:12px;color:var(--muted);font-size:12px;">Загрузка...</div>';

  chrome.runtime.sendMessage({ action: 'getRelatedDomains' }, (response) => {
    if (!response || !response.mainDomain) {
      box.innerHTML = '<div style="text-align:center;padding:12px;color:var(--muted);font-size:12px;">Не удалось получить информацию</div>';
      return;
    }
    const { mainDomain, relatedDomains } = response;
    const allDomains = [mainDomain, ...relatedDomains.filter(d => d !== mainDomain)];
    analyzeState = {};
    allDomains.forEach(domain => {
      if (domainInList(domain, cachedData.proxyList)) analyzeState[domain] = 'proxy';
      else if (domainInList(domain, cachedData.directList)) analyzeState[domain] = 'direct';
      else analyzeState[domain] = null;
    });
    updateAnalyzeList();
  });
});

// ============= ОНБОРДИНГ =============

chrome.storage.local.get(['onboardingComplete'], (d) => {
  if (!d.onboardingComplete) chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});

// ============= ИНИЦИАЛИЗАЦИЯ =============

loadData();
