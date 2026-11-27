// ============= POPUP =============

const $ = id => document.getElementById(id);

const state = {
  data: {
    proxyList: [],
    directList: [],
    proxies: [],
    activeProxyId: null,
    extensionEnabled: true,
    autoProxyEnabled: true,
    killSwitchEnabled: false
  },
  probe: null,
  probing: false,
  probeTimer: null,
  probeToken: 0,
  checkedAt: 0,
  domainsLoaded: false,
  domainsPollTimer: null,
  domainsRefreshing: false,
  pageDomains: null,
  lastIssue: null
};

const POWER_STATES = {
  off: { title: 'Прокси выключен', detail: 'Трафик идёт напрямую, правила не применяются' },
  empty: { title: 'Прокси не выбран', detail: 'Добавьте сервер в панели управления' },
  checking: { title: 'Проверяем прокси…', detail: 'Пара секунд' }
};

const ISSUE_TITLES = {
  proxy: 'Прокси не отвечает',
  fallback: 'Прокси переключён',
  auth: 'Нужна авторизация',
  config: 'Настройки не применились'
};

// ============= ДАННЫЕ =============

function loadData(options) {
  const opts = options || {};
  chrome.storage.local.get(
    ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled', 'lastIssue'],
    (data) => {
      state.data.proxyList = (Array.isArray(data.proxyList) ? data.proxyList : []).filter(item => item && typeof item === 'object');
      state.data.directList = (Array.isArray(data.directList) ? data.directList : []).filter(item => item && typeof item === 'object');
      state.data.proxies = (Array.isArray(data.proxies) ? data.proxies : []).filter(item => item && typeof item === 'object');
      state.data.activeProxyId = data.activeProxyId == null ? null : data.activeProxyId;
      state.data.extensionEnabled = data.extensionEnabled !== false;
      state.data.autoProxyEnabled = data.autoProxyEnabled !== false;
      state.data.killSwitchEnabled = data.killSwitchEnabled === true;
      state.lastIssue = data.lastIssue && typeof data.lastIssue === 'object' ? data.lastIssue : null;

      lastConfigKey = currentConfigKey();
      render();
      renderIssue();
      syncPageDomainRules();
      renderRulesStatus();
      renderPageRules();

      if (!state.domainsLoaded) {
        state.domainsLoaded = true;
        loadPageDomains();
      }

      if (opts.probe) probe();
      if (typeof opts.after === 'function') opts.after();
    }
  );
}

function activeProxy() {
  return findProxyById(state.data.proxies, state.data.activeProxyId);
}

function proxyAddress(proxy) {
  if (!proxy) return '';
  return `${proxy.host}:${proxy.port}, ${displayProxyType(proxy.type)}`;
}

// ============= СОСТОЯНИЕ ПРОКСИ =============

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setStatus(title, detail, cardState) {
  setText('stateTitle', title);
  setText('stateDetail', detail);
  $('powerCard').dataset.state = cardState;
}

function renderIssue() {
  const issue = state.lastIssue;
  const banner = $('issueBanner');
  if (!banner) return;

  const recent = issue && Number(issue.at) && Date.now() - Number(issue.at) < 30 * 60 * 1000;
  if (!recent || !issue.message) {
    banner.hidden = true;
    return;
  }

  setText('issueTitle', ISSUE_TITLES[issue.kind] || 'Ошибка прокси');
  setText('issueText', issue.message);
  banner.hidden = false;
}

function render() {
  const data = state.data;
  const proxy = activeProxy();
  const configured = isProxyConfigured(proxy);
  const configuredCount = data.proxies.filter(isProxyConfigured).length;

  const toggleBtn = $('toggleBtn');
  toggleBtn.setAttribute('aria-checked', data.extensionEnabled ? 'true' : 'false');
  toggleBtn.setAttribute('aria-label', data.extensionEnabled ? 'Выключить прокси' : 'Включить прокси');

  document.querySelectorAll('.header-mode').forEach(button => {
    const isAuto = button.dataset.mode === 'auto';
    const active = data.extensionEnabled && (isAuto === data.autoProxyEnabled);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = !data.extensionEnabled;
  });

  setText('proxyName', proxy ? (proxy.name || proxy.host) : '—');

  const refreshBtn = $('refreshBtn');
  refreshBtn.disabled = true;

  if (!data.extensionEnabled) {
    setStatus(POWER_STATES.off.title, POWER_STATES.off.detail, 'off');
    setText('proxyIp', '—');
    setText('latency', '—');
    $('latency').className = '';
    setText('checkedAt', '');
    return;
  }

  if (!configured) {
    const killSwitchDetail = data.killSwitchEnabled && configuredCount === 0
      ? 'Kill switch включён: без прокси сайты не открываются. Добавьте сервер или выключите защиту.'
      : POWER_STATES.empty.detail;
    setStatus(POWER_STATES.empty.title, killSwitchDetail, 'empty');
    setText('proxyIp', '—');
    setText('latency', '—');
    $('latency').className = '';
    setText('checkedAt', '');
    return;
  }

  refreshBtn.disabled = state.probing;
  refreshBtn.textContent = state.probing ? 'Проверяем…' : 'Проверить ещё раз';

  if (state.probing) {
    setStatus(POWER_STATES.checking.title, `${proxy.name || proxy.host} — ${proxyAddress(proxy)}`, 'checking');
    setText('proxyIp', '…');
    setText('latency', '…');
    $('latency').className = '';
    setText('checkedAt', '');
    return;
  }

  if (state.probe && state.probe.success) {
    const fallback = configuredCount > 1 ? `, резерв: ${configuredCount - 1}` : '';
    setStatus('Прокси работает', `${proxy.name || proxy.host} — ${proxyAddress(proxy)}${fallback}`, 'online');
    setText('proxyIp', state.probe.ip || '—');
    setText('latency', `${state.probe.latencyMs} мс`);
    $('latency').className = state.probe.latencyMs > 800 ? 'is-warn' : 'is-good';
    setText('checkedAt', state.checkedAt ? `Проверено в ${new Date(state.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '');
    return;
  }

  if (state.probe && !state.probe.success) {
    setStatus('Прокси не отвечает', state.probe.message || `${proxy.name || proxy.host} — ${proxyAddress(proxy)}`, 'error');
    setText('proxyIp', '—');
    setText('latency', '—');
    $('latency').className = '';
    setText('checkedAt', '');
    return;
  }

  setStatus(POWER_STATES.checking.title, `${proxy.name || proxy.host} — ${proxyAddress(proxy)}`, 'checking');
  setText('proxyIp', '…');
  setText('latency', '…');
  setText('checkedAt', '');
}

// ============= ПРОВЕРКА ПРОКСИ =============

function finishProbe(result) {
  if (state.probeTimer) {
    clearTimeout(state.probeTimer);
    state.probeTimer = null;
  }
  state.probing = false;
  state.probe = result;
  if (result && result.success) {
    state.checkedAt = Date.now();
  } else {
    state.checkedAt = 0;
  }
  render();
}

function probe() {
  if (state.probing) return;

  const data = state.data;
  const proxy = activeProxy();
  if (!data.extensionEnabled || !isProxyConfigured(proxy)) {
    state.probe = null;
    render();
    return;
  }

  const token = ++state.probeToken;
  state.probing = true;
  state.probe = null;
  render();

  let settled = false;
  const done = (result) => {
    if (settled || token !== state.probeToken) return;
    settled = true;
    finishProbe(result);
  };

  state.probeTimer = setTimeout(() => {
    done({ success: false, error: 'timeout', message: 'Прокси не ответил за 6 секунд' });
  }, 6000);

  try {
    chrome.runtime.sendMessage({ action: 'probeActiveProxy' }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        done({ success: false, error: 'worker', message: 'Фоновый процесс расширения не ответил' });
        return;
      }
      done(response || { success: false, error: 'empty', message: 'Пустой ответ фонового процесса' });
    });
  } catch (error) {
    done({ success: false, error: 'worker', message: String(error && error.message || error) });
  }
}

// ============= ПЕРЕКЛЮЧАТЕЛЬ И РЕЖИМ =============

$('toggleBtn').addEventListener('click', () => {
  const enabled = !state.data.extensionEnabled;
  state.data.extensionEnabled = enabled;
  state.probe = null;
  state.checkedAt = 0;
  state.probeToken++;
  state.probing = false;
  if (state.probeTimer) { clearTimeout(state.probeTimer); state.probeTimer = null; }
  chrome.storage.local.set({ extensionEnabled: enabled }, () => {
    render();
    renderRulesStatus();
    renderPageRules();
    if (enabled) probe();
  });
});

document.querySelectorAll('.header-mode').forEach(button => {
  button.addEventListener('click', () => {
    if (!state.data.extensionEnabled) return;
    const autoProxyEnabled = button.dataset.mode === 'auto';
    if (autoProxyEnabled === state.data.autoProxyEnabled) return;
    state.data.autoProxyEnabled = autoProxyEnabled;
    render();
    chrome.storage.local.set({ autoProxyEnabled });
  });
});

// ============= ССЫЛКИ =============

function openDashboard(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') + (hash || '') });
}

$('dashboardBtn').addEventListener('click', () => openDashboard(''));
$('manageRulesBtn').addEventListener('click', () => openDashboard('#rules'));
$('refreshBtn').addEventListener('click', probe);
$('refreshDomainsBtn').addEventListener('click', () => loadPageDomains());

$('issueLogsBtn').addEventListener('click', () => openDashboard('#activity'));
$('issueDismissBtn').addEventListener('click', () => {
  state.lastIssue = null;
  renderIssue();
  chrome.runtime.sendMessage({ action: 'acknowledgeIssue' }, () => {
    void chrome.runtime.lastError;
    loadData();
  });
});

// ============= ПРАВИЛА: КОМПАКТНЫЙ СТАТУС =============

function pluralDomains(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'домен';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'домена';
  return 'доменов';
}

function ruleStats() {
  const total = state.data.proxyList.length + state.data.directList.length;
  const active = [...state.data.proxyList, ...state.data.directList]
    .filter(site => site.enabled !== false).length;
  return { total, active };
}

function renderRulesStatus() {
  const { total, active } = ruleStats();
  const hasConfiguredProxy = state.data.proxies.some(isProxyConfigured);
  const el = $('rulesStatusText');

  let text;
  let kind;
  if (!total) {
    text = 'Правил пока нет';
    kind = 'is-empty';
  } else if (!state.data.extensionEnabled) {
    text = 'Правила выключены вместе с прокси';
    kind = 'is-off';
  } else if (!hasConfiguredProxy) {
    text = 'Правила не работают: прокси не настроен';
    kind = 'is-off';
  } else if (!active) {
    text = 'Все правила выключены';
    kind = 'is-off';
  } else if (active === total) {
    text = `Правил ${total}, все активны`;
    kind = 'is-on';
  } else {
    text = `Правил ${total}, активны ${active}`;
    kind = 'is-on';
  }

  if (el) {
    el.textContent = text;
    el.className = 'rules-status__text ' + kind;
  }
}

// ============= ДОМЕНЫ ОТКРЫТОЙ СТРАНИЦЫ =============

function matchRoute(domain) {
  const lower = String(domain).toLowerCase();
  const direct = state.data.directList.find(s => s.enabled !== false && hostMatches(lower, s.value));
  if (direct) return { mode: 'direct', rule: direct.value };
  const proxy = state.data.proxyList.find(s => s.enabled !== false && hostMatches(lower, s.value));
  if (proxy) return { mode: 'proxy', rule: proxy.value };
  return { mode: null, rule: null };
}

function syncPageDomainRules() {
  const domains = state.pageDomains;
  if (!domains || domains.loading || domains.error) return;

  domains.items.forEach(item => {
    const matched = matchRoute(item.domain);
    const hasPendingChoice = item.mode !== item.initialMode;
    item.rule = matched.rule;
    item.initialMode = matched.mode;
    if (!hasPendingChoice) item.mode = matched.mode;
  });
}

function domainsFromResponse(response) {
  const domains = [response.mainDomain];
  (response.relatedDomains || []).forEach(domain => {
    if (!domains.includes(domain)) domains.push(domain);
  });
  return domains;
}

function mergePageDomains(domains, mainDomain, collecting) {
  const current = state.pageDomains;
  const samePage = Boolean(current && !current.loading && !current.error && current.mainDomain === mainDomain);
  const previous = samePage ? current.items : [];
  const previousByDomain = new Map(previous.map(item => [item.domain, item]));

  const nextItems = domains.slice(0, 80).map(domain => {
    const matched = matchRoute(domain);
    const existing = previousByDomain.get(domain);
    if (existing) {
      const hasPendingChoice = existing.mode !== existing.initialMode;
      existing.rule = matched.rule;
      existing.initialMode = matched.mode;
      if (!hasPendingChoice) existing.mode = matched.mode;
      return existing;
    }
    return {
      domain,
      mode: matched.mode,
      initialMode: matched.mode,
      rule: matched.rule
    };
  });

  const changed = !samePage ||
    !current ||
    current.collecting !== (collecting === true) ||
    current.items.length !== nextItems.length ||
    current.items.some((item, index) => {
      const next = nextItems[index];
      return !next ||
        item.domain !== next.domain ||
        item.mode !== next.mode ||
        item.initialMode !== next.initialMode ||
        item.rule !== next.rule;
    });

  state.pageDomains = {
    loading: false,
    mainDomain,
    items: nextItems,
    error: '',
    collecting: collecting === true,
    result: samePage && current ? current.result : null
  };

  if (changed) renderPageRules();
}

function loadPageDomains() {
  if (state.pageDomains && state.pageDomains.loading) return;
  const previous = state.pageDomains;

  state.pageDomains = {
    loading: true,
    mainDomain: previous ? previous.mainDomain : null,
    items: previous ? previous.items : [],
    error: '',
    collecting: previous ? previous.collecting : false,
    result: previous ? previous.result : null
  };
  renderPageRules();

  chrome.runtime.sendMessage({ action: 'getRelatedDomains' }, (response) => {
    const error = chrome.runtime.lastError;

    if (error || !response) {
      state.pageDomains = {
        loading: false,
        mainDomain: null,
        items: [],
        error: 'Не удалось получить домены вкладки',
        collecting: false,
        result: null
      };
      renderPageRules();
      return;
    }

    if (!response.mainDomain) {
      state.pageDomains = {
        loading: false,
        mainDomain: null,
        items: [],
        error: 'Откройте обычную страницу, чтобы увидеть её домены',
        collecting: false,
        result: null
      };
      renderPageRules();
      return;
    }

    mergePageDomains(
      domainsFromResponse(response),
      response.mainDomain,
      response.collecting
    );
  });
}

function refreshPageDomainsSilently() {
  if (state.domainsRefreshing || !state.pageDomains || state.pageDomains.loading) return;
  state.domainsRefreshing = true;

  chrome.runtime.sendMessage({ action: 'getRelatedDomains' }, (response) => {
    state.domainsRefreshing = false;
    const error = chrome.runtime.lastError;
    if (error || !response || !response.mainDomain) return;

    mergePageDomains(
      domainsFromResponse(response),
      response.mainDomain,
      response.collecting
    );
  });
}

function pageDomainsSummary() {
  const domains = state.pageDomains;
  if (!domains) return 'Собираем домены…';
  if (domains.loading) return 'Собираем домены…';
  if (domains.error) return 'Нет данных о доменах';
  if (!domains.items.length) return 'Домены не найдены';

  const count = domains.items.length;
  const withRule = domains.items.filter(item => item.rule).length;
  return `${domains.mainDomain}, ${count} ${pluralDomains(count)}${withRule ? `, ${withRule} в правилах` : ''}`;
}

function renderPageRules() {
  const domains = state.pageDomains;
  const summary = $('pageRulesSummary');
  const list = $('pageRulesList');
  const actions = $('pageRulesActions');
  const refresh = $('refreshDomainsBtn');

  if (refresh) {
    refresh.disabled = Boolean(domains && domains.loading);
    refresh.textContent = domains && domains.loading ? 'Собираем…' : 'Обновить';
  }

  if (summary) summary.textContent = pageDomainsSummary();
  list.innerHTML = '';
  actions.hidden = true;

  if (!domains || domains.loading) {
    list.appendChild(makePageNote('Смотрим, какие домены загружает вкладка…'));
    return;
  }

  if (domains.error) {
    list.appendChild(makePageNote(domains.error));
    return;
  }

  if (!domains.items.length) {
    list.appendChild(makePageNote('Доменов не найдено. Обновите страницу и попробуйте ещё раз.'));
    return;
  }

  if (domains.collecting) {
    list.appendChild(makePageNote('Часть доменов могла не собраться. Обновите страницу и нажмите «Обновить».'));
  }

  domains.items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'page-rule-row';

    const name = document.createElement('span');
    name.className = 'page-rule-domain';
    name.textContent = item.domain;
    name.title = item.domain + (item.rule ? ` (правило: ${item.rule})` : '');

    const group = document.createElement('div');
    group.className = 'analysis-seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Маршрут для ${item.domain}`);

    ['proxy', 'direct'].forEach(mode => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'analysis-seg__btn' + (item.mode === mode ? ` is-${mode}` : '');
      button.textContent = mode === 'proxy' ? 'В прокси' : 'Напрямую';
      button.setAttribute('aria-pressed', item.mode === mode ? 'true' : 'false');
      button.addEventListener('click', () => {
        item.mode = item.mode === mode ? null : mode;
        renderPageRules();
      });
      group.appendChild(button);
    });

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'analysis-seg__btn analysis-seg__btn--clear' +
      (item.mode === null && item.initialMode !== null ? ' is-active' : '');
    clear.textContent = '×';
    clear.title = 'Убрать правило для этого домена';
    clear.setAttribute('aria-label', `Убрать правило для ${item.domain}`);
    clear.disabled = item.mode === null && item.initialMode === null;
    clear.addEventListener('click', () => {
      item.mode = null;
      renderPageRules();
    });
    group.appendChild(clear);

    row.appendChild(name);
    row.appendChild(group);
    list.appendChild(row);
  });

  const changes = domains.items.filter(item => item.mode !== item.initialMode).length;
  actions.hidden = false;
  const apply = $('applyDomainsBtn');
  const reset = $('resetDomainsBtn');
  apply.disabled = changes === 0;
  apply.textContent = changes ? `Применить (${changes})` : 'Применить';
  reset.disabled = changes === 0;

  if (domains.result) {
    list.appendChild(makePageNote(domains.result.text, domains.result.conflicts.length ? 'warn' : 'ok'));
  }
}

function makePageNote(text, kind) {
  const note = document.createElement('div');
  note.className = 'page-rule-note' + (kind ? ` page-rule-note--${kind}` : '');
  note.textContent = text;
  return note;
}

function applyPageDomains() {
  const domains = state.pageDomains;
  if (!domains || domains.loading) return;
  const changed = domains.items.filter(item => item.mode !== item.initialMode);
  if (!changed.length) return;

  chrome.storage.local.get(['proxyList', 'directList'], (data) => {
    const changes = changed.map(item => ({ domain: item.domain, mode: item.mode }));
    const result = applyRuleChanges(data.proxyList, data.directList, changes);

    chrome.storage.local.set({ proxyList: result.proxyList, directList: result.directList }, () => {
      const parts = [];
      if (result.removed) parts.push(`удалено ${result.removed}`);
      if (result.addedProxy) parts.push(`в прокси ${result.addedProxy}`);
      if (result.addedDirect) parts.push(`напрямую ${result.addedDirect}`);

      let text = parts.length
        ? `Готово: ${parts.join(', ')}.`
        : 'Точных правил для выбранных доменов не было.';

      if (result.conflicts.length) {
        text += ` Пропущено ${result.conflicts.length}: домен уже в «Напрямую» по правилу ${result.conflicts.slice(0, 2).join(', ')}${result.conflicts.length > 2 ? '…' : ''}.`;
      }
      if (result.remaining.length) {
        text += ` Осталось по общему правилу: ${result.remaining.slice(0, 2).join(', ')}${result.remaining.length > 2 ? '…' : ''}.`;
      }

      const warnings = result.conflicts.concat(result.remaining);
      domains.result = { conflicts: warnings, text };
      showToast(text, warnings.length ? 'info' : 'success');

      loadData({
        after: () => {
          domains.items.forEach(item => {
            const matched = matchRoute(item.domain);
            item.mode = matched.mode;
            item.initialMode = matched.mode;
            item.rule = matched.rule;
          });
          renderRulesStatus();
          renderPageRules();
        }
      });
    });
  });
}

$('applyDomainsBtn').addEventListener('click', applyPageDomains);
$('resetDomainsBtn').addEventListener('click', () => {
  if (!state.pageDomains) return;
  state.pageDomains.result = null;
  state.pageDomains.items.forEach(item => { item.mode = item.initialMode; });
  renderPageRules();
});

// ============= ОБНОВЛЕНИЕ ИЗ STORAGE =============

let refreshTimer = null;
let lastConfigKey = '';

function currentConfigKey() {
  const data = state.data;
  return JSON.stringify([
    data.extensionEnabled,
    data.activeProxyId,
    data.proxies.map(p => [p.id, p.host, p.port, p.type, p.enabled !== false])
  ]);
}

const scheduleRefresh = debounce(() => {
  const before = lastConfigKey;
  chrome.storage.local.get(
    ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled', 'lastIssue'],
    (data) => {
      state.data.proxyList = (Array.isArray(data.proxyList) ? data.proxyList : []).filter(item => item && typeof item === 'object');
      state.data.directList = (Array.isArray(data.directList) ? data.directList : []).filter(item => item && typeof item === 'object');
      state.data.proxies = (Array.isArray(data.proxies) ? data.proxies : []).filter(item => item && typeof item === 'object');
      state.data.activeProxyId = data.activeProxyId == null ? null : data.activeProxyId;
      state.data.extensionEnabled = data.extensionEnabled !== false;
      state.data.autoProxyEnabled = data.autoProxyEnabled !== false;
      state.data.killSwitchEnabled = data.killSwitchEnabled === true;
      state.lastIssue = data.lastIssue && typeof data.lastIssue === 'object' ? data.lastIssue : null;

      lastConfigKey = currentConfigKey();
      render();
      renderIssue();
      syncPageDomainRules();
      renderRulesStatus();
      renderPageRules();

      if (before !== lastConfigKey) {
        state.probe = null;
        state.probeToken++;
        state.probing = false;
        if (state.probeTimer) { clearTimeout(state.probeTimer); state.probeTimer = null; }
        probe();
      }
    }
  );
}, 250);

chrome.storage.onChanged.addListener((changes) => {
  const relevant = ['proxyList', 'directList', 'proxies', 'activeProxyId', 'extensionEnabled', 'autoProxyEnabled', 'killSwitchEnabled', 'lastIssue'];
  if (relevant.some(key => changes[key])) scheduleRefresh();
});

// ============= СТАРТ =============

lastConfigKey = currentConfigKey();
loadData({ probe: true });

state.domainsPollTimer = setInterval(() => {
  if (!document.hidden) refreshPageDomainsSilently();
}, 3000);

window.addEventListener('pagehide', () => {
  if (state.domainsPollTimer) {
    clearInterval(state.domainsPollTimer);
    state.domainsPollTimer = null;
  }
});
