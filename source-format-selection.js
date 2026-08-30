'use strict';

const SAFE_SOURCE_FORMAT_ID = /^[A-Za-z0-9._-]{1,100}$/;

function normalizeSourceFormatId(value, label = 'source format') {
  if (typeof value !== 'string') throw new Error(`Choose a valid ${label} from the current Preview.`);
  const id = value.trim();
  if (!SAFE_SOURCE_FORMAT_ID.test(id)) {
    throw new Error(`Choose a valid ${label} from the current Preview.`);
  }
  return id;
}

function normalizeSourceFormatSelection(raw, content) {
  if (!raw || raw.mode !== 'manual' || content === 'extras') return { mode: 'automatic' };

  if (content === 'av') {
    if (raw.type === 'combined') {
      return {
        mode: 'manual',
        type: 'combined',
        combinedId: normalizeSourceFormatId(raw.combinedId, 'combined source format')
      };
    }
    if (raw.type === 'separate') {
      return {
        mode: 'manual',
        type: 'separate',
        videoId: normalizeSourceFormatId(raw.videoId, 'video source format'),
        audioId: normalizeSourceFormatId(raw.audioId, 'audio source format')
      };
    }
    throw new Error('Choose either one combined source format or one video format plus one audio format.');
  }

  if (content === 'video') {
    if (raw.type !== 'video') throw new Error('Choose a video-only source format for Video Only.');
    return {
      mode: 'manual',
      type: 'video',
      videoId: normalizeSourceFormatId(raw.videoId, 'video source format')
    };
  }

  if (content === 'audio') {
    if (raw.type !== 'audio') throw new Error('Choose an audio-only source format for Audio Only.');
    return {
      mode: 'manual',
      type: 'audio',
      audioId: normalizeSourceFormatId(raw.audioId, 'audio source format')
    };
  }

  return { mode: 'automatic' };
}

function sourceFormatSelector(selection) {
  if (!selection || selection.mode !== 'manual') return null;
  if (selection.type === 'combined') return selection.combinedId;
  if (selection.type === 'separate') return `${selection.videoId}+${selection.audioId}`;
  if (selection.type === 'video') return selection.videoId;
  if (selection.type === 'audio') return selection.audioId;
  return null;
}

module.exports = {
  SAFE_SOURCE_FORMAT_ID,
  normalizeSourceFormatId,
  normalizeSourceFormatSelection,
  sourceFormatSelector
};
