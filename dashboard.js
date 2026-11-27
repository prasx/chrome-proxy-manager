// ============= DASHBOARD =============

const $ = id => document.getElementById(id);

let data = {
  proxyList: [],
  directList: [],
  proxies: [],
  activeProxyId: null,
  extensionEnabled: true,
  autoProxyEnabled: true,
  killSwitchEnabled: false
};

let currentPage = 'overview';

/** Состояние проверки активного прокси. */
const health = {
  state: 'idle',
  ip: null,
  latencyMs: null,
  message: '',
  checkedAt: 0
};
let healthProbing = false;
let healthPending = false;
let healthTimer = null;
let lastProbedKey = '';

/** Результаты проверки серверов: id -> {state, ip, latencyMs, message}. */
const testResults = new Map();

// ============= ЗАГРУЗКА =============

function loadData(callback) {
  chrome.storage.local.get(
    ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled'],
    (result) => {
      data.proxyList = (Array.isArray(result.proxyList) ? result.proxyList : []).filter(item => item && typeof item === 'object');
      data.directList = (Array.isArray(result.directList) ? result.directList : []).filter(item => item && typeof item === 'object');
      data.proxies = (Array.isArray(result.proxies) ? result.proxies : []).filter(item => item && typeof item === 'object');
      data.activeProxyId = result.activeProxyId == null ? null : result.activeProxyId;
      data.extensionEnabled = result.extensionEnabled !== false;
      data.autoProxyEnabled = result.autoProxyEnabled !== false;
      data.killSwitchEnabled = result.killSwitchEnabled === true;

      renderAll();
      maybeProbeHealth(false);
      if (currentPage === 'settings') initSettingsPage();
      if (typeof callback === 'function') callback();
    }
  );
}

function proxyConfigKey() {
  return JSON.stringify([
    data.extensionEnabled,
    data.activeProxyId,
    data.proxies.map(p => [p.id, p.host, p.port, p.type, p.enabled !== false, p.username ? 1 : 0])
  ]);
}

function renderAll() {
  renderOverview();
  renderServers();
  renderActivity();
  renderRules();
  updateConnectionBar();
}

// ============= НАВИГАЦИЯ =============

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page-content').forEach(el => { el.style.display = 'none'; });
  const target = $('page-' + page);
  if (target) target.style.display = '';

  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    const active = item.dataset.page === page;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });

  if (page === 'settings') initSettingsPage();
  if (page === 'activity') renderActivity();
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
});

// ============= ПРОВЕРКА ПРОКСИ =============

function setConnection(statusText, metaText, stateClass) {
  const status = $('dashStatus');
  const meta = $('dashMeta');
  status.textContent = statusText;
  status.className = 'connection-status-text' + (stateClass ? ' ' + stateClass : '');
  meta.textContent = metaText || '—';
  meta.className = 'connection-meta' + (stateClass === 'error' ? ' error' : '');
}

function updateConnectionBar() {
  const toggle = $('dashToggle');
  const active = findProxyById(data.proxies, data.activeProxyId);

  toggle.classList.toggle('on', data.extensionEnabled);
  toggle.setAttribute('aria-checked', data.extensionEnabled ? 'true' : 'false');
  toggle.setAttribute('aria-label', data.extensionEnabled ? 'Выключить прокси' : 'Включить прокси');

  const testBtn = $('dashTestActiveBtn');
  testBtn.disabled = healthProbing || !data.extensionEnabled || !isProxyConfigured(active);
  testBtn.textContent = healthProbing ? 'Проверяем…' : 'Проверить';

  if (!data.extensionEnabled) {
    setConnection('Выключено', 'Весь трафик идёт напрямую', 'off');
    return;
  }

  if (!isProxyConfigured(active)) {
    setConnection(
      'Прокси не настроен',
      data.killSwitchEnabled
        ? 'Kill switch включён: сайты не будут открываться'
        : 'Добавьте сервер и выберите его активным',
      'error'
    );
    return;
  }

  const proxyName = active.name || active.host;
  const address = `${active.host}:${active.port}, ${displayProxyType(active.type)}`;

  if (health.state === 'checking' || healthProbing) {
    setConnection('Проверяем…', `${proxyName} — ${address}`, 'checking');
    return;
  }

  if (health.state === 'online') {
    const latency = Math.round(health.latencyMs || 0);
    setConnection(
      'Прокси работает',
      `${proxyName} — ${address} — IP ${health.ip}, ${latency} мс`,
      ''
    );
    return;
  }

  if (health.state === 'error') {
    const extra = data.proxies.filter(isProxyConfigured).length > 1
      ? ', резервные серверы могут использоваться'
      : '';
    setConnection(
      'Прокси не отвечает',
      (health.message || `${proxyName} — ${address}`) + extra,
      'error'
    );
    return;
  }

  setConnection('Проверяем…', `${proxyName} — ${address}`, 'checking');
}

function maybeProbeHealth(force) {
  const key = proxyConfigKey();
  if (!force && key === lastProbedKey) return;
  lastProbedKey = key;
  probeHealth();
}

function probeHealth() {
  if (healthProbing) {
    healthPending = true;
    return;
  }
  const active = findProxyById(data.proxies, data.activeProxyId);

  if (!data.extensionEnabled) {
    health.state = 'off';
    updateConnectionBar();
    return;
  }

  if (!isProxyConfigured(active)) {
    health.state = 'empty';
    updateConnectionBar();
    return;
  }

  if (healthTimer) clearTimeout(healthTimer);
  healthProbing = true;
  health.state = 'checking';
  health.message = '';
  updateConnectionBar();

  healthTimer = setTimeout(() => {
    if (!healthProbing) return;
    healthProbing = false;
    health.state = 'error';
    health.message = 'Прокси не ответил за 15 секунд';
    updateConnectionBar();
  }, 16000);

  chrome.runtime.sendMessage({ action: 'probeActiveProxy' }, (response) => {
    const error = chrome.runtime.lastError;
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    healthProbing = false;

    if (error || !response) {
      health.state = 'error';
      health.message = 'Фоновый процесс расширения не ответил';
    } else if (response.success) {
      health.state = 'online';
      health.ip = response.ip;
      health.latencyMs = response.latencyMs;
      health.checkedAt = Date.now();
    } else {
      health.state = 'error';
      health.message = response.message || 'Прокси не отвечает';
    }
    updateConnectionBar();

    if (healthPending) {
      healthPending = false;
      probeHealth();
    }
  });
}

// ============= ОБЗОР =============

function renderOverview() {
  const activeProxy = findProxyById(data.proxies, data.activeProxyId);

  $('dashServerCount').textContent = String(data.proxies.length);
  $('dashRulesCount').textContent = String(data.proxyList.length + data.directList.length);
  $('navRulesBadge').textContent = String(data.proxyList.length + data.directList.length);
  $('dashMode').textContent = data.autoProxyEnabled ? 'Авто' : 'Список';

  const container = $('overviewServers');
  if (data.proxies.length === 0) {
    container.innerHTML = '<div class="empty-state">Нет серверов. Добавьте первый прокси, чтобы включить маршрутизацию.</div>';
  } else {
    container.innerHTML = data.proxies.map(proxy => {
      const isActive = sameProxyId(proxy.id, data.activeProxyId);
      const configured = isProxyConfigured(proxy);
      const reserve = configured && !isActive;
      return `<div class="overview-server${isActive ? ' is-active' : ''}">
        <span class="server-dot ${isActive && configured ? 'online' : 'offline'}" aria-hidden="true"></span>
        <div class="overview-server__info">
          <div class="overview-server__name">${escapeHtml(proxy.name || 'Без имени')}</div>
          <div class="overview-server__meta">${escapeHtml(proxy.host || '—')}:${escapeHtml(proxy.port || '—')}, ${escapeHtml(displayProxyType(proxy.type))}${configured ? '' : ', не настроен'}</div>
        </div>
        ${isActive ? '<span class="active-pill">Активен</span>' : reserve ? '<span class="reserve-pill">Резерв</span>' : ''}
      </div>`;
    }).join('');
  }

  chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (!response || !response.stats) return;
    const stats = response.stats;
    const total = (stats.proxy || 0) + (stats.direct || 0);
    $('ovStatTotal').textContent = String(total);
    $('ovStatProxy').textContent = String(stats.proxy || 0);
    $('ovStatDirect').textContent = String(stats.direct || 0);

    const domains = stats.domains || {};
    const entries = Object.entries(domains)
      .map(([domain, counts]) => [domain, counts, (counts.proxy || 0) + (counts.direct || 0)])
      .sort((a, b) => b[2] - a[2])
      .slice(0, 20);

    const topEl = $('ovTopDomains');
    if (entries.length === 0) {
      topEl.innerHTML = '<div class="logs-empty">Пока нет данных</div>';
    } else {
      topEl.innerHTML = entries.map(([domain, counts], index) => `<div class="domain-row">
        <span class="domain-rank">${index + 1}</span>
        <span class="domain-name">${escapeHtml(domain)}</span>
        <span class="domain-counts"><span class="domain-proxy">${counts.proxy || 0}</span> / <span class="domain-direct">${counts.direct || 0}</span></span>
      </div>`).join('');
    }
  });
}

$('dashToggle').addEventListener('click', () => {
  chrome.storage.local.set({ extensionEnabled: !data.extensionEnabled }, () => {
    data.extensionEnabled = !data.extensionEnabled;
    renderAll();
    probeHealth();
  });
});
$('dashChangeBtn').addEventListener('click', () => navigateTo('servers'));
$('overviewAddServer').addEventListener('click', () => {
  navigateTo('servers');
  $('serversAddBtn').click();
});
$('dashTestActiveBtn').addEventListener('click', probeHealth);

// ============= СЕРВЕРЫ =============

function renderTestResult(result) {
  if (!result) return '<span class="server-test">—</span>';
  if (result.state === 'checking') return '<span class="server-test">Проверка…</span>';
  if (result.state === 'success') {
    return `<span class="server-test is-good">IP ${escapeHtml(result.ip)}<span class="server-test__detail">, ${Math.round(result.latencyMs || 0)} мс</span></span>`;
  }
  return `<span class="server-test is-error">Ошибка<span class="server-test__detail">${escapeHtml(result.message || 'Прокси недоступен')}</span></span>`;
}

function renderServers() {
  const tbody = $('serversTableBody');
  if (!tbody) return;

  if (data.proxies.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="logs-empty">Нет серверов</td></tr>';
    return;
  }

  tbody.innerHTML = data.proxies.map(proxy => {
    const id = String(proxy.id);
    const isActive = sameProxyId(proxy.id, data.activeProxyId);
    const hostValid = !proxy.host || String(proxy.host).trim() === '' || isValidProxyHost(proxy.host);
    const portValid = !proxy.port || isValidPort(proxy.port);
    const socksWarning = isSocksProxyType(proxy.type) && (String(proxy.username || '').trim() || String(proxy.password || '').trim());
    const type = normalizeProxyType(proxy.type) || 'SOCKS5';
    const typeValue = type === 'PROXY' ? 'PROXY' : type;

    return `<tr data-proxy-id="${escapeHtml(id)}">
      <td>
        <span class="server-status">
          <span class="server-dot ${isActive ? 'online' : 'offline'}" aria-hidden="true" title="${isActive ? 'Активный прокси' : 'Резервный прокси'}"></span>
          <input type="text" class="proxy-item__field" value="${escapeHtml(proxy.name || '')}" data-id="${escapeHtml(id)}" data-field="name" placeholder="Название" aria-label="Название сервера" style="max-width:140px;">
        </span>
      </td>
      <td><input type="text" class="proxy-item__field ${hostValid ? '' : 'invalid'}" value="${escapeHtml(proxy.host || '')}" data-id="${escapeHtml(id)}" data-field="host" placeholder="IP или hostname" aria-label="Хост прокси" aria-invalid="${hostValid ? 'false' : 'true'}"></td>
      <td><input type="number" class="proxy-item__field ${portValid ? '' : 'invalid'}" value="${escapeHtml(proxy.port || '')}" data-id="${escapeHtml(id)}" data-field="port" placeholder="Порт" aria-label="Порт прокси" aria-invalid="${portValid ? 'false' : 'true'}" min="1" max="65535" style="max-width:82px;"></td>
      <td>
        <select class="proxy-item__field" data-id="${escapeHtml(id)}" data-field="type" aria-label="Тип прокси" style="min-width:96px;">
          <option value="SOCKS5" ${typeValue === 'SOCKS5' ? 'selected' : ''}>SOCKS5</option>
          <option value="SOCKS" ${typeValue === 'SOCKS' ? 'selected' : ''}>SOCKS4</option>
          <option value="PROXY" ${typeValue === 'PROXY' ? 'selected' : ''}>HTTP</option>
          <option value="HTTPS" ${typeValue === 'HTTPS' ? 'selected' : ''}>HTTPS</option>
        </select>
      </td>
      <td>
        <input type="text" class="proxy-item__field" value="${escapeHtml(proxy.username || '')}" data-id="${escapeHtml(id)}" data-field="username" placeholder="Логин" aria-label="Логин прокси" autocomplete="off" style="max-width:110px;margin-bottom:4px;">
        <input type="password" class="proxy-item__field" value="${escapeHtml(proxy.password || '')}" data-id="${escapeHtml(id)}" data-field="password" placeholder="Пароль" aria-label="Пароль прокси" autocomplete="new-password" style="max-width:110px;">
        ${socksWarning ? '<span class="inline-warning">Chrome не умеет авторизоваться на SOCKS — используйте IP-привязку или HTTP(S)</span>' : ''}
      </td>
      <td class="server-test-cell" data-test-id="${escapeHtml(id)}" aria-live="polite">${renderTestResult(testResults.get(id))}</td>
      <td>
        <div class="server-actions">
          <button class="server-btn" type="button" title="Проверить прокси" aria-label="Проверить ${escapeHtml(proxy.name || proxy.host || 'прокси')}" data-id="${escapeHtml(id)}" data-action="test">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </button>
          <button class="server-btn ${isActive ? 'connected' : ''}" type="button" title="${isActive ? 'Активен' : 'Выбрать активным'}" aria-label="${isActive ? 'Активный прокси' : 'Выбрать активным'}" data-id="${escapeHtml(id)}" data-action="select">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </button>
          <button class="server-btn is-danger" type="button" title="Удалить" aria-label="Удалить ${escapeHtml(proxy.name || proxy.host || 'прокси')}" data-id="${escapeHtml(id)}" data-action="delete">
            <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  setupServerHandlers();
}

function updateServerTestCell(proxyId) {
  const cell = document.querySelector(`.server-test-cell[data-test-id="${CSS.escape(String(proxyId))}"]`);
  if (cell) cell.innerHTML = renderTestResult(testResults.get(String(proxyId)));
}

function runServerTest(proxyId, button) {
  const id = String(proxyId);
  if (testResults.get(id) && testResults.get(id).state === 'checking') return;

  testResults.set(id, { state: 'checking' });
  updateServerTestCell(id);
  if (button) button.disabled = true;

  const timer = setTimeout(() => {
    if (!testResults.get(id) || testResults.get(id).state !== 'checking') return;
    testResults.set(id, { state: 'error', message: 'Таймаут проверки' });
    updateServerTestCell(id);
    if (button) button.disabled = false;
  }, 16000);

  chrome.runtime.sendMessage({ action: 'testProxy', proxyId }, (response) => {
    clearTimeout(timer);
    const error = chrome.runtime.lastError;
    if (error || !response) {
      testResults.set(id, { state: 'error', message: 'Фоновый процесс не ответил' });
    } else if (response.success) {
      testResults.set(id, { state: 'success', ip: response.ip, latencyMs: response.latencyMs });
    } else {
      testResults.set(id, { state: 'error', message: response.message || 'Прокси недоступен' });
    }

    updateServerTestCell(id);
    if (button) button.disabled = false;

    if (sameProxyId(proxyId, data.activeProxyId)) probeHealth();
  });
}

function setupServerHandlers() {
  const tbody = $('serversTableBody');
  if (!tbody || tbody.dataset.handlersReady === '1') return;
  tbody.dataset.handlersReady = '1';

  tbody.addEventListener('change', (event) => {
    const target = event.target;
    const field = target.dataset.field;
    if (!field) return;
    const id = parseProxyId(target.dataset.id);
    const proxy = findProxyById(data.proxies, id);
    if (!proxy) return;

    let value = target.value;
    if (field === 'port') {
      value = String(value).trim() === '' ? '' : parseInt(value, 10);
      if (value !== '' && !isValidPort(value)) {
        target.classList.add('invalid');
        target.setAttribute('aria-invalid', 'true');
        showToast('Порт должен быть от 1 до 65535', 'error');
        return;
      }
    }
    if (field === 'host') {
      value = String(value).trim();
      if (value !== '' && !isValidProxyHost(value)) {
        target.classList.add('invalid');
        target.setAttribute('aria-invalid', 'true');
        showToast('Укажите IP или корректный hostname', 'error');
        return;
      }
    }

    chrome.storage.local.get(['proxies'], (result) => {
      const proxies = Array.isArray(result.proxies) ? result.proxies : [];
      const updated = proxies.map(item => sameProxyId(item.id, id) ? { ...item, [field]: value } : item);
      testResults.delete(String(id));
      updateServerTestCell(id);
      chrome.storage.local.set({ proxies: updated }, () => loadData());
    });
  });

  tbody.addEventListener('input', (event) => {
    const target = event.target;
    const field = target.dataset.field;
    if (field === 'host') {
      const invalid = target.value.trim() !== '' && !isValidProxyHost(target.value);
      target.classList.toggle('invalid', invalid);
      target.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    } else if (field === 'port') {
      const invalid = target.value !== '' && !isValidPort(target.value);
      target.classList.toggle('invalid', invalid);
      target.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    }
  });

  tbody.addEventListener('click', (event) => {
    const button = event.target.closest('.server-btn');
    if (!button) return;
    const id = parseProxyId(button.dataset.id);
    const action = button.dataset.action;

    if (action === 'select') {
      chrome.storage.local.set({ activeProxyId: id }, () => {
        loadData(() => probeHealth());
      });
      return;
    }

    if (action === 'delete') {
      const proxy = findProxyById(data.proxies, id);
      if (!proxy) return;
      if (!confirm(`Удалить прокси «${proxy.name || proxy.host || 'без имени'}»?`)) return;
      if (data.proxies.length <= 1) {
        showToast('Нельзя удалить последний прокси', 'error');
        return;
      }

      chrome.storage.local.get(['proxies', 'activeProxyId'], (result) => {
        const proxies = (Array.isArray(result.proxies) ? result.proxies : []).filter(p => !sameProxyId(p.id, id));
        const updates = { proxies };
        if (sameProxyId(result.activeProxyId, id)) {
          const next = proxies.filter(isProxyConfigured)[0] || proxies[0];
          updates.activeProxyId = next ? next.id : null;
        }
        chrome.storage.local.set(updates, () => loadData());
      });
      return;
    }

    if (action === 'test') {
      runServerTest(id, button);
    }
  });
}

$('serversAddBtn').addEventListener('click', () => {
  chrome.storage.local.get(['proxies'], (result) => {
    const proxies = Array.isArray(result.proxies) ? result.proxies : [];
    const id = crypto.randomUUID();
    proxies.push({
      id,
      name: `Прокси ${proxies.length + 1}`,
      host: '',
      port: '',
      type: 'SOCKS5',
      enabled: true,
      username: '',
      password: ''
    });
    chrome.storage.local.set({ proxies }, () => {
      loadData(() => {
        const input = document.querySelector(`#serversTableBody input[data-id="${CSS.escape(id)}"][data-field="host"]`);
        if (input) input.focus();
      });
    });
  });
});

// ============= ЛОГИ =============

function parseLogs(logsStr) {
  if (!logsStr) return [];
  return logsStr.trim().split('\n').reverse().reduce((acc, line) => {
    if (!line.trim()) return acc;
    const match = line.match(/\[(.*?)\]\s+(\w+):\s+(\w+)\s+-\s+(.*?)\s+->\s+(.*?)(?:\s+\(matched:\s+(.*?)\))?$/);
    if (match) {
      acc.push({ time: match[1], category: match[2], type: match[3], domain: match[4], route: match[5], rule: match[6] || '' });
    } else {
      const common = line.match(/\[(.*?)\]\s+(\w+):\s+(.*?)\s+-\s+(.*)$/);
      if (common) {
        acc.push({ time: common[1], category: common[2], type: common[3].toUpperCase(), domain: '', route: common[4], rule: '' });
      }
    }
    return acc;
  }, []);
}

function applyLogFilter(logs) {
  const filter = $('activityFilter') ? $('activityFilter').value : 'all';
  if (filter === 'all') return logs;
  return logs.filter(log => {
    if (filter === 'PROXY' || filter === 'DIRECT') return log.type === filter;
    return log.category === filter;
  });
}

function logLabel(log) {
  if (/^PROXY TEST/.test(log.type)) return 'Тест';
  if (log.category === 'ERROR') return 'Ошибка';
  if (log.category === 'CONFIG') return 'Конфиг';
  if (log.category === 'AUTO') return 'Авто';
  return log.type;
}

function renderActivityList(container, limit) {
  chrome.storage.local.get(['routeLogs'], (result) => {
    const logs = applyLogFilter(parseLogs(result.routeLogs));
    const filtered = typeof limit === 'number' ? logs.slice(0, limit) : logs;

    if (filtered.length === 0) {
      container.innerHTML = '<div class="logs-empty">Нет событий</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach(log => {
      const item = document.createElement('div');
      item.className = 'activity-item';

      const icon = document.createElement('span');
      icon.className = 'activity-icon ' + (
        log.type === 'PROXY' ? 'proxy'
          : log.category === 'CONFIG' ? 'config'
            : log.category === 'ERROR' ? 'error'
              : log.category === 'AUTO' ? 'auto'
                : 'direct'
      );
      icon.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'activity-text';
      const label = logLabel(log);
      if (log.domain) {
        text.textContent = `${label}: ${log.domain}`;
        if (log.rule) text.textContent += ` (правило: ${log.rule})`;
        if (log.route) text.title = log.route;
      } else {
        text.textContent = `${label}: ${log.route}`;
      }

      const time = document.createElement('span');
      time.className = 'activity-time';
      time.textContent = log.time;

      item.appendChild(icon);
      item.appendChild(text);
      item.appendChild(time);
      fragment.appendChild(item);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
  });
}

function renderActivity() {
  renderActivityList($('activityFull'), 300);
}

$('activityFilter').addEventListener('change', renderActivity);
$('clearLogsBtn').addEventListener('click', () => {
  if (!confirm('Очистить все логи?')) return;
  chrome.storage.local.set({ routeLogs: '' }, () => {
    renderActivity();
    showToast('Логи очищены', 'success');
  });
});
$('exportLogsBtn').addEventListener('click', () => {
  chrome.storage.local.get(['routeLogs'], (result) => {
    const logs = result.routeLogs || '';
    if (!logs.trim()) {
      showToast('Логи пусты', 'info');
      return;
    }
    const now = new Date();
    const filename = `proxy-logs-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.txt`;
    const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// ============= ПРАВИЛА =============

function renderRules() {
  const proxyContainer = $('proxyRuleList');
  const directContainer = $('directRuleList');
  setupRuleListHandlers(proxyContainer, loadData);
  setupRuleListHandlers(directContainer, loadData);
  renderSiteList(data.proxyList, proxyContainer, 'proxyList', $('proxyRuleSearch'), $('proxyRuleCount'));
  renderSiteList(data.directList, directContainer, 'directList', $('directRuleSearch'), $('directRuleCount'));
}

function addRule(inputId, listKey) {
  const input = $(inputId);
  if (!input) return;
  addToList(input.value, listKey, (result) => {
    if (!result.ok) {
      showToast(result.message || 'Не удалось добавить правило', 'error');
      return;
    }
    input.value = '';
    loadData();
    input.focus();
    showToast(result.moved ? `Перемещено: ${result.value}` : `Добавлено: ${result.value}`, 'success');
  });
}

$('addProxyRuleBtn').addEventListener('click', () => addRule('proxyRuleInput', 'proxyList'));
$('addDirectRuleBtn').addEventListener('click', () => addRule('directRuleInput', 'directList'));
$('proxyRuleInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addRule('proxyRuleInput', 'proxyList');
});
$('directRuleInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addRule('directRuleInput', 'directList');
});
$('proxyRuleSearch').addEventListener('input', renderRules);
$('directRuleSearch').addEventListener('input', renderRules);

// ============= НАСТРОЙКИ =============

let settingsData = {
  extensionEnabled: true,
  autoProxyEnabled: true,
  autoProxyTimeoutEnabled: false,
  autoProxyTimeout: 5,
  autoAddRelated: false,
  webrtcProtectionEnabled: false,
  killSwitchEnabled: false
};

function updateKillSwitchWarning() {
  const warning = $('killSwitchWarning');
  if (!warning) return;
  const configured = data.proxies.filter(isProxyConfigured).length;
  warning.hidden = !(settingsData.killSwitchEnabled && configured === 0);
}

function updateSettingsSummary() {
  const proxyState = $('settingsProxyState');
  const serverState = $('settingsServerState');
  const modeState = $('settingsModeState');
  const rulesState = $('settingsRulesState');
  const active = findProxyById(data.proxies, data.activeProxyId);

  if (proxyState) {
    proxyState.textContent = data.extensionEnabled ? 'Включён' : 'Выключен';
    proxyState.className = 'settings-summary__value ' + (data.extensionEnabled ? 'is-on' : 'is-off');
  }
  if (serverState) {
    serverState.textContent = active
      ? (active.name || `${active.host}:${active.port}`)
      : '—';
  }
  if (modeState) modeState.textContent = data.autoProxyEnabled ? 'Авто' : 'Ручной';
  if (rulesState) rulesState.textContent = String(data.proxyList.length + data.directList.length);
}

function updateTimeoutControls() {
  const input = $('dashTimeoutInput');
  const output = $('dashTimeoutValue');
  const row = $('timeoutRow');
  if (!input) return;

  input.disabled = !settingsData.autoProxyTimeoutEnabled;
  if (row) row.classList.toggle('is-disabled', !settingsData.autoProxyTimeoutEnabled);
  if (output) output.textContent = `${settingsData.autoProxyTimeout} с`;
}

function saveSettingsData() {
  let timeout = parseInt(settingsData.autoProxyTimeout, 10) || 5;
  timeout = Math.min(30, Math.max(2, timeout));
  settingsData.autoProxyTimeout = timeout;

  chrome.storage.local.set({
    extensionEnabled: settingsData.extensionEnabled,
    autoProxyEnabled: settingsData.autoProxyEnabled,
    autoProxyTimeoutEnabled: settingsData.autoProxyTimeoutEnabled,
    autoProxyTimeout: timeout,
    autoAddRelated: settingsData.autoAddRelated,
    webrtcProtectionEnabled: settingsData.webrtcProtectionEnabled,
    killSwitchEnabled: settingsData.killSwitchEnabled
  });

  chrome.runtime.sendMessage({ action: 'setWebrtcPolicy', enabled: settingsData.webrtcProtectionEnabled }, () => {
    void chrome.runtime.lastError;
  });

  data.extensionEnabled = settingsData.extensionEnabled;
  data.autoProxyEnabled = settingsData.autoProxyEnabled;
  data.killSwitchEnabled = settingsData.killSwitchEnabled;
  updateKillSwitchWarning();
  updateTimeoutControls();
  updateSettingsSummary();
  renderOverview();
  updateConnectionBar();
}

function initSettingsPage() {
  chrome.storage.local.get(
    ['extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled', 'autoProxyTimeout',
      'autoAddRelated', 'webrtcProtectionEnabled', 'killSwitchEnabled'],
    (result) => {
      settingsData.extensionEnabled = result.extensionEnabled !== false;
      settingsData.autoProxyEnabled = result.autoProxyEnabled !== false;
      settingsData.autoProxyTimeoutEnabled = result.autoProxyTimeoutEnabled === true;
      settingsData.autoProxyTimeout = Math.min(30, Math.max(2, parseInt(result.autoProxyTimeout, 10) || 5));
      settingsData.autoAddRelated = result.autoAddRelated === true;
      settingsData.webrtcProtectionEnabled = result.webrtcProtectionEnabled === true;
      settingsData.killSwitchEnabled = result.killSwitchEnabled === true;

      document.querySelectorAll('#page-settings .toggle-switch[data-key]').forEach(sw => {
        const key = sw.dataset.key;
        sw.classList.toggle('on', settingsData[key] === true);
        sw.setAttribute('aria-checked', settingsData[key] === true ? 'true' : 'false');
        sw.onclick = () => {
          settingsData[key] = !settingsData[key];
          sw.classList.toggle('on', settingsData[key]);
          sw.setAttribute('aria-checked', settingsData[key] ? 'true' : 'false');
          if (key === 'autoProxyTimeoutEnabled') updateTimeoutControls();
          saveSettingsData();
        };
      });

      const timeoutInput = $('dashTimeoutInput');
      if (timeoutInput) {
        timeoutInput.value = String(settingsData.autoProxyTimeout);
        timeoutInput.oninput = () => {
          settingsData.autoProxyTimeout = Math.min(30, Math.max(2, parseInt(timeoutInput.value, 10) || 5));
          updateTimeoutControls();
        };
        timeoutInput.onchange = saveSettingsData;
      }

      $('dashAboutVersion').textContent = chrome.runtime.getManifest().version;
      updateTimeoutControls();
      updateKillSwitchWarning();
      updateSettingsSummary();
    }
  );
}

// ============= ЭКСПОРТ / ИМПОРТ =============

$('dashExportBtn').addEventListener('click', () => {
  chrome.storage.local.get([
    'proxyList', 'directList', 'proxies', 'activeProxyId',
    'extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled',
    'autoProxyTimeout', 'autoAddRelated', 'webrtcProtectionEnabled',
    'killSwitchEnabled'
  ], (result) => {
    const config = {
      version: '1.2',
      exportDate: new Date().toISOString(),
      proxyList: result.proxyList || [],
      directList: result.directList || [],
      proxies: result.proxies || [],
      activeProxyId: result.activeProxyId || null,
      extensionEnabled: result.extensionEnabled !== false,
      autoProxyEnabled: result.autoProxyEnabled !== false,
      autoProxyTimeoutEnabled: result.autoProxyTimeoutEnabled === true,
      autoProxyTimeout: result.autoProxyTimeout || 5,
      autoAddRelated: result.autoAddRelated === true,
      webrtcProtectionEnabled: result.webrtcProtectionEnabled === true,
      killSwitchEnabled: result.killSwitchEnabled === true
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxy-config-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

$('dashImportBtn').addEventListener('click', () => {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.onchange = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      try {
        const config = JSON.parse(String(loadEvent.target.result));
        if (!Array.isArray(config.proxyList) && !Array.isArray(config.directList) && !Array.isArray(config.proxies)) {
          throw new Error('Неверный формат файла');
        }
        const updates = {};
        const arrayKeys = ['proxyList', 'directList', 'proxies'];
        arrayKeys.forEach(key => {
          if (Array.isArray(config[key])) updates[key] = config[key].filter(item => item && typeof item === 'object');
        });
        const scalarKeys = [
          'extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled',
          'autoProxyTimeout', 'autoAddRelated', 'webrtcProtectionEnabled', 'killSwitchEnabled'
        ];
        scalarKeys.forEach(key => {
          if (config[key] !== undefined) updates[key] = config[key];
        });
        if (config.activeProxyId !== undefined) updates.activeProxyId = config.activeProxyId;
        if (Array.isArray(updates.proxies) && updates.proxies.length > 0 && !updates.activeProxyId) {
          updates.activeProxyId = updates.proxies[0].id;
        }
        chrome.storage.local.set(updates, () => {
          loadData();
          showToast('Конфигурация импортирована', 'success');
        });
      } catch (error) {
        showToast('Ошибка импорта: ' + (error.message || error), 'error');
      }
    };
    reader.readAsText(file);
  };
  fileInput.click();
});

$('dashResetStatsBtn').addEventListener('click', () => {
  if (!confirm('Сбросить статистику запросов и топ доменов?')) return;
  chrome.runtime.sendMessage({ action: 'resetStats' }, () => {
    if (chrome.runtime.lastError) {
      showToast('Не удалось сбросить статистику', 'error');
      return;
    }
    showToast('Статистика сброшена', 'success');
    loadData();
  });
});

// ============= ЖИВОЕ ОБНОВЛЕНИЕ =============

const scheduleReload = debounce(() => {
  const active = document.activeElement;
  if (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
  loadData();
}, 250);

chrome.storage.onChanged.addListener((changes) => {
  const relevant = ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled'];
  if (relevant.some(key => changes[key])) scheduleReload();
});

// ============= СТАРТ =============

loadData(() => {
  const initialPage = location.hash.replace('#', '');
  if (['overview', 'servers', 'activity', 'rules', 'settings'].includes(initialPage)) {
    navigateTo(initialPage);
  }
});
