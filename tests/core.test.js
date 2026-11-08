import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, today, createInitialState, getTasks, completeTask, validateBackup, calendarICS } from '../src/core.js';
import { saveState } from '../src/storage.js';

function growingState() {
  const state = createInitialState();
  state.plants[0] = { ...state.plants[0], status: 'growing', plantedAt: '2026-10-01', nextWater: today(), nextFeed: addDays(today(), 2), waterEvery: 2, feedEvery: 14 };
  return state;
}

test('calendar arithmetic survives year boundaries, leap years and Sydney DST boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2026-10-04', 1), '2026-10-05');
  assert.equal(daysBetween('2026-10-03', '2026-10-05'), 2);
  assert.equal(daysBetween('2026-04-04', '2026-04-06'), 2);
  assert.equal(daysBetween('2027-01-01', '2026-12-31'), -1);
  assert.throws(() => addDays('2025-02-29', 1));
  assert.throws(() => addDays('2026-04-31', 1));
});

test('initial garden contains only four plans, without invented growth records or tasks', () => {
  const state = createInitialState();
  assert.deepEqual(state.plants.map(plant => plant.species), ['strawberry', 'kangkong', 'pepper', 'tomato']);
  assert.ok(state.plants.every(plant => plant.status === 'planned' && !plant.plantedAt));
  assert.ok(state.plants.every(plant => plant.feedEvery === 0 && !plant.nextFeed));
  assert.deepEqual(state.entries, []);
  state.plants[0].nextWater = today();
  assert.deepEqual(getTasks(state), []);
});

test('tasks include overdue care, exclude disabled fertilizer and archives, and sort by date', () => {
  const state = growingState();
  state.plants[0].nextWater = addDays(today(), -3);
  state.plants[0].feedEvery = 0;
  state.plants[1] = { ...state.plants[1], status: 'growing', nextWater: today() };
  state.plants[2] = { ...state.plants[2], status: 'archived', nextWater: today() };
  const tasks = getTasks(state, addDays(today(), 30));
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].plantId, state.plants[0].id);
  assert.equal(tasks[0].overdue, 3);
  assert.equal(tasks[1].overdue, 0);
});

test('completing care is immutable, advances its schedule, records the action only once', () => {
  const state = growingState();
  const original = structuredClone(state);
  const task = getTasks(state)[0];
  const changed = completeTask(state, task);
  assert.deepEqual(state, original);
  assert.equal(changed.entries.length, 1);
  assert.equal(changed.entries[0].type, 'water');
  assert.equal(changed.plants[0].nextWater, addDays(today(), 2));
  assert.equal(completeTask(changed, task), changed);
  assert.equal(changed.entries.length, 1);
  assert.equal(changed.plants[0].nextFeed, original.plants[0].nextFeed);
});

test('snooze and skip do not invent care records, and stale actions cannot advance twice', () => {
  for (const action of ['snooze', 'skip']) {
    const state = growingState();
    const task = getTasks(state)[0];
    const result = completeTask(state, task, { action });
    assert.equal(result.plants[0].nextWater, addDays(today(), action === 'snooze' ? 1 : 2));
    assert.equal(result.entries.length, 0);
    assert.equal(completeTask(result, task, { action }), result);
  }
});

test('manually adjusted reminders reject an earlier rendered task', () => {
  const state = growingState();
  const task = getTasks(state)[0];
  state.plants[0].nextWater = addDays(today(), 5);
  assert.equal(completeTask(state, task, { action: 'skip' }), state);
  assert.equal(state.entries.length, 0);
});

test('valid backup normalizes optional fields, permits lettuce, and returns detached objects', () => {
  const state = growingState();
  state.plants[0].species = 'lettuce';
  state.settings.lightHours = 4.5;
  delete state.plants[0].notes;
  const result = validateBackup(state);
  assert.equal(result.plants[0].notes, '');
  assert.equal(result.settings.lightHours, 4.5);
  result.plants[0].name = 'changed';
  assert.notEqual(state.plants[0].name, 'changed');
});

test('invalid backups reject unknown fields, duplicate/orphan IDs, numbers, dates and image URLs', () => {
  const invalidMutations = [
    state => { state.unknown = true; },
    state => { state.plants[0].unknown = true; },
    state => { state.settings.unknown = true; },
    state => { state.plants[1].id = state.plants[0].id; },
    state => { state.plants[0].waterEvery = 0; },
    state => { state.plants[0].waterEvery = 1.5; },
    state => { state.plants[0].feedEvery = Infinity; },
    state => { state.settings.lightHours = 25; },
    state => { state.settings.notifications = 'true'; },
    state => { state.settings.reminderTime = '24:00'; },
    state => { state.plants[0].nextWater = '2026-02-30'; },
    state => { state.plants[0].createdAt = '2026-02-30T00:00:00.000Z'; },
    state => { state.plants[0].photo = 'https://example.com/picture.jpg'; },
    state => { state.plants[0].photo = 'data:image/svg+xml;base64,PHN2Zz4='; },
    state => { state.plants[0].photo = 'data:image/png;base64,aGVsbG8='; },
    state => { state.plants[0].photo = `data:image/jpeg;base64,${'/'.repeat(2_800_000)}`; },
    state => { state.entries.push({ id: 'orphan-entry', plantId: 'unknown', type: 'note', date: today(), createdAt: new Date().toISOString() }); },
  ];
  for (const mutate of invalidMutations) {
    const state = growingState();
    mutate(state);
    assert.throws(() => validateBackup(state));
  }
});

test('JPEG, PNG and WebP image signatures are accepted only with the matching MIME', () => {
  const samples = [
    ['jpeg', '\xff\xd8\xff\xe0image'],
    ['png', '\x89PNG\r\n\x1a\nimage'],
    ['webp', 'RIFFxxxxWEBPimage'],
  ];
  for (const [mime, bytes] of samples) {
    const state = growingState();
    state.plants[0].photo = `data:image/${mime};base64,${Buffer.from(bytes, 'latin1').toString('base64')}`;
    assert.equal(validateBackup(state).plants[0].photo, state.plants[0].photo);
  }
});

test('the complete exported backup must remain within the import size limit', () => {
  const state = growingState();
  const imageBytes = Buffer.alloc(2_000_000, 0xff);
  imageBytes[0] = 0xff; imageBytes[1] = 0xd8; imageBytes[2] = 0xff;
  const encoded = `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
  const template = state.plants[0];
  state.plants = Array.from({ length: 24 }, (_, index) => ({ ...template, id: `large-photo-${index}`, photo: encoded }));
  assert.throws(() => validateBackup(state), /60 MiB/);
});

test('invalid import is rejected before storage access and leaves original state intact', async () => {
  const state = growingState();
  const snapshot = structuredClone(state);
  const invalid = structuredClone(state);
  invalid.plants[0].waterEvery = -1;
  let opened = false;
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = { open() { opened = true; throw new Error('should not open'); } };
  try { await assert.rejects(saveState(invalid), /浇水周期/); }
  finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
  assert.equal(opened, false);
  assert.deepEqual(state, snapshot);
});

test('calendar limits events to 30 days, contains alarms and fixed-plan notice, escapes and folds text', () => {
  const state = growingState();
  state.plants[0].name = '草莓, A;B\\C\nBEGIN:VEVENT';
  state.settings.gardenName = '一方小院'.repeat(30);
  state.settings.reminderTime = '08:30';
  const ics = calendarICS(state);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(unfolded.includes('SUMMARY:草莓\\, A\\;B\\\\C\\nBEGIN:VEVENT'));
  assert.ok(unfolded.includes('不会随应用更新实时同步'));
  assert.ok(unfolded.includes('BEGIN:VALARM\r\nTRIGGER:-PT15M'));
  assert.ok(unfolded.includes('T083000'));
  assert.ok(ics.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  const dates = [...unfolded.matchAll(/^DTSTART:(\d{8})T/gm)].map(match => `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`);
  assert.equal(dates.length, 17); // Fifteen watering events plus two fertilizer events.
  assert.ok(dates.every(date => date >= today() && date <= addDays(today(), 29)));
  assert.equal((unfolded.match(/^BEGIN:VEVENT$/gm) || []).length, dates.length);
});
