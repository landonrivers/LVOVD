'use strict';

const BATCH_DELAY_MIN_MS = 5000;
const BATCH_DELAY_MAX_MS = 10000;

function createSerialTaskQueue() {
  let tail = Promise.resolve();
  let size = 0;
  const keyedTasks = new Map();

  return {
    enqueue(task, { key = null } = {}) {
      if (typeof task !== 'function') {
        return Promise.reject(new TypeError('Queued work must be a function.'));
      }
      if (key != null && keyedTasks.has(key)) return keyedTasks.get(key);

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

      if (key != null) {
        keyedTasks.set(key, result);
        const clearKey = () => {
          if (keyedTasks.get(key) === result) keyedTasks.delete(key);
        };
        result.then(clearKey, clearKey);
      }

      return result;
    },

    get size() {
      return size;
    }
  };
}

function createSourceRequestCoordinator() {
  const queue = createSerialTaskQueue();

  return {
    preview(key, task) {
      return queue.enqueue(task, { key: `preview:${key}` });
    },

    download(task) {
      return queue.enqueue(task);
    },

    acquire(task) {
      return queue.enqueue(task);
    },

    get size() {
      return queue.size;
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

module.exports = {
  BATCH_DELAY_MIN_MS,
  BATCH_DELAY_MAX_MS,
  createSerialTaskQueue,
  createSourceRequestCoordinator,
  courtesyDelayMs,
  wait
};
