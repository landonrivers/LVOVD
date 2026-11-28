'use strict';
(async function() {
  const native = globalThis.LVOVDNative, byId = id => document.getElementById(id);
  const viewport = byId('workspace-scroll'), download = byId('desktop-download');
  const local = byId('desktop-local'), settings = byId('desktop-settings');
  const nav = document.querySelectorAll('.desktop-header nav button');
  function markSection(id) {
    for (const button of nav) {
      if (button.getAttribute('aria-controls') === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
  for (const button of nav) {
    button.addEventListener('click', () => {
      const section = byId(button.getAttribute('aria-controls'));
      download.hidden = local.hidden = section === settings;
      settings.hidden = section !== settings;
      section.focus({ preventScroll: true });
      section.scrollIntoView({ block: 'start' });
      markSection(section.id);
    });
  }
  viewport.addEventListener('scroll', () => {
    if (settings.hidden) {
      const atLocal = local.getBoundingClientRect().top <= viewport.getBoundingClientRect().top + 1
        || (viewport.scrollTop > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1);
      markSection(atLocal ? local.id : download.id);
    }
  }, { passive: true });
  // Called for an OS drop. Rust owns the paths and sends only the physical point.
  globalThis.LVOVDLocalDropAt = (x, y) => {
    if (local.hidden || !Number.isFinite(x) || !Number.isFinite(y) || document.querySelector('dialog[open]')) return false;
    const target = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio);
    return local.contains(target);
  };
  const cleanup = byId('workspace-recovery');
  cleanup.setAttribute('aria-label', 'Temporary file cleanup');
  cleanup.querySelector('strong').textContent = 'Temporary file cleanup';
  cleanup.querySelector('.help').textContent = 'Removed files stay listed until cleanup finishes.';
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
  let previewGeneration = 0;
  document.addEventListener('lvovd:preview-result', event => {
    const generation = ++previewGeneration;
    player.pause();
    player.src = event.detail.url;
    byId('result-name').textContent = event.detail.name;
    byId('result-status').textContent = '';
    if (!preview.open) preview.showModal();
    player.play().catch(error => {
      if (generation === previewGeneration && preview.open && error.name === 'NotAllowedError') {
        byId('result-status').textContent = 'Press Play to start the preview.';
      }
    });
  });
  byId('close-result').onclick = () => preview.close();
  preview.addEventListener('close', () => {
    if (preview.open) return;
    ++previewGeneration;
    player.pause(); player.removeAttribute('src'); player.load();
  });
  player.addEventListener('playing', () => { byId('result-status').textContent = ''; });
  player.addEventListener('error', () => {
    if (preview.open && player.error) byId('result-status').textContent = 'This result cannot play in the preview. Save it to open in another player.';
  });
  try { const info = await globalThis.LVOVDWorkspaceTransport.ready;
    byId('connection').textContent = 'Desktop · ' + info.appVersion;
    byId('runtime-detail').textContent = 'Backend: Rust · Webview: ' + info.webviewVersion;
    await health();
  } catch(error) { byId('connection').textContent = 'Desktop unavailable'; byId('workspace-status').textContent = error.message; byId('recheck').disabled = true; byId('media-choose-button').disabled = true; }
})();
