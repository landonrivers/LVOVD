'use strict';

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'm4v', 'm4a', 'f4v', 'f4a'
]);

function roundMetadataNumber(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePositive(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = finiteInteger(value);
  return number > 0 ? number : null;
}

function boundedText(value, maxLength = 120, { lower = false } = {}) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) return null;
  return (lower ? text.toLowerCase() : text).slice(0, maxLength);
}

function parseFrameRate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value || '').trim();
  if (!text || text === '0/0') return null;
  const rational = text.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  const rate = rational ? Number(rational[1]) / Number(rational[2]) : finiteNumber(text);
  return Number.isFinite(rate) && rate > 0 ? roundMetadataNumber(rate) : null;
}

function normalizedBrandEvidence(format = {}) {
  const major = (boundedText(format.tags?.major_brand, 8, { lower: true }) || '');
  const compatible = (boundedText(format.tags?.compatible_brands, 256, { lower: true }) || '');
  const brands = new Set(/^[a-z0-9]{2,4}$/.test(major) ? [major] : []);
  for (let index = 0; index < compatible.length; index += 4) {
    const brand = compatible.slice(index, index + 4).trim();
    if (brand) brands.add(brand);
  }
  for (const brand of compatible.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)) {
    brands.add(brand);
  }
  return brands;
}

function normalizedContainerIdentity(format, formatNames) {
  const brands = normalizedBrandEvidence(format);
  const isoFamily = formatNames.some(name => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name));
  if (isoFamily) {
    // Parser-family aliases are not container identity. Specific non-MP4
    // brands take precedence over generic compatible ISO brands.
    if (brands.has('qt')) return { kind: 'mov', evidence: 'brand' };
    if ([...brands].some(brand => /^(3gp|3g2)/.test(brand))) return { kind: '3gp', evidence: 'brand' };
    if ([...brands].some(brand => ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'mj2s', 'mjp2'].includes(brand))) {
      return { kind: 'other-iso', evidence: 'brand' };
    }
    if ([...brands].some(brand => MP4_BRANDS.has(brand))) return { kind: 'mp4', evidence: 'brand' };
    return { kind: 'unknown', evidence: null };
  }
  // Known self-contained demuxers, independent of filename, MIME, and labels.
  const known = formatNames.find(name => ['matroska', 'webm', 'avi', 'mpegts', 'mpeg', 'ogg', 'flv',
    'asf', 'nut', 'mp3', 'flac', 'wav', 'aiff', 'aac', 'ac3', 'eac3', 'amr', 'au'].includes(name));
  return known ? { kind: known, evidence: 'demuxer' } : { kind: 'unknown', evidence: null };
}

function normalizedContainerLabel(format, formatNames) {
  const identity = normalizedContainerIdentity(format, formatNames);
  if (identity.kind === 'mov') return 'MOV / QuickTime';
  if (identity.kind === 'mp4') return 'MP4';
  return boundedText(format.format_long_name || format.format_name, 120) || 'Unknown container';
}

function usableStreamIndex(stream) {
  return finiteInteger(stream?.index);
}

function isRealVideoStream(stream) {
  return stream?.codec_type === 'video'
    && Number(stream.disposition?.attached_pic) !== 1
    && Number(stream.disposition?.timed_thumbnails) !== 1;
}

function isPrimaryVideoCandidate(stream) {
  return isRealVideoStream(stream)
    && usableStreamIndex(stream) != null
    && positiveInteger(stream.width) != null
    && positiveInteger(stream.height) != null;
}

function primaryAudioStream(streams) {
  return streams.find((stream) => stream?.codec_type === 'audio' && usableStreamIndex(stream) != null) || null;
}

function normalizedDuration(raw, video, audio, formatNames, timeOriginSeconds) {
  // Stream.duration is elapsed: include each selected stream's start offset
  // before measuring its endpoint from the common origin. MOV/MP4 format.duration
  // can instead report either elapsed time or an absolute endpoint, so it must
  // not override usable stream evidence. Never reset video and audio separately.
  const streamEndpoints = [video, audio].filter(Boolean).map(stream => {
    const elapsed = finitePositive(stream.duration);
    if (elapsed == null) return NaN;
    const streamStart = finiteNumber(stream.start_time) ?? timeOriginSeconds;
    return streamStart + elapsed - timeOriginSeconds;
  }).filter(endpoint => Number.isFinite(endpoint) && endpoint > 0);
  // Without usable stream durations, retain the Matroska/WebM presentation-end
  // fallback; other demuxers' format duration is used as elapsed time. This
  // bounded metadata fallback cannot resolve every ambiguous/missing timestamp.
  const durationIncludesOrigin = formatNames.some(name => ['matroska', 'webm'].includes(name));
  const duration = streamEndpoints.length ? Math.max(...streamEndpoints)
    : (finiteNumber(raw.format?.duration) ?? NaN) - (durationIncludesOrigin ? timeOriginSeconds : 0);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function streamTiming(stream, origin, formatNames) {
  const sampleClock = stream.codec_type === 'audio' && formatNames.some(name => ['wav', 'aiff', 'flac', 'aac', 'mp3'].includes(name));
  // Sample-clock audio formats start at sample zero when they report no PTS.
  const start = finiteNumber(stream.start_time) ?? (sampleClock ? origin : null);
  // Matroska commonly supplies a bounded DURATION tag instead of stream.duration.
  // That tag is the stream's presentation endpoint, including its timestamp shift.
  const tag = typeof stream.tags?.DURATION === 'string' ? stream.tags.DURATION.match(/^(\d{1,8}):(\d{2}):(\d{2}(?:\.\d{1,9})?)$/) : null;
  const endpoint = tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) : null;
  const taggedDuration = endpoint != null && start != null && formatNames.some(name => ['matroska', 'webm'].includes(name))
    ? finitePositive(endpoint - start) : null;
  return {
    startSeconds: start == null ? null : roundMetadataNumber(start - origin),
    durationSeconds: finitePositive(stream.duration) ?? taggedDuration
  };
}

function videoFidelity(stream) {
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list.slice(0, 32) : [];
  const matrix = side.find(item => item.side_data_type === 'Display Matrix');
  const rotation = finiteNumber(matrix?.rotation ?? stream.tags?.rotate);
  let supported = rotation == null || Math.abs(rotation / 90 - Math.round(rotation / 90)) < 0.001;
  if (matrix?.displaymatrix) {
    const entries = String(matrix.displaymatrix).slice(0, 1000).split(/\r?\n/)
      .flatMap(line => line.includes(':') ? line.split(':').at(-1).trim().split(/\s+/).map(Number) : []);
    // Standard orthogonal rotation only: no reflection, skew, translation, or perspective.
    supported &&= entries.length === 9 && entries.every(Number.isFinite)
      && [2, 5, 6, 7].every(index => entries[index] === 0) && entries[8] === 1073741824
      && Math.abs(entries[0] * entries[4] - entries[1] * entries[3] - 65536 ** 2) < 65536
      && [0, 1, 3, 4].every(index => [0, 65536].includes(Math.abs(entries[index])))
      && rotation != null;
  }
  const transfer = boundedText(stream.color_transfer, 80, { lower: true });
  const pixelFormat = boundedText(stream.pix_fmt, 80, { lower: true });
  const alphaTag = finiteNumber(stream.tags?.alpha_mode);
  return {
    rotationDegrees: rotation == null ? null : ((Math.round(rotation) % 360) + 360) % 360,
    orientationSupported: supported,
    sampleAspectRatio: /^\d+:\d+$/.test(stream.sample_aspect_ratio || '') ? stream.sample_aspect_ratio : null,
    colorTransfer: transfer,
    hdr: ['smpte2084', 'arib-std-b67'].includes(transfer) || side.some(item => /DOVI|HDR Dynamic|Mastering display|Content light level/i.test(item.side_data_type || '')) ? true : null,
    alpha: alphaTag === 1 || /^(yuva|gbrap|rgba|bgra|argb|abgr|ya\d|ayuv|vuya|pal8)/.test(pixelFormat || '') ? true : null
  };
}

function normalizeMediaInspection(raw = {}, { sourceSize = null } = {}) {
  const streamsReported = Array.isArray(raw.streams);
  const streams = streamsReported ? raw.streams : [];
  const videoStreams = streams.filter(isRealVideoStream);
  const videoCandidate = videoStreams.find(isPrimaryVideoCandidate) || null;
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
  const audioCandidate = primaryAudioStream(streams);
  const formatName = boundedText(raw.format?.format_name, 400, { lower: true }) || '';
  const formatNames = formatName.split(',')
    .map((name) => name.trim()).filter(Boolean).slice(0, 20);
  // Match FFmpeg -copyts -start_at_zero for both Edit and generic inspection.
  const timeOriginSeconds = finiteNumber(raw.format?.start_time) ?? 0;
  const duration = normalizedDuration(raw, videoCandidate, audioCandidate, formatNames, timeOriginSeconds);
  const hasTimedVideo = Boolean(videoCandidate && duration);
  const mediaKind = videoCandidate
    ? hasTimedVideo ? 'video' : 'unsupported'
    : videoStreams.length ? 'unknown' : audioCandidate ? 'audio' : 'unsupported';
  const normalizedSourceSize = finiteInteger(sourceSize) ?? finiteInteger(raw.format?.size);

  return {
    mediaKind,
    durationSeconds: duration ? roundMetadataNumber(duration) : null,
    timeOriginSeconds,
    sourceSize: normalizedSourceSize,
    format: normalizedContainerLabel(raw.format || {}, formatNames),
    container: normalizedContainerIdentity(raw.format || {}, formatNames),
    formatNames,
    video: videoCandidate ? {
      streamIndex: usableStreamIndex(videoCandidate),
      codec: boundedText(videoCandidate.codec_name, 80, { lower: true }),
      profile: boundedText(videoCandidate.profile, 120),
      width: Math.floor(Number(videoCandidate.width)),
      height: Math.floor(Number(videoCandidate.height)),
      frameRate: parseFrameRate(videoCandidate.avg_frame_rate || videoCandidate.r_frame_rate),
      pixelFormat: boundedText(videoCandidate.pix_fmt, 80, { lower: true }),
      ...streamTiming(videoCandidate, timeOriginSeconds, formatNames),
      ...videoFidelity(videoCandidate)
    } : null,
    audio: audioCandidate ? {
      streamIndex: usableStreamIndex(audioCandidate),
      codec: boundedText(audioCandidate.codec_name, 80, { lower: true }),
      sampleRate: positiveInteger(audioCandidate.sample_rate),
      channels: positiveInteger(audioCandidate.channels),
      channelLayout: boundedText(audioCandidate.channel_layout, 80),
      bitRate: finiteInteger(audioCandidate.bit_rate),
      profile: boundedText(audioCandidate.profile, 80),
      ...streamTiming(audioCandidate, timeOriginSeconds, formatNames)
    } : null,
    trackCounts: {
      video: streamsReported ? videoStreams.length : null,
      audio: streamsReported ? audioStreams.length : null,
      subtitle: streamsReported
        ? streams.filter((stream) => stream?.codec_type === 'subtitle').length
        : null
    },
    extraStreams: streamsReported ? {
      total: streams.length,
      artwork: streams.filter(stream => stream.codec_type === 'video' && !isRealVideoStream(stream)).length,
      other: streams.filter(stream => !['video', 'audio', 'subtitle'].includes(stream.codec_type)).length,
      chapters: Array.isArray(raw.chapters) ? raw.chapters.length : null
    } : null
  };
}

module.exports = {
  parseFrameRate,
  normalizedContainerLabel,
  normalizeMediaInspection,
  isPrimaryVideoCandidate
};
