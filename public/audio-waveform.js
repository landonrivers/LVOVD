'use strict';

(function attachWaveform(root) {
  if (!root.document) return;
  root.LVOVDAudioWaveform = { create({ canvas, note, retry }) {
    let selected = null, snapshot = null, viewport = null, generation = 0, request = 0, starting = false, attempted = false, startError = null, restartedOperationId = null, key = null, controller = null;
    function cancel(identity, operationId) {
      if (!identity || !operationId) return;
      root.fetch('/api/workspace/waveform', { method: 'DELETE', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, operationId }) }).catch(() => {});
    }
    function resumeCancelled() {
      const state = snapshot?.waveform;
      if (selected && !starting && state?.status === 'cancelled' && state.operationId !== restartedOperationId) {
        restartedOperationId = state.operationId; start(true);
      }
    }
    function draw(peaks) {
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight), ratio = root.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d'); context.scale(ratio, ratio); context.clearRect(0, 0, width, height);
      context.strokeStyle = '#baa0ef'; context.lineWidth = Math.max(1, width / Math.max(1, peaks.length) * 0.7);
      context.beginPath(); peaks.forEach(([min, max], index) => { const x = (index + 0.5) / peaks.length * width;
        context.moveTo(x, height / 2 - max * height * 0.44); context.lineTo(x, height / 2 - min * height * 0.44); }); context.stroke();
    }
    async function start(force = false) {
      if (!selected || starting || attempted && !force) return;
      const identity = { ...selected }, token = generation; starting = true; attempted = true; startError = null;
      try {
        const response = await root.fetch('/api/workspace/waveform', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(identity) });
        const data = await response.json();
        if (token !== generation) {
          if (selected?.workspaceId !== identity.workspaceId || selected.sourceAssetId !== identity.sourceAssetId) cancel(identity, data.workspace?.waveform?.operationId);
          return;
        }
        if (!response.ok) throw new Error(data.error || 'Waveform unavailable.');
        window();
      } catch (error) { if (token === generation) { startError = error.message; note.textContent = `${startError} Trimming and processing remain available.`; retry.hidden = false; } }
      finally { if (token === generation) { starting = false; resumeCancelled(); } }
    }
    async function window() {
      if (!selected || snapshot?.waveform?.status !== 'ready' || !viewport) return;
      const points = Math.max(1, Math.min(4096, Math.ceil(canvas.clientWidth || 800)));
      const operationId = snapshot.waveform.operationId;
      const nextKey = JSON.stringify([operationId, viewport, points]); if (key === nextKey) return; key = nextKey;
      draw([]); note.textContent = 'Loading combined waveform overview…';
      controller?.abort(); controller = new root.AbortController();
      const token = generation, revision = ++request, identity = { ...selected };
      try {
        const query = new URLSearchParams({ ...identity, startSeconds: viewport.startSeconds, endSeconds: viewport.endSeconds, points });
        const response = await root.fetch(`/api/workspace/waveform?${query}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (token !== generation || revision !== request) return;
        if (!response.ok) throw new Error(data.error || 'Waveform unavailable.');
        if (data.workspaceId !== identity.workspaceId || data.sourceAssetId !== identity.sourceAssetId || data.operationId !== operationId || data.status !== 'ready') return;
        draw(data.peaks); note.textContent = 'Combined waveform overview · Cuts use millisecond times.'; retry.hidden = true;
      } catch (error) { if (token === generation && revision === request && error.name !== 'AbortError') { key = null; note.textContent = `${error.message} Trimming and processing remain available.`; retry.hidden = false; } }
    }
    function reset() {
      const previous = selected, operationId = snapshot?.waveform?.operationId; generation++; request++; controller?.abort(); controller = null;
      selected = null; snapshot = null; viewport = null; key = null; attempted = false; starting = false; startError = null; restartedOperationId = null;
      canvas.hidden = true; note.hidden = true; retry.hidden = true; draw([]);
      cancel(previous, operationId);
    }
    retry.addEventListener('click', () => { attempted = false; key = null; start(true); });
    return { reset, render(data, visibleWindow) {
      if (!data?.inspection?.audio || data.inspection.video || !data.editor?.eligible) { if (selected) reset(); return; }
      if (selected?.workspaceId !== data.id || selected.sourceAssetId !== data.sourceAssetId) { reset(); selected = { workspaceId: data.id, sourceAssetId: data.sourceAssetId }; }
      snapshot = data; viewport = { ...visibleWindow }; canvas.hidden = false; note.hidden = false;
      const state = data.waveform || { status: 'idle' };
      if (state.status === 'ready') { window(); return; }
      if (state.status === 'idle' && startError) { note.textContent = `${startError} Trimming and processing remain available.`; retry.hidden = false; return; }
      note.textContent = state.message || (state.status === 'cancelled' ? 'Waveform preparation paused for other work.' : 'Preparing combined waveform overview…');
      retry.hidden = !['failed', 'cancelled'].includes(state.status);
      if (state.status === 'idle') start();
      resumeCancelled();
    } };
  } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
