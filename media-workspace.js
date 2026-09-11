'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { classifyFailure } = require('./failure-classification');
const { localMediaInputArgs } = require('./local-media-input');
const {
  parseFrameRate,
  normalizeMediaInspection
} = require('./media-inspection');
const { getFfmpegCapabilities } = require('./ffmpeg-capabilities');
const { assessBroadCompatibilityMp4 } = require('./conversion-compatibility');
const { ConversionOperations } = require('./conversion-workspace');
const { runConversionProcess } = require('./conversion-process');
const { OutputRetirement } = require('./output-retirement');
const { ProcessingOperations } = require('./processing-workspace');
const { LocalProcessingQueue } = require('./local-processing-queue');
const {
  MAX_KEEP_RANGES,
  roundMilliseconds,
  normalizeEditPlan: normalizeCanonicalEditPlan,
  totalRetainedDuration,
  subtractKeepRanges,
  intersectKeepRanges,
  deriveInternalRemovedGaps,
  deriveRemovedRanges,
  restoreInternalGap,
  outerRetainedBounds,
  isFullDurationEditPlan
} = require('./public/edit-plan');

const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
const MEDIA_WORKSPACE_TTL_MS = 60 * 60 * 1000;
const WORKSPACE_CANCELLED_CODE = 'LVOVD_WORKSPACE_CANCELLED';
const WORKSPACE_PURPOSES = new Set(['edit', 'convert', 'local']);
const CLEANUP_RETRY_DELAYS_MS = Object.freeze([100, 500]);
const TRANSIENT_CLEANUP_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

function normalizedFailure(category, title, explanation, help) {
  return { category, title, explanation, help };
}

function withLocalFailure(error, provenance = {}) {
  const local = error instanceof Error ? error : new Error(String(error || 'Local media processing failed.'));
  local.failureScope = 'local';
  const existing = local.localFailure || {};
  const systemCode = typeof local.code === 'string' ? local.code : null;
  local.localFailure = {
    ...provenance,
    ...(systemCode ? { systemCode } : {}),
    ...existing
  };
  return local;
}

function workspaceUserError(message, failure, statusCode = 422) {
  const error = withLocalFailure(new Error(message), { operation: 'local_processing' });
  error.workspaceFailure = failure;
  error.statusCode = statusCode;
  return error;
}

function workspaceRequestError(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function unsupportedLocalInputError() {
  return workspaceUserError(
    'This local input type is not supported.',
    normalizedFailure(
      'local_media_unsupported',
      'Choose a self-contained video file',
      'Local editing does not open playlists, reference media, or containers outside its supported local-input policy.',
      'Choose a self-contained MP4, MOV, Matroska/WebM, or another supported video file. Renaming a file does not change its media type.'
    )
  );
}

function workspaceCancelledError() {
  const error = new Error('Local media workspace cancelled.');
  error.code = WORKSPACE_CANCELLED_CODE;
  return error;
}

function isWorkspaceCancellation(error) {
  return error?.code === WORKSPACE_CANCELLED_CODE;
}

function awaitWorkspaceStep(workspace, promise) {
  const signal = workspace.abortController.signal;
  if (workspace.cancelRequested || signal.aborted) return Promise.reject(workspaceCancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(workspaceCancelledError()));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function normalizeDisplayFilename(value, maxLength = 255) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim()
    .replace(/\s+/g, ' ');
  return text.slice(0, maxLength) || 'Local video';
}

function normalizeClaimedContentType(value) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return text.slice(0, 200) || null;
}

function normalizeEditPlan(rawPlan, durationSeconds) {
  try {
    return normalizeCanonicalEditPlan(rawPlan, durationSeconds, { rejectNoop: true });
  } catch (error) {
    if (error?.code === 'LVOVD_EDIT_PLAN_INVALID') {
      throw workspaceRequestError(error.message);
    }
    throw error;
  }
}

function editedOutputFilename(sourceDisplayName) {
  const safeName = normalizeDisplayFilename(sourceDisplayName);
  const extension = path.extname(safeName);
  const suffix = ' - edited.mp4';
  const stem = (path.basename(safeName, extension).trim() || 'Local video')
    .slice(0, Math.max(1, 255 - suffix.length));
  return `${stem}${suffix}`;
}

function validateEditorInspection(inspection) {
  if (!inspection?.video) {
    throw workspaceUserError(
      'The staged file does not contain a usable video stream.',
      normalizedFailure(
        'local_media_invalid',
        'Choose a video file',
        'The staged local file does not contain a usable video stream.',
        'Choose one local video file. Audio-only files cannot be opened in this editor.'
      )
    );
  }

  if (!Number.isFinite(inspection.durationSeconds) || inspection.durationSeconds <= 0) {
    throw workspaceUserError(
      'The staged video does not have a usable duration.',
      normalizedFailure(
        'local_media_invalid',
        'This video has no usable duration',
        'Local inspection could not determine a finite, non-zero video duration.',
        'Choose another local video file with a normal seekable timeline.'
      )
    );
  }

  const mediaKind = inspection.mediaKind || (inspection.video ? 'video' : inspection.audio ? 'audio' : 'unsupported');
  if (mediaKind !== 'video') {
    throw workspaceUserError(
      'The staged file is not a supported timed video.',
      normalizedFailure(
        'local_media_invalid',
        'Choose a video file',
        'The staged local file is not a supported timed video.',
        'Choose one local video file with a normal seekable timeline.'
      )
    );
  }
  return inspection;
}

function editorInspectionShape(inspection) {
  validateEditorInspection(inspection);
  const audioCount = inspection.trackCounts?.audio;
  const subtitleCount = inspection.trackCounts?.subtitle;
  return {
    durationSeconds: roundMilliseconds(inspection.durationSeconds),
    timeOriginSeconds: Number.isFinite(inspection.timeOriginSeconds) ? inspection.timeOriginSeconds : 0,
    format: inspection.format,
    formatNames: Array.isArray(inspection.formatNames) ? [...inspection.formatNames] : [],
    video: {
      streamIndex: inspection.video.streamIndex,
      codec: String(inspection.video.codec || 'unknown').trim().toLowerCase().slice(0, 80),
      width: inspection.video.width,
      height: inspection.video.height,
      frameRate: inspection.video.frameRate
    },
    audio: inspection.audio ? {
      streamIndex: inspection.audio.streamIndex,
      codec: String(inspection.audio.codec || 'unknown').trim().toLowerCase().slice(0, 80)
    } : null,
    trackCounts: {
      audio: Number.isInteger(audioCount) ? audioCount : inspection.audio ? 1 : 0,
      subtitle: Number.isInteger(subtitleCount) ? subtitleCount : 0
    }
  };
}

function normalizeInspection(raw = {}) {
  return editorInspectionShape(normalizeMediaInspection(raw));
}

function isDirectPlaybackCompatible(inspection) {
  const mp4Family = (inspection?.formatNames || []).some((name) => (
    ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(String(name).toLowerCase())
  ));
  return Boolean(mp4Family
    // A shifted MP4 can expose its empty edit before media time zero. A proxy
    // makes player.currentTime agree with FFmpeg's normalized source timeline.
    && !inspection.timeOriginSeconds
    && inspection?.video?.codec === 'h264'
    && (!inspection.audio || inspection.audio.codec === 'aac'));
}

function playbackProxyArgs(inputPath, outputPath, inspection) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-copyts', '-start_at_zero',
    ...localMediaInputArgs(inspection),
    '-i', inputPath,
    '-map', `0:${inspection.video.streamIndex}`
  ];
  if (inspection.audio) args.push('-map', `0:${inspection.audio.streamIndex}`);
  args.push(
    '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-pix_fmt', 'yuv420p'
  );
  if (inspection.audio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function editedOutputArgs(inputPath, outputPath, inspection, editPlan) {
  const ranges = editPlan.keepRanges;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-copyts', '-start_at_zero',
    ...localMediaInputArgs(inspection),
    '-i', inputPath
  ];
  // Map every video PTS directly: output = source - removed time so far.
  // A/V concat instead advances by the longest actual stream segment, which
  // accumulates frame-boundary rounding when authored cuts fall between frames.
  // Compare integer microseconds: floating t comparisons can include a frame
  // exactly at an excluded end, or turn a mapped zero into a negative tick.
  const micros = seconds => Math.round(seconds * 1_000_000);
  const selection = ranges.map(current => `gte(pts,${micros(current.startSeconds)})*lt(pts,${micros(current.endSeconds)})`).join('+');
  const removed = ranges.map((current, index) => index === 0 ? String(micros(current.startSeconds))
    : `gte(PTS,${micros(current.startSeconds)})*${micros(roundMilliseconds(current.startSeconds - ranges[index - 1].endSeconds))}`).join('+');
  const filters = [
    `[0:${inspection.video.streamIndex}]settb=AVTB,trim=end_pts=${micros(ranges.at(-1).endSeconds)},select='${selection}',setpts='PTS-(${removed})',scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'[vout]`
  ];
  if (inspection.audio) {
    // Materialize timestamp gaps BEFORE cutting, including sections with no
    // input audio frames. Padding is bounded by the last retained source end.
    const split = ranges.map((_current, index) => `[as${index}]`).join('');
    filters.push(`[0:${inspection.audio.streamIndex}]${presentationAudioFilter(ranges.at(-1).endSeconds)},asplit=${ranges.length}${split}`);
    ranges.forEach((current, index) => {
      filters.push(`[as${index}]atrim=start=${current.startSeconds}:end=${current.endSeconds},asetpts=PTS-${current.startSeconds}/TB[a${index}]`);
    });
    filters.push(`${ranges.map((_current, index) => `[a${index}]`).join('')}concat=n=${ranges.length}:v=0:a=1[acat]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (inspection.audio) args.push('-map', '[acat]');
  // Preserve mapped frame timestamps, without imposing a new cadence. Older
  // setpts clears frame durations: recover missing encoded packet durations
  // from adjacent DTS so MOV does not discard the last presentation frame.
  args.push('-fps_mode:v', 'vfr', '-enc_time_base:v', '1:1000000',
    '-bsf:v', `setts=pts=PTS:dts=DTS:duration='if(gt(DURATION,0),DURATION,if(gt(NEXT_DTS,DTS),NEXT_DTS-DTS,if(eq(N,0),${totalRetainedDuration(editPlan)}/TB-PTS,DTS-PREV_OUTDTS)))'`);
  // select/setpts may unset the filter's frame-rate hint. Restore the inspected
  // cadence only in x264's header/level calculation; VFR PTS remain authoritative.
  if (inspection.video.frameRate) args.push('-x264-params', `fps=${inspection.video.frameRate}`);
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p'
  );
  if (inspection.audio) args.push('-c:a', 'aac', '-b:a', '256k');
  else args.push('-an');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function presentationAudioFilter(endSeconds) {
  // async=1 only fills/trims to PTS; it never stretches audio. The 1 ms hard
  // threshold accommodates coarse container time bases without collapsing gaps.
  return `aresample=async=1:first_pts=0:min_hard_comp=0.001,apad=whole_dur=${endSeconds},atrim=end=${endSeconds}`;
}

function renderProgressPercent(outputSeconds, retainedDurationSeconds) {
  const output = Number(outputSeconds);
  const duration = Number(retainedDurationSeconds);
  if (!Number.isFinite(output) || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(99, output / duration * 100));
}

function createFfmpegProgressHandler(durationSeconds, onPercent) {
  const maxBufferCharacters = 64 * 1024;
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
      if (!match) continue;
      const percent = renderProgressPercent(Number(match[1]) / 1_000_000, durationSeconds);
      if (percent != null) onPercent(percent);
    }
    if (buffer.length > maxBufferCharacters) buffer = buffer.slice(-maxBufferCharacters);
  };
}

function outputCollectionError(message) {
  return withLocalFailure(new Error(message), {
    operation: 'output_collection',
    reason: 'output_inconsistent'
  });
}

function validateEditedOutputInspection(inspection, {
  expectAudio = false,
  expectedDurationSeconds = null
} = {}) {
  const mp4 = (inspection?.formatNames || []).some((name) => String(name).toLowerCase() === 'mp4');
  if (!mp4 || inspection?.video?.codec !== 'h264'
    || !Number.isFinite(inspection.durationSeconds) || inspection.durationSeconds <= 0
    || inspection.video.width % 2 !== 0 || inspection.video.height % 2 !== 0) {
    throw outputCollectionError('The edited output did not validate as a usable even-dimension H.264 MP4.');
  }
  if (expectAudio && inspection.audio?.codec !== 'aac') {
    throw outputCollectionError('The edited output did not contain the expected AAC audio stream.');
  }
  if (!expectAudio && inspection.audio) {
    throw outputCollectionError('The edited output unexpectedly contained an audio stream.');
  }
  const expectedDuration = Number(expectedDurationSeconds);
  if (Number.isFinite(expectedDuration) && expectedDuration > 0) {
    const toleranceSeconds = Math.max(0.15, Math.min(1, expectedDuration * 0.01));
    if (Math.abs(inspection.durationSeconds - expectedDuration) > toleranceSeconds) {
      throw outputCollectionError('The edited output duration does not match the retained sections.');
    }
  }
  return inspection;
}

function rangeNotSatisfiable() {
  const error = new RangeError('Requested byte range is not satisfiable.');
  error.code = 'LVOVD_RANGE_NOT_SATISFIABLE';
  return error;
}

function parseByteRange(value, size) {
  if (value == null || value === '') return null;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Media size must be a non-negative safe integer.');
  const match = String(value).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || String(value).includes(',')) throw rangeNotSatisfiable();

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) throw rangeNotSatisfiable();
  if (size === 0) throw rangeNotSatisfiable();

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw rangeNotSatisfiable();
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) throw rangeNotSatisfiable();
    if (!endText) end = size - 1;
    else {
      end = Number(endText);
      if (!Number.isSafeInteger(end) || end < start) throw rangeNotSatisfiable();
      end = Math.min(end, size - 1);
    }
  }

  return { start, end, length: end - start + 1 };
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

class MediaWorkspaceManager {
  constructor({
    tempDir = os.tmpdir(),
    maxBytes = MAX_LOCAL_MEDIA_BYTES,
    ttlMs = MEDIA_WORKSPACE_TTL_MS,
    clock = () => Date.now(),
    fsPromises = fsp,
    createReadStream = fs.createReadStream,
    createWriteStream = fs.createWriteStream,
    spawnProcess = spawn,
    inspectAsset = null,
    createProxyAsset = null,
    inspectOutputAsset = null,
    createEditedAsset = null,
    discoverCapabilities = getFfmpegCapabilities,
    assessConversion = assessBroadCompatibilityMp4,
    maxConvertedBytes = MAX_LOCAL_MEDIA_BYTES,
    conversionTerminationGraceMs = 250,
    cleanupRetryDelaysMs = CLEANUP_RETRY_DELAYS_MS,
    localProcessingLimits = {}
  } = {}) {
    this.tempDir = tempDir;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.fs = fsPromises;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;
    this.spawnProcess = spawnProcess;
    this.inspectAsset = inspectAsset || this.defaultInspectAsset.bind(this);
    this.createProxyAsset = createProxyAsset || this.defaultCreateProxyAsset.bind(this);
    this.inspectOutputAsset = inspectOutputAsset || this.defaultInspectOutputAsset.bind(this);
    this.createEditedAsset = createEditedAsset || this.defaultCreateEditedAsset.bind(this);
    this.discoverCapabilities = discoverCapabilities;
    this.assessConversion = assessConversion;
    this.maxConvertedBytes = Math.min(MAX_LOCAL_MEDIA_BYTES, maxConvertedBytes);
    this.conversionTerminationGraceMs = Math.max(10, Math.min(2000, conversionTerminationGraceMs));
    this.conversions = new ConversionOperations(this);
    this.processing = new ProcessingOperations(this);
    this.outputRetirement = new OutputRetirement(this);
    this.workspaces = new Map();
    this.discards = new Map();
    this.cleanupPending = new Map();
    this.cleanupRetryDelaysMs = [...cleanupRetryDelaysMs];
    this.rootPromise = null;
    this.localProcessing = new LocalProcessingQueue(this, localProcessingLimits);
  }

  async workRoot() {
    if (!this.rootPromise) {
      this.rootPromise = this.fs.mkdtemp(path.join(this.tempDir, 'lvovd-media-')).catch((error) => {
        this.rootPromise = null;
        throw error;
      });
    }
    return this.rootPromise;
  }

  now() {
    return Number(this.clock());
  }

  async createWorkspace({
    displayName,
    claimedType = null,
    declaredLength = null,
    origin = 'local',
    sourceName = null,
    waiting = false,
    purpose = 'edit',
    id = crypto.randomUUID()
  } = {}) {
    if (!WORKSPACE_PURPOSES.has(purpose)) {
      throw workspaceRequestError('Unsupported local workspace purpose.', 400);
    }
    if (origin === 'url' && !['edit', 'local'].includes(purpose)) {
      throw workspaceRequestError('URL media acquisition is available only for editing.', 400);
    }
    const root = await this.workRoot();
    const tempDir = await this.fs.mkdtemp(path.join(root, 'workspace-'));
    const now = this.now();
    const urlOrigin = origin === 'url';
    const workspace = {
      id,
      purpose,
      status: waiting ? 'waiting' : urlOrigin ? 'acquiring' : 'receiving',
      phase: waiting ? 'waiting' : urlOrigin ? 'acquiring' : 'receiving',
      message: waiting
        ? 'Waiting for another source request to finish…'
        : urlOrigin
          ? 'Preparing URL media acquisition…'
          : 'Copying the local file into LVOVD temporary storage…',
      percent: waiting || urlOrigin ? null : 0,
      bytesReceived: 0,
      bytesTotal: declaredLength,
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      source: {
        displayName: normalizeDisplayFilename(displayName),
        claimedType: normalizeClaimedContentType(claimedType),
        size: null,
        origin: urlOrigin ? 'url' : 'local',
        sourceName: sourceName ? String(sourceName).slice(0, 120) : null
      },
      tempDir,
      assets: new Map(),
      sourceAssetId: null,
      playbackAssetId: null,
      inspection: null,
      editor: { status: 'idle', message: null, failure: null },
      conversion: { status: 'idle', percent: null, message: null, failure: null, output: null, targetId: null,
        terminationPending: false, cleanupPaths: new Set(), cleanupDirectories: new Set(), attemptPath: null, activeInputAssetId: null },
      processingReview: null,
      queuedProcessingJobId: null,
      retiredOutputs: new Map(),
      compatibility: null,
      playbackProxy: false,
      failure: null,
      listeners: new Set(),
      readStreams: new Map(),
      cleanupRecord: null,
      child: null,
      abortController: new AbortController(),
      cancelRequested: false,
      activeOperation: urlOrigin ? 'acquiring' : 'receiving',
      activePromise: null,
      receivingPromise: null,
      render: {
        status: 'idle',
        percent: null,
        message: 'Change the retained range or remove a section before creating an edited file.',
        failure: null,
        requestedPlan: null,
        outputAssetId: null
      }
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  touch(workspace) {
    workspace.lastAccessAt = this.now();
    return workspace;
  }

  get(id, { touch = true } = {}) {
    const workspace = this.workspaces.get(id) || null;
    return workspace && touch ? this.touch(workspace) : workspace;
  }

  publicWorkspace(workspace) {
    if (!workspace) return null;
    const playback = workspace.playbackAssetId ? workspace.assets.get(workspace.playbackAssetId) : null;
    const editedOutput = workspace.render.outputAssetId
      ? workspace.assets.get(workspace.render.outputAssetId)
      : null;
    return {
      id: workspace.id,
      purpose: workspace.purpose,
      status: workspace.status,
      phase: workspace.phase,
      message: workspace.message,
      percent: Number.isFinite(workspace.percent) ? workspace.percent : null,
      bytesReceived: Number.isFinite(workspace.bytesReceived) ? workspace.bytesReceived : null,
      bytesTotal: Number.isFinite(workspace.bytesTotal) ? workspace.bytesTotal : null,
      createdAt: new Date(workspace.createdAt).toISOString(),
      updatedAt: new Date(workspace.updatedAt).toISOString(),
      lastAccessAt: new Date(workspace.lastAccessAt).toISOString(),
      source: {
        name: workspace.source.displayName,
        size: workspace.source.size,
        origin: workspace.source.origin,
        sourceName: workspace.source.sourceName
      },
      inspection: workspace.inspection,
      sourceAssetId: workspace.sourceAssetId,
      activeOperation: workspace.activeOperation,
      queuedProcessingJobId: workspace.queuedProcessingJobId,
      processingRevision: workspace.processingReview?.revision ?? null,
      editor: { ...workspace.editor, eligible: Boolean(workspace.inspection?.video && workspace.inspection.durationSeconds > 0) },
      conversion: this.conversions.publicState(workspace),
      outputCleanup: this.outputRetirement.state(workspace),
      compatibility: workspace.compatibility,
      assets: [...workspace.assets.values()].map((asset) => ({
        id: asset.id,
        role: asset.role,
        size: asset.size,
        mime: asset.mime,
        playable: asset.playable === true
      })),
      playback: playback ? {
        assetId: playback.id,
        role: playback.role,
        mime: playback.mime,
        proxy: workspace.playbackProxy,
        url: `/api/workspace/media?workspace=${encodeURIComponent(workspace.id)}&asset=${encodeURIComponent(playback.id)}`
      } : null,
      render: workspace.editor.status === 'ready' ? {
        status: workspace.render.status,
        percent: Number.isFinite(workspace.render.percent) ? workspace.render.percent : null,
        message: workspace.render.message,
        failure: workspace.render.failure,
        requestedPlan: workspace.render.requestedPlan
          ? structuredClone(workspace.render.requestedPlan)
          : null
      } : null,
      editedOutput: editedOutput ? {
        assetId: editedOutput.id,
        role: editedOutput.role,
        filename: editedOutput.filename,
        size: editedOutput.size,
        mime: editedOutput.mime,
        inspection: structuredClone(editedOutput.inspection),
        editPlan: structuredClone(editedOutput.editPlan),
        downloadUrl: `/api/workspace/output?workspace=${encodeURIComponent(workspace.id)}&asset=${encodeURIComponent(editedOutput.id)}`
      } : null,
      failure: workspace.failure,
      cleanup: workspace.cleanupRecord ? this.cleanupStatus(workspace) : null
    };
  }

  emit(workspace) {
    const payload = `data: ${JSON.stringify(this.publicWorkspace(workspace))}\n\n`;
    for (const response of workspace.listeners) {
      try { response.write(payload); } catch {}
    }
    this.localProcessing.workspaceChanged(workspace);
  }

  update(workspace, patch) {
    Object.assign(workspace, patch, { updatedAt: this.now() });
    this.emit(workspace);
  }

  updateRender(workspace, patch) {
    workspace.render = { ...workspace.render, ...patch };
    workspace.updatedAt = this.now();
    this.emit(workspace);
  }

  failureFor(error) {
    return error?.workspaceFailure || classifyFailure(withLocalFailure(error), { scope: 'local' });
  }

  assertSizeAllowed(declaredLength, purpose = 'edit') {
    if (declaredLength == null) return;
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw workspaceUserError(
        'Invalid Content-Length for local media.',
        normalizedFailure(
          'local_media_invalid',
          'The local file size is invalid',
          'LVOVD received an invalid declared size for the local file.',
          'Choose the file again and retry the local copy.'
        ),
        400
      );
    }
    if (declaredLength > this.maxBytes) throw this.tooLargeError(purpose);
  }

  tooLargeError(purpose = 'edit') {
    const noun = purpose === 'convert' ? 'local media file' : 'local video';
    return workspaceUserError(
      'Local media exceeds the 100 GiB workspace limit.',
      normalizedFailure(
        'local_media_too_large',
        'This local file is too large',
        `LVOVD accepts one ${noun} up to 100 GiB.`,
        `Choose a ${noun} no larger than 100 GiB.`
      ),
      413
    );
  }

  registerAsset(workspace, rawAsset) {
    if (!rawAsset?.filePath || !isPathInside(workspace.tempDir, rawAsset.filePath)) {
      throw new Error('Workspace assets must remain inside their authoritative workspace.');
    }
    const asset = {
      id: rawAsset.id || crypto.randomUUID(),
      role: rawAsset.role,
      filePath: rawAsset.filePath,
      size: rawAsset.size,
      mime: rawAsset.mime || 'application/octet-stream',
      playable: rawAsset.playable === true,
      filename: rawAsset.filename ? normalizeDisplayFilename(rawAsset.filename) : null,
      inspection: rawAsset.inspection ? structuredClone(rawAsset.inspection) : null,
      editPlan: rawAsset.editPlan ? structuredClone(rawAsset.editPlan) : null,
      validated: rawAsset.validated === true
    };
    workspace.assets.set(asset.id, asset);
    return asset;
  }

  async createUrlWorkspace({ displayName, sourceName = null, waiting = false, purpose = 'edit', id } = {}) {
    try {
      return await this.createWorkspace({
        displayName,
        origin: 'url',
        sourceName,
        waiting,
        purpose,
        id
      });
    } catch (error) {
      throw withLocalFailure(error, { operation: 'workspace_creation' });
    }
  }

  async adoptAcquiredFile(workspaceId, filePath, { displayName = null, maximumBytes = this.maxBytes } = {}) {
    const workspace = this.get(workspaceId, { touch: false });
    if (!workspace || workspace.cancelRequested) throw workspaceCancelledError();
    if (!filePath || !isPathInside(workspace.tempDir, filePath)) {
      throw withLocalFailure(
        new Error('Acquired media was not contained inside its authoritative workspace.'),
        { operation: 'output_collection', reason: 'output_inconsistent' }
      );
    }

    let stat;
    try {
      stat = await this.fs.stat(filePath);
    } catch (error) {
      throw withLocalFailure(error, { operation: 'output_collection' });
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw withLocalFailure(
        new Error('Source acquisition completed without a usable media file.'),
        { operation: 'output_collection', reason: 'output_inconsistent' }
      );
    }
    if (stat.size > Math.min(this.maxBytes, maximumBytes)) throw this.tooLargeError();
    if (this.workspaces.get(workspaceId) !== workspace || workspace.cancelRequested || workspace.abortController.signal.aborted) throw workspaceCancelledError();

    const sourceAsset = this.registerAsset(workspace, {
      role: 'source',
      filePath,
      size: stat.size,
      mime: 'application/octet-stream',
      playable: false
    });
    workspace.source.size = stat.size;
    if (displayName) workspace.source.displayName = normalizeDisplayFilename(displayName);
    workspace.sourceAssetId = sourceAsset.id;
    workspace.activeOperation = 'inspecting';
    this.update(workspace, {
      status: 'inspecting',
      phase: 'inspecting',
      message: 'Inspecting the acquired video locally…',
      percent: null,
      bytesReceived: stat.size,
      bytesTotal: stat.size
    });
    await this.prepareWorkspace(workspace);
    return workspace;
  }

  async failAcquisition(workspace, failure) {
    if (!workspace || !this.workspaces.has(workspace.id)) return;
    workspace.child = null;
    await this.removeWorkspaceFiles(workspace);
    workspace.activeOperation = null;
    workspace.activePromise = null;
    this.update(workspace, {
      status: 'error',
      phase: 'error',
      message: failure.title,
      percent: null,
      failure
    });
  }

  async receiveLocalStream(readable, {
    displayName,
    claimedType = null,
    declaredLength = null,
    purpose = 'edit',
    maximumReceivedBytes = this.maxBytes,
    onWorkspace = null
  } = {}) {
    if (!WORKSPACE_PURPOSES.has(purpose)) {
      throw workspaceRequestError('Unsupported local workspace purpose.', 400);
    }
    this.assertSizeAllowed(declaredLength, purpose);
    let workspace;
    try {
      workspace = await this.createWorkspace({ displayName, claimedType, declaredLength, purpose });
    } catch (error) {
      throw withLocalFailure(error, { operation: 'workspace_creation' });
    }

    const partialPath = path.join(workspace.tempDir, 'source.partial');
    const sourcePath = path.join(workspace.tempDir, 'source.bin');
    let received = 0;
    const maxBytes = Math.min(this.maxBytes, maximumReceivedBytes);
    const counter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > maxBytes) return callback(this.tooLargeError(purpose));
        workspace.bytesReceived = received;
        workspace.percent = declaredLength > 0 ? Math.min(100, received / declaredLength * 100) : null;
        callback(null, chunk);
      }
    });

    // Install ownership before the collection can expose this receiving entry.
    // This promise owns copying/rename only: it never waits for Discard cleanup,
    // which in turn must await this promise before deleting or releasing bytes.
    const receiving = Promise.resolve().then(async () => {
      let output, closed;
      try {
        output = this.createWriteStream(partialPath, { flags: 'wx' });
        closed = output.closed ? Promise.resolve() : new Promise(resolve => output.once('close', resolve));
        await pipeline(readable, counter, output, { signal: workspace.abortController.signal });
        if (workspace.cancelRequested || workspace.abortController.signal.aborted) throw workspaceCancelledError();
        await this.fs.rename(partialPath, sourcePath);
      } finally {
        // A pipeline rejection is not itself proof that an asynchronous file
        // close has finished. Keep ownership until the actual writer closes.
        if (output) { if (!output.closed) output.destroy(); await closed; }
        else { readable.destroy(); counter.destroy(); }
      }
    });
    workspace.receivingPromise = receiving;
    workspace.activePromise = receiving;
    receiving.finally(() => { workspace.receivingPromise = null; }).catch(() => {});

    try {
      if (onWorkspace) onWorkspace(workspace);
      await receiving;
      if (workspace.cancelRequested || workspace.abortController.signal.aborted || !this.workspaces.has(workspace.id)) throw workspaceCancelledError();
      if (!received) {
        throw workspaceUserError(
          'The selected local file is empty.',
          normalizedFailure(
            'local_media_invalid',
            'The selected file is empty',
            'LVOVD did not receive any media bytes from the selected local file.',
            purpose === 'convert'
              ? 'Choose one non-empty local video or audio file.'
              : 'Choose a non-empty local video file.'
          ),
          400
        );
      }
      const sourceAsset = this.registerAsset(workspace, {
        role: 'source',
        filePath: sourcePath,
        size: received,
        mime: 'application/octet-stream',
        playable: false
      });
      workspace.source.size = received;
      workspace.sourceAssetId = sourceAsset.id;
      workspace.activeOperation = 'inspecting';
      this.update(workspace, {
        status: 'inspecting',
        phase: 'inspecting',
        message: purpose === 'convert'
          ? 'Inspecting the staged media locally…'
          : 'Inspecting the staged video locally…',
        percent: null,
        bytesReceived: received,
        bytesTotal: received
      });
      workspace.activePromise = this.prepareWorkspace(workspace);
      workspace.activePromise.catch(() => {});
      return workspace;
    } catch (error) {
      const cancelled = workspace.cancelRequested || workspace.abortController.signal.aborted || readable.aborted || isWorkspaceCancellation(error);
      // Intake failures use the same invalidation/resource/cleanup owner as a
      // concurrent DELETE. Its wait covers receiving, not this caller's catch.
      await this.discard(workspace.id);
      if (cancelled) {
        throw Object.assign(workspaceCancelledError(), { cleanup: this.cleanupStatus(workspace) });
      }
      error.cleanup = this.cleanupStatus(workspace);
      if (error?.workspaceFailure) throw error;
      throw withLocalFailure(error, { operation: 'local_file_operation' });
    }
  }

  async prepareWorkspace(workspace) {
    try {
      const sourceAsset = workspace.assets.get(workspace.sourceAssetId);
      const inspection = await this.inspectAsset(workspace, sourceAsset);
      if (workspace.cancelRequested) throw workspaceCancelledError();
      // One immutable source-fact object; editor projections are derived.
      workspace.inspection = inspection;
      if (workspace.purpose === 'edit') validateEditorInspection(inspection);

      if (workspace.purpose === 'convert') {
        const capabilities = await awaitWorkspaceStep(workspace, this.discoverCapabilities());
        if (workspace.cancelRequested) throw workspaceCancelledError();
        workspace.compatibility = this.assessConversion(workspace.inspection, capabilities);
        workspace.activeOperation = null;
        workspace.activePromise = null;
        this.update(workspace, {
          status: 'ready',
          phase: 'ready',
          message: 'Local media inspection ready.',
          percent: 100,
          failure: null
        });
        return;
      }

      if (workspace.purpose === 'local') {
        workspace.activeOperation = null;
        workspace.activePromise = null;
        this.update(workspace, { status: 'ready', phase: 'ready', message: 'Local media ready. Choose Edit Video or Convert Media.', percent: 100, failure: null });
        return;
      }

      await this.performEditorPreparation(workspace, sourceAsset);
    } catch (error) {
      workspace.child = null;
      const cancelled = workspace.cancelRequested || isWorkspaceCancellation(error);
      const failure = cancelled ? null : this.failureFor(error);
      await this.removeWorkspaceFiles(workspace);
      workspace.activeOperation = null;
      workspace.activePromise = null;
      this.update(workspace, { status: cancelled ? 'cancelled' : 'error', phase: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Local media preparation cancelled.' : failure.title, percent: null, failure });
    }
  }

  originalSource(workspaceId, sourceAssetId) {
    const workspace = this.get(workspaceId);
    if (!workspace) throw workspaceRequestError('Local media workspace not found or expired.', 404);
    const asset = workspace.assets.get(sourceAssetId);
    if (!asset || asset.id !== workspace.sourceAssetId || asset.role !== 'source') throw workspaceRequestError('This operation requires the workspace’s current original source asset.', 409);
    if (workspace.status !== 'ready' || !workspace.inspection || workspace.cleanupRecord) throw workspaceRequestError('The original source is not ready.', 409);
    return { workspace, asset };
  }

  prepareEditor(workspaceId, sourceAssetId) {
    const { workspace, asset } = this.originalSource(workspaceId, sourceAssetId);
    validateEditorInspection(workspace.inspection);
    if (workspace.activeOperation) throw workspaceRequestError('A local workspace operation is already running.', 409);
    if (workspace.editor.status === 'ready' && workspace.playbackAssetId) return workspace;
    if (workspace.queuedProcessingJobId) throw workspaceRequestError('This file is queued for processing. Preview can prepare after it finishes or is cancelled.', 409);
    workspace.cancelRequested = false;
    workspace.abortController = new AbortController();
    workspace.activeOperation = 'editor';
    workspace.activePromise = this.performEditorPreparation(workspace, asset);
    workspace.activePromise.catch(() => {});
    return workspace;
  }

  async performEditorPreparation(workspace, sourceAsset) {
    workspace.editor = { status: 'preparing', message: 'Preparing editor playback…', failure: null };
    try {
      if (isDirectPlaybackCompatible(editorInspectionShape(workspace.inspection))) {
        sourceAsset.mime = 'video/mp4';
        sourceAsset.playable = true;
        workspace.playbackAssetId = sourceAsset.id;
        workspace.playbackProxy = false;
      } else {
        workspace.activeOperation = 'proxying';
        this.update(workspace, {
          status: 'proxying',
          phase: 'proxying',
          message: 'Preparing a temporary browser-compatible playback proxy…',
          percent: 0
        });
        const proxyData = await this.createProxyAsset(workspace, sourceAsset, editorInspectionShape(workspace.inspection));
        if (workspace.cancelRequested) throw workspaceCancelledError();
        const proxyAsset = this.registerAsset(workspace, {
          ...proxyData,
          role: 'playback-proxy',
          mime: 'video/mp4',
          playable: true
        });
        workspace.playbackAssetId = proxyAsset.id;
        workspace.playbackProxy = true;
      }

      workspace.activeOperation = null;
      workspace.activePromise = null;
      workspace.editor = { status: 'ready', message: 'Editor playback ready.', failure: null };
      this.update(workspace, {
        status: 'ready',
        phase: 'ready',
        message: workspace.playbackProxy
          ? 'Editor ready with a temporary local playback proxy.'
          : 'Editor ready with direct local playback.',
        percent: 100,
        failure: null
      });
    } catch (error) {
      workspace.child = null;
      if (workspace.cancelRequested || isWorkspaceCancellation(error)) {
        workspace.activeOperation = null;
        workspace.activePromise = null;
        workspace.editor = { status: 'failed', message: 'Editor preparation cancelled.', failure: null };
        this.update(workspace, {
          status: 'ready',
          phase: 'ready',
          message: 'Local media preparation cancelled.',
          percent: null,
          failure: null
        });
        return;
      }

      const failure = this.failureFor(error);
      workspace.activeOperation = null;
      workspace.activePromise = null;
      workspace.editor = { status: 'failed', message: failure.title, failure };
      this.update(workspace, {
        status: 'ready',
        phase: 'ready',
        message: failure.title,
        percent: null,
        failure
      });
    }
  }

  async runOwnedProcess(workspace, command, args, {
    operation,
    tool,
    maxStdoutBytes = 4 * 1024 * 1024,
    captureStdout = true,
    onStdout = null
  }) {
    if (workspace.activeOperation === 'converting') {
      return runConversionProcess(this, workspace, command, args, { operation, tool, maxStdoutBytes, captureStdout, onStdout });
    }
    return new Promise((resolve, reject) => {
      if (workspace.cancelRequested || workspace.abortController.signal.aborted) {
        reject(workspaceCancelledError());
        return;
      }

      let child;
      try {
        child = this.spawnProcess(command, args, { windowsHide: true, shell: false });
      } catch (error) {
        reject(withLocalFailure(error, { operation: 'process_start', tool }));
        return;
      }
      workspace.child = child;
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let outputLimitFailure = null;
      const signal = workspace.abortController.signal;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        if (workspace.child === child) workspace.child = null;
      };
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onAbort = () => {
        try { child.kill(); } catch {}
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        if (outputLimitFailure) return;
        if (onStdout) onStdout(chunk);
        if (!captureStdout) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes <= maxStdoutBytes) {
          stdout.push(chunk);
        } else {
          outputLimitFailure = withLocalFailure(
            new Error(`${tool} returned too much output.`), { operation, tool }
          );
          try { child.kill(); } catch {}
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 512 * 1024) stderr.push(chunk);
      });
      child.on('error', (error) => {
        finish(() => reject(withLocalFailure(error, { operation: 'process_start', tool })));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (workspace.cancelRequested || signal.aborted) {
          finish(() => reject(workspaceCancelledError()));
          return;
        }
        if (outputLimitFailure) {
          finish(() => reject(outputLimitFailure));
          return;
        }
        if (code === 0) {
          finish(() => resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8')
          }));
          return;
        }
        const diagnosticLines = Buffer.concat(stderr).toString('utf8').trim()
          .split(/\r?\n/).filter(Boolean).slice(-12);
        const failure = new Error(diagnosticLines.at(-1) || `${tool} exited with code ${code}.`);
        failure.diagnostic = diagnosticLines.join('\n');
        finish(() => reject(withLocalFailure(failure, { operation, tool, exitCode: code })));
      });
    });
  }

  async defaultInspectAsset(workspace, sourceAsset) {
    let result;
    try {
      result = await this.runOwnedProcess(workspace, 'ffprobe', [
        '-v', 'warning',
        ...localMediaInputArgs(),
        '-show_format',
        '-show_streams',
        '-show_chapters',
        '-print_format', 'json',
        sourceAsset.filePath
      ], { operation: 'local_processing', tool: 'ffprobe' });
    } catch (error) {
      if (isWorkspaceCancellation(error) || error?.localFailure?.operation === 'process_start') throw error;
      if (/Format not on whitelist|Skipped opening external track/i.test(error.diagnostic || '')) throw unsupportedLocalInputError();
      if (workspace.purpose === 'convert') {
        throw workspaceUserError(
          'ffprobe could not inspect the staged file as local media.',
          normalizedFailure(
            'local_media_invalid',
            'This file could not be inspected',
            'Local media inspection could not read usable media information from the staged file.',
            'Choose another local video or audio file. The original file outside LVOVD is unchanged.'
          )
        );
      }
      throw workspaceUserError(
        'ffprobe could not inspect the staged file as media.',
        normalizedFailure(
          'local_media_invalid',
          'This file is not a usable local video',
          'Local media inspection could not read a usable video from the staged file.',
          'Choose another local video file. The original file outside LVOVD is unchanged.'
        )
      );
    }

    // The MOV options already prevented dependency reads. Its explicit skipped-
    // track diagnostic also prevents publishing a misleading Ready workspace.
    if (/Skipped opening external track/i.test(result.stderr || '')) throw unsupportedLocalInputError();

    let raw;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw workspaceUserError(
        'ffprobe returned unreadable inspection data.',
        normalizedFailure(
          'local_media_invalid',
          'This file could not be inspected',
          'Local media inspection did not return usable normalized metadata.',
          workspace.purpose === 'convert'
            ? 'Choose another local video or audio file, or check the FFmpeg installation.'
            : 'Choose another local video file or check the FFmpeg installation.'
        )
      );
    }
    return normalizeMediaInspection(raw, { sourceSize: sourceAsset.size });
  }

  async defaultCreateProxyAsset(workspace, sourceAsset, inspection) {
    const partialPath = path.join(workspace.tempDir, 'playback-proxy.partial.mp4');
    const finalPath = path.join(workspace.tempDir, 'playback-proxy.mp4');
    const onStdout = createFfmpegProgressHandler(inspection.durationSeconds, (percent) => {
      this.update(workspace, { percent });
    });

    try {
      await this.runOwnedProcess(
        workspace,
        'ffmpeg',
        playbackProxyArgs(sourceAsset.filePath, partialPath, inspection),
        { operation: 'ffmpeg_processing', tool: 'ffmpeg', captureStdout: false, onStdout }
      );
      await this.fs.rename(partialPath, finalPath);
      const stat = await this.fs.stat(finalPath);
      return { filePath: finalPath, size: stat.size };
    } catch (error) {
      await this.fs.rm(partialPath, { force: true }).catch(() => {});
      await this.fs.rm(finalPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async defaultInspectOutputAsset(workspace, outputAsset) {
    try {
      return await this.defaultInspectAsset(workspace, outputAsset);
    } catch (error) {
      if (isWorkspaceCancellation(error) || error?.localFailure?.operation === 'process_start') throw error;
      throw outputCollectionError('LVOVD could not validate the generated edited output.');
    }
  }

  async defaultCreateEditedAsset(workspace, sourceAsset, inspection, editPlan, attempt) {
    const retainedDuration = totalRetainedDuration(editPlan);
    const onStdout = createFfmpegProgressHandler(retainedDuration, (percent) => {
      this.updateRender(workspace, {
        percent,
        message: `Creating edited file… ${Math.floor(percent)}%`
      });
    });

    await this.runOwnedProcess(
      workspace,
      'ffmpeg',
      editedOutputArgs(sourceAsset.filePath, attempt.partialPath, inspection, editPlan),
      { operation: 'ffmpeg_processing', tool: 'ffmpeg', captureStdout: false, onStdout }
    );
    try {
      await this.fs.rename(attempt.partialPath, attempt.finalPath);
      const stat = await this.fs.stat(attempt.finalPath);
      return { filePath: attempt.finalPath, size: stat.size };
    } catch (error) {
      throw withLocalFailure(error, { operation: 'output_collection' });
    }
  }

  startRender(workspaceId, rawEditPlan) {
    const workspace = this.get(workspaceId);
    if (!workspace) throw workspaceRequestError('Local media workspace not found or expired.', 404);
    const sourceAsset = workspace.assets.get(workspace.sourceAssetId);
    if (workspace.editor.status !== 'ready') {
      throw workspaceRequestError('Prepare Edit for this owned source before rendering.', 409);
    }
    if (workspace.status !== 'ready' || !sourceAsset || !workspace.inspection) {
      throw workspaceRequestError('The local media workspace is not ready to create an edited file.', 409);
    }
    if (workspace.activeOperation || workspace.queuedProcessingJobId) {
      throw workspaceRequestError('A local workspace operation is already running.', 409);
    }
    if (this.outputRetirement.state(workspace).blocked || workspace.conversion.cleanupPaths.size) {
      throw workspaceRequestError('Retry temporary output cleanup before creating another file.', 409);
    }

    const editPlan = normalizeEditPlan(rawEditPlan, workspace.inspection.durationSeconds);
    const attemptId = crypto.randomUUID();
    const attempt = {
      id: attemptId,
      partialPath: path.join(workspace.tempDir, `edited-${attemptId}.partial.mp4`),
      finalPath: path.join(workspace.tempDir, `edited-${attemptId}.mp4`)
    };
    workspace.abortController = new AbortController();
    workspace.cancelRequested = false;
    workspace.activeOperation = 'rendering';
    this.updateRender(workspace, {
      status: 'rendering',
      percent: 0,
      message: 'Creating edited file… 0%',
      failure: null,
      requestedPlan: structuredClone(editPlan)
    });
    workspace.activePromise = this.performRender(workspace, sourceAsset, editPlan, attempt);
    workspace.activePromise.catch(() => {});
    return workspace;
  }

  async performRender(workspace, sourceAsset, editPlan, attempt) {
    const previousOutputId = workspace.render.outputAssetId;
    try {
      const created = await this.createEditedAsset(
        workspace,
        sourceAsset,
        workspace.inspection,
        editPlan,
        attempt
      );
      if (workspace.cancelRequested) throw workspaceCancelledError();
      if (!created?.filePath || !isPathInside(workspace.tempDir, created.filePath)) {
        throw outputCollectionError('The edited output was not created inside its authoritative workspace.');
      }
      let stat;
      try {
        stat = await this.fs.stat(created.filePath);
      } catch (error) {
        throw withLocalFailure(error, { operation: 'output_collection' });
      }
      if (!stat.isFile() || stat.size <= 0) {
        throw outputCollectionError('The edited output file is missing or empty.');
      }
      const outputInspection = await this.inspectOutputAsset(workspace, {
        role: 'edited-output',
        filePath: created.filePath,
        size: stat.size
      });
      if (workspace.cancelRequested) throw workspaceCancelledError();
      validateEditedOutputInspection(outputInspection, {
        expectAudio: Boolean(workspace.inspection.audio),
        expectedDurationSeconds: totalRetainedDuration(editPlan)
      });

      const outputAsset = this.registerAsset(workspace, {
        role: 'edited-output',
        filePath: created.filePath,
        size: stat.size,
        mime: 'video/mp4',
        playable: false,
        filename: editedOutputFilename(workspace.source.displayName),
        inspection: outputInspection,
        editPlan,
        validated: true
      });
      workspace.render.outputAssetId = outputAsset.id;
      if (previousOutputId && previousOutputId !== outputAsset.id) {
        await this.outputRetirement.retire(workspace, previousOutputId);
      }
      this.updateRender(workspace, {
        status: 'ready',
        percent: 100,
        message: 'Edited file ready.',
        failure: null,
        requestedPlan: structuredClone(editPlan)
      });
    } catch (error) {
      await this.conversions.removeFile(workspace, attempt.partialPath);
      await this.conversions.removeFile(workspace, attempt.finalPath);
      if (workspace.cancelRequested || isWorkspaceCancellation(error)) {
        this.updateRender(workspace, {
          status: 'cancelled',
          percent: null,
          message: 'Edited-file creation cancelled. The editor and staged source are still available.',
          failure: null
        });
      } else {
        const failure = this.failureFor(error);
        this.updateRender(workspace, {
          status: 'error',
          percent: null,
          message: failure.title,
          failure
        });
      }
    } finally {
      workspace.child = null;
      workspace.activeOperation = null;
      workspace.activePromise = null;
      this.emit(workspace);
    }
  }

  async cancelRender(workspaceId) {
    const workspace = this.get(workspaceId);
    if (!workspace) throw workspaceRequestError('Local media workspace not found or expired.', 404);
    if (workspace.activeOperation !== 'rendering'
      || !['rendering', 'cancelling'].includes(workspace.render.status)) {
      throw workspaceRequestError('No edited-file render is currently running.', 409);
    }
    workspace.cancelRequested = true;
    this.updateRender(workspace, {
      status: 'cancelling',
      percent: null,
      message: 'Cancelling edited-file creation…'
    });
    if (!workspace.abortController.signal.aborted) workspace.abortController.abort();
    if (workspace.child) {
      try { workspace.child.kill(); } catch {}
    }
    if (workspace.activePromise) await workspace.activePromise.catch(() => {});
    return workspace;
  }

  resolveOutputAsset(workspaceId, assetId) {
    const workspace = this.get(workspaceId);
    if (!workspace
      || !assetId || assetId !== workspace.render.outputAssetId) return null;
    const asset = workspace.assets.get(assetId) || null;
    if (!asset || asset.role !== 'edited-output' || !asset.filePath || !asset.filename) return null;
    return { workspace, asset };
  }

  resolvePlaybackAsset(workspaceId, assetId) {
    const workspace = this.get(workspaceId);
    if (!workspace || workspace.editor.status !== 'ready' || workspace.status !== 'ready') return null;
    const asset = workspace.assets.get(assetId) || null;
    if (!asset || !asset.playable || asset.id !== workspace.playbackAssetId) return null;
    return { workspace, asset };
  }

  async serveMedia(req, res, workspaceId, assetId) {
    const resolved = this.resolvePlaybackAsset(workspaceId, assetId);
    if (!resolved) {
      const body = JSON.stringify({ error: 'Workspace media not found or expired.' });
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const { workspace, asset } = resolved;
    let stat;
    try {
      stat = await this.fs.stat(asset.filePath);
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      const body = JSON.stringify({ error: status === 404
        ? 'Workspace media not found or expired.'
        : 'LVOVD could not read the workspace media.' });
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    // Discard may have invalidated the workspace while stat was in flight.
    if (!this.get(workspaceId, { touch: false })) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    let range;
    try {
      range = parseByteRange(req.headers.range, stat.size);
    } catch (error) {
      if (error?.code !== 'LVOVD_RANGE_NOT_SATISFIABLE') throw error;
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': '0',
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }

    const headers = {
      'Content-Type': asset.mime,
      'Content-Length': range ? range.length : stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const stream = this.createReadStream(asset.filePath, range ? { start: range.start, end: range.end } : undefined);
      this.ownReadStream(workspace, stream, res, asset.id);
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stream.once('error', (error) => {
        if (!res.destroyed) res.destroy(error);
        finish();
      });
      stream.once('end', finish);
      stream.once('close', finish);
      res.once('close', () => {
        if (!settled) stream.destroy();
        finish();
      });
      stream.pipe(res);
    });
  }

  ownReadStream(workspace, stream, response, assetId = null) {
    workspace.readStreams.set(stream, { response, assetId });
    stream.once('close', () => {
      workspace.readStreams.delete(stream);
      if (workspace.retiredOutputs.has(assetId)) this.outputRetirement.retire(workspace, assetId).catch(() => {});
    });
  }

  async releaseReadStreams(workspace) {
    await Promise.all([...workspace.readStreams].map(([stream, { response }]) => {
      if (stream.closed) return;
      const closed = new Promise(resolve => stream.once('close', resolve));
      stream.destroy();
      if (!response.destroyed) response.destroy();
      return closed;
    }));
  }

  cleanupStatus(workspaceOrId) {
    if (workspaceOrId?.receivingPromise || (typeof workspaceOrId === 'string' && this.discards.has(workspaceOrId) && !this.cleanupPending.has(workspaceOrId))) {
      return { status: 'pending', message: 'Owned resources must close before temporary files can be removed.' };
    }
    if (typeof workspaceOrId !== 'string' && workspaceOrId?.activeOperation === 'converting' && !workspaceOrId.cleanupRecord) {
      return { status: 'pending', message: 'Conversion termination is pending. Temporary files remain owned until the process exits.' };
    }
    const record = typeof workspaceOrId === 'string'
      ? this.cleanupPending.get(workspaceOrId)
      : workspaceOrId?.cleanupRecord;
    const status = record?.status || 'complete';
    return {
      status,
      message: status === 'complete'
        ? 'Temporary workspace files were removed.'
        : status === 'pending'
          ? 'Temporary-file cleanup is pending. Some local files may remain while LVOVD retries.'
          : 'Some temporary files could not be removed. LVOVD retains their cleanup ownership for this server session.'
    };
  }

  async attemptCleanup(record) {
    if (record.promise) return record.promise;
    if (record.status === 'complete') return;
    record.status = 'pending';
    if (!this.workspaces.has(record.workspace.id)) this.localProcessing.cleanupChanged(record.workspace.id);
    record.promise = (async () => {
      await this.releaseReadStreams(record.workspace);
      record.attempts += 1;
      try {
        // Only directories created by createWorkspace enter this bookkeeping.
        // Node's implicit retries are disabled; this record owns the budget.
        await this.fs.rm(record.directory, { recursive: true, force: true, maxRetries: 0 });
        record.status = 'complete';
        record.directory = null;
        record.assets.clear();
        this.cleanupPending.delete(record.workspace.id);
      } catch (error) {
        record.systemCode = typeof error?.code === 'string' ? error.code : null;
        const delay = this.cleanupRetryDelaysMs[record.attempts - 1];
        if (TRANSIENT_CLEANUP_CODES.has(record.systemCode) && delay != null) {
          record.timer = setTimeout(() => {
            record.timer = null;
            this.attemptCleanup(record).catch(() => {});
          }, delay);
          record.timer.unref?.();
        } else {
          // In particular, do not repeatedly retry EACCES. Keep ownership even
          // after the bounded automatic budget ends; no successful cleanup claim.
          record.status = 'failed';
        }
      }
    })();
    try { await record.promise; }
    finally {
      record.promise = null;
      if (this.workspaces.has(record.workspace.id)) this.emit(record.workspace);
      else this.localProcessing.cleanupChanged(record.workspace.id);
    }
  }

  async removeWorkspaceFiles(workspace) {
    if (!workspace) return;
    await Promise.all([...workspace.retiredOutputs.values()].map(record => record.promise).filter(Boolean));
    let record = workspace.cleanupRecord;
    if (!record && workspace.tempDir) {
      record = {
        workspace,
        directory: workspace.tempDir,
        assets: workspace.assets,
        status: 'pending',
        attempts: 0,
        promise: null,
        timer: null,
        systemCode: null
      };
      this.cleanupPending.set(workspace.id, record);
      workspace.cleanupRecord = record;
      // Transfer ownership before removing active asset authority. A failed rm
      // must never restore these URLs or lose the path needed for deletion.
      workspace.tempDir = null;
      workspace.assets = new Map();
      workspace.sourceAssetId = null;
      workspace.playbackAssetId = null;
      workspace.render.outputAssetId = null;
      workspace.conversion.output = null;
      workspace.conversion.cleanupPaths.clear();
      workspace.conversion.cleanupDirectories.clear();
      workspace.processingReview = null;
      workspace.retiredOutputs.clear();
    }
    if (!record) return;
    if (record.promise) await record.promise;
    else if (record.attempts === 0) await this.attemptCleanup(record);
    return this.cleanupStatus(workspace);
  }

  // Explicit retry for an owned, exhausted record (also used by repeated
  // DELETE). Automatic cleanup never replenishes its own bounded budget.
  async retryCleanup(workspaceId) {
    const record = this.cleanupPending.get(workspaceId);
    if (!record || record.status !== 'failed') return;
    record.attempts = 0;
    await this.attemptCleanup(record);
  }

  closeListeners(workspace) {
    for (const response of workspace.listeners) {
      try { response.end(); } catch {}
    }
    workspace.listeners.clear();
  }

  discard(workspaceId, { expired = false } = {}) {
    if (this.discards.has(workspaceId)) return this.discards.get(workspaceId);
    const workspace = this.get(workspaceId, { touch: false });
    if (!workspace) return Promise.resolve(false);
    // Invalidate first, independently of process shutdown or physical deletion.
    this.workspaces.delete(workspaceId);
    this.localProcessing.workspaceRemoved(workspace);
    this.closeListeners(workspace);
    const task = this.discardOwnedWorkspace(workspace, expired);
    this.discards.set(workspaceId, task);
    task.finally(() => { this.discards.delete(workspaceId); this.localProcessing.cleanupChanged(workspaceId); }).catch(() => {});
    return task;
  }

  async discardOwnedWorkspace(workspace, expired) {
    const releasingStreams = this.releaseReadStreams(workspace);
    if (workspace.activeOperation) {
      const operation = workspace.activeOperation;
      const queuedAcquisition = operation === 'acquiring'
        && workspace.status === 'waiting'
        && !workspace.child;
      workspace.cancelRequested = true;
      if (!workspace.abortController.signal.aborted) workspace.abortController.abort();
      if (workspace.child && !workspace.stopAcquisition) {
        try { workspace.child.kill(); } catch {}
      }
      if (operation === 'rendering') {
        this.updateRender(workspace, {
          status: 'cancelling',
          percent: null,
          message: 'Cancelling edited-file creation before discarding the workspace…'
        });
      } else {
        this.update(workspace, {
          status: 'cancelling',
          phase: 'cancelling',
          message: 'Cancelling local media preparation…',
          percent: null
        });
      }
      if (workspace.activePromise && !queuedAcquisition) {
        await workspace.activePromise.catch(() => {});
      }
    }
    await releasingStreams;
    await this.removeWorkspaceFiles(workspace);
    this.update(workspace, {
      status: expired ? 'expired' : 'discarded',
      phase: expired ? 'expired' : 'discarded',
      message: expired ? 'Local media workspace expired.' : 'Local media workspace discarded.',
      percent: null,
      failure: null
    });
    return true;
  }

  async cleanupExpired(now = this.now()) {
    this.localProcessing.sweep(now);
    const removed = [];
    for (const workspace of this.workspaces.values()) {
      if (workspace.activeOperation || workspace.queuedProcessingJobId || ['waiting', 'acquiring', 'receiving', 'inspecting', 'proxying', 'cancelling'].includes(workspace.status)) continue;
      if (now - workspace.lastAccessAt < this.ttlMs) continue;
      await this.discard(workspace.id, { expired: true });
      removed.push(workspace.id);
    }
    return removed;
  }

  async clearAll() {
    this.localProcessing.clear();
    for (const id of [...this.workspaces.keys()]) await this.discard(id);
  }
}

function createMediaWorkspaceManager(options) {
  return new MediaWorkspaceManager(options);
}

module.exports = {
  MAX_LOCAL_MEDIA_BYTES,
  MEDIA_WORKSPACE_TTL_MS,
  WORKSPACE_CANCELLED_CODE,
  MAX_KEEP_RANGES,
  normalizeDisplayFilename,
  normalizeEditPlan,
  totalRetainedDuration,
  subtractKeepRanges,
  intersectKeepRanges,
  deriveInternalRemovedGaps,
  deriveRemovedRanges,
  restoreInternalGap,
  outerRetainedBounds,
  isFullDurationEditPlan,
  editedOutputFilename,
  parseFrameRate,
  normalizeMediaInspection,
  validateEditorInspection,
  normalizeInspection,
  isDirectPlaybackCompatible,
  playbackProxyArgs,
  editedOutputArgs,
  renderProgressPercent,
  validateEditedOutputInspection,
  parseByteRange,
  createMediaWorkspaceManager,
  MediaWorkspaceManager
};
