const DAY_MS = 86_400_000;
const PHOTO_LIMIT = 2 * 1024 * 1024;
const BACKUP_LIMIT = 60 * 1024 * 1024;
const SPECIES = ['strawberry', 'kangkong', 'pepper', 'tomato', 'lettuce', 'custom'];
const CATEGORIES = ['fruit', 'vegetable', 'herb', 'other'];
const STATUSES = ['planned', 'growing', 'archived'];
const STAGES = ['seed', 'seedling', 'vegetative', 'flowering', 'fruiting', 'harvest'];
const ENTRY_TYPES = ['note', 'water', 'feed', 'harvest', 'stage', 'prune', 'repot', 'pest'];
const PLANT_FIELDS = ['id', 'name', 'species', 'category', 'status', 'stage', 'plantedAt', 'location', 'method', 'potSize', 'drainage', 'notes', 'photo', 'waterEvery', 'feedEvery', 'nextWater', 'nextFeed', 'createdAt'];
const ENTRY_FIELDS = ['id', 'plantId', 'type', 'date', 'text', 'photo', 'height', 'weight', 'createdAt'];

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `garden-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A local calendar date. Calendar arithmetic below uses UTC, avoiding DST drift. */
export function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateMillis(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw new Error(`${label}格式不正确`);
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) throw new Error(`${label}不存在`);
  return millis;
}

export function addDays(date, n) {
  if (!Number.isInteger(n)) throw new Error('日期间隔必须是整数');
  const result = new Date(dateMillis(date) + n * DAY_MS);
  const value = result.toISOString().slice(0, 10);
  dateMillis(value);
  return value;
}

/** Signed number of calendar days from a to b. */
export function daysBetween(a, b) {
  return Math.round((dateMillis(b) - dateMillis(a)) / DAY_MS);
}

export function formatDate(date) {
  if (!date) return '未设置';
  const value = new Date(dateMillis(date));
  return `${value.getUTCMonth() + 1}月${value.getUTCDate()}日`;
}

export function createInitialState() {
  const createdAt = new Date().toISOString();
  const templates = [
    ['草莓', 'strawberry', 'fruit', 2, 0],
    ['空心菜', 'kangkong', 'vegetable', 1, 0],
    ['青椒', 'pepper', 'vegetable', 2, 0],
    ['小番茄', 'tomato', 'fruit', 1, 0],
  ];
  return {
    version: 1,
    plants: templates.map(([name, species, category, waterEvery, feedEvery]) => ({
      id: uid(), name, species, category, status: 'planned', stage: 'seedling',
      plantedAt: '', location: '', method: 'pot', potSize: '', drainage: true,
      notes: '', photo: '', waterEvery, feedEvery, nextWater: '', nextFeed: '', createdAt,
    })),
    entries: [],
    settings: { gardenName: '一方小院', location: '', notifications: false, reminderTime: '09:00' },
  };
}

export function getTasks(state, throughDate = today()) {
  dateMillis(throughDate);
  const now = today();
  const tasks = [];
  for (const plant of state.plants) {
    if (plant.status !== 'growing') continue;
    for (const [type, key, period, verb] of [['water', 'nextWater', 'waterEvery', '浇水'], ['feed', 'nextFeed', 'feedEvery', '施肥']]) {
      if (!plant[key] || plant[period] <= 0) continue;
      dateMillis(plant[key]);
      if (plant[key] > throughDate) continue;
      tasks.push({ id: `${plant.id}:${type}`, plantId: plant.id, type, due: plant[key], title: `${plant.name} · ${verb}`, overdue: Math.max(0, daysBetween(plant[key], now)) });
    }
  }
  return tasks.sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
}

/** Pass the complete task returned by getTasks: its due date protects against double clicks and stale UI. */
export function completeTask(state, task, { date = today(), action = 'complete' } = {}) {
  dateMillis(date);
  if (!['complete', 'snooze', 'skip'].includes(action)) throw new Error('不支持的提醒操作');
  if (!task || !['water', 'feed'].includes(task.type)) throw new Error('提醒类型不正确');
  const key = task.type === 'water' ? 'nextWater' : 'nextFeed';
  const periodKey = task.type === 'water' ? 'waterEvery' : 'feedEvery';
  const plant = state.plants.find(item => item.id === task.plantId);
  if (!plant || plant.status !== 'growing' || plant[periodKey] <= 0 || !plant[key] || task.due !== plant[key]) return state;
  if (task.id && task.id !== `${plant.id}:${task.type}`) return state;
  const baseDate = date > task.due ? date : task.due;
  const nextDate = addDays(baseDate, action === 'snooze' ? 1 : plant[periodKey]);
  const result = { ...state, plants: state.plants.map(item => item.id === plant.id ? { ...item, [key]: nextDate } : item), entries: [...state.entries] };
  if (action === 'complete') {
    result.entries.push({ id: uid(), plantId: plant.id, type: task.type, date, text: task.type === 'water' ? '完成浇水' : '完成施肥', photo: '', height: null, weight: null, createdAt: new Date().toISOString() });
  }
  return result;
}

function plainObject(value, label, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}格式不正确`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`${label}包含未知字段：${key}`);
}

function string(value, label, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) throw new Error(`${label}必须是 ${maximum} 字以内的文字`);
  return value;
}

function choice(value, allowed, label, fallback) {
  const result = value === undefined ? fallback : value;
  if (!allowed.includes(result)) throw new Error(`${label}不受支持`);
  return result;
}

function number(value, label, minimum, maximum, fallback, integer = true) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < minimum || result > maximum || (integer && !Number.isInteger(result))) throw new Error(`${label}必须为 ${minimum}–${maximum} 之间的${integer ? '整数' : '数字'}`);
  return result;
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
  return value;
}

function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new Error(`${label}不正确`);
  return value;
}

function optionalDate(value, label) {
  if (value === undefined || value === '') return '';
  dateMillis(value, label);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${label}必须是 ISO 时间`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label}不正确`);
  return value;
}

function photo(value, label) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > Math.ceil(PHOTO_LIMIT / 3) * 4 + 40) throw new Error(`${label}每张不能超过 2 MiB`);
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error(`${label}仅支持 JPEG、PNG、WebP 图片`);
  const bytes = match[2].length * 3 / 4 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (bytes > PHOTO_LIMIT) throw new Error(`${label}每张不能超过 2 MiB`);
  let head;
  try { head = atob(match[2].slice(0, 24)); } catch { throw new Error(`${label}的图片数据不正确`); }
  const valid = match[1] === 'jpeg' ? head.startsWith('\xff\xd8\xff') : match[1] === 'png' ? head.startsWith('\x89PNG\r\n\x1a\n') : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
  if (!valid) throw new Error(`${label}的内容与图片类型不符`);
  return value;
}

/** Creates a detached, known-field-only state. It never mutates its input or persisted data. */
export function validateBackup(input) {
  plainObject(input, '备份', ['version', 'plants', 'entries', 'settings']);
  if (input.version !== 1) throw new Error('不支持此备份版本');
  if (!Array.isArray(input.plants) || input.plants.length > 500) throw new Error('植物列表不正确（最多 500 株）');
  if (!Array.isArray(input.entries) || input.entries.length > 20_000) throw new Error('记录列表不正确（最多 20,000 条）');
  plainObject(input.settings, '花园设置', ['gardenName', 'location', 'notifications', 'lightHours', 'reminderTime']);
  const settings = {
    gardenName: string(input.settings.gardenName, '花园名称', 80, '一方小院').trim() || '一方小院',
    location: string(input.settings.location, '花园位置', 160, ''),
    notifications: boolean(input.settings.notifications, '通知设置', false),
    reminderTime: string(input.settings.reminderTime, '提醒时间', 5, '09:00'),
  };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.reminderTime)) throw new Error('提醒时间必须为 HH:mm 格式');
  if (input.settings.lightHours !== undefined) settings.lightHours = number(input.settings.lightHours, '每日光照', 0, 24, undefined, false);
  const seen = new Set();
  const uniqueId = (value, label) => {
    const result = id(value, label);
    if (seen.has(result)) throw new Error(`备份包含重复 ID：${result}`);
    seen.add(result);
    return result;
  };
  const plants = input.plants.map((item, index) => {
    const label = `植物 ${index + 1}`;
    plainObject(item, label, PLANT_FIELDS);
    const name = string(item.name, `${label}名称`, 100).trim();
    if (!name) throw new Error(`${label}名称不能为空`);
    return {
      id: uniqueId(item.id, `${label} ID`), name,
      species: choice(item.species, SPECIES, `${label}种类`, 'custom'),
      category: choice(item.category, CATEGORIES, `${label}分类`, 'other'),
      status: choice(item.status, STATUSES, `${label}状态`, 'planned'),
      stage: choice(item.stage, STAGES, `${label}阶段`, 'seedling'),
      plantedAt: optionalDate(item.plantedAt, `${label}种植日期`),
      location: string(item.location, `${label}位置`, 160, ''),
      method: choice(item.method, ['pot', 'ground', 'water'], `${label}种植方式`, 'pot'),
      potSize: string(item.potSize, `${label}容器尺寸`, 80, ''),
      drainage: boolean(item.drainage, `${label}排水设置`, true),
      notes: string(item.notes, `${label}备注`, 10_000, ''),
      photo: photo(item.photo, `${label}照片`),
      waterEvery: number(item.waterEvery, `${label}浇水周期`, 1, 60, 2),
      feedEvery: number(item.feedEvery, `${label}施肥周期`, 0, 365, 0),
      nextWater: optionalDate(item.nextWater, `${label}下次浇水日期`),
      nextFeed: optionalDate(item.nextFeed, `${label}下次施肥日期`),
      createdAt: timestamp(item.createdAt, `${label}创建时间`),
    };
  });
  const plantIds = new Set(plants.map(plant => plant.id));
  const entries = input.entries.map((item, index) => {
    const label = `记录 ${index + 1}`;
    plainObject(item, label, ENTRY_FIELDS);
    const plantId = id(item.plantId, `${label}所属植物`);
    if (!plantIds.has(plantId)) throw new Error(`${label}关联了不存在的植物`);
    dateMillis(item.date, `${label}日期`);
    return {
      id: uniqueId(item.id, `${label} ID`), plantId,
      type: choice(item.type, ENTRY_TYPES, `${label}类型`, 'note'), date: item.date,
      text: string(item.text, `${label}内容`, 10_000, ''), photo: photo(item.photo, `${label}照片`),
      height: item.height === null || item.height === undefined ? null : number(item.height, `${label}高度`, 0, 100_000, undefined, false),
      weight: item.weight === null || item.weight === undefined ? null : number(item.weight, `${label}收获重量`, 0, 1_000_000_000, undefined, false),
      createdAt: timestamp(item.createdAt, `${label}创建时间`),
    };
  });
  const result = { version: 1, plants, entries, settings };
  // Match the UI's import limit, including UTF-8 text and exported indentation.
  if (new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength > BACKUP_LIMIT) throw new Error('花园备份超过 60 MiB，请先导出备份，再减少照片或记录后保存。');
  return result;
}

function icsEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

/** RFC 5545 line folding counts UTF-8 bytes, not JS string characters. */
function foldLine(line) {
  const encoder = new TextEncoder();
  let output = '', column = 0;
  for (const character of line) {
    const width = encoder.encode(character).length;
    if (column + width > 75) { output += '\r\n '; column = 1; }
    output += character;
    column += width;
  }
  return output;
}

export function calendarICS(state) {
  const start = today(), end = addDays(start, 29);
  const reminderTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(state.settings.reminderTime || '') ? state.settings.reminderTime : '09:00';
  const time = `${reminderTime.replace(':', '')}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const description = '这是导出时的固定计划。调整养护安排后，请重新导出并替换旧日历。浇水前检查盆土湿度。';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sprout Garden//Garden care//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(`${state.settings.gardenName} · 未来30天养护`)}`, `X-WR-CALDESC:${icsEscape(description)}`];
  for (const plant of state.plants) {
    if (plant.status !== 'growing') continue;
    for (const [type, key, periodKey, verb] of [['water', 'nextWater', 'waterEvery', '浇水'], ['feed', 'nextFeed', 'feedEvery', '施肥']]) {
      const period = plant[periodKey];
      if (!plant[key] || !Number.isInteger(period) || period < 1) continue;
      dateMillis(plant[key]);
      let due = plant[key] < start ? start : plant[key];
      while (due <= end) {
        const summary = `${plant.name} · ${verb}提醒`;
        lines.push('BEGIN:VEVENT', `UID:${plant.id}-${type}-${due}@sprout-garden.local`, `DTSTAMP:${stamp}`, `DTSTART:${due.replace(/-/g, '')}T${time}`, 'DURATION:PT15M', `SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape(description)}`, 'STATUS:CONFIRMED', 'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(summary)}`, 'END:VALARM', 'END:VEVENT');
        due = addDays(due, period);
      }
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
