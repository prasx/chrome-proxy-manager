/**
 * Сравнивает два идентификатора (строковое сравнение).
 */
function sameProxyId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/**
 * Находит прокси-сервер в списке по ID.
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

/**
 * Валидация IPv4/IPv6.
 */
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(ip)) {
    return ip.split('.').every(part => { const num = parseInt(part, 10); return num >= 0 && num <= 255; });
  }
  return /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(ip);
}

/**
 * Валидация hostname (RFC 1123).
 */
function isValidHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  if (hostname.length > 253) return false;
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(hostname);
}

/**
 * Валидация порта (1–65535).
 */
function isValidPort(port) {
  const portNum = parseInt(port, 10);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

/**
 * Валидация хоста прокси (IP или hostname).
 */
function isValidProxyHost(host) {
  if (!host || typeof host !== 'string') return false;
  return isValidIP(host.trim()) || isValidHostname(host.trim());
}

/**
 * Валидация домена или паттерна для правил.
 */
function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const trimmed = domain.trim();
  if (trimmed.startsWith('*.')) return isValidHostname(trimmed.substring(2));
  if (trimmed.includes('*')) return /^[a-zA-Z0-9.*-]+$/.test(trimmed.replace(/\*/g, 'a'));
  if (trimmed.includes('/')) return true;
  return isValidHostname(trimmed) || isValidIP(trimmed);
}

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

// ===================== ДОМЕННЫЕ ГРУППЫ =====================

const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za',
  'com.ru', 'net.ru', 'org.ru', 'co.nz', 'co.kr', 'com.cn'
]);

/**
 * Извлекает базовый домен (2-й или 3-й уровень с учётом двухуровневых TLD).
 */
function extractBaseDomain(domain) {
  if (domain.startsWith('*.')) domain = domain.substring(2);
  if (!domain.includes('.')) return domain;
  const parts = domain.split('.');
  if (parts.length === 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.length >= 3 ? parts.slice(-3).join('.') : domain;
  return parts.slice(-2).join('.');
}

/**
 * Группирует домены по базовому домену, сортирует — базовый домен первым.
 * @returns {Array<{base: string, sites: Array}>}
 */
function groupDomainsByBase(sites) {
  const groups = {};
  sites.forEach(site => {
    const base = extractBaseDomain(site.value);
    if (!groups[base]) groups[base] = { base, sites: [] };
    groups[base].sites.push(site);
  });

  const sorted = Object.values(groups);
  sorted.forEach(group => {
    group.sites.sort((a, b) => {
      if (a.value === group.base || a.value === '*.' + group.base) return -1;
      if (b.value === group.base || b.value === '*.' + group.base) return 1;
      const aW = a.value.startsWith('*.');
      const bW = b.value.startsWith('*.');
      if (aW && !bW) return -1;
      if (!aW && bW) return 1;
      return a.value.localeCompare(b.value);
    });
  });
  return sorted;
}

// ===================== РАБОТА СО СПИСКАМИ ПРАВИЛ =====================

/**
 * Нормализует введённое значение домена.
 */
function normalizeRuleValue(value) {
  let v = value.trim();
  if (!v) return '';
  v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (v.startsWith('.') && !v.startsWith('*.')) v = '*' + v;
  return v;
}

/**
 * Добавляет домен в список правил с кросс-проверкой.
 * Если домен есть в противоположном списке — перемещает.
 * По умолчанию не вызывает alert, возвращает статус.
 * @param {string} value Домен
 * @param {'proxyList'|'directList'} listKey
 * @param {Function} onSaved Колбэк после сохранения
 */
function addToList(value, listKey, onSaved) {
  const v = normalizeRuleValue(value);
  if (!v) return { ok: false, reason: 'empty' };
  if (!isValidDomain(v)) { alert('Неверный формат домена'); return { ok: false, reason: 'invalid' }; }

  const otherKey = listKey === 'proxyList' ? 'directList' : 'proxyList';
  chrome.storage.local.get([listKey, otherKey], (d) => {
    const list = d[listKey] || [];
    const otherList = d[otherKey] || [];
    if (list.find(s => s.value.toLowerCase() === v.toLowerCase())) {
      alert('Уже в списке');
      return { ok: false, reason: 'duplicate' };
    }

    const newOtherList = otherList.filter(s => s.value.toLowerCase() !== v.toLowerCase());
    list.push({ id: crypto.randomUUID(), value: v, enabled: true });
    const updates = { [listKey]: list };
    if (newOtherList.length !== otherList.length) updates[otherKey] = newOtherList;
    chrome.storage.local.set(updates, () => { if (onSaved) onSaved(); });
    return { ok: true };
  });
}

/**
 * Удаляет правило из списка.
 */
function deleteSite(id, listKey, onSaved) {
  if (id == null || !listKey) return;
  chrome.storage.local.get([listKey], (d) => {
    const list = (d[listKey] || []).filter(s => !sameProxyId(s.id, id));
    chrome.storage.local.set({ [listKey]: list }, () => { if (onSaved) onSaved(); });
  });
}

/**
 * Включает/отключает правило.
 */
function toggleSite(id, listKey, enabled, onSaved) {
  if (id == null || !listKey) return;
  chrome.storage.local.get([listKey], (d) => {
    const list = (d[listKey] || []).map(s => sameProxyId(s.id, id) ? { ...s, enabled } : s);
    chrome.storage.local.set({ [listKey]: list }, () => { if (onSaved) onSaved(); });
  });
}

// ===================== БЕЙДЖ =====================

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] });
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
  const query = searchInput?.value?.toLowerCase().trim() || '';
  const filtered = query ? sites.filter(s => s.value.toLowerCase().includes(query)) : sites;

  if (countEl) {
    countEl.textContent = filtered.length < sites.length ? `${filtered.length} из ${sites.length}` : '';
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">Список пуст</div>';
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

      let html = `<div class="domain-group__header" data-group="${group.base}">
        <div class="domain-group__expand">&#9654;</div>
        <div class="site-item__name">${mainSite.value}
          <span class="sub-count on">${enabledCount}</span>
          ${disabledCount > 0 ? '<span class="sub-count off">' + disabledCount + '</span>' : ''}
        </div>
        <div class="site-item__actions">
          <div class="site-item__toggle ${mainSite.enabled ? 'active' : ''}" data-id="${String(mainSite.id)}" data-list="${listType}"></div>
          <button type="button" class="delete-btn" data-id="${String(mainSite.id)}" data-list="${listType}">&times;</button>
        </div>
      </div>
      <div class="domain-group__subs" style="display:none;">`;

      otherSites.forEach(site => {
        html += `<div class="site-item subdomain-item">
          <div class="site-item__name">${site.value}</div>
          <div class="site-item__actions">
            <div class="site-item__toggle ${site.enabled ? 'active' : ''}" data-id="${String(site.id)}" data-list="${listType}"></div>
            <button type="button" class="delete-btn" data-id="${String(site.id)}" data-list="${listType}">&times;</button>
          </div>
        </div>`;
      });
      html += '</div>';
      groupDiv.innerHTML = html;
    } else {
      const site = group.sites[0];
      groupDiv.innerHTML = `<div class="site-item">
        <div class="site-item__name">${site.value}</div>
        <div class="site-item__actions">
          <div class="site-item__toggle ${site.enabled ? 'active' : ''}" data-id="${String(site.id)}" data-list="${listType}"></div>
          <button type="button" class="delete-btn" data-id="${String(site.id)}" data-list="${listType}">&times;</button>
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
  if (container.dataset.handlersReady === '1') return;
  container.dataset.handlersReady = '1';

  container.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
      e.preventDefault(); e.stopPropagation();
      deleteSite(parseProxyId(deleteBtn.dataset.id), deleteBtn.dataset.list, onDataChange);
      return;
    }
    const toggle = e.target.closest('.site-item__toggle');
    if (toggle) {
      e.preventDefault(); e.stopPropagation();
      toggleSite(parseProxyId(toggle.dataset.id), toggle.dataset.list, !toggle.classList.contains('active'), onDataChange);
      return;
    }
    const header = e.target.closest('.domain-group__header');
    if (header && !e.target.closest('.site-item__actions')) {
      e.preventDefault(); e.stopPropagation();
      const subs = header.nextElementSibling;
      const icon = header.querySelector('.domain-group__expand');
      if (subs && subs.classList.contains('domain-group__subs')) {
        const visible = subs.style.display !== 'none';
        subs.style.display = visible ? 'none' : 'block';
        icon.innerHTML = visible ? '&#9654;' : '&#9660;';
        header.classList.toggle('expanded', !visible);
        if (visible) expandedGroups.delete(header.dataset.group);
        else expandedGroups.add(header.dataset.group);
      }
    }
  });
}
