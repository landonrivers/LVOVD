'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function parseCodecCapabilities(output) {
  const names = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (!/^[VAS][A-Z.]{5}$/.test(parts[0] || '') || !parts[1] || parts[1] === '=') continue;
    names.add(parts[1].toLowerCase());
  }
  return names;
}

function parseMuxerCapabilities(output) {
  const names = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const flags = parts[0] || '';
    if (!flags.includes('E') || !/^[D.E]{1,3}$/.test(flags) || !parts[1] || parts[1] === '=') continue;
    for (const name of parts[1].toLowerCase().split(',').filter(Boolean)) names.add(name);
  }
  return names;
}

function parseFfmpegVersion(output) {
  const match = String(output || '').match(/^ffmpeg version\s+([^\s]+)/im);
  return match ? match[1].slice(0, 120) : null;
}

function runBoundedCommand(spawnProcess, args, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess('ffmpeg', args, { windowsHide: true, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const capture = (target) => (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        try { child.kill(); } catch {}
        finish(() => reject(new Error('FFmpeg capability output exceeded the bounded capture limit.')));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      if (settled) return;
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0) finish(() => resolve(result));
      else finish(() => reject(new Error(`FFmpeg capability command exited with code ${code}.`)));
    });
  });
}

async function discoverFfmpegCapabilities({
  spawnProcess = spawn,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  try {
    const versionResult = await runBoundedCommand(spawnProcess, ['-version'], maxOutputBytes);
    const encoderResult = await runBoundedCommand(
      spawnProcess, ['-hide_banner', '-encoders'], maxOutputBytes
    );
    const decoderResult = await runBoundedCommand(
      spawnProcess, ['-hide_banner', '-decoders'], maxOutputBytes
    );
    const muxerResult = await runBoundedCommand(
      spawnProcess, ['-hide_banner', '-muxers'], maxOutputBytes
    );
    return {
      available: true,
      version: parseFfmpegVersion(`${versionResult.stdout}\n${versionResult.stderr}`),
      encoders: parseCodecCapabilities(`${encoderResult.stdout}\n${encoderResult.stderr}`),
      decoders: parseCodecCapabilities(`${decoderResult.stdout}\n${decoderResult.stderr}`),
      muxers: parseMuxerCapabilities(`${muxerResult.stdout}\n${muxerResult.stderr}`)
    };
  } catch {
    return {
      available: false,
      version: null,
      encoders: new Set(),
      decoders: new Set(),
      muxers: new Set()
    };
  }
}

function createFfmpegCapabilityDiscovery(options = {}) {
  let cachedPromise = null;
  return function getFfmpegCapabilities() {
    if (!cachedPromise) cachedPromise = discoverFfmpegCapabilities(options);
    return cachedPromise;
  };
}

function publicCapabilitySummary(capabilities) {
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
  parseCodecCapabilities,
  parseMuxerCapabilities,
  parseFfmpegVersion,
  runBoundedCommand,
  discoverFfmpegCapabilities,
  createFfmpegCapabilityDiscovery,
  publicCapabilitySummary,
  getFfmpegCapabilities
};
