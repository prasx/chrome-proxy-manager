importScripts('shared.js');

/**
 * Service worker Proxy Manager.
 *
 * Основные правила:
 * - конфигурация применяется последовательно, последняя запись побеждает;
 * - тест прокси не оставляет браузер в «тестовом» PAC-режиме;
 * - HTTP/HTTPS-прокси с логином получают учётные данные через onAuthRequired;
 * - события прокси-ошибок и сетевые ошибки разделены, чтобы не крутить
 *   правила и не перезагружать вкладку по кругу.
 */

// ===================== КОНСТАНТЫ =====================

const CONFIG_KEYS = ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled'];
const MAX_LOG_SIZE = 50000;
const MAX_STAT_DOMAINS = 400;
const STATS_SAVE_DELAY = 1200;
const LOG_FLUSH_DELAY = 400;
const AUTO_PROXY_COOLDOWN = 15000;
const AUTO_NOTIFY_COOLDOWN = 30000;
const RELOAD_COOLDOWN = 5000;
const FALLBACK_FAILURE_WINDOW = 60000;
const FALLBACK_COOLDOWN = 30000;
const MAINTENANCE_ALARM = 'proxyManagerMaintenance';
const RESTORE_ALARM = 'proxyManagerRestoreProxy';
const HEALTH_ALARM = 'proxyManagerHealth';

const RETRYABLE_ERRORS = [
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_TIMED_OUT',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_ADDRESS_INVALID',
  'net::ERR_NETWORK_ACCESS_DENIED',
  'net::ERR_NAME_UNRESOLVED'
];

const PROXY_ERRORS = [
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
  'net::ERR_PROXY_AUTH_UNSUPPORTED',
  'net::ERR_PROXY_AUTH_REQUESTED',
  'net::ERR_PROXY_CERTIFICATE_INVALID',
  'net::ERR_SOCKS_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  'net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED'
];

const ALL_RETRYABLE_ERRORS = RETRYABLE_ERRORS.concat(PROXY_ERRORS);

const BADGE_COLORS = { P: '#17a34a', D: '#d97706', A: '#2f6feb', '!': '#dc2626' };

// ===================== СОСТОЯНИЕ =====================

/** @type {{proxyList: Array, directList: Array, proxies: Array, activeProxyId: (string|null), extensionEnabled: boolean, autoProxyEnabled: boolean, killSwitchEnabled: boolean}} */
let cachedConfig = {
  proxyList: [],
  directList: [],
  proxies: [],
  activeProxyId: null,
  extensionEnabled: true,
  autoProxyEnabled: true,
  killSwitchEnabled: false
};

let configReady = false;
const configReadyWaiters = [];
let applyInFlight = false;
let applyPending = false;
let lastAppliedSignature = '';
const applyIdleWaiters = [];

let logBuffer = '';
let logFlushTimer = null;
let logFlushInFlight = false;
let logEpoch = 0;

let statsSaveTimer = null;
let lastStatsSaveAt = 0;

/** Активный тест: в это время нельзя перезаписывать PAC обычной конфигурацией. */
let testSession = null;
let lastProxyError = null;
let lastIssue = null;
let acknowledgedIssueKey = '';
let issueMuteUntil = 0;
let activeHealthFailures = 0;
let lastAutoSwitchAt = 0;
let lastHealthIssueAt = 0;

/** Попытки авто-прокси, чтобы не долбить storage на каждый ресурс. */
const autoProxyAttempts = new Map();
let lastAutoNotifyAt = 0;

/** Ошибки активного прокси (для автоматического fallback). */
const proxyFailures = new Map();
let lastFallbackAt = 0;
let lastFallbackNotifyAt = 0;
let lastAuthWarningAt = 0;
let lastConfigErrorNotifyAt = 0;
let lastProxyErrorLog = { message: '', at: 0 };

/** Собранные домены вкладок: tabId -> Set<string>. */
const tabDomains = new Map();
let tabDomainsSessionReady = false;
const tabDomainsWaiters = [];
let sessionSaveTimer = null;

/** Состояние загрузки вкладки для авто-прокси по таймауту. */
const tabLoadTimers = new Map();
const lastReloadByTab = new Map();

/** Счётчики и почасовая статистика за текущий день. */
const activityStats = {
  proxy: 0,
  direct: 0,
  daily: [],
  dailyDate: '',
  domains: {}
};

// ===================== УТИЛИТЫ =====================

function proxyLabel(proxy) {
  if (!proxy) return 'нет прокси';
  return proxy.name || `${proxy.host}:${proxy.port}`;
}

function publicProxy(proxy) {
  if (!proxy) return null;
  return {
    id: String(proxy.id),
    name: proxy.name || '',
    host: String(proxy.host || ''),
    port: String(proxy.port || ''),
    type: normalizeProxyType(proxy.type) || String(proxy.type || ''),
    configured: isProxyConfigured(proxy),
    hasAuth: String(proxy.username || '').trim() !== '',
    socks: isSocksProxyType(proxy.type)
  };
}

function isProxyErrorCode(error) {
  return PROXY_ERRORS.some(code => String(error || '').includes(code));
}

function isRetryableErrorCode(error) {
  return ALL_RETRYABLE_ERRORS.some(code => String(error || '').includes(code));
}

function friendlyProbeError(error) {
  const message = String((error && error.message) || error || '');
  if (/abort|timeout|timed out/i.test(message)) return 'Таймаут: прокси не ответил';
  if (/failed to fetch|networkerror|load failed/i.test(message)) return 'Прокси недоступен или отклоняет соединение';
  return message || 'Не удалось проверить прокси';
}

function configSignature(config) {
  const norm = value => String(value == null ? '' : value).trim().toLowerCase();
  return JSON.stringify({
    enabled: config.extensionEnabled !== false,
    kill: config.killSwitchEnabled === true,
    active: config.activeProxyId == null ? null : String(config.activeProxyId),
    proxies: (config.proxies || []).map(p => [
      String(p.id), p.enabled !== false, normalizeProxyType(p.type), norm(p.host), String(p.port == null ? '' : p.port)
    ]),
    proxy: (config.proxyList || []).map(s => [norm(s.value), s.enabled !== false]),
    direct: (config.directList || []).map(s => [norm(s.value), s.enabled !== false])
  });
}

function notifyConfigReady() {
  if (configReady) return;
  configReady = true;
  configReadyWaiters.splice(0).forEach(cb => cb());
}

function onConfigReady(cb) {
  if (configReady) { cb(); return; }
  configReadyWaiters.push(cb);
}

function flushApplyIdleWaiters() {
  if (applyInFlight || testSession) return;
  applyIdleWaiters.splice(0).forEach(cb => cb());
}

function whenApplyIdle(cb) {
  if (!applyInFlight && !testSession) { cb(); return; }
  applyIdleWaiters.push(cb);
}

// ===================== КОНФИГУРАЦИЯ =====================

let configLoadSequence = 0;

function applyConfigData(data) {
  cachedConfig.proxyList = (Array.isArray(data.proxyList) ? data.proxyList : []).filter(item => item && typeof item === 'object');
  cachedConfig.directList = (Array.isArray(data.directList) ? data.directList : []).filter(item => item && typeof item === 'object');
  cachedConfig.proxies = (Array.isArray(data.proxies) ? data.proxies : []).filter(item => item && typeof item === 'object');
  cachedConfig.activeProxyId = data.activeProxyId == null ? null : data.activeProxyId;
  cachedConfig.extensionEnabled = data.extensionEnabled !== false;
  cachedConfig.autoProxyEnabled = data.autoProxyEnabled !== false;
  cachedConfig.killSwitchEnabled = data.killSwitchEnabled === true;
}

function loadConfigFromStorage(cb) {
  const sequence = ++configLoadSequence;
  chrome.storage.local.get(CONFIG_KEYS, (data) => {
    if (sequence !== configLoadSequence) return; // уже загружена более свежая версия
    applyConfigData(data);
    if (cb) cb();
  });
}

/**
 * Принудительно перечитывает конфигурацию перед тестом/проверкой:
 * пользователь мог только что сохранить сервер, и кэш ещё не обновился.
 */
function ensureConfigFresh() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONFIG_KEYS, (data) => {
      configLoadSequence++;
      applyConfigData(data);
      resolve();
    });
  });
}

/**
 * Применяет конфигурацию. Синхронно ставит в очередь следующую попытку,
 * чтобы несколько быстрых изменений подряд не оставили устаревший PAC.
 */
function applyProxyConfigNow() {
  if (testSession) {
    applyPending = true;
    return;
  }
  if (applyInFlight) {
    applyPending = true;
    return;
  }

  applyInFlight = true;
  const config = cachedConfig;
  const signature = configSignature(config);

  if (configReady && signature === lastAppliedSignature) {
    applyInFlight = false;
    if (applyPending) { applyPending = false; applyProxyConfigNow(); }
    else flushApplyIdleWaiters();
    return;
  }

  let value;
  if (!config.extensionEnabled) {
    clearBadge();
    value = { mode: 'direct' };
  } else {
    const pac = generatePAC(config);
    if (pac.length > 900000) {
      logRoute('ERROR', 'PAC size', `${pac.length} байт — Chrome может отклонить конфигурацию`);
    }
    value = { mode: 'pac_script', pacScript: { data: pac } };
  }

  chrome.proxy.settings.set({ value, scope: 'regular' }, () => {
    const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
    applyInFlight = false;

    if (error) {
      logRoute('ERROR', 'Proxy config failed', error);
      lastAppliedSignature = '';
      setIssue('config', `Не удалось применить настройки прокси: ${error}`);
      if (Date.now() - lastConfigErrorNotifyAt > 60000) {
        lastConfigErrorNotifyAt = Date.now();
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'logo.png',
          title: 'Proxy Manager',
          message: 'Не удалось применить настройки прокси. Откройте панель управления и проверьте конфигурацию.'
        });
      }
    } else {
      lastAppliedSignature = signature;
      const activeProxy = findProxyById(config.proxies, config.activeProxyId);
      const configured = config.proxies.filter(isProxyConfigured).length;
      logRoute('CONFIG', 'Applied',
        `${config.extensionEnabled ? 'PAC' : 'DIRECT'} | прокси: ${configured} | правил: ${config.proxyList.length}+${config.directList.length}${activeProxy ? ` | активный: ${proxyLabel(activeProxy)}` : ''}`);
    }

    notifyConfigReady();
    if (applyPending) {
      applyPending = false;
      applyProxyConfigNow();
    } else {
      flushApplyIdleWaiters();
    }
  });
}

const applyProxyConfig = debounce(applyProxyConfigNow, 150);

// ===================== ЛОГИ =====================

function logRoute(type, action, details) {
  const time = new Date().toLocaleTimeString('ru-RU');
  logBuffer += `[${time}] ${type}: ${action} - ${details}\n`;
  if (logBuffer.length > MAX_LOG_SIZE) {
    logBuffer = logBuffer.slice(-MAX_LOG_SIZE);
  }
  scheduleLogFlush();
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    flushLogs();
  }, LOG_FLUSH_DELAY);
}

function flushLogs() {
  if (!logBuffer) return;
  if (logFlushInFlight) {
    scheduleLogFlush();
    return;
  }

  const chunk = logBuffer;
  const epoch = logEpoch;
  logBuffer = '';
  logFlushInFlight = true;

  chrome.storage.local.get(['routeLogs'], (data) => {
    if (epoch !== logEpoch) {
      logFlushInFlight = false;
      if (logBuffer) scheduleLogFlush();
      return;
    }
    let logs = (data.routeLogs || '') + chunk;
    if (logs.length > MAX_LOG_SIZE) logs = logs.slice(-MAX_LOG_SIZE);
    chrome.storage.local.set({ routeLogs: logs }, () => {
      logFlushInFlight = false;
      if (logBuffer) scheduleLogFlush();
    });
  });
}

function maybeCleanupLogs() {
  chrome.storage.local.get(['lastLogCleanup'], (data) => {
    const last = Number(data.lastLogCleanup) || 0;
    // Первый запуск после обновления: не стираем историю, просто ставим отметку.
    if (!last) {
      chrome.storage.local.set({ lastLogCleanup: Date.now() });
      return;
    }
    if (Date.now() - last < 3 * 60 * 60 * 1000) return;
    chrome.storage.local.set({ routeLogs: '', lastLogCleanup: Date.now() }, () => {
      logRoute('CONFIG', 'Auto-cleanup', 'Логи очищены автоматически');
    });
  });
}

// ===================== СТАТИСТИКА =====================

function initDaily(now) {
  activityStats.daily = Array(24).fill(0).map((_, i) => {
    const date = new Date(now || Date.now());
    date.setHours(i, 0, 0, 0);
    return { proxy: 0, direct: 0, timestamp: date.getTime() };
  });
  activityStats.dailyDate = new Date(now || Date.now()).toDateString();
}

function initStats() {
  chrome.storage.local.get(['activityStats'], (data) => {
    if (data.activityStats && typeof data.activityStats === 'object') {
      Object.assign(activityStats, data.activityStats);
    }
    if (!Array.isArray(activityStats.daily) || activityStats.daily.length !== 24 ||
        activityStats.dailyDate !== new Date().toDateString()) {
      initDaily();
    }
    if (!activityStats.domains || typeof activityStats.domains !== 'object') {
      activityStats.domains = {};
    }
    pruneStatsDomains();
  });
}

function saveStatsNow() {
  lastStatsSaveAt = Date.now();
  chrome.storage.local.set({ activityStats });
}

function saveStatsSoon() {
  clearTimeout(statsSaveTimer);
  if (Date.now() - lastStatsSaveAt > 5000) {
    saveStatsNow();
    return;
  }
  statsSaveTimer = setTimeout(saveStatsNow, STATS_SAVE_DELAY);
}

function pruneStatsDomains() {
  const entries = Object.entries(activityStats.domains);
  if (entries.length <= MAX_STAT_DOMAINS) return;
  entries.sort((a, b) =>
    ((b[1].proxy || 0) + (b[1].direct || 0)) - ((a[1].proxy || 0) + (a[1].direct || 0))
  );
  activityStats.domains = Object.fromEntries(entries.slice(0, Math.floor(MAX_STAT_DOMAINS * 0.75)));
}

function updateStats(routeType, domain) {
  if (!domain) return;
  const now = new Date();
  if (activityStats.dailyDate !== now.toDateString()) initDaily(now);

  if (routeType === 'PROXY') activityStats.proxy++;
  else activityStats.direct++;

  const key = String(domain).toLowerCase();
  if (!activityStats.domains[key]) activityStats.domains[key] = { proxy: 0, direct: 0 };
  if (routeType === 'PROXY') activityStats.domains[key].proxy++;
  else activityStats.domains[key].direct++;

  const hour = now.getHours();
  if (!activityStats.daily[hour]) activityStats.daily[hour] = { proxy: 0, direct: 0 };
  if (routeType === 'PROXY') activityStats.daily[hour].proxy++;
  else activityStats.daily[hour].direct++;

  pruneStatsDomains();
  saveStatsSoon();
}

// ===================== БЕЙДЖ =====================

function showBadge(text, bgColor) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: bgColor || BADGE_COLORS[text] || '#111111' });
  if (text !== '!') chrome.action.setTitle({ title: 'Proxy Manager' });
}

/**
 * Запоминает причину красного «!» рядом с иконкой и делает её
 * видимой в попапе, подсказке иконки и логах.
 */
function setIssue(kind, message, proxyId) {
  const text = String(message || 'Ошибка прокси').slice(0, 300);
  const issueKey = `${kind}:${text}`;

  // После «Скрыть» не возвращаем тот же значок из-за повторяющейся
  // ошибки в течение минуты. Другие ошибки показываются сразу.
  if (issueKey === acknowledgedIssueKey && Date.now() < issueMuteUntil) return;

  lastIssue = {
    at: Date.now(),
    kind,
    message: text,
    proxyId: proxyId ? String(proxyId) : null
  };
  chrome.storage.local.set({ lastIssue });
  showBadge('!');
  chrome.action.setTitle({ title: `Proxy Manager: ${text.slice(0, 120)}` });
}

function proxyErrorText(message) {
  const raw = String(message || '');
  if (/ERR_PROXY_CONNECTION_FAILED/.test(raw)) return 'Не удалось подключиться к прокси';
  if (/ERR_TUNNEL_CONNECTION_FAILED/.test(raw)) return 'Прокси не установил туннель';
  if (/ERR_SOCKS_CONNECTION/.test(raw)) return 'SOCKS-прокси не отвечает';
  if (/ERR_PROXY_AUTH/.test(raw)) return 'Прокси требует авторизацию';
  if (/ERR_PROXY_CERTIFICATE/.test(raw)) return 'Ошибка сертификата прокси';
  return 'Ошибка прокси';
}

// ===================== ОЧЕРЕДЬ ЗАПИСИ В STORAGE =====================

let storageQueue = Promise.resolve();

function enqueueStorage(task) {
  const run = () => new Promise((resolve) => {
    try { task(resolve); } catch (_) { resolve(null); }
  });
  storageQueue = storageQueue.then(run, run);
  return storageQueue;
}

/**
 * Добавляет домены в список правил, если их ещё нет ни в одном списке.
 * Все автоматические добавления идут через очередь — параллельные
 * read-modify-write больше не теряют правила.
 * @returns {Promise<string[]>} добавленные значения
 */
function addAutoProxyRules(domains) {
  const unique = [...new Set((domains || [])
    .map(value => normalizeDomain(value))
    .filter(value => value && isAutoProxyCandidate(value)))];

  if (unique.length === 0) return Promise.resolve([]);

  return enqueueStorage(resolve => {
    chrome.storage.local.get(['proxyList', 'directList'], (data) => {
      let proxyList = Array.isArray(data.proxyList) ? data.proxyList : [];
      const directList = Array.isArray(data.directList) ? data.directList : [];
      const added = [];

      for (const domain of unique) {
        const lower = domain.toLowerCase();
        if (proxyList.some(s => String(s.value).toLowerCase() === lower)) continue;
        if (directList.some(s => String(s.value).toLowerCase() === lower)) continue;
        if (directList.some(s => s.enabled !== false && hostMatches(domain, s.value))) continue;
        if (!domain.startsWith('*.') && proxyList.some(s => s.enabled !== false && hostMatches(domain, s.value))) continue;
        proxyList.push({ id: crypto.randomUUID(), value: domain, enabled: true });
        added.push(domain);
      }

      if (added.length === 0) { resolve([]); return; }
      chrome.storage.local.set({ proxyList }, () => resolve(added));
    });
  });
}

function canAttemptAutoProxy(domain) {
  const key = String(domain).toLowerCase();
  const now = Date.now();
  const last = autoProxyAttempts.get(key) || 0;
  if (now - last < AUTO_PROXY_COOLDOWN) return false;
  autoProxyAttempts.set(key, now);
  if (autoProxyAttempts.size > 600) {
    const oldest = autoProxyAttempts.keys().next().value;
    autoProxyAttempts.delete(oldest);
  }
  return true;
}

function notifyAutoProxy(domains, detail) {
  const now = Date.now();
  if (now - lastAutoNotifyAt < AUTO_NOTIFY_COOLDOWN) return;
  lastAutoNotifyAt = now;
  const list = domains.slice(0, 3).join(', ') + (domains.length > 3 ? ` и ещё ${domains.length - 3}` : '');
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'logo.png',
    title: 'Авто-прокси',
    message: `${list} — добавлено в список прокси${detail ? ` (${detail})` : ''}`
  });
}

// ===================== FALLBACK =====================

function recordProxyFailure(message, options) {
  const opts = options || {};
  const now = Date.now();

  // Ошибки во время теста прокси не должны переключать рабочий сервер.
  if (testSession) {
    logRoute('ERROR', 'Proxy test error', String(message || 'Ошибка прокси').slice(0, 300));
    return;
  }

  const activeProxy = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
  const rawMessage = String(message || 'Ошибка прокси');
  const displayMessage = activeProxy ? `${rawMessage} (${proxyLabel(activeProxy)})` : rawMessage;
  const duplicate = rawMessage === lastProxyErrorLog.message && now - lastProxyErrorLog.at < 5000;

  lastProxyError = {
    at: now,
    message: displayMessage.slice(0, 300),
    proxyId: activeProxy ? String(activeProxy.id) : null
  };

  // Chrome может прислать несколько одинаковых ошибок на один запрос —
  // не засоряем логи и не считаем их разными сбоями.
  if (duplicate) return;
  lastProxyErrorLog = { message: rawMessage, at: now };
  chrome.storage.local.set({ lastProxyError });
  logRoute('ERROR', 'Proxy error', displayMessage);
  setIssue('proxy', `${proxyErrorText(rawMessage)}: ${displayMessage}`, activeProxy ? activeProxy.id : null);

  if (opts.rotate === false || !activeProxy) return;
  if (!isProxyConfigured(activeProxy)) return;

  const id = String(activeProxy.id);
  const recent = (proxyFailures.get(id) || []).filter(time => now - time < FALLBACK_FAILURE_WINDOW);
  recent.push(now);
  proxyFailures.set(id, recent);

  if (recent.length < 2) return;
  proxyFailures.delete(id);
  switchToFallbackProxy(opts.reason || 'network');
}

function switchToFallbackProxy(reason) {
  const proxies = cachedConfig.proxies.filter(isProxyConfigured);
  if (proxies.length < 2) {
    const active = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
    setIssue('proxy', active
      ? `Прокси ${proxyLabel(active)} недоступен, резервных серверов нет`
      : 'Прокси недоступен, резервных серверов нет');
    return;
  }
  if (Date.now() - lastFallbackAt < FALLBACK_COOLDOWN) return;

  const currentIndex = proxies.findIndex(p => sameProxyId(p.id, cachedConfig.activeProxyId));
  if (currentIndex === -1) return;

  const next = proxies[(currentIndex + 1) % proxies.length];
  lastFallbackAt = Date.now();
  logRoute('AUTO', 'Proxy fallback',
    `${proxyLabel(proxies[currentIndex])} → ${proxyLabel(next)} (${reason})`);

  chrome.storage.local.set({ activeProxyId: next.id }, () => {
    setIssue('fallback',
      `Прокси ${proxyLabel(proxies[currentIndex])} не отвечает. Активный: ${proxyLabel(next)}`);
    if (Date.now() - lastFallbackNotifyAt > 5 * 60 * 1000) {
      lastFallbackNotifyAt = Date.now();
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'logo.png',
        title: 'Переключение прокси',
        message: `Активный прокси: ${proxyLabel(next)}`
      });
    }
  });
}

// ===================== АВТОРИЗАЦИЯ ПРОКСИ =====================

function handleAuthRequired(details, callback) {
  if (!details || !details.isProxy) {
    return; // обычная авторизация сайта — не вмешиваемся
  }

  const proxy = findProxyForAuthChallenge(details.challenger, cachedConfig.proxies, cachedConfig.activeProxyId);
  if (proxy) {
    callback({
      authCredentials: {
        username: String(proxy.username || ''),
        password: String(proxy.password || '')
      }
    });
    return;
  }

  const now = Date.now();
  if (now - lastAuthWarningAt > 10000) {
    lastAuthWarningAt = now;
    const challenger = details.challenger;
    const where = challenger && challenger.host
      ? `${challenger.host}:${challenger.port}`
      : 'прокси';
    logRoute('ERROR', 'Proxy auth', `Требуется логин и пароль для ${where}`);
    setIssue('auth', `Требуется логин и пароль для ${where}`);
  }
  callback({});
}

if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  try {
    chrome.webRequest.onAuthRequired.addListener(
      handleAuthRequired,
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    );
  } catch (error) {
    logRoute('ERROR', 'Proxy auth listener', String(error && error.message || error));
  }
}

// ===================== СОБЫТИЯ ПРОКСИ =====================

if (chrome.proxy && chrome.proxy.onProxyError) {
  chrome.proxy.onProxyError.addListener((details) => {
    const message = typeof details === 'string'
      ? details
      : (details && (details.details || details.error)) || 'Неизвестная ошибка прокси';
    const isPacError = /pac|script|parse|javascript/i.test(String(message));
    recordProxyFailure(message, { rotate: !isPacError, reason: 'proxy error' });
  });
}

// ===================== WEBRTC =====================

function applyWebrtcPolicy(enabled, callback) {
  try {
    chrome.privacy.network.webRTCIPHandlingPolicy.set(
      { value: enabled ? 'proxy_only' : 'default' },
      () => {
        const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (callback) callback(error || null);
      }
    );
  } catch (error) {
    if (callback) callback(String(error && error.message || error));
  }
}

function applyStoredWebrtcPolicy() {
  chrome.storage.local.get(['webrtcProtectionEnabled'], (data) => {
    if (data.webrtcProtectionEnabled === true) applyWebrtcPolicy(true);
  });
}

// ===================== ДОМЕНЫ ВКЛАДОК =====================

function scheduleTabDomainsSave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    if (!chrome.storage.session) return;
    const payload = {};
    let count = 0;
    for (const [tabId, set] of tabDomains.entries()) {
      if (count >= 50) break;
      payload[tabId] = [...set].slice(0, 100);
      count++;
    }
    try {
      chrome.storage.session.set({ tabDomains: payload });
    } catch (_) { /* storage.session может быть недоступен */ }
  }, 700);
}

function whenTabDomainsReady(cb) {
  if (tabDomainsSessionReady) { cb(); return; }
  tabDomainsWaiters.push(cb);
}

function restoreTabDomains() {
  if (!chrome.storage.session) {
    tabDomainsSessionReady = true;
    tabDomainsWaiters.splice(0).forEach(cb => cb());
    return;
  }
  try {
    chrome.storage.session.get(['tabDomains'], (data) => {
      const saved = data && data.tabDomains;
      if (saved && typeof saved === 'object') {
        Object.entries(saved).forEach(([tabId, values]) => {
          const id = Number(tabId);
          if (!Number.isFinite(id)) return;
          tabDomains.set(id, new Set(Array.isArray(values) ? values : []));
        });
      }
      tabDomainsSessionReady = true;
      tabDomainsWaiters.splice(0).forEach(cb => cb());
    });
  } catch (_) {
    tabDomainsSessionReady = true;
    tabDomainsWaiters.splice(0).forEach(cb => cb());
  }
}

function rememberTabDomain(tabId, host) {
  if (!Number.isFinite(tabId) || tabId < 0) return;
  const domain = normalizeDomain(host);
  if (!domain) return;
  if (!tabDomains.has(tabId)) tabDomains.set(tabId, new Set());
  const set = tabDomains.get(tabId);
  set.add(domain);
  if (set.size > 100) set.delete(set.values().next().value);
  scheduleTabDomainsSave();
}

// ===================== ОПРЕДЕЛЕНИЕ МАРШРУТА =====================

function findRoute(host, url) {
  const directRule = cachedConfig.directList.find(s => s && s.enabled !== false && hostMatches(host, s.value, url));
  if (directRule) return { route: 'DIRECT', rule: directRule.value };

  const proxyRule = cachedConfig.proxyList.find(s => s && s.enabled !== false && hostMatches(host, s.value, url));
  if (proxyRule) return { route: 'PROXY', rule: proxyRule.value };

  return null;
}

function hasActiveProxy() {
  return isProxyConfigured(findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId));
}

// ===================== ЗАПРОСЫ =====================

function handleBeforeRequest(details) {
  try {
    const url = new URL(details.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const host = url.hostname;

    if (details.type === 'main_frame' && details.tabId >= 0) {
      tabDomains.set(details.tabId, new Set());
      scheduleTabDomainsSave();
    }
    rememberTabDomain(details.tabId, host);

    const timerState = tabLoadTimers.get(details.tabId);
    if (timerState && timerState.pendingRequests && details.tabId >= 0) {
      timerState.pendingRequests.set(details.requestId, host);
      if (timerState.pendingRequests.size > 300) {
        timerState.pendingRequests.delete(timerState.pendingRequests.keys().next().value);
      }
    }

    if (details.type !== 'main_frame' && details.type !== 'sub_frame') return;
    if (!configReady || !cachedConfig.extensionEnabled) return;

    const matched = findRoute(host, details.url);
    const activeProxy = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
    const canProxy = isProxyConfigured(activeProxy);
    const effectiveRoute = matched && matched.route === 'PROXY' && canProxy ? 'PROXY' : 'DIRECT';

    if (details.type === 'main_frame') {
      if (effectiveRoute === 'PROXY') showBadge('P');
      else if (matched) showBadge('D');
      else clearBadge();

      const previous = tabLoadTimers.get(details.tabId);
      if (previous && previous.timeoutId) clearTimeout(previous.timeoutId);
      tabLoadTimers.set(details.tabId, {
        mainDomain: host,
        mainUrl: details.url,
        timeoutId: null,
        pendingRequests: new Map(),
        mainLoaded: false,
        startedAt: Date.now()
      });
      startAutoProxyTimer(details.tabId, host);
      updateStats(effectiveRoute, host);
    }

    if (matched) {
      let routeLabel = effectiveRoute;
      let detail = matched.route === 'PROXY' && !canProxy ? 'нет активного прокси' : proxyLabel(activeProxy);
      logRoute('REQUEST', routeLabel, `${host} -> ${detail} (matched: ${matched.rule})`);
    }
  } catch (error) {
    console.error('Request analysis error:', error);
  }
}

chrome.webRequest.onBeforeRequest.addListener(handleBeforeRequest, { urls: ['<all_urls>'] });

// ===================== ОШИБКИ ЗАПРОСОВ =====================

function maybeAutoProxy(details) {
  if (!details.url || !details.error) return;
  if (!configReady || !cachedConfig.extensionEnabled) return;
  if (details.tabId < 0) return; // фоновые запросы расширения не создают правила
  // Ошибки основной навигации обрабатываются в webNavigation: только там
  // можно один раз перезагрузить вкладку после добавления правила.
  if (details.type === 'main_frame') return;

  let url;
  try { url = new URL(details.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (!isRetryableErrorCode(details.error)) return;

  const host = url.hostname;
  if (!isAutoProxyCandidate(host)) return;

  const directRule = cachedConfig.directList.find(s => s && s.enabled !== false && hostMatches(host, s.value, details.url));
  if (directRule) return;

  const proxyRule = cachedConfig.proxyList.find(s => s && s.enabled !== false && hostMatches(host, s.value, details.url));
  if (proxyRule) {
    if (isProxyErrorCode(details.error)) {
      recordProxyFailure(`${details.error} (${host})`, { reason: 'request error' });
    }
    return;
  }

  // Ошибки самого прокси не превращаем в новые правила: домен уже не при чём.
  if (isProxyErrorCode(details.error)) return;
  if (!cachedConfig.autoProxyEnabled) return;

  const domain = normalizeDomain(host);
  if (!domain || !canAttemptAutoProxy(domain)) return;

  addAutoProxyRules([domain]).then(added => {
    if (!added.length) return;
    logRoute('AUTO', 'Авто-прокси (ресурс)', `${host} → ${added.join(', ')} (${details.error})`);
    showBadge('A');
    notifyAutoProxy(added, details.error);
  });
}

chrome.webRequest.onErrorOccurred.addListener((details) => {
  const state = tabLoadTimers.get(details.tabId);
  if (state) state.pendingRequests.delete(details.requestId);
  maybeAutoProxy(details);
}, { urls: ['<all_urls>'] });

// ===================== АВТО-ПРОКСИ ПО ТАЙМАУТУ =====================

function startAutoProxyTimer(tabId, mainDomain) {
  if (tabId == null || tabId < 0 || !mainDomain) return;

  chrome.storage.local.get(['autoProxyTimeoutEnabled', 'autoProxyTimeout'], (data) => {
    if (!data.autoProxyTimeoutEnabled) return;

    const state = tabLoadTimers.get(tabId);
    if (!state || state.mainDomain !== mainDomain || state.timeoutId) return;

    const timeoutMs = Math.min(30, Math.max(2, parseInt(data.autoProxyTimeout, 10) || 5)) * 1000;
    const startedAt = state.startedAt;

    state.timeoutId = setTimeout(() => {
      const current = tabLoadTimers.get(tabId);
      if (!current || current.startedAt !== startedAt) return;
      tabLoadTimers.delete(tabId);

      // Если основная страница уже открылась, «зависшие» трекеры и реклама
      // не повод перезагружать вкладку и заворачивать их в прокси.
      if (current.mainLoaded) return;

      const stuck = new Set([current.mainDomain]);
      for (const domain of current.pendingRequests.values()) stuck.add(domain);

      const candidates = [...stuck];
      if (candidates.length === 0) return;

      addAutoProxyRules(candidates).then(added => {
        if (!added.length) return;
        logRoute('AUTO', 'Авто-прокси (таймаут)',
          `${current.mainDomain} → ${added.join(', ')} (${timeoutMs / 1000} с)`);
        showBadge('A');
        notifyAutoProxy(added, `таймаут ${timeoutMs / 1000} с`);
        reloadTabOnce(tabId);
      });
    }, timeoutMs);
  });
}

function handleCompleted(details) {
  const state = tabLoadTimers.get(details.tabId);
  if (!state) return;
  state.pendingRequests.delete(details.requestId);
  if (details.type === 'main_frame') state.mainLoaded = true;
}

chrome.webRequest.onCompleted.addListener(handleCompleted, { urls: ['<all_urls>'] });

function reloadTabOnce(tabId) {
  const now = Date.now();
  if (now - (lastReloadByTab.get(tabId) || 0) < RELOAD_COOLDOWN) return;
  lastReloadByTab.set(tabId, now);
  setTimeout(() => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      // Вкладку могли закрыть — это нормально.
      void chrome.runtime.lastError;
    });
  }, 900);
}

// ===================== НАВИГАЦИЯ =====================

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  const state = tabLoadTimers.get(details.tabId);
  if (state) state.pendingRequests.delete(details.requestId);

  if (details.tabId >= 0 && details.url && details.error) {
    try { rememberTabDomain(details.tabId, new URL(details.url).hostname); } catch (_) { /* noop */ }
  }

  if (details.frameId !== 0) return;
  if (!details.url || (!details.url.startsWith('http://') && !details.url.startsWith('https://'))) return;
  if (!isRetryableErrorCode(details.error)) return;
  if (!configReady || !cachedConfig.extensionEnabled) return;

  let url;
  try { url = new URL(details.url); } catch (_) { return; }
  const host = url.hostname;

  const proxyRule = cachedConfig.proxyList.find(s => s && s.enabled !== false && hostMatches(host, s.value, details.url));
  if (proxyRule) {
    if (isProxyErrorCode(details.error)) {
      recordProxyFailure(`${details.error} (${host})`, { reason: 'navigation' });
    }
    return;
  }

  if (isProxyErrorCode(details.error)) {
    // Прокси-ошибка при прямом маршруте — не повод добавлять домен в прокси.
    recordProxyFailure(`${details.error} (${host})`, { reason: 'navigation' });
    return;
  }

  if (cachedConfig.directList.some(s => s && s.enabled !== false && hostMatches(host, s.value, details.url))) return;
  if (!cachedConfig.autoProxyEnabled) return;

  const domain = normalizeDomain(host);
  if (!domain || !canAttemptAutoProxy(domain)) return;

  addAutoProxyRules([domain]).then(added => {
    if (!added.length) return;
    logRoute('AUTO', 'Авто-прокси', `${host} → ${added.join(', ')} (${details.error})`);
    showBadge('A');
    notifyAutoProxy(added, details.error);
    reloadTabOnce(details.tabId);
  });
});

// ===================== ОЧИСТКА ВКЛАДОК =====================

chrome.tabs.onRemoved.addListener((tabId) => {
  tabDomains.delete(tabId);
  scheduleTabDomainsSave();
  const state = tabLoadTimers.get(tabId);
  if (state && state.timeoutId) clearTimeout(state.timeoutId);
  tabLoadTimers.delete(tabId);
  lastReloadByTab.delete(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  tabDomains.delete(removedTabId);
  tabLoadTimers.delete(removedTabId);
  scheduleTabDomainsSave();
});

// ===================== ТЕСТ ПРОКСИ =====================

function setProxyValue(value) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: 'regular' }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function buildTestPac(proxy) {
  const route = escapePacString(proxyToPacString(proxy));
  const hosts = ['api.ipify.org', 'api64.ipify.org', 'www.gstatic.com', 'cp.cloudflare.com'];
  const probe = hosts
    .map(host => `(host.toLowerCase() === "${host}" || host.toLowerCase().endsWith(".${host}"))`)
    .join(' || ');
  const probeLine = `  if (${probe}) return "${route}";\n`;
  const marker = 'function FindProxyForURL(url, host) {\n';
  const normal = generatePAC(cachedConfig);

  // Остальной трафик продолжает идти по обычным правилам, а не напрямую.
  if (normal.includes(marker)) {
    return normal.replace(marker, marker + probeLine);
  }
  return `function FindProxyForURL(url, host){${probeLine}return "DIRECT";}`;
}

async function fetchExternalIp(options = {}) {
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json'
  ];
  const timeoutMs = Math.max(800, Math.min(5000, Number(options.timeoutMs) || 2200));
  let lastError = null;

  for (const endpoint of endpoints) {
    const started = Date.now();
    try {
      const response = await fetch(endpoint + '&_=' + Date.now(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      const ip = data && (data.ip || data.origin);
      if (!ip) throw new Error('Пустой ответ от сервиса проверки IP');
      return { ip: String(ip), latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Сервис проверки IP недоступен');
}

/**
 * Лёгкий ping через уже настроенный прокси: 204-ответ без тела.
 * Используется для фоновой проверки резервных серверов.
 */
async function fetchFastPing(options = {}) {
  const endpoints = [
    'https://www.gstatic.com/generate_204',
    'https://cp.cloudflare.com/generate_204'
  ];
  const timeoutMs = Math.max(600, Math.min(3000, Number(options.timeoutMs) || 1600));
  let lastError = null;

  for (const endpoint of endpoints) {
    const started = Date.now();
    try {
      const response = await fetch(endpoint + '?_=' + Date.now(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok && response.status !== 204) throw new Error('HTTP ' + response.status);
      return { latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Ping не удался');
}

async function runProxyTest(proxyId, options = {}) {
  const opts = options || {};
  if (testSession) {
    return { success: false, error: 'busy', message: 'Другой тест уже выполняется' };
  }

  const proxy = findProxyById(cachedConfig.proxies, proxyId);
  if (!proxy) {
    return { success: false, error: 'not-found', message: 'Прокси не найден' };
  }
  if (!isProxyConfigured(proxy)) {
    return { success: false, error: 'invalid', message: 'Заполните хост и порт прокси' };
  }

  testSession = { proxyId: String(proxy.id), startedAt: Date.now() };
  if (chrome.alarms) {
    chrome.alarms.create(RESTORE_ALARM, { when: Date.now() + 30000 });
  }

  try {
    await setProxyValue({
      mode: 'pac_script',
      pacScript: { data: buildTestPac(proxy) }
    });
    const probe = opts.fast
      ? await fetchFastPing({ timeoutMs: opts.timeoutMs })
      : await fetchExternalIp({ timeoutMs: opts.timeoutMs });
    recordProxyHealth(proxy, 'online', probe);
    if (!opts.quiet) {
      logRoute('CONFIG', 'Proxy test',
        `${proxyLabel(proxy)}${probe.ip ? ` → ${probe.ip}` : ''} (${probe.latencyMs} мс)`);
    }
    return {
      success: true,
      ip: probe.ip || null,
      latencyMs: probe.latencyMs,
      proxy: publicProxy(proxy)
    };
  } catch (error) {
    const message = friendlyProbeError(error);
    recordProxyHealth(proxy, 'offline', { message });
    if (!opts.quiet) {
      logRoute('ERROR', 'Proxy test failed', `${proxyLabel(proxy)} — ${message}`);
    }
    return { success: false, error: 'unreachable', message, proxy: publicProxy(proxy) };
  } finally {
    testSession = null;
    if (chrome.alarms) chrome.alarms.clear(RESTORE_ALARM);
    lastAppliedSignature = '';
    applyProxyConfigNow();
  }
}

async function probeActiveProxy(options = {}) {
  const opts = options || {};
  if (testSession) {
    return { success: false, error: 'busy', message: 'Идёт тест прокси' };
  }
  if (!cachedConfig.extensionEnabled) {
    return { success: false, error: 'disabled', message: 'Прокси выключен' };
  }

  const activeProxy = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
  if (!isProxyConfigured(activeProxy)) {
    return { success: false, error: 'no-active-proxy', message: 'Прокси не выбран или настроен не полностью' };
  }

  try {
    const probe = await fetchExternalIp({ timeoutMs: opts.timeoutMs || 2200 });
    recordProxyHealth(activeProxy, 'online', probe);
    return {
      success: true,
      ip: probe.ip,
      latencyMs: probe.latencyMs,
      proxy: publicProxy(activeProxy)
    };
  } catch (error) {
    const message = friendlyProbeError(error);
    recordProxyHealth(activeProxy, 'offline', { message });
    if (!opts.quiet) {
      logRoute('ERROR', 'Proxy prober', `${proxyLabel(activeProxy)} — ${message}`);
    }
    return { success: false, error: 'unreachable', message, proxy: publicProxy(activeProxy) };
  }
}

// ===================== ЗДОРОВЬЕ И АВТОПЕРЕКЛЮЧЕНИЕ =====================

function recordProxyHealth(proxy, status, details = {}) {
  if (!proxy || !proxy.id) return;
  chrome.storage.local.get(['proxyHealth'], (data) => {
    const health = data.proxyHealth && typeof data.proxyHealth === 'object'
      ? data.proxyHealth
      : {};
    health[String(proxy.id)] = {
      status,
      latencyMs: Math.max(0, Math.round(Number(details.latencyMs) || 0)),
      ip: details.ip ? String(details.ip) : null,
      message: details.message ? String(details.message).slice(0, 200) : '',
      checkedAt: Date.now()
    };
    chrome.storage.local.set({ proxyHealth: health });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function switchToHealthyProxy(current) {
  const configured = cachedConfig.proxies.filter(isProxyConfigured);
  if (configured.length < 2) return false;

  const currentIndex = configured.findIndex(p => sameProxyId(p.id, current.id));
  const ordered = currentIndex === -1
    ? configured
    : configured.slice(currentIndex + 1).concat(configured.slice(0, currentIndex));

  for (const candidate of ordered) {
    if (sameProxyId(candidate.id, current.id)) continue;
    const test = await runProxyTest(candidate.id, { fast: true, quiet: true });
    if (!test.success) continue;

    lastAutoSwitchAt = Date.now();
    await new Promise(resolve => {
      chrome.storage.local.set({ activeProxyId: candidate.id }, resolve);
    });

    logRoute('AUTO', 'Proxy health',
      `${proxyLabel(current)} недоступен → ${proxyLabel(candidate)} (${test.latencyMs} мс)`);
    setIssue('fallback',
      `Прокси ${proxyLabel(current)} не отвечает. Активный: ${proxyLabel(candidate)}`);

    if (Date.now() - lastFallbackNotifyAt > 5 * 60 * 1000) {
      lastFallbackNotifyAt = Date.now();
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'logo.png',
        title: 'Переключение прокси',
        message: `Активный прокси: ${proxyLabel(candidate)}`
      });
    }
    return true;
  }
  return false;
}

async function checkActiveProxyHealth() {
  if (!configReady || !cachedConfig.extensionEnabled || testSession || applyInFlight) return;

  const activeProxy = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
  if (!isProxyConfigured(activeProxy)) return;

  let result = await probeActiveProxy({ quiet: true, timeoutMs: 2200 });
  if (result.error === 'busy' || result.error === 'disabled') return;
  if (!result.success) {
    // Один повторяющийся сбой может быть сетевым провалом, а не мёртвым прокси.
    await wait(900);
    result = await probeActiveProxy({ quiet: true, timeoutMs: 2200 });
    if (result.error === 'busy' || result.error === 'disabled') return;
  }

  if (result.success) {
    activeHealthFailures = 0;
    return;
  }

  activeHealthFailures += 1;
  if (Date.now() - lastAutoSwitchAt < 60000) return;

  activeHealthFailures = 0;
  const switched = await switchToHealthyProxy(activeProxy);
  if (switched) return;

  if (Date.now() - lastHealthIssueAt > 5 * 60 * 1000) {
    lastHealthIssueAt = Date.now();
    logRoute('ERROR', 'Proxy health',
      `${proxyLabel(activeProxy)} недоступен, резервные серверы не ответили`);
    setIssue('proxy',
      `Прокси ${proxyLabel(activeProxy)} недоступен, резервные серверы не ответили`);
  }
}

// ===================== КОНТЕКСТНОЕ МЕНЮ =====================

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
  try {
    if (info.linkUrl) domain = new URL(info.linkUrl).hostname;
    else if (info.pageUrl) domain = new URL(info.pageUrl).hostname;
  } catch (_) { return; }
  if (!domain) return;

  chrome.storage.local.get(['proxyList', 'directList', 'autoAddRelated'], (data) => {
    const proxyList = Array.isArray(data.proxyList) ? data.proxyList : [];
    const directList = Array.isArray(data.directList) ? data.directList : [];
    const autoAddRelated = data.autoAddRelated === true;

    const addDomain = (listKey, title, message) => {
      enqueueStorage(resolve => {
        chrome.storage.local.get(['proxyList', 'directList'], (fresh) => {
          const list = Array.isArray(fresh[listKey]) ? fresh[listKey] : [];
          const otherKey = listKey === 'proxyList' ? 'directList' : 'proxyList';
          const other = Array.isArray(fresh[otherKey]) ? fresh[otherKey] : [];
          if (list.some(s => String(s.value).toLowerCase() === domain.toLowerCase()) ||
              other.some(s => String(s.value).toLowerCase() === domain.toLowerCase())) {
            resolve(false);
            return;
          }
          list.push({ id: crypto.randomUUID(), value: domain, enabled: true });
          chrome.storage.local.set({ [listKey]: list }, () => {
            chrome.notifications.create({
              type: 'basic', iconUrl: 'logo.png', title, message
            });
            resolve(true);
          });
        });
      }).then((added) => {
        if (added !== false && autoAddRelated && tab) addRelatedDomains(tab.id, listKey);
      });
    };

    if (info.menuItemId === 'addToProxyList') {
      addDomain('proxyList', 'Добавлено в прокси', `${domain} добавлен в список прокси`);
    } else if (info.menuItemId === 'addToDirectList') {
      addDomain('directList', 'Добавлено в напрямую', `${domain} добавлен в список напрямую`);
    } else if (info.menuItemId === 'removeFromLists') {
      const newProxyList = proxyList.filter(s => String(s.value).toLowerCase() !== domain.toLowerCase());
      const newDirectList = directList.filter(s => String(s.value).toLowerCase() !== domain.toLowerCase());
      chrome.storage.local.set({ proxyList: newProxyList, directList: newDirectList }, () => {
        chrome.notifications.create({
          type: 'basic', iconUrl: 'logo.png',
          title: 'Удалено из списков', message: `${domain} удалён из всех списков`
        });
      });
    }
  });
});

// ===================== СВЯЗАННЫЕ ДОМЕНЫ =====================

function addRelatedDomains(tabId, listKey) {
  const domains = tabDomains.get(tabId);
  if (!domains || domains.size === 0) return;

  const otherKey = listKey === 'proxyList' ? 'directList' : 'proxyList';
  enqueueStorage(resolve => {
    chrome.storage.local.get([listKey, otherKey], (data) => {
      const list = Array.isArray(data[listKey]) ? data[listKey] : [];
      const otherList = Array.isArray(data[otherKey]) ? data[otherKey] : [];
      let addedCount = 0;

      domains.forEach(domain => {
        const lower = String(domain).toLowerCase();
        if (list.some(s => String(s.value).toLowerCase() === lower)) return;
        if (otherList.some(s => String(s.value).toLowerCase() === lower)) return;
        if (list.some(s => s.enabled !== false && hostMatches(domain, s.value))) return;
        if (otherList.some(s => s.enabled !== false && hostMatches(domain, s.value))) return;
        list.push({ id: crypto.randomUUID(), value: domain, enabled: true });
        addedCount++;
      });

      if (addedCount === 0) { resolve(0); return; }
      chrome.storage.local.set({ [listKey]: list }, () => {
        chrome.notifications.create({
          type: 'basic', iconUrl: 'logo.png',
          title: 'Связанные домены добавлены',
          message: `Автоматически добавлено ${addedCount} связанных доменов`
        });
        resolve(addedCount);
      });
    });
  });
}

// ===================== СООБЩЕНИЯ =====================

function getRelatedDomainsForActiveTab(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      sendResponse({ mainDomain: null, relatedDomains: [], collecting: false });
      return;
    }

    let mainHost;
    try { mainHost = new URL(tab.url).hostname; } catch (_) {
      sendResponse({ mainDomain: null, relatedDomains: [], collecting: false });
      return;
    }

    const domains = tabDomains.get(tab.id);
    if (!domains || domains.size === 0) {
      sendResponse({ mainDomain: mainHost, relatedDomains: [], collecting: true });
      return;
    }

    const mainNorm = normalizeDomain(mainHost);
    const seen = new Set();
    const related = [];

    domains.forEach(domain => {
      if (domain === mainHost || domain === mainNorm) return;
      if (hostMatches(mainHost, domain)) return;
      const lower = String(domain).toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      related.push(domain);
    });
    related.sort((a, b) => a.localeCompare(b));

    sendResponse({ mainDomain: mainHost, relatedDomains: related, collecting: false });
  });
}

function getProxyStatus() {
  const configured = cachedConfig.proxies.filter(isProxyConfigured);
  const activeProxy = findProxyById(cachedConfig.proxies, cachedConfig.activeProxyId);
  return {
    extensionEnabled: cachedConfig.extensionEnabled,
    autoProxyEnabled: cachedConfig.autoProxyEnabled,
    killSwitchEnabled: cachedConfig.killSwitchEnabled,
    killSwitchActive: cachedConfig.killSwitchEnabled && configured.length === 0,
    configuredProxyCount: configured.length,
    proxyCount: cachedConfig.proxies.length,
    rulesCount: cachedConfig.proxyList.length + cachedConfig.directList.length,
    activeProxy: publicProxy(activeProxy),
    testInProgress: Boolean(testSession),
    lastProxyError,
    lastIssue
  };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || typeof request.action !== 'string') return;

  if (request.action === 'getRelatedDomains') {
    whenTabDomainsReady(() => getRelatedDomainsForActiveTab(sendResponse));
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
    saveStatsNow();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'setWebrtcPolicy') {
    applyWebrtcPolicy(request.enabled === true, (error) => {
      sendResponse(error ? { success: false, error } : { success: true });
    });
    return true;
  }

  if (request.action === 'getWebrtcPolicy') {
    try {
      chrome.privacy.network.webRTCIPHandlingPolicy.get({}, (result) => {
        sendResponse({ enabled: result && result.value === 'proxy_only' });
      });
    } catch (error) {
      sendResponse({ enabled: false });
    }
    return true;
  }

  if (request.action === 'clearBadge') {
    clearBadge();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'acknowledgeIssue') {
    if (lastIssue) {
      acknowledgedIssueKey = `${lastIssue.kind}:${lastIssue.message}`;
      issueMuteUntil = Date.now() + 60000;
    }
    lastIssue = null;
    lastProxyError = null;
    chrome.storage.local.set({ lastIssue: null, lastProxyError: null }, () => {
      clearBadge();
      chrome.action.setTitle({ title: 'Proxy Manager' });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'getProxyStatus') {
    onConfigReady(() => {
      ensureConfigFresh().then(() => sendResponse(getProxyStatus()));
    });
    return true;
  }

  if (request.action === 'probeActiveProxy') {
    onConfigReady(() => {
      ensureConfigFresh().then(() => {
        applyProxyConfigNow();
        whenApplyIdle(() => {
          probeActiveProxy().then(result => sendResponse(result));
        });
      });
    });
    return true;
  }

  if (request.action === 'getActiveProxyIp') {
    onConfigReady(() => {
      ensureConfigFresh().then(() => {
        applyProxyConfigNow();
        whenApplyIdle(() => {
          probeActiveProxy().then(result => {
            sendResponse(result.success
              ? { success: true, ip: result.ip, latencyMs: result.latencyMs }
              : { success: false, error: result.message || result.error });
          });
        });
      });
    });
    return true;
  }

  if (request.action === 'testProxy' || request.action === 'testSpecificProxy') {
    onConfigReady(() => {
      ensureConfigFresh().then(() => {
        applyProxyConfigNow();
        whenApplyIdle(() => {
          runProxyTest(request.proxyId).then(result => sendResponse(result));
        });
      });
    });
    return true;
  }

  if (request.action === 'restoreProxySettings') {
    testSession = null;
    if (chrome.alarms) chrome.alarms.clear(RESTORE_ALARM);
    lastAppliedSignature = '';
    applyProxyConfigNow();
    sendResponse({ success: true });
    return true;
  }
});

// ===================== УСТАНОВКА / СТАРТ / БУДИЛЬНИКИ =====================

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(
    ['proxyList', 'directList', 'proxies', 'activeProxyId', 'installDate', 'lastUpdateDate',
      'extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled', 'autoProxyTimeout',
      'killSwitchEnabled', 'lastLogCleanup'],
    (data) => {
      const proxies = Array.isArray(data.proxies) ? data.proxies : [];
      let activeProxyId = data.activeProxyId == null ? null : data.activeProxyId;

      if (activeProxyId != null && !findProxyById(proxies, activeProxyId)) {
        activeProxyId = proxies.length > 0 ? proxies[0].id : null;
      }
      if (proxies.length === 0) activeProxyId = null;

      const defaults = {
        proxyList: (Array.isArray(data.proxyList) ? data.proxyList : []).filter(item => item && typeof item === 'object'),
        directList: (Array.isArray(data.directList) ? data.directList : []).filter(item => item && typeof item === 'object'),
        proxies: proxies.filter(item => item && typeof item === 'object'),
        activeProxyId,
        extensionEnabled: data.extensionEnabled !== false,
        autoProxyEnabled: data.autoProxyEnabled !== false,
        autoProxyTimeoutEnabled: data.autoProxyTimeoutEnabled === true,
        autoProxyTimeout: Math.min(30, Math.max(2, parseInt(data.autoProxyTimeout, 10) || 5)),
        killSwitchEnabled: data.killSwitchEnabled === true
      };

      if (!data.installDate) defaults.installDate = Date.now();
      if (!data.lastLogCleanup) defaults.lastLogCleanup = Date.now();
      if (details.reason === 'update') defaults.lastUpdateDate = Date.now();

      chrome.storage.local.set(defaults, () => {
        configLoadSequence++;
        cachedConfig.proxyList = defaults.proxyList;
        cachedConfig.directList = defaults.directList;
        cachedConfig.proxies = defaults.proxies;
        cachedConfig.activeProxyId = defaults.activeProxyId;
        cachedConfig.extensionEnabled = defaults.extensionEnabled;
        cachedConfig.autoProxyEnabled = defaults.autoProxyEnabled;
        cachedConfig.killSwitchEnabled = defaults.killSwitchEnabled;
        applyProxyConfigNow();
      });
    }
  );

  createContextMenu();
  applyStoredWebrtcPolicy();

  if (details.reason === 'install') {
    chrome.storage.local.set({ onboardingComplete: false }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  loadConfigFromStorage(() => {
    applyProxyConfigNow();
    applyStoredWebrtcPolicy();
  });
});

chrome.storage.onChanged.addListener((changes) => {
  // Пользователь очистил логи — не дописываем в них старый буфер.
  if (changes.routeLogs && changes.routeLogs.newValue === '') {
    logEpoch++;
    logBuffer = '';
    if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  }

  const relevant = ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled'];
  if (!relevant.some(key => changes[key])) return;

  loadConfigFromStorage(() => {
    if (testSession) applyPending = true;
    else applyProxyConfig();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESTORE_ALARM) {
    if (testSession) {
      logRoute('CONFIG', 'Test restored', 'Тестовый режим снят по таймауту');
      testSession = null;
    }
    lastAppliedSignature = '';
    applyProxyConfigNow();
    return;
  }

  if (alarm.name === MAINTENANCE_ALARM) {
    flushLogs();
    saveStatsNow();
    maybeCleanupLogs();
    return;
  }

  if (alarm.name === HEALTH_ALARM) {
    void checkActiveProxyHealth();
  }
});

if (chrome.alarms) {
  chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 30 });
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.notifications.clear(notificationId);
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#activity') });
  });
}

// ===================== ИНИЦИАЛИЗАЦИЯ =====================

restoreTabDomains();
initStats();

chrome.storage.local.get(['lastProxyError', 'lastIssue'], (data) => {
  if (data.lastProxyError && typeof data.lastProxyError === 'object') {
    lastProxyError = data.lastProxyError;
  }
  if (data.lastIssue && typeof data.lastIssue === 'object') {
    lastIssue = data.lastIssue;
  }
});

loadConfigFromStorage(() => {
  applyProxyConfigNow();
  applyStoredWebrtcPolicy();
  maybeCleanupLogs();
});
