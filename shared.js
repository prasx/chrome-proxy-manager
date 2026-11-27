/**
 * Общие функции расширения.
 * Здесь живут только чистые помощники и UI-хелперы: файл подключается
 * и в service worker (importScripts), и в обычные страницы расширения.
 */

// ===================== ИДЕНТИФИКАТОРЫ =====================

/**
 * Сравнивает два идентификатора.
 */
function sameProxyId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/**
 * Находит прокси-сервер по ID.
 */
function findProxyById(proxies, id) {
  return (proxies || []).find(p => sameProxyId(p.id, id));
}

/**
 * Приводит ID из data-атрибута к числу или строке.
 */
function parseProxyId(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  const num = Number(str);
  if (/^\d+(\.\d+)?$/.test(str) && Number.isFinite(num)) return num;
  return str;
}

// ===================== ВАЛИДАЦИЯ =====================

/**
 * Валидация IPv4/IPv6 (IPv6 проверяется через URL).
 */
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const value = ip.trim().replace(/^\[|\]$/g, '');
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(value)) {
    return value.split('.').every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  if (!value.includes(':')) return false;
  try {
    new URL('http://[' + value + ']');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Валидация hostname (RFC 1123, допускается localhost).
 */
function isValidHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const value = hostname.trim().replace(/\.$/, '');
  if (!value || value.length > 253) return false;
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value);
}

/**
 * Валидация порта (1–65535).
 */
function isValidPort(port) {
  if (port === null || port === undefined) return false;
  const value = String(port).trim();
  if (!/^\d+$/.test(value)) return false;
  const portNum = parseInt(value, 10);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

/**
 * Валидация хоста прокси (IP или hostname, IPv6 можно в скобках).
 */
function isValidProxyHost(host) {
  if (!host || typeof host !== 'string') return false;
  const value = host.trim().replace(/^\[|\]$/g, '');
  return isValidIP(value) || isValidHostname(value);
}

/**
 * Допустимые типы прокси в PAC-скрипте.
 */
const PROXY_TYPES = {
  PROXY: 'PROXY',
  HTTP: 'PROXY',
  HTTPS: 'HTTPS',
  SOCKS: 'SOCKS',
  SOCKS4: 'SOCKS',
  SOCKS5: 'SOCKS5'
};

/**
 * Приводит тип прокси к значению, которое понимает PAC.
 * @returns {string|null}
 */
function normalizeProxyType(type) {
  return PROXY_TYPES[String(type || '').trim().toUpperCase()] || null;
}

/**
 * SOCKS-прокси: Chrome не умеет авторизоваться на них через расширение.
 */
function isSocksProxyType(type) {
  const normalized = normalizeProxyType(type);
  return normalized === 'SOCKS' || normalized === 'SOCKS5';
}

/**
 * Человеческое название типа прокси для интерфейса.
 */
function displayProxyType(type) {
  const normalized = normalizeProxyType(type);
  if (normalized === 'PROXY') return 'HTTP';
  if (normalized === 'SOCKS') return 'SOCKS4';
  return normalized || '—';
}

/**
 * Проверяет, что прокси-сервер настроен (валидные тип, хост и порт).
 */
function isProxyConfigured(proxy) {
  return Boolean(
    proxy &&
    proxy.enabled !== false &&
    isValidProxyHost(proxy.host) &&
    isValidPort(proxy.port) &&
    normalizeProxyType(proxy.type)
  );
}

// ===================== ОБЩИЕ УТИЛИТЫ =====================

/**
 * Debounce.
 */
function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Экранирует HTML для вставки через innerHTML.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

/**
 * Короткое сообщение в углу страницы. Заменяет alert() для успешных действий.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 */
function showToast(message, type) {
  if (typeof document === 'undefined' || !document.body) return;
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast--' + (type || 'info');
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 180);
  }, 3200);
}

// ===================== ДОМЕННЫЕ ГРУППЫ =====================

const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za',
  'com.ru', 'net.ru', 'org.ru', 'co.nz', 'co.kr', 'com.cn',
  'co.id', 'com.tr', 'com.mx', 'com.ar', 'co.il', 'com.sg'
]);

/**
 * Извлекает базовый домен (2-й или 3-й уровень с учётом двухуровневых TLD).
 */
function extractBaseDomain(domain) {
  let value = String(domain || '').trim().toLowerCase();
  const slash = value.indexOf('/');
  if (slash !== -1) value = value.slice(0, slash);
  if (value.startsWith('*.')) value = value.slice(2);
  if (!value.includes('.')) return value;
  if (isValidIP(value)) return value;
  const parts = value.split('.');
  if (parts.length === 2) return value;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.length >= 3 ? parts.slice(-3).join('.') : value;
  return parts.slice(-2).join('.');
}

/**
 * Признак «плавающего» поддомена CDN/балансировщика.
 */
function looksDynamicSubdomain(label) {
  if (!label) return false;
  if (/^(cdn|cache|edge|node|server|static|img|image|media|video|assets?|data|web|rr|api)\d*$/i.test(label)) return true;
  if (/^[a-z0-9]+-{2,}/i.test(label)) return true;
  if (/^[a-z]+\d{2,}$/i.test(label)) return true;
  if (/^\d{1,3}-/.test(label)) return true;
  if (/^[a-f0-9]{12,}$/i.test(label)) return true;
  return false;
}

/**
 * Нормализует домен для правил.
 * Раньше любой поддомен 3-го уровня превращался в *.example.com,
 * из-за чего авто-прокси неожиданно заворачивал целые сайты.
 * Теперь wildcard появляется только для явно динамических поддоменов.
 */
function normalizeDomain(domain) {
  if (!domain) return '';
  let value = String(domain).trim().toLowerCase().replace(/\.$/, '');
  const slash = value.indexOf('/');
  if (slash !== -1) value = value.slice(0, slash);
  if (!value) return '';
  if (isValidIP(value)) return value;
  const parts = value.split('.');
  if (parts.length < 3) return value;
  if (!looksDynamicSubdomain(parts[0])) return value;
  const base = extractBaseDomain(value);
  return base && base !== value ? '*.' + base : value;
}

/**
 * Хост, который безопасно добавить в список прокси по ошибке загрузки.
 * Локальные адреса не трогаем: через прокси они всё равно не откроются.
 */
function isAutoProxyCandidate(host) {
  if (!host) return false;
  const value = String(host).trim().toLowerCase().replace(/\.$/, '');
  if (!value) return false;
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return false;
  if (value.endsWith('.onion')) return false;
  if (isValidIP(value)) {
    if (/^127\./.test(value)) return false;
    if (/^10\./.test(value)) return false;
    if (/^192\.168\./.test(value)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return false;
    if (value === '::1' || value === '0.0.0.0') return false;
  }
  return true;
}

/**
 * Группирует домены по базовому домену, сортирует — базовый домен первым.
 * @returns {Array<{base: string, sites: Array}>}
 */
function groupDomainsByBase(sites) {
  const groups = {};
  (sites || []).forEach(site => {
    const base = extractBaseDomain(site && site.value);
    if (!groups[base]) groups[base] = { base, sites: [] };
    groups[base].sites.push(site);
  });

  const sorted = Object.values(groups);
  sorted.forEach(group => {
    group.sites.sort((a, b) => {
      if (a.value === group.base || a.value === '*.' + group.base) return -1;
      if (b.value === group.base || b.value === '*.' + group.base) return 1;
      const aW = String(a.value).startsWith('*.');
      const bW = String(b.value).startsWith('*.');
      if (aW && !bW) return -1;
      if (!aW && bW) return 1;
      return String(a.value).localeCompare(String(b.value));
    });
  });
  return sorted;
}

// ===================== ПРАВИЛА МАРШРУТИЗАЦИИ =====================

/**
 * Нормализует введённое значение домена.
 * URL-схема и хвостовой слэш отбрасываются, путь сохраняется:
 * так паттерны вида "/api" и "example.com/watch?v=" продолжают работать.
 */
function normalizeRuleValue(value) {
  let v = String(value == null ? '' : value).trim();
  if (!v || /\s/.test(v)) return '';

  const scheme = v.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) {
    const rest = v.slice(scheme[0].length);
    if (rest.includes('*')) {
      v = rest;
    } else {
      try {
        const url = new URL(v);
        let path = url.pathname === '/' ? '' : url.pathname;
        v = url.hostname + path + (url.search || '');
      } catch (_) {
        return '';
      }
    }
  } else if (v.startsWith('//')) {
    const rest = v.slice(2);
    if (rest.includes('*')) {
      v = rest;
    } else {
      try {
        const url = new URL('http://' + rest);
        let path = url.pathname === '/' ? '' : url.pathname;
        v = url.hostname + path + (url.search || '');
      } catch (_) {
        return '';
      }
    }
  } else if (!v.includes('*') && !v.includes('/')) {
    try {
      v = new URL('http://' + v).hostname;
    } catch (_) {
      // оставляем как есть — валидация ниже покажет ошибку
    }
  } else if (!v.includes('*')) {
    const slash = v.indexOf('/');
    const hostPart = v.slice(0, slash);
    const rest = v.slice(slash);
    try {
      v = new URL('http://' + hostPart).hostname + rest;
    } catch (_) {
      // оставляем как есть
    }
  }

  if (v.endsWith('/')) v = v.slice(0, -1);
  if (v.startsWith('.') && !v.startsWith('*.')) v = '*' + v;
  return v.toLowerCase();
}

/**
 * Валидация домена или паттерна для правил (включая путь и wildcard).
 */
function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  let value = domain.trim();
  if (!value || /\s/.test(value)) return false;

  let path = '';
  const slash = value.indexOf('/');
  if (slash !== -1) {
    path = value.slice(slash);
    value = value.slice(0, slash);
    if (!path || path === '/') return false;
  }

  if (value === '*' || value === '*.' || value === '') {
    return false;
  }

  let hostPart = value.startsWith('.') ? value.slice(1) : value;
  if (hostPart.startsWith('*.')) hostPart = hostPart.slice(2);
  if (hostPart.includes('*')) {
    const probe = hostPart.replace(/\*/g, 'a');
    return isValidHostname(probe) || isValidIP(probe);
  }
  if (/^\d+(\.\d+){3}$/.test(hostPart)) return isValidIP(hostPart);
  return isValidHostname(hostPart) || isValidIP(hostPart);
}

/**
 * Разделяет правило на хостовую и путевую части.
 */
function splitRulePattern(pattern) {
  const value = String(pattern || '').trim().toLowerCase();
  const slash = value.indexOf('/');
  if (slash === -1) return { hostPart: value, pathPart: '' };
  return { hostPart: value.slice(0, slash), pathPart: value.slice(slash) };
}

/**
 * Escapes regexp special characters (кроме *).
 */
function globToRegexSource(glob) {
  return String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

/**
 * Проверяет соответствие хоста (и, при наличии, пути) правилу.
 */
function hostMatches(host, pattern, url) {
  if (!host || !pattern) return false;
  const target = String(host).toLowerCase().replace(/\.$/, '');
  const { hostPart, pathPart } = splitRulePattern(pattern);

  let hostOk = true;
  if (hostPart && hostPart !== '*') {
    if (hostPart.startsWith('*.')) {
      const domain = hostPart.slice(2);
      hostOk = target === domain || target.endsWith('.' + domain);
    } else if (hostPart.includes('*')) {
      hostOk = new RegExp('^' + globToRegexSource(hostPart) + '$', 'i').test(target);
    } else {
      hostOk = target === hostPart || target.endsWith('.' + hostPart);
    }
  }
  if (!hostOk) return false;
  if (!pathPart) return true;
  if (!url) return false;

  const targetUrl = String(url).toLowerCase();
  if (pathPart.includes('*')) {
    return new RegExp(globToRegexSource(pathPart), 'i').test(targetUrl);
  }
  return targetUrl.includes(pathPart);
}

/**
 * Добавляет домен в список правил с кросс-проверкой.
 * Если домен есть в противоположном списке — перемещает.
 * @param {string} value
 * @param {'proxyList'|'directList'} listKey
 * @param {(result: {ok: boolean, reason?: string, message?: string, value?: string, moved?: boolean}) => void} [done]
 */
function addToList(value, listKey, done) {
  const callback = typeof done === 'function' ? done : () => {};
  if (listKey !== 'proxyList' && listKey !== 'directList') {
    callback({ ok: false, reason: 'list', message: 'Неизвестный список' });
    return;
  }

  const v = normalizeRuleValue(value);
  if (!v) {
    callback({ ok: false, reason: 'empty', message: 'Введите домен' });
    return;
  }
  if (!isValidDomain(v)) {
    callback({ ok: false, reason: 'invalid', message: 'Неверный формат домена' });
    return;
  }

  const otherKey = listKey === 'proxyList' ? 'directList' : 'proxyList';
  chrome.storage.local.get([listKey, otherKey], (data) => {
    const list = data[listKey] || [];
    const otherList = data[otherKey] || [];
    const lower = v.toLowerCase();
    if (list.some(s => String(s.value).toLowerCase() === lower)) {
      callback({ ok: false, reason: 'duplicate', message: 'Уже в списке' });
      return;
    }

    const newOtherList = otherList.filter(s => String(s.value).toLowerCase() !== lower);
    const moved = newOtherList.length !== otherList.length;
    list.push({ id: crypto.randomUUID(), value: v, enabled: true });
    const updates = { [listKey]: list };
    if (moved) updates[otherKey] = newOtherList;
    chrome.storage.local.set(updates, () => {
      callback({ ok: true, value: v, moved });
    });
  });
}

/**
 * Удаляет правило из списка.
 */
function deleteSite(id, listKey, onSaved) {
  if (id == null || !listKey) return;
  chrome.storage.local.get([listKey], (data) => {
    const list = (data[listKey] || []).filter(s => !sameProxyId(s.id, id));
    chrome.storage.local.set({ [listKey]: list }, () => {
      if (typeof onSaved === 'function') onSaved();
    });
  });
}

/**
 * Включает/отключает правило.
 */
function toggleSite(id, listKey, enabled, onSaved) {
  if (id == null || !listKey) return;
  chrome.storage.local.get([listKey], (data) => {
    const list = (data[listKey] || []).map(s => sameProxyId(s.id, id) ? { ...s, enabled } : s);
    chrome.storage.local.set({ [listKey]: list }, () => {
      if (typeof onSaved === 'function') onSaved();
    });
  });
}

/**
 * Применяет изменения маршрутов для доменов открытой страницы.
 * Для изменённого домена старые точные правила удаляются из обоих списков,
 * затем добавляется выбранный маршрут (или ничего, если mode === null).
 * Возвращает новые списки и предупреждения, не записывая storage.
 *
 * @param {Array} proxyList
 * @param {Array} directList
 * @param {Array<{domain: string, mode: ('proxy'|'direct'|null)}>} changes
 */
function applyRuleChanges(proxyList, directList, changes) {
  let nextProxy = (Array.isArray(proxyList) ? proxyList : [])
    .filter(item => item && typeof item === 'object').slice();
  let nextDirect = (Array.isArray(directList) ? directList : [])
    .filter(item => item && typeof item === 'object').slice();

  const changed = (changes || []).filter(change => change && change.domain);
  const changedValues = new Set(changed.map(change => String(change.domain).toLowerCase()));
  let removed = 0;

  const removeExact = list => list.filter(site => {
    if (changedValues.has(String(site.value).toLowerCase())) {
      removed++;
      return false;
    }
    return true;
  });

  nextProxy = removeExact(nextProxy);
  nextDirect = removeExact(nextDirect);

  let addedProxy = 0;
  let addedDirect = 0;
  const conflicts = [];

  changed.forEach(change => {
    const domain = String(change.domain).toLowerCase();
    if (change.mode === 'proxy') {
      const blocker = nextDirect.find(site => site.enabled !== false && hostMatches(domain, site.value));
      if (blocker) {
        conflicts.push(`${domain} (${blocker.value})`);
        return;
      }
      nextProxy.push({ id: crypto.randomUUID(), value: domain, enabled: true });
      addedProxy++;
    } else if (change.mode === 'direct') {
      nextDirect.push({ id: crypto.randomUUID(), value: domain, enabled: true });
      addedDirect++;
    }
  });

  const remaining = [];
  changed.filter(change => change.mode === null).forEach(change => {
    const domain = String(change.domain).toLowerCase();
    const direct = nextDirect.find(site => site.enabled !== false && hostMatches(domain, site.value));
    const proxy = direct ? null : nextProxy.find(site => site.enabled !== false && hostMatches(domain, site.value));
    const matched = direct || proxy;
    if (matched) remaining.push(`${domain} (${matched.value})`);
  });

  return {
    proxyList: nextProxy,
    directList: nextDirect,
    removed,
    addedProxy,
    addedDirect,
    conflicts,
    remaining
  };
}

// ===================== PAC =====================

/**
 * Экранирует спецсимволы для вставки строки в PAC-скрипт.
 */
function escapePacString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

/**
 * Форматирует адрес прокси для PAC (IPv6 — в квадратных скобках).
 */
function formatProxyAddress(host, port) {
  const value = String(host || '').trim().replace(/^\[|\]$/g, '');
  const address = value.includes(':') ? '[' + value + ']' : value;
  return address + ':' + String(port).trim();
}

/**
 * Строка одного прокси для PAC: "SOCKS5 127.0.0.1:1080".
 */
function proxyToPacString(proxy) {
  const type = normalizeProxyType(proxy && proxy.type);
  if (!type || !proxy) return '';
  return `${type} ${formatProxyAddress(proxy.host, proxy.port)}`;
}

/**
 * Строит цепочку фоллбэка для PAC-скрипта.
 * Активный прокси — первый, остальные — по порядку. Дубликаты убираются.
 * Kill Switch: цепочка заканчивается на прокси (без DIRECT).
 * @returns {string|null}
 */
function buildProxyReturnChain(proxies, activeProxy, killSwitch) {
  const valid = (proxies || []).filter(isProxyConfigured);
  if (valid.length === 0) return null;

  const seen = new Set();
  const chain = [];
  const addProxy = (proxy) => {
    const pac = proxyToPacString(proxy);
    const key = pac.toLowerCase();
    if (pac && !seen.has(key)) {
      seen.add(key);
      chain.push(pac);
    }
  };

  if (activeProxy) {
    const active = valid.find(p => sameProxyId(p.id, activeProxy.id));
    if (active) addProxy(active);
  }
  valid.forEach(addProxy);
  if (chain.length === 0) return null;

  const result = chain.join('; ');
  return killSwitch ? result : result + '; DIRECT';
}

/**
 * Одна строка условия внутри PAC-функции.
 */
function generatePACondition(pattern, result) {
  const { hostPart, pathPart } = splitRulePattern(pattern);
  const res = escapePacString(result);
  const conditions = [];

  if (hostPart && hostPart !== '*') {
    if (hostPart.startsWith('*.')) {
      const domain = escapePacString(hostPart.slice(2));
      conditions.push(`(host === "${domain}" || host.endsWith(".${domain}"))`);
    } else if (hostPart.includes('*')) {
      const source = escapePacString('^' + globToRegexSource(hostPart) + '$');
      conditions.push(`new RegExp("${source}", "i").test(host)`);
    } else {
      const domain = escapePacString(hostPart);
      conditions.push(`(host === "${domain}" || host.endsWith(".${domain}"))`);
    }
  }

  if (pathPart) {
    if (pathPart.includes('*')) {
      const source = escapePacString(globToRegexSource(pathPart));
      conditions.push(`new RegExp("${source}", "i").test(url)`);
    } else {
      const path = escapePacString(pathPart);
      conditions.push(`url.toLowerCase().indexOf("${path}") !== -1`);
    }
  }

  if (conditions.length === 0) return '';
  return `  if (${conditions.join(' && ')}) return "${res}";\n`;
}

/**
 * Генерирует PAC-скрипт на основе конфигурации.
 * Проверка внешнего IP (api.ipify.org) идёт строго через активный прокси:
 * так тест показывает состояние выбранного сервера, а не резервного.
 * @param {object} config
 * @returns {string}
 */
function generatePAC(config) {
  const cfg = config || {};
  const killSwitch = cfg.killSwitchEnabled === true;
  const activeProxy = findProxyById(cfg.proxies || [], cfg.activeProxyId);
  const chain = buildProxyReturnChain(cfg.proxies || [], activeProxy, killSwitch);
  const activeRoute = isProxyConfigured(activeProxy) ? proxyToPacString(activeProxy) : 'DIRECT';

  const ipCheck = '  if (host === "api.ipify.org" || host === "api64.ipify.org" || ' +
    'host.endsWith(".api.ipify.org") || host.endsWith(".api64.ipify.org")) ' +
    `return "${escapePacString(activeRoute)}";\n`;

  if (!chain) {
    return 'function FindProxyForURL(url, host) {\n' + ipCheck +
      (killSwitch ? '  return "PROXY 0.0.0.0:0";\n}' : '  return "DIRECT";\n}');
  }

  const directRules = [];
  const directSeen = new Set();
  (cfg.directList || []).forEach(site => {
    if (!site || site.enabled === false) return;
    const pattern = String(site.value || '').trim().toLowerCase();
    if (!pattern || directSeen.has(pattern) || !isValidDomain(pattern)) return;
    directSeen.add(pattern);
    directRules.push(generatePACondition(pattern, 'DIRECT'));
  });

  const proxyRules = [];
  const proxySeen = new Set();
  (cfg.proxyList || []).forEach(site => {
    if (!site || site.enabled === false) return;
    const pattern = String(site.value || '').trim().toLowerCase();
    if (!pattern || proxySeen.has(pattern) || directSeen.has(pattern) || !isValidDomain(pattern)) return;
    proxySeen.add(pattern);
    proxyRules.push(generatePACondition(pattern, chain));
  });

  let code = 'function FindProxyForURL(url, host) {\n';
  code += '  host = host.toLowerCase().replace(/\\.$/, "");\n';
  code += ipCheck;
  code += directRules.join('');
  code += proxyRules.join('');
  code += killSwitch
    ? '  return "PROXY 0.0.0.0:0";\n}'
    : '  return "DIRECT";\n}';
  return code;
}

/**
 * Подбирает прокси для HTTP-авторизации по challenger'у.
 * Никогда не отдаёт пароль «чужому» прокси: только точное совпадение
 * host:port или единственный настроенный прокси с логином.
 * @returns {object|null}
 */
function findProxyForAuthChallenge(challenger, proxies, activeProxyId) {
  const withCredentials = (proxies || []).filter(p =>
    isProxyConfigured(p) && String(p.username || '').trim() !== ''
  );
  if (withCredentials.length === 0) return null;

  const host = challenger && challenger.host ? String(challenger.host).trim().toLowerCase() : '';
  const port = challenger ? parseInt(challenger.port, 10) : NaN;
  if (host && Number.isFinite(port)) {
    const exact = withCredentials.filter(p =>
      String(p.host).trim().toLowerCase() === host && parseInt(p.port, 10) === port
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      return exact.find(p => sameProxyId(p.id, activeProxyId)) || exact[0];
    }
    // Challenge может прийти с IP вместо hostname — если порт уникален, это тот же прокси.
    const byPort = withCredentials.filter(p => parseInt(p.port, 10) === port);
    if (byPort.length === 1) return byPort[0];
  }
  if (withCredentials.length === 1) return withCredentials[0];
  return null;
}

// ===================== БЕЙДЖ =====================

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] });
  chrome.action.setTitle({ title: 'Proxy Manager' });
}

// ===================== РЕНДЕРИНГ СПИСКА ПРАВИЛ =====================

const expandedGroups = new Set();

/**
 * Рендерит список правил (прокси/direct) с группировкой и поиском.
 * @param {Array} sites Список правил
 * @param {HTMLElement} container DOM-контейнер
 * @param {'proxyList'|'directList'} listType
 * @param {HTMLInputElement} [searchInput]
 * @param {HTMLElement} [countEl]
 */
function renderSiteList(sites, container, listType, searchInput, countEl) {
  if (!container) return;
  const query = searchInput && searchInput.value ? searchInput.value.toLowerCase().trim() : '';
  const all = sites || [];
  const filtered = query ? all.filter(s => String(s.value).toLowerCase().includes(query)) : all;

  if (countEl) {
    countEl.textContent = query ? `${filtered.length} из ${all.length}` : String(all.length);
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">${query
      ? 'Ничего не найдено'
      : 'Пока пусто — добавьте домен выше'}</div>`;
    return;
  }

  const groups = groupDomainsByBase(filtered);
  const fragment = document.createDocumentFragment();

  groups.forEach(group => {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'domain-group';

    if (group.sites.length > 1) {
      const mainSite = group.sites.find(s => s.value === group.base) || group.sites[0];
      const otherSites = group.sites.filter(s => s !== mainSite);
      const enabledCount = group.sites.filter(s => s.enabled).length;
      const disabledCount = group.sites.length - enabledCount;
      const expanded = expandedGroups.has(group.base);
      const toggleLabel = mainSite.enabled ? 'Отключить' : 'Включить';

      const subsHtml = otherSites.map(site => `<div class="site-item subdomain-item">
          <div class="site-item__name">${escapeHtml(site.value)}</div>
          <div class="site-item__actions">
            <button type="button" class="site-item__toggle ${site.enabled ? 'active' : ''}" role="switch" aria-checked="${site.enabled ? 'true' : 'false'}" aria-label="${site.enabled ? 'Отключить' : 'Включить'}: ${escapeHtml(site.value)}" data-id="${escapeHtml(site.id)}" data-list="${listType}"></button>
            <button type="button" class="delete-btn" aria-label="Удалить ${escapeHtml(site.value)}" data-id="${escapeHtml(site.id)}" data-list="${listType}">&times;</button>
          </div>
        </div>`).join('');

      groupDiv.innerHTML = `<div class="domain-group__header" data-group="${escapeHtml(group.base)}">
        <button type="button" class="domain-group__expand" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="${expanded ? 'Свернуть' : 'Развернуть'} группу ${escapeHtml(group.base)}">${expanded ? '&#9660;' : '&#9654;'}</button>
        <div class="site-item__name">${escapeHtml(mainSite.value)}
          <span class="sub-count on" title="Включено">${enabledCount}</span>
          ${disabledCount > 0 ? `<span class="sub-count off" title="Отключено">${disabledCount}</span>` : ''}
        </div>
        <div class="site-item__actions">
          <button type="button" class="site-item__toggle ${mainSite.enabled ? 'active' : ''}" role="switch" aria-checked="${mainSite.enabled ? 'true' : 'false'}" aria-label="${toggleLabel}: ${escapeHtml(mainSite.value)}" data-id="${escapeHtml(mainSite.id)}" data-list="${listType}"></button>
          <button type="button" class="delete-btn" aria-label="Удалить ${escapeHtml(mainSite.value)}" data-id="${escapeHtml(mainSite.id)}" data-list="${listType}">&times;</button>
        </div>
      </div>
      <div class="domain-group__subs"${expanded ? '' : ' hidden'}>${subsHtml}</div>`;
    } else {
      const site = group.sites[0];
      groupDiv.innerHTML = `<div class="site-item">
        <div class="site-item__name">${escapeHtml(site.value)}</div>
        <div class="site-item__actions">
          <button type="button" class="site-item__toggle ${site.enabled ? 'active' : ''}" role="switch" aria-checked="${site.enabled ? 'true' : 'false'}" aria-label="${site.enabled ? 'Отключить' : 'Включить'}: ${escapeHtml(site.value)}" data-id="${escapeHtml(site.id)}" data-list="${listType}"></button>
          <button type="button" class="delete-btn" aria-label="Удалить ${escapeHtml(site.value)}" data-id="${escapeHtml(site.id)}" data-list="${listType}">&times;</button>
        </div>
      </div>`;
    }
    fragment.appendChild(groupDiv);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

/**
 * Навешивает делегированные обработчики на список правил.
 * @param {HTMLElement} container
 * @param {Function} onDataChange Колбэк после удаления/переключения
 */
function setupRuleListHandlers(container, onDataChange) {
  if (!container || container.dataset.handlersReady === '1') return;
  container.dataset.handlersReady = '1';

  const toggleGroup = (trigger) => {
    const header = trigger.closest('.domain-group__header');
    if (!header) return;
    const subs = header.nextElementSibling;
    if (!subs || !subs.classList.contains('domain-group__subs')) return;
    const expanded = subs.hidden;
    subs.hidden = !expanded;
    const button = header.querySelector('.domain-group__expand');
    if (button) {
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      button.innerHTML = expanded ? '&#9660;' : '&#9654;';
      button.setAttribute('aria-label', `${expanded ? 'Свернуть' : 'Развернуть'} группу ${header.dataset.group}`);
    }
    header.classList.toggle('expanded', expanded);
    if (expanded) expandedGroups.add(header.dataset.group);
    else expandedGroups.delete(header.dataset.group);
  };

  container.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      deleteSite(parseProxyId(deleteBtn.dataset.id), deleteBtn.dataset.list, onDataChange);
      return;
    }
    const toggle = e.target.closest('.site-item__toggle');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      toggleSite(parseProxyId(toggle.dataset.id), toggle.dataset.list,
        toggle.getAttribute('aria-checked') !== 'true', onDataChange);
      return;
    }
    const header = e.target.closest('.domain-group__header');
    if (header && !e.target.closest('.site-item__actions')) {
      e.preventDefault();
      e.stopPropagation();
      toggleGroup(header);
    }
  });
}
