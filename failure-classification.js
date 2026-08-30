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

function classifySourceFailure(error, context = {}) {
  const evidence = failureEvidence(error);
  const manualSourceFormat = context.manualSourceFormat === true
    || context.sourceFormatMode === 'manual';

  if (/unable to download (?:video )?thumbnail|thumbnail[^\n]*(?:403|forbidden|rejected|failed)/.test(evidence)) {
    return failure(
      'extra_rejected',
      'The thumbnail could not be downloaded',
      'The source rejected the thumbnail request. The media itself may still be available.',
      'Try again without Thumbnail, or wait and try again later.'
    );
  }

  if (/\b(?:http (?:error )?)?429\b|\btoo many requests\b|\brate[ -]?limit(?:ed|ing)?\b|\brequest limit(?:ed|ing)?\b/.test(evidence)) {
    return failure(
      'rate_limited',
      'The source is limiting requests',
      'The source explicitly reported too many requests or another request limit. LVOVD stopped without retrying automatically.',
      'Wait before running Preview or Download again. Repeated attempts may extend the limit.'
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
  classifySourceFailure
};
