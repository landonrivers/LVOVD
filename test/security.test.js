process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { security } = require('../server');

const {
  SECURITY_HEADERS,
  configuredAllowedHosts,
  isAllowedHostHeader,
  isAllowedOrigin,
  isAllowedFetchSite
} = security;

test('default allowed hosts stay on loopback', () => {
  const hosts = configuredAllowedHosts();
  assert.equal(hosts.has('127.0.0.1'), true);
  assert.equal(hosts.has('localhost'), true);
  assert.equal(hosts.has('::1'), true);
});

test('Host validation accepts configured localhost authority and rejects unexpected hosts', () => {
  assert.equal(isAllowedHostHeader('127.0.0.1:3000'), true);
  assert.equal(isAllowedHostHeader('localhost:3000'), true);
  assert.equal(isAllowedHostHeader('evil.example:3000'), false);
  assert.equal(isAllowedHostHeader('127.0.0.1:9999'), false);
});

test('Origin validation allows localhost and rejects hostile or opaque origins', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
});

test('Fetch Metadata rejects cross-site browser requests', () => {
  assert.equal(isAllowedFetchSite(undefined), true);
  assert.equal(isAllowedFetchSite('none'), true);
  assert.equal(isAllowedFetchSite('same-origin'), true);
  assert.equal(isAllowedFetchSite('same-site'), false);
  assert.equal(isAllowedFetchSite('cross-site'), false);
});

test('security header set includes anti-framing and restrictive CSP defaults', () => {
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /connect-src 'self'/);
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
});
