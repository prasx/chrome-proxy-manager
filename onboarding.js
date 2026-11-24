// ============= ONBOARDING =============

const dots = document.querySelectorAll('.step-dot');
const slides = document.querySelectorAll('.slide');
let current = 0;
let testing = false;
let editingProxyId = null;

function goTo(index) {
  slides.forEach((slide, i) => slide.classList.toggle('active', i === index));
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === index);
    dot.classList.toggle('done', i < index);
  });
  current = index;
}

function readForm() {
  const type = document.getElementById('onboardType').value;
  return {
    name: document.getElementById('onboardName').value.trim(),
    host: document.getElementById('onboardHost').value.trim().replace(/^\[|\]$/g, ''),
    port: parseInt(document.getElementById('onboardPort').value, 10),
    type,
    username: document.getElementById('onboardUser').value.trim(),
    password: document.getElementById('onboardPass').value.trim()
  };
}

function showHint(message) {
  const hint = document.getElementById('onboardHint');
  hint.textContent = message;
  hint.hidden = !message;
}

function updateSocksWarning() {
  const type = document.getElementById('onboardType').value;
  const warning = document.getElementById('onboardSocksWarning');
  const hasCredentials = document.getElementById('onboardUser').value.trim() ||
    document.getElementById('onboardPass').value.trim();
  warning.hidden = !(isSocksProxyType(type) && hasCredentials);
}

function validateForm() {
  const form = readForm();
  if (!form.host || !isValidProxyHost(form.host)) {
    showHint('Укажите IP-адрес или корректный hostname');
    document.getElementById('onboardHost').focus();
    return null;
  }
  if (!isValidPort(form.port)) {
    showHint('Порт должен быть числом от 1 до 65535');
    document.getElementById('onboardPort').focus();
    return null;
  }
  showHint('');
  return form;
}

function saveProxy(callback) {
  const form = validateForm();
  if (!form) return;

  chrome.storage.local.get(['proxies'], (result) => {
    const proxies = Array.isArray(result.proxies) ? result.proxies : [];
    const existingIndex = editingProxyId
      ? proxies.findIndex(p => sameProxyId(p.id, editingProxyId))
      : proxies.findIndex(p => p.host === form.host && Number(p.port) === form.port);
    const id = existingIndex === -1 ? crypto.randomUUID() : proxies[existingIndex].id;
    editingProxyId = id;
    const proxy = {
      id,
      name: form.name || form.host,
      host: form.host,
      port: form.port,
      type: form.type,
      enabled: true,
      username: form.username,
      password: form.password
    };

    if (existingIndex === -1) proxies.unshift(proxy);
    else proxies[existingIndex] = { ...proxies[existingIndex], ...proxy };

    chrome.storage.local.set({ proxies, activeProxyId: id }, () => {
      if (typeof callback === 'function') callback(proxy);
    });
  });
}

function setTestResult(text, state) {
  const el = document.getElementById('onboardTestResult');
  el.textContent = text;
  el.className = 'onboard-result' + (state ? ' is-' + state : '');
}

function testProxy() {
  if (testing) return;
  const form = validateForm();
  if (!form) return;

  testing = true;
  const button = document.getElementById('onboardTestBtn');
  button.disabled = true;
  button.textContent = 'Проверяем…';
  setTestResult('Проверяем соединение…', 'checking');

  saveProxy((proxy) => {
    chrome.runtime.sendMessage({ action: 'testProxy', proxyId: proxy.id }, (response) => {
      testing = false;
      button.disabled = false;
      button.textContent = 'Проверить прокси';

      const error = chrome.runtime.lastError;
      if (error || !response) {
        setTestResult('Фоновый процесс не ответил — попробуйте ещё раз', 'error');
        return;
      }
      if (response.success) {
        setTestResult(`Прокси отвечает: IP ${response.ip}, ${Math.round(response.latencyMs || 0)} мс`, 'success');
      } else {
        setTestResult(response.message || 'Прокси недоступен', 'error');
      }
    });
  });
}

document.querySelectorAll('.next-btn').forEach(button => {
  button.addEventListener('click', () => {
    if (current !== 2) {
      if (current < slides.length - 1) goTo(current + 1);
      return;
    }
    saveProxy(() => {
      if (current < slides.length - 1) goTo(current + 1);
    });
  });
});

document.querySelectorAll('.prev-btn').forEach(button => {
  button.addEventListener('click', () => {
    if (current > 0) goTo(current - 1);
  });
});

document.getElementById('onboardType').addEventListener('change', updateSocksWarning);
document.getElementById('onboardUser').addEventListener('input', updateSocksWarning);
document.getElementById('onboardPass').addEventListener('input', updateSocksWarning);
document.getElementById('onboardTestBtn').addEventListener('click', testProxy);
['onboardHost', 'onboardPort'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const hint = document.getElementById('onboardHint');
    if (!hint.hidden) showHint('');
  });
});

document.getElementById('finishBtn').addEventListener('click', () => {
  chrome.storage.local.set({ onboardingComplete: true }, () => {
    window.location.href = chrome.runtime.getURL('dashboard.html');
  });
});

document.getElementById('skipOnboarding').addEventListener('click', () => {
  chrome.storage.local.set({ onboardingComplete: true }, () => {
    window.location.href = chrome.runtime.getURL('dashboard.html');
  });
});
