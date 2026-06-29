// ============= DASHBOARD — КЭШ =============

const IP_SERVICES = [
  'https://api.ipify.org?format=json',
  'https://api64.ipify.org?format=json',
  'https://httpbin.org/ip'
];

function fetchWithFallback(services, index = 0) {
  if (index >= services.length) return Promise.reject(new Error('All IP services failed'));
  return fetch(services[index], { signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(data => data.ip || data.origin || (data.error ? Promise.reject(new Error(data.error)) : null))
    .then(ip => ip || Promise.reject(new Error('No IP in response')))
    .catch(err => fetchWithFallback(services, index + 1));
}

let data = {
  proxyList: [], directList: [], proxies: [],
  activeProxyId: null, extensionEnabled: true, autoProxyEnabled: true
};

// ============= ЗАГРУЗКА ДАННЫХ =============

function loadData(cb) {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled'], (d) => {
    data.proxyList = d.proxyList || [];
    data.directList = d.directList || [];
    data.proxies = d.proxies || [];
    data.activeProxyId = d.activeProxyId;
    data.extensionEnabled = d.extensionEnabled !== false;
    data.autoProxyEnabled = d.autoProxyEnabled !== false;
    renderAll();
    if (cb) cb();
  });
}

function renderAll() {
  renderOverview();
  renderServers();
  renderActivity();
  renderRules();
  updateConnectionBar();
}

// ============= НАВИГАЦИЯ =============

let currentPage = 'overview';

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page-content').forEach(p => p.style.display = 'none');
  const target = document.getElementById('page-' + page);
  if (target) target.style.display = '';

  document.querySelectorAll('.nav-item[data-page]').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });

  if (page === 'settings') initSettingsPage();
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(item.dataset.page);
  });
});

// ============= ОБЗОР =============

function renderOverview() {
  const activeProxy = findProxyById(data.proxies, data.activeProxyId);

  document.getElementById('dashServerCount').textContent = data.proxies.length;
  document.getElementById('dashRulesCount').textContent = data.proxyList.length + data.directList.length;
  document.getElementById('navRulesBadge').textContent = data.proxyList.length + data.directList.length;

  const overviewServers = document.getElementById('overviewServers');
  if (data.proxies.length === 0) {
    overviewServers.innerHTML = '<div class="empty-state">Нет серверов. Добавьте прокси-сервер.</div>';
  } else {
    let html = '<div style="display:flex;flex-direction:column;gap:30px;">';
    data.proxies.forEach(proxy => {
      const isActive = sameProxyId(proxy.id, data.activeProxyId);
      html += `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);${isActive ? 'border-color:var(--accent);' : ''}">
          <span class="server-dot ${isActive ? 'online' : 'offline'}"></span>
          <div style="flex:1;">
            <div style="font:500 var(--text-sm)/1.3 var(--font-body);">${proxy.name || 'Без имени'}</div>
            <div style="font:400 var(--text-xs)/1 var(--font-mono);color:var(--muted);">${proxy.host}:${proxy.port} · ${proxy.type}</div>
          </div>
          ${isActive ? '<span style="font:500 10px/1 var(--font-body);color:var(--accent);background:color-mix(in oklab,var(--accent),transparent 90%);padding:3px 8px;border-radius:4px;letter-spacing:0.06em;text-transform:uppercase;">Активен</span>' : ''}
        </div>`;
    });
    html += '</div>';
    overviewServers.innerHTML = html;
  }

  chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
    if (!response || !response.stats) return;
    const s = response.stats;
    const total = (s.proxy || 0) + (s.direct || 0);
    document.getElementById('ovStatTotal').textContent = total;
    document.getElementById('ovStatProxy').textContent = s.proxy || 0;
    document.getElementById('ovStatDirect').textContent = s.direct || 0;

    const domains = s.domains || {};
    const entries = Object.entries(domains).sort((a, b) => (b[1].proxy + b[1].direct) - (a[1].proxy + a[1].direct)).slice(0, 20);
    const topEl = document.getElementById('ovTopDomains');
    if (entries.length === 0) {
      topEl.innerHTML = '<div class="logs-empty">Нет данных</div>';
    } else {
      topEl.innerHTML = entries.map(([domain, counts], i) => `<div class="domain-row">
        <span class="domain-rank">${i + 1}</span>
        <span class="domain-name">${domain}</span>
        <span class="domain-counts"><span class="domain-proxy">${counts.proxy || 0}</span> / <span class="domain-direct">${counts.direct || 0}</span></span>
      </div>`).join('');
    }
  });
}

function updateConnectionBar() {
  const toggle = document.getElementById('dashToggle');
  const statusText = document.getElementById('dashStatus');
  const metaText = document.getElementById('dashMeta');
  const activeProxy = findProxyById(data.proxies, data.activeProxyId);

  toggle.classList.toggle('on', data.extensionEnabled);
  if (data.extensionEnabled) {
    statusText.textContent = activeProxy ? `Подключено к ${activeProxy.name}` : 'Подключено';
    statusText.classList.remove('off');
    metaText.textContent = activeProxy ? `${activeProxy.host}:${activeProxy.port} · ${activeProxy.type}` : '—';
  } else {
    statusText.textContent = 'Отключено';
    statusText.classList.add('off');
    metaText.textContent = '—';
  }
}

document.getElementById('dashToggle').addEventListener('click', () => {
  chrome.storage.local.set({ extensionEnabled: !data.extensionEnabled }, () => loadData());
});

document.getElementById('dashChangeBtn').addEventListener('click', () => navigateTo('servers'));
document.getElementById('overviewAddServer').addEventListener('click', () => navigateTo('servers'));

// ============= СЕРВЕРЫ =============

function renderServers() {
  const tbody = document.getElementById('serversTableBody');
  if (data.proxies.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="logs-empty">Нет серверов</td></tr>';
    return;
  }

  const fragment = document.createDocumentFragment();
  data.proxies.forEach(proxy => {
    const isActive = sameProxyId(proxy.id, data.activeProxyId);
    const isHostValid = !proxy.host || proxy.host.trim() === '' || isValidProxyHost(proxy.host);
    const isPortValid = !proxy.port || isValidPort(proxy.port);
    const proxyId = String(proxy.id);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <span class="server-status">
          <span class="server-dot ${isActive ? 'online' : 'offline'}"></span>
          <input type="text" class="proxy-item__field" value="${proxy.name || ''}" data-id="${proxyId}" data-field="name" placeholder="Название" style="max-width:140px;">
        </span>
      </td>
      <td><input type="text" class="proxy-item__field ${isHostValid ? '' : 'invalid'}" value="${proxy.host || ''}" data-id="${proxyId}" data-field="host" placeholder="IP или hostname"></td>
      <td><input type="number" class="proxy-item__field ${isPortValid ? '' : 'invalid'}" value="${proxy.port || ''}" data-id="${proxyId}" data-field="port" placeholder="Порт" min="1" max="65535" style="max-width:80px;"></td>
      <td>
        <select class="proxy-item__field" data-id="${proxyId}" data-field="type" style="min-width:90px;">
          <option value="SOCKS5" ${proxy.type === 'SOCKS5' ? 'selected' : ''}>SOCKS5</option>
          <option value="SOCKS" ${proxy.type === 'SOCKS' ? 'selected' : ''}>SOCKS4</option>
          <option value="PROXY" ${proxy.type === 'PROXY' ? 'selected' : ''}>HTTP</option>
          <option value="HTTPS" ${proxy.type === 'HTTPS' ? 'selected' : ''}>HTTPS</option>
        </select>
      </td>
      <td>
        <span style="font:400 var(--text-xs)/1 var(--font-mono);color:var(--muted);">
          <input type="text" class="proxy-item__field" value="${proxy.username || ''}" data-id="${proxyId}" data-field="username" placeholder="Логин" style="max-width:100px;margin-bottom:4px;">
          <input type="password" class="proxy-item__field" value="${proxy.password || ''}" data-id="${proxyId}" data-field="password" placeholder="Пароль" style="max-width:100px;">
        </span>
      </td>
      <td>
        <div class="server-actions">
          <button class="server-btn" title="Тест IP" data-id="${proxyId}" data-action="test">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </button>
          <button class="server-btn ${isActive ? 'connected' : ''}" title="${isActive ? 'Активен' : 'Выбрать'}" data-id="${proxyId}" data-action="select">
            <svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </button>
          <button class="server-btn is-danger" title="Удалить" data-id="${proxyId}" data-action="delete">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    `;
    fragment.appendChild(row);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);
  setupServerHandlers();
}

function setupServerHandlers() {
  const tbody = document.getElementById('serversTableBody');
  if (tbody.dataset.handlersReady === '1') return;
  tbody.dataset.handlersReady = '1';

  tbody.addEventListener('change', (e) => {
    const target = e.target;
    const field = target.dataset.field;
    if (!field) return;
    const id = parseProxyId(target.dataset.id);

    const val = field === 'port' ? parseInt(target.value, 10) : target.value;
    if (field === 'host' && val && val.trim() && !isValidProxyHost(val)) { loadData(); return; }
    if (field === 'port' && !isValidPort(val)) { loadData(); return; }

    chrome.storage.local.get(['proxies'], (d) => {
      const proxies = d.proxies.map(p => sameProxyId(p.id, id) ? { ...p, [field]: val } : p);
      chrome.storage.local.set({ proxies }, () => loadData());
    });
  });

  tbody.addEventListener('input', (e) => {
    const target = e.target;
    const field = target.dataset.field;
    if (field === 'host') {
      target.classList.toggle('invalid', target.value.trim() !== '' && !isValidProxyHost(target.value));
    } else if (field === 'port') {
      target.classList.toggle('invalid', target.value !== '' && !isValidPort(target.value));
    }
  });

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.server-btn');
    if (!btn) return;
    const id = parseProxyId(btn.dataset.id);
    const action = btn.dataset.action;
    if (action === 'select') {
      chrome.storage.local.set({ activeProxyId: id }, () => loadData());
    } else if (action === 'delete') {
      chrome.storage.local.get(['proxies', 'activeProxyId'], (d) => {
        if (d.proxies.length <= 1) { alert('Нельзя удалить последний прокси.'); return; }
        const proxy = findProxyById(d.proxies, id);
        if (!proxy || !confirm(`Удалить прокси "${proxy.name}"?`)) return;
        const proxies = d.proxies.filter(p => !sameProxyId(p.id, id));
        const updates = { proxies };
        if (sameProxyId(d.activeProxyId, id)) updates.activeProxyId = proxies[0].id;
        chrome.storage.local.set(updates, () => loadData());
      });
    } else if (action === 'test') {
      btn.disabled = true;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
      chrome.runtime.sendMessage({ action: 'testSpecificProxy', proxyId: id }, (response) => {
        btn.disabled = false;
        const row = btn.closest('tr');
        if (response?.ready) {
          setTimeout(() => {
            fetchWithFallback(IP_SERVICES, 0)
              .then(ip => {
                chrome.runtime.sendMessage({ action: 'restoreProxySettings' });
                if (row) {
                  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
                  row.querySelector('.server-actions').insertAdjacentHTML('afterend',
                    `<div class="server-test-ip" style="font:500 11px/1 var(--font-mono);color:var(--success);padding:4px 0 0 4px;">IP: ${ip}</div>`);
                }
              })
              .catch(() => {
                chrome.runtime.sendMessage({ action: 'restoreProxySettings' });
                if (row) {
                  btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
                  row.querySelector('.server-actions').insertAdjacentHTML('afterend',
                    `<div class="server-test-ip" style="font:500 11px/1 var(--font-mono);color:var(--danger);padding:4px 0 0 4px;">Ошибка: прокси недоступен</div>`);
                }
              });
          }, 1000);
        } else {
          if (row) {
            row.querySelector('.server-actions').insertAdjacentHTML('afterend',
              `<div class="server-test-ip" style="font:500 11px/1 var(--font-mono);color:var(--danger);padding:4px 0 0 4px;">Ошибка: ${response?.error || 'таймаут'}</div>`);
          }
          btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
        }
        setTimeout(() => { row?.querySelector('.server-test-ip')?.remove(); }, 8000);
      });
    }
  });
}

document.getElementById('serversAddBtn').addEventListener('click', () => {
  chrome.storage.local.get(['proxies'], (d) => {
    const proxies = d.proxies || [];
    proxies.push({
      id: crypto.randomUUID(), name: `Proxy ${proxies.length + 1}`,
      host: '', port: '', type: 'SOCKS5',
      enabled: true, username: '', password: ''
    });
    chrome.storage.local.set({ proxies }, () => loadData());
  });
});

// ============= ЛОГИ =============

function parseLogs(logsStr) {
  if (!logsStr) return [];
  return logsStr.trim().split('\n').reverse().reduce((acc, line) => {
    if (!line.trim()) return acc;
    const m = line.match(/\[(.*?)\]\s+(\w+):\s+(\w+)\s+-\s+(.*?)\s+->\s+(.*?)(?:\s+\(matched:\s+(.*?)\))?$/);
    if (m) {
      acc.push({ time: m[1], category: m[2], type: m[3], domain: m[4], route: m[5], rule: m[6] || '—' });
    } else {
      const cm = line.match(/\[(.*?)\]\s+(\w+):\s+(.*?)\s+-\s+(.*)$/);
      if (cm) acc.push({ time: cm[1], category: cm[2], type: cm[3].toUpperCase(), domain: '—', route: cm[4], rule: '—' });
    }
    return acc;
  }, []);
}

function renderActivityList(container, limit) {
  chrome.storage.local.get(['routeLogs'], (d) => {
    const logs = parseLogs(d.routeLogs);
    const filtered = typeof limit === 'number' ? logs.slice(0, limit) : applyLogFilter(logs);

    if (filtered.length === 0) {
      container.innerHTML = '<div class="logs-empty">Нет событий</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach(log => {
      const item = document.createElement('div');
      item.className = 'activity-item';
      let iconClass = 'direct';
      if (log.type === 'PROXY') iconClass = 'proxy';
      else if (log.category === 'CONFIG') iconClass = 'config';
      else if (log.category === 'ERROR') iconClass = 'error';
      else if (log.category === 'AUTO') iconClass = 'auto';

      item.innerHTML = `<span class="activity-icon ${iconClass}"></span>
        <span class="activity-text">${log.type} — ${log.domain}${log.rule !== '—' ? ' <span style="color:var(--accent);font-style:italic;">' + log.rule + '</span>' : ''}</span>
        <span class="activity-time">${log.time}</span>`;
      fragment.appendChild(item);
    });
    container.innerHTML = '';
    container.appendChild(fragment);
  });
}

function applyLogFilter(logs) {
  const filter = document.getElementById('activityFilter')?.value || 'all';
  if (filter === 'all') return logs;
  return logs.filter(log => {
    if (filter === 'PROXY') return log.type === 'PROXY';
    if (filter === 'DIRECT') return log.type === 'DIRECT';
    if (filter === 'CONFIG') return log.category === 'CONFIG';
    if (filter === 'ERROR') return log.category === 'ERROR';
    return true;
  });
}

function renderActivity() {
  renderActivityList(document.getElementById('activityFull'));
}

// ============= СТАТИСТИКА =============


document.getElementById('activityFilter')?.addEventListener('change', renderActivity);
document.getElementById('clearLogsBtn')?.addEventListener('click', () => {
  if (confirm('Очистить все логи?')) chrome.storage.local.set({ routeLogs: '' }, renderActivity);
});
document.getElementById('exportLogsBtn')?.addEventListener('click', () => {
  chrome.storage.local.get(['routeLogs'], (d) => {
    const logs = d.routeLogs || '';
    if (!logs.trim()) { alert('Логи пусты'); return; }
    const now = new Date();
    const filename = `proxy-logs-${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}.txt`;
    const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  });
});

// ============= ПРАВИЛА =============

function renderRules() {
  const proxyContainer = document.getElementById('proxyRuleList');
  const directContainer = document.getElementById('directRuleList');
  setupRuleListHandlers(proxyContainer, loadData);
  setupRuleListHandlers(directContainer, loadData);
  renderSiteList(data.proxyList, proxyContainer, 'proxyList',
    document.getElementById('proxyRuleSearch'), document.getElementById('proxyRuleCount'));
  renderSiteList(data.directList, directContainer, 'directList',
    document.getElementById('directRuleSearch'), document.getElementById('directRuleCount'));
}

document.getElementById('addProxyRuleBtn')?.addEventListener('click', () => {
  const input = document.getElementById('proxyRuleInput');
  addToList(input.value, 'proxyList', () => { input.value = ''; loadData(); });
});
document.getElementById('proxyRuleInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addProxyRuleBtn').click();
});

document.getElementById('addDirectRuleBtn')?.addEventListener('click', () => {
  const input = document.getElementById('directRuleInput');
  addToList(input.value, 'directList', () => { input.value = ''; loadData(); });
});
document.getElementById('directRuleInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addDirectRuleBtn').click();
});

document.getElementById('proxyRuleSearch')?.addEventListener('input', () => renderRules());
document.getElementById('directRuleSearch')?.addEventListener('input', () => renderRules());

// ============= СТРАНИЦА НАСТРОЕК =============

let settingsData = {
  extensionEnabled: true, autoProxyEnabled: true,
  autoProxyTimeoutEnabled: false, autoProxyTimeout: 5, autoAddRelated: false,
  webrtcProtectionEnabled: false, killSwitchEnabled: false
};

function saveSettingsData() {
  const timeoutInput = document.getElementById('dashTimeoutInput');
  let timeout = parseInt(timeoutInput?.value, 10) || 5;
  if (timeout < 2) timeout = 2;
  if (timeout > 30) timeout = 30;
  if (timeoutInput) timeoutInput.value = timeout;

  chrome.storage.local.set({
    extensionEnabled: settingsData.extensionEnabled,
    autoProxyEnabled: settingsData.autoProxyEnabled,
    autoProxyTimeoutEnabled: settingsData.autoProxyTimeoutEnabled,
    autoProxyTimeout: timeout,
    autoAddRelated: settingsData.autoAddRelated,
    webrtcProtectionEnabled: settingsData.webrtcProtectionEnabled,
    killSwitchEnabled: settingsData.killSwitchEnabled
  });
  chrome.runtime.sendMessage({ action: 'setWebrtcPolicy', enabled: settingsData.webrtcProtectionEnabled });
}

function initSettingsPage() {
  chrome.storage.local.get(['extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled', 'autoProxyTimeout', 'autoAddRelated', 'webrtcProtectionEnabled', 'killSwitchEnabled'], (d) => {
    settingsData.extensionEnabled = d.extensionEnabled !== false;
    settingsData.autoProxyEnabled = d.autoProxyEnabled !== false;
    settingsData.autoProxyTimeoutEnabled = d.autoProxyTimeoutEnabled === true;
    settingsData.autoProxyTimeout = parseInt(d.autoProxyTimeout, 10) || 5;
    settingsData.autoAddRelated = d.autoAddRelated === true;
    settingsData.webrtcProtectionEnabled = d.webrtcProtectionEnabled === true;
    settingsData.killSwitchEnabled = d.killSwitchEnabled === true;

    document.querySelectorAll('#page-settings .toggle-switch[data-key]').forEach(sw => {
      const key = sw.dataset.key;
      sw.classList.toggle('on', settingsData[key] === true);
      sw.onclick = () => {
        settingsData[key] = !settingsData[key];
        sw.classList.toggle('on', settingsData[key]);
        saveSettingsData();
      };
    });

    const timeoutInput = document.getElementById('dashTimeoutInput');
    if (timeoutInput) {
      timeoutInput.value = settingsData.autoProxyTimeout;
      timeoutInput.addEventListener('change', saveSettingsData);
    }

    document.getElementById('dashAboutVersion').textContent = chrome.runtime.getManifest().version;
  });
}



document.getElementById('dashExportBtn')?.addEventListener('click', () => {
  chrome.storage.local.get([
    'proxyList', 'directList', 'proxies', 'activeProxyId',
    'extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled',
    'autoProxyTimeout', 'autoAddRelated', 'webrtcProtectionEnabled',
    'killSwitchEnabled', 'onboardingComplete'
  ], (d) => {
    const config = {
      version: '1.1',
      exportDate: new Date().toISOString(),
      proxyList: d.proxyList || [],
      directList: d.directList || [],
      proxies: d.proxies || [],
      activeProxyId: d.activeProxyId || null,
      extensionEnabled: d.extensionEnabled !== false,
      autoProxyEnabled: d.autoProxyEnabled === true,
      autoProxyTimeoutEnabled: d.autoProxyTimeoutEnabled === true,
      autoProxyTimeout: d.autoProxyTimeout || 5,
      autoAddRelated: d.autoAddRelated === true,
      webrtcProtectionEnabled: d.webrtcProtectionEnabled === true,
      killSwitchEnabled: d.killSwitchEnabled === true,
      onboardingComplete: d.onboardingComplete === true
    };
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `proxy-config-${new Date().toISOString().split('T')[0]}.json`; a.click();
    URL.revokeObjectURL(url);
  });
});

document.getElementById('dashImportBtn')?.addEventListener('click', () => {
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.json';
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const config = JSON.parse(event.target.result);
        if (!config.proxyList && !config.directList && !config.proxies) throw new Error('Неверный формат');
        const updates = {};
        const keys = [
          'proxyList', 'directList', 'proxies',
          'extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled',
          'autoProxyTimeout', 'autoAddRelated', 'webrtcProtectionEnabled',
          'killSwitchEnabled', 'onboardingComplete'
        ];
        keys.forEach(k => { if (config[k] !== undefined) updates[k] = config[k]; });
        if (config.activeProxyId) updates.activeProxyId = config.activeProxyId;
        if (config.proxies && config.proxies.length > 0 && !config.activeProxyId) {
          updates.activeProxyId = config.proxies[0].id;
        }
        chrome.storage.local.set(updates, () => { loadData(); alert('Конфигурация импортирована'); });
      } catch (err) { alert('Ошибка: ' + err.message); }
    };
    reader.readAsText(file);
  };
  fileInput.click();
});

// ============= ИНИЦИАЛИЗАЦИЯ =============

loadData();
