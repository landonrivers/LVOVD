'use strict';

const { localMediaInputArgs } = require('./local-media-input');
const { roundMilliseconds } = require('./public/edit-plan');

function processingVideoFilter(inspection, plan) {
  const video = plan.streams.find(stream => stream.role === 'video');
  if (video?.action !== 'encode') return null;
  const transforms = [];
  if (plan.cuts) {
    // The accepted editor's common-clock mapping: remove authored time from
    // each source PTS, without independently rebasing stream starts or allowing
    // frame rounding to accumulate across concatenated video segments.
    const ranges = plan.editPlan.keepRanges;
    const micros = seconds => Math.round(seconds * 1_000_000);
    const selection = ranges.map(range => `gte(pts,${micros(range.startSeconds)})*lt(pts,${micros(range.endSeconds)})`).join('+');
    const removed = ranges.map((range, index) => index === 0 ? String(micros(range.startSeconds))
      : `gte(PTS,${micros(range.startSeconds)})*${micros(roundMilliseconds(range.startSeconds - ranges[index - 1].endSeconds))}`).join('+');
    transforms.push('settb=AVTB', `trim=end_pts=${micros(ranges.at(-1).endSeconds)}`, `select='${selection}'`, `setpts='PTS-(${removed})'`);
  }
  if (plan.settings.scale.mode !== 'unchanged') transforms.push(`scale=${plan.output.width}:${plan.output.height}`);
  else transforms.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  if (plan.settings.frameRate != null) transforms.push(`fps=fps=${plan.settings.frameRate}:round=near:eof_action=pass`);
  return `[0:${video.index}]${transforms.join(',')}[vout]`;
}

function processingAudioFilters(plan) {
  const audio = plan.streams.find(stream => stream.role === 'audio');
  if (audio?.action !== 'encode') return [];
  const clock = 'aresample=async=1:first_pts=0:min_hard_comp=0.001';
  if (!plan.cuts) return [`[0:${audio.index}]${clock}[aout]`];
  const ranges = plan.editPlan.keepRanges;
  // Fill timestamped silence on the source presentation clock BEFORE cutting.
  // The bounded pad preserves silent retained intervals and the accepted editor
  // behavior when the audio ends before the selected video endpoint.
  const end = ranges.at(-1).endSeconds;
  return [
    `[0:${audio.index}]${clock},apad=whole_dur=${end},atrim=end=${end},asplit=${ranges.length}${ranges.map((_, index) => `[as${index}]`).join('')}`,
    ...ranges.map((range, index) => `[as${index}]atrim=start=${range.startSeconds}:end=${range.endSeconds},asetpts=PTS-${range.startSeconds}/TB[a${index}]`),
    `${ranges.map((_, index) => `[a${index}]`).join('')}concat=n=${ranges.length}:v=0:a=1[aout]`
  ];
}

function processingArgs(inputPath, outputPath, inspection, plan, { pass = null, passLogPrefix = null, videoBitrate = null } = {}) {
  if (plan.status !== 'executable' || !inputPath || !outputPath || inputPath === outputPath) throw new Error('An executable owned processing plan and a separate output are required.');
  if (plan.passes === 2 && (![1, 2].includes(pass) || typeof passLogPrefix !== 'string' || !passLogPrefix)) {
    throw new Error('Two-pass processing requires an attempt-owned pass log and an explicit pass.');
  }
  if (plan.passes !== 2 && pass != null) throw new Error('This processing plan does not use two passes.');
  const firstPass = pass === 1;
  const video = plan.streams.find(stream => stream.role === 'video');
  const audio = firstPass ? null : plan.streams.find(stream => stream.role === 'audio');
  const args = ['-hide_banner', '-nostdin', '-y', '-copyts', '-start_at_zero'];
  if (plan.timing.audioOnly && !plan.cuts) args.push('-itsoffset', String(-plan.timing.sourceAudioStartSeconds));
  for (const stream of plan.streams.filter(item => item.action === 'encode' && (!firstPass || item.role === 'video'))) {
    if (!/^[a-z0-9_][a-z0-9_.-]{0,79}$/.test(stream.decoder || '')) throw new Error('The admitted software decoder is missing.');
    args.push(`-c:${stream.index}`, stream.decoder);
  }
  if (!video || video.action === 'copy') args.push('-noautorotate');
  args.push(...localMediaInputArgs(inspection), '-i', inputPath);
  const videoFilter = processingVideoFilter(inspection, plan);
  const audioFilters = firstPass ? [] : processingAudioFilters(plan);
  const filters = [...(videoFilter ? [videoFilter] : []), ...audioFilters];
  if (filters.length) args.push('-filter_complex', filters.join(';'));
  if (video) args.push('-map', video.action === 'encode' ? '[vout]' : `0:${video.index}`);
  if (audio) args.push('-map', audio.action === 'encode' ? '[aout]' : `0:${audio.index}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn');
  if (video?.action === 'copy') args.push('-c:v', 'copy');
  else if (video) {
    args.push('-c:v', 'libx264', '-preset', video.preset, '-pix_fmt', 'yuv420p',
      '-fps_mode:v', 'vfr', '-enc_time_base:v', '1:1000000', '-metadata:s:v:0', 'rotate=0');
    if (plan.settings.rate.mode === 'bitrate' || plan.settings.rate.mode === 'size') {
      const bitrate = videoBitrate ?? plan.rateBudget?.videoBitrate;
      if (!Number.isSafeInteger(bitrate) || bitrate <= 0 || bitrate > 1000000000) throw new Error('A bounded video bitrate is required.');
      args.push('-b:v', String(bitrate));
    } else args.push('-crf', String(video.crf));
    if (pass != null) args.push('-pass', String(pass), '-passlogfile', passLogPrefix);
    const cadence = plan.settings.frameRate ?? inspection.video.frameRate;
    if (cadence) args.push('-x264-params', `fps=${cadence}`);
    // Older setpts drops duration hints. Recover missing packet durations from
    // neighboring DTS while preserving the mapped PTS and source cadence.
    if (plan.cuts) args.push('-bsf:v', `setts=pts=PTS:dts=DTS:duration='if(gt(DURATION,0),DURATION,if(gt(NEXT_DTS,DTS),NEXT_DTS-DTS,if(eq(N,0),${plan.timing.durationSeconds}/TB-PTS,DTS-PREV_OUTDTS)))'`);
  } else args.push('-vn');
  if (audio?.action === 'copy') args.push('-c:a', 'copy');
  else if (audio) {
    args.push('-c:a', audio.encoder, '-ar', String(audio.sampleRate), '-ac', String(audio.channels), '-channel_layout', audio.channelLayout);
    if (audio.bitRate) args.push('-b:a', String(audio.bitRate));
    else args.push('-q:a', String(audio.quality));
  } else args.push('-an');
  if (!firstPass && ['mp4', 'mov'].includes(plan.output.container)) args.push('-movflags', '+faststart');
  // A file-size switch can truncate media, so no -fs is emitted here. The
  // process owner enforces its independent disk cap and validates actual bytes.
  args.push('-avoid_negative_ts', 'disabled', '-f', firstPass ? 'null' : plan.output.container,
    '-progress', 'pipe:1', '-nostats', firstPass ? '-' : outputPath);
  return args;
}

function validateProcessingOutput(output, plan) {
  const fail = message => { throw Object.assign(new Error(`Processed output validation failed: ${message}`), {
    workspaceFailure: { category: 'local_processing_validation', title: 'The processed result did not preserve the requested output',
      explanation: `Validation rejected the result: ${message}. The original source and previous outputs remain available.`,
      help: 'Check the installed FFmpeg build or choose different supported settings. No rejected result is offered for download.' }
  }); };
  const video = plan.streams.find(stream => stream.role === 'video');
  const audio = plan.streams.find(stream => stream.role === 'audio');
  if (output.container?.kind !== plan.output.container) fail('unexpected container');
  if (output.extraStreams?.total !== plan.streams.length || output.trackCounts?.video !== (video ? 1 : 0)
    || output.trackCounts?.audio !== (audio ? 1 : 0) || output.trackCounts?.subtitle !== 0 || output.extraStreams?.chapters !== 0) fail('unexpected stream roles or chapters');
  const tolerance = Math.max(0.06, 1 / (plan.output.frameRate || output.video?.frameRate || 25) + 0.01);
  if (!Number.isFinite(output.durationSeconds) || Math.abs(output.durationSeconds - plan.timing.durationSeconds) > tolerance) fail('duration differs from the retained presentation');
  if (video) {
    if (output.video?.codec !== plan.output.videoCodec || output.video?.pixelFormat !== plan.output.pixelFormat
      || output.video.width !== plan.output.width || output.video.height !== plan.output.height
      || (output.video.rotationDegrees || 0) !== plan.output.rotationDegrees || output.video.orientationSupported === false) fail('video geometry, orientation, or codec');
    if (plan.timing.videoStartSeconds != null && output.video.startSeconds != null
      && Math.abs(output.video.startSeconds - plan.timing.videoStartSeconds) > tolerance) fail('video start changed');
    const ratio = value => { const [n, d] = String(value || '').split(':').map(Number); return n > 0 && d > 0 ? n / d : null; };
    const aspect = ratio(plan.output.sampleAspectRatio);
    if (aspect != null && (ratio(output.video.sampleAspectRatio) == null || Math.abs(ratio(output.video.sampleAspectRatio) - aspect) > 0.001)) fail('display aspect changed');
    if (plan.timing.videoEndSeconds != null && output.video.durationSeconds != null
      && Math.abs(output.video.startSeconds + output.video.durationSeconds - plan.timing.videoEndSeconds) > tolerance) fail('video endpoint changed');
    if (plan.settings.frameRate != null && (!output.video.frameRate
      || Math.abs(output.video.frameRate - plan.settings.frameRate) > Math.max(0.01, plan.settings.frameRate * 0.01))) fail('requested frame rate changed');
  }
  if (audio) {
    if (output.audio?.codec !== plan.output.audioCodec || output.audio.sampleRate !== plan.output.sampleRate
      || output.audio.channels !== plan.output.channels) fail('audio codec, sample rate, or channels');
    if (plan.output.channelLayout && output.audio.channelLayout !== plan.output.channelLayout) fail('audio channel layout changed');
    const start = audio.action === 'encode' ? 0 : plan.timing.audioStartSeconds;
    if (start != null && output.audio.startSeconds != null && Math.abs(output.audio.startSeconds - start) > 0.06) fail('audio start changed');
    if (plan.timing.audioEndSeconds != null && output.audio.durationSeconds != null
      && Math.abs(output.audio.startSeconds + output.audio.durationSeconds - plan.timing.audioEndSeconds) > 0.06) fail('audio endpoint changed');
  }
  return output;
}

module.exports = { processingArgs, processingVideoFilter, validateProcessingOutput };
