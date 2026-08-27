'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HISTORY_SCHEMA_VERSION = 1;

function defaultHistoryDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.LVOVD_DATA_DIR) return path.resolve(env.LVOVD_DATA_DIR);
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'LVOVD');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'LVOVD');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'LVOVD');
}

function emptyHistoryStore() {
  return { version: HISTORY_SCHEMA_VERSION, entries: [] };
}

function historyError(message, code, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateHistoryStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw historyError('History file does not contain an object.', 'LVOVD_HISTORY_CORRUPT');
  }
  if (value.version !== HISTORY_SCHEMA_VERSION) {
    throw historyError(`Unsupported history schema version: ${String(value.version)}.`, 'LVOVD_HISTORY_VERSION');
  }
  if (!Array.isArray(value.entries)) {
    throw historyError('History file does not contain an entries array.', 'LVOVD_HISTORY_CORRUPT');
  }
  return value;
}

function createHistoryStore({
  dataDir = defaultHistoryDataDir(),
  fsPromises = fsp
} = {}) {
  const filePath = path.join(dataDir, 'history.json');
  let mutationTail = Promise.resolve();

  async function readStore() {
    let text;
    try {
      text = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyHistoryStore();
      throw historyError(`Could not read LVOVD history: ${error.message}`, 'LVOVD_HISTORY_READ', error);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw historyError('LVOVD history.json is not valid JSON.', 'LVOVD_HISTORY_CORRUPT', error);
    }
    return validateHistoryStore(parsed);
  }

  async function writeStore(store) {
    const validated = validateHistoryStore(store);
    await fsPromises.mkdir(dataDir, { recursive: true });
    const tempPath = path.join(dataDir, `.history-${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
      await fsPromises.writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      });
      await fsPromises.rename(tempPath, filePath);
    } catch (error) {
      throw historyError(`Could not save LVOVD history: ${error.message}`, 'LVOVD_HISTORY_WRITE', error);
    } finally {
      await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  function mutate(mutator) {
    const operation = mutationTail.then(async () => {
      const store = await readStore();
      return mutator(store);
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function list() {
    const store = await readStore();
    return [...store.entries].sort((a, b) => {
      const right = Date.parse(b?.finishedAt || b?.createdAt || 0) || 0;
      const left = Date.parse(a?.finishedAt || a?.createdAt || 0) || 0;
      return right - left;
    });
  }

  function upsert(entry) {
    if (!entry?.id || typeof entry.id !== 'string') {
      return Promise.reject(new TypeError('History entries require a string id.'));
    }
    const copy = structuredClone(entry);
    return mutate(async (store) => {
      store.entries = [copy, ...store.entries.filter((item) => item?.id !== copy.id)];
      await writeStore(store);
      return copy;
    });
  }

  function remove(id) {
    return mutate(async (store) => {
      const before = store.entries.length;
      store.entries = store.entries.filter((item) => item?.id !== id);
      const removed = before !== store.entries.length;
      if (removed) await writeStore(store);
      return removed;
    });
  }

  function clear() {
    return mutate(async (store) => {
      const removed = store.entries.length;
      if (!removed) return 0;
      store.entries = [];
      await writeStore(store);
      return removed;
    });
  }

  return {
    dataDir,
    filePath,
    list,
    upsert,
    remove,
    clear,
    readStore,
    writeStore
  };
}

module.exports = {
  HISTORY_SCHEMA_VERSION,
  defaultHistoryDataDir,
  emptyHistoryStore,
  validateHistoryStore,
  createHistoryStore
};
