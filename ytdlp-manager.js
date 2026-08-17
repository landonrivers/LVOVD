'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = __dirname;
const DEFAULT_CHANNEL = 'nightly';
const CHANNEL_REPOS = Object.freeze({
  stable: 'yt-dlp/yt-dlp',
  nightly: 'yt-dlp/yt-dlp-nightly-builds'
});
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
]);
const MAX_REDIRECTS = 6;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const CHECKSUM_FILENAME = 'SHA2-256SUMS';
const MANIFEST_FILENAME = 'manifest.json';

function normalizedChannel(value = process.env.LVOVD_YTDLP_CHANNEL || DEFAULT_CHANNEL) {
  const channel = String(value || '').trim().toLowerCase();
  if (!CHANNEL_REPOS[channel]) throw new Error(`Unsupported yt-dlp channel: ${value}`);
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
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'LVOVD yt-dlp manager',
        Accept: 'application/vnd.github+json,application/octet-stream,*/*',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) throw new Error('Too many redirects while downloading yt-dlp.');
      const location = response.headers.get('location');
      if (!location) throw new Error('yt-dlp download redirect did not include a destination.');
      current = assertAllowedUrl(new URL(location, current));
      continue;
    }
    if (!response.ok) throw new Error(`yt-dlp download failed with HTTP ${response.status}.`);
    return { response, finalUrl: current.toString() };
  }
  throw new Error('Too many redirects while downloading yt-dlp.');
}

async function responseTextLimited(response, maxBytes, label) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${label} was unexpectedly large.`);
  return text;
}

async function fetchText(url, options = {}) {
  const { response, finalUrl } = await fetchWithRedirects(url, options);
  const text = await responseTextLimited(response, MAX_METADATA_BYTES, 'yt-dlp metadata response');
  return { text, finalUrl };
}

async function fetchLatestRelease(channel, { fetchImpl = globalThis.fetch } = {}) {
  const selectedChannel = normalizedChannel(channel);
  const repository = CHANNEL_REPOS[selectedChannel];
  const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  const { response } = await fetchWithRedirects(apiUrl, { fetchImpl });
  const text = await responseTextLimited(response, MAX_METADATA_BYTES, 'yt-dlp release metadata');
  let release;
  try {
    release = JSON.parse(text);
  } catch {
    throw new Error('GitHub returned unreadable yt-dlp release metadata.');
  }
  if (!release?.tag_name || !Array.isArray(release.assets)) {
    throw new Error('GitHub returned incomplete yt-dlp release metadata.');
  }
  return { channel: selectedChannel, repository, release };
}

function releaseAsset(release, assetName) {
  const asset = release?.assets?.find((candidate) => candidate?.name === assetName);
  if (!asset?.browser_download_url) {
    throw new Error(`Official yt-dlp release did not contain ${assetName}.`);
  }
  assertAllowedUrl(asset.browser_download_url);
  return asset;
}

function parseChecksumFile(text, assetName) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`Official yt-dlp checksum file did not contain ${assetName}.`);
}

function assetDigest(asset) {
  const match = String(asset?.digest || '').match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
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
  const assetName = platformAsset(platform, arch, musl);
  const directory = managedDir(root);
  const binaryPath = managedBinaryPath({ root, platform, arch, musl });
  await fsp.mkdir(directory, { recursive: true });

  const { repository, release } = await fetchLatestRelease(selectedChannel, { fetchImpl });
  const checksumAsset = releaseAsset(release, CHECKSUM_FILENAME);
  const binaryAsset = releaseAsset(release, assetName);
  const { text: sums } = await fetchText(checksumAsset.browser_download_url, { fetchImpl });
  const expectedSha256 = parseChecksumFile(sums, assetName);
  const githubDigest = assetDigest(binaryAsset);
  if (githubDigest && githubDigest !== expectedSha256) {
    throw new Error(`Official yt-dlp release metadata disagreed with ${CHECKSUM_FILENAME} for ${assetName}.`);
  }

  const tempPath = path.join(directory, `.${assetName}.${process.pid}.${Date.now()}.download`);
  try {
    await downloadToFile(binaryAsset.browser_download_url, tempPath, { fetchImpl });
    const actualSha256 = await sha256File(tempPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`yt-dlp checksum verification failed for ${assetName}.`);
    }
    if (platform !== 'win32') await fsp.chmod(tempPath, 0o755);
    await replaceFileAtomically(tempPath, binaryPath);
    const manifest = {
      asset: assetName,
      channel: selectedChannel,
      repository,
      release: release.tag_name,
      sha256: expectedSha256,
      source: binaryAsset.browser_download_url,
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
  CHANNEL_REPOS,
  CHECKSUM_FILENAME,
  DEFAULT_CHANNEL,
  activeBinaryPath,
  assertAllowedUrl,
  assetDigest,
  cachedBinaryStatus,
  ensureYtdlp,
  fetchLatestRelease,
  fetchWithRedirects,
  installYtdlp,
  managedBinaryPath,
  managedDir,
  normalizedChannel,
  parseChecksumFile,
  platformAsset,
  releaseAsset,
  sha256File
};
