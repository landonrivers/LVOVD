'use strict';

const { createHistoryStore, HISTORY_SCHEMA_VERSION } = require('./history-store');

const historyStore = createHistoryStore();
const TERMINAL_JOB_STATUSES = new Set(['ready', 'error', 'cancelled']);

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeHistoryDisplay(raw = {}) {
  return {
    title: boundedText(raw.title, 500),
    sourceName: boundedText(raw.sourceName, 200)
  };
}

function createHistoryContext(videoUrl, options, selection, rawDisplay = {}) {
  return {
    sourceUrl: videoUrl,
    display: normalizeHistoryDisplay(rawDisplay),
    request: {
      options: structuredClone(options),
      selection: structuredClone(selection)
    }
  };
}

function outputHistoryMetadata(output) {
  return {
    filename: output.filename,
    size: output.size,
    kind: output.kind,
    label: output.label
  };
}

function createHistoryEntry(job, finishedAt = new Date()) {
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) {
    throw new TypeError('Only terminal download jobs can become history entries.');
  }

  const context = job.historyContext || {};
  const sourceUrl = context.sourceUrl || null;
  let hostname = null;
  try { hostname = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./i, '') : null; } catch {}
  const outputs = job.status === 'ready'
    ? (job.outputs || []).map(outputHistoryMetadata)
    : [];
  const fallbackTitle = outputs[0]?.filename || hostname || 'Media download';

  return {
    id: job.id,
    createdAt: new Date(job.createdAt || Date.now()).toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: job.status,
    title: context.display?.title || fallbackTitle,
    source: {
      name: context.display?.sourceName || hostname,
      url: sourceUrl
    },
    request: context.request ? structuredClone(context.request) : null,
    outputs,
    failure: job.status === 'error'
      ? {
          category: job.errorCategory || 'download_error',
          message: job.error || job.message || 'Download failed.'
        }
      : null
  };
}

async function recordTerminalJob(job, { store = historyStore, logger = console } = {}) {
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status) || job.historyRecordStarted) return false;
  job.historyRecordStarted = true;
  try {
    await store.upsert(createHistoryEntry(job));
    job.historyRecorded = true;
    return true;
  } catch (error) {
    job.historyRecordError = error.message;
    logger.warn?.(`LVOVD could not save local download history: ${error.message}`);
    return false;
  }
}

module.exports = {
  HISTORY_SCHEMA_VERSION,
  historyStore,
  TERMINAL_JOB_STATUSES,
  normalizeHistoryDisplay,
  createHistoryContext,
  createHistoryEntry,
  recordTerminalJob
};
