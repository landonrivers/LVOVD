'use strict';
// No HTTP fallback: an accidentally opened browser copy has no desktop authority.
(function exposeNative(root) {
  const allowed = new Set(['desktop_handshake', 'runtime_health', 'subscribe_sources', 'pick_source', 'remove_source', 'shutdown_desktop']);
  root.LVOVDNative = Object.freeze({
    async call(command, args = {}) {
      if (!allowed.has(command)) throw new Error('Unknown desktop operation.');
      if (!root.__TAURI__?.core) throw new Error('Open the desktop app instead of this HTML file. On Windows, use Start-LVOVD-Desktop-Windows.bat in the project folder, or run npm run dev:desktop from a terminal.');
      try { return await root.__TAURI__.core.invoke(command, args); }
      catch (error) { throw Object.assign(new Error(error?.message || String(error)), { code: error?.code }); }
    },
    async subscribe(onSnapshot) {
      const channel = new root.__TAURI__.core.Channel();
      channel.onmessage = onSnapshot;
      await this.call('subscribe_sources', { channel });
      return () => { channel.onmessage = () => {}; };
    },
    mediaUrl(assetId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(assetId)) throw new Error('Invalid media identity.');
      return root.__TAURI__.core.convertFileSrc(assetId, 'lvovd-media');
    }
  });
})(globalThis);
