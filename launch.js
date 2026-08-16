'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
const MIN_NODE_MAJOR = 22;

function nodeMajor(version = process.versions.node) {
  return Number(String(version || '').split('.')[0]);
}

function localUrl(portValue = process.env.PORT || 3000) {
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'http://127.0.0.1:3000';
  return `http://127.0.0.1:${port}`;
}

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function browserLaunchCommand(platform, url) {
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url}"`] };
  }
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
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

function packageDependenciesReady() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const wanted = lock.packages?.['node_modules/ytdlp-nodejs']?.version;
    const installed = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'node_modules', 'ytdlp-nodejs', 'package.json'),
      'utf8'
    )).version;
    return Boolean(wanted && installed && wanted === installed);
  } catch {
    return false;
  }
}

function installDependencies() {
  console.log('LVOVD dependencies are not installed yet. Installing them now...');
  const result = spawnSync(npmCommand(), ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
    shell: false
  });
  if (result.error || result.status !== 0) {
    throw new Error('npm install did not complete successfully.');
  }
  console.log('LVOVD dependencies are ready.');
  console.log('');
}

function openBrowser(url) {
  const launch = browserLaunchCommand(process.platform, url);
  try {
    const child = spawn(launch.command, launch.args, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The server is still usable if the OS cannot open a browser automatically.
  }
}

function openWhenReady(url, serverChild) {
  const deadline = Date.now() + 15000;
  const probe = () => {
    if (serverChild.exitCode !== null || serverChild.signalCode) return;
    const request = http.get(url, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode < 500) {
        openBrowser(url);
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
  console.error('See the Requirements section in README.md for setup help.');
}

function main() {
  process.chdir(ROOT);

  if (nodeMajor() < MIN_NODE_MAJOR) {
    fail(`Node.js ${MIN_NODE_MAJOR} or newer is required. This computer is using Node ${process.versions.node}.`);
    return 1;
  }

  if (!commandWorks(npmCommand(), ['--version'])) {
    fail('npm is not available. Reinstall a current Node.js LTS release.');
    return 1;
  }

  if (!commandWorks('ffmpeg', ['-version'])) {
    fail('FFmpeg is not installed or is not available on PATH.');
    return 1;
  }

  try {
    if (!packageDependenciesReady()) installDependencies();
  } catch (error) {
    fail(error.message);
    return 1;
  }

  const url = localUrl();
  console.log('Starting LVOVD...');
  console.log(`Your browser should open to ${url}`);
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

  openWhenReady(url, serverChild);
  return 0;
}

if (require.main === module) {
  const result = main();
  if (result) process.exitCode = result;
}

module.exports = {
  MIN_NODE_MAJOR,
  browserLaunchCommand,
  localUrl,
  nodeMajor,
  npmCommand,
  packageDependenciesReady
};