'use strict';

const { installYtdlp, normalizedChannel } = require('../ytdlp-manager');

async function main() {
  const channel = normalizedChannel(process.argv[2] || process.env.LVOVD_YTDLP_CHANNEL);
  console.log(`Downloading the latest official yt-dlp ${channel} release...`);
  const result = await installYtdlp({ channel });
  console.log(`yt-dlp updated and SHA-256 verified: ${result.path}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`yt-dlp update failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
