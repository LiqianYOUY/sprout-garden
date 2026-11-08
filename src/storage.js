import { createInitialState, validateBackup } from './core.js';

const DATABASE = 'sprout-garden';
const STORE = 'garden';
const KEY = 'state';
const REVISION = 'revision';
let databasePromise;
let writeQueue = Promise.resolve();
let loadedRevision;

function revisionNumber(value) {
  if (value === undefined) return 0; // Existing v1 databases predate revision checking.
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('花园数据库版本标记损坏；原始数据已保留，请勿清除网站数据。');
  return value;
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('此浏览器无法使用本地数据库。请使用支持 IndexedDB 的浏览器，或退出限制存储的模式。'));
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      let rejected = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const database = request.result;
        if (rejected) { database.close(); return; }
        database.onversionchange = () => { database.close(); databasePromise = undefined; };
        resolve(database);
      };
      request.onerror = () => reject(new Error('无法打开花园数据库，请检查浏览器存储权限。', { cause: request.error }));
      request.onblocked = () => { rejected = true; reject(new Error('数据库升级被其他标签页占用，请关闭其他花园标签页后重试。')); };
    }).catch(error => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

/** Check-and-write occur in one transaction, so an older tab cannot overwrite newer work. */
async function writeState(state, expectedRevision) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get(REVISION);
    let operationError, nextRevision;
    request.onsuccess = () => {
      try {
        const actualRevision = revisionNumber(request.result);
        if (actualRevision !== expectedRevision) {
          operationError = new Error('另一标签页已更新花园。为避免覆盖新记录，本次未保存；请保留当前填写内容，刷新页面后重新填写。');
          operationError.code = 'STALE_STATE';
          transaction.abort();
          return;
        }
        nextRevision = actualRevision + 1;
        revisionNumber(nextRevision);
        store.put(state, KEY);
        store.put(nextRevision, REVISION);
      } catch (error) { operationError = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(nextRevision);
    transaction.onabort = transaction.onerror = () => reject(operationError || new Error('花园未能保存，请检查浏览器存储空间后重试。', { cause: transaction.error }));
  });
}

export async function saveState(state) {
  // Validate and detach before entering the queue: rejected input cannot replace the existing state.
  const normalized = validateBackup(state);
  const expectedRevision = loadedRevision ?? 0;
  const operation = writeQueue.catch(() => {}).then(() => writeState(normalized, expectedRevision));
  writeQueue = operation;
  loadedRevision = await operation;
  return normalized;
}

export async function loadState() {
  await writeQueue.catch(() => {});
  const database = await openDatabase();
  const { stored, revision } = await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const stateRequest = store.get(KEY);
    const revisionRequest = store.get(REVISION);
    transaction.oncomplete = () => resolve({ stored: stateRequest.result, revision: revisionRequest.result });
    transaction.onabort = transaction.onerror = () => reject(new Error('无法读取已保存的花园，请重试。', { cause: transaction.error }));
  });
  const normalizedRevision = revisionNumber(revision);
  if (stored === undefined) {
    loadedRevision = normalizedRevision;
    const initial = createInitialState();
    try { await saveState(initial); return initial; }
    catch (error) {
      // Concurrent first visits adopt the garden committed by the winning tab.
      if (error.code === 'STALE_STATE') return loadState();
      throw error;
    }
  }
  // Never silently reset a damaged or newer-version backup.
  const state = validateBackup(stored);
  loadedRevision = normalizedRevision;
  return state;
}
