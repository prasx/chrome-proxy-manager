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
const proxyListValue = document.getElementById('proxyListValue');
const proxyListSites = document.getElementById('proxyListSites');
const clearProxyListBtn = document.getElementById('clearProxyList');
const exportProxyListBtn = document.getElementById('exportProxyList');
const importProxyListBtn = document.getElementById('importProxyList');
const proxyListUrl = document.getElementById('proxyListUrl');
const importProxyListFromUrlBtn = document.getElementById('importProxyListFromUrl');
const proxyImportStatus = document.getElementById('proxyImportStatus');

// Direct list
const addToDirectListBtn = document.getElementById('addToDirectList');
const directListValue = document.getElementById('directListValue');
const directListSites = document.getElementById('directListSites');
const clearDirectListBtn = document.getElementById('clearDirectList');
const exportDirectListBtn = document.getElementById('exportDirectList');
const directListUrl = document.getElementById('directListUrl');
const importDirectListFromUrlBtn = document.getElementById('importDirectListFromUrl');
const directImportStatus = document.getElementById('directImportStatus');

const importFile = document.getElementById('importFile');
const importConfigFile = document.getElementById('importConfigFile');
const exportConfigBtn = document.getElementById('exportConfig');
const importConfigBtn = document.getElementById('importConfig');
const clearLogsBtn = document.getElementById('clearLogs');

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
  });
});

// Загрузка данных
function loadData() {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId', 'autoAddRelated'], (data) => {
    const proxyList = data.proxyList || [];
    const directList = data.directList || [];
    const proxies = data.proxies || [];
    const activeProxyId = data.activeProxyId;
    const autoAddRelated = data.autoAddRelated || false;
    
    renderProxies(proxies, activeProxyId);
    renderSites(proxyList, proxyListSites, 'proxyList');
    renderSites(directList, directListSites, 'directList');
    
    // Устанавливаем состояние чекбокса
    if (autoAddRelatedCheckbox) {
      autoAddRelatedCheckbox.checked = autoAddRelated;
    }
  });
}

// Рендер списка прокси
function renderProxies(proxies, activeProxyId) {
  if (proxies.length === 0) {
    proxiesList.innerHTML = '<div class="empty-state-small">Нет прокси серверов</div>';
    return;
  }
  
  proxiesList.innerHTML = '';
  proxies.forEach(proxy => {
    const item = document.createElement('div');
    item.className = `proxy-item ${proxy.id === activeProxyId ? 'active' : ''}`;
    item.innerHTML = `
      <div class="proxy-radio">
        <input type="radio" name="activeProxy" value="${proxy.id}" ${proxy.id === activeProxyId ? 'checked' : ''}>
      </div>
      <div class="proxy-info">
        <input type="text" class="proxy-name" value="${proxy.name}" data-id="${proxy.id}" placeholder="Название">
        <div class="proxy-details">
          <input type="text" class="proxy-host" value="${proxy.host}" data-id="${proxy.id}" placeholder="127.0.0.1">
          <input type="number" class="proxy-port" value="${proxy.port}" data-id="${proxy.id}" placeholder="1080">
          <select class="proxy-type" data-id="${proxy.id}">
            <option value="SOCKS5" ${proxy.type === 'SOCKS5' ? 'selected' : ''}>SOCKS5</option>
            <option value="SOCKS" ${proxy.type === 'SOCKS' ? 'selected' : ''}>SOCKS4</option>
            <option value="PROXY" ${proxy.type === 'PROXY' ? 'selected' : ''}>HTTP</option>
            <option value="HTTPS" ${proxy.type === 'HTTPS' ? 'selected' : ''}>HTTPS</option>
          </select>
        </div>
      </div>
      <div class="proxy-actions">
        <div class="toggle-switch ${proxy.enabled ? 'active' : ''}" data-id="${proxy.id}"></div>
        <button class="delete-btn-small" data-id="${proxy.id}">✕</button>
      </div>
    `;
    proxiesList.appendChild(item);
  });
  
  // Обработчики для прокси
  document.querySelectorAll('input[name="activeProxy"]').forEach(radio => {
    radio.addEventListener('change', () => {
      chrome.storage.local.set({ activeProxyId: parseInt(radio.value) }, loadData);
    });
  });
  
  document.querySelectorAll('.proxy-name').forEach(input => {
    input.addEventListener('change', () => updateProxy(parseInt(input.dataset.id), 'name', input.value));
  });
  
  document.querySelectorAll('.proxy-host').forEach(input => {
    input.addEventListener('change', () => updateProxy(parseInt(input.dataset.id), 'host', input.value));
  });
  
  document.querySelectorAll('.proxy-port').forEach(input => {
    input.addEventListener('change', () => updateProxy(parseInt(input.dataset.id), 'port', parseInt(input.value)));
  });
  
  document.querySelectorAll('.proxy-type').forEach(select => {
    select.addEventListener('change', () => updateProxy(parseInt(select.dataset.id), 'type', select.value));
  });
  
  document.querySelectorAll('.proxy-item .toggle-switch').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const enabled = !toggle.classList.contains('active');
      updateProxy(parseInt(toggle.dataset.id), 'enabled', enabled);
    });
  });
  
  document.querySelectorAll('.delete-btn-small').forEach(btn => {
    btn.addEventListener('click', () => deleteProxy(parseInt(btn.dataset.id)));
  });
}

// Обновление прокси
function updateProxy(id, field, value) {
  chrome.storage.local.get(['proxies'], (data) => {
    const proxies = data.proxies.map(p => p.id === id ? { ...p, [field]: value } : p);
    chrome.storage.local.set({ proxies }, loadData);
  });
}

// Удаление прокси
function deleteProxy(id) {
  chrome.storage.local.get(['proxies', 'activeProxyId'], (data) => {
    if (data.proxies.length <= 1) {
      alert('Должен остаться хотя бы один прокси');
      return;
    }
    const proxies = data.proxies.filter(p => p.id !== id);
    const updates = { proxies };
    if (data.activeProxyId === id) {
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
      id: Date.now(),
      name: `Proxy ${proxies.length + 1}`,
      host: '127.0.0.1',
      port: 1080,
      type: 'SOCKS5',
      enabled: true
    };
    proxies.push(newProxy);
    chrome.storage.local.set({ proxies }, loadData);
  });
});

// Тест прокси
testProxyBtn.addEventListener('click', () => {
  proxyTestResult.textContent = 'Проверка...';
  proxyTestResult.className = 'proxy-test-result loading';
  
  chrome.storage.local.get(['proxies', 'activeProxyId', 'proxyList'], (data) => {
    const activeProxy = data.proxies?.find(p => p.id === data.activeProxyId);
    
    if (!activeProxy) {
      proxyTestResult.textContent = '✗ Нет активного прокси';
      proxyTestResult.className = 'proxy-test-result error';
      return;
    }
    
    // Добавляем api.ipify.org в proxy list временно для теста
    const proxyList = data.proxyList || [];
    const testSite = { id: -1, value: 'api.ipify.org', enabled: true };
    const tempProxyList = [...proxyList, testSite];
    
    chrome.storage.local.set({ proxyList: tempProxyList }, () => {
      // Ждем применения конфигурации
      setTimeout(() => {
        fetch('https://api.ipify.org?format=json')
          .then(res => res.json())
          .then(result => {
            // Убираем тестовый сайт
            chrome.storage.local.set({ proxyList: proxyList }, () => {
              proxyTestResult.textContent = `✓ IP через прокси: ${result.ip}`;
              proxyTestResult.className = 'proxy-test-result success';
            });
          })
          .catch(err => {
            chrome.storage.local.set({ proxyList: proxyList }, () => {
              proxyTestResult.textContent = `✗ Ошибка: ${err.message}`;
              proxyTestResult.className = 'proxy-test-result error';
            });
          });
      }, 500);
    });
  });
});

// Рендер списка сайтов
function renderSites(sites, container, listType) {
  if (sites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📝</div>
        <div>Список пуст</div>
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  sites.forEach(site => {
    const item = document.createElement('div');
    item.className = 'site-item';
    item.innerHTML = `
      <div class="site-name">${site.value}</div>
      <div class="site-actions">
        <div class="toggle-switch ${site.enabled ? 'active' : ''}" data-id="${site.id}" data-list="${listType}"></div>
        <button class="delete-btn" data-id="${site.id}" data-list="${listType}">✕</button>
      </div>
    `;
    container.appendChild(item);
  });
  
  // Обработчики
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteSite(parseInt(btn.dataset.id), btn.dataset.list));
  });
  
  container.querySelectorAll('.toggle-switch').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const enabled = !toggle.classList.contains('active');
      toggleSite(parseInt(toggle.dataset.id), toggle.dataset.list, enabled);
    });
  });
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
  
  chrome.storage.local.get([listKey], (data) => {
    const list = data[listKey] || [];
    
    if (list.find(s => s.value.toLowerCase() === value.toLowerCase())) {
      alert('Этот сайт уже в списке');
      return;
    }
    
    list.push({
      id: Date.now(),
      value: value,
      enabled: true
    });
    chrome.storage.local.set({ [listKey]: list }, loadData);
  });
}

// Добавление в proxy list
addToProxyListBtn.addEventListener('click', () => {
  addToList(proxyListValue.value, 'proxyList');
  proxyListValue.value = '';
});

proxyListValue.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addToProxyListBtn.click();
});

// Добавление в direct list
addToDirectListBtn.addEventListener('click', () => {
  addToList(directListValue.value, 'directList');
  directListValue.value = '';
});

directListValue.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addToDirectListBtn.click();
});

// Удаление сайта
function deleteSite(id, listKey) {
  chrome.storage.local.get([listKey], (data) => {
    const list = data[listKey].filter(s => s.id !== id);
    chrome.storage.local.set({ [listKey]: list }, loadData);
  });
}

// Toggle сайта
function toggleSite(id, listKey, enabled) {
  chrome.storage.local.get([listKey], (data) => {
    const list = data[listKey].map(s => s.id === id ? { ...s, enabled } : s);
    chrome.storage.local.set({ [listKey]: list }, loadData);
  });
}

// Очистка списков
clearProxyListBtn.addEventListener('click', () => {
  if (confirm('Удалить все сайты из списка прокси?')) {
    chrome.storage.local.set({ proxyList: [] }, loadData);
  }
});

clearDirectListBtn.addEventListener('click', () => {
  if (confirm('Удалить все сайты из списка direct?')) {
    chrome.storage.local.set({ directList: [] }, loadData);
  }
});

// Импорт с URL для proxy list
importProxyListFromUrlBtn.addEventListener('click', () => {
  importFromUrl(proxyListUrl.value, 'proxyList', proxyImportStatus);
});

// Импорт с URL для direct list
importDirectListFromUrlBtn.addEventListener('click', () => {
  importFromUrl(directListUrl.value, 'directList', directImportStatus);
});

// Быстрые ссылки
document.querySelectorAll('.quick-link-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.url;
    const directListUrlInput = document.getElementById('directListUrl');
    const directImportStatusElement = document.getElementById('directImportStatus');
    
    directListUrlInput.value = url;
    importFromUrl(url, 'directList', directImportStatusElement);
  });
});

// Функция импорта с URL
function importFromUrl(url, listKey, statusElement) {
  url = url.trim();
  
  if (!url) {
    statusElement.textContent = 'Введите URL';
    statusElement.className = 'import-status error';
    return;
  }
  
  statusElement.textContent = 'Загрузка...';
  statusElement.className = 'import-status loading';
  
  fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then(text => {
      const lines = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('//'));
      
      if (lines.length === 0) {
        throw new Error('Список пуст');
      }
      
      chrome.storage.local.get([listKey], (data) => {
        let list = data[listKey] || [];
        
        lines.forEach(domain => {
          if (!list.find(s => s.value.toLowerCase() === domain.toLowerCase())) {
            list.push({
              id: Date.now() + Math.random(),
              value: domain,
              enabled: true
            });
          }
        });
        
        chrome.storage.local.set({ [listKey]: list }, () => {
          loadData();
          statusElement.textContent = `✓ Добавлено ${lines.length} сайтов`;
          statusElement.className = 'import-status success';
          
          setTimeout(() => {
            statusElement.textContent = '';
          }, 3000);
        });
      });
    })
    .catch(err => {
      statusElement.textContent = `✗ Ошибка: ${err.message}`;
      statusElement.className = 'import-status error';
    });
}

// Экспорт/импорт JSON
exportProxyListBtn.addEventListener('click', () => exportList('proxyList', 'proxy-list.json'));
exportDirectListBtn.addEventListener('click', () => exportList('directList', 'direct-list.json'));

function exportList(listKey, filename) {
  chrome.storage.local.get([listKey], (data) => {
    const json = JSON.stringify(data[listKey] || [], null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  });
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
    a.download = `xray-proxy-config-${new Date().toISOString().split('T')[0]}.json`;
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
      
      // Парсим строку: [04.05.2026, 20:32:39] REQUEST: PROXY - 2ip.ru -> SOCKS5 192.168.1.131:1080 (matched: *.ru)
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
      <td class="log-route">${log.route}</td>
      <td class="log-rule">${log.rule}</td>
    `;
    
    logsTableBody.appendChild(row);
  });
}

// Фильтр логов
const logFilterElement = document.getElementById('logFilter');
if (logFilterElement) {
  logFilterElement.addEventListener('change', loadLogs);
}

// Очистка логов
clearLogsBtn.addEventListener('click', () => {
  if (confirm('Очистить все логи?')) {
    chrome.storage.local.set({ routeLogs: '' }, () => {
      loadLogs();
    });
  }
});

// Инициализация
loadData();

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
  
  // Рисуем столбцы
  hourlyData.forEach((data, index) => {
    const x = padding + index * barWidth;
    const proxyHeight = (data.proxy / maxValue) * chartHeight;
    const directHeight = (data.direct / maxValue) * chartHeight;
    
    // Столбец для direct (снизу)
    ctx.fillStyle = '#1a73e8';
    ctx.fillRect(x + 1, height - padding - directHeight, barWidth - 2, directHeight);
    
    // Столбец для proxy (сверху)
    ctx.fillStyle = '#34a853';
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
    
    const proxyPercent = Math.round((item.proxy / item.total) * 100);
    
    div.innerHTML = `
      <div class="top-domain-rank">${index + 1}</div>
      <div class="top-domain-info">
        <div class="top-domain-name">${item.domain}</div>
        <div class="top-domain-bar">
          <div class="top-domain-bar-proxy" style="width: ${proxyPercent}%"></div>
        </div>
      </div>
      <div class="top-domain-count">${item.total}</div>
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
    
    if (relatedDomains.length === 0) {
      relatedDomainsSection.style.display = 'block';
      relatedDomainsList.innerHTML = `
        <div class="related-domains-empty">
          <div>📭 Не найдено связанных доменов</div>
          <div class="related-domains-hint">Основной домен: <strong>${mainDomain}</strong></div>
        </div>
      `;
      return;
    }
    
    // Получаем текущие списки
    chrome.storage.local.get(['proxyList', 'directList'], (data) => {
      const proxyList = data.proxyList || [];
      const directList = data.directList || [];
      
      relatedDomainsSection.style.display = 'block';
      relatedDomainsList.innerHTML = `
        <div class="related-domains-hint">
          Основной домен: <strong>${mainDomain}</strong><br>
          Найдено связанных доменов: <strong>${relatedDomains.length}</strong>
        </div>
      `;
      
      relatedDomains.forEach(domain => {
        const inProxyList = proxyList.some(s => s.value === domain);
        const inDirectList = directList.some(s => s.value === domain);
        
        const item = document.createElement('div');
        item.className = 'related-domain-item';
        
        let statusBadge = '';
        if (inProxyList) {
          statusBadge = '<span class="domain-badge proxy">В списке прокси</span>';
        } else if (inDirectList) {
          statusBadge = '<span class="domain-badge direct">В списке напрямую</span>';
        }
        
        item.innerHTML = `
          <div class="related-domain-name">${domain} ${statusBadge}</div>
          <div class="related-domain-actions">
            ${!inProxyList && !inDirectList ? `
              <button class="add-related-btn proxy" data-domain="${domain}">+ Прокси</button>
              <button class="add-related-btn direct" data-domain="${domain}">+ Напрямую</button>
            ` : ''}
          </div>
        `;
        
        relatedDomainsList.appendChild(item);
      });
      
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
