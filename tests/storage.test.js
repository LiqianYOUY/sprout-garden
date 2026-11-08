import test from 'node:test';
import assert from 'node:assert/strict';

// A small transactional test double. It serializes transactions and rolls back
// aborted writes, so independent module instances exercise stale-tab protection.
function memoryDatabase() {
  let records = new Map(), queue = Promise.resolve(), failWrite = false;
  const database = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction(_store, mode) {
      const operations = [];
      let aborted = false;
      const transaction = {
        error: null,
        abort() { aborted = true; },
        objectStore() {
          return {
            get(key) {
              const request = {};
              operations.push({ request, execute: staged => structuredClone(staged.get(key)) });
              return request;
            },
            put(value, key) {
              const request = {};
              operations.push({ request, execute: staged => {
                if (failWrite) { failWrite = false; throw new Error('QuotaExceededError'); }
                staged.set(key, structuredClone(value));
                return key;
              } });
              return request;
            },
          };
        },
      };
      queue = queue.then(() => new Promise(resolve => {
        const staged = structuredClone(records);
        function next() {
          if (aborted) { transaction.onabort?.(); resolve(); return; }
          const operation = operations.shift();
          if (!operation) {
            if (mode === 'readwrite') records = staged;
            transaction.oncomplete?.();
            resolve();
            return;
          }
          try {
            operation.request.result = operation.execute(staged);
            operation.request.onsuccess?.();
          } catch (error) {
            transaction.error = error;
            operation.request.error = error;
            operation.request.onerror?.();
            aborted = true;
          }
          queueMicrotask(next);
        }
        queueMicrotask(next);
      }));
      return transaction;
    },
  };
  return {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
    snapshot: () => structuredClone(records.get('state')),
    revision: () => records.get('revision'),
    failNextWrite: () => { failWrite = true; },
    corruptState: value => { records.set('state', value); },
  };
}

let moduleCounter = 0;
const freshStorage = () => import(`../src/storage.js?instance=${moduleCounter++}`);

async function withDatabase(run) {
  const original = globalThis.indexedDB;
  const database = memoryDatabase();
  globalThis.indexedDB = database;
  try { await run(database); }
  finally { if (original === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = original; }
}

test('saved state survives reload only after transaction commit', async () => withDatabase(async database => {
  const storage = await freshStorage();
  const initial = await storage.loadState();
  assert.equal(database.revision(), 1);
  assert.deepEqual(database.snapshot(), initial);
  const changed = structuredClone(initial);
  changed.settings.gardenName = '我的窗边花园';
  await storage.saveState(changed);
  assert.equal(database.revision(), 2);
  assert.equal((await storage.loadState()).settings.gardenName, '我的窗边花园');
}));

test('two simultaneous first visits adopt one initial garden', async () => withDatabase(async database => {
  const [tabA, tabB] = await Promise.all([freshStorage(), freshStorage()]);
  const [stateA, stateB] = await Promise.all([tabA.loadState(), tabB.loadState()]);
  assert.deepEqual(stateA, stateB);
  assert.deepEqual(database.snapshot(), stateA);
  assert.equal(database.revision(), 1);
}));

test('a stale tab cannot overwrite records saved by another tab', async () => withDatabase(async database => {
  const tabA = await freshStorage(), tabB = await freshStorage();
  const stateA = await tabA.loadState(), stateB = await tabB.loadState();
  stateA.plants[0].notes = '另一页新增的观察';
  await tabA.saveState(stateA);
  stateB.settings.location = '旧表单的位置';
  await assert.rejects(tabB.saveState(stateB), error => error.code === 'STALE_STATE');
  assert.equal(database.snapshot().plants[0].notes, '另一页新增的观察');
  assert.equal(database.snapshot().settings.location, '');
  const refreshed = await tabB.loadState();
  refreshed.settings.location = '刷新后的新位置';
  await tabB.saveState(refreshed);
  assert.equal(database.snapshot().plants[0].notes, '另一页新增的观察');
  assert.equal(database.snapshot().settings.location, '刷新后的新位置');
}));

test('transaction failure leaves prior state and revision intact, and can be retried', async () => withDatabase(async database => {
  const storage = await freshStorage();
  const original = await storage.loadState();
  const changed = structuredClone(original);
  changed.plants[0].notes = '需要保留的输入';
  database.failNextWrite();
  await assert.rejects(storage.saveState(changed), /未能保存/);
  assert.deepEqual(database.snapshot(), original);
  assert.equal(database.revision(), 1);
  await storage.saveState(changed);
  assert.equal(database.snapshot().plants[0].notes, '需要保留的输入');
  assert.equal(database.revision(), 2);
}));

test('damaged stored data rejects loading without resetting the database', async () => withDatabase(async database => {
  const storage = await freshStorage();
  await storage.loadState();
  const invalid = { version: 99, privateNote: 'preserve the original' };
  database.corruptState(invalid);
  await assert.rejects(storage.loadState());
  assert.deepEqual(database.snapshot(), invalid);
}));
