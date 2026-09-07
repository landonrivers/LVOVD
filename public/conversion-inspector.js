'use strict';

(function attachConversionInspector(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) root.LVOVDMediaFacts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createConversionInspectorApi() {
  const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
  const CODEC_LABELS = Object.freeze({
    h264: 'H.264',
    hevc: 'H.265 / HEVC',
    h265: 'H.265 / HEVC',
    av1: 'AV1',
    vp9: 'VP9',
    aac: 'AAC',
    opus: 'Opus',
    mp3: 'MP3',
    flac: 'FLAC',
    pcm_s16le: 'PCM 16-bit'
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function familiarCodecName(value) {
    const codec = String(value || '').trim().toLowerCase();
    if (!codec) return 'Unknown';
    return CODEC_LABELS[codec] || codec.replace(/_/g, ' ').toUpperCase();
  }

  function formatBytes(value) {
    if (value == null || (typeof value === 'string' && !value.trim())) return 'Unknown';
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let index = -1;
    do {
      amount /= 1024;
      index += 1;
    } while (amount >= 1024 && index < units.length - 1);
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown';
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const wholeSeconds = Math.floor(milliseconds % 60_000 / 1000);
    const remainder = milliseconds % 1000;
    return [hours, minutes, wholeSeconds]
      .map((part) => String(part).padStart(2, '0')).join(':')
      + `.${String(remainder).padStart(3, '0')}`;
  }

  function mediaKindLabel(value) {
    if (value === 'video') return 'Video';
    if (value === 'audio') return 'Audio';
    return 'Unsupported or unknown';
  }

  function countLabel(value) {
    return Number.isInteger(value) && value >= 0 ? String(value) : 'Unknown';
  }

  function inspectionFacts(snapshot) {
    const inspection = snapshot?.inspection || {};
    const video = inspection.video;
    const audio = inspection.audio;
    const counts = inspection.trackCounts || {};
    const facts = [
      ['Filename', snapshot?.source?.name || 'Local media'],
      ['File size', formatBytes(snapshot?.source?.size ?? inspection.sourceSize)],
      ['Media type', mediaKindLabel(inspection.mediaKind)],
      ['Container', inspection.format || 'Unknown'],
      ['Duration', formatDuration(inspection.durationSeconds)]
    ];
    if (video) {
      facts.push(
        ['Video codec', familiarCodecName(video.codec)],
        ['Video profile', video.profile || 'Unknown'],
        ['Resolution', Number.isFinite(video.width) && Number.isFinite(video.height)
          ? `${video.width} × ${video.height}` : 'Unknown'],
        ['Frame rate', Number.isFinite(video.frameRate) ? `${video.frameRate} fps` : 'Unknown'],
        ['Pixel format', video.pixelFormat || 'Unknown']
      );
    }
    if (audio) {
      facts.push(
        ['Audio codec', familiarCodecName(audio.codec)],
        ['Sample rate', Number.isFinite(audio.sampleRate)
          ? (audio.sampleRate >= 1000
            ? `${audio.sampleRate / 1000} kHz`
            : `${audio.sampleRate} Hz`)
          : 'Unknown'],
        ['Channels', Number.isFinite(audio.channels) ? String(audio.channels) : 'Unknown'],
        ['Channel layout', audio.channelLayout || 'Unknown'],
        ['Audio bitrate', Number.isFinite(audio.bitRate)
          ? `${Math.round(audio.bitRate / 1000)} kbps` : 'Unknown']
      );
    }
    facts.push([
      'Tracks',
      `${countLabel(counts.video)} video · ${countLabel(counts.audio)} audio · ${countLabel(counts.subtitle)} subtitle`
    ]);
    return facts;
  }

  return {
    familiarCodecName,
    formatBytes,
    formatDuration,
    mediaKindLabel,
    inspectionFacts
  };
});
