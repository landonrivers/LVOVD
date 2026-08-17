'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = __dirname;
const DEFAULT_CHANNEL = 'nightly';
const CHANNELS = Object.freeze({
  stable: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download',
  nightly: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download'
});
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
]);
const MAX_REDIRECTS = 6;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const CHECKSUM_FILENAME = 'SHA2-256SUMS';
const MANIFEST_FILENAME = 'manifest.json';

function normalizedChannel(value = process.env.LVOVD_YTDLP_CHANNEL || DEFAULT_CHANNEL) {
  const channel = String(value || '').trim().toLowerCase();
  if (!CHANNELS[channel]) throw new Error(`Unsupported yt-dlp channel: ${value}`);
  return channel;
}

function isMuslRuntime(report = process.report?.getReport?.()) {
  if (process.platform !== 'linux') return false;
  return !report?.header?.glibcVersionRuntime;
}

function platformAsset(platform = process.platform, arch = process.arch, musl = isMuslRuntime()) {
  if (platform === 'win32') {
    if (arch === 'x64') return 'yt-dlp.exe';
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
  }
  if (platform === 'darwin') {
    if (arch === 'x64' || arch === 'arm64') return 'yt-dlp_macos';
  }
  if (platform === 'linux') {
    if (musl) {
      if (arch === 'x64') return 'yt-dlp_musllinux';
      if (arch === 'arm64' || arch === 'aarch64') return 'yt-dlp_musllinux_aarch64';
    } else {
      if (arch === 'x64') return 'yt-dlp_linux';
      if (arch === 'arm64' || arch === 'aarch64') return 'yt-dlp_linux_aarch64';
    }
  }
  throw new Error(`No supported yt-dlp standalone binary for ${platform} ${arch}.`);
}

function managedDir(root = ROOT) {
  return path.join(root, '.lvovd-bin');
}

function managedBinaryPath({ root = ROOT, platform = process.platform, arch = process.arch, musl } = {}) {
  return path.join(managedDir(root), platformAsset(platform, arch, musl));
}

function activeBinaryPath(options = {}) {
  if (process.env.YTDLP_PATH) return path.resolve(process.env.YTDLP_PATH);
  return managedBinaryPath(options);
}

function manifestPath(root = ROOT) {
  return path.join(managedDir(root), MANIFEST_FILENAME);
}

function assertAllowedUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'https:') throw new Error('yt-dlp downloads must use HTTPS.');
  if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing unexpected yt-dlp download host: ${url.hostname}`);
  }
  return url;
}

async function fetchWithRedirects(url, { fetchImpl = globalThis.fetch, maxRedirects = MAX_REDIRECTS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Node fetch API is unavailable. Node.js 22+ is required.');
  let current = assertAllowedUrl(url);
  let releaseUrl = /\/releases\/download\//.test(current.pathname) && current.hostname === 'github.com' ? current.toString() : null;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'LVOVD yt-dlp manager',
        Accept: 'application/octet-stream,*/*'
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) throw new Error('Too many redirects while downloading yt-dlp.');
      const location = response.headers.get('location');
      if (!location) throw new Error('yt-dlp download redirect did not include a destination.');
      current = assertAllowedUrl(new URL(location, current));
      if (current.hostname === 'github.com' && /\/releases\/download\//.test(current.pathname)) releaseUrl = current.toString();
      continue;
    }
    if (!response.ok) throw new Error(`yt-dlp download failed with HTTP ${response.status}.`);
    return { response, finalUrl: current.toString(), releaseUrl };
  }
  throw new Error('Too many redirects while downloading yt-dlp.');
}

async function fetchText(url, options = {}) {
  const { response, finalUrl, releaseUrl } = await fetchWithRedirects(url, options);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('yt-dlp checksum file was unexpectedly large.');
  return { text, finalUrl, releaseUrl };
}

function parseChecksumFile(text, assetName) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`Official yt-dlp checksum file did not contain ${assetName}.`);
}

function exactReleaseAssetUrl(checksumFinalUrl, assetName) {
  const url = assertAllowedUrl(checksumFinalUrl);
  if (!url.pathname.endsWith(`/${CHECKSUM_FILENAME}`)) {
    throw new Error('Could not determine the exact yt-dlp release from the checksum URL.');
  }
  url.pathname = `${url.pathname.slice(0, -CHECKSUM_FILENAME.length)}${assetName}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function byteLimit(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new Error('yt-dlp binary download was unexpectedly large.'));
      callback(null, chunk);
    }
  });
}

async function downloadToFile(url, filePath, options = {}) {
  const { response, finalUrl } = await fetchWithRedirects(url, options);
  if (!response.body) throw new Error('yt-dlp download returned no file data.');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BINARY_BYTES) {
    throw new Error('yt-dlp binary download was unexpectedly large.');
  }
  await pipeline(
    Readable.fromWeb(response.body),
    byteLimit(MAX_BINARY_BYTES),
    fs.createWriteStream(filePath, { flags: 'wx' })
  );
  return finalUrl;
}

async function readManifest(root = ROOT) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath(root), 'utf8'));
  } catch {
    return null;
  }
}

async function cachedBinaryStatus({ root = ROOT, platform = process.platform, arch = process.arch, musl } = {}) {
  const binaryPath = managedBinaryPath({ root, platform, arch, musl });
  const manifest = await readManifest(root);
  if (!manifest || manifest.asset !== path.basename(binaryPath) || !/^[a-f0-9]{64}$/i.test(manifest.sha256 || '')) {
    return { valid: false, binaryPath, manifest };
  }
  try {
    const actual = await sha256File(binaryPath);
    return { valid: actual === manifest.sha256.toLowerCase(), binaryPath, manifest, actual };
  } catch {
    return { valid: false, binaryPath, manifest };
  }
}

async function replaceFileAtomically(tempPath, finalPath) {
  const backupPath = `${finalPath}.previous`;
  await fsp.rm(backupPath, { force: true }).catch(() => {});
  let movedExisting = false;
  try {
    try {
      await fsp.rename(finalPath, backupPath);
      movedExisting = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fsp.rename(tempPath, finalPath);
    if (movedExisting) await fsp.rm(backupPath, { force: true });
  } catch (error) {
    if (movedExisting) {
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      await fsp.rename(backupPath, finalPath).catch(() => {});
    }
    throw error;
  }
}

async function installYtdlp({
  root = ROOT,
  channel = normalizedChannel(),
  platform = process.platform,
  arch = process.arch,
  musl,
  fetchImpl = globalThis.fetch
} = {}) {
  const selectedChannel = normalizedChannel(channel);
  const asset = platformAsset(platform, arch, musl);
  const directory = managedDir(root);
  const binaryPath = managedBinaryPath({ root, platform, arch, musl });
  const checksumUrl = `${CHANNELS[selectedChannel]}/${CHECKSUM_FILENAME}`;
  await fsp.mkdir(directory, { recursive: true });

  const { text: sums, releaseUrl: checksumReleaseUrl } = await fetchText(checksumUrl, { fetchImpl });
  if (!checksumReleaseUrl) throw new Error('Could not determine the exact yt-dlp release selected by GitHub.');
  const expectedSha256 = parseChecksumFile(sums, asset);
  const binaryUrl = exactReleaseAssetUrl(checksumReleaseUrl, asset);
  const tempPath = path.join(directory, `.${asset}.${process.pid}.${Date.now()}.download`);

  try {
    await downloadToFile(binaryUrl, tempPath, { fetchImpl });
    const actualSha256 = await sha256File(tempPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`yt-dlp checksum verification failed for ${asset}.`);
    }
    if (platform !== 'win32') await fsp.chmod(tempPath, 0o755);
    await replaceFileAtomically(tempPath, binaryPath);
    const manifest = {
      asset,
      channel: selectedChannel,
      sha256: expectedSha256,
      source: binaryUrl,
      verifiedAt: new Date().toISOString()
    };
    await fsp.writeFile(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { path: binaryPath, downloaded: true, verified: true, manifest };
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function ensureYtdlp(options = {}) {
  const { respectEnvironment = true, ...managerOptions } = options;
  if (respectEnvironment && process.env.YTDLP_PATH) {
    const override = path.resolve(process.env.YTDLP_PATH);
    await fsp.access(override, fs.constants.X_OK).catch(() => {
      throw new Error(`YTDLP_PATH does not point to an executable file: ${override}`);
    });
    return { path: override, downloaded: false, verified: false, source: 'environment' };
  }

  const status = await cachedBinaryStatus(managerOptions);
  if (status.valid) {
    return { path: status.binaryPath, downloaded: false, verified: true, manifest: status.manifest };
  }
  return installYtdlp(managerOptions);
}

module.exports = {
  ALLOWED_DOWNLOAD_HOSTS,
  CHANNELS,
  CHECKSUM_FILENAME,
  DEFAULT_CHANNEL,
  activeBinaryPath,
  assertAllowedUrl,
  cachedBinaryStatus,
  ensureYtdlp,
  exactReleaseAssetUrl,
  fetchWithRedirects,
  installYtdlp,
  managedBinaryPath,
  managedDir,
  normalizedChannel,
  parseChecksumFile,
  platformAsset,
  sha256File
};
