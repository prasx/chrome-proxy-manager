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
});

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
});
