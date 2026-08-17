'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MIN_NODE_MAJOR = 22;
const STARTUP_TIMEOUT_MS = 120000;

function nodeMajor(version = process.versions.node) {
  return Number(String(version || '').split('.')[0]);
}

function localUrl(portValue = process.env.PORT || 3000) {
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'http://127.0.0.1:3000';
  return `http://127.0.0.1:${port}`;
}

function localhostUrl(url) {
  return String(url).replace('://127.0.0.1:', '://localhost:');
}

function readyMessage(url) {
  return [
    'LVOVD is ready.',
    `Open LVOVD: ${url}`,
    `Or: ${localhostUrl(url)}`
  ].join('\n');
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    shell: false
  });
  return !result.error && result.status === 0;
}

function announceWhenReady(url, serverChild) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const probe = () => {
    if (serverChild.exitCode !== null || serverChild.signalCode) return;
    const request = http.get(url, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode < 500) {
        console.log('');
        console.log(readyMessage(url));
        console.log('');
        return;
      }
      if (Date.now() < deadline) setTimeout(probe, 250);
    });
    request.setTimeout(750, () => request.destroy());
    request.on('error', () => {
      if (Date.now() < deadline) setTimeout(probe, 250);
    });
  };
  setTimeout(probe, 200);
}

function fail(message) {
  console.error('');
  console.error(`LVOVD could not start: ${message}`);
  console.error('See the Quick Start section in README.md for setup help.');
}

function main() {
  process.chdir(ROOT);

  if (nodeMajor() < MIN_NODE_MAJOR) {
    fail(`Node.js ${MIN_NODE_MAJOR} or newer is required. This computer is using Node ${process.versions.node}.`);
    return 1;
  }

  if (!commandWorks('ffmpeg', ['-version'])) {
    fail('FFmpeg is not installed or is not available on PATH.');
    return 1;
  }

  const url = localUrl();
  console.log('Starting LVOVD...');
  console.log('On first run, LVOVD downloads and verifies the official yt-dlp binary. Later starts reuse the verified local copy.');
  console.log('Keep this terminal window open while using LVOVD. Closing it stops the server.');
  console.log('Press Ctrl+C to stop LVOVD.');
  console.log('');

  const serverChild = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
    shell: false
  });

  serverChild.on('error', (error) => {
    fail(error.message);
    process.exitCode = 1;
  });

  serverChild.on('exit', (code, signal) => {
    if (signal) process.exitCode = 0;
    else process.exitCode = Number.isInteger(code) ? code : 1;
  });

  announceWhenReady(url, serverChild);
  return 0;
}

if (require.main === module) {
  const result = main();
  if (result) process.exitCode = result;
}

module.exports = {
  MIN_NODE_MAJOR,
  STARTUP_TIMEOUT_MS,
  localUrl,
  localhostUrl,
  nodeMajor,
  readyMessage
};
