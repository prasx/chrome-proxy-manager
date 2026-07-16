importScripts('shared.js');

// ===================== УТИЛИТЫ =====================

/**
 * Проверяет, что прокси-сервер настроен (заполнен хост и порт).
 * @param {object} proxy
 * @returns {boolean}
 */
function isProxyConfigured(proxy) {
  return proxy && proxy.enabled !== false && proxy.host && String(proxy.host).trim() && proxy.port;
}

/**
 * Экранирует спецсимволы для вставки строки в PAC-скрипт.
 * @param {string} str
 * @returns {string}
 */
function escapePacString(str) {
  return String(str).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n');
}

// ===================== КЭШ КОНФИГУРАЦИИ =====================

/** @type {{ proxyList: Array, directList: Array, proxies: Array, activeProxyId: (string|null), extensionEnabled: boolean, autoProxyEnabled: boolean }} */
let cachedConfig = {
  proxyList: [],
  directList: [],
  proxies: [],
  activeProxyId: null,
  extensionEnabled: true,
  autoProxyEnabled: true,
  killSwitchEnabled: false
};

loadConfigFromStorage(() => applyProxyConfig());

/**
 * Загружает настройки из chrome.storage.local в кэш.
 * @param {Function} [cb] Колбэк после загрузки
 */
function loadConfigFromStorage(cb) {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled'], (data) => {
    cachedConfig.proxyList = data.proxyList || [];
    cachedConfig.directList = data.directList || [];
    cachedConfig.proxies = data.proxies || [];
    cachedConfig.activeProxyId = data.activeProxyId;
    cachedConfig.extensionEnabled = data.extensionEnabled !== false;
    cachedConfig.autoProxyEnabled = data.autoProxyEnabled !== false;
    cachedConfig.killSwitchEnabled = data.killSwitchEnabled === true;
    if (cb) cb();
  });
}

// ===================== ЛОГИРОВАНИЕ =====================

/** Буфер логов в памяти, сбрасывается в storage раз в 30 секунд */
let logBuffer = '';
const MAX_LOG_SIZE = 50000;

/**
 * Добавляет запись в буфер логов.
 * @param {string} type Категория (REQUEST, CONFIG, AUTO, ERROR)
 * @param {string} action Действие
 * @param {string} details Подробности
 */
function logRoute(type, action, details) {
  const timeString = new Date().toLocaleTimeString('ru-RU');
  logBuffer += `[${timeString}] ${type}: ${action} - ${details}\n`;
  if (logBuffer.length > MAX_LOG_SIZE) {
    logBuffer = logBuffer.slice(-MAX_LOG_SIZE);
  }
}

/** Сбрасывает буфер логов в chrome.storage.local */
function flushLogs() {
  if (!logBuffer) return;
  chrome.storage.local.get(['routeLogs'], (data) => {
    let logs = (data.routeLogs || '') + logBuffer;
    logBuffer = '';
    if (logs.length > MAX_LOG_SIZE) logs = logs.slice(-MAX_LOG_SIZE);
    chrome.storage.local.set({ routeLogs: logs });
  });
}

setInterval(flushLogs, 30000);

setInterval(() => {
  chrome.storage.local.set({ routeLogs: '' }, () => {
    logRoute('CONFIG', 'Auto-cleanup', 'Логи очищены автоматически');
  });
}, 3 * 60 * 60 * 1000);

// ===================== ПРОКСИ-ЧЕЙН =====================

/**
 * Строит цепочку фоллбэка для PAC-скрипта.
 * Активный прокси — первый, остальные — по порядку.
 * Kill Switch: цепочка заканчивается на прокси (без DIRECT).
 * @param {Array} proxies Все прокси
 * @param {object|null} activeProxy Текущий активный
 * @param {boolean} killSwitch Режим Kill Switch
 * @returns {string|null} Строка вида "SOCKS5 host:port; HTTP host2:port2; DIRECT"
 */
function buildProxyReturnChain(proxies, activeProxy, killSwitch) {
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

  let result = chain.map(p => `${p.type} ${p.host}:${p.port}`).join('; ');
  if (!killSwitch) result += '; DIRECT';
  return result;
}

// ===================== МЭТЧИНГ ДОМЕНОВ =====================

/**
 * Проверяет, соответствует ли host паттерну.
 * Поддерживает: точные домены, *.wildcard, паттерны с *, URL-фрагменты.
 * @param {string} host Hostname из запроса
 * @param {string} pattern Паттерн из списка правил
 * @param {string} [url] Полный URL (нужен для фрагментов "/path")
 * @returns {boolean}
 */
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

// ===================== ГЕНЕРАЦИЯ PAC =====================

/**
 * Генерирует PAC-скрипт на основе текущих правил.
 * Сначала проверяются direct-правила, потом proxy-правила.
 * Kill Switch: неиспользуемые домены блокируются (не DIRECT).
 * @returns {string} Код функции FindProxyForURL
 */
function generatePAC() {
  const cfg = cachedConfig;
  const killSwitch = cfg.killSwitchEnabled;
  const proxyChain = buildProxyReturnChain(cfg.proxies, findProxyById(cfg.proxies, cfg.activeProxyId), killSwitch);

  const ipCheckRule = `  if (host === "api.ipify.org" || host.endsWith(".api.ipify.org")) return "DIRECT";\n`;

  if (!proxyChain) {
    return killSwitch
      ? 'function FindProxyForURL(url, host) {\n' + ipCheckRule + '  return "PROXY 0.0.0.0:0";\n}'
      : 'function FindProxyForURL(url, host) {\n' + ipCheckRule + '  return "DIRECT";\n}';
  }

  const enabledDirect = cfg.directList.filter(s => s.enabled);
  const enabledProxy = cfg.proxyList.filter(s => s.enabled);

  let code = 'function FindProxyForURL(url, host) {\n';

  enabledDirect.forEach(site => {
    const pat = site.value.toLowerCase().trim().replace(/^\./, '');
    code += generatePACondition(pat, 'DIRECT');
  });

  enabledProxy.forEach(site => {
    const pat = site.value.toLowerCase().trim().replace(/^\./, '');
    code += generatePACondition(pat, proxyChain);
  });

  code += `  if (host === "api.ipify.org" || host.endsWith(".api.ipify.org")) return "${escapePacString(proxyChain)}";\n`;

  code += killSwitch
    ? '  return "PROXY 0.0.0.0:0";\n}'
    : '  return "DIRECT";\n}';
  return code;
}

/**
 * Генерирует одну строку условия внутри PAC-функции.
 * @param {string} pattern Паттерн
 * @param {string} result Что возвращать при совпадении
 * @returns {string}
 */
function generatePACondition(pattern, result) {
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

// ===================== ПРИМЕНЕНИЕ НАСТРОЕК ПРОКСИ =====================

/** Применяет конфигурацию прокси через chrome.proxy.settings.set (без debounce) */
let _testingProxy = false;
let _testingProxyTimer = null;
let _savedProxySettings = null;
let _configReady = false;
const _configReadyCallbacks = [];

function onConfigReady(cb) {
  if (_configReady) { cb(); return; }
  _configReadyCallbacks.push(cb);
}

function clearTestingProxy() {
  _testingProxy = false;
  if (_testingProxyTimer) { clearTimeout(_testingProxyTimer); _testingProxyTimer = null; }
  _savedProxySettings = null;
}

function applyProxyConfigNow() {
  if (_testingProxy) return;
  const cfg = cachedConfig;

  const notifyReady = () => {
    _configReady = true;
    const cbs = _configReadyCallbacks.splice(0);
    cbs.forEach(cb => cb());
  };

  if (!cfg.extensionEnabled) {
    clearBadge();
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => { logRoute('CONFIG', 'Disabled', 'Extension is turned off'); notifyReady(); }
    );
    return;
  }

  const activeProxy = findProxyById(cfg.proxies, cfg.activeProxyId);
  const proxyChain = buildProxyReturnChain(cfg.proxies, activeProxy, cfg.killSwitchEnabled);

  if (!proxyChain) {
    const reason = activeProxy
      ? `Invalid proxy "${activeProxy.name}" (missing host or port)`
      : 'No active proxy selected';
    chrome.proxy.settings.set(
      { value: { mode: 'direct' }, scope: 'regular' },
      () => { logRoute('CONFIG', 'error', `${reason} — using DIRECT`); notifyReady(); }
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
      notifyReady();
    }
  );
}

/** Debounced-версия applyProxyConfigNow (200 мс) */
const applyProxyConfig = debounce(applyProxyConfigNow, 200);

// ===================== НОРМАЛИЗАЦИЯ ДОМЕНОВ =====================

/**
 * Нормализует домен для правил: превращает поддомены CDN/динамических хостов
 * в wildcard-паттерны. Нужно для авто-добавления связанных доменов.
 * @param {string} domain
 * @returns {string}
 */
function normalizeDomain(domain) {
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
  if (TWO_LEVEL_TLDS.has(lastTwo)) {
    if (parts.length >= 4) return `*.${parts.slice(-3).join('.')}`;
    return domain;
  }
  if (parts.length >= 3) return `*.${parts.slice(-2).join('.')}`;
  return domain;
}

// ===================== СВЯЗАННЫЕ ДОМЕНЫ =====================

/** Карта: tabId -> Set нормализованных доменов, собранных при загрузке страницы */
const tabDomains = new Map();

/**
 * Добавляет все собранные домены вкладки в указанный список правил.
 * @param {number} tabId
 * @param {'proxyList'|'directList'} listKey
 */
function addRelatedDomains(tabId, listKey) {
  const domains = tabDomains.get(tabId);
  if (!domains || domains.size === 0) return;

  const otherKey = listKey === 'proxyList' ? 'directList' : 'proxyList';
  chrome.storage.local.get([listKey, otherKey], (data) => {
    let list = data[listKey] || [];
    const otherList = data[otherKey] || [];
    let addedCount = 0;

    domains.forEach(domain => {
      const dl = domain.toLowerCase();
      const inTarget = list.some(s => s.value.toLowerCase() === dl);
      const inOther = otherList.some(s => s.value.toLowerCase() === dl);
      if (!inTarget && !inOther) {
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

// ===================== СТАТИСТИКА =====================

/** Счётчики и почасовая статистика за текущий день (00:00–23:59) */
const activityStats = {
  proxy: 0, direct: 0, daily: [], dailyDate: '', domains: {}
};

/** Инициализирует дневной массив на 24 часа */
function initDaily() {
  activityStats.daily = Array(24).fill(0).map(() => ({ proxy: 0, direct: 0 }));
  activityStats.dailyDate = new Date().toDateString();
}

/** Загружает сохранённую статистику из storage */
function initStats() {
  chrome.storage.local.get(['activityStats'], (data) => {
    if (data.activityStats) Object.assign(activityStats, data.activityStats);
    const today = new Date().toDateString();
    if (!activityStats.daily || activityStats.daily.length !== 24 || activityStats.dailyDate !== today) {
      activityStats.daily = Array(24).fill(0).map((_, i) => {
        const t = new Date(); t.setHours(i, 0, 0, 0);
        return { proxy: 0, direct: 0, timestamp: t.getTime() };
      });
      activityStats.dailyDate = today;
    }
  });
}

/** Сохраняет статистику в storage */
function saveStats() {
  chrome.storage.local.set({ activityStats });
}

/**
 * Обновляет счётчики при маршрутизации запроса.
 * @param {'PROXY'|'DIRECT'} routeType
 * @param {string} domain
 */
function updateStats(routeType, domain) {
  if (routeType === 'PROXY') activityStats.proxy++;
  else activityStats.direct++;

  if (!activityStats.domains[domain]) activityStats.domains[domain] = { proxy: 0, direct: 0 };
  if (routeType === 'PROXY') activityStats.domains[domain].proxy++;
  else activityStats.domains[domain].direct++;

  const now = new Date();
  const today = now.toDateString();
  if (today !== activityStats.dailyDate) {
    activityStats.daily = Array(24).fill(0).map((_, i) => {
      const t = new Date(now); t.setHours(i, 0, 0, 0);
      return { proxy: 0, direct: 0, timestamp: t.getTime() };
    });
    activityStats.dailyDate = today;
  }

  const hour = now.getHours();
  if (routeType === 'PROXY') activityStats.daily[hour].proxy++;
  else activityStats.daily[hour].direct++;
  saveStats();
}

initStats();

// ===================== ИНИЦИАЛИЗАЦИЯ =====================

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'installDate', 'lastUpdateDate', 'extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled', 'autoProxyTimeout'], (data) => {
    const proxies = data.proxies || [];
    let activeProxyId = data.activeProxyId;
    if (activeProxyId && proxies.length > 0 && !findProxyById(proxies, activeProxyId)) {
      activeProxyId = proxies[0].id;
    }
    if (proxies.length === 0) activeProxyId = null;

    const defaults = {
      proxyList: data.proxyList || [],
      directList: data.directList || [],
      proxies,
      activeProxyId,
      extensionEnabled: data.extensionEnabled !== false,
      autoProxyEnabled: data.autoProxyEnabled === true,
      autoProxyTimeoutEnabled: data.autoProxyTimeoutEnabled === true,
      autoProxyTimeout: parseInt(data.autoProxyTimeout, 10) || 5
    };

    if (!data.installDate) defaults.installDate = Date.now();
    if (details.reason === 'update') defaults.lastUpdateDate = Date.now();

    chrome.storage.local.set(defaults, () => {
      cachedConfig.proxyList = defaults.proxyList;
      cachedConfig.directList = defaults.directList;
      cachedConfig.proxies = defaults.proxies;
      cachedConfig.activeProxyId = defaults.activeProxyId;
      cachedConfig.extensionEnabled = defaults.extensionEnabled;
      cachedConfig.autoProxyEnabled = defaults.autoProxyEnabled;
      applyProxyConfig();
    });
  });

  createContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  loadConfigFromStorage(() => applyProxyConfig());
});

// ===================== КОНТЕКСТНОЕ МЕНЮ =====================

/** Создаёт пункты контекстного меню для добавления/удаления доменов */
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'addToProxyList', title: 'Добавить в список прокси', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'addToDirectList', title: 'Добавить в список напрямую', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'separator1', type: 'separator', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'removeFromLists', title: 'Удалить из всех списков', contexts: ['page', 'link'] });
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
        if (!proxyList.find(s => s.value === domain) && !directList.find(s => s.value === domain)) {
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
        if (!directList.find(s => s.value === domain) && !proxyList.find(s => s.value === domain)) {
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

// ===================== СЛУШАТЕЛЬ STORAGE =====================

chrome.storage.onChanged.addListener((changes) => {
  if (_testingProxy) return;
  const relevant = ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled'];
  if (!relevant.some(k => changes[k])) return;

  loadConfigFromStorage(() => applyProxyConfig());
});

// ===================== АНАЛИЗ ЗАПРОСОВ =====================

/**
 * Обрабатывает входящие HTTP-запросы: собирает домены для анализа,
 * отслеживает pending-запросы для timeout auto-proxy,
 * логирует маршрутизацию и обновляет бейдж.
 */
const handleBeforeRequest = (details) => {
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

        const timerState = tabLoadTimers.get(details.tabId);
        if (timerState && timerState.pendingRequests) {
          timerState.pendingRequests.set(details.requestId, host);
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
        if (!activeProxy) {
          console.warn('Active proxy not found for matched site:', matchedSite);
        }
        const proxyInfo = activeProxy ? `${activeProxy.type} ${activeProxy.host}:${activeProxy.port}` : 'DIRECT';
        logRoute('REQUEST', routeType, `${host} -> ${proxyInfo} (matched: ${matchedSite})`);
        updateStats(routeType, host);
      }

      if (details.type === 'main_frame') {
        if (matchedSite) showBadge(routeType === 'PROXY' ? 'P' : 'D');
        else clearBadge();
        if (tabLoadTimers.has(details.tabId)) {
          clearTimeout(tabLoadTimers.get(details.tabId).timeoutId);
        }
        tabLoadTimers.set(details.tabId, { mainDomain: host, mainUrl: details.url, timeoutId: null, pendingRequests: new Map(), mainLoaded: false });
        startAutoProxyTimer(details.tabId, host);
      }
    } catch (e) {
      console.error('Request analysis error:', e);
    }
};
chrome.webRequest.onBeforeRequest.addListener(handleBeforeRequest, { urls: ['<all_urls>'] });

// ===================== AUTO-PROXY (по ошибкам ресурсов) =====================

/**
 * Обрабатывает ошибки загрузки ресурсов (не навигации).
 * Если ресурс не загрузился и не противоречит direct-списку — добавляет домен в прокси.
 */
chrome.webRequest.onErrorOccurred.addListener((details) => {
  const ts = tabLoadTimers.get(details.tabId);
  if (ts) ts.pendingRequests.delete(details.requestId);

  if (!cachedConfig.extensionEnabled || !cachedConfig.autoProxyEnabled) return;
  if (!details.url || !details.error) return;
  if (!RETRYABLE_ERRORS.some(e => details.error.includes(e))) return;

  let host;
  try { host = new URL(details.url).hostname; } catch (_) { return; }
  const normalized = normalizeDomain(host).toLowerCase();

  if (autoProxiedDomains.has(normalized)) return;
  if (cachedConfig.directList.some(s => s.value.toLowerCase() === normalized)) return;
  if (cachedConfig.proxyList.some(s => s.value.toLowerCase() === normalized)) return;

  autoProxiedDomains.add(normalized);

  const proxyList = [...cachedConfig.proxyList];
  proxyList.push({ id: crypto.randomUUID(), value: normalized, enabled: true });
  chrome.storage.local.set({ proxyList }, () => {
    logRoute('AUTO', 'Авто-прокси (ресурс)', `${host} → ${normalized} (${details.error})`);
    showBadge('A');
  });
}, { urls: ['<all_urls>'] });

// ===================== ОЧИСТКА ВКЛАДОК =====================

chrome.tabs.onRemoved.addListener((tabId) => {
  tabDomains.delete(tabId);
  const ts = tabLoadTimers.get(tabId);
  if (ts && ts.timeoutId) clearTimeout(ts.timeoutId);
  tabLoadTimers.delete(tabId);
});

// ===================== AUTO-PROXY (по ошибкам) =====================

const RETRYABLE_ERRORS = [
  'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_RESET',
  'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_NETWORK_ACCESS_DENIED',
  'net::ERR_CONNECTION_CLOSED', 'net::ERR_NAME_UNRESOLVED'
];

const BADGE_COLORS = { P: '#34a853', D: '#ea8600', A: '#1a73e8' };

function showBadge(text, bgColor) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: bgColor || BADGE_COLORS[text] || [0, 0, 0, 0] });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

/** Множество доменов, уже добавленных через auto-proxy (чтобы не дублировать) */
const autoProxiedDomains = new Set();

/**
 * Переключает активный прокси на следующий в списке при падении текущего.
 */
function switchToFallbackProxy() {
  chrome.storage.local.get(['proxies', 'activeProxyId'], (data) => {
    const proxies = (data.proxies || []).filter(isProxyConfigured);
    if (proxies.length < 2) return;

    const currentId = data.activeProxyId;
    const currentIdx = proxies.findIndex(p => sameProxyId(p.id, currentId));
    if (currentIdx === -1) return;

    const nextIdx = (currentIdx + 1) % proxies.length;
    const nextProxy = proxies[nextIdx];
    logRoute('AUTO', 'Proxy fallback', `${proxies[currentIdx].name || proxies[currentIdx].host} → ${nextProxy.name || nextProxy.host}`);
    chrome.storage.local.set({ activeProxyId: nextProxy.id });
    showBadge('A', '#ea8600');
  });
}

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  const ts = tabLoadTimers.get(details.tabId);
  if (ts) ts.pendingRequests.delete(details.requestId);

  if (details.tabId >= 0 && details.url && details.error) {
    try {
      const url = new URL(details.url);
      const normalized = normalizeDomain(url.hostname);
      if (!tabDomains.has(details.tabId)) {
        tabDomains.set(details.tabId, new Set());
      }
      const set = tabDomains.get(details.tabId);
      set.add(normalized);
      if (set.size > 100) {
        const first = set.values().next().value;
        set.delete(first);
      }
    } catch (e) {
      console.error('Error in onErrorOccurred:', e);
    }
  }

  if (details.frameId !== 0) return;
  if (!details.url.startsWith('http://') && !details.url.startsWith('https://')) return;
  if (!RETRYABLE_ERRORS.some(e => details.error && details.error.includes(e))) return;

  let domain;
  try { domain = new URL(details.url).hostname; } catch (e) { return; }

  const normalized = normalizeDomain(domain);
  if (autoProxiedDomains.has(normalized)) return;

  chrome.storage.local.get(['proxyList', 'directList', 'extensionEnabled', 'autoProxyEnabled', 'proxies', 'activeProxyId'], (data) => {
    if (data.extensionEnabled === false) return;
    const nl = normalized.toLowerCase();
    const inProxyList = (data.proxyList || []).some(s => s.value.toLowerCase() === nl);

    if (inProxyList) {
      const proxies = (data.proxies || []).filter(isProxyConfigured);
      if (proxies.length >= 2) switchToFallbackProxy();
      return;
    }

    if (!data.autoProxyEnabled) return;
    if ((data.directList || []).some(s => s.value.toLowerCase() === nl)) return;

    autoProxiedDomains.add(normalized);

    const proxyList = data.proxyList || [];
    proxyList.push({ id: crypto.randomUUID(), value: normalized, enabled: true });
    chrome.storage.local.set({ proxyList }, () => {
      logRoute('AUTO', 'Auto-proxy', `${domain} → ${normalized} (${details.error})`);
      showBadge('A', '#1a73e8');
      chrome.notifications.create({
        type: 'basic', iconUrl: 'logo.png',
        title: 'Auto Proxy',
        message: `${normalized} — добавлен в список прокси`
      });
      setTimeout(() => chrome.tabs.reload(details.tabId, { bypassCache: true }), 1000);
    });
  });
});

// ===================== AUTO-PROXY (по таймауту) =====================

/** Карта: tabId -> { mainDomain, timeoutId, pendingRequests, mainLoaded } */
const tabLoadTimers = new Map();

/**
 * Запускает таймер для отслеживания долгой загрузки страницы.
 * Если страница не загрузилась за N секунд, домены из pending-запросов
 * добавляются в список прокси.
 * @param {number} tabId
 * @param {string} mainDomain
 */
function startAutoProxyTimer(tabId, mainDomain) {
  if (tabId == null || tabId < 0 || !mainDomain) {
    return;
  }

  chrome.storage.local.get(['autoProxyTimeoutEnabled', 'autoProxyTimeout'], (data) => {
    if (!data.autoProxyTimeoutEnabled) {
      tabLoadTimers.delete(tabId);
      return;
    }

    const existing = tabLoadTimers.get(tabId);
    if (!existing) return;

    const timeoutMs = (parseInt(data.autoProxyTimeout, 10) || 5) * 1000;

      if (!existing.timeoutId) {
        existing.timeoutId = setTimeout(() => {
          const state = tabLoadTimers.get(tabId);
          if (!state) return;
          tabLoadTimers.delete(tabId);

          const stuckDomains = new Set();

          if (!state.mainLoaded && state.mainDomain) {
            stuckDomains.add(state.mainDomain);
          }
          for (const domain of state.pendingRequests.values()) {
            stuckDomains.add(domain);
          }
        if (stuckDomains.size === 0) return;

        const domainsToAdd = [...stuckDomains].filter(d => d).map(d => normalizeDomain(d));
        if (!domainsToAdd || domainsToAdd.length === 0) return;

        chrome.storage.local.get(['proxyList', 'directList'], (sd) => {
          let proxyList = sd.proxyList || [];
          const directList = sd.directList || [];
          let added = [];

          for (const d of domainsToAdd) {
            const dl = d.toLowerCase();
            if (proxyList.some(s => s.value.toLowerCase() === dl)) continue;
            if (directList.some(s => s.value.toLowerCase() === dl)) continue;
            proxyList.push({ id: crypto.randomUUID(), value: d, enabled: true });
            added.push(d);
          }

          if (added.length === 0) return;

          chrome.storage.local.set({ proxyList }, () => {
            logRoute('AUTO', 'Auto-proxy (timeout)', `${state.mainDomain} → ${added.join(', ')} (${timeoutMs/1000}s)`);
            showBadge('A', '#1a73e8');
            chrome.notifications.create({
              type: 'basic', iconUrl: 'logo.png',
              title: 'Auto Proxy',
              message: `${added.join(', ')} — добавлены через авто-прокси (${timeoutMs/1000}с)`
            });
            setTimeout(() => {
              if (state.mainUrl && state.mainUrl.startsWith('http')) {
                chrome.tabs.update(tabId, { url: state.mainUrl });
              } else {
                chrome.tabs.reload(tabId, { bypassCache: true });
              }
            }, 1000);
          });
        });
      }, timeoutMs);
    }
  });
}

/**
 * Обрабатывает завершённые запросы: убирает их из pending-списка
 * и отмечает main_frame как загруженный.
 */
const handleCompleted = (details) => {
  const state = tabLoadTimers.get(details.tabId);
  if (state) {
    state.pendingRequests.delete(details.requestId);
    if (details.type === 'main_frame') state.mainLoaded = true;
  }
};
chrome.webRequest.onCompleted.addListener(handleCompleted, { urls: ['<all_urls>'] });

// ===================== ОБРАБОТЧИК СООБЩЕНИЙ =====================

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'getRelatedDomains') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ mainDomain: null, relatedDomains: [] });

      const domains = tabDomains.get(tabs[0].id);
      if (!domains) return sendResponse({ mainDomain: null, relatedDomains: [] });

      const mainHost = new URL(tabs[0].url).hostname;
      const mainNorm = normalizeDomain(mainHost);

      const seen = new Set();
      const related = [];

      domains.forEach(d => {
        if (d === mainHost || d === mainNorm) return;
        const dl = d.toLowerCase();
        if (!seen.has(dl)) {
          seen.add(dl);
          related.push(d);
        }
      });
      related.sort();

      sendResponse({
        mainDomain: mainHost,
        relatedDomains: related
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
    initDaily();
    saveStats();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'setWebrtcPolicy') {
    try {
      const policy = request.enabled ? 'proxy_only' : 'default_public_interface_only';
      chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: policy }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  if (request.action === 'getWebrtcPolicy') {
    try {
      chrome.privacy.network.webRTCIPHandlingPolicy.get({}, (result) => {
        const enabled = result.value === 'proxy_only';
        sendResponse({ enabled });
      });
    } catch (e) {
      sendResponse({ enabled: false });
    }
    return true;
  }

  if (request.action === 'clearBadge') {
    clearBadge();
    return true;
  }

  if (request.action === 'getActiveProxyIp') {
    const ap = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
    if (!ap || !ap.host || !ap.port) {
      sendResponse({ success: false, error: 'No active proxy' }); return true;
    }

    onConfigReady(() => {
      fetch('https://api.ipify.org?format=json&_=' + Date.now(), { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(d => { const ip = d && d.ip; if (!ip) throw new Error('No IP'); return ip; })
        .then(ip => sendResponse({ success: true, ip }))
        .catch(err => sendResponse({ success: false, error: 'Proxy недоступен' }));
    });
    return true;
  }

  if (request.action === 'restoreProxySettings') {
    clearTestingProxy();
    chrome.proxy.settings.set({ value: _savedProxySettings || { mode: 'direct' }, scope: 'regular' });
    return true;
  }

  if (request.action === 'testSpecificProxy') {
    clearTestingProxy();
    const proxyToTest = findProxyById(cachedConfig.proxies, request.proxyId);
    if (!proxyToTest || !proxyToTest.host || !proxyToTest.port) {
      return sendResponse({ success: false, error: 'Proxy not found or misconfigured' });
    }
    _testingProxy = true;
    _testingProxyTimer = setTimeout(clearTestingProxy, 30000);
    const hostname = String(proxyToTest.host).trim();
    const testPacScript = `function FindProxyForURL(url,host){if(host==="api.ipify.org")return"${escapePacString(proxyToTest.type+' '+hostname+':'+proxyToTest.port)}";return"DIRECT";}`;

    chrome.proxy.settings.get({}, (current) => {
      _savedProxySettings = current.value;
      chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: testPacScript } }, scope: 'regular' }, () => {
        sendResponse({ ready: true, proxyHost: proxyToTest.host });
      });
    });
    return true;
  }

});
