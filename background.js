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

function buildProxyReturnChain(proxies, activeProxy) {
  const valid = (proxies || []).filter(isProxyConfigured);
  if (valid.length === 0) return null;

  const chain = [];
  const add = (proxy) => {
    if (!chain.some(p => sameProxyId(p.id, proxy.id))) {
      chain.push(proxy);
    }
  };

  if (activeProxy) {
    const active = valid.find(p => sameProxyId(p.id, activeProxy.id));
    if (active) add(active);
  }

  if (chain.length === 0) return null;
  return chain.map(p => `${p.type} ${p.host}:${p.port}`).join('; ') + '; DIRECT';
}

// Инициализация при установке
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'installDate', 'lastUpdateDate', 'extensionEnabled'], (data) => {
    // Создаём дефолтный прокси если его нет
    const defaultProxies = data.proxies || [
      { id: crypto.randomUUID(), name: 'Default', host: '127.0.0.1', port: 1080, type: 'SOCKS5', enabled: true }
    ];
    
    // Если activeProxyId не установлен или не существует в списке, берём ID первого прокси
    let activeProxyId = data.activeProxyId;
    if (!activeProxyId || !findProxyById(defaultProxies, activeProxyId)) {
      activeProxyId = defaultProxies[0].id;
    }
    
    const defaults = {
      proxyList: data.proxyList || [],
      directList: data.directList || [],
      proxies: defaultProxies,
      activeProxyId: activeProxyId,
      extensionEnabled: data.extensionEnabled !== false
    };
    
    // Сохраняем дату установки (только при первой установке)
    if (!data.installDate) {
      defaults.installDate = Date.now();
    }
    
    // Обновляем дату последнего обновления
    if (details.reason === 'update') {
      defaults.lastUpdateDate = Date.now();
    }
    
    chrome.storage.local.set(defaults);
    const activeProxy = findProxyById(defaults.proxies, defaults.activeProxyId);
    applyProxyConfig(defaults.proxyList, defaults.directList, defaults.proxies, activeProxy, defaults.extensionEnabled);
  });
  
  // Создаём контекстное меню
  createContextMenu();
});

// Инициализация при запуске браузера
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled'], (data) => {
    const activeProxy = findProxyById(data.proxies, data.activeProxyId);
    const extensionEnabled = data.extensionEnabled !== false;
    applyProxyConfig(
      data.proxyList || [],
      data.directList || [],
      data.proxies || [],
      activeProxy,
      extensionEnabled
    );
  });
});

// Создание контекстного меню
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'addToProxyList',
      title: '🔒 Добавить в список прокси',
      contexts: ['page', 'link']
    });
    
    chrome.contextMenus.create({
      id: 'addToDirectList',
      title: '✅ Добавить в список напрямую',
      contexts: ['page', 'link']
    });
    
    chrome.contextMenus.create({
      id: 'separator1',
      type: 'separator',
      contexts: ['page', 'link']
    });
    
    chrome.contextMenus.create({
      id: 'removeFromLists',
      title: '🗑️ Удалить из всех списков',
      contexts: ['page', 'link']
    });
  });
}

// Обработчик контекстного меню
chrome.contextMenus.onClicked.addListener((info, tab) => {
  let domain = '';
  
  if (info.linkUrl) {
    domain = new URL(info.linkUrl).hostname;
  } else if (info.pageUrl) {
    domain = new URL(info.pageUrl).hostname;
  }
  
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
              type: 'basic',
              iconUrl: 'logo.png',
              title: 'Добавлено в прокси',
              message: `${domain} добавлен в список прокси`
            });
            
            if (autoAddRelated && tab) {
              addRelatedDomains(tab.id, 'proxyList');
            }
          });
        }
        break;
        
      case 'addToDirectList':
        if (!directList.find(s => s.value === domain)) {
          directList.push({ id: crypto.randomUUID(), value: domain, enabled: true });
          chrome.storage.local.set({ directList }, () => {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'logo.png',
              title: 'Добавлено в напрямую',
              message: `${domain} добавлен в список напрямую`
            });
            
            if (autoAddRelated && tab) {
              addRelatedDomains(tab.id, 'directList');
            }
          });
        }
        break;
        
      case 'removeFromLists':
        proxyList = proxyList.filter(s => s.value !== domain);
        directList = directList.filter(s => s.value !== domain);
        chrome.storage.local.set({ proxyList, directList }, () => {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'logo.png',
            title: 'Удалено из списков',
            message: `${domain} удалён из всех списков`
          });
        });
        break;
    }
  });
});

// Автодобавление связанных доменов
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
          type: 'basic',
          iconUrl: 'logo.png',
          title: 'Связанные домены добавлены',
          message: `Автоматически добавлено ${addedCount} связанных доменов`
        });
      });
    }
  });
}

// Автоматическая очистка логов
let logCleanupInterval = null;

function startLogCleanup() {
  // Предотвращаем создание нескольких интервалов
  if (logCleanupInterval) {
    clearInterval(logCleanupInterval);
  }
  
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  
  logCleanupInterval = setInterval(() => {
    chrome.storage.local.set({ routeLogs: '' }, () => {
      console.log('Логи автоматически очищены');
      logRoute('CONFIG', 'Auto-cleanup', 'Логи очищены автоматически');
    });
  }, THREE_HOURS);
}

// Запускаем очистку только один раз
startLogCleanup();

// Слушаем изменения в storage
chrome.storage.onChanged.addListener((changes) => {
  if (changes.proxyList || changes.directList || changes.proxies || changes.activeProxyId || changes.extensionEnabled) {
    chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled'], (data) => {
      const activeProxy = findProxyById(data.proxies, data.activeProxyId);
      const extensionEnabled = data.extensionEnabled !== false;
      applyProxyConfig(
        data.proxyList || [],
        data.directList || [],
        data.proxies || [],
        activeProxy,
        extensionEnabled
      );
    });
  }
});

// Общая функция проверки соответствия домена паттерну
function matchesPattern(host, pattern, url = '') {
  pattern = pattern.toLowerCase().trim();
  if (pattern.startsWith('.')) pattern = pattern.substring(1);
  
  if (pattern.startsWith('*.')) {
    const domain = pattern.substring(2);
    return host.endsWith('.' + domain) || host === domain;
  } else if (pattern.includes('*')) {
    const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
    return new RegExp(`^${regexPattern}$`).test(host);
  } else if (pattern.includes('/')) {
    return url.toLowerCase().includes(pattern);
  } else {
    return host === pattern || host.endsWith('.' + pattern);
  }
}

// Генерация PAC скрипта
function generatePAC(proxyList, directList, proxies, activeProxy) {
  const proxyChain = buildProxyReturnChain(proxies, activeProxy);
  if (!proxyChain) {
    return `function FindProxyForURL(url, host) { return "DIRECT"; }`;
  }

  const enabledProxyList = proxyList.filter(s => s.enabled);
  const enabledDirectList = directList.filter(s => s.enabled);
  
  let pacScript = `function FindProxyForURL(url, host) {\n`;
  
  // Приоритет 1: Direct список (всегда напрямую)
  enabledDirectList.forEach(site => {
    let pattern = site.value.toLowerCase().trim();
    if (pattern.startsWith('.')) pattern = pattern.substring(1);
    
    if (pattern.startsWith('*.')) {
      const domain = pattern.substring(2);
      pacScript += `  if (host.endsWith(".${domain}") || host === "${domain}") return "DIRECT";\n`;
    } else if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*');
      pacScript += `  if (/^${regexPattern}$/.test(host)) return "DIRECT";\n`;
    } else if (pattern.includes('/')) {
      const urlPattern = pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*').replace(/\//g, '\\\\/');
      pacScript += `  if (/${urlPattern}/.test(url)) return "DIRECT";\n`;
    } else {
      pacScript += `  if (dnsDomainIs(host, "${pattern}") || host === "${pattern}") return "DIRECT";\n`;
    }
  });
  
  // Приоритет 2: Proxy список (через прокси)
  enabledProxyList.forEach(site => {
    let pattern = site.value.toLowerCase().trim();
    if (pattern.startsWith('.')) pattern = pattern.substring(1);
    
    if (pattern.startsWith('*.')) {
      const domain = pattern.substring(2);
      pacScript += `  if (host.endsWith(".${domain}") || host === "${domain}") return "${proxyChain}";\n`;
    } else if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*');
      pacScript += `  if (/^${regexPattern}$/.test(host)) return "${proxyChain}";\n`;
    } else if (pattern.includes('/')) {
      const urlPattern = pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*').replace(/\//g, '\\\\/');
      pacScript += `  if (/${urlPattern}/.test(url)) return "${proxyChain}";\n`;
    } else {
      pacScript += `  if (dnsDomainIs(host, "${pattern}") || host === "${pattern}") return "${proxyChain}";\n`;
    }
  });
  
  pacScript += `  return "DIRECT";\n}`;
  
  return pacScript;
}

// Применение конфигурации прокси
function applyProxyConfig(proxyList, directList, proxies, activeProxy, extensionEnabled = true) {
  if (!extensionEnabled) {
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'Disabled', 'Extension is turned off - using DIRECT connection')
    );
    return;
  }
  
  const proxyChain = buildProxyReturnChain(proxies, activeProxy);
  if (!proxyChain) {
    const reason = activeProxy
      ? `Invalid proxy "${activeProxy.name}" (missing host or port)`
      : 'No active proxy selected';
    console.warn(`${reason}, using DIRECT`);
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'error', `${reason} - using DIRECT`)
    );
    return;
  }

  const pacScript = generatePAC(proxyList, directList, proxies, activeProxy);
  
  const config = {
    mode: 'pac_script',
    pacScript: {
      data: pacScript
    }
  };

  chrome.proxy.settings.set(
    { value: config, scope: 'regular' },
    () => {
      if (chrome.runtime.lastError) {
        console.error('Proxy error:', chrome.runtime.lastError.message);
        logRoute('ERROR', 'Proxy config failed', chrome.runtime.lastError.message);
      } else {
        logRoute('CONFIG', 'Applied', `${proxyChain} | Proxy: ${proxyList.length} | Direct: ${directList.length}`);
      }
    }
  );
}

// Логирование маршрутов
function logRoute(type, action, details) {
  const now = new Date();
  const timeString = now.toLocaleTimeString('ru-RU');
  const logEntry = `[${timeString}] ${type}: ${action} - ${details}\n`;
  
  chrome.storage.local.get(['routeLogs'], (data) => {
    let logs = data.routeLogs || '';
    logs += logEntry;
    
    if (logs.length > 50000) {
      logs = logs.slice(-50000);
    }
    
    chrome.storage.local.set({ routeLogs: logs });
  });
}

// Нормализация доменов - группирует поддомены
function normalizeDomain(domain) {
  // Список двухуровневых TLD
  const twoLevelTLDs = [
    'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za',
    'com.ru', 'net.ru', 'org.ru', 'co.nz', 'co.kr', 'com.cn'
  ];
  
  // Паттерны для динамических поддоменов (CDN, серверы и т.д.)
  const dynamicPatterns = [
    /^[a-z0-9]+-*[a-z0-9]*---/i,              // rr1---sn-xxx (YouTube CDN с тройным дефисом)
    /^[a-z0-9]+-{2,}/i,                       // xxx-- или xxx--- (двойной/тройной дефис)
    /^[a-z]+\d+[a-z]*-/i,                     // cdn123-, api2-
    /^\d+[a-z]*-/i,                           // 123-, 1a-
    /^[a-z]\d+-/i,                            // a1-, s2-
    /^(cdn|cache|edge|node|server|api|static|img|image|media|video|data|web|rr)\d+$/i  // cdn1, api2, rr1
  ];
  
  const parts = domain.split('.');
  
  // Если домен короткий (example.com или localhost), возвращаем как есть
  if (parts.length < 3) {
    return domain;
  }
  
  const firstPart = parts[0];
  
  // Проверяем первую часть на динамичность
  const isDynamic = dynamicPatterns.some(pattern => pattern.test(firstPart));
  
  if (isDynamic) {
    // Для динамических поддоменов возвращаем wildcard базового домена
    const baseDomain = parts.slice(1).join('.');
    return `*.${baseDomain}`;
  }
  
  // Для обычных поддоменов группируем по базовому домену
  // Проверяем двухуровневые TLD
  const lastTwo = parts.slice(-2).join('.');
  
  if (twoLevelTLDs.includes(lastTwo)) {
    // Для доменов типа api.example.com.ru -> *.example.com.ru
    if (parts.length >= 4) {
      const baseDomain = parts.slice(-3).join('.');
      return `*.${baseDomain}`;
    }
    // Для example.com.ru -> example.com.ru (не группируем)
    return domain;
  }
  
  // Для обычных доменов (api.github.com -> *.github.com)
  if (parts.length >= 3) {
    const baseDomain = parts.slice(-2).join('.');
    return `*.${baseDomain}`;
  }
  
  return domain;
}

// Отслеживание связанных доменов для каждой вкладки
const tabDomains = new Map();

// Статистика активности
const activityStats = {
  proxy: 0,
  direct: 0,
  hourly: [],
  domains: {}
};

// Инициализация статистики
function initStats() {
  chrome.storage.local.get(['activityStats'], (data) => {
    if (data.activityStats) {
      Object.assign(activityStats, data.activityStats);
    }
    if (!activityStats.hourly || activityStats.hourly.length === 0) {
      activityStats.hourly = Array(60).fill(0).map(() => ({ proxy: 0, direct: 0, timestamp: Date.now() }));
    }
  });
}

// Сохранение статистики
function saveStats() {
  chrome.storage.local.set({ activityStats });
}

// Обновление статистики
function updateStats(routeType, domain) {
  if (routeType === 'PROXY') {
    activityStats.proxy++;
  } else {
    activityStats.direct++;
  }
  
  if (!activityStats.domains[domain]) {
    activityStats.domains[domain] = { proxy: 0, direct: 0 };
  }
  if (routeType === 'PROXY') {
    activityStats.domains[domain].proxy++;
  } else {
    activityStats.domains[domain].direct++;
  }
  
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const lastEntry = activityStats.hourly[activityStats.hourly.length - 1];
  const lastMinute = Math.floor(lastEntry.timestamp / 60000);
  
  if (currentMinute === lastMinute) {
    if (routeType === 'PROXY') {
      lastEntry.proxy++;
    } else {
      lastEntry.direct++;
    }
  } else {
    activityStats.hourly.push({
      proxy: routeType === 'PROXY' ? 1 : 0,
      direct: routeType === 'DIRECT' ? 1 : 0,
      timestamp: now
    });
    
    if (activityStats.hourly.length > 60) {
      activityStats.hourly.shift();
    }
  }
  
  saveStats();
}

initStats();

// Перехват запросов для логирования и анализа доменов
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const host = url.hostname;
      
      // Отслеживаем все домены для вкладки с ограничением размера
      if (details.tabId >= 0) {
        if (!tabDomains.has(details.tabId)) {
          tabDomains.set(details.tabId, new Set());
        }
        const normalizedDomain = normalizeDomain(host);
        const domains = tabDomains.get(details.tabId);
        domains.add(normalizedDomain);
        
        // Ограничиваем размер Set (максимум 100 доменов на вкладку)
        if (domains.size > 100) {
          const firstItem = domains.values().next().value;
          domains.delete(firstItem);
        }
      }
      
      if (details.type === 'main_frame' || details.type === 'sub_frame' || details.type === 'xmlhttprequest') {
        chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId'], (data) => {
          const proxyList = data.proxyList || [];
          const directList = data.directList || [];
          const proxies = data.proxies || [];
          const activeProxy = findProxyById(proxies, data.activeProxyId);
          
          let routeType = 'DIRECT';
          let matchedSite = null;
          
          if (activeProxy) {
            const enabledDirectList = directList.filter(s => s.enabled);
            const enabledProxyList = proxyList.filter(s => s.enabled);
            
            // Проверяем Direct список (приоритет)
            for (let site of enabledDirectList) {
              if (matchesPattern(host, site.value, details.url)) {
                matchedSite = site.value;
                routeType = 'DIRECT';
                break;
              }
            }
            
            // Если не в Direct, проверяем Proxy список
            if (!matchedSite) {
              for (let site of enabledProxyList) {
                if (matchesPattern(host, site.value, details.url)) {
                  matchedSite = site.value;
                  routeType = 'PROXY';
                  break;
                }
              }
            }
          }
          
          const proxyInfo = routeType === 'PROXY' && activeProxy 
            ? `${activeProxy.type} ${activeProxy.host}:${activeProxy.port}`
            : 'DIRECT';
          
          if (matchedSite) {
            logRoute('REQUEST', routeType, `${host} -> ${proxyInfo} (matched: ${matchedSite})`);
            updateStats(routeType, host);
          }
        });
      }
    } catch (e) {
      console.error('Log error:', e);
    }
  },
  { urls: ['<all_urls>'] }
);

// Очистка данных при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  tabDomains.delete(tabId);
});

// Очистка данных при навигации (предотвращение утечки памяти)
if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      tabDomains.delete(details.tabId);
    }
  });
}

// API для получения связанных доменов текущей вкладки
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'getRelatedDomains') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        const domains = tabDomains.get(tabs[0].id);
        const mainUrl = new URL(tabs[0].url);
        const mainHost = mainUrl.hostname;
        
        if (domains) {
          const relatedDomains = Array.from(domains)
            .filter(d => d !== mainHost)
            .sort();
          
          sendResponse({ 
            mainDomain: mainHost,
            relatedDomains: relatedDomains 
          });
        } else {
          sendResponse({ 
            mainDomain: mainHost,
            relatedDomains: [] 
          });
        }
      } else {
        sendResponse({ mainDomain: null, relatedDomains: [] });
      }
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
      
      if (!proxyToTest) {
        sendResponse({ success: false, error: 'Proxy not found' });
        return;
      }
      
      const originalList = data.proxyList || [];
      const originalDirectList = data.directList || [];
      
      const testProxyString = `${proxyToTest.type} ${proxyToTest.host}:${proxyToTest.port}`;
      const testPAC = `function FindProxyForURL(url, host) {
        if (host === "api.ipify.org") return "${testProxyString}";
        return "DIRECT";
      }`;
      
      chrome.proxy.settings.set({
        value: {
          mode: 'pac_script',
          pacScript: { data: testPAC }
        },
        scope: 'regular'
      }, () => {
        setTimeout(() => {
          fetch('https://api.ipify.org?format=json', { 
            signal: AbortSignal.timeout(10000) 
          })
            .then(res => res.json())
            .then(result => {
              chrome.storage.local.get(['proxies', 'activeProxyId', 'extensionEnabled'], (restoreData) => {
                const activeProxy = findProxyById(restoreData.proxies, restoreData.activeProxyId);
                const extensionEnabled = restoreData.extensionEnabled !== false;
                applyProxyConfig(originalList, originalDirectList, restoreData.proxies || [], activeProxy, extensionEnabled);
                sendResponse({ success: true, ip: result.ip });
              });
            })
            .catch(err => {
              chrome.storage.local.get(['proxies', 'activeProxyId', 'extensionEnabled'], (restoreData) => {
                const activeProxy = findProxyById(restoreData.proxies, restoreData.activeProxyId);
                const extensionEnabled = restoreData.extensionEnabled !== false;
                applyProxyConfig(originalList, originalDirectList, restoreData.proxies || [], activeProxy, extensionEnabled);
                sendResponse({ success: false, error: err.message });
              });
            });
        }, 500);
      });
    });
    
    return true;
  }
  
  if (request.action === 'testProxyHealth') {
    chrome.storage.local.get(['proxies', 'proxyList', 'directList'], (data) => {
      const proxyToTest = findProxyById(data.proxies, request.proxyId);
      if (!proxyToTest) {
        sendResponse({ success: false, error: 'Proxy not found' });
        return;
      }
      
      const originalList = data.proxyList || [];
      const originalDirectList = data.directList || [];
      const testProxyString = `${proxyToTest.type} ${proxyToTest.host}:${proxyToTest.port}`;
      
      const restore = (cb) => {
        chrome.storage.local.get(['proxies', 'activeProxyId', 'extensionEnabled'], (restoreData) => {
          const activeProxy = findProxyById(restoreData.proxies, restoreData.activeProxyId);
          const extEnabled = restoreData.extensionEnabled !== false;
          applyProxyConfig(originalList, originalDirectList, restoreData.proxies || [], activeProxy, extEnabled);
          if (cb) cb();
        });
      };
      
      // Step 1: get local IP (direct connection)
      chrome.proxy.settings.set(
        { value: { mode: 'direct' }, scope: 'regular' },
        () => {
          setTimeout(() => {
            fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
              .then(r => r.json())
              .then(local => {
                // Step 2: get proxy IP
                const pac = `function FindProxyForURL(url, host) {
                  if (host === "api.ipify.org") return "${testProxyString}";
                  return "DIRECT";
                }`;
                chrome.proxy.settings.set(
                  { value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' },
                  () => {
                    setTimeout(() => {
                      fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
                        .then(r => r.json())
                        .then(proxy => {
                          restore(() => sendResponse({ success: true, proxyIp: proxy.ip, localIp: local.ip }));
                        })
                        .catch(err => {
                          restore(() => sendResponse({ success: false, error: err.message, localIp: local.ip }));
                        });
                    }, 500);
                  }
                );
              })
              .catch(() => {
                // Failed to get local IP, try proxy only
                const pac = `function FindProxyForURL(url, host) {
                  if (host === "api.ipify.org") return "${testProxyString}";
                  return "DIRECT";
                }`;
                chrome.proxy.settings.set(
                  { value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' },
                  () => {
                    setTimeout(() => {
                      fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) })
                        .then(r => r.json())
                        .then(proxy => {
                          restore(() => sendResponse({ success: true, proxyIp: proxy.ip, localIp: null }));
                        })
                        .catch(err => {
                          restore(() => sendResponse({ success: false, error: err.message }));
                        });
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
