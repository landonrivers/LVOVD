'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const app = require('./app-server');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function configuredAllowedHosts() {
  const allowed = new Set(LOOPBACK_HOSTS);
  const configured = normalizeHostname(HOST);
  if (configured && !WILDCARD_HOSTS.has(configured)) allowed.add(configured);

  for (const value of String(process.env.LVOVD_ALLOWED_HOSTS || '').split(',')) {
    const hostname = normalizeHostname(value);
    if (hostname) allowed.add(hostname);
  }
  return allowed;
}

function parseAuthority(value, protocol = 'http:') {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(`${protocol}//${value.trim()}`);
    return {
      hostname: normalizeHostname(parsed.hostname),
      port: parsed.port || (protocol === 'https:' ? '443' : '80')
    };
  } catch {
    return null;
  }
}

function isAllowedHostHeader(hostHeader) {
  const authority = parseAuthority(hostHeader);
  if (!authority) return false;
  return configuredAllowedHosts().has(authority.hostname) && authority.port === String(PORT);
}

function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  if (originHeader === 'null') return false;

  try {
    const parsed = new URL(originHeader);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = normalizeHostname(parsed.hostname);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return configuredAllowedHosts().has(hostname) && port === String(PORT);
  } catch {
    return false;
  }
}

function isAllowedFetchSite(fetchSite) {
  if (!fetchSite) return true;
  return fetchSite === 'same-origin' || fetchSite === 'none';
}

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function rejectRequest(res, statusCode, message) {
  const body = `${message}\n`;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);

  if (!isAllowedHostHeader(req.headers.host)) {
    return rejectRequest(res, 403, 'LVOVD rejected an unexpected Host header.');
  }

  if (!isAllowedFetchSite(req.headers['sec-fetch-site'])) {
    return rejectRequest(res, 403, 'LVOVD rejected a cross-site browser request.');
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    return rejectRequest(res, 403, 'LVOVD rejected an unexpected request origin.');
  }

  app.server.emit('request', req, res);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`LVOVD running at http://${HOST}:${PORT}`);
    console.log(`Node ${process.version}`);
    console.log('Local request hardening is enabled (Host, Origin, Fetch Metadata, CSP, anti-framing).');
    if (WILDCARD_HOSTS.has(normalizeHostname(HOST)) && !process.env.LVOVD_ALLOWED_HOSTS) {
      console.log('Warning: HOST is a wildcard, but remote Host headers remain blocked until LVOVD_ALLOWED_HOSTS is set.');
    }
    console.log('FFmpeg is expected on PATH. All media processing runs locally on this computer.');
    console.log('Only download media you own or have permission to download.');
  });
}

module.exports = {
  ...app,
  server,
  security: {
    SECURITY_HEADERS,
    configuredAllowedHosts,
    isAllowedHostHeader,
    isAllowedOrigin,
    isAllowedFetchSite,
    normalizeHostname
  }
};
