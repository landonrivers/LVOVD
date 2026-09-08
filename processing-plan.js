'use strict';

const crypto = require('node:crypto');
const { hasSoftwareDecoder } = require('./ffmpeg-capabilities');
const { planConversion, requestError } = require('./conversion-plan');
const { normalizeEditPlan, isFullDurationEditPlan, totalRetainedDuration, roundMilliseconds } = require('./public/edit-plan');

const PRESETS = Object.freeze(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']);
const MP3_BITRATES = Object.freeze([32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]);
const CONTAINERS = Object.freeze({
  mp4: { extension: 'mp4', mime: 'video/mp4', label: 'MP4', muxer: 'mp4' },
  mov: { extension: 'mov', mime: 'video/quicktime', label: 'MOV / QuickTime', muxer: 'mov' },
  matroska: { extension: 'mkv', mime: 'video/x-matroska', label: 'Matroska / MKV', muxer: 'matroska' },
  m4a: { extension: 'm4a', mime: 'audio/mp4', label: 'M4A / AAC', muxer: 'mp4' },
  mp3: { extension: 'mp3', mime: 'audio/mpeg', label: 'MP3', muxer: 'mp3' }
});
// Conservative muxing policy, not a catalog of every codec FFmpeg can mux.
const COPY_CODECS = Object.freeze({
  mp4: { video: ['h264', 'hevc', 'av1', 'mpeg4'], audio: ['aac', 'mp3', 'ac3', 'eac3', 'alac'] },
  mov: { video: ['h264', 'hevc', 'mpeg4', 'prores', 'mjpeg'], audio: ['aac', 'mp3', 'ac3', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le'] },
  matroska: { video: ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg4', 'mpeg2video', 'mjpeg', 'ffv1', 'prores'], audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le'] }
});

function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw requestError(`${label} must be an object.`);
  if (Object.keys(value).some(key => !fields.includes(key))) throw requestError(`${label} contains an unsupported setting.`);
  return value;
}
function choice(value, options, label) {
  if (!options.includes(value)) throw requestError(`Choose a supported ${label}.`);
  return value;
}
function number(value, minimum, maximum, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    throw requestError(`${label} must be ${integer ? 'an integer' : 'a finite number'} from ${minimum} to ${maximum}.`);
  }
  return value;
}

function normalizeProcessingSettings(raw = {}) {
  object(raw, ['videoCodec', 'container', 'scale', 'frameRate', 'rate', 'audio'], 'Processing settings');
  const scale = object(raw.scale === undefined ? {} : raw.scale, ['mode', 'width', 'height', 'allowUpscale'], 'Scale');
  const rate = object(raw.rate === undefined ? {} : raw.rate, ['mode', 'crf', 'preset', 'videoKbps', 'maximumMB', 'twoPass'], 'Encoding rate');
  const audio = object(raw.audio === undefined ? {} : raw.audio, ['codec', 'bitrateKbps'], 'Audio');
  const scaleMode = choice(scale.mode === undefined ? 'unchanged' : scale.mode, ['unchanged', 'fit'], 'scaling mode');
  const rateMode = choice(rate.mode === undefined ? 'automatic' : rate.mode, ['automatic', 'quality', 'bitrate', 'size'], 'encoding mode');
  if (scale.allowUpscale !== undefined && typeof scale.allowUpscale !== 'boolean') throw requestError('Allow upscale must be a boolean.');
  if (rate.twoPass !== undefined && typeof rate.twoPass !== 'boolean') throw requestError('Two pass must be a boolean.');
  // Inactive bounded control values can survive a mode change in the browser;
  // normalize them deliberately so they cannot affect an admitted plan or key.
  if (scale.width != null) number(scale.width, 2, 16384, 'Maximum width', true);
  if (scale.height != null) number(scale.height, 2, 16384, 'Maximum height', true);
  if (rate.crf != null) number(rate.crf, 0, 51, 'CRF', true);
  if (rate.preset != null) choice(rate.preset, PRESETS, 'software preset');
  if (rate.videoKbps != null) number(rate.videoKbps, 1, 1000000, 'Video bitrate');
  if (rate.maximumMB != null) number(rate.maximumMB, 0.001, 100 * 1024 ** 3 / 1e6, 'Maximum MB');
  const normalized = {
    videoCodec: choice(raw.videoCodec === undefined ? 'unchanged' : raw.videoCodec, ['unchanged', 'h264'], 'video codec'),
    container: choice(raw.container === undefined ? 'source' : raw.container, ['source', ...Object.keys(CONTAINERS)], 'container'),
    scale: { mode: scaleMode, width: scaleMode === 'fit' ? number(scale.width, 2, 16384, 'Maximum width', true) : null,
      height: scaleMode === 'fit' ? number(scale.height, 2, 16384, 'Maximum height', true) : null,
      allowUpscale: scaleMode === 'fit' ? scale.allowUpscale ?? false : false },
    frameRate: raw.frameRate == null ? null : number(raw.frameRate, 0.1, 120, 'Frame rate'),
    rate: { mode: rateMode, crf: rateMode === 'quality' ? rate.crf ?? 18 : 18,
      preset: rateMode === 'automatic' ? 'medium' : rate.preset ?? 'medium',
      videoKbps: rateMode === 'bitrate' ? number(rate.videoKbps, 1, 1000000, 'Video bitrate') : null,
      maximumMB: rateMode === 'size' ? number(rate.maximumMB, 0.001, 100 * 1024 ** 3 / 1e6, 'Maximum MB') : null,
      twoPass: rateMode === 'size' || (rateMode === 'bitrate' && (rate.twoPass ?? false)) },
    audio: { codec: choice(audio.codec === undefined ? 'unchanged' : audio.codec, ['unchanged', 'aac', 'mp3'], 'audio codec'),
      bitrateKbps: audio.bitrateKbps == null ? null : number(audio.bitrateKbps, 8, 1536, 'Audio bitrate') }
  };
  if (normalized.audio.codec === 'mp3' && normalized.audio.bitrateKbps != null && !MP3_BITRATES.includes(normalized.audio.bitrateKbps)) {
    throw requestError(`Choose a supported MP3 bitrate: ${MP3_BITRATES.join(', ')} kbps.`);
  }
  return normalized;
}

function softwareDecoder(capabilities, codec) {
  if (!hasSoftwareDecoder(capabilities, codec)) return null;
  const name = capabilities.decoderCodecs instanceof Map ? capabilities.decoderCodecs.get(codec)?.find(item => item.software)?.name : codec;
  return /^[a-z0-9_][a-z0-9_.-]{0,79}$/.test(name || '') ? name : null;
}

function processingOptions(source = {}, capabilities) {
  const checked = capabilities?.available === true;
  const videoSafe = source.video && source.video.hdr !== true && source.video.alpha !== true && source.video.orientationSupported !== false;
  const h264 = checked && videoSafe && capabilities.encoders?.has('libx264') && hasSoftwareDecoder(capabilities, source.video.codec);
  const audio = source.audio;
  const layout = audio?.channelLayout || ({ 1: 'mono', 2: 'stereo' }[audio?.channels]);
  const audioSafe = audio && ({ mono: 1, stereo: 2, '5.1': 6, '5.1(side)': 6 })[layout] === audio.channels;
  const audioCodecAvailable = codec => audio && (audio.codec === codec || (checked && audioSafe
    && (codec !== 'mp3' || audio.channels <= 2) && capabilities.encoders?.has(codec === 'mp3' ? 'libmp3lame' : 'aac') && hasSoftwareDecoder(capabilities, audio.codec)));
  const containers = [{ value: 'source', label: 'Keep source' }];
  if (source.video && checked) for (const value of ['mp4', 'mov', 'matroska']) {
    if (capabilities.muxers?.has(value) && (h264 || COPY_CODECS[value].video.includes(source.video.codec))
      && (!audio || COPY_CODECS[value].audio.includes(audio.codec) || audioCodecAvailable('aac'))) containers.push({ value, label: CONTAINERS[value].label });
  }
  if (checked) for (const [value, codec] of [['m4a', 'aac'], ['mp3', 'mp3']]) {
    if (capabilities.muxers?.has(CONTAINERS[value].muxer) && audioCodecAvailable(codec)) containers.push({ value, label: CONTAINERS[value].label });
  }
  return {
    checked,
    videoCodecs: [{ value: 'unchanged', label: 'Unchanged' }, ...(h264 ? [{ value: 'h264', label: 'H.264' }] : [])], containers,
    audioCodecs: [{ value: 'unchanged', label: 'Unchanged' }, ...['aac', 'mp3'].filter(audioCodecAvailable).map(value => ({ value, label: value.toUpperCase() }))],
    frameRates: h264 ? [1, 5, 10, 12, 15, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60].filter(value => value < (source.video?.frameRate || 0)) : [],
    presets: [...PRESETS], mp3Bitrates: [...MP3_BITRATES]
  };
}

function aspectRatio(value) {
  const [n, d] = String(value || '').split(':').map(Number);
  return n > 0 && d > 0 ? n / d : null;
}
function rationalAspect(n, d) {
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const common = gcd(n, d);
  return `${n / common}:${d / common}`;
}
function geometry(video, scale, encode) {
  const rotation = video.rotationDegrees || 0;
  const transpose = encode && [90, 270].includes(rotation);
  const width = transpose ? video.height : video.width;
  const height = transpose ? video.width : video.height;
  const sar = transpose && video.sampleAspectRatio ? video.sampleAspectRatio.split(':').reverse().join(':') : video.sampleAspectRatio;
  if (!encode) return { width, height, rotationDegrees: rotation, sampleAspectRatio: sar };
  if (scale.mode === 'unchanged') return { width: Math.ceil(width / 2) * 2, height: Math.ceil(height / 2) * 2,
    rotationDegrees: 0, sampleAspectRatio: sar };
  const displayWidth = width * (aspectRatio(sar) ?? 1);
  const factor = Math.min(scale.width / displayWidth, scale.height / height,
    ...(scale.allowUpscale ? [] : [1, width / displayWidth]));
  const outputWidth = Math.max(2, Math.floor(displayWidth * factor / 2) * 2);
  const outputHeight = Math.max(2, Math.floor(height * factor / 2) * 2);
  const [n, d] = String(sar || '1:1').split(':').map(Number);
  return { width: outputWidth, height: outputHeight, rotationDegrees: 0,
    sampleAspectRatio: rationalAspect(width * outputHeight * n, height * outputWidth * d) };
}
function mappedTime(time, ranges) {
  if (!Number.isFinite(time)) return null;
  return roundMilliseconds(ranges.reduce((sum, range) => sum + Math.max(0, Math.min(time, range.endSeconds) - range.startSeconds), 0));
}

function planProcessing({ workspaceId = null, sourceAssetId, inputFilename = null, inspection, editPlan: rawEditPlan = null,
  settings: rawSettings = {}, draftRevision = 0, capabilities }) {
  const settings = normalizeProcessingSettings(rawSettings);
  number(draftRevision, 0, Number.MAX_SAFE_INTEGER, 'Draft revision', true);
  const source = inspection || {};
  let editPlan = null;
  if (source.durationSeconds > 0) {
    if (rawEditPlan != null) {
      object(rawEditPlan, ['version', 'keepRanges'], 'Edit plan');
      if (Array.isArray(rawEditPlan.keepRanges)) for (const range of rawEditPlan.keepRanges) object(range, ['startSeconds', 'endSeconds'], 'Retained range');
    }
    try { editPlan = normalizeEditPlan(rawEditPlan ?? { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: roundMilliseconds(source.durationSeconds) }] }, roundMilliseconds(source.durationSeconds)); }
    catch (error) { throw requestError(error.message); }
  } else if (rawEditPlan != null) throw requestError('A known source duration is required for cuts.');
  const cuts = editPlan && !isFullDurationEditPlan(editPlan, source.durationSeconds);
  const defaultRequest = settings.videoCodec === 'unchanged' && settings.container === 'source'
    && settings.scale.mode === 'unchanged' && settings.frameRate == null && settings.rate.mode === 'automatic'
    && settings.audio.codec === 'unchanged' && settings.audio.bitrateKbps == null && !cuts;
  const plan = {
    version: 1, workspaceId, sourceAssetId, inputAssetId: sourceAssetId, inputRole: 'source', inputFilename, draftRevision,
    inspectionKey: crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    inputDurationSeconds: source.durationSeconds, settings, editPlan, cuts: Boolean(cuts),
    status: 'unknown', reason: 'incomplete', message: 'More source metadata is needed.',
    streams: [], changes: [], warnings: [], missing: [], output: {}, passes: 1, rateBudget: null,
    options: processingOptions(source, capabilities),
    timing: { originSeconds: source.timeOriginSeconds, audioOnly: false, durationSeconds: editPlan ? totalRetainedDuration(editPlan) : source.durationSeconds }
  };
  const finish = (status, reason, message) => {
    Object.assign(plan, { status, reason, message });
    plan.key = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    return plan;
  };
  const incomplete = message => finish('unknown', 'incomplete', message);
  const unsupported = message => finish('unavailable', 'unsupported', message);
  if (!sourceAssetId || !Number.isFinite(source.timeOriginSeconds)) return incomplete('The source identity or presentation origin is incomplete.');
  if (defaultRequest) {
    // No transform or inventory change has been requested. Authorization is for
    // the original owned file, including streams the encoder does not handle.
    const kind = source.container?.kind;
    Object.assign(plan.output, { ...(CONTAINERS[kind] || {}), container: kind,
      videoCodec: source.video?.codec, width: source.video?.width, height: source.video?.height,
      pixelFormat: source.video?.pixelFormat, rotationDegrees: source.video?.rotationDegrees || 0,
      sampleAspectRatio: source.video?.sampleAspectRatio, frameRate: source.video?.frameRate,
      audioCodec: source.audio?.codec, sampleRate: source.audio?.sampleRate, channels: source.audio?.channels, channelLayout: source.audio?.channelLayout });
    for (const role of ['video', 'audio']) if (source[role]) plan.streams.push({ role, index: source[role].streamIndex, action: 'copy', codec: source[role].codec });
    plan.timing.audioOnly = !source.video;
    plan.preserveSourceInventory = true;
    plan.changes.push('Keep all original bytes, streams, chapters, and metadata.');
    return finish('no-op', null, 'No processing needed; download the original file.');
  }
  if (!editPlan) return incomplete('A known positive source duration is required for processing.');
  const audioOnly = ['m4a', 'mp3'].includes(settings.container) || (!source.video && settings.container === 'source');
  plan.timing.audioOnly = audioOnly;
  const video = audioOnly ? null : source.video;
  const audio = source.audio;
  let container = settings.container === 'source' ? source.container?.kind : settings.container;
  if (audioOnly) {
    if (settings.videoCodec !== 'unchanged' || settings.scale.mode !== 'unchanged' || settings.frameRate != null || settings.rate.mode !== 'automatic') {
      return unsupported('Choose Automatic and unchanged video settings for audio-only output.');
    }
    if (cuts && !source.video) return unsupported('Editing audio-only sources is not supported in this slice. Use the complete selected audio timeline.');
    if (!audio) return unsupported('This source has no selected audio to convert.');
    if (settings.container === 'source' && !['mp4', 'mp3'].includes(container)) return unsupported('Keep source cannot encode this audio container. Choose M4A / AAC or MP3 explicitly.');
    if (settings.container === 'source' && container === 'mp4' && (settings.audio.codec === 'unchanged' ? audio.codec : settings.audio.codec) !== 'aac') {
      return unsupported('Choose AAC explicitly for audio in the source MP4 container, or choose an MP3 container explicitly.');
    }
    const codec = container === 'm4a' ? 'aac' : container === 'mp3' ? 'mp3' : settings.audio.codec === 'unchanged' ? audio.codec : settings.audio.codec;
    if (!['aac', 'mp3'].includes(codec)) return unsupported('Choose M4A / AAC or MP3 for this audio conversion.');
    if (codec === 'mp3' && settings.audio.bitrateKbps != null && !MP3_BITRATES.includes(settings.audio.bitrateKbps)) return unsupported(`Choose a supported MP3 bitrate: ${MP3_BITRATES.join(', ')} kbps.`);
    if (settings.audio.codec !== 'unchanged' && settings.audio.codec !== codec) return unsupported('The chosen audio codec does not match this audio container.');
    const targetId = codec === 'aac' ? 'm4a-aac' : 'mp3';
    const delegated = planConversion({ workspaceId, inputAssetId: sourceAssetId, inputFilename, inspection: source, targetId, capabilities });
    Object.assign(plan, { output: delegated.output, streams: delegated.streams, timing: delegated.timing,
      changes: delegated.changes, warnings: delegated.warnings, missing: delegated.missing, omitted: delegated.omitted, audioDelegate: targetId });
    // Preserve the accepted AAC/MP3 conversion policy; an explicit bitrate
    // requires encoding even if source codec and container already match.
    if (settings.audio.bitrateKbps == null && !cuts) return finish(delegated.status, delegated.reason, delegated.message);
    if (!['executable', 'no-op'].includes(delegated.status)) return finish(delegated.status, delegated.reason, delegated.message);
    const stream = plan.streams[0];
    const encoded = planConversion({ workspaceId, inputAssetId: sourceAssetId, inspection: { ...source, audio: { ...audio, codec: '__force_encode' } }, targetId, capabilities: { ...capabilities, available: true } });
    if (encoded.reason === 'unsupported' || encoded.reason === 'incomplete') return finish(encoded.status, encoded.reason, encoded.message);
    const policy = encoded.streams.find(item => item.role === 'audio');
    if (!policy) return unsupported('This audio layout cannot be encoded safely.');
    Object.assign(stream, policy, { codec: audio.codec });
    if (settings.audio.bitrateKbps != null) { stream.bitRate = settings.audio.bitrateKbps * 1000; delete stream.quality; }
    Object.assign(plan.output, encoded.output);
    plan.changes = plan.changes.filter(message => !message.startsWith('Copy the selected audio'));
    plan.changes.push(`Encode ${codec.toUpperCase()} ${stream.bitRate ? `at ${stream.bitRate / 1000} kbps` : 'at quality 0'}; preserve ${stream.channelLayout}.`);
    if (cuts) {
      plan.timing = { originSeconds: source.timeOriginSeconds, audioOnly: true, durationSeconds: totalRetainedDuration(editPlan),
        audioStartSeconds: 0, audioEndSeconds: totalRetainedDuration(editPlan) };
      plan.changes = plan.changes.filter(message => !message.startsWith('Use a zero-based selected-audio timeline'));
      plan.changes.push(`Apply the committed video cuts directly to original audio on the shared presentation clock, retaining ${plan.timing.durationSeconds} seconds including silence.`);
    }
    plan.missing = [];
    container = plan.output.container;
  } else {
    if (!video || source.mediaKind !== 'video') return incomplete('The selected timed video is incomplete.');
    if (!['mp4', 'mov', 'matroska'].includes(container)) return unsupported('Keep source cannot encode this container. Choose MP4, MOV, or Matroska explicitly.');
    if (video.hdr === true) return unsupported('Known HDR video is not supported for processed video. Audio-only conversion remains available.');
    if (video.alpha === true) return unsupported('Known alpha-bearing video cannot be processed without losing transparency.');
    if (video.orientationSupported === false) return unsupported('This display transform is not a supported standard rotation.');
    if (!video.codec || !video.pixelFormat || !Number.isSafeInteger(video.streamIndex)
      || !(video.width > 0 && video.height > 0)) return incomplete('Video codec, pixel format, stream identity, or geometry is incomplete.');
    if (source.trackCounts?.audio == null || (source.trackCounts.audio > 0 && !audio)) return incomplete('The selected audio inventory is incomplete.');
    if (settings.frameRate != null && (!video.frameRate || settings.frameRate > video.frameRate + 0.000001)) {
      return unsupported('Choose a frame rate no higher than the known source frame rate.');
    }
    const encodeVideo = Boolean(cuts || settings.scale.mode === 'fit' || settings.frameRate != null
      || settings.rate.mode !== 'automatic' || (settings.videoCodec === 'h264' && (video.codec !== 'h264' || video.pixelFormat !== 'yuv420p')));
    const outputCodec = settings.videoCodec === 'unchanged' ? video.codec : settings.videoCodec;
    if (encodeVideo && outputCodec !== 'h264') return unsupported('These cuts or encoding changes require a supported encoder. Choose H.264 explicitly; the source codec will not be changed automatically.');
    if (!COPY_CODECS[container].video.includes(outputCodec)) return unsupported('This video codec cannot be copied to the selected container. Choose H.264 explicitly.');
    const resolved = geometry(video, settings.scale, encodeVideo);
    plan.output = { ...CONTAINERS[container], container, videoCodec: outputCodec,
      pixelFormat: encodeVideo ? 'yuv420p' : video.pixelFormat, ...resolved, frameRate: settings.frameRate ?? video.frameRate };
    plan.streams.push({ role: 'video', index: video.streamIndex, action: encodeVideo ? 'encode' : 'copy', codec: video.codec,
      ...(encodeVideo ? { encoder: 'libx264', crf: settings.rate.crf, preset: settings.rate.preset, pixelFormat: 'yuv420p' } : {}) });
    plan.changes.push(encodeVideo ? `Encode H.264 with ${settings.rate.mode === 'automatic' || settings.rate.mode === 'quality' ? `CRF ${settings.rate.crf}; final size varies` : settings.rate.mode === 'size' ? 'a maximum-size two-pass bitrate budget' : `${settings.rate.videoKbps} kbps average video bitrate`}.` : 'Copy the selected video without re-encoding.');
    if (settings.scale.mode === 'fit') plan.changes.push(`Fit within ${settings.scale.width} × ${settings.scale.height}: ${resolved.width} × ${resolved.height}, preserving display aspect${settings.scale.allowUpscale ? '' : ' without upscaling'}.`);
    else if (encodeVideo && (video.width % 2 || video.height % 2)) plan.changes.push(`Pad coded dimensions minimally to ${resolved.width} × ${resolved.height}; no source pixels are cropped.`);
    if (encodeVideo && video.rotationDegrees) plan.changes.push(`Apply the ${video.rotationDegrees}° display rotation once.`);
    if (settings.frameRate != null) plan.changes.push(`Reduce frame rate to ${settings.frameRate} fps without changing playback duration.`);
    if (cuts) plan.changes.push(`Apply ${editPlan.keepRanges.length} retained range(s) directly to the original source, keeping ${plan.timing.durationSeconds} seconds.`);
    const videoEnd = video.startSeconds != null && video.durationSeconds != null ? video.startSeconds + video.durationSeconds : null;
    plan.timing.videoStartSeconds = cuts ? mappedTime(video.startSeconds, editPlan.keepRanges) : video.startSeconds;
    plan.timing.videoEndSeconds = cuts ? mappedTime(videoEnd, editPlan.keepRanges) : videoEnd;
    if (cuts && videoEnd != null && !editPlan.keepRanges.some(range => range.startSeconds < videoEnd && range.endSeconds > video.startSeconds)) return unsupported('The retained ranges contain no video frames.');
    if (audio) {
      if (!audio.codec || !Number.isSafeInteger(audio.streamIndex) || !audio.channels || !audio.sampleRate) return incomplete('Audio codec, stream identity, channels, or sample rate is incomplete.');
      const outputAudioCodec = settings.audio.codec === 'unchanged' ? audio.codec : settings.audio.codec;
      const encode = Boolean(cuts || outputAudioCodec !== audio.codec || settings.audio.bitrateKbps != null);
      if (encode && !['aac', 'mp3'].includes(outputAudioCodec)) return unsupported('These cuts or audio changes require an audio encoder. Choose AAC or MP3 explicitly.');
      if (!COPY_CODECS[container].audio.includes(outputAudioCodec)) return unsupported('This audio codec cannot be copied into the selected container. Choose AAC explicitly; audio will not be removed.');
      const stream = { role: 'audio', index: audio.streamIndex, action: encode ? 'encode' : 'copy', codec: audio.codec };
      if (encode) {
        const layout = audio.channelLayout || ({ 1: 'mono', 2: 'stereo' }[audio.channels]);
        if (!layout) return incomplete('An audio channel layout is required before encoding.');
        if (({ mono: 1, stereo: 2, '5.1': 6, '5.1(side)': 6 })[layout] !== audio.channels
          || (outputAudioCodec === 'mp3' && audio.channels > 2)) return unsupported('This audio layout cannot be encoded here without a channel change. No downmix is performed.');
        if (outputAudioCodec === 'mp3' && settings.audio.bitrateKbps != null && !MP3_BITRATES.includes(settings.audio.bitrateKbps)) return unsupported(`Choose a supported MP3 bitrate: ${MP3_BITRATES.join(', ')} kbps.`);
        const sampleRate = [44100, 48000].includes(audio.sampleRate) ? audio.sampleRate : 48000;
        Object.assign(stream, { encoder: outputAudioCodec === 'aac' ? 'aac' : 'libmp3lame', sampleRate,
          channels: audio.channels, channelLayout: layout,
          ...(settings.audio.bitrateKbps != null ? { bitRate: settings.audio.bitrateKbps * 1000 }
            : outputAudioCodec === 'aac' ? { bitRate: { 1: 128000, 2: 256000, 6: 512000 }[audio.channels] } : { quality: 0 }) });
        if (sampleRate !== audio.sampleRate) plan.changes.push(`Resample audio from ${audio.sampleRate} Hz to ${sampleRate} Hz.`);
        plan.changes.push(`Encode ${outputAudioCodec.toUpperCase()} ${stream.bitRate ? `at ${stream.bitRate / 1000} kbps` : 'at quality 0'}; preserve ${layout}.`);
      } else plan.changes.push('Copy the selected audio with its existing bitrate, channels, and sample rate.');
      plan.streams.push(stream);
      Object.assign(plan.output, { audioCodec: outputAudioCodec, sampleRate: stream.sampleRate ?? audio.sampleRate,
        channels: audio.channels, channelLayout: stream.channelLayout ?? audio.channelLayout });
      plan.timing.audioStartSeconds = cuts ? 0 : audio.startSeconds;
      plan.timing.audioEndSeconds = cuts ? plan.timing.durationSeconds : audio.startSeconds != null && audio.durationSeconds != null ? audio.startSeconds + audio.durationSeconds : null;
    } else if (settings.audio.codec !== 'unchanged' || settings.audio.bitrateKbps != null) return unsupported('This source has no audio; choose unchanged audio settings.');
    const extra = source.extraStreams;
    const counts = source.trackCounts || {};
    if (!extra || !Number.isInteger(extra.total) || extra.chapters == null) return incomplete('Stream and chapter inventory is incomplete.');
    plan.omitted = { video: Math.max(0, (counts.video || 0) - 1), audio: Math.max(0, (counts.audio || 0) - (audio ? 1 : 0)),
      subtitles: counts.subtitle || 0, artwork: extra.artwork || 0, other: extra.other || 0, chapters: extra.chapters };
    const omitted = Object.entries(plan.omitted).filter(([, count]) => count > 0);
    if (omitted.length) plan.warnings.push({ id: 'omitted-content', required: true,
      message: `Omit ${omitted.map(([role, count]) => `${count} ${role}`).join(', ')}. Only the selected relevant streams are included.` });
    const allCopy = plan.streams.every(stream => stream.action === 'copy');
    if (allCopy && source.container?.kind === container && extra.total === plan.streams.length && !extra.chapters) return finish('no-op', null, 'No processing needed; download the original file.');
    plan.passes = settings.rate.twoPass ? 2 : 1;
    if (settings.rate.mode === 'bitrate' || settings.rate.mode === 'size') {
      const duration = plan.timing.durationSeconds;
      const audioStream = plan.streams.find(stream => stream.role === 'audio');
      // An inspected average is an estimate for copied audio, not an upper
      // bound. Reserve 15%; final bytes remain the publication authority.
      const audioBitsPerSecond = !audio ? 0 : audioStream.bitRate || (audioStream.action === 'copy' && audio.bitRate > 0 ? Math.ceil(audio.bitRate * 1.15) : null);
      if (settings.rate.mode === 'size' && audioBitsPerSecond == null) return unsupported('The unchanged audio cannot be budgeted honestly. Choose AAC with an explicit audio bitrate, or use an average video bitrate.');
      const maximumBytes = settings.rate.mode === 'size' ? Math.floor(settings.rate.maximumMB * 1e6) : null;
      const audioBytes = audioBitsPerSecond == null ? null : Math.ceil(audioBitsPerSecond * duration / 8);
      const minimumVideoBitrate = 16000;
      // Reserve fixed headers, per-packet tables, and a 3% variable margin.
      // This is a conservative estimate, never a claim that mux overhead is fixed.
      const packetReserve = duration * ((plan.output.frameRate || 60) * 24 + (audio ? 50 * 16 : 0));
      const overheadBytes = Math.ceil(16384 + packetReserve + (maximumBytes || (settings.rate.videoKbps * 1000 * duration / 8 + (audioBytes || 0))) * 0.03);
      const videoBitrate = maximumBytes == null ? Math.round(settings.rate.videoKbps * 1000) : Math.min(1000000000, Math.floor((maximumBytes - overheadBytes - audioBytes) * 8 / duration));
      plan.rateBudget = { maximumBytes, overheadBytes, audioBitsPerSecond, audioBytes, videoBitrate, minimumVideoBitrate,
        estimatedBytes: audioBytes == null ? null : Math.ceil(videoBitrate * duration / 8 + audioBytes + overheadBytes) };
      if (maximumBytes != null && videoBitrate < minimumVideoBitrate) return unsupported('This maximum file size cannot fit the retained duration, selected audio, and container reserve. Increase the size limit or explicitly change the audio bitrate or cuts.');
    }
  }
  if (capabilities?.available !== true) return finish('unknown', 'capability-check', 'Could not check local processing capabilities. Retry after the capability-check cooldown.');
  if (!capabilities.muxers?.has(plan.output.container)) plan.missing.push(`${plan.output.container.toUpperCase()} muxer`);
  if (plan.passes === 2 && !capabilities.muxers?.has('null')) plan.missing.push('null analysis muxer');
  for (const stream of plan.streams.filter(item => item.action === 'encode')) {
    stream.decoder = softwareDecoder(capabilities, stream.codec);
    if (!stream.decoder) plan.missing.push(`selected ${stream.role} software decoder`);
    if (!capabilities.encoders?.has(stream.encoder)) plan.missing.push(`${stream.encoder} encoder`);
  }
  if (plan.missing.length) return finish('unavailable', 'missing-capability', `Missing: ${plan.missing.join(', ')}.`);
  return finish('executable', null, plan.streams.every(stream => stream.action === 'copy') ? 'Remux selected streams without re-encoding.' : 'Process the original source with the committed cuts and requested settings.');
}

function publicProcessingPlan(plan) {
  const { streams, ...result } = plan;
  return { ...result, streams: streams.map(({ role, index, action }) => ({ role, index, action })) };
}

module.exports = { normalizeProcessingSettings, planProcessing, publicProcessingPlan, processingOptions, PRESETS };
