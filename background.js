// Инициализация при установке
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId'], (data) => {
    const defaults = {
      proxyList: data.proxyList || [],
      directList: data.directList || [],
      proxies: data.proxies || [
        { id: Date.now(), name: 'Default', host: '127.0.0.1', port: 1080, type: 'SOCKS5', enabled: true }
      ],
      activeProxyId: data.activeProxyId || Date.now()
    };
    
    chrome.storage.local.set(defaults);
    const activeProxy = defaults.proxies.find(p => p.id === defaults.activeProxyId) || defaults.proxies[0];
    applyProxyConfig(defaults.proxyList, defaults.directList, defaults.proxies, activeProxy);
  });
  
  // Запускаем автоочистку логов
  startLogCleanup();
  
  // Создаём контекстное меню
  createContextMenu();
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
      id: 'analyzeCurrentPage',
      title: '🔍 Анализ связанных доменов',
      contexts: ['page']
    });
    
    chrome.contextMenus.create({
      id: 'separator2',
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
  
  // Получаем домен из ссылки или текущей страницы
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
          proxyList.push({ id: Date.now(), value: domain, enabled: true });
          chrome.storage.local.set({ proxyList }, () => {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'logo.png',
              title: 'Добавлено в прокси',
              message: `${domain} добавлен в список прокси`
            });
            
            // Автодобавление связанных доменов
            if (autoAddRelated && tab) {
              addRelatedDomains(tab.id, 'proxyList');
            }
          });
        }
        break;
        
      case 'addToDirectList':
        if (!directList.find(s => s.value === domain)) {
          directList.push({ id: Date.now(), value: domain, enabled: true });
          chrome.storage.local.set({ directList }, () => {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'logo.png',
              title: 'Добавлено в напрямую',
              message: `${domain} добавлен в список напрямую`
            });
            
            // Автодобавление связанных доменов
            if (autoAddRelated && tab) {
              addRelatedDomains(tab.id, 'directList');
            }
          });
        }
        break;
        
      case 'analyzeCurrentPage':
        if (tab) {
          // Открываем popup с анализом
          chrome.action.openPopup();
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
        list.push({ id: Date.now() + Math.random(), value: domain, enabled: true });
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

// Автоматическая очистка логов каждые 3 часа
function startLogCleanup() {
  const THREE_HOURS = 3 * 60 * 60 * 1000; // 3 часа в миллисекундах
  
  setInterval(() => {
    chrome.storage.local.set({ routeLogs: '' }, () => {
      console.log('Логи автоматически очищены');
      logRoute('CONFIG', 'Auto-cleanup', 'Логи очищены автоматически');
    });
  }, THREE_HOURS);
}

// Запускаем очистку при загрузке service worker
startLogCleanup();

// Слушаем изменения в storage
chrome.storage.onChanged.addListener((changes) => {
  if (changes.proxyList || changes.directList || changes.proxies || changes.activeProxyId) {
    chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId'], (data) => {
      const activeProxy = data.proxies?.find(p => p.id === data.activeProxyId) || data.proxies?.[0];
      applyProxyConfig(
        data.proxyList || [], 
        data.directList || [],
        data.proxies || [],
        activeProxy
      );
    });
  }
});

// Генерация PAC скрипта
function generatePAC(proxyList, directList, proxies, activeProxy) {
  if (!activeProxy) {
    return `function FindProxyForURL(url, host) { return "DIRECT"; }`;
  }
  
  // Формируем строку с fallback прокси
  const enabledProxies = proxies.filter(p => p.enabled);
  const proxyStrings = enabledProxies.map(p => `${p.type} ${p.host}:${p.port}`);
  const proxyString = proxyStrings.length > 0 ? proxyStrings.join('; ') + '; DIRECT' : 'DIRECT';
  
  const enabledProxyList = proxyList.filter(s => s.enabled);
  const enabledDirectList = directList.filter(s => s.enabled);
  
  let pacScript = `function FindProxyForURL(url, host) {\n`;
  
  // Приоритет 1: Direct список (всегда напрямую)
  enabledDirectList.forEach(site => {
    let pattern = site.value.toLowerCase().trim();
    if (pattern.startsWith('.')) pattern = pattern.substring(1);
    
    if (pattern.startsWith('*.')) {
      // *.domain -> проверяем что заканчивается на .domain
      const domain = pattern.substring(2); // убираем *.
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
      // *.domain -> проверяем что заканчивается на .domain
      const domain = pattern.substring(2); // убираем *.
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
  
  // По умолчанию - напрямую
  pacScript += `  return "DIRECT";\n}`;
  
  return pacScript;
}

// Применение конфигурации прокси
function applyProxyConfig(proxyList, directList, proxies, activeProxy) {
  if (!activeProxy) {
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => logRoute('CONFIG', 'error', 'No active proxy')
    );
    return;
  }
  
  const pacScript = generatePAC(proxyList, directList, proxies, activeProxy);
  
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
        console.error('Proxy error:', chrome.runtime.lastError.message || JSON.stringify(chrome.runtime.lastError));
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
  const timestamp = new Date().toLocaleString('ru-RU');
  const logEntry = `[${timestamp}] ${type}: ${action} - ${details}\n`;
  
  chrome.storage.local.get(['routeLogs'], (data) => {
    let logs = data.routeLogs || '';
    logs += logEntry;
    
    // Ограничиваем размер лога (последние 50000 символов)
    if (logs.length > 50000) {
      logs = logs.slice(-50000);
    }
    
    chrome.storage.local.set({ routeLogs: logs });
  });
}

// Отслеживание связанных доменов для каждой вкладки
const tabDomains = new Map(); // tabId -> Set of domains

// Статистика активности
const activityStats = {
  proxy: 0,
  direct: 0,
  hourly: [], // Массив для графика по минутам
  domains: {} // Счётчик по доменам
};

// Инициализация статистики
function initStats() {
  chrome.storage.local.get(['activityStats'], (data) => {
    if (data.activityStats) {
      Object.assign(activityStats, data.activityStats);
    }
    // Инициализируем массив для последнего часа (60 минут)
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
  
  // Обновляем счётчик по доменам
  if (!activityStats.domains[domain]) {
    activityStats.domains[domain] = { proxy: 0, direct: 0 };
  }
  if (routeType === 'PROXY') {
    activityStats.domains[domain].proxy++;
  } else {
    activityStats.domains[domain].direct++;
  }
  
  // Обновляем данные для графика (текущая минута)
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const lastEntry = activityStats.hourly[activityStats.hourly.length - 1];
  const lastMinute = Math.floor(lastEntry.timestamp / 60000);
  
  if (currentMinute === lastMinute) {
    // Та же минута - обновляем
    if (routeType === 'PROXY') {
      lastEntry.proxy++;
    } else {
      lastEntry.direct++;
    }
  } else {
    // Новая минута - добавляем запись и удаляем старую
    activityStats.hourly.push({
      proxy: routeType === 'PROXY' ? 1 : 0,
      direct: routeType === 'DIRECT' ? 1 : 0,
      timestamp: now
    });
    
    // Оставляем только последние 60 минут
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
      
      // Отслеживаем все домены для вкладки
      if (details.tabId >= 0) {
        if (!tabDomains.has(details.tabId)) {
          tabDomains.set(details.tabId, new Set());
        }
        tabDomains.get(details.tabId).add(host);
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
              let pattern = site.value.toLowerCase().trim();
              if (pattern.startsWith('.')) pattern = pattern.substring(1);
              
              if (pattern.startsWith('*.')) {
                const domain = pattern.substring(2);
                if (host.endsWith('.' + domain) || host === domain) {
                  matchedSite = pattern;
                  routeType = 'DIRECT';
                  break;
                }
              } else if (pattern.includes('*')) {
                const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
                if (new RegExp(`^${regexPattern}$`).test(host)) {
                  matchedSite = pattern;
                  routeType = 'DIRECT';
                  break;
                }
              } else if (pattern.includes('/')) {
                if (details.url.toLowerCase().includes(pattern)) {
                  matchedSite = pattern;
                  routeType = 'DIRECT';
                  break;
                }
              } else {
                if (host === pattern || host.endsWith('.' + pattern)) {
                  matchedSite = pattern;
                  routeType = 'DIRECT';
                  break;
                }
              }
            }
            
            // Если не в Direct, проверяем Proxy список
            if (!matchedSite) {
              for (let site of enabledProxyList) {
                let pattern = site.value.toLowerCase().trim();
                if (pattern.startsWith('.')) pattern = pattern.substring(1);
                
                if (pattern.startsWith('*.')) {
                  const domain = pattern.substring(2);
                  if (host.endsWith('.' + domain) || host === domain) {
                    matchedSite = pattern;
                    routeType = 'PROXY';
                    break;
                  }
                } else if (pattern.includes('*')) {
                  const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
                  if (new RegExp(`^${regexPattern}$`).test(host)) {
                    matchedSite = pattern;
                    routeType = 'PROXY';
                    break;
                  }
                } else if (pattern.includes('/')) {
                  if (details.url.toLowerCase().includes(pattern)) {
                    matchedSite = pattern;
                    routeType = 'PROXY';
                    break;
                  }
                } else {
                  if (host === pattern || host.endsWith('.' + pattern)) {
                    matchedSite = pattern;
                    routeType = 'PROXY';
                    break;
                  }
                }
              }
            }
          }
          
          const proxyInfo = routeType === 'PROXY' && activeProxy 
            ? `${activeProxy.type} ${activeProxy.host}:${activeProxy.port}`
            : 'DIRECT';
          
          // Логируем только если есть совпадение
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

// API для получения связанных доменов текущей вкладки
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getRelatedDomains') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        const domains = tabDomains.get(tabs[0].id);
        const mainUrl = new URL(tabs[0].url);
        const mainHost = mainUrl.hostname;
        
        if (domains) {
          // Фильтруем домены: убираем основной и сортируем
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
    return true; // Асинхронный ответ
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
});
