// Генератор уникальных ID
function generateUniqueId() {
  return Date.now() + Math.random();
}

// Инициализация при установке
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'installDate', 'lastUpdateDate', 'extensionEnabled'], (data) => {
    // Создаём дефолтный прокси если его нет
    const defaultProxies = data.proxies || [
      { id: generateUniqueId(), name: 'Default', host: '127.0.0.1', port: 1080, type: 'SOCKS5', enabled: true }
    ];
    
    // Если activeProxyId не установлен или не существует в списке, берём ID первого прокси
    let activeProxyId = data.activeProxyId;
    if (!activeProxyId || !defaultProxies.find(p => p.id === activeProxyId)) {
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
      console.log(`Обновлено с версии ${details.previousVersion} до ${chrome.runtime.getManifest().version}`);
    }
    
    chrome.storage.local.set(defaults);
    const activeProxy = defaults.proxies.find(p => p.id === defaults.activeProxyId);
    applyProxyConfig(defaults.proxyList, defaults.directList, defaults.proxies, activeProxy, defaults.extensionEnabled);
  });
  
  // Создаём контекстное меню
  createContextMenu();
});

// Инициализация при запуске браузера
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled'], (data) => {
    const activeProxy = data.proxies?.find(p => p.id === data.activeProxyId);
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
          proxyList.push({ id: generateUniqueId(), value: domain, enabled: true });
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
          directList.push({ id: generateUniqueId(), value: domain, enabled: true });
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
        list.push({ id: generateUniqueId(), value: domain, enabled: true });
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

// Автоматическая очистка логов (запускается только один раз)
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
      const activeProxy = data.proxies?.find(p => p.id === data.activeProxyId);
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
function generatePAC(proxyList, directList, activeProxy) {
  if (!activeProxy) {
    return `function FindProxyForURL(url, host) { return "DIRECT"; }`;
  }
  
  const proxyString = `${activeProxy.type} ${activeProxy.host}:${activeProxy.port}`;
  
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
      pacScript += `  if (host.endsWith(".${domain}") || host === "${domain}") return "${proxyString}";\n`;
    } else if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*');
      pacScript += `  if (/^${regexPattern}$/.test(host)) return "${proxyString}";\n`;
    } else if (pattern.includes('/')) {
      const urlPattern = pattern.replace(/\./g, '\\\\.').replace(/\*/g, '.*').replace(/\//g, '\\\\/');
      pacScript += `  if (/${urlPattern}/.test(url)) return "${proxyString}";\n`;
    } else {
      pacScript += `  if (dnsDomainIs(host, "${pattern}") || host === "${pattern}") return "${proxyString}";\n`;
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
  
  if (!activeProxy) {
    console.warn('No active proxy selected, using DIRECT');
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'error', 'No active proxy selected - using DIRECT')
    );
    return;
  }
  
  if (!activeProxy.host || !activeProxy.port || activeProxy.host.trim() === '') {
    console.warn(`Invalid proxy configuration for "${activeProxy.name}": missing host or port, using DIRECT`);
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'error', `Invalid proxy "${activeProxy.name}" (missing host or port) - using DIRECT`)
    );
    return;
  }
  
  const pacScript = generatePAC(proxyList, directList, activeProxy);
  
  console.log('=== Generated PAC script ===');
  console.log(pacScript);
  console.log('=== End PAC script ===');
  
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
        const proxyInfo = `${activeProxy.type} ${activeProxy.host}:${activeProxy.port}`;
        console.log('Proxy applied:', proxyInfo, `Proxy list: ${proxyList.length}`, `Direct list: ${directList.length}`);
        logRoute('CONFIG', 'Applied', `${proxyInfo} | Proxy: ${proxyList.length} | Direct: ${directList.length}`);
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

// Нормализация доменов
function normalizeDomain(domain) {
  const dynamicPatterns = [
    /^[a-z0-9]+-*[a-z0-9]*---/i,
    /^[a-z]+\d+[a-z]*-/i,
    /^\d+[a-z]*-/i,
    /^[a-z]\d+-/i
  ];
  
  const parts = domain.split('.');
  
  if (parts.length < 3) {
    return domain;
  }
  
  const firstPart = parts[0];
  const isDynamic = dynamicPatterns.some(pattern => pattern.test(firstPart));
  
  if (isDynamic) {
    const baseDomain = parts.slice(1).join('.');
    return `*.${baseDomain}`;
  }
  
  if (/^(cdn|cache|edge|node|server)\d+$/i.test(firstPart)) {
    const baseDomain = parts.slice(1).join('.');
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
          const activeProxy = proxies.find(p => p.id === data.activeProxyId);
          
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
      const proxyToTest = data.proxies.find(p => p.id === request.proxyId);
      
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
            signal: AbortSignal.timeout(15000) 
          })
            .then(res => res.json())
            .then(result => {
              chrome.storage.local.get(['proxies', 'activeProxyId', 'extensionEnabled'], (restoreData) => {
                const activeProxy = restoreData.proxies?.find(p => p.id === restoreData.activeProxyId);
                const extensionEnabled = restoreData.extensionEnabled !== false;
                applyProxyConfig(originalList, originalDirectList, restoreData.proxies, activeProxy, extensionEnabled);
                sendResponse({ success: true, ip: result.ip });
              });
            })
            .catch(err => {
              chrome.storage.local.get(['proxies', 'activeProxyId', 'extensionEnabled'], (restoreData) => {
                const activeProxy = restoreData.proxies?.find(p => p.id === restoreData.activeProxyId);
                const extensionEnabled = restoreData.extensionEnabled !== false;
                applyProxyConfig(originalList, originalDirectList, restoreData.proxies, activeProxy, extensionEnabled);
                sendResponse({ success: false, error: err.message });
              });
            });
        }, 1000);
      });
    });
    
    return true;
  }
  
  if (request.action === 'checkDNSLeak') {
    chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled'], (data) => {
      const originalEnabled = data.extensionEnabled !== false;
      
      chrome.storage.local.set({ extensionEnabled: false }, () => {
        setTimeout(() => {
          fetch('https://api.ipify.org?format=json')
            .then(r => r.json())
            .then(realIP => {
              chrome.storage.local.set({ extensionEnabled: originalEnabled }, () => {
                setTimeout(() => {
                  fetch('https://api.ipify.org?format=json')
                    .then(r => r.json())
                    .then(proxyIP => {
                      const isLeaking = realIP.ip === proxyIP.ip;
                      sendResponse({ 
                        success: true, 
                        realIP: realIP.ip,
                        proxyIP: proxyIP.ip,
                        isLeaking: isLeaking
                      });
                    })
                    .catch(() => {
                      sendResponse({ success: false, error: 'Proxy check failed' });
                    });
                }, 500);
              });
            })
            .catch(() => {
              chrome.storage.local.set({ extensionEnabled: originalEnabled });
              sendResponse({ success: false, error: 'Real IP check failed' });
            });
        }, 500);
      });
    });
    
    return true;
  }
});
