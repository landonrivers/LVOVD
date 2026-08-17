'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  DEFAULT_UPDATE_CHECK_MS,
  assertAllowedUrl,
  cachedBinaryStatus,
  ensureYtdlp,
  installYtdlp,
  parseChecksumFile,
  platformAsset,
  updateCheckDue
} = require('../ytdlp-manager');

async function writeCachedBinary(root, {
  bytes = Buffer.from('verified fake yt-dlp binary'),
  release = 'cached-tag',
  checkedAt = new Date().toISOString(),
  channel = 'nightly'
} = {}) {
  const binDir = path.join(root, '.lvovd-bin');
  const binaryPath = path.join(binDir, 'yt-dlp_linux');
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(binaryPath, bytes);
  await fsp.chmod(binaryPath, 0o755);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await fsp.writeFile(path.join(binDir, 'manifest.json'), JSON.stringify({
    asset: 'yt-dlp_linux',
    channel,
    repository: 'yt-dlp/yt-dlp-nightly-builds',
    release,
    sha256,
    verifiedAt: checkedAt,
    checkedAt
  }));
  return { binaryPath, sha256 };
}

test('platform asset mapping uses official standalone release names', () => {
  assert.equal(platformAsset('win32', 'x64', false), 'yt-dlp.exe');
  assert.equal(platformAsset('win32', 'arm64', false), 'yt-dlp_arm64.exe');
  assert.equal(platformAsset('darwin', 'arm64', false), 'yt-dlp_macos');
  assert.equal(platformAsset('linux', 'x64', false), 'yt-dlp_linux');
  assert.equal(platformAsset('linux', 'x64', true), 'yt-dlp_musllinux');
  assert.throws(() => platformAsset('plan9', 'x64', false), /No supported/);
});

test('checksum parser selects the exact requested asset', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const sums = `${first}  yt-dlp\n${second} *yt-dlp.exe\n`;
  assert.equal(parseChecksumFile(sums, 'yt-dlp.exe'), second);
  assert.throws(() => parseChecksumFile(sums, 'missing'), /did not contain/);
});

test('download host policy allows only expected GitHub HTTPS hosts', () => {
  assert.equal(assertAllowedUrl('https://api.github.com/repos/example').hostname, 'api.github.com');
  assert.equal(assertAllowedUrl('https://github.com/example').hostname, 'github.com');
  assert.throws(() => assertAllowedUrl('http://github.com/example'), /HTTPS/);
  assert.throws(() => assertAllowedUrl('https://example.com/file'), /unexpected/);
});

test('freshness policy checks again after 24 hours or a channel change', () => {
  const now = Date.parse('2026-08-17T12:00:00Z');
  const manifest = {
    channel: 'nightly',
    release: 'cached-tag',
    checkedAt: new Date(now - DEFAULT_UPDATE_CHECK_MS + 1000).toISOString()
  };
  assert.equal(updateCheckDue(manifest, { channel: 'nightly', now }), false);
  manifest.checkedAt = new Date(now - DEFAULT_UPDATE_CHECK_MS).toISOString();
  assert.equal(updateCheckDue(manifest, { channel: 'nightly', now }), true);
  assert.equal(updateCheckDue(manifest, { channel: 'stable', now }), true);
});

test('a recently checked verified cached binary is reused without any network fetch', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-test-'));
  const now = Date.parse('2026-08-17T12:00:00Z');
  try {
    const { binaryPath } = await writeCachedBinary(root, {
      checkedAt: new Date(now - 60 * 60 * 1000).toISOString()
    });
    const status = await cachedBinaryStatus({ root, platform: 'linux', arch: 'x64', musl: false });
    assert.equal(status.valid, true);
    const result = await ensureYtdlp({
      root,
      platform: 'linux',
      arch: 'x64',
      musl: false,
      respectEnvironment: false,
      now,
      fetchImpl: async () => { throw new Error('network should not be used'); }
    });
    assert.equal(result.path, binaryPath);
    assert.equal(result.downloaded, false);
    assert.equal(result.verified, true);
    assert.equal(result.updateChecked, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a stale verified cache checks GitHub and records freshness when release is unchanged', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-current-'));
  const now = Date.parse('2026-08-17T12:00:00Z');
  const apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';
  let fetchCount = 0;
  try {
    const { binaryPath } = await writeCachedBinary(root, {
      release: 'current-tag',
      checkedAt: new Date(now - 2 * DEFAULT_UPDATE_CHECK_MS).toISOString()
    });
    const result = await ensureYtdlp({
      root,
      platform: 'linux',
      arch: 'x64',
      musl: false,
      respectEnvironment: false,
      now,
      fetchImpl: async (input) => {
        fetchCount += 1;
        assert.equal(String(input), apiUrl);
        return new Response(JSON.stringify({ tag_name: 'current-tag', assets: [] }), { status: 200 });
      }
    });
    assert.equal(result.path, binaryPath);
    assert.equal(result.downloaded, false);
    assert.equal(result.updateChecked, true);
    assert.equal(result.updateAvailable, false);
    assert.equal(fetchCount, 1);
    const manifest = JSON.parse(await fsp.readFile(path.join(root, '.lvovd-bin', 'manifest.json'), 'utf8'));
    assert.equal(manifest.checkedAt, new Date(now).toISOString());
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a stale verified cache automatically installs a newer checked release', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-newer-'));
  const now = Date.parse('2026-08-17T12:00:00Z');
  const newBytes = Buffer.from('new verified yt-dlp binary');
  const digest = crypto.createHash('sha256').update(newBytes).digest('hex');
  const apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';
  const releaseUrl = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/new-tag';
  const checksumUrl = `${releaseUrl}/SHA2-256SUMS`;
  const binaryUrl = `${releaseUrl}/yt-dlp_linux`;
  const calls = [];
  try {
    await writeCachedBinary(root, {
      release: 'old-tag',
      checkedAt: new Date(now - 2 * DEFAULT_UPDATE_CHECK_MS).toISOString()
    });
    const result = await ensureYtdlp({
      root,
      platform: 'linux',
      arch: 'x64',
      musl: false,
      respectEnvironment: false,
      now,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url === apiUrl) {
          return new Response(JSON.stringify({
            tag_name: 'new-tag',
            assets: [
              { name: 'SHA2-256SUMS', browser_download_url: checksumUrl },
              { name: 'yt-dlp_linux', browser_download_url: binaryUrl, digest: `sha256:${digest}` }
            ]
          }), { status: 200 });
        }
        if (url === checksumUrl) return new Response(`${digest}  yt-dlp_linux\n`, { status: 200 });
        if (url === binaryUrl) return new Response(newBytes, { status: 200, headers: { 'content-length': String(newBytes.length) } });
        throw new Error(`unexpected fetch ${url}`);
      }
    });
    assert.equal(result.downloaded, true);
    assert.equal(result.updated, true);
    assert.equal(result.previousRelease, 'old-tag');
    assert.equal(await fsp.readFile(result.path, 'utf8'), newBytes.toString());
    assert.deepEqual(calls, [apiUrl, checksumUrl, binaryUrl]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a failed freshness check does not block a valid cached binary', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-offline-'));
  const now = Date.parse('2026-08-17T12:00:00Z');
  try {
    const { binaryPath } = await writeCachedBinary(root, {
      checkedAt: new Date(now - 2 * DEFAULT_UPDATE_CHECK_MS).toISOString()
    });
    const result = await ensureYtdlp({
      root,
      platform: 'linux',
      arch: 'x64',
      musl: false,
      respectEnvironment: false,
      now,
      fetchImpl: async () => { throw new Error('offline'); }
    });
    assert.equal(result.path, binaryPath);
    assert.equal(result.verified, true);
    assert.equal(result.downloaded, false);
    assert.match(result.updateCheckError, /offline/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('verified install uses one exact official release for metadata, checksum, and binary', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-install-'));
  const binaryBytes = Buffer.from('official fake binary bytes');
  const digest = crypto.createHash('sha256').update(binaryBytes).digest('hex');
  const releaseUrl = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/test-tag';
  const checksumUrl = `${releaseUrl}/SHA2-256SUMS`;
  const binaryUrl = `${releaseUrl}/yt-dlp_linux`;
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest') {
      return new Response(JSON.stringify({
        tag_name: 'test-tag',
        assets: [
          { name: 'SHA2-256SUMS', browser_download_url: checksumUrl },
          { name: 'yt-dlp_linux', browser_download_url: binaryUrl, digest: `sha256:${digest}` }
        ]
      }), { status: 200 });
    }
    if (url === checksumUrl) {
      return new Response(`${digest}  yt-dlp_linux\n`, { status: 200 });
    }
    if (url === binaryUrl) {
      return new Response(binaryBytes, { status: 200, headers: { 'content-length': String(binaryBytes.length) } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await installYtdlp({
      root,
      channel: 'nightly',
      platform: 'linux',
      arch: 'x64',
      musl: false,
      fetchImpl
    });
    assert.equal(result.verified, true);
    assert.equal(await fsp.readFile(result.path, 'utf8'), binaryBytes.toString());
    assert.deepEqual(calls, [
      'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest',
      checksumUrl,
      binaryUrl
    ]);
    const manifest = JSON.parse(await fsp.readFile(path.join(root, '.lvovd-bin', 'manifest.json'), 'utf8'));
    assert.equal(manifest.sha256, digest);
    assert.equal(manifest.release, 'test-tag');
    assert.equal(manifest.source, binaryUrl);
    assert.equal(manifest.checkedAt, manifest.verifiedAt);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('install fails closed if GitHub asset digest and published checksum disagree', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-mismatch-'));
  const expected = 'a'.repeat(64);
  const apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';
  const checksumUrl = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/test-tag/SHA2-256SUMS';
  const binaryUrl = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/test-tag/yt-dlp_linux';
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === apiUrl) {
      return new Response(JSON.stringify({
        tag_name: 'test-tag',
        assets: [
          { name: 'SHA2-256SUMS', browser_download_url: checksumUrl },
          { name: 'yt-dlp_linux', browser_download_url: binaryUrl, digest: `sha256:${'b'.repeat(64)}` }
        ]
      }), { status: 200 });
    }
    if (url === checksumUrl) return new Response(`${expected}  yt-dlp_linux\n`, { status: 200 });
    throw new Error('binary should not be downloaded after metadata mismatch');
  };
  try {
    await assert.rejects(
      installYtdlp({ root, channel: 'nightly', platform: 'linux', arch: 'x64', musl: false, fetchImpl }),
      /metadata disagreed/
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
