'use strict';

function failure(category, title, explanation, help) {
  return { category, title, explanation, help };
}

function failureEvidence(error) {
  const message = String(error?.message || error || '').trim();
  const diagnostic = String(error?.diagnostic || '').trim();
  return [message, diagnostic]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '[url]');
}

function classifyLocalFailure(error) {
  const message = String(error?.message || error || '').trim();
  const evidence = failureEvidence(error);
  const provenance = error?.localFailure || {};
  const operation = String(provenance.operation || '').toLowerCase();
  const tool = String(provenance.tool || '').toLowerCase();
  const systemCode = String(provenance.systemCode || error?.code || '').toUpperCase();
  const hasStructuredLocalProvenance = Boolean(operation || tool);
  const processStartMissing = operation === 'process_start' && systemCode === 'ENOENT';
  const ffmpegUnavailable = message === 'FFmpeg is not installed or is not on PATH.'
    || (processStartMissing && tool === 'ffmpeg');
  const ytdlpUnavailable = message === 'LVOVD-managed yt-dlp is not ready. Start LVOVD through server.js.'
    || message === 'The configured yt-dlp binary is missing. Restart LVOVD or run npm run update-ytdlp.'
    || (processStartMissing && tool === 'yt-dlp');

  if (ffmpegUnavailable) {
    return failure(
      'local_runtime_unavailable',
      'FFmpeg is unavailable',
      'FFmpeg is not installed or is not on PATH.',
      'Install FFmpeg or make it available on PATH, then restart LVOVD.'
    );
  }

  if (ytdlpUnavailable) {
    return failure(
      'local_runtime_unavailable',
      'LVOVD\'s downloader is not ready',
      message === 'LVOVD-managed yt-dlp is not ready. Start LVOVD through server.js.'
        || message === 'The configured yt-dlp binary is missing. Restart LVOVD or run npm run update-ytdlp.'
        ? message
        : 'The LVOVD-managed yt-dlp executable is missing or could not be started.',
      'Restart LVOVD. If the problem continues, run npm run update-ytdlp.'
    );
  }

  if (processStartMissing) {
    return failure(
      'local_runtime_unavailable',
      'A required local tool is unavailable',
      'A required local program could not be found or started.',
      'Check the required local tools, then restart LVOVD and try again.'
    );
  }

  if (systemCode === 'ENOSPC'
    || (hasStructuredLocalProvenance && /\bno space left on device\b|\bdisk (?:is )?full\b/.test(evidence))) {
    return failure(
      'local_disk_full',
      'Not enough local disk space',
      'The operating system reported that there is not enough space for LVOVD\'s local temporary files.',
      'Free local disk space, then start the download again.'
    );
  }

  if (systemCode === 'EACCES' || systemCode === 'EPERM'
    || (hasStructuredLocalProvenance && /\bpermission denied\b|\boperation not permitted\b|\baccess is denied\b/.test(evidence))) {
    return failure(
      'local_access_denied',
      'LVOVD was denied local access',
      'The operating system denied a local file operation or prevented a required local tool from running.',
      'Check permissions for LVOVD and its temporary workspace, then try again.'
    );
  }

  if ((tool === 'ffmpeg' || operation === 'ffmpeg_processing')
    && /\bunknown (?:encoder|decoder)\b|\b(?:encoder|decoder)(?: \([^\n)]*\))? not found\b|\bno (?:encoder|decoder) found\b|\berror selecting an? (?:encoder|decoder)\b/.test(evidence)) {
    return failure(
      'local_codec_unavailable',
      'FFmpeg does not support a required codec',
      'FFmpeg explicitly reported that a required encoder or decoder is unavailable in this installation.',
      'Use an FFmpeg build with the required codec. For audio jobs, Source Audio or another format may avoid that codec.'
    );
  }

  if (systemCode === 'ENOENT'
    || ((tool === 'ffmpeg' || operation === 'ffmpeg_processing') && /\bno such file or directory\b/.test(evidence))) {
    return failure(
      'local_file_missing',
      'A required local file is missing',
      'A local input or output file could not be found while LVOVD was processing it.',
      'Start the download again. If it repeats, check that LVOVD\'s temporary files are not being removed while it runs.'
    );
  }

  if (provenance.reason === 'output_inconsistent' || operation === 'output_collection') {
    return failure(
      'local_output_inconsistent',
      'LVOVD could not collect the prepared output',
      'Local processing finished, but the expected output files were missing or inconsistent.',
      'Start the download again. If it repeats, check the local temporary workspace and FFmpeg installation.'
    );
  }

  if (tool === 'ffmpeg' || operation === 'ffmpeg_processing' || operation === 'local_processing') {
    return failure(
      'local_processing_failed',
      'Local media processing failed',
      'FFmpeg or another local post-processing step failed without a reliable, more specific cause.',
      'Try again or choose different output options. For audio jobs, Source Audio avoids conversion. If it repeats, check the FFmpeg installation.'
    );
  }

  return failure(
    'local_error',
    'LVOVD could not complete a local operation',
    'A local operation failed, but the available evidence does not identify a reliable specific cause.',
    'Try again. If the problem continues, check that LVOVD can use its local temporary workspace.'
  );
}

function classifyFailure(error, context = {}) {
  const scope = context.scope || error?.failureScope;
  return scope === 'local'
    ? classifyLocalFailure(error)
    : classifySourceFailure(error, context);
}

function classifySourceFailure(error, context = {}) {
  const evidence = failureEvidence(error);
  const manualSourceFormat = context.manualSourceFormat === true
    || context.sourceFormatMode === 'manual';

  if (/\b(?:http (?:error )?)?429\b|\btoo many requests\b|\brate[ -]?limit(?:ed|ing)?\b|\brequest limit(?:ed|ing)?\b/.test(evidence)) {
    return failure(
      'rate_limited',
      'The source is limiting requests',
      'The source explicitly reported too many requests or another request limit. LVOVD stopped without retrying automatically.',
      'Wait before running Preview or Download again. Repeated attempts may extend the limit.'
    );
  }

  if (/unable to download (?:video )?thumbnail|thumbnail[^\n]*(?:403|forbidden|rejected|failed)/.test(evidence)) {
    return failure(
      'extra_rejected',
      'The thumbnail could not be downloaded',
      'The source rejected the thumbnail request. The media itself may still be available.',
      'Try again without Thumbnail, or wait and try again later.'
    );
  }

  if (/\bdrm\b|digital rights management|\bwidevine\b|\bplayready\b|\bfairplay\b|(?:video|media|content|stream)[^\n]{0,30}(?:copy-protected|drm-protected|access-controlled)|(?:copy-protected|drm-protected|access-controlled|protected) (?:video|media|content|stream)/.test(evidence)) {
    return failure(
      'protected',
      'Protected media is not supported',
      'The source reports that this media uses DRM or another access-control protection.',
      'LVOVD does not bypass DRM or access controls. Choose an unprotected source you are allowed to download.'
    );
  }

  if (/\b(?:http (?:error )?)?401\b|\bunauthorized\b|\b(?:log[ -]?in|sign[ -]?in)\b|(?:login|authentication|account) (?:is )?required|(?:use|provide) (?:browser )?cookies|cookies (?:are )?required|--cookies(?:-from-browser)?|members?[ -]?only|account[ -]?only|registered users? only/.test(evidence)) {
    return failure(
      'authentication',
      'This source requires sign-in',
      'The media appears to require an authenticated account or browser cookies that LVOVD does not use.',
      'Use a source that is publicly accessible without signing in. LVOVD does not import browser sessions or bypass authentication.'
    );
  }

  const requestedFormatUnavailable = /requested format[^\n]{0,100}(?:not available|unavailable|not found)|manually selected source format[^\n]{0,100}(?:not available|unavailable)|no matching formats?|format[^\n]{0,80}(?:is |was )?(?:not available|unavailable)/.test(evidence);
  if (requestedFormatUnavailable) {
    if (manualSourceFormat || /manually selected source format/.test(evidence)) {
      return failure(
        'format_unavailable',
        'The selected source format is no longer available',
        'The source no longer offers the manual format reported by the earlier Preview.',
        'Run Preview again and choose a current source format.'
      );
    }
    return failure(
      'format_unavailable',
      'The requested format is unavailable',
      'The source did not offer a format matching the selected download choices.',
      'Run a fresh Preview, then try another format, profile, or resolution.'
    );
  }

  if (/not available in (?:your|this) (?:country|region)|geo(?:graphic)?(?:ally)?[ -]?(?:blocked|restricted)|region[ -]?restricted/.test(evidence)) {
    return failure(
      'geo_restricted',
      'This media is region restricted',
      'The source reports that this media is not available in the current region.',
      'LVOVD does not bypass geographic restrictions.'
    );
  }

  if (/(?:video|media|content|post|item|page|stream|livestream)[^\n]{0,40}(?:unavailable|not available|no longer available|removed|deleted|private|expired)|\bprivate (?:video|media|content|post)\b|(?:has been|was) (?:removed|deleted)\b|(?:link|media|content) (?:has )?expired|(?:video|media|content|post|item) (?:does not|doesn't) exist/.test(evidence)) {
    return failure(
      'unavailable',
      'The media is unavailable',
      'The source reports that this item is not currently accessible. It may be unavailable, private, deleted, or expired.',
      'Check that the URL is current and publicly available, then run Preview again.'
    );
  }

  if (/enter a video or media url|does not look like a valid url|not a valid url|only http\/https media urls are supported/.test(evidence)) {
    return failure(
      'unsupported',
      'This is not a usable media URL',
      'LVOVD could not read this as a complete HTTP or HTTPS media URL.',
      'Check the address and enter the full URL of the media page.'
    );
  }

  if (/\bunsupported url\b|\burl (?:is )?not supported\b|\bno suitable extractor\b|\bunsupported (?:site|extractor)\b/.test(evidence)) {
    return failure(
      'unsupported',
      'yt-dlp did not recognize this media URL',
      'yt-dlp explicitly reported that the URL is unsupported or that no suitable extractor is available.',
      'Check that the URL points to a media page. Updating yt-dlp may add or restore extractor support.'
    );
  }

  if (/\b(?:http (?:error )?)?403\b|\bforbidden\b|\baccess (?:was )?(?:denied|rejected)\b|\brequest (?:was )?(?:denied|rejected|blocked)\b|\bsource[^\n]{0,40}blocked[^\n]{0,20}request\b|\btemporarily blocked\b|automated access (?:is )?blocked/.test(evidence)) {
    return failure(
      'access_rejected',
      'The source rejected the request',
      'The source returned HTTP 403 or another explicit access rejection. This does not by itself prove rate limiting. LVOVD stopped without retrying automatically.',
      'Try again later. If the problem continues, update yt-dlp and run a fresh Preview.'
    );
  }

  return failure(
    'unknown',
    'LVOVD could not complete the source request',
    'The request failed, but the available evidence does not identify a reliable specific cause.',
    'Check that the URL is current and public, run a fresh Preview, and update yt-dlp if the problem continues.'
  );
}

module.exports = {
  classifyFailure,
  classifySourceFailure
};
