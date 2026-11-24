import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../shared.js', import.meta.url), 'utf8');
const sandbox = {
  URL,
  console,
  setTimeout,
  clearTimeout,
  crypto: globalThis.crypto,
  chrome: {
    storage: {
      local: {
        get() {},
        set() {}
      }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {}
    }
  }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const {
  normalizeRuleValue,
  isValidDomain,
  normalizeDomain,
  hostMatches,
  buildProxyReturnChain,
  generatePAC,
  findProxyForAuthChallenge,
  isAutoProxyCandidate,
  normalizeProxyType,
  displayProxyType,
  isValidProxyHost,
  isValidPort,
  proxyToPacString,
  applyRuleChanges
} = sandbox;

const proxy = (overrides) => ({
  id: 'p1',
  name: 'Test',
  host: '127.0.0.1',
  port: 1080,
  type: 'SOCKS5',
  enabled: true,
  ...overrides
});

const rule = (value) => ({ id: value, value, enabled: true });

test('normalizeRuleValue keeps paths and normalizes URLs', () => {
  assert.equal(normalizeRuleValue('Google.COM'), 'google.com');
  assert.equal(normalizeRuleValue('  example.com  '), 'example.com');
  assert.equal(normalizeRuleValue('example.com/'), 'example.com');
  assert.equal(normalizeRuleValue('https://Example.com/watch?v=AbC'), 'example.com/watch?v=abc');
  assert.equal(normalizeRuleValue('.example.com'), '*.example.com');
  assert.equal(normalizeRuleValue('http://*.example.com/path'), '*.example.com/path');
  assert.equal(normalizeRuleValue('https://пример.рф/путь'), 'xn--e1afmkfd.xn--p1ai/%d0%bf%d1%83%d1%82%d1%8c');
  assert.equal(normalizeRuleValue('has space.com'), '');
  assert.equal(normalizeRuleValue('   '), '');
});

test('isValidDomain accepts domains, wildcards and URL paths', () => {
  assert.equal(isValidDomain('example.com'), true);
  assert.equal(isValidDomain('*.example.com'), true);
  assert.equal(isValidDomain('cdn*.example.com'), true);
  assert.equal(isValidDomain('example.com/path?x=1'), true);
  assert.equal(isValidDomain('/api'), false);
  assert.equal(isValidDomain('*'), false);
  assert.equal(isValidDomain('*.'), false);
  assert.equal(isValidDomain('bad domain.com'), false);
  assert.equal(isValidDomain('999.999.999.999'), false);
  assert.equal(isValidDomain('192.168.1.1'), true);
});

test('normalizeDomain only collapses clearly dynamic subdomains', () => {
  assert.equal(normalizeDomain('cdn3.example.com'), '*.example.com');
  assert.equal(normalizeDomain('static1.example.co.uk'), '*.example.co.uk');
  assert.equal(normalizeDomain('mail.google.com'), 'mail.google.com');
  assert.equal(normalizeDomain('docs.google.com'), 'docs.google.com');
  assert.equal(normalizeDomain('EXAMPLE.com.'), 'example.com');
  assert.equal(normalizeDomain('a1b2c3d4e5f6.example.com'), '*.example.com');
});

test('hostMatches follows direct-then-proxy rules', () => {
  assert.equal(hostMatches('google.com', 'google.com'), true);
  assert.equal(hostMatches('mail.google.com', 'google.com'), true);
  assert.equal(hostMatches('notgoogle.com', 'google.com'), false);
  assert.equal(hostMatches('google.com', '*.google.com'), true);
  assert.equal(hostMatches('mail.google.com', '*.google.com'), true);
  assert.equal(hostMatches('evil-google.com', '*.google.com'), false);
  assert.equal(hostMatches('yandex.ru', '*.ru'), true);
  assert.equal(hostMatches('yandex.ru', '*.ru'), true);
  assert.equal(hostMatches('example.com', 'example.com/path', 'https://example.com/path?x=1'), true);
  assert.equal(hostMatches('example.com', 'example.com/path', 'https://example.com/other'), false);
  assert.equal(hostMatches('example.com', '/api', 'https://example.com/api/x'), true);
  assert.equal(hostMatches('example.com', '/api', 'https://example.com/other'), false);
  assert.equal(hostMatches('example.com', 'example.com', '') , true);
  assert.equal(hostMatches('api.example.com', '*api.example.com'), true);
});

test('buildProxyReturnChain puts the active proxy first and deduplicates', () => {
  const proxies = [
    proxy({ id: 'a', name: 'A', host: 'a.test', port: 1, type: 'SOCKS5' }),
    proxy({ id: 'b', name: 'B', host: 'b.test', port: 2, type: 'PROXY' }),
    proxy({ id: 'c', name: 'C', host: 'a.test', port: 1, type: 'SOCKS5' }),
    proxy({ id: 'd', name: 'D', host: '', port: 3, type: 'SOCKS5' }),
    proxy({ id: 'e', name: 'E', host: 'e.test', port: 4, type: 'UNKNOWN' })
  ];
  const chain = buildProxyReturnChain(proxies, proxies[1], false);
  assert.equal(chain, 'PROXY b.test:2; SOCKS5 a.test:1; DIRECT');
  assert.equal(buildProxyReturnChain(proxies, proxies[1], true), 'PROXY b.test:2; SOCKS5 a.test:1');
  assert.equal(buildProxyReturnChain([], null, false), null);
  assert.equal(buildProxyReturnChain([proxy({ enabled: false })], null, false), null);
});

test('PAC puts direct rules first, proxy rules second and keeps kill switch blocking', () => {
  const config = {
    proxies: [
      proxy({ id: 'a', host: 'a.test', port: 1080, type: 'SOCKS5' }),
      proxy({ id: 'b', host: 'b.test', port: 8080, type: 'PROXY' })
    ],
    activeProxyId: 'b',
    directList: [rule('direct.test')],
    proxyList: [rule('proxied.test')],
    killSwitchEnabled: false
  };
  const pac = generatePAC(config);
  const directIndex = pac.indexOf('direct.test');
  const proxyIndex = pac.indexOf('proxied.test');
  assert.ok(directIndex !== -1 && proxyIndex !== -1);
  assert.ok(directIndex < proxyIndex, 'direct rules must be checked before proxy rules');
  assert.match(pac, /return "PROXY b\.test:8080; SOCKS5 a\.test:1080; DIRECT"/);
  assert.match(pac, /return "PROXY b\.test:8080"/, 'IP check must use only the active proxy');
  assert.match(pac, /return "DIRECT";\n}$/);

  const blocked = generatePAC({ ...config, killSwitchEnabled: true });
  assert.match(blocked, /return "PROXY 0\.0\.0\.0:0";\n}$/);
  assert.doesNotMatch(blocked, /SOCKS5 a\.test:1080; DIRECT/);
});

test('PAC escapes hostile rule content and skips invalid rules', () => {
  const config = {
    proxies: [proxy({ type: 'SOCKS5' })],
    activeProxyId: 'p1',
    directList: [rule('example.com/path"quoted')],
    proxyList: [rule('*.example.org'), rule('not a domain'), rule('bad\\path')],
    killSwitchEnabled: false
  };
  const pac = generatePAC(config);
  assert.doesNotMatch(pac, /not a domain/);
  assert.ok(pac.includes('example.org'));
  // Строка не должна разорвать PAC-скрипт кавычкой из правила.
  assert.doesNotThrow(() => new vm.Script(pac));
});

test('PAC without configured proxies is direct, or blocked when kill switch is on', () => {
  const direct = generatePAC({ proxies: [], activeProxyId: null, directList: [], proxyList: [] });
  assert.match(direct, /return "DIRECT";\n}$/);
  const kill = generatePAC({ proxies: [], activeProxyId: null, directList: [], proxyList: [], killSwitchEnabled: true });
  assert.match(kill, /return "PROXY 0\.0\.0\.0:0";\n}$/);
});

test('generated PAC routes real URLs correctly', () => {
  const config = {
    proxies: [
      proxy({ id: 'a', host: 'a.test', port: 1080, type: 'SOCKS5' }),
      proxy({ id: 'b', host: 'b.test', port: 8080, type: 'PROXY' })
    ],
    activeProxyId: 'a',
    directList: [rule('direct.test'), rule('example.com/private')],
    proxyList: [rule('proxied.test'), rule('*.blocked.test'), rule('other.test/api'), rule('api.ipify.org')],
    killSwitchEnabled: false
  };
  const sandbox = {};
  vm.runInNewContext(generatePAC(config), sandbox);
  const proxyFor = sandbox.FindProxyForURL;
  const chain = 'SOCKS5 a.test:1080; PROXY b.test:8080; DIRECT';

  assert.equal(proxyFor('https://direct.test/page', 'direct.test'), 'DIRECT');
  assert.equal(proxyFor('https://example.com/private/x', 'example.com'), 'DIRECT');
  assert.equal(proxyFor('https://proxied.test/x', 'proxied.test'), chain);
  assert.equal(proxyFor('https://sub.blocked.test/x', 'sub.blocked.test'), chain);
  assert.equal(proxyFor('https://other.test/api/v1', 'other.test'), chain);
  assert.equal(proxyFor('https://other.test/other', 'other.test'), 'DIRECT');
  assert.equal(
    proxyFor('https://api.ipify.org/?format=json', 'api.ipify.org'),
    'SOCKS5 a.test:1080'
  );

  const killSwitch = {};
  vm.runInNewContext(generatePAC({ ...config, killSwitchEnabled: true }), killSwitch);
  assert.equal(killSwitch.FindProxyForURL('https://unmatched.test/', 'unmatched.test'), 'PROXY 0.0.0.0:0');
  assert.equal(killSwitch.FindProxyForURL('https://direct.test/', 'direct.test'), 'DIRECT');
  assert.equal(
    killSwitch.FindProxyForURL('https://proxied.test/', 'proxied.test'),
    'SOCKS5 a.test:1080; PROXY b.test:8080'
  );
});

test('auth credentials only go to the matching proxy', () => {
  const proxies = [
    proxy({ id: 'a', host: 'a.test', port: 1080, username: 'user-a', password: 'pass-a' }),
    proxy({ id: 'b', host: 'b.test', port: 8080, username: 'user-b', password: 'pass-b', type: 'PROXY' })
  ];
  const exact = findProxyForAuthChallenge({ host: 'b.test', port: 8080 }, proxies, 'a');
  assert.equal(exact.id, 'b');
  const byUniquePort = findProxyForAuthChallenge({ host: '10.0.0.9', port: 8080 }, proxies, 'a');
  assert.equal(byUniquePort.id, 'b');
  assert.equal(findProxyForAuthChallenge({ host: 'unknown.test', port: 1 }, proxies, 'a'), null);

  const single = [proxy({ username: 'only', password: 'secret' })];
  assert.equal(findProxyForAuthChallenge({ host: '10.0.0.1', port: 3128 }, single, null).username, 'only');

  const noCredentials = proxies.map(p => ({ ...p, username: '', password: '' }));
  assert.equal(findProxyForAuthChallenge({ host: 'a.test', port: 1080 }, noCredentials, 'a'), null);
});

test('SOCKS auth limitation is visible to callers', () => {
  assert.equal(normalizeProxyType('socks4'), 'SOCKS');
  assert.equal(normalizeProxyType('http'), 'PROXY');
  assert.equal(normalizeProxyType('nonsense'), null);
  assert.equal(displayProxyType('SOCKS'), 'SOCKS4');
  assert.equal(displayProxyType('PROXY'), 'HTTP');
  assert.equal(displayProxyType('HTTPS'), 'HTTPS');
  assert.equal(isAutoProxyCandidate('localhost'), false);
  assert.equal(isAutoProxyCandidate('192.168.1.10'), false);
  assert.equal(isAutoProxyCandidate('example.com'), true);
  assert.equal(isValidProxyHost('::1'), true);
  assert.equal(isValidProxyHost('[::1]'), true);
  assert.equal(isValidProxyHost('bad host'), false);
  assert.equal(isValidPort('8080'), true);
  assert.equal(isValidPort('0'), false);
  assert.equal(isValidPort('8080abc'), false);
  assert.equal(isValidPort('80.5'), false);
  assert.equal(proxyToPacString(proxy({ host: '::1', port: 1080 })), 'SOCKS5 [::1]:1080');
});

test('applyRuleChanges removes exact rules when a domain is cleared', () => {
  const result = applyRuleChanges(
    [rule('x.com'), rule('keep.dev')],
    [rule('localhost')],
    [{ domain: 'x.com', mode: null }]
  );

  assert.equal(result.removed, 1);
  assert.deepEqual(result.proxyList.map(s => s.value), ['keep.dev']);
  assert.deepEqual(result.directList.map(s => s.value), ['localhost']);
  assert.equal(result.addedProxy, 0);
  assert.equal(result.addedDirect, 0);
  assert.deepEqual([...result.remaining], []);
});

test('applyRuleChanges warns when a cleared domain is still covered by a wildcard', () => {
  const result = applyRuleChanges(
    [rule('x.com'), rule('*.x.com')],
    [],
    [{ domain: 'x.com', mode: null }]
  );

  assert.equal(result.removed, 1);
  assert.equal(result.proxyList.some(s => s.value === '*.x.com'), true);
  assert.equal(result.remaining.length, 1);
  assert.match(result.remaining[0], /x\.com \(\*\.x\.com\)/);
});

test('applyRuleChanges moves an exact rule between lists', () => {
  const result = applyRuleChanges(
    [rule('x.com')],
    [],
    [{ domain: 'x.com', mode: 'direct' }]
  );

  assert.equal(result.removed, 1);
  assert.equal(result.addedDirect, 1);
  assert.equal(result.proxyList.length, 0);
  assert.deepEqual(result.directList.map(s => s.value), ['x.com']);
});

test('applyRuleChanges does not add a proxy rule blocked by a direct wildcard', () => {
  const result = applyRuleChanges(
    [],
    [rule('*.corp.dev')],
    [{ domain: 'a.corp.dev', mode: 'proxy' }]
  );

  assert.equal(result.addedProxy, 0);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0], /a\.corp\.dev \(\*\.corp\.dev\)/);
});
