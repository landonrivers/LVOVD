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

const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
const MEDIA_WORKSPACE_TTL_MS = 60 * 60 * 1000;
const WORKSPACE_CANCELLED_CODE = 'LVOVD_WORKSPACE_CANCELLED';

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

function workspaceCancelledError() {
  const error = new Error('Local media workspace cancelled.');
  error.code = WORKSPACE_CANCELLED_CODE;
  return error;
}

function isWorkspaceCancellation(error) {
  return error?.code === WORKSPACE_CANCELLED_CODE;
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

function roundMilliseconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function normalizeEditPlan(rawPlan, durationSeconds) {
  const duration = roundMilliseconds(durationSeconds);
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    throw workspaceRequestError('Edit plan must be an object.');
  }
  if (rawPlan.version !== 1) {
    throw workspaceRequestError('Edit plan version 1 is required.');
  }
  if (!Array.isArray(rawPlan.keepRanges) || rawPlan.keepRanges.length !== 1) {
    throw workspaceRequestError('This editor currently requires exactly one retained range.');
  }
  const range = rawPlan.keepRanges[0];
  if (!range || typeof range !== 'object' || Array.isArray(range)
    || typeof range.startSeconds !== 'number' || typeof range.endSeconds !== 'number') {
    throw workspaceRequestError('The retained range must contain numeric start and end times.');
  }
  const startSeconds = roundMilliseconds(range.startSeconds);
  const endSeconds = roundMilliseconds(range.endSeconds);
  if (![duration, startSeconds, endSeconds].every(Number.isFinite) || duration <= 0) {
    throw workspaceRequestError('The retained range and media duration must be finite numbers.');
  }
  if (startSeconds < 0 || endSeconds > duration) {
    throw workspaceRequestError('The retained range must stay within the inspected media duration.');
  }
  if (startSeconds >= endSeconds) {
    throw workspaceRequestError('The retained range end must be after its start.');
  }
  if (startSeconds === 0 && endSeconds === duration) {
    throw workspaceRequestError('Move the start or end before creating an edited file.');
  }
  return {
    version: 1,
    keepRanges: [{ startSeconds, endSeconds }]
  };
}

function editedOutputFilename(sourceDisplayName) {
  const safeName = normalizeDisplayFilename(sourceDisplayName);
  const extension = path.extname(safeName);
  const suffix = ' - edited.mp4';
  const stem = (path.basename(safeName, extension).trim() || 'Local video')
    .slice(0, Math.max(1, 255 - suffix.length));
  return `${stem}${suffix}`;
}

function parseFrameRate(value) {
  const text = String(value || '').trim();
  if (!text || text === '0/0') return null;
  const rational = text.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  const rate = rational ? Number(rational[1]) / Number(rational[2]) : Number(text);
  return Number.isFinite(rate) && rate > 0 ? roundMilliseconds(rate) : null;
}

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'm4v', 'm4a', 'f4v', 'f4a',
  '3gp4', '3gp5', '3gp6'
]);

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
  return String(format.format_long_name || format.format_name || 'Unknown container')
    .trim().slice(0, 120);
}

function normalizeInspection(raw = {}) {
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video'
    && Number.isInteger(Number(stream.index)) && Number(stream.index) >= 0
    && Number(stream.width) > 0 && Number(stream.height) > 0
    && Number(stream.disposition?.attached_pic) !== 1
    && Number(stream.disposition?.timed_thumbnails) !== 1);
  if (!video) {
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

  const formatDuration = Number(raw.format?.duration);
  const videoDuration = Number(video.duration);
  const duration = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : videoDuration;
  if (!Number.isFinite(duration) || duration <= 0) {
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

  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
  const audio = audioStreams.find((stream) => (
    Number.isInteger(Number(stream.index)) && Number(stream.index) >= 0
  )) || null;
  const subtitleTrackCount = streams.filter((stream) => stream?.codec_type === 'subtitle').length;
  const formatName = String(raw.format?.format_name || '').trim().toLowerCase();
  const formatNames = formatName.split(',').map((name) => name.trim()).filter(Boolean).slice(0, 20);
  const displayFormat = normalizedContainerLabel(raw.format || {}, formatNames);

  return {
    durationSeconds: roundMilliseconds(duration),
    format: displayFormat,
    formatNames,
    video: {
      streamIndex: Number(video.index),
      codec: String(video.codec_name || 'unknown').trim().toLowerCase().slice(0, 80),
      width: Math.floor(Number(video.width)),
      height: Math.floor(Number(video.height)),
      frameRate: parseFrameRate(video.avg_frame_rate || video.r_frame_rate)
    },
    audio: audio ? {
      streamIndex: Number(audio.index),
      codec: String(audio.codec_name || 'unknown').trim().toLowerCase().slice(0, 80)
    } : null,
    trackCounts: {
      audio: audioStreams.length,
      subtitle: subtitleTrackCount
    }
  };
}

function isDirectPlaybackCompatible(inspection) {
  const mp4Family = (inspection?.formatNames || []).some((name) => (
    ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(String(name).toLowerCase())
  ));
  return Boolean(mp4Family
    && inspection?.video?.codec === 'h264'
    && (!inspection.audio || inspection.audio.codec === 'aac'));
}

function playbackProxyArgs(inputPath, outputPath, inspection) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
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
  const range = editPlan.keepRanges[0];
  const retainedDuration = roundMilliseconds(range.endSeconds - range.startSeconds);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-ss', String(range.startSeconds),
    '-t', String(retainedDuration),
    '-map', `0:${inspection.video.streamIndex}`
  ];
  if (inspection.audio) args.push('-map', `0:${inspection.audio.streamIndex}`);
  args.push(
    '-vf', "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'",
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

function validateEditedOutputInspection(inspection, { expectAudio = false } = {}) {
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
    createEditedAsset = null
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
    this.workspaces = new Map();
    this.rootPromise = null;
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

  async createWorkspace({ displayName, claimedType = null, declaredLength = null } = {}) {
    const root = await this.workRoot();
    const tempDir = await this.fs.mkdtemp(path.join(root, 'workspace-'));
    const now = this.now();
    const workspace = {
      id: crypto.randomUUID(),
      status: 'receiving',
      phase: 'receiving',
      message: 'Copying the local file into LVOVD temporary storage…',
      percent: 0,
      bytesReceived: 0,
      bytesTotal: declaredLength,
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      source: {
        displayName: normalizeDisplayFilename(displayName),
        claimedType: normalizeClaimedContentType(claimedType),
        size: null
      },
      tempDir,
      assets: new Map(),
      sourceAssetId: null,
      playbackAssetId: null,
      inspection: null,
      playbackProxy: false,
      failure: null,
      listeners: new Set(),
      child: null,
      abortController: new AbortController(),
      cancelRequested: false,
      activeOperation: 'receiving',
      activePromise: null,
      render: {
        status: 'idle',
        percent: null,
        message: 'Move the start or end before creating an edited file.',
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
        size: workspace.source.size
      },
      inspection: workspace.inspection,
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
      render: {
        status: workspace.render.status,
        percent: Number.isFinite(workspace.render.percent) ? workspace.render.percent : null,
        message: workspace.render.message,
        failure: workspace.render.failure,
        requestedPlan: workspace.render.requestedPlan
          ? structuredClone(workspace.render.requestedPlan)
          : null
      },
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
      failure: workspace.failure
    };
  }

  emit(workspace) {
    const payload = `data: ${JSON.stringify(this.publicWorkspace(workspace))}\n\n`;
    for (const response of workspace.listeners) {
      try { response.write(payload); } catch {}
    }
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

  assertSizeAllowed(declaredLength) {
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
    if (declaredLength > this.maxBytes) throw this.tooLargeError();
  }

  tooLargeError() {
    return workspaceUserError(
      'Local media exceeds the 100 GiB workspace limit.',
      normalizedFailure(
        'local_media_too_large',
        'This local file is too large',
        'LVOVD accepts one local video up to 100 GiB.',
        'Choose a local video no larger than 100 GiB.'
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
      editPlan: rawAsset.editPlan ? structuredClone(rawAsset.editPlan) : null
    };
    workspace.assets.set(asset.id, asset);
    return asset;
  }

  async receiveLocalStream(readable, {
    displayName,
    claimedType = null,
    declaredLength = null
  } = {}) {
    this.assertSizeAllowed(declaredLength);
    let workspace;
    try {
      workspace = await this.createWorkspace({ displayName, claimedType, declaredLength });
    } catch (error) {
      throw withLocalFailure(error, { operation: 'workspace_creation' });
    }

    const partialPath = path.join(workspace.tempDir, 'source.partial');
    const sourcePath = path.join(workspace.tempDir, 'source.bin');
    let received = 0;
    const maxBytes = this.maxBytes;
    const counter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > maxBytes) return callback(this.tooLargeError());
        workspace.bytesReceived = received;
        workspace.percent = declaredLength > 0 ? Math.min(100, received / declaredLength * 100) : null;
        callback(null, chunk);
      }
    });

    try {
      await pipeline(readable, counter, this.createWriteStream(partialPath, { flags: 'wx' }));
      if (workspace.cancelRequested) throw workspaceCancelledError();
      if (!received) {
        throw workspaceUserError(
          'The selected local file is empty.',
          normalizedFailure(
            'local_media_invalid',
            'The selected file is empty',
            'LVOVD did not receive any media bytes from the selected local file.',
            'Choose a non-empty local video file.'
          ),
          400
        );
      }
      await this.fs.rename(partialPath, sourcePath);
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
        message: 'Inspecting the staged video locally…',
        percent: null,
        bytesReceived: received,
        bytesTotal: received
      });
      workspace.activePromise = this.prepareWorkspace(workspace);
      workspace.activePromise.catch(() => {});
      return workspace;
    } catch (error) {
      await this.removeWorkspaceFiles(workspace);
      this.workspaces.delete(workspace.id);
      if (readable.aborted || isWorkspaceCancellation(error)) throw workspaceCancelledError();
      if (error?.workspaceFailure) throw error;
      throw withLocalFailure(error, { operation: 'local_file_operation' });
    }
  }

  async prepareWorkspace(workspace) {
    try {
      const sourceAsset = workspace.assets.get(workspace.sourceAssetId);
      const inspection = await this.inspectAsset(workspace, sourceAsset);
      if (workspace.cancelRequested) throw workspaceCancelledError();
      workspace.inspection = inspection;

      if (isDirectPlaybackCompatible(inspection)) {
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
        const proxyData = await this.createProxyAsset(workspace, sourceAsset, inspection);
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
      workspace.activeOperation = null;
      workspace.activePromise = null;
      if (workspace.cancelRequested || isWorkspaceCancellation(error)) {
        await this.removeWorkspaceFiles(workspace);
        this.update(workspace, {
          status: 'cancelled',
          phase: 'cancelled',
          message: 'Local media preparation cancelled.',
          percent: null,
          failure: null
        });
        return;
      }

      const failure = this.failureFor(error);
      await this.removeWorkspaceFiles(workspace);
      this.update(workspace, {
        status: 'error',
        phase: 'error',
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
        if (onStdout) onStdout(chunk);
        if (!captureStdout) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes <= maxStdoutBytes) {
          stdout.push(chunk);
        } else {
          try { child.kill(); } catch {}
          finish(() => reject(withLocalFailure(
            new Error(`${tool} returned too much output.`),
            { operation, tool }
          )));
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
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-print_format', 'json',
        sourceAsset.filePath
      ], { operation: 'local_processing', tool: 'ffprobe' });
    } catch (error) {
      if (isWorkspaceCancellation(error) || error?.localFailure?.operation === 'process_start') throw error;
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
          'Choose another local video file or check the FFmpeg installation.'
        )
      );
    }
    return normalizeInspection(raw);
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
    const retainedDuration = roundMilliseconds(
      editPlan.keepRanges[0].endSeconds - editPlan.keepRanges[0].startSeconds
    );
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
    if (workspace.status !== 'ready' || !sourceAsset || !workspace.inspection) {
      throw workspaceRequestError('The local media workspace is not ready to create an edited file.', 409);
    }
    if (workspace.activeOperation) {
      throw workspaceRequestError('A local workspace operation is already running.', 409);
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
      validateEditedOutputInspection(outputInspection, { expectAudio: Boolean(workspace.inspection.audio) });

      const outputAsset = this.registerAsset(workspace, {
        role: 'edited-output',
        filePath: created.filePath,
        size: stat.size,
        mime: 'video/mp4',
        playable: false,
        filename: editedOutputFilename(workspace.source.displayName),
        inspection: outputInspection,
        editPlan
      });
      workspace.render.outputAssetId = outputAsset.id;
      if (previousOutputId && previousOutputId !== outputAsset.id) {
        const previous = workspace.assets.get(previousOutputId);
        workspace.assets.delete(previousOutputId);
        if (previous?.filePath) await this.fs.rm(previous.filePath, { force: true }).catch(() => {});
      }
      this.updateRender(workspace, {
        status: 'ready',
        percent: 100,
        message: 'Edited file ready.',
        failure: null,
        requestedPlan: structuredClone(editPlan)
      });
    } catch (error) {
      await this.fs.rm(attempt.partialPath, { force: true }).catch(() => {});
      await this.fs.rm(attempt.finalPath, { force: true }).catch(() => {});
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
    if (!workspace || !assetId || assetId !== workspace.render.outputAssetId) return null;
    const asset = workspace.assets.get(assetId) || null;
    if (!asset || asset.role !== 'edited-output' || !asset.filePath || !asset.filename) return null;
    return { workspace, asset };
  }

  resolvePlaybackAsset(workspaceId, assetId) {
    const workspace = this.get(workspaceId);
    if (!workspace || workspace.status !== 'ready') return null;
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

    const { asset } = resolved;
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
      res.once('close', () => {
        if (!settled) stream.destroy();
        finish();
      });
      stream.pipe(res);
    });
  }

  async removeWorkspaceFiles(workspace) {
    if (!workspace) return;
    if (workspace.child) {
      try { workspace.child.kill(); } catch {}
      workspace.child = null;
    }
    if (workspace.tempDir) {
      await this.fs.rm(workspace.tempDir, { recursive: true, force: true }).catch(() => {});
    }
    workspace.tempDir = null;
    workspace.assets.clear();
    workspace.sourceAssetId = null;
    workspace.playbackAssetId = null;
    workspace.render.outputAssetId = null;
  }

  closeListeners(workspace) {
    for (const response of workspace.listeners) {
      try { response.end(); } catch {}
    }
    workspace.listeners.clear();
  }

  async discard(workspaceId, { expired = false } = {}) {
    const workspace = this.get(workspaceId, { touch: false });
    if (!workspace) return false;
    if (workspace.activeOperation) {
      const operation = workspace.activeOperation;
      workspace.cancelRequested = true;
      if (!workspace.abortController.signal.aborted) workspace.abortController.abort();
      if (workspace.child) {
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
      if (workspace.activePromise) await workspace.activePromise.catch(() => {});
    }
    await this.removeWorkspaceFiles(workspace);
    this.update(workspace, {
      status: expired ? 'expired' : 'discarded',
      phase: expired ? 'expired' : 'discarded',
      message: expired ? 'Local media workspace expired.' : 'Local media workspace discarded.',
      percent: null,
      failure: null
    });
    this.closeListeners(workspace);
    this.workspaces.delete(workspace.id);
    return true;
  }

  async cleanupExpired(now = this.now()) {
    const removed = [];
    for (const workspace of this.workspaces.values()) {
      if (workspace.activeOperation || ['receiving', 'inspecting', 'proxying', 'cancelling'].includes(workspace.status)) continue;
      if (now - workspace.lastAccessAt < this.ttlMs) continue;
      await this.discard(workspace.id, { expired: true });
      removed.push(workspace.id);
    }
    return removed;
  }

  async clearAll() {
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
  normalizeDisplayFilename,
  normalizeEditPlan,
  editedOutputFilename,
  parseFrameRate,
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
