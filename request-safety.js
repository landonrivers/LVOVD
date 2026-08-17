'use strict';

const BATCH_DELAY_MIN_MS = 5000;
const BATCH_DELAY_MAX_MS = 10000;

function createSerialTaskQueue() {
  let tail = Promise.resolve();
  let size = 0;

  return {
    enqueue(task) {
      if (typeof task !== 'function') {
        return Promise.reject(new TypeError('Queued work must be a function.'));
      }

      size += 1;
      const run = async () => {
        try {
          return await task();
        } finally {
          size -= 1;
        }
      };

      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },

    get size() {
      return size;
    }
  };
}

function courtesyDelayMs(random = Math.random) {
  const sample = Number(random());
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999999, sample)) : 0;
  return BATCH_DELAY_MIN_MS
    + Math.floor(normalized * (BATCH_DELAY_MAX_MS - BATCH_DELAY_MIN_MS + 1));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function classifyDownloadError(error) {
  const original = String(error?.message || error || 'Download failed.').trim();
  const diagnostic = String(error?.diagnostic || original).trim();
  const originalLower = original.toLowerCase();
  const diagnosticLower = diagnostic.toLowerCase();

  if (/unable to download (?:video )?thumbnail|thumbnail[^\n]*(?:403|forbidden)/i.test(original)) {
    return {
      category: 'extra_rejected',
      userMessage: `The source rejected the thumbnail request. The media itself may still be available. Try again without Thumbnail or try again later. Original error: ${original}`
    };
  }

  if (/\b429\b|too many requests|rate[ -]?limit|request limit|unusual traffic|temporarily blocked|confirm (?:that )?you(?:'|’)re not a bot/.test(diagnosticLower)) {
    return {
      category: 'rate_limited',
      userMessage: `The source is temporarily limiting requests. LVOVD stopped instead of retrying automatically. Try again later. Original error: ${original}`
    };
  }

  if (/\b403\b|forbidden/.test(originalLower) || /\b403\b|forbidden/.test(diagnosticLower)) {
    return {
      category: 'access_rejected',
      userMessage: `The source rejected the download request (HTTP 403). This can be temporary or mean yt-dlp/source compatibility changed; it does not by itself prove rate limiting. LVOVD stopped instead of retrying automatically. Try updating yt-dlp or try again later. Original error: ${original}`
    };
  }

  return {
    category: 'download_error',
    userMessage: original
  };
}

module.exports = {
  BATCH_DELAY_MIN_MS,
  BATCH_DELAY_MAX_MS,
  createSerialTaskQueue,
  courtesyDelayMs,
  wait,
  classifyDownloadError
};
