import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sharedSource = fs.readFileSync(new URL('../shared.js', import.meta.url), 'utf8');
const backgroundSource = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    emit(...args) { listeners.forEach(fn => fn(...args)); }
  };
}

const store = {};
let proxyValue = { mode: 'direct' };
const appliedProxyValues = [];
let lastMessageListener = null;
let runtimeLastError = null;
let activeTabUrl = 'https://example.com/page';

function readKeys(keys) {
  if (keys == null) return { ...store };
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const out = {};
    keys.forEach(key => { out[key] = store[key]; });
    return out;
  }
  const out = {};
  Object.keys(keys).forEach(key => { out[key] = store[key] !== undefined ? store[key] : keys[key]; });
  return out;
}

const events = {
  installed: makeEvent(),
  startup: makeEvent(),
  message: makeEvent(),
  storageChanged: makeEvent(),
  beforeRequest: makeEvent(),
  errorOccurred: makeEvent(),
  completed: makeEvent(),
  authRequired: makeEvent(),
  navigationError: makeEvent(),
  tabRemoved: makeEvent(),
  tabReplaced: makeEvent(),
  contextClicked: makeEvent(),
  alarm: makeEvent(),
  proxyError: makeEvent()
};

const chrome = {
  runtime: {
    get lastError() { return runtimeLastError; },
    onInstalled: events.installed,
    onStartup: events.startup,
    onMessage: events.message,
    getManifest: () => ({ version: '0.8.0' }),
    getURL: path => 'chrome-extension://test/' + path
  },
  storage: {
    local: {
      get(keys, cb) { setTimeout(() => cb(readKeys(keys)), 0); },
      set(values, cb) { Object.assign(store, values); setTimeout(() => cb && cb(), 0); }
    },
    session: {
      get(keys, cb) { setTimeout(() => cb(readKeys(keys)), 0); },
      set(values, cb) { Object.assign(store, values); setTimeout(() => cb && cb(), 0); }
    },
    onChanged: events.storageChanged
  },
  proxy: {
    settings: {
      get(_options, cb) { setTimeout(() => cb({ value: proxyValue }), 0); },
      set(options, cb) {
        proxyValue = options.value;
        appliedProxyValues.push(options.value);
        setTimeout(() => cb && cb(), 0);
      }
    },
    onProxyError: events.proxyError
  },
  webRequest: {
    onBeforeRequest: events.beforeRequest,
    onErrorOccurred: events.errorOccurred,
    onCompleted: events.completed,
    onAuthRequired: events.authRequired
  },
  webNavigation: { onErrorOccurred: events.navigationError },
  tabs: {
    query(_query, cb) {
      setTimeout(() => cb([{ id: 7, url: activeTabUrl }]), 0);
    },
    reload(_tabId, _options, cb) { setTimeout(() => cb && cb(), 0); },
    update(_tabId, _options, cb) { setTimeout(() => cb && cb(), 0); },
    create() {},
    onRemoved: events.tabRemoved,
    onReplaced: events.tabReplaced
  },
  action: {
    setBadgeText() {},
    setBadgeBackgroundColor() {},
    setTitle() {}
  },
  contextMenus: {
    removeAll(cb) { setTimeout(() => cb && cb(), 0); },
    create() {},
    onClicked: events.contextClicked
  },
  notifications: { create() {} },
  privacy: {
    network: {
      webRTCIPHandlingPolicy: {
        set(_value, cb) { setTimeout(() => cb && cb(), 0); },
        get(_options, cb) { setTimeout(() => cb({ value: 'default' }), 0); }
      }
    }
  },
  alarms: {
    create() {},
    clear(_name, cb) { if (cb) setTimeout(() => cb(), 0); },
    onAlarm: events.alarm
  }
};

const sandbox = {
  chrome,
  console,
  URL,
  URLSearchParams,
  AbortSignal,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ip: '203.0.113.7' })
  }),
  importScripts() {}
};
vm.createContext(sandbox);
vm.runInContext(sharedSource, sandbox);
vm.runInContext(backgroundSource, sandbox);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    const listener = events.message.listeners[events.message.listeners.length - 1];
    if (!listener) { reject(new Error('No message listener')); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) reject(new Error('Message timeout')); }, 3000);
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const keepOpen = listener(payload, {}, done);
    if (keepOpen !== true && !settled) {
      // listener ответит асинхронно; ждём timeout
    }
  });
}

test('background starts, applies PAC and answers auth challenges', async () => {
  store.proxies = [{
    id: 'p1', name: 'Main', host: '127.0.0.1', port: 1080,
    type: 'SOCKS5', enabled: true, username: 'user', password: 'secret'
  }];
  store.activeProxyId = 'p1';
  store.proxyList = [{ id: 'r1', value: 'example.com', enabled: true }];
  store.directList = [{ id: 'r2', value: 'direct.test', enabled: true }];
  store.extensionEnabled = true;
  store.autoProxyEnabled = true;
  store.killSwitchEnabled = false;

  await delay(100);

  assert.ok(appliedProxyValues.length > 0, 'PAC should be applied on startup');
  const pac = proxyValue.pacScript.data;
  assert.match(pac, /SOCKS5 127\.0\.0\.1:1080/);
  assert.match(pac, /example\.com/);

  const authListener = events.authRequired.listeners[0];
  assert.ok(authListener, 'auth listener should be registered');
  const credentials = await new Promise(resolve => {
    authListener({ isProxy: true, challenger: { host: '127.0.0.1', port: 1080 } }, resolve);
  });
  assert.equal(credentials.authCredentials.username, 'user');
  assert.equal(credentials.authCredentials.password, 'secret');

  events.beforeRequest.emit({
    url: 'https://example.com/page', tabId: 7, type: 'main_frame', requestId: '1'
  });
  await delay(50);

  const stats = await sendMessage({ action: 'getStats' });
  assert.equal(stats.stats.proxy, 1);
  assert.equal(stats.stats.direct, 0);

  const status = await sendMessage({ action: 'getProxyStatus' });
  assert.equal(status.extensionEnabled, true);
  assert.equal(status.activeProxy.id, 'p1');
  assert.equal(status.configuredProxyCount, 1);
});

test('proxy test returns IP and restores the normal PAC', async () => {
  const result = await sendMessage({ action: 'testProxy', proxyId: 'p1' });
  assert.equal(result.success, true);
  assert.equal(result.ip, '203.0.113.7');
  assert.ok(result.latencyMs >= 0);

  await delay(50);
  const restored = proxyValue.pacScript && proxyValue.pacScript.data;
  assert.match(restored, /example\.com/);
  assert.doesNotMatch(restored, /^function FindProxyForURL\(url, host\)\{if\(host==="api\.ipify\.org"/);
});

test('proxy test sees a proxy saved immediately before the message', async () => {
  store.proxies = [
    ...store.proxies,
    {
      id: 'p2', name: 'Fresh', host: '127.0.0.1', port: 1081,
      type: 'PROXY', enabled: true, username: '', password: ''
    }
  ];

  const result = await sendMessage({ action: 'testProxy', proxyId: 'p2' });
  assert.equal(result.success, true);
  assert.equal(result.ip, '203.0.113.7');

  const status = await sendMessage({ action: 'getProxyStatus' });
  assert.equal(status.proxyCount, 2);
  assert.equal(status.configuredProxyCount, 2);
});

test('related domains are scoped to the active tab', async () => {
  const response = await sendMessage({ action: 'getRelatedDomains' });
  assert.equal(response.mainDomain, 'example.com');
  assert.equal(response.relatedDomains.length, 0);
});

test('related domains ignore browser and extension pages', async () => {
  activeTabUrl = 'chrome-extension://test/popup.html';
  const response = await sendMessage({ action: 'getRelatedDomains' });
  assert.equal(response.mainDomain, null);
  activeTabUrl = 'https://example.com/page';
});

test('proxy error stores a visible issue reason and can be acknowledged', async () => {
  events.proxyError.emit({ details: 'net::ERR_PROXY_CONNECTION_FAILED', fatal: true });
  await delay(30);

  const status = await sendMessage({ action: 'getProxyStatus' });
  assert.equal(status.lastIssue.kind, 'proxy');
  assert.match(status.lastIssue.message, /не принимает соединение/);
  assert.match(status.lastIssue.detail, /ERR_PROXY_CONNECTION_FAILED/);

  const acknowledged = await sendMessage({ action: 'acknowledgeIssue' });
  assert.equal(acknowledged.success, true);
  await delay(30);

  const after = await sendMessage({ action: 'getProxyStatus' });
  assert.equal(after.lastIssue, null);
});

test('health check switches to a working reserve and records health', async () => {
  store.activeProxyId = 'p1';
  await delay(50);
  const originalFetch = sandbox.fetch;

  sandbox.fetch = async (url) => {
    if (String(url).includes('ipify')) throw new Error('active proxy is down');
    return { ok: true, status: 204, json: async () => ({}) };
  };

  try {
    events.alarm.emit({ name: 'proxyManagerHealth' });
    await delay(1600);

    const status = await sendMessage({ action: 'getProxyStatus' });
    assert.equal(status.activeProxy.id, 'p2');
    assert.equal(store.proxyHealth.p1.status, 'offline');
    assert.equal(store.proxyHealth.p2.status, 'online');
  } finally {
    sandbox.fetch = originalFetch;
  }
});
