'use strict';

// The reference suites need a real managed executable. Use the same official
// version and checksum as desktop CI, without querying the mutable latest API.
const { ytdlp } = require('../distribution/provider-tools.json');
const { CHANNEL_REPOS, CHECKSUM_FILENAME, installYtdlp, platformAsset } = require('../ytdlp-manager');

async function main() {
  const channel = 'nightly';
  const repository = CHANNEL_REPOS[channel];
  const [name, sha256] = ytdlp.archives[process.platform] || [];
  if (name !== platformAsset() || !/^[a-f0-9]{64}$/.test(sha256 || '')) {
    throw new Error('Missing pinned yt-dlp fixture for this platform.');
  }
  const base = `https://github.com/${repository}/releases/download/${ytdlp.version}`;
  const assets = [
    { name, browser_download_url: `${base}/${name}`, digest: `sha256:${sha256}` },
    { name: CHECKSUM_FILENAME, browser_download_url: `${base}/${CHECKSUM_FILENAME}` }
  ];
  await installYtdlp({ channel, releaseInfo: { channel, repository, release: { tag_name: ytdlp.version, assets } } });
  console.log(`Verified yt-dlp ${ytdlp.version} for the reference tests.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
