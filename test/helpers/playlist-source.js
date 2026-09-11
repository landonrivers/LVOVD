'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

// An ordinary RSS playlist linking individual HTML video pages, handled by
// yt-dlp's installed generic extractor. No extractor plugin or production hook.
async function playlistSource(root) {
  const files = [];
  for (let index = 0; index < 3; index++) {
    const file = path.join(root, `source-${index}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=96x64:r=10:d=6',
      '-f', 'lavfi', '-i', `aevalsrc=0.125*sin(2*PI*(${400 + index * 300}+100*floor(t))*t):s=48000:d=6:n=480`,
      '-vf', `geq=lum='${40 + index * 20}+10*floor(T)':cb=128:cr=128`, '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
    { windowsHide: true, shell: false, timeout: 30000 });
    files.push({ file, bytes: await fs.readFile(file) });
  }
  const requests = [], holds = new Map(), failures = new Map();
  let base;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, base).pathname; requests.push({ path: route, method: req.method });
    if (holds.has(route) && !holds.get(route).afterBytes) { const hold = holds.get(route); hold.arrived(); await hold.promise; }
    if (res.destroyed) return;
    if (failures.has(route)) { res.writeHead(failures.get(route)); res.end('Synthetic fixture rejection'); return; }
    if (route === '/feed.xml') {
      res.setHeader('Content-Type', 'application/rss+xml');
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Generated playlist</title><link>${base}/</link><description>Local test media</description>${files.map((_, index) => `<item><title>Generated item ${index}</title><guid>${base}/item-${index}</guid><link>${base}/item-${index}</link></item>`).join('')}</channel></rss>`);
      return;
    }
    const page = route.match(/^\/item-([0-2])$/);
    if (page) {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><head><title>Generated item ${page[1]}</title></head><body><video controls src="${base}/source-${page[1]}.mp4"></video></body></html>`); return;
    }
    const media = route.match(/^\/source-([0-2])\.mp4$/);
    if (media) {
      const bytes = files[Number(media[1])].bytes, hold = holds.get(route);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      if (req.method !== 'HEAD' && hold?.afterBytes) {
        res.write(bytes.subarray(0, hold.afterBytes)); hold.arrived(); await hold.promise;
        if (!res.destroyed) res.end(bytes.subarray(hold.afterBytes));
      } else res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: base + '/feed.xml', files, requests, failures,
    hold(route, { afterBytes = null } = {}) {
      let release, arrived; const promise = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { arrived = resolve; });
      holds.set(route, { promise, arrived, release, afterBytes });
      return { accepted, release() { holds.delete(route); release(); } };
    },
    async close() { for (const hold of holds.values()) hold.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
module.exports = { playlistSource };
