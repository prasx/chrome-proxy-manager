// ============= SETTINGS — КЭШ =============

let settings = {
  extensionEnabled: true, autoProxyEnabled: true,
  autoProxyTimeoutEnabled: false, autoProxyTimeout: 5, autoAddRelated: false,
  webrtcProtectionEnabled: false, killSwitchEnabled: false,
  proxyList: [], directList: []
};

// ============= ЗАГРУЗКА =============

function loadSettings(cb) {
  chrome.storage.local.get(['extensionEnabled', 'autoProxyEnabled', 'autoProxyTimeoutEnabled', 'autoProxyTimeout', 'autoAddRelated', 'webrtcProtectionEnabled', 'killSwitchEnabled', 'proxyList', 'directList'], (d) => {
    settings.extensionEnabled = d.extensionEnabled !== false;
    settings.autoProxyEnabled = d.autoProxyEnabled !== false;
    settings.autoProxyTimeoutEnabled = d.autoProxyTimeoutEnabled === true;
    settings.autoProxyTimeout = parseInt(d.autoProxyTimeout, 10) || 5;
    settings.autoAddRelated = d.autoAddRelated === true;
    settings.webrtcProtectionEnabled = d.webrtcProtectionEnabled === true;
    settings.killSwitchEnabled = d.killSwitchEnabled === true;
    settings.proxyList = d.proxyList || [];
    settings.directList = d.directList || [];
    renderAll();
    if (cb) cb();
  });
}

// ============= ВКЛАДКИ =============

const tabs = document.querySelectorAll('.settings-nav-item');
const sections = document.querySelectorAll('.settings-section');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    sections.forEach(s => { s.style.display = s.dataset.tab === id ? '' : 'none'; });
  });
});

// ============= ПЕРЕКЛЮЧАТЕЛИ =============

function saveSettings() {
  const timeoutInput = document.getElementById('timeoutInput');
  let timeout = parseInt(timeoutInput?.value, 10) || 5;
  if (timeout < 2) timeout = 2;
  if (timeout > 30) timeout = 30;

  chrome.storage.local.set({
    extensionEnabled: settings.extensionEnabled,
    autoProxyEnabled: settings.autoProxyEnabled,
    autoProxyTimeoutEnabled: settings.autoProxyTimeoutEnabled,
    autoProxyTimeout: timeout,
    autoAddRelated: settings.autoAddRelated,
    webrtcProtectionEnabled: settings.webrtcProtectionEnabled,
    killSwitchEnabled: settings.killSwitchEnabled
  });
  chrome.runtime.sendMessage({ action: 'setWebrtcPolicy', enabled: settings.webrtcProtectionEnabled });
}

function initToggles() {
  document.querySelectorAll('.toggle-switch[data-key]').forEach(sw => {
    const key = sw.dataset.key;
    sw.classList.toggle('on', settings[key] === true);
    sw.addEventListener('click', () => {
      settings[key] = !settings[key];
      sw.classList.toggle('on', settings[key]);
      saveSettings();
    });
  });
  const timeoutInput = document.getElementById('timeoutInput');
  if (timeoutInput) {
    timeoutInput.value = settings.autoProxyTimeout;
    timeoutInput.addEventListener('change', saveSettings);
  }
}

// ============= ПРАВИЛА =============

function renderRules() {
  const proxyContainer = document.getElementById('settingsProxyList');
  const directContainer = document.getElementById('settingsDirectList');
  setupRuleListHandlers(proxyContainer, loadSettings);
  setupRuleListHandlers(directContainer, loadSettings);
  renderSiteList(settings.proxyList, proxyContainer, 'proxyList',
    document.getElementById('settingsProxySearch'), document.getElementById('settingsProxyCount'));
  renderSiteList(settings.directList, directContainer, 'directList',
    document.getElementById('settingsDirectSearch'), document.getElementById('settingsDirectCount'));
}

// ============= ПОЛНЫЙ РЕНДЕР =============

function renderAll() {
  initToggles();
  renderRules();
  document.getElementById('aboutVersion').textContent = chrome.runtime.getManifest().version;
}

// ============= ОБРАБОТЧИКИ =============

document.getElementById('addSettingsProxyBtn')?.addEventListener('click', () => {
  const input = document.getElementById('settingsProxyInput');
  addToList(input.value, 'proxyList', () => { input.value = ''; loadSettings(); });
});
document.getElementById('settingsProxyInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addSettingsProxyBtn').click();
});

document.getElementById('addSettingsDirectBtn')?.addEventListener('click', () => {
  const input = document.getElementById('settingsDirectInput');
  addToList(input.value, 'directList', () => { input.value = ''; loadSettings(); });
});
document.getElementById('settingsDirectInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addSettingsDirectBtn').click();
});

document.getElementById('settingsProxySearch')?.addEventListener('input', renderRules);
document.getElementById('settingsDirectSearch')?.addEventListener('input', renderRules);



document.getElementById('exportConfigBtn')?.addEventListener('click', () => {
  chrome.storage.local.get(['proxyList', 'directList', 'proxies', 'activeProxyId'], (d) => {
    const config = { version: '1.0', exportDate: new Date().toISOString(), proxyList: d.proxyList || [], directList: d.directList || [], proxies: d.proxies || [], activeProxyId: d.activeProxyId };
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `proxy-config-${new Date().toISOString().split('T')[0]}.json`; a.click();
    URL.revokeObjectURL(url);
  });
});

document.getElementById('importConfigBtn')?.addEventListener('click', () => {
  document.getElementById('importConfigFile').click();
});

document.getElementById('importConfigFile')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const config = JSON.parse(event.target.result);
      if (!config.proxyList && !config.directList && !config.proxies) throw new Error('Неверный формат');
      const updates = {};
      if (config.proxyList) updates.proxyList = config.proxyList;
      if (config.directList) updates.directList = config.directList;
      if (config.proxies) updates.proxies = config.proxies;
      if (config.activeProxyId) updates.activeProxyId = config.activeProxyId;
      chrome.storage.local.set(updates, () => { loadSettings(); alert('Конфигурация импортирована'); });
    } catch (err) { alert('Ошибка импорта: ' + err.message); }
  };
  reader.readAsText(file);
});

document.getElementById('resetStatsBtn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'resetStats' }, () => alert('Статистика сброшена'));
});

document.getElementById('backLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ============= ИНИЦИАЛИЗАЦИЯ =============

loadSettings();
