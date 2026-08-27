const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const {
  createSourceRequestCoordinator,
  courtesyDelayMs,
  wait,
  classifyDownloadError
} = require('./request-safety');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_PLAYLIST_PREVIEW = 100;
const MAX_PLAYLIST_SELECTION = 100;
const jobs = new Map();
const remoteSourceRequests = createSourceRequestCoordinator();
let processWorkRootPromise = null;

const CONTENT_MODES = new Set(['av', 'video', 'audio', 'extras']);
const PROFILES = new Set(['compatible', 'maximum']);
const AUDIO_FORMATS = new Set(['m4a', 'mp3', 'source', 'opus', 'flac', 'wav']);
const RANGE_MODES = new Set(['full', 'custom', 'chapters']);
const SUBTITLE_MODES = new Set(['manual', 'auto', 'both']);
const SPONSOR_MODES = new Set(['off', 'mark', 'remove']);
const SPONSOR_CATEGORIES = new Set([
  'sponsor', 'intro', 'outro', 'selfpromo', 'interaction', 'preview', 'filler', 'music_offtopic', 'hook'
]);

const YTDLP_PATH = process.env.YTDLP_PATH || '';
const YTDLP_COMMON_ARGS = ['--js-runtimes', 'node', '--no-colors'];

async function createProcessWorkRoot(tempDir = os.tmpdir()) {
  return fsp.mkdtemp(path.join(tempDir, 'lvovd-run-'));
}

function getProcessWorkRoot() {
  if (!processWorkRootPromise) {
    processWorkRootPromise = createProcessWorkRoot().catch((error) => {
      processWorkRootPromise = null;
      throw error;
    });
  }
  return processWorkRootPromise;
}

async function createJobWorkDir(workRoot) {
  return fsp.mkdtemp(path.join(workRoot, 'job-'));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function parseMediaUrl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Enter a video or media URL.');

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https media URLs are supported.');
  }

  return parsed.toString();
}

function safeMediaUrl(value) {
  try {
    return parseMediaUrl(value);
  } catch {
    return null;
  }
}

function run(command, args, { maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error('LVOVD-managed yt-dlp is not ready. Start LVOVD through server.js.'));
      return;
    }

    const child = spawn(command, args, { windowsHide: true, shell: false });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) return fail(new Error(`${path.basename(command)} returned too much output.`));
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        const isYtdlp = command === YTDLP_PATH;
        fail(new Error(isYtdlp
          ? 'The configured yt-dlp binary is missing. Restart LVOVD or run npm run update-ytdlp.'
          : `${command} is not installed or is not on PATH.`));
      } else {
        fail(error);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) return resolve({ stdout: out, stderr: err });
      const lastLine = err.split(/\r?\n/).filter(Boolean).slice(-1)[0];
      reject(new Error(lastLine || `${path.basename(command)} exited with code ${code}.`));
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

async function commandVersion(command, args) {
  try {
    const result = await run(command, args, { maxBytes: 256 * 1024 });
    return { installed: true, version: result.stdout.split(/\r?\n/)[0] || 'installed' };
  } catch (error) {
    return { installed: false, error: error.message };
  }
}

function bestThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  if (!Array.isArray(info.thumbnails)) return null;
  return info.thumbnails
    .filter((item) => item && item.url)
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
}

function isH264Codec(codec) {
  return typeof codec === 'string' && /^(avc1|h264)/i.test(codec);
}

function isAacCodec(codec) {
  return typeof codec === 'string' && /^(mp4a|aac)/i.test(codec);
}

function codecState(codec) {
  if (typeof codec !== 'string' || !codec.trim() || /^NA$/i.test(codec.trim())) return null;
  return codec.trim().toLowerCase() === 'none' ? false : true;
}

function hasVisualEvidence(format) {
  if (!format || typeof format !== 'object') return false;
  if (!format.url && !format.manifest_url) return false;
  return [format.height, format.width, format.fps, format.aspect_ratio]
    .some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => b - a);
}

function resolutionSummary(info) {
  const formats = Array.isArray(info.formats) && info.formats.length
    ? info.formats
    : ((info?.url || info?.vcodec || info?.acodec) ? [info] : []);
  const hasKnownAudioCodec = formats.some((format) => codecState(format?.acodec) === true);
  const hasPossibleUnknownAudio = formats.some((format) => hasVisualEvidence(format) && codecState(format?.acodec) === null);
  return {
    heights: uniqueSortedNumbers(formats.map((format) => Number(format.height))),
    h264Heights: uniqueSortedNumbers(formats.filter((format) => isH264Codec(format?.vcodec)).map((format) => Number(format.height))),
    nativeAacAvailable: formats.some((format) => isAacCodec(format?.acodec))
      ? true
      : hasKnownAudioCodec
        ? false
        : hasPossibleUnknownAudio
          ? null
          : false,
    audioCodecs: [...new Set(formats
      .filter((format) => codecState(format?.vcodec) === false && codecState(format?.acodec) === true)
      .map((format) => format.acodec))].sort(),
    maxFps: Math.max(0, ...formats.map((format) => Number(format.fps) || 0)) || null
  };
}

function subtitleSummary(info) {
  const result = new Map();
  const add = (source, auto) => {
    if (!source || typeof source !== 'object') return;
    for (const [code, tracks] of Object.entries(source)) {
      if (!code || code === 'live_chat') continue;
      const first = Array.isArray(tracks) ? tracks[0] : null;
      const existing = result.get(code) || { code, name: first?.name || code, manual: false, auto: false };
      if (auto) existing.auto = true;
      else existing.manual = true;
      if ((!existing.name || existing.name === code) && first?.name) existing.name = first.name;
      result.set(code, existing);
    }
  };
  add(info.subtitles, false);
  add(info.automatic_captions, true);
  return [...result.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function chapterSummary(info) {
  if (!Array.isArray(info.chapters)) return [];
  return info.chapters
    .map((chapter, index) => ({
      index,
      title: chapter?.title || `Chapter ${index + 1}`,
      start: Number(chapter?.start_time),
      end: Number(chapter?.end_time)
    }))
    .filter((chapter) => Number.isFinite(chapter.start) && Number.isFinite(chapter.end) && chapter.end > chapter.start);
}

function uniqueStrings(values) {
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value && value !== 'none' && value !== 'NA')
    .map((value) => value.trim())
    .filter(Boolean))].sort();
}

function sourceSummary(info, requestedUrl) {
  const extractorKey = info?.extractor_key || info?.ie_key || null;
  const extractor = info?.extractor || null;
  let hostname = null;
  for (const candidate of [info?.webpage_url, info?.original_url, requestedUrl]) {
    try {
      hostname = new URL(candidate).hostname.replace(/^www\./i, '');
      if (hostname) break;
    } catch {}
  }

  const raw = String(extractorKey || extractor || '').trim();
  const branded = {
    youtube: 'YouTube',
    instagram: 'Instagram',
    facebook: 'Facebook',
    tiktok: 'TikTok',
    vimeo: 'Vimeo',
    dailymotion: 'Dailymotion',
    twitch: 'Twitch',
    twitter: 'Twitter / X',
    x: 'X',
    reddit: 'Reddit',
    soundcloud: 'SoundCloud'
  };
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  let name = Object.entries(branded).find(([prefix]) => key.startsWith(prefix))?.[1];
  if (!name && raw && !/^generic$/i.test(raw)) {
    name = raw
      .replace(/[_:-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!name) name = hostname || 'Generic web source';

  return {
    name,
    extractor: extractor || null,
    extractorKey: extractorKey || null,
    hostname,
    generic: /^generic$/i.test(raw) || (!raw && Boolean(hostname))
  };
}

function capabilitySummary(info, requestedUrl) {
  const formats = Array.isArray(info?.formats) && info.formats.length
    ? info.formats.filter(Boolean)
    : ((info?.url || info?.vcodec || info?.acodec) ? [info] : []);
  const videoState = (format) => codecState(format?.vcodec);
  const audioState = (format) => codecState(format?.acodec);
  const isVideo = (format) => videoState(format) === true;
  const isAudio = (format) => audioState(format) === true;
  const isVideoOnly = (format) => isVideo(format) && audioState(format) === false;
  const isAudioOnly = (format) => isAudio(format) && videoState(format) === false;
  const visualFormats = formats.filter((format) => videoState(format) !== false && hasVisualEvidence(format));
  const hasVideo = formats.some(isVideo) || visualFormats.length > 0;
  const hasAudio = formats.some(isAudio);
  const hasPossibleAudio = visualFormats.some((format) => audioState(format) === null);
  const audioCapability = hasAudio ? true : hasPossibleAudio ? null : false;
  const hasVideoOnly = formats.some(isVideoOnly);
  const hasAudioOnly = formats.some(isAudioOnly);
  const hasCombined = formats.some((format) => isVideo(format) && isAudio(format));
  const hasPossibleCombined = visualFormats.some((format) =>
    (videoState(format) === null && audioState(format) !== false) ||
    (videoState(format) !== false && audioState(format) === null));
  const combinedCapability = hasCombined ? true : hasPossibleCombined ? null : false;
  const h264VideoOnlyHeights = uniqueSortedNumbers(formats.filter((format) => isVideoOnly(format) && isH264Codec(format?.vcodec)).map((format) => Number(format.height)));
  const videoOnlyHeights = uniqueSortedNumbers(formats.filter(isVideoOnly).map((format) => Number(format.height)));
  const compatibleCombined = formats.some((format) => isVideo(format) && isAudio(format) && isH264Codec(format?.vcodec) && isAacCodec(format?.acodec));
  const compatibleSeparate = formats.some((format) => isVideoOnly(format) && isH264Codec(format?.vcodec))
    && formats.some((format) => isAudioOnly(format) && isAacCodec(format?.acodec));
  const resolution = resolutionSummary(info || {});
  const chapters = chapterSummary(info || {});
  const subtitles = subtitleSummary(info || {});
  const source = sourceSummary(info || {}, requestedUrl);
  const thumbnail = Boolean(bestThumbnail(info || {}));
  const liveStatus = info?.live_status || null;
  const isLive = liveStatus === 'is_live' || Boolean(info?.is_live);
  const isYouTube = /youtube/i.test(`${source.extractorKey || ''} ${source.extractor || ''}`);
  const hasUnknownDirectMedia = visualFormats.some((format) => videoState(format) === null || audioState(format) === null);

  return {
    source,
    media: {
      video: hasVideo,
      audio: audioCapability,
      videoOnly: hasVideoOnly,
      audioOnly: hasAudioOnly,
      combined: combinedCapability,
      directMedia: hasUnknownDirectMedia,
      heights: resolution.heights,
      videoOnlyHeights,
      h264Heights: resolution.h264Heights,
      h264VideoOnlyHeights,
      nativeAac: resolution.nativeAacAvailable,
      compatibleAv: compatibleCombined || compatibleSeparate,
      compatibleVideo: h264VideoOnlyHeights.length > 0,
      maxFps: resolution.maxFps,
      videoCodecs: uniqueStrings(formats.map((format) => format?.vcodec)),
      audioCodecs: uniqueStrings(formats.map((format) => format?.acodec))
    },
    extras: {
      thumbnail,
      metadata: true,
      subtitles: subtitles.length > 0,
      chapters: chapters.length > 0,
      sponsorBlock: isYouTube
    },
    range: {
      custom: (hasVideo || hasAudio || hasPossibleAudio) && !isLive,
      chapters: chapters.length > 0 && !isLive
    },
    live: {
      status: liveStatus,
      isLive
    },
    note: hasUnknownDirectMedia
      ? 'yt-dlp reported downloadable visual media but did not identify every codec. Maximum Quality is available; codec-specific compatibility and separate-stream modes remain conservative.'
      : undefined
  };
}

function classifyPreviewError(error, requestedUrl) {
  const message = String(error?.message || error || 'Could not inspect this URL.').trim();
  let hostname = null;
  try { hostname = new URL(requestedUrl).hostname.replace(/^www\./i, ''); } catch {}
  const lower = message.toLowerCase();

  if (/drm|digital rights management/.test(lower)) {
    return {
      category: 'protected',
      title: 'Protected media is not supported',
      message,
      hint: 'LVOVD does not bypass DRM or other access-control protections.',
      hostname
    };
  }
  if (/login|log in|sign in|signin|authentication|cookies|private video|private post|account required|members-only|members only/.test(lower)) {
    return {
      category: 'authentication',
      title: 'This source appears to require sign-in',
      message,
      hint: 'The URL may be supported by yt-dlp, but LVOVD does not import browser cookies or authenticated sessions yet.',
      hostname
    };
  }
  if (/unsupported url|no suitable extractor|not a valid url|unable to extract.*url/.test(lower)) {
    return {
      category: 'unsupported',
      title: 'yt-dlp could not recognize this media URL',
      message,
      hint: 'The site may not be supported, the page may not expose downloadable media, or its extractor may need an update.',
      hostname
    };
  }
  if (/geo|not available in your country|not available in your region|geographic/.test(lower)) {
    return {
      category: 'geo_restricted',
      title: 'This media appears to be region restricted',
      message,
      hint: 'LVOVD does not attempt to bypass geographic restrictions.',
      hostname
    };
  }
  if (/not available|unavailable|removed|deleted|does not exist/.test(lower)) {
    return {
      category: 'unavailable',
      title: 'The media is unavailable',
      message,
      hint: 'The item may have been removed, made private, expired, or otherwise become inaccessible.',
      hostname
    };
  }
  if (/403|forbidden|429|too many requests|rate limit|blocked/.test(lower)) {
    return {
      category: 'access_blocked',
      title: 'The source rejected the request',
      message,
      hint: 'The service may be rate-limiting or blocking automated access. Trying again later or updating yt-dlp may help.',
      hostname
    };
  }
  return {
    category: 'extractor_error',
    title: 'yt-dlp could not preview this URL',
    message,
    hint: 'The service may have changed, the URL may need authentication, or the current yt-dlp extractor may be temporarily broken.',
    hostname
  };
}

function normalizePlaylistEntry(entry, index) {
  const id = typeof entry?.id === 'string' ? entry.id : null;
  const extractor = String(entry?.ie_key || entry?.extractor_key || entry?.extractor || '').toLowerCase();
  const candidates = [entry?.webpage_url, entry?.original_url, entry?.url];
  let entryUrl = candidates.map(safeMediaUrl).find(Boolean) || null;
  // Flat YouTube playlists commonly expose only the video id; keep this extractor-specific fallback.
  if (!entryUrl && id && extractor.includes('youtube')) {
    entryUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }
  return {
    index,
    id,
    title: entry?.title || `Video ${index + 1}`,
    channel: entry?.channel || entry?.uploader || null,
    duration: Number.isFinite(Number(entry?.duration)) ? Number(entry.duration) : null,
    durationString: entry?.duration_string || null,
    thumbnail: bestThumbnail(entry),
    url: entryUrl
  };
}

async function fetchRawInfo(videoUrl, { playlist = true } = {}) {
  const args = [
    ...YTDLP_COMMON_ARGS,
    '--dump-single-json',
    '--skip-download',
    '--no-warnings'
  ];

  if (playlist) {
    args.push('--flat-playlist', '--playlist-end', String(MAX_PLAYLIST_PREVIEW));
  } else {
    args.push('--no-playlist');
  }
  args.push(videoUrl);

  const { stdout } = await run(YTDLP_PATH, args, { maxBytes: MAX_JSON_BYTES });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp returned metadata that could not be parsed.');
  }
}

async function fetchInfo(videoUrl) {
  const info = await fetchRawInfo(videoUrl, { playlist: true });
  const isPlaylist = info?._type === 'playlist' || Array.isArray(info?.entries);

  if (isPlaylist) {
    const entries = (Array.isArray(info.entries) ? info.entries : [])
      .filter(Boolean)
      .slice(0, MAX_PLAYLIST_PREVIEW)
      .map(normalizePlaylistEntry)
      .filter((entry) => entry.id || entry.url);
    const total = Number(info.playlist_count || info.n_entries || info.entry_count || entries.length) || entries.length;
    const source = sourceSummary(info, videoUrl);
    const isYouTube = /youtube/i.test(`${source.extractorKey || ''} ${source.extractor || ''}`);
    return {
      kind: 'playlist',
      id: info.id || null,
      title: info.title || 'Media playlist',
      channel: info.channel || info.uploader || null,
      thumbnail: bestThumbnail(info) || entries.find((entry) => entry.thumbnail)?.thumbnail || null,
      entryCount: total,
      limited: total > entries.length,
      entries,
      source,
      capabilities: {
        source,
        media: {
          known: false,
          video: true,
          audio: true,
          videoOnly: true,
          audioOnly: true,
          combined: true,
          heights: [],
          videoOnlyHeights: [],
          h264Heights: [],
          h264VideoOnlyHeights: [],
          nativeAac: null,
          compatibleAv: null,
          compatibleVideo: null,
          maxFps: null,
          videoCodecs: [],
          audioCodecs: []
        },
        extras: {
          thumbnail: Boolean(bestThumbnail(info) || entries.find((entry) => entry.thumbnail)?.thumbnail),
          metadata: true,
          subtitles: null,
          chapters: false,
          sponsorBlock: isYouTube
        },
        range: { custom: false, chapters: false },
        live: { status: null, isLive: false },
        note: 'Playlist item capabilities vary. LVOVD will apply the selected settings to each chosen item.'
      }
    };
  }

  const resolution = resolutionSummary(info);
  const capabilities = capabilitySummary(info, videoUrl);
  return {
    kind: 'media',
    id: info.id || null,
    title: info.title || 'Untitled media',
    channel: info.channel || info.uploader || info.creator || null,
    duration: Number.isFinite(Number(info.duration)) ? Number(info.duration) : null,
    durationString: info.duration_string || null,
    thumbnail: bestThumbnail(info),
    heights: resolution.heights,
    h264Heights: resolution.h264Heights,
    nativeAacAvailable: resolution.nativeAacAvailable,
    audioCodecs: resolution.audioCodecs,
    maxFps: resolution.maxFps,
    chapters: chapterSummary(info),
    subtitles: subtitleSummary(info),
    webpageUrl: info.webpage_url || videoUrl,
    liveStatus: info.live_status || null,
    source: capabilities.source,
    capabilities
  };
}

function parseTimecode(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const nums = parts.map(Number);
  if (parts.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function secondsToTimecode(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(value);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

function normalizeOptions(raw = {}) {
  const content = CONTENT_MODES.has(raw.content) ? raw.content : 'av';
  const profile = PROFILES.has(raw.profile) ? raw.profile : 'compatible';
  const audioFormat = AUDIO_FORMATS.has(raw.audioFormat) ? raw.audioFormat : 'm4a';
  const maxHeight = raw.maxHeight == null || raw.maxHeight === '' ? null : Number(raw.maxHeight);
  if (maxHeight != null && (!Number.isInteger(maxHeight) || maxHeight < 144 || maxHeight > 8640)) {
    throw new Error('Resolution must be a valid video height.');
  }

  const rangeType = RANGE_MODES.has(raw?.range?.type) ? raw.range.type : 'full';
  const range = { type: rangeType };
  if (rangeType === 'custom') {
    range.start = parseTimecode(raw.range.start);
    range.end = parseTimecode(raw.range.end);
    if (range.start == null || range.end == null || range.end <= range.start) {
      throw new Error('Enter a valid custom time range with an end time after the start time.');
    }
  }
  if (rangeType === 'chapters') {
    range.chapterIndexes = [...new Set((Array.isArray(raw.range.chapterIndexes) ? raw.range.chapterIndexes : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 0))];
    if (!range.chapterIndexes.length) throw new Error('Choose at least one chapter.');
  }

  const extras = {
    thumbnail: Boolean(raw?.extras?.thumbnail),
    metadata: Boolean(raw?.extras?.metadata),
    subtitles: Boolean(raw?.extras?.subtitles),
    subtitleMode: SUBTITLE_MODES.has(raw?.extras?.subtitleMode) ? raw.extras.subtitleMode : 'both',
    subtitleLanguage: typeof raw?.extras?.subtitleLanguage === 'string' && raw.extras.subtitleLanguage.trim()
      ? raw.extras.subtitleLanguage.trim().slice(0, 80)
      : 'en'
  };

  if (content === 'extras' && !extras.thumbnail && !extras.metadata && !extras.subtitles) {
    throw new Error('Choose at least one extra when using Extras Only.');
  }

  const sponsorMode = SPONSOR_MODES.has(raw?.sponsor?.mode) ? raw.sponsor.mode : 'off';
  const sponsorCategories = [...new Set((Array.isArray(raw?.sponsor?.categories) ? raw.sponsor.categories : [])
    .filter((category) => SPONSOR_CATEGORIES.has(category)))];
  const sponsor = {
    mode: sponsorMode,
    categories: sponsorCategories.length ? sponsorCategories : ['sponsor']
  };

  return { content, profile, audioFormat, maxHeight, range, extras, sponsor };
}

function normalizeSelection(raw = {}) {
  const urls = [...new Set((Array.isArray(raw.entryUrls) ? raw.entryUrls : []).map(safeMediaUrl).filter(Boolean))];
  if (urls.length > MAX_PLAYLIST_SELECTION) throw new Error(`Choose no more than ${MAX_PLAYLIST_SELECTION} playlist videos at a time.`);
  return { entryUrls: urls };
}

function withHeightFilter(base, maxHeight) {
  return `${base}${maxHeight ? `[height<=?${maxHeight}]` : ''}`;
}

function formatSelector(options) {
  const h = options.maxHeight;
  if (options.content === 'audio') return 'bestaudio';
  if (options.content === 'extras') return null;

  if (options.content === 'video') {
    if (options.profile === 'compatible') {
      return `${withHeightFilter('bestvideo[vcodec^=avc1]', h)}/${withHeightFilter('bestvideo[vcodec^=h264]', h)}`;
    }
    return withHeightFilter('bestvideo', h);
  }

  if (options.profile === 'compatible') {
    const videoAvc = withHeightFilter('bestvideo[vcodec^=avc1]', h);
    const videoH264 = withHeightFilter('bestvideo[vcodec^=h264]', h);
    const bestAvc = withHeightFilter('best[vcodec^=avc1][acodec^=mp4a]', h);
    const bestH264 = withHeightFilter('best[vcodec^=h264][acodec^=aac]', h);
    return `${videoAvc}+bestaudio[acodec^=mp4a]/${videoH264}+bestaudio[acodec^=aac]/${bestAvc}/${bestH264}`;
  }

  return `${withHeightFilter('bestvideo', h)}+bestaudio/${withHeightFilter('best', h)}`;
}

function buildYtdlpArgs(task, options, outputTemplate, progressTemplate) {
  const args = [
    ...YTDLP_COMMON_ARGS,
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--output', outputTemplate,
    '--progress-template', progressTemplate
  ];

  if (options.content === 'extras') {
    args.push('--skip-download');
  } else {
    args.push('--progress', '--no-simulate');
    const selector = formatSelector(options);
    if (selector) args.push('--format', selector);

    if (options.content === 'av') {
      args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4');
    } else if (options.content === 'video') {
      args.push('--remux-video', 'mp4');
    }
  }

  if (task.section) {
    args.push('--download-sections', `*${secondsToTimecode(task.section.start)}-${secondsToTimecode(task.section.end)}`);
  }

  if (options.extras.thumbnail) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (options.extras.metadata) args.push('--write-info-json');
  if (options.extras.subtitles) {
    if (options.extras.subtitleMode === 'manual' || options.extras.subtitleMode === 'both') args.push('--write-subs');
    if (options.extras.subtitleMode === 'auto' || options.extras.subtitleMode === 'both') args.push('--write-auto-subs');
    args.push('--sub-langs', options.extras.subtitleLanguage, '--sub-format', 'srt/best', '--convert-subs', 'srt');
  }

  if (options.content !== 'extras' && options.sponsor.mode !== 'off') {
    const categories = options.sponsor.categories.join(',');
    if (options.sponsor.mode === 'mark') args.push('--sponsorblock-mark', categories);
    if (options.sponsor.mode === 'remove') args.push('--sponsorblock-remove', categories);
  }

  args.push(task.url);
  return args;
}

async function resolveTasks(videoUrl, options, selection) {
  let tasks;
  if (selection.entryUrls.length) {
    if (options.range.type !== 'full') throw new Error('Custom ranges and chapter selection are available for single videos, not playlist batches.');
    tasks = selection.entryUrls.map((url, index) => ({
      url,
      label: `Playlist item ${index + 1}`
    }));
  } else {
    tasks = [{ url: videoUrl, label: 'Video' }];
  }

  if (options.range.type === 'custom') {
    tasks[0].section = { start: options.range.start, end: options.range.end };
    tasks[0].label = `${secondsToTimecode(options.range.start)}–${secondsToTimecode(options.range.end)}`;
  }

  if (options.range.type === 'chapters') {
    const info = await fetchRawInfo(videoUrl, { playlist: false });
    const chapters = chapterSummary(info);
    tasks = options.range.chapterIndexes.map((chapterIndex) => {
      const chapter = chapters.find((item) => item.index === chapterIndex);
      if (!chapter) throw new Error(`Chapter ${chapterIndex + 1} is no longer available.`);
      return {
        url: videoUrl,
        label: `Chapter ${chapter.index + 1}: ${chapter.title}`,
        section: { start: chapter.start, end: chapter.end }
      };
    });
  }

  return tasks;
}

function asciiFallbackFilename(filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\/<>|:*?]/g, '_')
    .trim()
    .slice(0, 140) || 'download';
  return `${stem}${ext.replace(/[^.A-Za-z0-9]/g, '')}`;
}

function contentDisposition(filename) {
  const fallback = asciiFallbackFilename(filename).replace(/"/g, '');
  const encoded = encodeURIComponent(filename)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseMaybeNumber(value) {
  if (!value || value === 'NA' || value === 'None') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeLineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
      }
    },
    flush() {
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      if (line) onLine(line);
    }
  };
}

function progressLabel(vcodec, acodec, formatId) {
  const hasVideo = vcodec && vcodec !== 'none' && vcodec !== 'NA';
  const hasAudio = acodec && acodec !== 'none' && acodec !== 'NA';
  if (hasVideo && !hasAudio) return formatId ? `Video stream (${formatId})` : 'Video stream';
  if (!hasVideo && hasAudio) return formatId ? `Audio stream (${formatId})` : 'Audio stream';
  return formatId ? `Media stream (${formatId})` : 'Media stream';
}

async function walkFiles(root) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) results.push(full);
    }
  }
  await walk(root);
  return results;
}

function classifyOutput(filePath) {
  const lower = filePath.toLowerCase();
  if (/\.info\.json$/.test(lower)) return { kind: 'metadata', label: 'Metadata JSON' };
  const ext = path.extname(lower);
  if (['.srt', '.vtt', '.ass', '.lrc', '.ttml'].includes(ext)) return { kind: 'subtitle', label: 'Subtitles' };
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return { kind: 'thumbnail', label: 'Thumbnail' };
  if (['.mp4', '.mkv', '.webm', '.mov', '.m4a', '.mp3', '.opus', '.ogg', '.wav', '.flac', '.aac'].includes(ext)) {
    return { kind: 'media', label: 'Media' };
  }
  return null;
}

function audioConversionArgs(inputPath, outputPath, format) {
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-map', '0:a:0', '-vn'];
  if (format === 'm4a') return [...base, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', outputPath];
  if (format === 'mp3') return [...base, '-c:a', 'libmp3lame', '-q:a', '0', outputPath];
  if (format === 'opus') return [...base, '-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', outputPath];
  if (format === 'flac') return [...base, '-c:a', 'flac', outputPath];
  if (format === 'wav') return [...base, '-c:a', 'pcm_s16le', outputPath];
  throw new Error(`Unsupported audio conversion format: ${format}`);
}

async function findDownloadedMediaFile(taskDir) {
  const files = await walkFiles(taskDir);
  const mediaFiles = files.filter((filePath) => {
    const name = path.basename(filePath);
    if (/\.(part|ytdl|temp)$/i.test(name)) return false;
    return classifyOutput(filePath)?.kind === 'media';
  });
  if (mediaFiles.length === 1) return mediaFiles[0];
  if (!mediaFiles.length) throw new Error('yt-dlp completed but did not produce a source audio file.');
  throw new Error('yt-dlp produced multiple media files, so LVOVD could not safely choose which one to convert.');
}

async function convertDownloadedAudio(job, taskDir, format) {
  const sourcePath = await findDownloadedMediaFile(taskDir);
  const sourceExt = path.extname(sourcePath);
  const stem = path.basename(sourcePath, sourceExt);
  const finalPath = path.join(path.dirname(sourcePath), `${stem}.${format}`);
  const tempPath = path.join(path.dirname(sourcePath), `${stem}.lvovd-converting.${format}`);
  const formatNames = {
    m4a: 'M4A / AAC',
    mp3: 'MP3',
    opus: 'Opus',
    flac: 'FLAC',
    wav: 'WAV'
  };

  updateJob(job, {
    status: 'running',
    phase: 'processing',
    message: `Converting source audio to ${formatNames[format] || format} with FFmpeg…`,
    streamLabel: null,
    percent: null,
    speed: null,
    eta: null
  });

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', audioConversionArgs(sourcePath, tempPath, format), {
      windowsHide: true,
      shell: false
    });
    job.child = child;
    const stderr = [];
    let stderrBytes = 0;

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 512 * 1024) stderr.push(chunk);
    });

    child.on('error', (error) => {
      job.child = null;
      reject(error.code === 'ENOENT'
        ? new Error('FFmpeg is not installed or is not on PATH.')
        : error);
    });

    child.on('close', (code) => {
      job.child = null;
      if (code === 0) return resolve();
      const detail = Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
      reject(new Error(detail || `FFmpeg audio conversion exited with code ${code}.`));
    });
  });

  await fsp.rm(sourcePath, { force: true });
  if (finalPath !== sourcePath) await fsp.rm(finalPath, { force: true });
  await fsp.rename(tempPath, finalPath);
  return finalPath;
}

function outputMime(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.opus')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.srt')) return 'application/x-subrip; charset=utf-8';
  if (lower.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (/\.jpe?g$/.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function collectTaskOutputs(taskDir, taskLabel) {
  const files = await walkFiles(taskDir);
  const outputs = [];
  for (const filePath of files) {
    const name = path.basename(filePath);
    if (/\.(part|ytdl|temp)$/i.test(name)) continue;
    const classification = classifyOutput(filePath);
    if (!classification) continue;
    const stat = await fsp.stat(filePath);
    outputs.push({
      id: crypto.randomUUID(),
      filePath,
      filename: name,
      size: stat.size,
      kind: classification.kind,
      label: taskLabel ? `${taskLabel} · ${classification.label}` : classification.label
    });
  }
  return outputs;
}

function publicOutput(job, output) {
  return {
    id: output.id,
    filename: output.filename,
    size: output.size,
    kind: output.kind,
    label: output.label,
    downloadUrl: `/api/download/file?id=${encodeURIComponent(job.id)}&file=${encodeURIComponent(output.id)}`
  };
}

function publicJob(job) {
  const outputs = job.outputs.map((output) => publicOutput(job, output));
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    message: job.message,
    streamLabel: job.streamLabel || null,
    percent: job.percent,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    itemIndex: job.itemIndex,
    itemCount: job.itemCount,
    itemLabel: job.itemLabel || null,
    outputs,
    autoDownloadUrl: job.autoDownloadUrl || null,
    error: job.error || null,
    errorCategory: job.errorCategory || null
  };
}

function emitJob(job) {
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const response of job.listeners) {
    try { response.write(payload); } catch {}
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  emitJob(job);
}

function processingMessage(line) {
  if (/SponsorBlock/i.test(line)) return 'Checking SponsorBlock segments…';
  if (/ModifyChapters/i.test(line)) return 'Applying chapter / SponsorBlock edits…';
  if (/ExtractAudio/i.test(line)) return 'Converting / extracting audio with FFmpeg…';
  if (/SubtitleConvertor|EmbedSubtitle/i.test(line)) return 'Preparing subtitles…';
  if (/ThumbnailsConvertor/i.test(line)) return 'Preparing thumbnail…';
  if (/VideoRemuxer/i.test(line)) return 'Remuxing to MP4…';
  if (/Merger/i.test(line)) return 'Merging video and audio with FFmpeg…';
  if (/Metadata|EmbedThumbnail/i.test(line)) return 'Writing metadata…';
  return 'Processing with FFmpeg / yt-dlp…';
}

async function runTask(job, task, taskIndex, options) {
  const taskDir = path.join(job.tempDir, `item-${String(taskIndex + 1).padStart(3, '0')}`);
  await fsp.mkdir(taskDir, { recursive: true });
  const outputTemplate = path.join(taskDir, '%(title).180B [%(id)s].%(ext)s');
  const progressTemplate = 'download:__YTDLP_PROGRESS__%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(info.vcodec)s|%(info.acodec)s|%(progress._percent_str)s';
  const args = buildYtdlpArgs(task, options, outputTemplate, progressTemplate);

  updateJob(job, {
    status: 'running',
    phase: options.content === 'extras' ? 'processing' : 'starting',
    message: options.content === 'extras' ? 'Fetching selected extras…' : 'Starting download…',
    itemIndex: taskIndex + 1,
    itemCount: job.itemCount,
    itemLabel: task.label,
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: null,
    streamLabel: null
  });

  await new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { windowsHide: true, shell: false });
    job.child = child;
    let lastErrorLine = '';
    const recentErrorLines = [];

    const handleStdout = (line) => {
      if (!line.startsWith('__YTDLP_PROGRESS__')) return;
      const values = line.slice('__YTDLP_PROGRESS__'.length).split('|');
      const downloadedBytes = parseMaybeNumber(values[0]);
      const totalBytes = parseMaybeNumber(values[1]) ?? parseMaybeNumber(values[2]);
      const speed = parseMaybeNumber(values[3]);
      const eta = parseMaybeNumber(values[4]);
      const formatId = values[5] || null;
      const vcodec = values[6] || null;
      const acodec = values[7] || null;
      const percentFromTemplate = Number.parseFloat((values[8] || '').replace('%', '').trim());
      const percent = Number.isFinite(percentFromTemplate)
        ? Math.max(0, Math.min(100, percentFromTemplate))
        : (downloadedBytes != null && totalBytes ? Math.max(0, Math.min(100, downloadedBytes / totalBytes * 100)) : null);

      updateJob(job, {
        status: 'running',
        phase: 'downloading',
        message: 'Downloading from source…',
        streamLabel: progressLabel(vcodec, acodec, formatId),
        percent,
        downloadedBytes,
        totalBytes,
        speed,
        eta
      });
    };

    const handleStderr = (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        lastErrorLine = trimmed;
        recentErrorLines.push(trimmed);
        if (recentErrorLines.length > 8) recentErrorLines.shift();
      }
      if (/\[(Merger|VideoRemuxer|VideoConvertor|ExtractAudio|Metadata|EmbedThumbnail|EmbedSubtitle|SubtitleConvertor|ThumbnailsConvertor|SponsorBlock|ModifyChapters|Fixup[^\]]*|MoveFiles)\]/i.test(line)) {
        updateJob(job, {
          status: 'running',
          phase: 'processing',
          message: processingMessage(line),
          streamLabel: null,
          percent: null,
          speed: null,
          eta: null
        });
      }
    };

    const stdoutReader = makeLineReader(handleStdout);
    const stderrReader = makeLineReader(handleStderr);
    child.stdout.on('data', (chunk) => stdoutReader.push(chunk));
    child.stderr.on('data', (chunk) => stderrReader.push(chunk));

    child.on('error', (error) => {
      reject(error.code === 'ENOENT'
        ? new Error('The configured yt-dlp binary is missing. Restart LVOVD or run npm run update-ytdlp.')
        : error);
    });

    child.on('close', (code) => {
      stdoutReader.flush();
      stderrReader.flush();
      job.child = null;
      if (code === 0) return resolve();
      const compatibilityFailure = options.profile === 'compatible' && /requested format|format.*not available/i.test(lastErrorLine);
      const failure = new Error(compatibilityFailure
        ? 'A requested native H.264/AAC format was not available. Try Maximum Quality or a lower resolution.'
        : (lastErrorLine || `yt-dlp exited with code ${code}.`));
      failure.diagnostic = recentErrorLines.join('\n');
      reject(failure);
    });
  });

  if (options.content === 'audio' && options.audioFormat !== 'source') {
    await convertDownloadedAudio(job, taskDir, options.audioFormat);
  }

  const outputs = await collectTaskOutputs(taskDir, task.label);
  if (!outputs.length) throw new Error('yt-dlp completed but did not produce a downloadable file.');
  job.outputs.push(...outputs);
}

async function prepareDownloadJob(job, videoUrl, options, selection) {
  if (!YTDLP_PATH) throw new Error('LVOVD-managed yt-dlp is not ready. Start LVOVD through server.js.');
  const workRoot = await getProcessWorkRoot();
  job.tempDir = await createJobWorkDir(workRoot);

  const tasks = await resolveTasks(videoUrl, options, selection);
  job.itemCount = tasks.length;

  for (let i = 0; i < tasks.length; i += 1) {
    if (i > 0) {
      const delayMs = courtesyDelayMs();
      updateJob(job, {
        status: 'running',
        phase: 'waiting',
        message: `Giving the source a short break before item ${i + 1} of ${tasks.length}…`,
        streamLabel: null,
        percent: null,
        speed: null,
        eta: Math.ceil(delayMs / 1000)
      });
      await wait(delayMs);
    }
    await runTask(job, tasks[i], i, options);
  }

  const mediaOutputs = job.outputs.filter((output) => output.kind === 'media');
  job.autoDownloadUrl = job.outputs.length === 1 && mediaOutputs.length === 1
    ? `/api/download/file?id=${encodeURIComponent(job.id)}&file=${encodeURIComponent(mediaOutputs[0].id)}`
    : null;

  updateJob(job, {
    status: 'ready',
    phase: 'ready',
    message: job.outputs.length === 1 ? 'Your file is ready.' : `${job.outputs.length} files are ready.`,
    percent: 100,
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: 0,
    streamLabel: null
  });
}

async function startDownload(videoUrl, rawOptions, rawSelection) {
  const options = normalizeOptions(rawOptions);
  const selection = normalizeSelection(rawSelection);
  const id = crypto.randomUUID();
  const waitingBehindSourceWork = remoteSourceRequests.size > 0;
  const job = {
    id,
    status: 'queued',
    phase: 'queued',
    message: waitingBehindSourceWork ? 'Waiting for another source request to finish…' : 'Queued…',
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: null,
    itemIndex: 0,
    itemCount: 1,
    itemLabel: null,
    outputs: [],
    autoDownloadUrl: null,
    error: null,
    errorCategory: null,
    listeners: new Set(),
    tempDir: null,
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  jobs.set(id, job);

  remoteSourceRequests.download(async () => {
    if (jobs.get(job.id) !== job) return;
    try {
      await prepareDownloadJob(job, videoUrl, options, selection);
    } catch (error) {
      if (job.tempDir) await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
      job.tempDir = null;
      const classified = classifyDownloadError(error);
      updateJob(job, {
        status: 'error',
        phase: 'error',
        message: classified.category === 'rate_limited'
          ? 'The source is limiting requests.'
          : classified.category === 'access_rejected'
            ? 'The source rejected the download request.'
            : classified.category === 'extra_rejected'
              ? 'The selected extra could not be downloaded.'
              : 'Download failed.',
        error: classified.userMessage,
        errorCategory: classified.category,
        percent: null,
        speed: null,
        eta: null
      });
    }
  }).catch(() => {});

  return job;
}

function serveStatic(reqPath, res) {
  const routes = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8']
  };
  const route = routes[reqPath];
  if (!route) return false;
  const [file, type] = route;
  fs.readFile(path.join(PUBLIC_DIR, file), (error, data) => {
    if (error) return text(res, 500, 'Could not load the site.');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
  return true;
}

async function cleanupJob(job) {
  if (job.child) {
    try { job.child.kill(); } catch {}
    job.child = null;
  }
  if (job.tempDir) await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
  job.tempDir = null;
  job.outputs = [];
}

async function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running' || job.status === 'queued') continue;
    if (now - job.updatedAt < JOB_TTL_MS) continue;
    await cleanupJob(job);
    jobs.delete(id);
  }
}

setInterval(() => cleanupExpiredJobs().catch(() => {}), 10 * 60 * 1000).unref();

function streamPreparedFile(res, output) {
  return new Promise((resolve) => {
    let settled = false;
    const stream = fs.createReadStream(output.filePath);

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    stream.once('error', (error) => {
      if (settled) return;
      finish();
      if (res.headersSent || res.destroyed) {
        res.destroy(error);
        return;
      }
      if (error.code === 'ENOENT') return json(res, 404, { error: 'That prepared file has expired.' });
      return json(res, 500, { error: 'Could not read that prepared file.' });
    });

    stream.once('open', (descriptor) => {
      fs.fstat(descriptor, (error, stat) => {
        if (error || settled) {
          if (!settled) stream.destroy(error);
          return;
        }

        res.writeHead(200, {
          'Content-Type': outputMime(output.filename),
          'Content-Length': stat.size,
          'Content-Disposition': contentDisposition(output.filename),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });

        res.once('close', () => {
          if (!settled) stream.destroy();
        });
        stream.once('end', finish);
        stream.pipe(res);
      });
    });
  });
}

async function handleRequest(req, res) {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    return json(res, 400, { error: 'Invalid request URL.' });
  }

  if (req.method === 'GET' && serveStatic(requestUrl.pathname, res)) return;

  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    const [ytdlp, ffmpeg] = await Promise.all([
      commandVersion(YTDLP_PATH, ['--version']),
      commandVersion('ffmpeg', ['-version'])
    ]);
    return json(res, 200, {
      node: { installed: true, version: process.version },
      ytdlp,
      ffmpeg,
      localOnly: HOST === '127.0.0.1' || HOST === 'localhost'
    });
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/info') {
    const rawUrl = requestUrl.searchParams.get('url');
    try {
      const videoUrl = parseMediaUrl(rawUrl);
      const info = await remoteSourceRequests.preview(videoUrl, () => fetchInfo(videoUrl));
      return json(res, 200, info);
    } catch (error) {
      let parsedUrl = rawUrl;
      try { parsedUrl = parseMediaUrl(rawUrl); } catch {}
      return json(res, 400, { error: error.message, details: classifyPreviewError(error, parsedUrl) });
    }
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/download/start') {
    try {
      const body = await readJsonBody(req);
      const videoUrl = parseMediaUrl(body.url);
      const job = await startDownload(videoUrl, body.options || {}, body.selection || {});
      return json(res, 202, { jobId: job.id });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/download/progress') {
    const job = jobs.get(requestUrl.searchParams.get('id'));
    if (!job) return json(res, 404, { error: 'Download job not found or expired.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
    job.listeners.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      job.listeners.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/download/file') {
    const job = jobs.get(requestUrl.searchParams.get('id'));
    if (!job || job.status !== 'ready') return json(res, 404, { error: 'The prepared files are not available.' });
    const output = job.outputs.find((item) => item.id === requestUrl.searchParams.get('file'));
    if (!output?.filePath) return json(res, 404, { error: 'That prepared file is not available.' });
    return streamPreparedFile(res, output);
  }

  if (req.method === 'DELETE' && requestUrl.pathname === '/api/download/job') {
    const id = requestUrl.searchParams.get('id');
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'Download job not found or already cleared.' });
    await cleanupJob(job);
    jobs.delete(id);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not found.' });
}

if (require.main === module) {
  console.error('app-server.js is an internal LVOVD module. Start LVOVD with node server.js.');
  process.exitCode = 1;
}

module.exports = {
  handleRequest,
  fetchInfo,
  fetchRawInfo,
  sourceSummary,
  capabilitySummary,
  classifyPreviewError,
  parseMediaUrl,
  normalizeOptions,
  normalizeSelection,
  formatSelector,
  buildYtdlpArgs,
  audioConversionArgs,
  resolveTasks,
  startDownload,
  publicJob,
  createProcessWorkRoot,
  createJobWorkDir,
  streamPreparedFile,
  jobs
};
