function sameProxyId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function parseProxyId(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  const num = Number(str);
  if (/^\d+(\.\d+)?$/.test(str) && Number.isFinite(num)) return num;
  return str;
}

function findProxyById(proxies, id) {
  return (proxies || []).find(p => sameProxyId(p.id, id));
}

// Debounce функция для оптимизации поиска
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ============= КЭШ ДЛЯ UI =============
let cachedData = {
  proxyList: [],
  directList: [],
  proxies: [],
  activeProxyId: null,
  autoAddRelated: false,
  extensionEnabled: true,
  autoProxyEnabled: false
};

// Флаг для предотвращения множественных рендеров
let isRendering = false;
let pendingRender = false;

// Валидация IP адреса
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  
  // IPv4
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(ip)) {
    const parts = ip.split('.');
    return parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  // IPv6 (упрощённая проверка)
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (ipv6Regex.test(ip)) {
    return true;
  }
  
  return false;
}

// Валидация hostname
function isValidHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  
  // Проверка длины
  if (hostname.length > 253) return false;
  
  // Hostname может содержать буквы, цифры, дефисы и точки
  const hostnameRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  
  return hostnameRegex.test(hostname);
}

// Валидация порта
function isValidPort(port) {
  const portNum = parseInt(port, 10);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

// Валидация прокси хоста (IP или hostname)
function isValidProxyHost(host) {
  if (!host || typeof host !== 'string') return false;
  
  const trimmedHost = host.trim();
  
  // Проверяем IP или hostname
  return isValidIP(trimmedHost) || isValidHostname(trimmedHost);
}

// Элементы
const addProxyBtn = document.getElementById('addProxy');
const proxiesList = document.getElementById('proxiesList');
const testProxyBtn = document.getElementById('testProxy');
const proxyTestResult = document.getElementById('proxyTestResult');
const analyzeCurrentPageBtn = document.getElementById('analyzeCurrentPage');
const relatedDomainsSection = document.getElementById('relatedDomainsSection');
const relatedDomainsList = document.getElementById('relatedDomainsList');
const autoAddRelatedCheckbox = document.getElementById('autoAddRelated');

// Proxy list
const addToProxyListBtn = document.getElementById('addToProxyList');
const proxyListType = document.getElementById('proxyListType');
const proxyListValue = document.getElementById('proxyListValue');
const proxyListSites = document.getElementById('proxyListSites');

// Direct list
const addToDirectListBtn = document.getElementById('addToDirectList');
const directListType = document.getElementById('directListType');
const directListValue = document.getElementById('directListValue');
const directListSites = document.getElementById('directListSites');

const importConfigFile = document.getElementById('importConfigFile');
const exportConfigBtn = document.getElementById('exportConfig');
const importConfigBtn = document.getElementById('importConfig');
const clearLogsBtn = document.getElementById('clearLogs');
const mainToggle = document.getElementById('mainToggle');
const extensionStatusBadge = document.getElementById('extensionStatusBadge');
const proxyListSearch = document.getElementById('proxyListSearch');
const directListSearch = document.getElementById('directListSearch');
const proxyListCount = document.getElementById('proxyListCount');
const directListCount = document.getElementById('directListCount');

// Управление вкладками
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabName).classList.add('active');
    btn.classList.add('active');
    
    if (tabName === 'logs') {
      loadLogs();
    } else if (tabName === 'stats') {
      loadStats();
    }
  });
});

// Управление подвкладками
document.querySelectorAll('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const subtabName = btn.dataset.subtab;
    
    document.querySelectorAll('.subtab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(subtabName).classList.add('active');
    btn.classList.add('active');
    
    // Перерендериваем данные при переключении вкладок
    loadData();
  });
});

// Загрузка данных
function loadData() {
  // Предотвращаем множественные одновременные рендеры
  if (isRendering) {
    pendingRender = true;
    return;
  }
  
  isRendering = true;
  
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'autoAddRelated', 'extensionEnabled', 'autoProxyEnabled'], (data) => {
    // Обновляем кэш
    cachedData.proxyList = data.proxyList || [];
    cachedData.directList = data.directList || [];
    cachedData.proxies = data.proxies || [];
    cachedData.activeProxyId = data.activeProxyId;
    cachedData.autoAddRelated = data.autoAddRelated || false;
    cachedData.extensionEnabled = data.extensionEnabled !== false;
    cachedData.autoProxyEnabled = data.autoProxyEnabled === true;
    
    renderProxies(cachedData.proxies, cachedData.activeProxyId);
    
    // Применяем текущий поисковый запрос при рендере
    const proxySearchQuery = proxyListSearch?.value || '';
    const directSearchQuery = directListSearch?.value || '';
    
    const filteredProxyList = filterSites(cachedData.proxyList, proxySearchQuery);
    const filteredDirectList = filterSites(cachedData.directList, directSearchQuery);
    
    renderSites(filteredProxyList, proxyListSites, 'proxyList');
    renderSites(filteredDirectList, directListSites, 'directList');
    
    // Обновляем счётчики
    updateSearchCount(cachedData.proxyList.length, filteredProxyList.length, proxyListCount);
    updateSearchCount(cachedData.directList.length, filteredDirectList.length, directListCount);
    
    // Устанавливаем состояние чекбокса
    if (autoAddRelatedCheckbox) {
      autoAddRelatedCheckbox.checked = cachedData.autoAddRelated;
    }
    
    // Обновляем главный переключатель
    updateMainToggle(cachedData.extensionEnabled);

    // Обновляем переключатель автопрокси
    const autoProxyToggle = document.getElementById('autoProxyToggle');
    if (autoProxyToggle) {
      if (cachedData.autoProxyEnabled) {
        autoProxyToggle.classList.add('active');
      } else {
        autoProxyToggle.classList.remove('active');
      }
    }
    
    isRendering = false;
    
    // Если был запрос на рендер во время выполнения, выполняем его
    if (pendingRender) {
      pendingRender = false;
      loadData();
    }
  });
}

function setActiveProxy(proxyId) {
  chrome.storage.local.set({ activeProxyId: proxyId }, loadData);
}

function setupProxiesListHandlers() {
  if (proxiesList.dataset.handlersReady === '1') return;
  proxiesList.dataset.handlersReady = '1';

  proxiesList.addEventListener('change', (e) => {
    const target = e.target;
    const id = parseProxyId(target.dataset.id);

    if (target.name === 'activeProxy') {
      setActiveProxy(parseProxyId(target.value));
      return;
    }
    if (target.classList.contains('proxy-name-input')) {
      updateProxy(id, 'name', target.value);
    } else if (target.classList.contains('proxy-host')) {
      updateProxy(id, 'host', target.value);
    } else if (target.classList.contains('proxy-port')) {
      updateProxy(id, 'port', parseInt(target.value, 10));
    } else if (target.classList.contains('proxy-type')) {
      updateProxy(id, 'type', target.value);
    } else if (target.classList.contains('proxy-username')) {
      updateProxy(id, 'username', target.value);
    } else if (target.classList.contains('proxy-password')) {
      updateProxy(id, 'password', target.value);
    }
  });

  proxiesList.addEventListener('input', (e) => {
    const target = e.target;

    if (target.classList.contains('proxy-host')) {
      const value = target.value.trim();
      if (value === '' || isValidProxyHost(value)) {
        target.classList.remove('invalid-input');
        target.title = '';
      } else {
        target.classList.add('invalid-input');
        target.title = 'Неверный формат IP или hostname';
      }
    } else if (target.classList.contains('proxy-port')) {
      const value = target.value;
      if (value === '' || isValidPort(value)) {
        target.classList.remove('invalid-input');
        target.title = '';
      } else {
        target.classList.add('invalid-input');
        target.title = 'Порт должен быть от 1 до 65535';
      }
    }
  });

  proxiesList.addEventListener('click', (e) => {
    if (e.target.classList.contains('delete-btn-small')) {
      deleteProxy(parseProxyId(e.target.dataset.id));
      return;
    }

    const proxyItem = e.target.closest('.proxy-item');
    if (!proxyItem || e.target.closest('input, select, textarea, button')) {
      return;
    }

    const radio = proxyItem.querySelector('input[name="activeProxy"]');
    if (radio && !radio.checked) {
      radio.checked = true;
      setActiveProxy(parseProxyId(radio.value));
    }
  });
}

// Рендер списка прокси (используем DocumentFragment)
function renderProxies(proxies, activeProxyId) {
  if (proxies.length === 0) {
    proxiesList.innerHTML = '<div class="empty-state-small">Нет прокси серверов</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  proxies.forEach(proxy => {
    const isActive = sameProxyId(proxy.id, activeProxyId);
    const item = document.createElement('div');
    item.className = `proxy-item${isActive ? ' active' : ''}`;

    const isHostValid = !proxy.host || proxy.host.trim() === '' || isValidProxyHost(proxy.host);
    const isPortValid = !proxy.port || isValidPort(proxy.port);
    const hostClass = isHostValid ? '' : 'invalid-input';
    const portClass = isPortValid ? '' : 'invalid-input';
    const proxyId = String(proxy.id);

    item.innerHTML = `
      <div class="proxy-header-row">
        <input type="radio" name="activeProxy" value="${proxyId}" ${isActive ? 'checked' : ''} class="proxy-radio-input" aria-label="Выбрать прокси ${proxy.name}">
        <input type="text" class="proxy-name-input" value="${proxy.name}" data-id="${proxyId}" placeholder="Название прокси">
        <button type="button" class="delete-btn-small" data-id="${proxyId}" title="Удалить">✕</button>
      </div>
      <div class="proxy-config-row">
        <input type="text" class="proxy-host ${hostClass}" value="${proxy.host}" data-id="${proxyId}" placeholder="IP адрес или hostname" title="${isHostValid ? '' : 'Неверный формат IP или hostname'}">
        <input type="number" class="proxy-port ${portClass}" value="${proxy.port}" data-id="${proxyId}" placeholder="Порт" min="1" max="65535" title="${isPortValid ? '' : 'Порт должен быть от 1 до 65535'}">
        <select class="proxy-type" data-id="${proxyId}">
          <option value="SOCKS5" ${proxy.type === 'SOCKS5' ? 'selected' : ''}>SOCKS5</option>
          <option value="SOCKS" ${proxy.type === 'SOCKS' ? 'selected' : ''}>SOCKS4</option>
          <option value="PROXY" ${proxy.type === 'PROXY' ? 'selected' : ''}>HTTP</option>
          <option value="HTTPS" ${proxy.type === 'HTTPS' ? 'selected' : ''}>HTTPS</option>
        </select>
      </div>
      <div class="proxy-auth-row">
        <input type="text" class="proxy-username" value="${proxy.username || ''}" data-id="${proxyId}" placeholder="Логин (опционально)">
        <input type="password" class="proxy-password" value="${proxy.password || ''}" data-id="${proxyId}" placeholder="Пароль (опционально)">
      </div>
    `;
    fragment.appendChild(item);
  });
  
  proxiesList.innerHTML = '';
  proxiesList.appendChild(fragment);
  setupProxiesListHandlers();
}

// Обновление прокси
function updateProxy(id, field, value) {
  // Валидация перед сохранением
  if (field === 'host') {
    if (value && value.trim() && !isValidProxyHost(value)) {
      alert('❌ Неверный формат IP адреса или hostname\n\nПримеры правильных значений:\n• 127.0.0.1\n• 192.168.1.1\n• proxy.example.com\n• localhost');
      loadData(); // Перезагружаем данные для отмены изменения
      return;
    }
  }
  
  if (field === 'port') {
    if (!isValidPort(value)) {
      alert('❌ Неверный порт\n\nПорт должен быть числом от 1 до 65535');
      loadData(); // Перезагружаем данные для отмены изменения
      return;
    }
  }
  
  chrome.storage.local.get(['proxies'], (data) => {
    const proxies = data.proxies.map(p => sameProxyId(p.id, id) ? { ...p, [field]: value } : p);
    chrome.storage.local.set({ proxies }, loadData);
  });
}

// Удаление прокси
function deleteProxy(id) {
  chrome.storage.local.get(['proxies', 'activeProxyId'], (data) => {
    if (data.proxies.length <= 1) {
      alert('Нельзя удалить последний прокси. Должен остаться хотя бы один.');
      return;
    }
    
    const proxyToDelete = findProxyById(data.proxies, id);
    if (!proxyToDelete) return;

    if (!confirm(`Удалить прокси "${proxyToDelete.name}"?\n\n${proxyToDelete.host}:${proxyToDelete.port} (${proxyToDelete.type})`)) {
      return;
    }

    const proxies = data.proxies.filter(p => !sameProxyId(p.id, id));
    const updates = { proxies };

    if (sameProxyId(data.activeProxyId, id)) {
      updates.activeProxyId = proxies[0].id;
    }
    
    chrome.storage.local.set(updates, loadData);
  });
}

// Добавление прокси
addProxyBtn.addEventListener('click', () => {
  chrome.storage.local.get(['proxies'], (data) => {
    const proxies = data.proxies || [];
    const newProxy = {
      id: crypto.randomUUID(),
      name: `Proxy ${proxies.length + 1}`,
      host: '127.0.0.1',
      port: 1080,
      type: 'SOCKS5',
      enabled: true,
      username: '',
      password: ''
    };
    proxies.push(newProxy);
    chrome.storage.local.set({ proxies }, loadData);
  });
});

// Тест прокси
testProxyBtn.addEventListener('click', () => {
  proxyTestResult.style.display = 'flex';
  const textSpan = proxyTestResult.querySelector('.test-result-text');
  textSpan.textContent = 'Проверка...';
  proxyTestResult.className = 'proxy-test-result loading';
  
  chrome.storage.local.get(['proxies', 'activeProxyId', 'extensionEnabled'], (data) => {
    const activeProxy = findProxyById(data.proxies, data.activeProxyId);
    const extensionEnabled = data.extensionEnabled !== false;
    
    if (!extensionEnabled) {
      textSpan.textContent = '✗ Расширение выключено';
      proxyTestResult.className = 'proxy-test-result error';
      return;
    }
    
    if (!activeProxy) {
      textSpan.textContent = '✗ Нет активного прокси';
      proxyTestResult.className = 'proxy-test-result error';
      return;
    }
    
    if (!activeProxy.host || !activeProxy.port || activeProxy.host.trim() === '') {
      textSpan.textContent = `✗ Прокси "${activeProxy.name}" не настроен (укажите IP и порт)`;
      proxyTestResult.className = 'proxy-test-result error';
      return;
    }
    
    chrome.runtime.sendMessage({ 
      action: 'testSpecificProxy', 
      proxyId: activeProxy.id 
    }, (response) => {
      if (chrome.runtime.lastError) {
        textSpan.textContent = `✗ Ошибка: ${chrome.runtime.lastError.message}`;
        proxyTestResult.className = 'proxy-test-result error';
        return;
      }
      
      if (response && response.success) {
        textSpan.textContent = `✓ IP через прокси "${activeProxy.name}": ${response.ip}`;
        proxyTestResult.className = 'proxy-test-result success';
      } else {
        const errorMsg = response?.error || 'Connection failed';
        textSpan.textContent = `✗ Прокси "${activeProxy.name}" недоступен (${errorMsg})`;
        proxyTestResult.className = 'proxy-test-result error';
      }
    });
  });
});

// Кнопка закрытия для proxy test
proxyTestResult.querySelector('.test-result-close').addEventListener('click', () => {
  proxyTestResult.style.display = 'none';
});

// Состояние раскрытых групп
const expandedGroups = new Set();

// Группировка доменов по основному домену
function groupDomainsByBase(sites) {
  const groups = {};
  
  // Список двухуровневых TLD
  const twoLevelTLDs = [
    'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za',
    'com.ru', 'net.ru', 'org.ru', 'co.nz', 'co.kr', 'com.cn'
  ];
  
  // Функция для извлечения базового домена
  function extractBaseDomain(domain) {
    // Убираем wildcard в начале
    if (domain.startsWith('*.')) {
      return domain.substring(2);
    }
    
    // Если нет точек - это одиночное слово (localhost, etc)
    if (!domain.includes('.')) {
      return domain;
    }
    
    const parts = domain.split('.');
    
    // Если только 2 части (example.com) - это уже базовый домен
    if (parts.length === 2) {
      return domain;
    }
    
    // Проверяем двухуровневые TLD (example.com.ru)
    const lastTwo = parts.slice(-2).join('.');
    if (twoLevelTLDs.includes(lastTwo)) {
      // Для доменов типа api.example.com.ru -> example.com.ru
      if (parts.length >= 3) {
        return parts.slice(-3).join('.');
      }
      return domain;
    }
    
    // Для обычных доменов берём последние 2 части
    // api.github.com -> github.com
    // cdn.api.github.com -> github.com
    return parts.slice(-2).join('.');
  }
  
  sites.forEach(site => {
    const domain = site.value;
    const baseDomain = extractBaseDomain(domain);
    
    if (!groups[baseDomain]) {
      groups[baseDomain] = {
        base: baseDomain,
        sites: []
      };
    }
    
    groups[baseDomain].sites.push(site);
  });
  
  // Сортируем группы по имени базового домена
  const sortedGroups = Object.values(groups).sort((a, b) => a.base.localeCompare(b.base));
  
  // Внутри каждой группы сортируем сайты:
  // 1. Сначала базовый домен или *.basedomain
  // 2. Потом wildcard домены (*.subdomain.basedomain)
  // 3. Потом конкретные поддомены (subdomain.basedomain)
  sortedGroups.forEach(group => {
    group.sites.sort((a, b) => {
      const aVal = a.value;
      const bVal = b.value;
      
      // Базовый домен или *.basedomain идут первыми
      if (aVal === group.base || aVal === `*.${group.base}`) return -1;
      if (bVal === group.base || bVal === `*.${group.base}`) return 1;
      
      // Wildcard домены идут перед конкретными
      const aIsWildcard = aVal.startsWith('*.');
      const bIsWildcard = bVal.startsWith('*.');
      
      if (aIsWildcard && !bIsWildcard) return -1;
      if (!aIsWildcard && bIsWildcard) return 1;
      
      // Иначе сортируем по алфавиту
      return aVal.localeCompare(bVal);
    });
  });
  
  return sortedGroups;
}

// Рендер списка сайтов с группировкой (DocumentFragment)
function renderSites(sites, container, listType) {
  if (!container) {
    console.error('renderSites: container is null for', listType);
    return;
  }
  
  if (sites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📝</div>
        <div>Список пуст</div>
      </div>
    `;
    return;
  }
  
  // Группируем домены
  const groups = groupDomainsByBase(sites);
  
  // Используем DocumentFragment для быстрого рендера
  const fragment = document.createDocumentFragment();
  
  groups.forEach(group => {
    const hasMultiple = group.sites.length > 1;
    const groupDiv = document.createElement('div');
    groupDiv.className = 'domain-group';
    
    if (hasMultiple) {
      // Группа с несколькими доменами
      const mainSite = group.sites.find(s => s.value === group.base) || group.sites[0];
      const otherSites = group.sites.filter(s => s !== mainSite);
      
      const enabledCount = group.sites.filter(s => s.enabled).length;
      const disabledCount = group.sites.length - enabledCount;
      
      const isExpanded = expandedGroups.has(group.base);
      
      groupDiv.innerHTML = `
        <div class="domain-group-header" data-group="${group.base}">
          <div class="expand-icon">${isExpanded ? '▼' : '▶'}</div>
          <div class="site-name">
            ${mainSite.value}
            <span class="subdomain-count enabled">${enabledCount}</span>
            ${disabledCount > 0 ? `<span class="subdomain-count disabled">${disabledCount}</span>` : ''}
          </div>
          <div class="site-actions">
            <div class="toggle-switch ${mainSite.enabled ? 'active' : ''}" data-id="${String(mainSite.id)}" data-list="${listType}"></div>
            <button type="button" class="delete-btn" data-id="${String(mainSite.id)}" data-list="${listType}">✕</button>
          </div>
        </div>
        <div class="domain-group-subdomains" style="display: ${isExpanded ? 'block' : 'none'};">
          ${otherSites.map(site => `
            <div class="site-item subdomain-item">
              <div class="site-name">${site.value}</div>
              <div class="site-actions">
                <div class="toggle-switch ${site.enabled ? 'active' : ''}" data-id="${String(site.id)}" data-list="${listType}"></div>
                <button type="button" class="delete-btn" data-id="${String(site.id)}" data-list="${listType}">✕</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      
      if (isExpanded) {
        groupDiv.querySelector('.domain-group-header').classList.add('expanded');
      }
    } else {
      // Одиночный домен
      const site = group.sites[0];
      groupDiv.innerHTML = `
        <div class="site-item">
          <div class="site-name">${site.value}</div>
          <div class="site-actions">
            <div class="toggle-switch ${site.enabled ? 'active' : ''}" data-id="${String(site.id)}" data-list="${listType}"></div>
            <button type="button" class="delete-btn" data-id="${String(site.id)}" data-list="${listType}">✕</button>
          </div>
        </div>
      `;
    }
    
    fragment.appendChild(groupDiv);
  });
  
  // Очищаем и добавляем все за один раз
  container.innerHTML = '';
  container.appendChild(fragment);
}

// Обработчики событий для списков (устанавливаются один раз, делегирование)
function setupSiteListHandlers(container) {
  if (container.dataset.handlersReady === '1') return;
  container.dataset.handlersReady = '1';

  container.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      deleteSite(parseProxyId(deleteBtn.dataset.id), deleteBtn.dataset.list);
      return;
    }

    const toggle = e.target.closest('.toggle-switch');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const enabled = !toggle.classList.contains('active');
      toggleSite(parseProxyId(toggle.dataset.id), toggle.dataset.list, enabled);
      return;
    }

    const header = e.target.closest('.domain-group-header');
    if (header && !e.target.closest('.site-actions')) {
      e.preventDefault();
      e.stopPropagation();

      const groupName = header.dataset.group;
      const subdomains = header.nextElementSibling;
      const icon = header.querySelector('.expand-icon');

      if (subdomains && subdomains.classList.contains('domain-group-subdomains')) {
        if (subdomains.style.display === 'none') {
          subdomains.style.display = 'block';
          icon.textContent = '▼';
          header.classList.add('expanded');
          expandedGroups.add(groupName);
        } else {
          subdomains.style.display = 'none';
          icon.textContent = '▶';
          header.classList.remove('expanded');
          expandedGroups.delete(groupName);
        }
      }
    }
  });
}

// Валидация домена для списков
function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  
  const trimmed = domain.trim();
  
  // Разрешаем wildcard паттерны
  if (trimmed.startsWith('*.')) {
    const withoutWildcard = trimmed.substring(2);
    return isValidHostname(withoutWildcard);
  }
  
  // Разрешаем паттерны с *
  if (trimmed.includes('*')) {
    // Упрощённая проверка для wildcard паттернов
    const withoutStars = trimmed.replace(/\*/g, 'a');
    return /^[a-zA-Z0-9.*-]+$/.test(withoutStars);
  }
  
  // Разрешаем URL паттерны с /
  if (trimmed.includes('/')) {
    return true; // URL паттерны проверяем упрощённо
  }
  
  // Обычный домен или IP
  return isValidHostname(trimmed) || isValidIP(trimmed);
}

// Добавление в список
function addToList(value, listKey) {
  value = value.trim();
  
  if (!value) {
    alert('Введите домен');
    return;
  }
  
  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  
  if (value.startsWith('.') && !value.startsWith('*.')) {
    value = '*' + value;
  }
  
  // Валидация домена
  if (!isValidDomain(value)) {
    alert('❌ Неверный формат домена\n\nПримеры правильных значений:\n• google.com\n• *.google.com\n• 192.168.1.1\n• localhost\n• *.ru');
    return;
  }
  
  chrome.storage.local.get([listKey], (data) => {
    const list = data[listKey] || [];
    
    if (list.find(s => s.value.toLowerCase() === value.toLowerCase())) {
      alert('Этот сайт уже в списке');
      return;
    }
    
    // Если добавляем в список прокси, проверяем нет ли в directList (приоритет)
    if (listKey === 'proxyList') {
      chrome.storage.local.get(['directList'], (directData) => {
        const directList = directData.directList || [];
        if (directList.find(s => s.value.toLowerCase() === value.toLowerCase())) {
          alert('❌ Этот сайт уже в списке напрямую\n\nПриоритет у списка прямых подключений — удалите его оттуда сначала.');
          return;
        }
        // Продолжаем добавление
        finalizeAdd(value, list, listKey);
      });
    } else {
      finalizeAdd(value, list, listKey);
    }
  });
}

function finalizeAdd(value, list, listKey) {
    list.push({
      id: crypto.randomUUID(),
      value: value,
      enabled: true
    });
    chrome.storage.local.set({ [listKey]: list }, loadData);
}

// Добавление в proxy list
addToProxyListBtn.addEventListener('click', () => {
  addToList(proxyListValue.value, 'proxyList');
  proxyListValue.value = '';
  proxyListValue.classList.remove('invalid-input');
});

proxyListValue.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addToProxyListBtn.click();
});

// Валидация в реальном времени для proxy list
proxyListValue.addEventListener('input', () => {
  let value = proxyListValue.value.trim();
  if (value) {
    value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (value.startsWith('.') && !value.startsWith('*.')) {
      value = '*' + value;
    }
    
    if (isValidDomain(value)) {
      proxyListValue.classList.remove('invalid-input');
    } else {
      proxyListValue.classList.add('invalid-input');
    }
  } else {
    proxyListValue.classList.remove('invalid-input');
  }
});

// Добавление в direct list
addToDirectListBtn.addEventListener('click', () => {
  addToList(directListValue.value, 'directList');
  directListValue.value = '';
  directListValue.classList.remove('invalid-input');
});

directListValue.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addToDirectListBtn.click();
});

// Валидация в реальном времени для direct list
directListValue.addEventListener('input', () => {
  let value = directListValue.value.trim();
  if (value) {
    value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (value.startsWith('.') && !value.startsWith('*.')) {
      value = '*' + value;
    }
    
    if (isValidDomain(value)) {
      directListValue.classList.remove('invalid-input');
    } else {
      directListValue.classList.add('invalid-input');
    }
  } else {
    directListValue.classList.remove('invalid-input');
  }
});

// Удаление сайта
function deleteSite(id, listKey) {
  if (id == null || !listKey) return;

  chrome.storage.local.get([listKey], (data) => {
    const list = (data[listKey] || []).filter(s => !sameProxyId(s.id, id));
    chrome.storage.local.set({ [listKey]: list }, loadData);
  });
}

// Toggle сайта
function toggleSite(id, listKey, enabled) {
  if (id == null || !listKey) return;

  chrome.storage.local.get([listKey], (data) => {
    const list = (data[listKey] || []).map(s =>
      sameProxyId(s.id, id) ? { ...s, enabled } : s
    );
    chrome.storage.local.set({ [listKey]: list }, loadData);
  });
}

// Поиск по списку
function filterSites(sites, searchQuery) {
  if (!searchQuery) return sites;
  
  const query = searchQuery.toLowerCase().trim();
  return sites.filter(site => site.value.toLowerCase().includes(query));
}

// Обновление счётчика результатов поиска
function updateSearchCount(total, filtered, countElement) {
  if (countElement) {
    if (filtered < total) {
      countElement.textContent = `${filtered} из ${total}`;
      countElement.style.display = 'block';
    } else {
      countElement.textContent = '';
      countElement.style.display = 'none';
    }
  }
}

// Поиск в proxy list с debounce (уменьшен debounce)
if (proxyListSearch) {
  const debouncedProxySearch = debounce(() => {
    const searchQuery = proxyListSearch.value;
    const filtered = filterSites(cachedData.proxyList, searchQuery);
    renderSites(filtered, proxyListSites, 'proxyList');
    updateSearchCount(cachedData.proxyList.length, filtered.length, proxyListCount);
  }, 200); // Уменьшено с 300 до 200мс
  
  proxyListSearch.addEventListener('input', debouncedProxySearch);
}

// Поиск в direct list с debounce (уменьшен debounce)
if (directListSearch) {
  const debouncedDirectSearch = debounce(() => {
    const searchQuery = directListSearch.value;
    const filtered = filterSites(cachedData.directList, searchQuery);
    renderSites(filtered, directListSites, 'directList');
    updateSearchCount(cachedData.directList.length, filtered.length, directListCount);
  }, 200); // Уменьшено с 300 до 200мс
  
  directListSearch.addEventListener('input', debouncedDirectSearch);
}

// Полный экспорт конфигурации
exportConfigBtn.addEventListener('click', () => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId'], (data) => {
    const config = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      proxyList: data.proxyList || [],
      directList: data.directList || [],
      proxies: data.proxies || [],
      activeProxyId: data.activeProxyId
    };
    
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxy-config-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
  });
});

// Полный импорт конфигурации
importConfigBtn.addEventListener('click', () => {
  importConfigFile.click();
});

importConfigFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const config = JSON.parse(event.target.result);
      
      // Валидация
      if (!config.proxyList && !config.directList && !config.proxies) {
        throw new Error('Неверный формат конфигурации');
      }
      
      const updates = {};
      if (config.proxyList) updates.proxyList = config.proxyList;
      if (config.directList) updates.directList = config.directList;
      if (config.proxies) updates.proxies = config.proxies;
      if (config.activeProxyId) updates.activeProxyId = config.activeProxyId;
      
      chrome.storage.local.set(updates, () => {
        loadData();
        alert(`✓ Конфигурация импортирована\nПрокси список: ${config.proxyList?.length || 0}\nDirect список: ${config.directList?.length || 0}\nПрокси серверы: ${config.proxies?.length || 0}`);
      });
    } catch (err) {
      alert('✗ Ошибка импорта: ' + err.message);
    }
  };
  reader.readAsText(file);
});

// Загрузка логов
function loadLogs() {
  const logsTableBody = document.getElementById('logsTableBody');
  
  if (!logsTableBody) {
    console.error('logsTableBody element not found');
    return;
  }
  
  chrome.storage.local.get(['routeLogs'], (data) => {
    const logs = data.routeLogs || '';
    
    if (!logs) {
      logsTableBody.innerHTML = '<tr><td colspan="5" class="logs-empty">📭 Логи пусты</td></tr>';
      return;
    }
    
    const logLines = logs.trim().split('\n').reverse();
    const parsedLogs = [];
    
    logLines.forEach(line => {
      if (!line.trim()) return;
      
      // Парсим строку: [20:32:39] REQUEST: PROXY - 2ip.ru -> SOCKS5 192.168.1.131:1080 (matched: *.ru)
      const match = line.match(/\[(.*?)\]\s+(\w+):\s+(\w+)\s+-\s+(.*?)\s+->\s+(.*?)(?:\s+\(matched:\s+(.*?)\))?$/);
      
      if (match) {
        const [, time, category, type, domain, route, rule] = match;
        parsedLogs.push({ time, category, type, domain, route, rule: rule || '-' });
      } else {
        // Для CONFIG и ERROR
        const configMatch = line.match(/\[(.*?)\]\s+(\w+):\s+(.*?)\s+-\s+(.*)$/);
        if (configMatch) {
          const [, time, category, type, details] = configMatch;
          parsedLogs.push({ time, category, type, domain: '-', route: details, rule: '-' });
        }
      }
    });
    
    renderLogs(parsedLogs);
  });
}

// Рендер логов
function renderLogs(logs) {
  const logsTableBody = document.getElementById('logsTableBody');
  const logFilter = document.getElementById('logFilter');
  
  if (!logsTableBody || !logFilter) {
    console.error('Logs elements not found');
    return;
  }
  
  const filterValue = logFilter.value;
  
  const filteredLogs = logs.filter(log => {
    if (filterValue === 'all') return true;
    if (filterValue === 'PROXY') return log.type === 'PROXY';
    if (filterValue === 'DIRECT') return log.type === 'DIRECT';
    if (filterValue === 'CONFIG') return log.category === 'CONFIG';
    if (filterValue === 'ERROR') return log.category === 'ERROR';
    return true;
  });
  
  if (filteredLogs.length === 0) {
    logsTableBody.innerHTML = '<tr><td colspan="5" class="logs-empty">Нет логов для выбранного фильтра</td></tr>';
    return;
  }
  
  logsTableBody.innerHTML = '';
  
  filteredLogs.forEach(log => {
    const row = document.createElement('tr');
    
    let typeClass = 'direct';
    if (log.type === 'PROXY') typeClass = 'proxy';
    if (log.category === 'CONFIG') typeClass = 'config';
    if (log.category === 'ERROR') typeClass = 'error';
    
    row.innerHTML = `
      <td class="log-time">${log.time}</td>
      <td><span class="log-type ${typeClass}">${log.type}</span></td>
      <td class="log-domain">${log.domain}</td>
      <td class="log-rule">${log.rule}</td>
      <td class="log-route">${log.route}</td>
    `;
    
    logsTableBody.appendChild(row);
  });
}

// Фильтр логов
const logFilterElement = document.getElementById('logFilter');
if (logFilterElement) {
  logFilterElement.addEventListener('change', loadLogs);
}

// Экспорт логов
const exportLogsBtn = document.getElementById('exportLogs');
if (exportLogsBtn) {
  exportLogsBtn.addEventListener('click', () => {
    chrome.storage.local.get(['routeLogs'], (data) => {
      const logs = data.routeLogs || '';
      
      if (!logs || logs.trim() === '') {
        alert('Логи пусты, нечего экспортировать');
        return;
      }
      
      // Создаём имя файла с текущей датой и временем
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      const filename = `proxy-logs-${year}-${month}-${day}-${hours}-${minutes}-${seconds}.txt`;
      
      // Создаём blob и скачиваем
      const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  });
}

// Очистка логов
clearLogsBtn.addEventListener('click', () => {
  if (confirm('Очистить все логи?')) {
    chrome.storage.local.set({ routeLogs: '' }, () => {
      loadLogs();
    });
  }
});

// Главный переключатель расширения
function updateMainToggle(enabled) {
  if (mainToggle) {
    if (enabled) {
      mainToggle.classList.add('active');
    } else {
      mainToggle.classList.remove('active');
    }
  }
  if (extensionStatusBadge) {
    if (enabled) {
      extensionStatusBadge.textContent = 'Включено';
      extensionStatusBadge.classList.remove('disabled');
    } else {
      extensionStatusBadge.textContent = 'Выключено';
      extensionStatusBadge.classList.add('disabled');
    }
  }
}

if (mainToggle) {
  mainToggle.addEventListener('click', () => {
    chrome.storage.local.get(['extensionEnabled'], (data) => {
      const currentState = data.extensionEnabled !== false;
      const newState = !currentState;
      
      chrome.storage.local.set({ extensionEnabled: newState }, () => {
        updateMainToggle(newState);
        
        // Показываем уведомление
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'logo.png',
          title: 'Proxy Manager',
          message: newState ? '✓ Расширение включено' : '✗ Расширение выключено'
        });
      });
    });
  });
}

// Инициализация
loadData();

// Очищаем бейдж при открытии попапа
chrome.runtime.sendMessage({ action: 'clearBadge' });

// Авто-прокси переключатель
const autoProxyToggle = document.getElementById('autoProxyToggle');
if (autoProxyToggle) {
  autoProxyToggle.addEventListener('click', () => {
    const newState = !cachedData.autoProxyEnabled;
    cachedData.autoProxyEnabled = newState;
    chrome.storage.local.set({ autoProxyEnabled: newState }, () => {
      if (newState) {
        autoProxyToggle.classList.add('active');
      } else {
        autoProxyToggle.classList.remove('active');
      }
    });
  });
}

// Устанавливаем обработчики событий для списков (один раз)
setupSiteListHandlers(proxyListSites);
setupSiteListHandlers(directListSites);

// Загрузка версии в футер
const manifest = chrome.runtime.getManifest();
document.getElementById('footerVersion').textContent = manifest.version;


// Обновление placeholder при изменении типа
if (proxyListType) {
  proxyListType.addEventListener('change', () => {
    const placeholders = {
      domain: 'google.com, *.ru, 2ip.ru',
      ip: '192.168.1.1, 10.0.0.0/8',
      url: 'https://example.com/path'
    };
    proxyListValue.placeholder = placeholders[proxyListType.value] || placeholders.domain;
  });
}

if (directListType) {
  directListType.addEventListener('change', () => {
    const placeholders = {
      domain: 'localhost, *.local',
      ip: '127.0.0.1, 192.168.0.0/16',
      url: 'https://internal.company.com'
    };
    directListValue.placeholder = placeholders[directListType.value] || placeholders.domain;
  });
}


// Обработчик чекбокса автодобавления
if (autoAddRelatedCheckbox) {
  autoAddRelatedCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ autoAddRelated: autoAddRelatedCheckbox.checked });
  });
}

// Загрузка статистики
function loadStats() {
  chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
    if (!response || !response.stats) return;
    
    const stats = response.stats;
    
    // Обновляем счётчики
    document.getElementById('proxyCount').textContent = stats.proxy || 0;
    document.getElementById('directCount').textContent = stats.direct || 0;
    document.getElementById('totalCount').textContent = (stats.proxy || 0) + (stats.direct || 0);
    
    // Рисуем график
    drawActivityChart(stats.hourly || []);
    
    // Показываем топ доменов
    showTopDomains(stats.domains || {});
  });
}

// Рисование графика активности
function drawActivityChart(hourlyData) {
  const canvas = document.getElementById('activityChart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  // Очищаем canvas
  ctx.clearRect(0, 0, width, height);
  
  if (hourlyData.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Нет данных', width / 2, height / 2);
    return;
  }
  
  // Находим максимальное значение
  const maxValue = Math.max(...hourlyData.map(d => d.proxy + d.direct), 1);
  
  // Параметры графика
  const padding = 40;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const barWidth = chartWidth / hourlyData.length;
  
  // Рисуем оси
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, height - padding);
  ctx.lineTo(width - padding, height - padding);
  ctx.stroke();
  
  // Оптимизация: рисуем все столбцы за один проход
  ctx.fillStyle = '#1a73e8';
  hourlyData.forEach((data, index) => {
    const x = padding + index * barWidth;
    const directHeight = (data.direct / maxValue) * chartHeight;
    ctx.fillRect(x + 1, height - padding - directHeight, barWidth - 2, directHeight);
  });
  
  ctx.fillStyle = '#34a853';
  hourlyData.forEach((data, index) => {
    const x = padding + index * barWidth;
    const proxyHeight = (data.proxy / maxValue) * chartHeight;
    const directHeight = (data.direct / maxValue) * chartHeight;
    ctx.fillRect(x + 1, height - padding - directHeight - proxyHeight, barWidth - 2, proxyHeight);
  });
  
  // Подписи
  ctx.fillStyle = '#666';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('0', 5, height - padding + 5);
  ctx.fillText(maxValue.toString(), 5, padding + 5);
  
  // Легенда
  ctx.fillStyle = '#34a853';
  ctx.fillRect(width - 150, 10, 15, 15);
  ctx.fillStyle = '#333';
  ctx.fillText('Прокси', width - 130, 22);
  
  ctx.fillStyle = '#1a73e8';
  ctx.fillRect(width - 150, 30, 15, 15);
  ctx.fillStyle = '#333';
  ctx.fillText('Напрямую', width - 130, 42);
}

// Показ топ доменов
function showTopDomains(domains) {
  const topDomainsList = document.getElementById('topDomainsList');
  if (!topDomainsList) return;
  
  // Сортируем домены по общему количеству запросов
  const sortedDomains = Object.entries(domains)
    .map(([domain, counts]) => ({
      domain,
      total: counts.proxy + counts.direct,
      proxy: counts.proxy,
      direct: counts.direct
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  
  if (sortedDomains.length === 0) {
    topDomainsList.innerHTML = '<div class="empty-state-small">Нет данных</div>';
    return;
  }
  
  topDomainsList.innerHTML = '';
  sortedDomains.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'top-domain-item';
    
    // Определяем основной тип маршрутизации
    const routeType = item.proxy > item.direct ? 'proxy' : 'direct';
    const routeIcon = item.proxy > item.direct ? '🔒' : '✅';
    const routeLabel = item.proxy > item.direct ? 'Прокси' : 'Напрямую';
    
    div.innerHTML = `
      <div class="top-domain-rank">${index + 1}</div>
      <div class="top-domain-name">${item.domain}</div>
      <span class="domain-route-badge ${routeType}">${routeIcon} ${routeLabel}: ${item.total}</span>
    `;
    
    topDomainsList.appendChild(div);
  });
}

// Сброс статистики
const resetStatsBtn = document.getElementById('resetStats');
if (resetStatsBtn) {
  resetStatsBtn.addEventListener('click', () => {
    if (confirm('Сбросить всю статистику?')) {
      chrome.runtime.sendMessage({ action: 'resetStats' }, () => {
        loadStats();
      });
    }
  });
}

// Анализ текущей страницы
analyzeCurrentPageBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getRelatedDomains' }, (response) => {
    if (!response || !response.mainDomain) {
      alert('Не удалось получить информацию о текущей странице');
      return;
    }
    
    const { mainDomain, relatedDomains } = response;
    
    relatedDomainsSection.style.display = 'block';
    
    if (relatedDomains.length === 0) {
      relatedDomainsList.innerHTML = `
        <div class="related-domains-empty">
          <div>📭 Не найдено связанных доменов</div></br>
          <div class="related-domains-hint">Основной домен: <strong>${mainDomain}</strong></div>
        </div>
      `;
      document.getElementById('relatedDomainsActions').style.display = 'none';
      return;
    }
    
    // Получаем текущие списки
    chrome.storage.local.get(['proxyList', 'directList'], (data) => {
      const proxyList = data.proxyList || [];
      const directList = data.directList || [];
      
      relatedDomainsList.innerHTML = `
        <div class="related-domains-hint">
          Основной домен: <strong>${mainDomain}</strong><br>
          Найдено связанных доменов: <strong>${relatedDomains.length}</strong>
        </div>
      `;
      
      let hasUnaddedDomains = false;
      
      relatedDomains.forEach(domain => {
        const inProxyList = proxyList.some(s => s.value === domain);
        const inDirectList = directList.some(s => s.value === domain);
        
        if (!inProxyList && !inDirectList) {
          hasUnaddedDomains = true;
        }
        
        const item = document.createElement('div');
        item.className = 'related-domain-item';
        
        let statusBadge = '';
        if (inProxyList) {
          statusBadge = '<span class="domain-badge proxy">В списке прокси</span>';
        } else if (inDirectList) {
          statusBadge = '<span class="domain-badge direct">В списке напрямую</span>';
        }
        
        // Показываем если это wildcard паттерн
        const isWildcard = domain.startsWith('*.');
        const wildcardHint = isWildcard ? '<span class="domain-badge wildcard">Wildcard</span>' : '';
        
        item.innerHTML = `
          <div class="related-domain-name">${domain} ${wildcardHint} ${statusBadge}</div>
          <div class="related-domain-actions">
            ${!inProxyList && !inDirectList ? `
              <button class="add-related-btn proxy" data-domain="${domain}">+ Прокси</button>
              <button class="add-related-btn direct" data-domain="${domain}">+ Напрямую</button>
            ` : ''}
          </div>
        `;
        
        relatedDomainsList.appendChild(item);
      });
      
      // Показываем кнопки массового добавления если есть неадобавленные домены
      const actionsBlock = document.getElementById('relatedDomainsActions');
      actionsBlock.style.display = hasUnaddedDomains ? 'flex' : 'none';
      
      // Обработчики для кнопок добавления
      document.querySelectorAll('.add-related-btn.proxy').forEach(btn => {
        btn.addEventListener('click', () => {
          addToList(btn.dataset.domain, 'proxyList');
          analyzeCurrentPageBtn.click(); // Обновляем список
        });
      });
      
      document.querySelectorAll('.add-related-btn.direct').forEach(btn => {
        btn.addEventListener('click', () => {
          addToList(btn.dataset.domain, 'directList');
          analyzeCurrentPageBtn.click(); // Обновляем список
        });
      });
    });
  });
});

// Скрыть блок связанных доменов
document.getElementById('hideRelatedDomains')?.addEventListener('click', () => {
  relatedDomainsSection.style.display = 'none';
});

// Добавить все домены в прокси
document.getElementById('addAllToProxy')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getRelatedDomains' }, (response) => {
    if (!response || !response.relatedDomains) return;
    
    chrome.storage.local.get(['proxyList'], (data) => {
      let proxyList = data.proxyList || [];
      let addedCount = 0;
      
      response.relatedDomains.forEach((domain, index) => {
        if (!proxyList.some(s => s.value === domain)) {
          proxyList.push({
            id: crypto.randomUUID(),
            value: domain,
            enabled: true
          });
          addedCount++;
        }
      });
      
      if (addedCount > 0) {
        chrome.storage.local.set({ proxyList }, () => {
          loadData();
          analyzeCurrentPageBtn.click();
        });
      }
    });
  });
});

// Добавить все домены напрямую
document.getElementById('addAllToDirect')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getRelatedDomains' }, (response) => {
    if (!response || !response.relatedDomains) return;
    
    chrome.storage.local.get(['directList'], (data) => {
      let directList = data.directList || [];
      let addedCount = 0;
      
      response.relatedDomains.forEach((domain, index) => {
        if (!directList.some(s => s.value === domain)) {
          directList.push({
            id: crypto.randomUUID(),
            value: domain,
            enabled: true
          });
          addedCount++;
        }
      });
      
      if (addedCount > 0) {
        chrome.storage.local.set({ directList }, () => {
          loadData();
          analyzeCurrentPageBtn.click();
        });
      }
    });
  });
});

