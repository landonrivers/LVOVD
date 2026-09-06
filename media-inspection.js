'use strict';

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'm4v', 'm4a', 'f4v', 'f4a',
  '3gp4', '3gp5', '3gp6'
]);

function roundMetadataNumber(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function boundedText(value, maxLength = 120, { lower = false } = {}) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) return null;
  return (lower ? text.toLowerCase() : text).slice(0, maxLength);
}

function parseFrameRate(value) {
  const text = String(value || '').trim();
  if (!text || text === '0/0') return null;
  const rational = text.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  const rate = rational ? Number(rational[1]) / Number(rational[2]) : Number(text);
  return Number.isFinite(rate) && rate > 0 ? roundMetadataNumber(rate) : null;
}

function normalizedBrandEvidence(format = {}) {
  const major = String(format.tags?.major_brand || '').trim().toLowerCase();
  const compatible = String(format.tags?.compatible_brands || '').toLowerCase();
  const brands = new Set(major ? [major] : []);
  for (let index = 0; index < compatible.length; index += 4) {
    const brand = compatible.slice(index, index + 4).trim();
    if (brand) brands.add(brand);
  }
  for (const brand of compatible.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)) {
    brands.add(brand);
  }
  return brands;
}

function normalizedContainerLabel(format, formatNames) {
  const brands = normalizedBrandEvidence(format);
  const isoBaseMediaFamily = formatNames.some((name) => (
    ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name)
  ));
  if (isoBaseMediaFamily && brands.has('qt')) return 'MOV / QuickTime';
  if (isoBaseMediaFamily && [...brands].some((brand) => MP4_BRANDS.has(brand))) return 'MP4';
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
    && finitePositive(stream.width) != null
    && finitePositive(stream.height) != null;
}

function primaryAudioStream(streams) {
  return streams.find((stream) => stream?.codec_type === 'audio' && usableStreamIndex(stream) != null) || null;
}

function normalizedDuration(raw, video, audio) {
  const formatDuration = finitePositive(raw.format?.duration);
  if (video) return formatDuration || finitePositive(video.duration) || null;
  return formatDuration || finitePositive(audio?.duration) || null;
}

function normalizeMediaInspection(raw = {}, { sourceSize = null } = {}) {
  const streamsReported = Array.isArray(raw.streams);
  const streams = streamsReported ? raw.streams : [];
  const videoStreams = streams.filter(isRealVideoStream);
  const videoCandidate = videoStreams.find(isPrimaryVideoCandidate) || null;
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
  const audioCandidate = primaryAudioStream(streams);
  const duration = normalizedDuration(raw, videoCandidate, audioCandidate);
  const hasTimedVideo = Boolean(videoCandidate && duration);
  const mediaKind = videoCandidate
    ? hasTimedVideo ? 'video' : 'unsupported'
    : audioCandidate ? 'audio' : 'unsupported';
  const formatName = boundedText(raw.format?.format_name, 400, { lower: true }) || '';
  const formatNames = formatName.split(',')
    .map((name) => name.trim()).filter(Boolean).slice(0, 20);
  const normalizedSourceSize = finiteInteger(sourceSize) ?? finiteInteger(raw.format?.size);

  return {
    mediaKind,
    durationSeconds: duration ? roundMetadataNumber(duration) : null,
    sourceSize: normalizedSourceSize,
    format: normalizedContainerLabel(raw.format || {}, formatNames),
    formatNames,
    video: videoCandidate ? {
      streamIndex: usableStreamIndex(videoCandidate),
      codec: boundedText(videoCandidate.codec_name, 80, { lower: true }),
      profile: boundedText(videoCandidate.profile, 120),
      width: Math.floor(Number(videoCandidate.width)),
      height: Math.floor(Number(videoCandidate.height)),
      frameRate: parseFrameRate(videoCandidate.avg_frame_rate || videoCandidate.r_frame_rate),
      pixelFormat: boundedText(videoCandidate.pix_fmt, 80, { lower: true })
    } : null,
    audio: audioCandidate ? {
      streamIndex: usableStreamIndex(audioCandidate),
      codec: boundedText(audioCandidate.codec_name, 80, { lower: true }),
      sampleRate: finiteInteger(audioCandidate.sample_rate),
      channels: finiteInteger(audioCandidate.channels),
      channelLayout: boundedText(audioCandidate.channel_layout, 80),
      bitRate: finiteInteger(audioCandidate.bit_rate)
    } : null,
    trackCounts: {
      video: streamsReported ? videoStreams.length : null,
      audio: streamsReported ? audioStreams.length : null,
      subtitle: streamsReported
        ? streams.filter((stream) => stream?.codec_type === 'subtitle').length
        : null
    }
  };
}

module.exports = {
  parseFrameRate,
  normalizedContainerLabel,
  normalizeMediaInspection,
  isPrimaryVideoCandidate
};
