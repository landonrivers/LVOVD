'use strict';

const BROAD_MP4_TARGET = 'broad-compatibility-mp4';
const MP4_FAMILY = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']);

function capabilitySet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

function result(status, title, explanation, actions = null, missing = []) {
  return {
    target: BROAD_MP4_TARGET,
    status,
    title,
    explanation,
    actions,
    missing
  };
}

function decoderName(codec) {
  const normalized = String(codec || '').toLowerCase();
  if (normalized === 'h265') return 'hevc';
  return normalized || null;
}

function missingCapabilities(status, inspection, capabilities) {
  const encoders = capabilitySet(capabilities?.encoders);
  const decoders = capabilitySet(capabilities?.decoders);
  const muxers = capabilitySet(capabilities?.muxers);
  const missing = [];
  if (capabilities?.available !== true) return ['FFmpeg capability discovery'];
  if (!muxers.has('mp4')) missing.push('MP4 muxer');
  if (['reencode-video', 'reencode-video-and-audio'].includes(status)) {
    const sourceDecoder = decoderName(inspection.video?.codec);
    if (sourceDecoder && !decoders.has(sourceDecoder)) missing.push('source video decoder');
    if (!encoders.has('libx264')) missing.push('H.264 software encoder');
  }
  if (['reencode-audio', 'reencode-video-and-audio'].includes(status)) {
    const sourceDecoder = decoderName(inspection.audio?.codec);
    if (sourceDecoder && !decoders.has(sourceDecoder)) missing.push('source audio decoder');
    if (!encoders.has('aac')) missing.push('AAC encoder');
  }
  return missing;
}

function assessBroadCompatibilityMp4(inspection, capabilities) {
  const mediaKind = inspection?.mediaKind || (inspection?.video ? 'video' : inspection?.audio ? 'audio' : 'unsupported');
  if (mediaKind !== 'video') {
    return result(
      'not-applicable',
      mediaKind === 'audio' ? 'Video target not applicable' : 'No supported timed video found',
      mediaKind === 'audio'
        ? 'This is an audio-only source. Broad Compatibility MP4 is a video target.'
        : 'This source is not a supported timed video for the Broad Compatibility MP4 target.'
    );
  }

  const videoCodec = inspection.video?.codec || null;
  const pixelFormat = inspection.video?.pixelFormat || null;
  const audioTracks = inspection.trackCounts?.audio;
  const audioKnownAbsent = audioTracks === 0;
  const audio = inspection.audio || null;
  const audioUnknown = !audio && !audioKnownAbsent;
  const containerNames = Array.isArray(inspection.formatNames) ? inspection.formatNames : [];
  const containerKnown = containerNames.length > 0;
  const containerCompatible = containerKnown
    ? containerNames.some((name) => MP4_FAMILY.has(String(name).toLowerCase()))
    : null;

  let videoCompatible = null;
  if (videoCodec && videoCodec !== 'h264') videoCompatible = false;
  else if (videoCodec === 'h264' && pixelFormat) videoCompatible = pixelFormat === 'yuv420p';

  let audioCompatible = null;
  if (audioKnownAbsent) audioCompatible = true;
  else if (audio?.codec) audioCompatible = audio.codec === 'aac';

  if (videoCompatible == null || audioCompatible == null || audioUnknown) {
    return result(
      'unknown',
      'Compatibility unknown',
      'LVOVD does not have enough reported metadata to prove compatibility with the Broad Compatibility MP4 target.'
    );
  }

  let status;
  let title;
  let explanation;
  let actions;
  if (videoCompatible && audioCompatible) {
    if (containerCompatible == null) {
      return result(
        'unknown',
        'Compatibility unknown',
        'LVOVD does not have enough reported container metadata to prove compatibility with the Broad Compatibility MP4 target.'
      );
    }
    if (containerCompatible) {
      return result(
        'already-compatible',
        'Already broadly compatible',
        'No conversion would be needed for LVOVD\'s Broad Compatibility MP4 target.',
        { container: 'keep', video: 'copy', audio: audioKnownAbsent ? 'none' : 'copy' }
      );
    }
    status = 'remux';
    title = 'Container change only';
    explanation = 'The video and audio codecs can remain unchanged; a remux into MP4 would be enough.';
    actions = { container: 'remux', video: 'copy', audio: audioKnownAbsent ? 'none' : 'copy' };
  } else if (videoCompatible) {
    status = 'reencode-audio';
    title = 'Audio conversion needed';
    explanation = 'The video can be copied, but the audio would need conversion to AAC.';
    actions = { container: 'mp4', video: 'copy', audio: 'reencode' };
  } else if (audioCompatible) {
    status = 'reencode-video';
    title = 'Video conversion needed';
    explanation = 'The source video would need re-encoding to H.264 with an 8-bit yuv420p pixel format.';
    actions = { container: 'mp4', video: 'reencode', audio: audioKnownAbsent ? 'none' : 'copy' };
  } else {
    status = 'reencode-video-and-audio';
    title = 'Video and audio conversion needed';
    explanation = 'The source video would need re-encoding to H.264 and its audio would need conversion to AAC.';
    actions = { container: 'mp4', video: 'reencode', audio: 'reencode' };
  }

  const missing = missingCapabilities(status, inspection, capabilities);
  if (missing.length) {
    return result(
      'unavailable',
      'Conversion unavailable',
      'This FFmpeg installation does not expose all required local decoders, encoders, or the MP4 muxer.',
      actions,
      missing
    );
  }
  return result(status, title, explanation, actions);
}

module.exports = {
  BROAD_MP4_TARGET,
  assessBroadCompatibilityMp4
};
