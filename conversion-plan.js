'use strict';

const crypto = require('node:crypto');
const { hasSoftwareDecoder } = require('./ffmpeg-capabilities');

const TARGETS = Object.freeze({
  'broad-compatibility-mp4': Object.freeze({ label: 'Compatible MP4', extension: 'mp4', mime: 'video/mp4', muxer: 'mp4', video: true, audioCodec: 'aac' }),
  'm4a-aac': Object.freeze({ label: 'M4A / AAC', extension: 'm4a', mime: 'audio/mp4', muxer: 'mp4', video: false, audioCodec: 'aac' }),
  mp3: Object.freeze({ label: 'MP3', extension: 'mp3', mime: 'audio/mpeg', muxer: 'mp3', video: false, audioCodec: 'mp3' })
});

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !Object.hasOwn(TARGETS, value)) throw requestError('Choose a supported conversion target.');
  return value;
}

function softwareDecoder(capabilities, codec) {
  if (!hasSoftwareDecoder(capabilities, codec)) return null;
  const name = capabilities.decoderCodecs instanceof Map
    ? capabilities.decoderCodecs.get(codec)?.find(item => item.software)?.name : codec;
  return /^[a-z0-9_][a-z0-9_.-]{0,79}$/.test(name || '') ? name : null;
}

function planConversion({ workspaceId = null, inputAssetId, inputRole = 'source', inputFilename = null, editPlanKey = null, inspection, targetId, capabilities }) {
  normalizeTarget(targetId);
  const target = TARGETS[targetId];
  const source = inspection || {};
  const video = target.video ? source.video : null;
  const audio = source.audio;
  const counts = source.trackCounts || {};
  const plan = {
    version: 1, workspaceId, inputAssetId, inputRole, inputFilename, editPlanKey,
    inspectionKey: crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    inputDurationSeconds: source.durationSeconds, targetId, target: target.label,
    status: 'unknown', reason: 'incomplete', message: 'More source metadata is needed for this target.',
    streams: [], changes: [], warnings: [], missing: [],
    output: { extension: target.extension, mime: target.mime, container: target.muxer },
    timing: { originSeconds: source.timeOriginSeconds, audioOnly: !target.video }
  };
  const finish = (status, reason, message) => {
    Object.assign(plan, { status, reason, message });
    plan.key = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    return plan;
  };
  const incomplete = message => finish('unknown', 'incomplete', message);
  const unsupported = message => finish('unavailable', 'unsupported', message);
  if (!inputAssetId || !Number.isFinite(source.timeOriginSeconds)) return incomplete('The source identity or presentation origin is incomplete.');
  if (target.video && (!video || source.mediaKind !== 'video')) {
    return counts.video === 0 ? unsupported('Compatible MP4 requires a timed video. Choose an audio target for this source.')
      : incomplete('The reported video does not have enough usable metadata.');
  }
  if (!target.video && !audio) return counts.audio === 0 ? unsupported('This source has no audio to extract.') : incomplete('The selected audio is unknown.');
  if (target.video && counts.audio == null) return incomplete('The source audio track count is unknown.');
  if (target.video && counts.audio > 0 && !audio) return incomplete('A reported audio stream cannot be selected safely.');
  if (video) {
    if (video.hdr === true) return unsupported('Known HDR video is not supported by Compatible MP4. Audio extraction is available when audio exists.');
    if (video.alpha === true) return unsupported('Known alpha-bearing video is not supported by Compatible MP4; transparency would be lost.');
    if (video.orientationSupported === false) return unsupported('This display transform is not a supported standard rotation.');
    if (!video.codec || !video.pixelFormat || !Number.isSafeInteger(video.streamIndex)) return incomplete('Video codec, pixel format, or stream identity is incomplete.');
    const copy = video.codec === 'h264' && video.pixelFormat === 'yuv420p';
    const rotation = video.rotationDegrees || 0;
    const transpose = !copy && [90, 270].includes(rotation);
    const width = transpose ? video.height : video.width, height = transpose ? video.width : video.height;
    Object.assign(plan.output, {
      videoCodec: 'h264', pixelFormat: 'yuv420p',
      width: copy ? width : Math.ceil(width / 2) * 2,
      height: copy ? height : Math.ceil(height / 2) * 2,
      rotationDegrees: copy ? rotation : 0,
      sampleAspectRatio: video.sampleAspectRatio && transpose ? video.sampleAspectRatio.split(':').reverse().join(':') : video.sampleAspectRatio
    });
    plan.streams.push({ role: 'video', index: video.streamIndex, action: copy ? 'copy' : 'encode', codec: video.codec,
      ...(copy ? {} : { encoder: 'libx264', crf: 18, preset: 'medium', pixelFormat: 'yuv420p' }) });
    plan.changes.push(copy ? 'Copy the selected video without re-encoding.' : 'Encode H.264 at CRF 18, medium, yuv420p; preserve source cadence and display aspect.');
    if (!copy && (width % 2 || height % 2)) plan.changes.push(`Pad the coded image minimally to ${plan.output.width} × ${plan.output.height}; no source pixels are cropped.`);
    if (!copy && rotation) plan.changes.push(`Apply the ${rotation}° display rotation once.`);
  }
  if (audio) {
    if (!audio.codec || !Number.isSafeInteger(audio.streamIndex) || !audio.channels || !audio.sampleRate) return incomplete('Audio codec, stream identity, channel count, or sample rate is incomplete.');
    if (target.audioCodec === 'mp3' && ![1, 2].includes(audio.channels)) return unsupported('MP3 supports suitable mono/stereo audio here. Multichannel audio will not be downmixed.');
    // Bare MP3 has a sample clock, not per-packet presentation timestamps.
    // Copy is safe from an existing MP3 result; timestamped containers require
    // filling gaps before encoding, even when their codec is already MP3.
    const timestampedMp3 = target.audioCodec === 'mp3' && audio.codec === 'mp3' && source.container?.kind !== 'mp3';
    const copy = audio.codec === target.audioCodec && !timestampedMp3;
    if (timestampedMp3) plan.changes.push('MP3 cannot carry container timestamp gaps. Re-encode the selected audio to preserve its timeline, filling gaps with silence.');
    const stream = { role: 'audio', index: audio.streamIndex, action: copy ? 'copy' : 'encode', codec: audio.codec };
    let sampleRate = audio.sampleRate;
    if (!copy) {
      const layout = audio.channelLayout || ({ 1: 'mono', 2: 'stereo' }[audio.channels]);
      const supported = { mono: 1, stereo: 2, '5.1': 6, '5.1(side)': 6 };
      if (!layout) return incomplete('The channel layout is required before encoding audio.');
      if (supported[layout] !== audio.channels) return unsupported('This audio layout cannot be encoded without an unsupported channel change. Suitable AAC can still be copied.');
      if (!audio.channelLayout) plan.changes.push(`Use ${layout} output for the reported ${audio.channels}-channel audio; the source does not name its layout.`);
      sampleRate = [44100, 48000].includes(audio.sampleRate) ? audio.sampleRate : 48000;
      Object.assign(stream, { encoder: target.audioCodec === 'aac' ? 'aac' : 'libmp3lame', sampleRate, channels: audio.channels, channelLayout: layout,
        ...(target.audioCodec === 'aac' ? { bitRate: { 1: 128000, 2: 256000, 6: 512000 }[audio.channels] } : { quality: 0 }) });
      if (sampleRate !== audio.sampleRate) plan.changes.push(`Resample audio from ${audio.sampleRate} Hz to 48000 Hz.`);
    }
    plan.streams.push(stream);
    Object.assign(plan.output, { audioCodec: target.audioCodec, sampleRate, channels: audio.channels, channelLayout: copy ? audio.channelLayout : stream.channelLayout });
    plan.changes.push(copy ? 'Copy the selected audio with its existing sample rate, channels, and bitrate.'
      : `Encode ${target.audioCodec === 'aac' ? `AAC at ${stream.bitRate / 1000} kbps` : 'MP3 with libmp3lame quality 0'}; preserve ${stream.channelLayout}.`);
  }
  const extra = source.extraStreams;
  if (!extra || !Number.isInteger(extra.total) || extra.chapters == null) return incomplete('Stream and chapter inventory is incomplete.');
  const omitted = {
    video: Math.max(0, (counts.video || 0) - (video ? 1 : 0)), audio: Math.max(0, (counts.audio || 0) - (audio ? 1 : 0)),
    subtitles: counts.subtitle || 0, artwork: extra.artwork || 0, other: extra.other || 0, chapters: extra.chapters
  };
  if (!target.video && counts.video > 0) plan.changes.push('Extract audio only; the video is omitted.');
  const warningParts = Object.entries(omitted).filter(([role, count]) => count > 0 && !(role === 'video' && !target.video));
  if (warningParts.length) plan.warnings.push({ id: 'omitted-content', required: true,
    message: `Omit ${warningParts.map(([role, count]) => `${count} ${role}`).join(', ')}. Only the selected relevant streams are included.` });
  plan.omitted = omitted;
  const allCopy = plan.streams.every(stream => stream.action === 'copy');
  const exactRoles = extra.total === plan.streams.length && !extra.chapters;
  const sameContainer = source.container?.kind === target.muxer;
  if (target.video) {
    plan.timing.durationSeconds = source.durationSeconds;
    plan.timing.videoStartSeconds = video.startSeconds;
    plan.timing.audioStartSeconds = audio?.startSeconds ?? null;
    plan.timing.audioEndSeconds = audio?.startSeconds != null && audio.durationSeconds != null ? audio.startSeconds + audio.durationSeconds : null;
    plan.timing.videoEndSeconds = video.startSeconds != null && video.durationSeconds != null ? video.startSeconds + video.durationSeconds : null;
  } else {
    plan.timing.audioStartSeconds = 0;
    plan.timing.sourceAudioStartSeconds = audio.startSeconds;
    plan.timing.durationSeconds = audio.durationSeconds ?? (counts.video === 0 ? source.durationSeconds : null);
    plan.timing.audioEndSeconds = plan.timing.durationSeconds;
    plan.changes.push('Use a zero-based selected-audio timeline; do not append any video-only tail.');
  }
  if (!(plan.timing.durationSeconds > 0) || (!target.video && audio.startSeconds == null)) return incomplete('Selected-stream timing is incomplete; the audio endpoint cannot be inferred from an unrelated video tail.');
  if (allCopy && exactRoles && sameContainer) return finish('no-op', null, 'No conversion needed');
  if (allCopy && (!source.container?.kind || source.container.kind === 'unknown')) return incomplete('Container identity is unknown.');
  if (capabilities?.available !== true) return finish('unknown', 'capability-check', 'Could not check local conversion capabilities. Retry after the capability-check cooldown.');
  if (!capabilities.muxers?.has(target.muxer)) plan.missing.push(`${target.muxer.toUpperCase()} muxer`);
  for (const stream of plan.streams.filter(item => item.action === 'encode')) {
    stream.decoder = softwareDecoder(capabilities, stream.codec);
    if (!stream.decoder) plan.missing.push(`selected ${stream.role} software decoder`);
    if (!capabilities.encoders?.has(stream.encoder)) plan.missing.push(`${stream.encoder} encoder`);
  }
  if (plan.missing.length) return finish('unavailable', 'missing-capability', `Missing: ${plan.missing.join(', ')}.`);
  return finish('executable', null, allCopy ? 'Remux selected streams without re-encoding' : 'Convert the selected streams');
}

function publicConversionPlan(plan) {
  const { streams, ...publicPlan } = plan;
  return { ...publicPlan, streams: streams.map(({ role, index, action }) => ({ role, index, action })) };
}

module.exports = { TARGETS, normalizeTarget, planConversion, publicConversionPlan, requestError };
