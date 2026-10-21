'use strict';
(async function() {
  const native = globalThis.LVOVDNative, byId = id => document.getElementById(id);
  async function health() {
    byId('recheck').disabled = true;
    try { const result = await native.call('runtime_health');
      byId('runtime').replaceChildren(...[['ffmpeg','FFmpeg'],['ffprobe','FFprobe'],['ytdlp','yt-dlp'],['providerRuntime','Node · provider helper']].map(([key,label]) => {
        const node = document.createElement('span'), status = result[key]; node.textContent = label + ': ' + (status.installed ? 'available' : 'unavailable'); node.title = status.version || status.error; return node;
      }));
    } catch(error) { byId('runtime-detail').textContent = error.message; }
    finally { byId('recheck').disabled = false; }
  }
  byId('recheck').onclick = health;
  byId('native-intake-cancel').onclick = async () => {
    try { await native.call('cancel_intake', { request: { workbenchId: globalThis.LVOVDWorkspaceTransport.owner() } }); }
    catch(error) { byId('native-intake-status').textContent = error.message; }
  };
  const preview = byId('result-preview'), player = byId('result-player');
  document.addEventListener('lvovd:preview-result', event => {
    player.pause(); player.src = event.detail.url; byId('result-name').textContent = event.detail.name; byId('result-status').textContent = ''; preview.showModal();
  });
  const close = () => { player.pause(); player.removeAttribute('src'); player.load(); };
  byId('close-result').onclick = () => preview.close(); preview.addEventListener('close', close);
  player.addEventListener('error', () => { byId('result-status').textContent = 'This result cannot play in the preview. Save it to open in another player.'; });
  try { const info = await globalThis.LVOVDWorkspaceTransport.ready;
    byId('connection').textContent = 'Desktop · ' + info.appVersion;
    byId('runtime-detail').textContent = 'Backend: Rust · Webview: ' + info.webviewVersion;
    await health();
  } catch(error) { byId('connection').textContent = 'Desktop unavailable'; byId('workspace-status').textContent = error.message; byId('recheck').disabled = true; byId('media-choose-button').disabled = true; }
})();
