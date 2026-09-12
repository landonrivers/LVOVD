'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FAILURE_COOLDOWN_MS = 30000;

function boundedLimit(value, fallback, maximum) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), maximum) : fallback;
}

function discoveryError(reason) {
  const messages = {
    timeout: 'FFmpeg capability command timed out.',
    'output-limit': 'FFmpeg capability output exceeded the bounded capture limit.',
    'command-failed': 'FFmpeg capability command failed.',
    unparseable: 'FFmpeg capability listings could not be recognized.'
  };
  return Object.assign(new Error(messages[reason] || messages['command-failed']), { discoveryReason: reason });
}

function capabilityLines(output) {
  const text = String(output || '');
  if (Buffer.byteLength(text) > DEFAULT_MAX_OUTPUT_BYTES) throw discoveryError('unparseable');
  const lines = text.split(/\r?\n/);
  if (lines.length > 10000 || lines.some(line => line.length > 4096)) throw discoveryError('unparseable');
  return lines;
}

function codecEntries(output) {
  const entries = [];
  for (const line of capabilityLines(output)) {
    const match = line.match(/^\s*([VAS][A-Z.]{5})\s+([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79})\s+(.+)$/);
    if (!match) continue;
    const name = match[2].toLowerCase();
    const codec = match[3].match(/\(codec ([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79})\)\s*$/)?.[1].toLowerCase() || name;
    entries.push({ name, codec, description: match[3] });
  }
  return entries;
}

function parseCodecCapabilities(output) {
  return new Set(codecEntries(output).map(entry => entry.name));
}

function baselineSoftwareDecoder(name, description = '') {
  // Listings advertise implementations, not working hardware. In particular,
  // FFmpeg's native "av1" can require hwaccel despite its unqualified name:
  // https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavcodec/av1dec.c#L613-L622
  return name !== 'av1' && !/(?:^|_)(?:nvenc|nvdec|cuvid|qsv|amf|vaapi|vdpau|videotoolbox|mediacodec|v4l2m2m|mmal|omx|rkmpp|vulkan|d3d11va|d3d12va)(?:_|$)/i.test(name)
    && !/hardware|acceleration|cuvid|quick sync|nvdec|cuda/i.test(description);
}

function parseDecoderCapabilities(output) {
  const codecs = new Map();
  for (const { name, codec, description } of codecEntries(output)) {
    if (!codecs.has(codec)) codecs.set(codec, []);
    codecs.get(codec).push({ name, software: baselineSoftwareDecoder(name, description) });
  }
  return codecs;
}

function hasSoftwareDecoder(capabilities, codec) {
  if (capabilities?.decoderCodecs instanceof Map) {
    return capabilities.decoderCodecs.get(codec)?.some(decoder => decoder.software) === true;
  }
  // Same-name evidence remains supported for injected capabilities. Aliases
  // require the listing's explicit codec relationship, never name guessing.
  return capabilities?.decoders?.has(codec) === true && baselineSoftwareDecoder(codec);
}

function parseMuxerCapabilities(output) {
  const names = new Set();
  for (const line of capabilityLines(output)) {
    const parts = line.trim().split(/\s+/);
    const flags = parts[0] || '';
    if (!flags.includes('E') || !/^[D.E]{1,3}$/.test(flags) || !parts[1] || parts[1] === '=') continue;
    for (const name of parts[1].toLowerCase().split(',').filter(Boolean)) names.add(name);
  }
  return names;
}

function parseFfmpegVersion(output) {
  const match = String(output || '').match(/^ffmpeg version\s+([a-z0-9][a-z0-9._+~-]{0,119})(?:\s|$)/im);
  return match ? match[1].slice(0, 120) : null;
}

function runBoundedCommand(spawnProcess, args, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, {
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS
} = {}) {
  const fixedCommand = Array.isArray(args) && ['-version', '-encoders', '-decoders', '-muxers',
    '-hide_banner -encoders', '-hide_banner -decoders', '-hide_banner -muxers'].includes(args.join(' '));
  if (!fixedCommand) return Promise.reject(discoveryError('command-failed'));
  const byteLimit = boundedLimit(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
  const deadlineMs = boundedLimit(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 30000);
  const graceMs = boundedLimit(terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, 2000);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess('ffmpeg', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let settled = false;
    let failure = null;
    let exited = false;
    let deadline, escalation, finalWait;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(finalWait);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.stdout.removeListener('error', onPipeError);
      child.stderr.removeListener('error', onPipeError);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      if (error) {
        // A signal is only a request. If neither exit nor close was observed,
        // report that fact and stop owning pipes that could keep Node waiting.
        error.terminationConfirmed = exited;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref?.();
        reject(error);
      } else resolve(result);
    };
    const stop = error => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(deadline);
      if (exited) return finish(error);
      escalation = setTimeout(() => {
        // Windows treats these as forceful termination; POSIX gets a grace
        // period before SIGKILL. Never wait indefinitely for a close event.
        finalWait = setTimeout(() => finish(error), graceMs);
        try { child.kill('SIGKILL'); } catch {}
      }, graceMs);
      try { child.kill('SIGTERM'); } catch {}
    };
    const capture = (target) => (chunk) => {
      if (settled || failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > byteLimit) return stop(discoveryError('output-limit'));
      target.push(bytes);
    };
    const onStdout = capture(stdout), onStderr = capture(stderr);
    const onPipeError = () => stop(discoveryError('command-failed'));
    const onError = error => {
      if (failure) return;
      if (!child.pid) finish(Object.assign(error, { discoveryReason: 'spawn-failed' }));
      else stop(discoveryError('command-failed'));
    };
    const onExit = code => {
      exited = true;
      if (failure) finish(failure);
      else if (code !== 0) stop(discoveryError('command-failed'));
    };
    const onClose = (code) => {
      if (settled) return;
      exited = true;
      if (failure) return finish(failure);
      if (code !== 0) return finish(discoveryError('command-failed'));
      finish(null, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.stdout.on('error', onPipeError);
    child.stderr.on('error', onPipeError);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);
    deadline = setTimeout(() => stop(discoveryError('timeout')), deadlineMs);
  });
}

async function discoverFfmpegCapabilities({
  spawnProcess = spawn,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS
} = {}) {
  try {
    const limits = { timeoutMs, terminationGraceMs };
    const versionResult = await runBoundedCommand(spawnProcess, ['-version'], maxOutputBytes, limits);
    const encoderResult = await runBoundedCommand(
      spawnProcess, ['-hide_banner', '-encoders'], maxOutputBytes, limits
    );
    const decoderResult = await runBoundedCommand(
      spawnProcess, ['-hide_banner', '-decoders'], maxOutputBytes, limits
    );
    const muxerResult = await runBoundedCommand(
      spawnProcess, ['-hide_banner', '-muxers'], maxOutputBytes, limits
    );
    const capabilities = {
      available: true,
      version: parseFfmpegVersion(`${versionResult.stdout}\n${versionResult.stderr}`),
      encoders: parseCodecCapabilities(`${encoderResult.stdout}\n${encoderResult.stderr}`),
      decoders: parseCodecCapabilities(`${decoderResult.stdout}\n${decoderResult.stderr}`),
      decoderCodecs: parseDecoderCapabilities(`${decoderResult.stdout}\n${decoderResult.stderr}`),
      muxers: parseMuxerCapabilities(`${muxerResult.stdout}\n${muxerResult.stderr}`)
    };
    if (!capabilities.version || !capabilities.encoders.size || !capabilities.decoders.size || !capabilities.muxers.size) {
      throw discoveryError('unparseable');
    }
    return capabilities;
  } catch (error) {
    const failureReason = error?.discoveryReason || 'spawn-failed';
    return {
      available: false,
      version: null,
      encoders: new Set(),
      decoders: new Set(),
      muxers: new Set(),
      decoderCodecs: new Map(),
      failureReason,
      terminationConfirmed: error?.terminationConfirmed ?? null
    };
  }
}

function createFfmpegCapabilityDiscovery({ clock = () => Date.now(), failureCooldownMs = DEFAULT_FAILURE_COOLDOWN_MS, ...options } = {}) {
  let cachedPromise = null;
  let retryAfter = Infinity;
  const cooldownMs = boundedLimit(failureCooldownMs, DEFAULT_FAILURE_COOLDOWN_MS, 60000);
  return function getFfmpegCapabilities() {
    if (!cachedPromise || clock() >= retryAfter) {
      retryAfter = Infinity;
      cachedPromise = discoverFfmpegCapabilities(options).then(capabilities => {
        retryAfter = capabilities.available ? Infinity : clock() + cooldownMs;
        return capabilities;
      });
    }
    return cachedPromise;
  };
}

function publicCapabilitySummary(capabilities) {
  if (capabilities?.available !== true) {
    return {
      available: false,
      version: null,
      broadMp4: { h264SoftwareEncoder: null, aacEncoder: null, mp4Muxer: null },
      failure: {
        category: 'local_capability_discovery_failed',
        title: 'Could not check local conversion capabilities',
        explanation: capabilities?.failureReason === 'timeout'
          ? 'The local FFmpeg capability check exceeded its time limit.'
          : 'LVOVD could not read usable capability information from the local FFmpeg installation.',
        help: 'Check the local FFmpeg installation, then try inspecting again shortly.'
      }
    };
  }
  const encoders = capabilities?.encoders || new Set();
  const muxers = capabilities?.muxers || new Set();
  return {
    available: capabilities?.available === true,
    version: capabilities?.version || null,
    broadMp4: {
      h264SoftwareEncoder: encoders.has('libx264'),
      aacEncoder: encoders.has('aac'),
      mp4Muxer: muxers.has('mp4')
    }
  };
}

const getFfmpegCapabilities = createFfmpegCapabilityDiscovery();

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_FAILURE_COOLDOWN_MS,
  parseCodecCapabilities,
  parseDecoderCapabilities,
  hasSoftwareDecoder,
  parseMuxerCapabilities,
  parseFfmpegVersion,
  runBoundedCommand,
  discoverFfmpegCapabilities,
  createFfmpegCapabilityDiscovery,
  publicCapabilitySummary,
  getFfmpegCapabilities
};
