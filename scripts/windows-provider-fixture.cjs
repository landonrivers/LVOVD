'use strict';
const fs = require('node:fs');
const { startProvider } = require('../desktop/test/download.cjs');
startProvider(process.argv[2]).then(provider => {
  fs.writeFileSync(process.argv[3], JSON.stringify({ url: provider.url }));
}).catch(error => { console.error(error); process.exitCode = 1; });
