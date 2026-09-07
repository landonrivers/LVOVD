'use strict';

// Local workspace inputs only. This is a demuxer policy, not a codec list or an
// OS sandbox. libavformat checks format_whitelist before the demuxer's header
// reader can resolve dependencies. Never replace it with a file-only protocol
// list: file access alone does not confine a manifest's referenced files.
const LOCAL_INPUT_FORMATS = Object.freeze([
  'mov', 'matroska', 'avi', 'asf', 'flv', 'mpeg', 'mpegts', 'ogg', 'nut',
  'mp3', 'aac', 'flac', 'wav', 'aiff', 'amr', 'ape', 'wv', 'tta',
  'ac3', 'eac3', 'dts', 'au', 'caf'
]);

function localMediaInputArgs(inspection = null) {
  const args = [
    '-format_whitelist', LOCAL_INPUT_FORMATS.join(','),
    '-protocol_whitelist', 'file'
  ];
  // ffprobe accepts demuxer AVOptions while detecting the format. FFmpeg
  // rejects unused MOV options for other containers, so pin its demuxer to the
  // already inspected format and apply those options only to MOV-family input.
  let format = null;
  if (inspection) {
    format = (inspection.formatNames || []).find(name => LOCAL_INPUT_FORMATS.includes(name));
    if (!format) throw new Error('Unsupported local media container.');
    args.push('-f', format);
  }
  if (!inspection || format === 'mov') {
    args.push('-enable_drefs', '0', '-use_absolute_path', '0');
  }
  return args;
}

module.exports = { LOCAL_INPUT_FORMATS, localMediaInputArgs };
