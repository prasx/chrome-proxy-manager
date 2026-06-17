// ============= УТИЛИТЫ =============
function sameProxyId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function findProxyById(proxies, id) {
  return (proxies || []).find(p => sameProxyId(p.id, id));
}

function isProxyConfigured(proxy) {
  return proxy && proxy.enabled !== false && proxy.host && String(proxy.host).trim() && proxy.port;
}

function escapePacString(str) {
  return String(str).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n');
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// ============= КЭШ КОНФИГУРАЦИИ =============
let cachedConfig = {
  proxyList: [],
  directList: [],
  proxies: [],
  activeProxyId: null,
  extensionEnabled: true
};

function loadConfigFromStorage(cb) {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled'], (data) => {
    cachedConfig.proxyList = data.proxyList || [];
    cachedConfig.directList = data.directList || [];
    cachedConfig.proxies = data.proxies || [];
    cachedConfig.activeProxyId = data.activeProxyId;
    cachedConfig.extensionEnabled = data.extensionEnabled !== false;
    if (cb) cb();
  });
}

// ============= ЛОГИРОВАНИЕ (in-memory buffer) =============
let logBuffer = '';
const MAX_LOG_SIZE = 50000;

function logRoute(type, action, details) {
  const timeString = new Date().toLocaleTimeString('ru-RU');
  logBuffer += `[${timeString}] ${type}: ${action} - ${details}\n`;
  if (logBuffer.length > MAX_LOG_SIZE) {
    logBuffer = logBuffer.slice(-MAX_LOG_SIZE);
  }
}

function flushLogs() {
  if (!logBuffer) return;
  chrome.storage.local.get(['routeLogs'], (data) => {
    let logs = (data.routeLogs || '') + logBuffer;
    logBuffer = '';
    if (logs.length > MAX_LOG_SIZE) logs = logs.slice(-MAX_LOG_SIZE);
    chrome.storage.local.set({ routeLogs: logs });
  });
}

// Сброс логов каждые 30 секунд
setInterval(flushLogs, 30000);

// Автоочистка каждые 3 часа
setInterval(() => {
  chrome.storage.local.set({ routeLogs: '' }, () => {
    logRoute('CONFIG', 'Auto-cleanup', 'Логи очищены автоматически');
  });
}, 3 * 60 * 60 * 1000);

// ============= ПРОКСИ ЧЕЙН =============
function buildProxyReturnChain(proxies, activeProxy) {
  const valid = (proxies || []).filter(isProxyConfigured);
  if (valid.length === 0) return null;

  const seen = new Set();
  const chain = [];

  const addProxy = (proxy) => {
    const id = String(proxy.id);
    if (!seen.has(id)) {
      seen.add(id);
      chain.push(proxy);
    }
  };

  if (activeProxy) {
    const active = valid.find(p => sameProxyId(p.id, activeProxy.id));
    if (active) addProxy(active);
  }

  valid.forEach(addProxy);
  if (chain.length === 0) return null;

  return chain.map(p => `${p.type} ${p.host}:${p.port}`).join('; ') + '; DIRECT';
}

// ============= МЭТЧИНГ (единая логика для PAC и JS) =============
function hostMatches(host, pattern, url) {
  pattern = pattern.toLowerCase().trim();
  if (pattern.startsWith('.')) pattern = pattern.substring(1);
  if (pattern.startsWith('*.')) {
    const domain = pattern.substring(2);
    return host === domain || host.endsWith('.' + domain);
  }
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    return re.test(host);
  }
  if (pattern.includes('/')) {
    return url != null && url.toLowerCase().includes(pattern);
  }
  return host === pattern || host.endsWith('.' + pattern);
}

// ============= ГЕНЕРАЦИЯ PAC =============
function generatePAC() {
  const cfg = cachedConfig;
  const proxyChain = buildProxyReturnChain(cfg.proxies, findProxyById(cfg.proxies, cfg.activeProxyId));
  if (!proxyChain) {
    return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }

  const enabledDirect = cfg.directList.filter(s => s.enabled);
  const enabledProxy = cfg.proxyList.filter(s => s.enabled);

  let code = 'function FindProxyForURL(url, host) {\n';

  enabledDirect.forEach(site => {
    const pat = site.value.toLowerCase().trim().replace(/^\./, '');
    code += generatePACondition(pat, 'DIRECT', 'DIRECT');
  });

  enabledProxy.forEach(site => {
    const pat = site.value.toLowerCase().trim().replace(/^\./, '');
    code += generatePACondition(pat, proxyChain, 'PROXY');
  });

  code += '  return "DIRECT";\n}';
  return code;
}

function generatePACondition(pattern, result, _tag) {
  if (pattern.startsWith('*.')) {
    const domain = escapePacString(pattern.substring(2));
    return `  if (host === "${domain}" || host.endsWith(".${domain}")) return "${escapePacString(result)}";\n`;
  }
  if (pattern.includes('*')) {
    const re = escapePacString('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return `  if (/${re}/i.test(host)) return "${escapePacString(result)}";\n`;
  }
  if (pattern.includes('/')) {
    const re = escapePacString(pattern.toLowerCase());
    return `  if (url.toLowerCase().indexOf("${re}") !== -1) return "${escapePacString(result)}";\n`;
  }
  return `  if (host === "${escapePacString(pattern)}" || host.endsWith(".${escapePacString(pattern)}")) return "${escapePacString(result)}";\n`;
}

// ============= ПРИМЕНЕНИЕ ПРОКСИ (debounced) =============
function applyProxyConfigNow() {
  const cfg = cachedConfig;
  if (!cfg.extensionEnabled) {
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'Disabled', 'Extension is turned off')
    );
    return;
  }

  const activeProxy = findProxyById(cfg.proxies, cfg.activeProxyId);
  const proxyChain = buildProxyReturnChain(cfg.proxies, activeProxy);

  if (!proxyChain) {
    const reason = activeProxy
      ? `Invalid proxy "${activeProxy.name}" (missing host or port)`
      : 'No active proxy selected';
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'error', `${reason} — using DIRECT`)
    );
    return;
  }

  const pacScript = generatePAC();

  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {
      if (chrome.runtime.lastError) {
        logRoute('ERROR', 'Proxy config failed', chrome.runtime.lastError.message);
      } else {
        logRoute('CONFIG', 'Applied',
          `${proxyChain} | Proxy: ${cfg.proxyList.length} | Direct: ${cfg.directList.length}`);
      }
    }
  );
}

const applyProxyConfig = debounce(applyProxyConfigNow, 200);

// ============= НОРМАЛИЗАЦИЯ ДОМЕНОВ =============
function normalizeDomain(domain) {
  const twoLevelTLDs = [
    'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za',
    'com.ru', 'net.ru', 'org.ru', 'co.nz', 'co.kr', 'com.cn'
  ];
  const dynamicPatterns = [
    /^[a-z0-9]+-*[a-z0-9]*---/i,
    /^[a-z0-9]+-{2,}/i,
    /^[a-z]+\d+[a-z]*-/i,
    /^\d+[a-z]*-/i,
    /^[a-z]\d+-/i,
    /^(cdn|cache|edge|node|server|api|static|img|image|media|video|data|web|rr)\d+$/i
  ];

  const parts = domain.split('.');
  if (parts.length < 3) return domain;

  const firstPart = parts[0];
  const isDynamic = dynamicPatterns.some(p => p.test(firstPart));
  if (isDynamic) return `*.${parts.slice(1).join('.')}`;

  const lastTwo = parts.slice(-2).join('.');
  if (twoLevelTLDs.includes(lastTwo)) {
    if (parts.length >= 4) return `*.${parts.slice(-3).join('.')}`;
    return domain;
  }
  if (parts.length >= 3) return `*.${parts.slice(-2).join('.')}`;
  return domain;
}

// ============= СВЯЗАННЫЕ ДОМЕНЫ =============
const tabDomains = new Map();

function addRelatedDomains(tabId, listKey) {
  const domains = tabDomains.get(tabId);
  if (!domains || domains.size === 0) return;

  chrome.storage.local.get([listKey], (data) => {
    let list = data[listKey] || [];
    let addedCount = 0;

    domains.forEach(domain => {
      if (!list.find(s => s.value === domain)) {
        list.push({ id: crypto.randomUUID(), value: domain, enabled: true });
        addedCount++;
      }
    });

    if (addedCount > 0) {
      chrome.storage.local.set({ [listKey]: list }, () => {
        chrome.notifications.create({
          type: 'basic', iconUrl: 'logo.png',
          title: 'Связанные домены добавлены',
          message: `Автоматически добавлено ${addedCount} связанных доменов`
        });
      });
    }
  });
}

// ============= СТАТИСТИКА =============
const activityStats = {
  proxy: 0, direct: 0, hourly: [], domains: {}
};

function initStats() {
  chrome.storage.local.get(['activityStats'], (data) => {
    if (data.activityStats) Object.assign(activityStats, data.activityStats);
    if (!activityStats.hourly || activityStats.hourly.length === 0) {
      activityStats.hourly = Array(60).fill(0).map(() => ({ proxy: 0, direct: 0, timestamp: Date.now() }));
    }
  });
}

function saveStats() {
  chrome.storage.local.set({ activityStats });
}

function updateStats(routeType, domain) {
  if (routeType === 'PROXY') activityStats.proxy++;
  else activityStats.direct++;

  if (!activityStats.domains[domain]) activityStats.domains[domain] = { proxy: 0, direct: 0 };
  if (routeType === 'PROXY') activityStats.domains[domain].proxy++;
  else activityStats.domains[domain].direct++;

  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const lastEntry = activityStats.hourly[activityStats.hourly.length - 1];
  const lastMinute = Math.floor(lastEntry.timestamp / 60000);

  if (currentMinute === lastMinute) {
    if (routeType === 'PROXY') lastEntry.proxy++;
    else lastEntry.direct++;
  } else {
    activityStats.hourly.push({
      proxy: routeType === 'PROXY' ? 1 : 0,
      direct: routeType === 'DIRECT' ? 1 : 0,
      timestamp: now
    });
    if (activityStats.hourly.length > 60) activityStats.hourly.shift();
  }
  saveStats();
}

initStats();

// ============= ИНИЦИАЛИЗАЦИЯ =============
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'installDate', 'lastUpdateDate', 'extensionEnabled'], (data) => {
    const defaultProxies = data.proxies || [
      { id: crypto.randomUUID(), name: 'Default', host: '127.0.0.1', port: 1080, type: 'SOCKS5', enabled: true }
    ];

    let activeProxyId = data.activeProxyId;
    if (!activeProxyId || !findProxyById(defaultProxies, activeProxyId)) {
      activeProxyId = defaultProxies[0].id;
    }

    const defaults = {
      proxyList: data.proxyList || [],
      directList: data.directList || [],
      proxies: defaultProxies,
      activeProxyId,
      extensionEnabled: data.extensionEnabled !== false
    };

    if (!data.installDate) defaults.installDate = Date.now();
    if (details.reason === 'update') defaults.lastUpdateDate = Date.now();

    chrome.storage.local.set(defaults, () => {
      cachedConfig.proxyList = defaults.proxyList;
      cachedConfig.directList = defaults.directList;
      cachedConfig.proxies = defaults.proxies;
      cachedConfig.activeProxyId = defaults.activeProxyId;
      cachedConfig.extensionEnabled = defaults.extensionEnabled;
      applyProxyConfig();
    });
  });

  createContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  loadConfigFromStorage(() => applyProxyConfig());
});

// ============= КОНТЕКСТНОЕ МЕНЮ =============
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'addToProxyList', title: '🔒 Добавить в список прокси', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'addToDirectList', title: '✅ Добавить в список напрямую', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'separator1', type: 'separator', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'removeFromLists', title: '🗑️ Удалить из всех списков', contexts: ['page', 'link'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let domain = '';
  if (info.linkUrl) domain = new URL(info.linkUrl).hostname;
  else if (info.pageUrl) domain = new URL(info.pageUrl).hostname;
  if (!domain) return;

  chrome.storage.local.get(['proxyList', 'directList', 'autoAddRelated'], (data) => {
    let proxyList = data.proxyList || [];
    let directList = data.directList || [];
    const autoAddRelated = data.autoAddRelated || false;

    switch (info.menuItemId) {
      case 'addToProxyList':
        if (!proxyList.find(s => s.value === domain)) {
          proxyList.push({ id: crypto.randomUUID(), value: domain, enabled: true });
          chrome.storage.local.set({ proxyList }, () => {
            chrome.notifications.create({
              type: 'basic', iconUrl: 'logo.png',
              title: 'Добавлено в прокси',
              message: `${domain} добавлен в список прокси`
            });
            if (autoAddRelated && tab) addRelatedDomains(tab.id, 'proxyList');
          });
        }
        break;
      case 'addToDirectList':
        if (!directList.find(s => s.value === domain)) {
          directList.push({ id: crypto.randomUUID(), value: domain, enabled: true });
          chrome.storage.local.set({ directList }, () => {
            chrome.notifications.create({
              type: 'basic', iconUrl: 'logo.png',
              title: 'Добавлено в напрямую',
              message: `${domain} добавлен в список напрямую`
            });
            if (autoAddRelated && tab) addRelatedDomains(tab.id, 'directList');
          });
        }
        break;
      case 'removeFromLists':
        proxyList = proxyList.filter(s => s.value !== domain);
        directList = directList.filter(s => s.value !== domain);
        chrome.storage.local.set({ proxyList, directList }, () => {
          chrome.notifications.create({
            type: 'basic', iconUrl: 'logo.png',
            title: 'Удалено из списков',
            message: `${domain} удалён из всех списков`
          });
        });
        break;
    }
  });
});

// ============= СЛУШАТЕЛЬ STORAGE =============
chrome.storage.onChanged.addListener((changes) => {
  const relevant = ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled'];
  if (!relevant.some(k => changes[k])) return;

  loadConfigFromStorage(() => applyProxyConfig());
});

// ============= АНАЛИЗ ЗАПРОСОВ (только main_frame + sub_frame) =============
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const host = url.hostname;

      if (details.tabId >= 0) {
        if (!tabDomains.has(details.tabId)) {
          tabDomains.set(details.tabId, new Set());
        }
        const normalized = normalizeDomain(host);
        const set = tabDomains.get(details.tabId);
        set.add(normalized);
        if (set.size > 100) {
          const first = set.values().next().value;
          set.delete(first);
        }
      }

      if (details.type !== 'main_frame' && details.type !== 'sub_frame') return;

      const cfg = cachedConfig;
      let matchedSite = null;
      let routeType = 'DIRECT';

      if (cfg.activeProxyId) {
        const enabledDirect = cfg.directList.filter(s => s.enabled);
        const enabledProxy = cfg.proxyList.filter(s => s.enabled);

        for (const site of enabledDirect) {
          if (hostMatches(host, site.value, details.url)) {
            matchedSite = site.value;
            routeType = 'DIRECT';
            break;
          }
        }

        if (!matchedSite) {
          for (const site of enabledProxy) {
            if (hostMatches(host, site.value, details.url)) {
              matchedSite = site.value;
              routeType = 'PROXY';
              break;
            }
          }
        }
      }

      if (matchedSite) {
        const activeProxy = findProxyById(cfg.proxies, cfg.activeProxyId);
        const proxyInfo = activeProxy ? `${activeProxy.type} ${activeProxy.host}:${activeProxy.port}` : 'DIRECT';
        logRoute('REQUEST', routeType, `${host} -> ${proxyInfo} (matched: ${matchedSite})`);
        updateStats(routeType, host);
      }
    } catch (e) {
      console.error('Request analysis error:', e);
    }
  },
  { urls: ['<all_urls>'] }
);

// ============= ОЧИСТКА ВКЛАДОК =============
chrome.tabs.onRemoved.addListener((tabId) => tabDomains.delete(tabId));

if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) tabDomains.delete(details.tabId);
  });
}

// ============= ОБРАБОТЧИК СООБЩЕНИЙ =============
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'getRelatedDomains') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ mainDomain: null, relatedDomains: [] });

      const domains = tabDomains.get(tabs[0].id);
      const mainHost = new URL(tabs[0].url).hostname;

      sendResponse({
        mainDomain: mainHost,
        relatedDomains: domains ? Array.from(domains).filter(d => d !== mainHost).sort() : []
      });
    });
    return true;
  }

  if (request.action === 'getStats') {
    sendResponse({ stats: activityStats });
    return true;
  }

  if (request.action === 'resetStats') {
    activityStats.proxy = 0;
    activityStats.direct = 0;
    activityStats.domains = {};
    activityStats.hourly = Array(60).fill(0).map(() => ({ proxy: 0, direct: 0, timestamp: Date.now() }));
    saveStats();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'testSpecificProxy') {
    chrome.storage.local.get(['proxies', 'proxyList', 'directList'], (data) => {
      const proxyToTest = findProxyById(data.proxies, request.proxyId);
      if (!proxyToTest) return sendResponse({ success: false, error: 'Proxy not found' });

      const originalList = data.proxyList || [];
      const originalDirectList = data.directList || [];
      const proxyStr = `${proxyToTest.type} ${proxyToTest.host}:${proxyToTest.port}`;

      const restore = (cb) => {
        loadConfigFromStorage(() => { applyProxyConfig(); if (cb) cb(); });
      };

      chrome.proxy.settings.set({
        value: { mode: 'pac_script', pacScript: { data: `function FindProxyForURL(url, host) { if (host === "api.ipify.org") return "${escapePacString(proxyStr)}"; return "DIRECT"; }` } },
        scope: 'regular'
      }, () => {
        setTimeout(() => {
          fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
            .then(r => r.json())
            .then(result => restore(() => sendResponse({ success: true, ip: result.ip })))
            .catch(err => restore(() => sendResponse({ success: false, error: err.message })));
        }, 500);
      });
    });
    return true;
  }

  if (request.action === 'testProxyHealth') {
    chrome.storage.local.get(['proxies', 'proxyList', 'directList'], (data) => {
      const proxyToTest = findProxyById(data.proxies, request.proxyId);
      if (!proxyToTest) return sendResponse({ success: false, error: 'Proxy not found' });

      const originalList = data.proxyList || [];
      const originalDirectList = data.directList || [];
      const proxyStr = `${proxyToTest.type} ${proxyToTest.host}:${proxyToTest.port}`;

      const restore = (cb) => {
        loadConfigFromStorage(() => { applyProxyConfig(); if (cb) cb(); });
      };

      chrome.proxy.settings.set(
        { value: { mode: 'direct' }, scope: 'regular' },
        () => {
          setTimeout(() => {
            fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
              .then(r => r.json())
              .then(local => {
                const pac = `function FindProxyForURL(url, host) { if (host === "api.ipify.org") return "${escapePacString(proxyStr)}"; return "DIRECT"; }`;
                chrome.proxy.settings.set(
                  { value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' },
                  () => {
                    setTimeout(() => {
                      fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
                        .then(r => r.json())
                        .then(proxy => restore(() => sendResponse({ success: true, proxyIp: proxy.ip, localIp: local.ip })))
                        .catch(err => restore(() => sendResponse({ success: false, error: err.message, localIp: local.ip })));
                    }, 500);
                  }
                );
              })
              .catch(() => {
                const pac = `function FindProxyForURL(url, host) { if (host === "api.ipify.org") return "${escapePacString(proxyStr)}"; return "DIRECT"; }`;
                chrome.proxy.settings.set(
                  { value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' },
                  () => {
                    setTimeout(() => {
                      fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
                        .then(r => r.json())
                        .then(proxy => restore(() => sendResponse({ success: true, proxyIp: proxy.ip, localIp: null })))
                        .catch(err => restore(() => sendResponse({ success: false, error: err.message })));
                    }, 500);
                  }
                );
              });
          }, 500);
        }
      );
    });
    return true;
  }
});
