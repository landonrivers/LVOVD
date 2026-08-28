'use strict';

const MAX_SOURCE_FORMATS = 100;

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /https?:\/\//i.test(text)) return null;
  return text.slice(0, maxLength);
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function codecState(value) {
  if (typeof value !== 'string' || !value.trim() || /^NA$/i.test(value.trim())) return null;
  const codec = value.trim().toLowerCase();
  if (codec === 'none') return false;
  if (codec === 'images') return false;
  return true;
}

function hasVisualEvidence(format) {
  if (!format || typeof format !== 'object') return false;
  if (!format.url && !format.manifest_url) return false;
  return [format.height, format.width, format.fps, format.aspect_ratio]
    .some((value) => finitePositive(value) != null);
}

function formatPresence(format) {
  const note = `${format?.format_note || ''} ${format?.resolution || ''}`.toLowerCase();
  const audioOnlyEvidence = /\baudio only\b/.test(note);
  const videoOnlyEvidence = /\bvideo only\b/.test(note);
  const rawVideo = codecState(format?.vcodec);
  const rawAudio = codecState(format?.acodec);

  let video = rawVideo;
  let audio = rawAudio;

  if (audioOnlyEvidence) {
    audio = rawAudio === false ? false : true;
    if (rawVideo == null) video = false;
  }
  if (videoOnlyEvidence) {
    video = rawVideo === false ? false : true;
    if (rawAudio == null) audio = false;
  }
  if (video !== false && hasVisualEvidence(format)) video = true;

  return { video, audio, rawVideo, rawAudio };
}

function mediaType({ video, audio }) {
  if (video === true && audio === true) return 'Video + Audio';
  if (video === true && audio === false) return 'Video only';
  if (video === false && audio === true) return 'Audio only';
  if (video === true && audio == null) return 'Video · audio unknown';
  if (video == null && audio === true) return 'Audio · video unknown';
  return 'Media';
}

function normalizeSourceFormat(format, index) {
  if (!format || typeof format !== 'object') return null;
  if (!format.url && !format.manifest_url) return null;

  const ext = boundedText(format.ext, 20);
  const protocol = boundedText(format.protocol, 40);
  const note = boundedText(format.format_note, 160);
  const rawVideoCodec = boundedText(format.vcodec, 120);
  if (/^mhtml$/i.test(ext || '') || /mhtml/i.test(protocol || '') || /storyboard/i.test(note || '') || /^images$/i.test(rawVideoCodec || '')) {
    return null;
  }

  const presence = formatPresence(format);
  if (presence.video !== true && presence.audio !== true) return null;

  const exactSize = finitePositive(format.filesize);
  const approximateSize = exactSize == null ? finitePositive(format.filesize_approx) : null;

  return {
    id: boundedText(format.format_id, 100) || `format-${index + 1}`,
    note,
    type: mediaType(presence),
    video: presence.video,
    audio: presence.audio,
    width: finitePositive(format.width),
    height: finitePositive(format.height),
    fps: finitePositive(format.fps),
    videoCodec: presence.rawVideo === true ? rawVideoCodec : null,
    audioCodec: presence.rawAudio === true ? boundedText(format.acodec, 120) : null,
    ext,
    totalBitrateKbps: finitePositive(format.tbr),
    videoBitrateKbps: finitePositive(format.vbr),
    audioBitrateKbps: finitePositive(format.abr),
    sizeBytes: exactSize || approximateSize,
    sizeApproximate: exactSize == null && approximateSize != null,
    audioChannels: finitePositive(format.audio_channels),
    sampleRate: finitePositive(format.asr)
  };
}

function formatRank(format) {
  if (format.video === true && format.audio === true) return 0;
  if (format.video === true && format.audio === false) return 1;
  if (format.video === true) return 2;
  if (format.audio === true && format.video === false) return 3;
  if (format.audio === true) return 4;
  return 5;
}

function sourceFormatSummary(info = {}, { limit = MAX_SOURCE_FORMATS } = {}) {
  const rawFormats = Array.isArray(info.formats) && info.formats.length
    ? info.formats
    : ((info?.url || info?.manifest_url || info?.vcodec || info?.acodec) ? [info] : []);

  const formats = rawFormats
    .map(normalizeSourceFormat)
    .filter(Boolean)
    .sort((a, b) =>
      formatRank(a) - formatRank(b)
      || (b.height || 0) - (a.height || 0)
      || (b.fps || 0) - (a.fps || 0)
      || (b.totalBitrateKbps || b.videoBitrateKbps || b.audioBitrateKbps || 0)
        - (a.totalBitrateKbps || a.videoBitrateKbps || a.audioBitrateKbps || 0)
      || String(a.id).localeCompare(String(b.id)));

  const boundedLimit = Math.max(1, Math.min(MAX_SOURCE_FORMATS, Number(limit) || MAX_SOURCE_FORMATS));
  const shown = formats.slice(0, boundedLimit);
  return {
    total: formats.length,
    shown: shown.length,
    limited: formats.length > shown.length,
    formats: shown
  };
}

module.exports = {
  MAX_SOURCE_FORMATS,
  sourceFormatSummary
};
