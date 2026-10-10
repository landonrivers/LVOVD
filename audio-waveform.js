'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { editorTimeline } = require('./audio-policy');
const { localMediaInputArgs } = require('./local-media-input');
const { hasSoftwareDecoder } = require('./ffmpeg-capabilities');
const { conversionSlotBusy, onConversionSlotReleased } = require('./conversion-workspace');
const { requestError } = require('./conversion-plan');

const MAX_PAIRS = 200000;
const MAX_WINDOW_POINTS = 4096;
const managers = new Set();
let active = null, foreground = 0;

function createPeakAccumulator({ durationSeconds, sampleRate, channels }) {
  if (!(durationSeconds > 0) || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(channels) || channels < 1 || channels > 8) throw new Error('Waveform timing or channels are unsupported.');
  const frames = Math.ceil(durationSeconds * sampleRate);
  if (!Number.isSafeInteger(frames * channels * 4)) throw new Error('Waveform duration exceeds its byte bound.');
  const framesPerBin = Math.max(Math.ceil(sampleRate * 0.01), Math.ceil(frames / MAX_PAIRS));
  const pairs = Math.ceil(frames / framesPerBin), peaks = new Float32Array(pairs * 2);
  for (let bin = 0; bin < pairs; bin++) { peaks[bin * 2] = Infinity; peaks[bin * 2 + 1] = -Infinity; }
  const maxBytes = (frames + sampleRate) * channels * 4;
  let bytes = 0, frame = 0, tail = Buffer.alloc(0);
  return {
    pairs, binSeconds: framesPerBin / sampleRate,
    push(chunk) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Waveform decoder exceeded the inspected duration byte bound.');
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      const stride = channels * 4, length = data.length - data.length % stride;
      for (let offset = 0; offset < length; offset += stride, frame++) {
        const bin = Math.floor(frame / framesPerBin);
        for (let channel = 0; channel < channels; channel++) {
          const value = data.readFloatLE(offset + channel * 4);
          if (!Number.isFinite(value)) throw new Error('Waveform decoder returned non-finite samples.');
          if (bin < pairs) {
            peaks[bin * 2] = Math.min(peaks[bin * 2], value);
            peaks[bin * 2 + 1] = Math.max(peaks[bin * 2 + 1], value);
          }
        }
      }
      tail = Buffer.from(data.subarray(length));
    },
    finish() {
      if (tail.length || frame < frames - Math.ceil(sampleRate * 0.002)) throw new Error('Waveform decoder returned incomplete samples.');
      for (let bin = 0; bin < pairs; bin++) if (peaks[bin * 2] === Infinity) { peaks[bin * 2] = 0; peaks[bin * 2 + 1] = 0; }
      return Buffer.from(peaks.buffer);
    }
  };
}

function waveformWindow(buffer, binSeconds, durationSeconds, start, end, points) {
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > durationSeconds + 0.001
    || !Number.isSafeInteger(points) || points < 1 || points > MAX_WINDOW_POINTS) throw requestError('Choose a valid waveform window and 1–4096 points.');
  const total = buffer.length / 8, peaks = [];
  const count = Math.min(points, Math.max(1, Math.ceil((end - start) / binSeconds)));
  for (let i = 0; i < count; i++) {
    const first = Math.max(0, Math.floor((start + (end - start) * i / count) / binSeconds));
    const last = Math.min(total, Math.ceil((start + (end - start) * (i + 1) / count) / binSeconds));
    let min = Infinity, max = -Infinity;
    for (let bin = first; bin < last; bin++) { min = Math.min(min, buffer.readFloatLE(bin * 8)); max = Math.max(max, buffer.readFloatLE(bin * 8 + 4)); }
    if (min === Infinity) { min = 0; max = 0; }
    // Fixed decimal precision bounds JSON responses as well as the binary cache.
    peaks.push([Math.round(Math.max(-1, min) * 1000000) / 1000000, Math.round(Math.min(1, max) * 1000000) / 1000000]);
  }
  return peaks;
}

function drain() {
  if (active || foreground || conversionSlotBusy()) return;
  for (const owner of managers) {
    if ([...owner.manager.workspaces.values()].some(w => w.activeOperation || w.queuedProcessingJobId)) continue;
    const task = [...owner.tasks.values()].find(t => t.status === 'waiting');
    if (task) { active = task; task.promise = owner.perform(task); task.promise.catch(() => {}); return; }
  }
}

class AudioWaveforms {
  constructor(manager, { deadlineMs = 120000 } = {}) {
    this.manager = manager; this.deadlineMs = deadlineMs; this.tasks = new Map();
    this.unsubscribe = null;
  }
  listen() { if (!this.unsubscribe) { managers.add(this); this.unsubscribe = onConversionSlotReleased(() => queueMicrotask(drain)); } }
  state(workspace) {
    const task = this.tasks.get(workspace.id);
    return task ? { status: task.status, operationId: task.id, sourceAssetId: task.sourceAssetId, durationSeconds: task.durationSeconds,
      binSeconds: task.binSeconds || null, message: task.message || null } : { status: 'idle' };
  }
  start(workspaceId, sourceAssetId) {
    const { workspace, asset } = this.manager.originalSource(workspaceId, sourceAssetId);
    const timeline = editorTimeline(workspace.inspection);
    if (workspace.purpose !== 'local' || workspace.inspection?.video || !(timeline.durationSeconds > 0) || !Number.isFinite(timeline.offsetSeconds)) throw requestError('Waveforms require an inspected audio-only Local Media source.', 422);
    const existing = this.tasks.get(workspaceId);
    if (existing && !['failed', 'cancelled'].includes(existing.status)) return workspace;
    this.listen();
    const task = { id: crypto.randomUUID(), workspace, sourceAssetId, asset, durationSeconds: timeline.durationSeconds,
      offsetSeconds: timeline.offsetSeconds, status: 'waiting', controller: new AbortController(), child: null, owner: this };
    this.tasks.set(workspaceId, task); this.manager.emit(workspace); queueMicrotask(drain);
    return workspace;
  }
  async cancel(workspaceId, operationId = null) {
    const task = this.tasks.get(workspaceId);
    if (!task || operationId && operationId !== task.id || task.status === 'ready') return;
    task.preempted = false; task.controller.abort();
    if (active === task && task.promise) await task.promise.catch(() => {});
    else { task.status = 'cancelled'; this.manager.emit(task.workspace); }
  }
  async preempt() {
    foreground++;
    let released = false;
    const resume = () => { if (!released) { released = true; foreground--; queueMicrotask(drain); } };
    try { if (active) { active.preempted = true; active.controller.abort(); await active.promise.catch(() => {}); } return resume; }
    catch (error) { resume(); throw error; }
  }
  changed() { queueMicrotask(drain); }
  async remove(workspaceId) { await this.cancel(workspaceId); this.tasks.delete(workspaceId); }
  async clear() { for (const id of [...this.tasks.keys()]) await this.remove(id); this.unsubscribe?.(); this.unsubscribe = null; managers.delete(this); }
  async window(workspaceId, sourceAssetId, start, end, points) {
    this.manager.originalSource(workspaceId, sourceAssetId);
    const task = this.tasks.get(workspaceId);
    if (!task || task.sourceAssetId !== sourceAssetId) throw requestError('No waveform belongs to that source.', 404);
    if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > task.durationSeconds + 0.001
      || !Number.isSafeInteger(points) || points < 1 || points > MAX_WINDOW_POINTS) throw requestError('Choose a valid waveform window and 1–4096 points.');
    const state = { workspaceId, sourceAssetId, ...this.state(task.workspace) };
    if (task.status !== 'ready') return { ...state, peaks: [] };
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isSafeInteger(points)) throw requestError('Invalid waveform window.');
    const buffer = await this.manager.fs.readFile(task.filePath);
    this.manager.originalSource(workspaceId, sourceAssetId);
    if (this.tasks.get(workspaceId) !== task) throw requestError('The waveform operation changed.', 409);
    return { ...state, startSeconds: start, endSeconds: end, peaks: waveformWindow(buffer, task.binSeconds, task.durationSeconds, start, end, points) };
  }
  async perform(task) {
    task.status = 'preparing'; this.manager.emit(task.workspace);
    let timer;
    try {
      const inspection = task.workspace.inspection, audio = inspection.audio;
      timer = setTimeout(() => { task.timedOut = true; task.controller.abort(); }, this.deadlineMs); timer.unref?.();
      const capabilities = await new Promise((resolve, reject) => {
        const signal = task.controller.signal;
        const abort = () => reject(new Error('Waveform cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        Promise.resolve().then(() => this.manager.discoverCapabilities()).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      if (task.controller.signal.aborted) throw new Error('Waveform cancelled.');
      if (!hasSoftwareDecoder(capabilities, audio.codec) || !capabilities.encoders?.has('pcm_f32le') || !capabilities.muxers?.has('f32le')) throw new Error('Waveform needs the selected software decoder and FFmpeg float-PCM support.');
      const decoder = capabilities.decoderCodecs instanceof Map ? capabilities.decoderCodecs.get(audio.codec)?.find(item => item.software)?.name : audio.codec;
      if (!/^[a-z0-9_][a-z0-9_.-]{0,79}$/.test(decoder || '')) throw new Error('Waveform software decoder is unavailable.');
      const accumulator = createPeakAccumulator({ durationSeconds: task.durationSeconds, sampleRate: audio.sampleRate, channels: audio.channels });
      await this.decode(task, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-copyts', '-start_at_zero', '-itsoffset', String(-task.offsetSeconds),
        `-c:${audio.streamIndex}`, decoder, ...localMediaInputArgs(inspection), '-i', task.asset.filePath, '-map', `0:${audio.streamIndex}`, '-vn', '-sn', '-dn',
        '-af', `aresample=async=1:first_pts=0:min_hard_comp=0.001,apad=whole_dur=${task.durationSeconds},atrim=end=${task.durationSeconds}`,
        '-c:a', 'pcm_f32le', '-ar', String(audio.sampleRate), '-ac', String(audio.channels), '-f', 'f32le', 'pipe:1'], chunk => accumulator.push(chunk));
      if (task.controller.signal.aborted || !this.manager.workspaces.has(task.workspace.id)) throw new Error('Waveform cancelled.');
      task.filePath = path.join(task.workspace.tempDir, `waveform-${task.id}.bin`);
      const bytes = accumulator.finish();
      await this.manager.fs.writeFile(task.filePath, bytes, { flag: 'wx' });
      if (!this.manager.workspaces.has(task.workspace.id)) throw new Error('Waveform cancelled.');
      this.manager.registerAsset(task.workspace, { role: 'waveform', filePath: task.filePath, size: bytes.length, mime: 'application/octet-stream', playable: false });
      task.binSeconds = accumulator.binSeconds; task.status = 'ready'; task.message = 'Combined waveform overview; cuts use millisecond times.';
    } catch (error) {
      task.status = task.preempted ? 'waiting' : task.controller.signal.aborted && !task.timedOut ? 'cancelled' : 'failed';
      task.message = task.timedOut ? 'Waveform preparation timed out. Trimming and processing remain available.'
        : task.status === 'cancelled' ? 'Waveform preparation cancelled.' : 'Waveform preparation failed. Trimming and processing remain available; retry the overview when FFmpeg is available.';
      if (task.preempted) { task.message = 'Waveform preparation will resume after foreground work.'; task.controller = new AbortController(); task.preempted = false; task.timedOut = false; }
      // The cache path remains inside the owned directory and is removed by
      // normal workspace cleanup even when a partial write or deletion fails.
    } finally {
      clearTimeout(timer); if (active === task) active = null;
      this.manager.emit(task.workspace); queueMicrotask(drain);
    }
  }
  decode(task, args, consume) {
    return new Promise((resolve, reject) => {
      const child = this.manager.spawnProcess('ffmpeg', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      task.child = child;
      let failure, settled = false, escalation, closeWait, diagnostic = '', exited = false;
      const finish = code => {
        if (settled) return; settled = true; clearTimeout(escalation); clearTimeout(closeWait);
        task.controller.signal.removeEventListener('abort', stop); task.child = null;
        child.stdout.removeAllListeners(); child.stderr.removeAllListeners();
        if (failure || task.controller.signal.aborted || code !== 0) reject(failure || new Error(task.controller.signal.aborted ? 'Waveform cancelled.' : diagnostic || 'Waveform decoding failed.'));
        else resolve();
      };
      const stop = () => {
        if (exited || settled) return;
        try { child.kill('SIGTERM'); } catch {}
        if (!escalation) escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, this.manager.conversionTerminationGraceMs);
      };
      child.stdout.on('data', chunk => { if (failure || task.controller.signal.aborted) return; try { consume(chunk); } catch (error) { failure = error; stop(); } });
      child.stdout.on('error', error => { failure = error; stop(); });
      child.stderr.on('data', chunk => { if (diagnostic.length < 512 * 1024) diagnostic += String(chunk).slice(0, 512 * 1024 - diagnostic.length); });
      child.stderr.on('error', error => { failure = error; stop(); });
      child.on('error', error => { failure = error; if (!child.pid) finish(1); else stop(); });
      child.on('exit', code => { exited = true; closeWait = setTimeout(() => finish(code), this.manager.conversionTerminationGraceMs); });
      child.on('close', code => { exited = true; finish(code); });
      task.controller.signal.addEventListener('abort', stop, { once: true });
      if (task.controller.signal.aborted) stop();
    });
  }
}

module.exports = { AudioWaveforms, createPeakAccumulator, waveformWindow, MAX_PAIRS, MAX_WINDOW_POINTS };
