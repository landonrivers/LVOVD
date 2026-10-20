'use strict';
// No HTTP fallback: an accidentally opened browser copy has no desktop authority.
(function exposeNative(root) {
  const allowed = new Set(['desktop_handshake', 'runtime_health', 'create_workbench', 'list_workbenches', 'subscribe_workbench', 'acknowledge_workbench', 'review_processing', 'queue_processing', 'cancel_processing', 'discard_workbench', 'cleanup_workbench', 'pick_source', 'remove_source', 'shutdown_desktop']);
  let connectionGeneration = 0, disposeCurrent = () => {};
  root.LVOVDNative = Object.freeze({
    async call(command, args = {}) {
      if (!allowed.has(command)) throw new Error('Unknown desktop operation.');
      if (!root.__TAURI__?.core) throw new Error('Open lvovd.exe instead of this HTML file. The Windows development build is in target/debug. If it has not been built yet, run npm run build:desktop from the project folder.');
      try {
        const result = await root.__TAURI__.core.invoke(command, args);
        if (command === 'desktop_handshake') connectionGeneration = Math.max(connectionGeneration, result.connectionGeneration);
        return result;
      }
      catch (error) { throw Object.assign(new Error(error?.message || String(error)), { code: error?.code }); }
    },
    async subscribe(workbenchId, onSnapshot) {
      disposeCurrent();
      const generation = ++connectionGeneration;
      const channel = new root.__TAURI__.core.Channel();
      let active = true, connectionId = null, last = null, heartbeat = null;
      const acknowledge = () => last && this.call('acknowledge_workbench', { request: {
        connectionId, revision: last.revision, queueRevision: last.queueRevision
      } }).catch(() => {});
      const accept = value => {
        if (!active || generation !== connectionGeneration || value.connectionId !== connectionId) return;
        const snapshot = value.snapshot;
        if (snapshot && (snapshot.workbenchId !== workbenchId || (last &&
          (snapshot.revision < last.revision || snapshot.queueRevision < last.queueRevision)))) return;
        last = snapshot;
        try { onSnapshot(snapshot); } finally { acknowledge(); }
      };
      const dispose = () => { active = false; clearInterval(heartbeat); channel.onmessage = () => {}; };
      disposeCurrent = dispose;
      channel.onmessage = accept;
      try {
        const initial = await this.call('subscribe_workbench', { request: { workbenchId, generation }, channel });
        if (!active || generation !== connectionGeneration) return dispose;
        connectionId = initial.connectionId;
        accept(initial);
        heartbeat = setInterval(acknowledge, 15000);
        return dispose;
      } catch (error) { dispose(); throw error; }
    },
    mediaUrl(assetId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(assetId)) throw new Error('Invalid media identity.');
      return root.__TAURI__.core.convertFileSrc(assetId, 'lvovd-media');
    }
  });
})(globalThis);
