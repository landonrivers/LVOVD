'use strict';

const { localMediaInputArgs } = require('./local-media-input');

function conversionArgs(inputPath, outputPath, inspection, plan, maxBytes) {
  if (plan.status !== 'executable' || inputPath === outputPath) throw new Error('An executable owned conversion plan and separate output are required.');
  const args = ['-hide_banner', '-nostdin', '-y', '-copyts', '-start_at_zero'];
  const video = plan.streams.find(stream => stream.role === 'video');
  const audio = plan.streams.find(stream => stream.role === 'audio');
  if (plan.timing.audioOnly) args.push('-itsoffset', String(-plan.timing.sourceAudioStartSeconds));
  for (const stream of plan.streams.filter(stream => stream.action === 'encode')) {
    // Input stream specifiers use the inspected absolute index, including aliases.
    args.push(`-c:${stream.index}`, stream.decoder);
  }
  if (!video || video.action === 'copy') args.push('-noautorotate');
  args.push(...localMediaInputArgs(inspection), '-i', inputPath);
  for (const stream of plan.streams) args.push('-map', `0:${stream.index}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn');
  if (video?.action === 'copy') args.push('-c:v', 'copy');
  else if (video) {
    args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-fps_mode:v', 'vfr', '-enc_time_base:v', '1:1000000',
      '-metadata:s:v:0', 'rotate=0');
    if (inspection.video.frameRate) args.push('-x264-params', `fps=${inspection.video.frameRate}`);
  } else args.push('-vn');
  if (audio?.action === 'copy') args.push('-c:a', 'copy');
  else if (audio) {
    // One source clock for video output; audio extraction shifts the entire input
    // by the selected audio start before filling gaps. No stretch or video-tail pad.
    args.push('-c:a', audio.encoder, '-ar', String(audio.sampleRate), '-ac', String(audio.channels),
      '-channel_layout', audio.channelLayout, '-af', 'aresample=async=1:first_pts=0:min_hard_comp=0.001');
    if (audio.bitRate) args.push('-b:a', String(audio.bitRate));
    else args.push('-q:a', String(audio.quality));
  } else args.push('-an');
  if (plan.output.container === 'mp4') args.push('-movflags', '+faststart');
  args.push('-avoid_negative_ts', 'disabled', '-fs', String(maxBytes), '-f', plan.output.container,
    '-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function validateConversionOutput(output, plan) {
  const fail = message => { throw Object.assign(new Error(`Converted output validation failed: ${message}`), {
    workspaceFailure: { category: 'local_conversion_validation', title: 'The converted result did not preserve the requested output',
      explanation: `Validation rejected the result: ${message}. The original source and previous outputs remain available.`,
      help: 'Check the installed FFmpeg build or choose a different supported target. No rejected result is offered for download.' }
  }); };
  const video = plan.streams.find(stream => stream.role === 'video');
  const audio = plan.streams.find(stream => stream.role === 'audio');
  if (output.container?.kind !== plan.output.container) fail('unexpected container');
  if (output.extraStreams?.total !== plan.streams.length || output.trackCounts?.video !== (video ? 1 : 0)
    || output.trackCounts?.audio !== (audio ? 1 : 0) || output.trackCounts?.subtitle !== 0) fail('unexpected stream roles');
  // One frame plus audio priming/muxer rounding, never a half-second displacement.
  const tolerance = Math.max(0.06, 1 / (output.video?.frameRate || 25) + 0.01);
  if (!Number.isFinite(output.durationSeconds) || Math.abs(output.durationSeconds - plan.timing.durationSeconds) > tolerance) fail('duration differs from selected presentation');
  if (video) {
    if (output.video?.codec !== 'h264' || output.video?.pixelFormat !== 'yuv420p'
      || output.video.width !== plan.output.width || output.video.height !== plan.output.height
      || (output.video.rotationDegrees || 0) !== plan.output.rotationDegrees || output.video.orientationSupported === false) fail('video geometry, orientation, or codec');
    if (plan.timing.videoStartSeconds != null && output.video.startSeconds != null
      && Math.abs(output.video.startSeconds - plan.timing.videoStartSeconds) > tolerance) fail('video start changed');
    const ratio = value => { const [n, d] = String(value || '').split(':').map(Number); return n > 0 && d > 0 ? n / d : null; };
    const expectedAspect = ratio(plan.output.sampleAspectRatio);
    if (expectedAspect != null && (ratio(output.video.sampleAspectRatio) == null
      || Math.abs(ratio(output.video.sampleAspectRatio) - expectedAspect) > 0.001)) fail('display aspect changed');
    if (plan.timing.videoEndSeconds != null && output.video.durationSeconds != null
      && Math.abs(output.video.startSeconds + output.video.durationSeconds - plan.timing.videoEndSeconds) > tolerance) fail('video endpoint changed');
  }
  if (audio) {
    if (output.audio?.codec !== plan.output.audioCodec || output.audio.sampleRate !== plan.output.sampleRate
      || output.audio.channels !== plan.output.channels) fail('audio codec, sample rate, or channels');
    if (plan.output.channelLayout && output.audio.channelLayout !== plan.output.channelLayout) fail('audio channel layout changed');
    // Encoded audio deliberately fills leading silence at zero on the common clock.
    const expectedStart = audio.action === 'encode' ? 0 : plan.timing.audioStartSeconds;
    if (expectedStart != null && output.audio.startSeconds != null
      && Math.abs(output.audio.startSeconds - expectedStart) > 0.06) fail('audio start changed');
    if (plan.timing.audioEndSeconds != null && output.audio.durationSeconds != null
      && Math.abs(output.audio.startSeconds + output.audio.durationSeconds - plan.timing.audioEndSeconds) > 0.06) fail('audio endpoint changed');
  }
  return output;
}

module.exports = { conversionArgs, validateConversionOutput };
