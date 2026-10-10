'use strict';

const crypto = require('node:crypto');
const { hasSoftwareDecoder } = require('./ffmpeg-capabilities');
const { planConversion, requestError } = require('./conversion-plan');
const { normalizeEditPlan, isFullDurationEditPlan, totalRetainedDuration, roundMilliseconds } = require('./public/edit-plan');

const PRESETS = Object.freeze(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']);
const { AUDIO_CONTAINERS, MP3_BITRATES, audioEncodingPolicy, audioPrecision, editorTimeline } = require('./audio-policy');
const CONTAINERS = Object.freeze({
  mp4: { extension: 'mp4', mime: 'video/mp4', label: 'MP4', muxer: 'mp4' },
  mov: { extension: 'mov', mime: 'video/quicktime', label: 'MOV / QuickTime', muxer: 'mov' },
  matroska: { extension: 'mkv', mime: 'video/x-matroska', label: 'Matroska / MKV', muxer: 'matroska' },
  m4a: { extension: 'm4a', mime: 'audio/mp4', label: 'M4A / AAC', muxer: 'mp4' },
  mp3: { extension: 'mp3', mime: 'audio/mpeg', label: 'MP3', muxer: 'mp3' },
  opus: { extension: 'opus', mime: 'audio/ogg', label: 'Opus', muxer: 'ogg' },
  flac: { extension: 'flac', mime: 'audio/flac', label: 'FLAC', muxer: 'flac' },
  wav: { extension: 'wav', mime: 'audio/wav', label: 'WAV / PCM', muxer: 'wav' }
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
  object(raw, ['videoCodec', 'container', 'scale', 'frameRate', 'rate', 'audio', 'filenameSuffix'], 'Processing settings');
  const scale = object(raw.scale === undefined ? {} : raw.scale, ['mode', 'width', 'height', 'percent', 'allowUpscale'], 'Scale');
  const rate = object(raw.rate === undefined ? {} : raw.rate, ['mode', 'crf', 'preset', 'videoKbps', 'maximumMB', 'twoPass'], 'Encoding rate');
  const audio = object(raw.audio === undefined ? {} : raw.audio, ['codec', 'bitrateKbps'], 'Audio');
  const scaleMode = choice(scale.mode === undefined ? 'unchanged' : scale.mode, ['unchanged', 'fit', 'width', 'height', 'percent'], 'scaling mode');
  const rateMode = choice(rate.mode === undefined ? 'automatic' : rate.mode, ['automatic', 'quality', 'bitrate', 'size'], 'encoding mode');
  if (scale.allowUpscale !== undefined && typeof scale.allowUpscale !== 'boolean') throw requestError('Allow upscale must be a boolean.');
  if (rate.twoPass !== undefined && typeof rate.twoPass !== 'boolean') throw requestError('Two pass must be a boolean.');
  // Inactive bounded control values can survive a mode change in the browser;
  // normalize them deliberately so they cannot affect an admitted plan or key.
  if (scale.width != null) number(scale.width, 2, 16384, 'Maximum width', true);
  if (scale.height != null) number(scale.height, 2, 16384, 'Maximum height', true);
  if (scale.percent != null) number(scale.percent, 1, 100, 'Scale percentage');
  const filenameSuffix = raw.filenameSuffix === undefined ? '-processed' : raw.filenameSuffix;
  if (typeof filenameSuffix !== 'string' || filenameSuffix.length > 60 || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filenameSuffix)) {
    throw requestError('The filename suffix must be at most 60 characters, without path separators or reserved filename characters.');
  }
  if (rate.crf != null) number(rate.crf, 0, 51, 'CRF', true);
  if (rate.preset != null) choice(rate.preset, PRESETS, 'software preset');
  if (rate.videoKbps != null) number(rate.videoKbps, 1, 1000000, 'Video bitrate');
  if (rate.maximumMB != null) number(rate.maximumMB, 0.001, 100 * 1024 ** 3 / 1e6, 'Maximum MB');
  const normalized = {
    videoCodec: choice(raw.videoCodec === undefined ? 'unchanged' : raw.videoCodec, ['unchanged', 'h264'], 'video codec'),
    container: choice(raw.container === undefined ? 'source' : raw.container, ['source', ...Object.keys(CONTAINERS)], 'container'),
    filenameSuffix,
    scale: { mode: scaleMode, width: ['fit', 'width'].includes(scaleMode) ? number(scale.width, 2, 16384, 'Maximum width', true) : null,
      height: ['fit', 'height'].includes(scaleMode) ? number(scale.height, 2, 16384, 'Maximum height', true) : null,
      percent: scaleMode === 'percent' ? number(scale.percent, 1, 100, 'Scale percentage') : null,
      allowUpscale: scaleMode !== 'unchanged' ? scale.allowUpscale ?? false : false },
    frameRate: raw.frameRate == null ? null : number(raw.frameRate, 0.1, 120, 'Frame rate'),
    rate: { mode: rateMode, crf: rateMode === 'quality' ? rate.crf ?? 18 : 18,
      preset: rateMode === 'automatic' ? 'medium' : rate.preset ?? 'medium',
      videoKbps: rateMode === 'bitrate' ? number(rate.videoKbps, 1, 1000000, 'Video bitrate') : null,
      maximumMB: rateMode === 'size' ? number(rate.maximumMB, 0.001, 100 * 1024 ** 3 / 1e6, 'Maximum MB') : null,
      twoPass: rateMode === 'size' || (rateMode === 'bitrate' && (rate.twoPass ?? false)) },
    audio: { codec: choice(audio.codec === undefined ? 'unchanged' : audio.codec, ['unchanged', 'aac', 'mp3', 'opus', 'flac', 'pcm'], 'audio codec'),
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
  const audioCodecAvailable = codec => audio && (audio.codec === codec || (checked
    && !audioEncodingPolicy(audio, codec).error && hasSoftwareDecoder(capabilities, audio.codec)
    && capabilities.encoders?.has(audioEncodingPolicy(audio, codec).stream.encoder)));
  const containers = [{ value: 'source', label: 'Keep source' }];
  if (source.video && checked) for (const value of ['mp4', 'mov', 'matroska']) {
    if (capabilities.muxers?.has(value) && (h264 || COPY_CODECS[value].video.includes(source.video.codec))
      && (!audio || COPY_CODECS[value].audio.includes(audio.codec)
        || (value === 'matroska' ? ['aac', 'mp3', 'opus', 'flac'] : ['aac', 'mp3']).some(audioCodecAvailable))) containers.push({ value, label: CONTAINERS[value].label });
  }
  if (checked) for (const [value, codec] of [['m4a', 'aac'], ['mp3', 'mp3'], ['opus', 'opus'], ['flac', 'flac'], ['wav', 'pcm']]) {
    if (capabilities.muxers?.has(CONTAINERS[value].muxer) && audioCodecAvailable(codec)) containers.push({ value, label: CONTAINERS[value].label });
  }
  return {
    checked,
    videoCodecs: [{ value: 'unchanged', label: 'Unchanged' }, ...(h264 ? [{ value: 'h264', label: 'H.264' }] : [])], containers,
    audioCodecs: [{ value: 'unchanged', label: 'Unchanged' }, ...['aac', 'mp3', 'opus', 'flac', 'pcm'].filter(audioCodecAvailable).map(value => ({ value, label: value === 'pcm' ? 'PCM (automatic precision)' : value.toUpperCase() }))],
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
  const factor = Math.min(scale.mode === 'percent' ? scale.percent / 100 : Infinity,
    scale.width == null ? Infinity : scale.width / displayWidth, scale.height == null ? Infinity : scale.height / height,
    16384 / displayWidth, 16384 / height,
    ...(scale.allowUpscale ? [] : [1, width / displayWidth]));
  const outputWidth = Math.max(2, Math.floor(displayWidth * factor / 2) * 2);
  const outputHeight = Math.max(2, Math.floor(height * factor / 2) * 2);
  const [n, d] = String(sar || '1:1').split(':').map(Number);
  return { width: outputWidth, height: outputHeight, rotationDegrees: 0,
    sampleAspectRatio: rationalAspect(width * outputHeight * n, height * outputWidth * d) };
}
function processingFilename(name, extension, suffix = '-processed') {
  const stem = String(name || 'Local media').split(/[\\/]/).at(-1).replace(/\.[^.]*$/, '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 180) || 'Local media';
  return `${stem}${suffix}${extension ? `.${extension}` : ''}`;
}

function sizeEstimate(plan, source) {
  const video = plan.streams.find(stream => stream.role === 'video');
  const audio = plan.streams.find(stream => stream.role === 'audio');
  const videoBitrate = plan.rateBudget?.videoBitrate ?? (video?.action === 'copy' ? source.video?.bitRate : null);
  const audioBitrate = audio ? audio.bitRate ?? (audio.action === 'copy' ? source.audio?.bitRate : null) : 0;
  const result = { bytes: null, exact: false, videoBitrate: videoBitrate ?? null, audioBitrate: audioBitrate ?? null,
    explanation: 'Size varies with quality and content; measured after processing.' };
  if (!['executable', 'no-op'].includes(plan.status)) return { ...result, explanation: 'Complete a valid review to estimate size.' };
  if (plan.status === 'no-op') return { ...result, bytes: source.sourceSize ?? null, exact: source.sourceSize != null,
    explanation: source.sourceSize != null ? 'Exact size: existing original bytes.' : 'Original file size is unavailable.' };
  if (plan.rateBudget) return { ...result, bytes: plan.rateBudget.estimatedBytes,
    explanation: plan.rateBudget.estimatedBytes == null ? 'Cannot estimate without a known audio bitrate.' : 'Estimate includes audio and a container reserve; actual bytes are measured before publication.' };
  // Estimate only from available rate evidence. CRF and MP3 VBR cannot honestly
  // be predicted from the size of the source or an unrelated source bitrate.
  const duration = plan.timing.durationSeconds;
  if ((!video || videoBitrate > 0) && (!audio || audioBitrate > 0) && duration > 0) {
    const bytes = ((videoBitrate || 0) + (audioBitrate || 0)) * duration / 8;
    return { ...result, bytes: Math.ceil(bytes * 1.03 + 16384 + duration * ((plan.output.frameRate || 0) * 24 + (audio ? 800 : 0))),
      explanation: 'Estimate from selected stream bitrates, retained duration, and container reserve; actual size varies.' };
  }
  if (plan.streams.length && plan.streams.every(stream => stream.action === 'copy') && !plan.cuts
    && source.extraStreams?.total === plan.streams.length && !source.extraStreams?.chapters && source.sourceSize > 0) {
    return { ...result, bytes: Math.ceil(source.sourceSize * 1.03 + 16384), explanation: 'Approximate remux size from the complete source; container overhead varies.' };
  }
  return result;
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
  const timeline = editorTimeline(source);
  const editDuration = source.video ? source.durationSeconds : timeline.durationSeconds;
  let editPlan = null;
  if (editDuration > 0) {
    if (rawEditPlan != null) {
      object(rawEditPlan, ['version', 'keepRanges'], 'Edit plan');
      if (Array.isArray(rawEditPlan.keepRanges)) for (const range of rawEditPlan.keepRanges) object(range, ['startSeconds', 'endSeconds'], 'Retained range');
    }
    try { editPlan = normalizeEditPlan(rawEditPlan ?? { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: roundMilliseconds(editDuration) }] }, roundMilliseconds(editDuration)); }
    catch (error) { throw requestError(error.message); }
  } else if (rawEditPlan != null) throw requestError('A known source duration is required for cuts.');
  const cuts = editPlan && !isFullDurationEditPlan(editPlan, editDuration);
  const defaultRequest = settings.videoCodec === 'unchanged' && settings.container === 'source'
    && settings.scale.mode === 'unchanged' && settings.frameRate == null && settings.rate.mode === 'automatic'
    && settings.audio.codec === 'unchanged' && settings.audio.bitrateKbps == null && !cuts;
  const plan = {
    version: 1, workspaceId, sourceAssetId, inputAssetId: sourceAssetId, inputRole: 'source', inputFilename, draftRevision,
    inspectionKey: crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    inputDurationSeconds: editDuration, settings, editPlan, cuts: Boolean(cuts),
    status: 'unknown', reason: 'incomplete', message: 'More source metadata is needed.',
    streams: [], changes: [], warnings: [], missing: [], output: {}, passes: 1, rateBudget: null,
    options: processingOptions(source, capabilities),
    timing: { originSeconds: source.timeOriginSeconds, audioOnly: false, durationSeconds: editPlan ? totalRetainedDuration(editPlan) : editDuration }
  };
  const finish = (status, reason, message) => {
    Object.assign(plan, { status, reason, message });
    const extension = status === 'no-op' ? String(inputFilename || '').match(/\.([a-zA-Z0-9]{1,12})$/)?.[1] || plan.output.extension : plan.output.extension;
    plan.downloadFilename = extension || status === 'no-op' ? processingFilename(inputFilename, extension, settings.filenameSuffix) : null;
    plan.sizeEstimate = sizeEstimate(plan, source);
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
    const precision = audioPrecision(source.audio || {});
    if (precision.bitDepth) Object.assign(plan.output, precision);
    for (const role of ['video', 'audio']) if (source[role]) plan.streams.push({ role, index: source[role].streamIndex, action: 'copy', codec: source[role].codec });
    plan.timing.audioOnly = !source.video;
    plan.preserveSourceInventory = true;
    plan.changes.push('Keep all original bytes, streams, chapters, and metadata.');
    return finish('no-op', null, 'No processing needed; download the original file.');
  }
  if (!editPlan) return incomplete('A known positive source duration is required for processing.');
  const audioOnly = AUDIO_CONTAINERS.includes(settings.container) || (!source.video && settings.container === 'source');
  plan.timing.audioOnly = audioOnly;
  const video = audioOnly ? null : source.video;
  const audio = source.audio;
  let container = settings.container === 'source' ? source.container?.kind : settings.container;
  if (audioOnly) {
    if (settings.videoCodec !== 'unchanged' || settings.scale.mode !== 'unchanged' || settings.frameRate != null || settings.rate.mode !== 'automatic') {
      return unsupported('Choose Automatic and unchanged video settings for audio-only output.');
    }
    if (!audio) return unsupported('This source has no selected audio to convert.');
    if (settings.container === 'source') {
      container = ({ mp4: 'm4a', mp3: 'mp3', flac: 'flac', wav: 'wav' })[container]
        || (container === 'ogg' && audio.codec === 'opus' ? 'opus' : null);
      if (!container) return unsupported('Keep source cannot encode this audio container. Choose an explicit audio output format.');
    }
    const codec = ({ m4a: 'aac', mp3: 'mp3', opus: 'opus', flac: 'flac', wav: 'pcm' })[container];
    if (!codec) return unsupported('Choose a supported audio output format.');
    if (settings.audio.codec !== 'unchanged' && settings.audio.codec !== codec) return unsupported('The chosen audio codec does not match this audio container.');
    // Keep the established full-file AAC/MP3 conversion behavior compatible.
    if (['aac', 'mp3'].includes(codec) && !cuts && settings.audio.bitrateKbps == null) {
      const delegated = planConversion({ workspaceId, inputAssetId: sourceAssetId, inputFilename, inspection: source,
        targetId: codec === 'aac' ? 'm4a-aac' : 'mp3', capabilities });
      Object.assign(plan, { output: delegated.output, streams: delegated.streams, timing: delegated.timing,
        changes: delegated.changes, warnings: delegated.warnings, missing: delegated.missing, omitted: delegated.omitted });
      return finish(delegated.status, delegated.reason, delegated.message);
    }
    const descriptor = CONTAINERS[container];
    const copy = !cuts && settings.audio.bitrateKbps == null && source.container?.kind === descriptor.muxer
      && (audio.codec === codec || (codec === 'pcm' && /^pcm_(?:[su](?:8|16|24|32)|f(?:32|64))(?:le)?$/.test(audio.codec)));
    const policy = copy ? { stream: { role: 'audio', index: audio.streamIndex, codec: audio.codec, action: 'copy' }, outputCodec: audio.codec }
      : audioEncodingPolicy(audio, codec, settings.audio.bitrateKbps);
    if (policy.error) return policy.reason === 'incomplete' ? incomplete(policy.error) : unsupported(policy.error);
    plan.streams = [policy.stream];
    const precision = copy ? audioPrecision(audio) : policy.stream;
    plan.output = { ...descriptor, container: descriptor.muxer, audioCodec: policy.outputCodec,
      sampleRate: policy.stream.sampleRate ?? audio.sampleRate, channels: audio.channels,
      channelLayout: policy.stream.channelLayout ?? audio.channelLayout, bitDepth: precision.bitDepth, representation: precision.representation };
    const offset = !source.video || !cuts ? audio.startSeconds : 0;
    const duration = cuts ? totalRetainedDuration(editPlan) : audio.durationSeconds ?? (!source.video ? editDuration : null);
    if (!(duration > 0) || !Number.isFinite(offset)) return incomplete('Selected-stream timing is incomplete; the audio endpoint cannot be inferred from an unrelated video tail.');
    plan.timing = { originSeconds: source.timeOriginSeconds, audioOnly: true, sourceAudioStartSeconds: offset,
      durationSeconds: duration, audioStartSeconds: 0, audioEndSeconds: duration };
    if (policy.stream.sampleRate && policy.stream.sampleRate !== audio.sampleRate) plan.changes.push(`Resample audio from ${audio.sampleRate} Hz to ${policy.stream.sampleRate} Hz.`);
    plan.changes.push(copy ? 'Copy the selected audio with its existing sample rate, channels, and precision.'
      : `Encode ${codec.toUpperCase()}${policy.stream.bitRate && codec !== 'pcm' ? ' at ' + policy.stream.bitRate / 1000 + ' kbps' : ''}; preserve ${plan.output.channelLayout}${plan.output.bitDepth ? ', ' + plan.output.bitDepth + '-bit ' + plan.output.representation : ''}.`);
    if (codec === 'opus' && !copy) plan.changes.push('Opus is lossy; use 48 kHz playback with variable bitrate.');
    plan.changes.push(cuts ? `Apply ${editPlan.keepRanges.length} retained range(s) directly to original audio, retaining ${duration} seconds including timestamped silence.`
      : 'Use a zero-based selected-audio timeline; do not append any video-only tail.');
    if (!source.extraStreams || !Number.isInteger(source.extraStreams.total) || source.extraStreams.chapters == null) return incomplete('Stream and chapter inventory is incomplete.');
    plan.omitted = { video: source.trackCounts?.video || 0, audio: Math.max(0, (source.trackCounts?.audio || 0) - 1),
      subtitles: source.trackCounts?.subtitle || 0, artwork: source.extraStreams.artwork || 0, other: source.extraStreams.other || 0, chapters: source.extraStreams.chapters };
    const omissions = Object.entries(plan.omitted).filter(([role, count]) => role !== 'video' && count > 0);
    if (omissions.length) plan.warnings.push({ id: 'omitted-content', required: true, message: `Omit ${omissions.map(([role, count]) => count + ' ' + role).join(', ')}. Only the selected audio is included.` });
    if (copy && source.extraStreams.total === 1 && !source.extraStreams.chapters) return finish('no-op', null, 'No processing needed; download the original file.');
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
    const encodeVideo = Boolean(cuts || settings.scale.mode !== 'unchanged' || settings.frameRate != null
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
    if (settings.scale.mode !== 'unchanged') plan.changes.push(`Scale to ${resolved.width} × ${resolved.height}, adjusted to fit display aspect${settings.scale.allowUpscale ? '' : ' without upscaling'}; even encoder dimensions, no cropping.`);
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
      const encodable = container === 'matroska' ? ['aac', 'mp3', 'opus', 'flac'] : ['aac', 'mp3'];
      if (encode && !encodable.includes(outputAudioCodec)) return unsupported('These cuts or audio changes require a compatible audio encoder. Choose AAC, MP3, or an MKV audio encoder explicitly.');
      if (!COPY_CODECS[container].audio.includes(outputAudioCodec)) return unsupported('This audio codec is incompatible with the selected container. Choose a compatible codec explicitly; audio will not be removed.');
      const policy = encode ? audioEncodingPolicy(audio, outputAudioCodec, settings.audio.bitrateKbps) : null;
      if (policy?.error) return policy.reason === 'incomplete' ? incomplete(policy.error) : unsupported(policy.error);
      const stream = encode ? policy.stream : { role: 'audio', index: audio.streamIndex, action: 'copy', codec: audio.codec };
      if (encode) {
        if (stream.sampleRate !== audio.sampleRate) plan.changes.push(`Resample audio from ${audio.sampleRate} Hz to ${stream.sampleRate} Hz.`);
        plan.changes.push(`Encode ${outputAudioCodec.toUpperCase()}${stream.bitRate ? ' at ' + stream.bitRate / 1000 + ' kbps' : stream.quality != null ? ' at quality ' + stream.quality : ''}; preserve ${stream.channelLayout}.`);
      } else plan.changes.push('Copy the selected audio with its existing bitrate, channels, and sample rate.');
      plan.streams.push(stream);
      Object.assign(plan.output, { audioCodec: outputAudioCodec, sampleRate: stream.sampleRate ?? audio.sampleRate,
        channels: audio.channels, channelLayout: stream.channelLayout ?? audio.channelLayout,
        ...(encode && stream.bitDepth ? { bitDepth: stream.bitDepth, representation: stream.representation } : {}) });
      if (!encode) {
        const precision = audioPrecision(audio);
        if (precision.bitDepth) Object.assign(plan.output, precision);
      }
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

module.exports = { normalizeProcessingSettings, planProcessing, publicProcessingPlan, processingOptions, processingFilename, PRESETS };
