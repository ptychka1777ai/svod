'use strict';
/* Свод — сервер: веб-приложение + API + Telegram-бот (текст, голос, фото) */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'svod.json');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TG_SECRET = TG_TOKEN ? crypto.createHash('sha256').update('svod:' + TG_TOKEN).digest('hex').slice(0, 48) : '';
const STATUS_IDS = ['idea', 'todo', 'doing', 'done'];
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR || '8', 10);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const TRASH_DAYS = 30;        /* сколько дней удалённое лежит в корзине */
const BACKUP_KEEP_DAYS = 30;  /* сколько дней хранятся автокопии базы */
/* отдельный токен для просмотра фотографий: сам пароль в URL не попадает */
const FILE_TOKEN = APP_PASSWORD ? crypto.createHash('sha256').update('svod-files:' + APP_PASSWORD).digest('hex').slice(0, 32) : '';
/* токен подписки календаря (ICS): календарь не умеет слать заголовки — ключ в URL */
const CAL_TOKEN = APP_PASSWORD ? crypto.createHash('sha256').update('svod-cal:' + APP_PASSWORD).digest('hex').slice(0, 32) : '';

fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------------- хранилище: JSON-файл на постоянном диске ---------------- */

let db = loadDB();

function defaultDB() {
  return {
    rev: 1,
    projects: [
      { id: 'p1', name: 'Личное', color: '#0e6e73' },
      { id: 'p2', name: 'Работа', color: '#b0431f' },
      { id: 'p3', name: 'Учёба', color: '#8a5cc4' }
    ],
    items: [{
      id: uid(), kind: 'task', title: 'Добро пожаловать в Свод',
      note: 'Задачи можно добавлять здесь или через Telegram-бота: текстом, голосом или фото.',
      projectId: 'p1', status: 'todo', priority: 2, due: '', url: '', tags: ['старт'], created: Date.now()
    }]
  };
}

function validDB(d) { return !!(d && Array.isArray(d.items) && Array.isArray(d.projects)); }

/* имена сортируются лексикографически = хронологически */
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(function (n) { return /\.json$/.test(n); }).sort().reverse();
  } catch (e) { return []; }
}

function snapshot(reason) {
  try {
    const name = 'svod-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '-' + reason + '.json';
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(db));
    pruneBackups();
    return name;
  } catch (e) { console.error('snapshot:', e.message); return ''; }
}

function pruneBackups() {
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 864e5;
  listBackups().forEach(function (n) {
    const p = path.join(BACKUP_DIR, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
  });
}

function loadDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (validDB(d)) return d;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('svod.json не читается:', e.message);
  }
  /* файл повреждён: НЕ перезаписываем его — откладываем в сторону
     и поднимаем базу из последней исправной автокопии */
  if (fs.existsSync(DB_FILE)) {
    const bad = DB_FILE + '.corrupt-' + Date.now();
    try { fs.renameSync(DB_FILE, bad); console.error('Повреждённый файл базы сохранён как ' + bad); } catch (e) {}
  }
  const names = listBackups();
  for (let i = 0; i < names.length; i++) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, names[i]), 'utf8'));
      if (validDB(d)) { console.error('База восстановлена из автокопии ' + names[i]); return d; }
    } catch (e) {}
  }
  if (names.length) console.error('Исправных автокопий не нашлось — старт с базой по умолчанию');
  return defaultDB();
}

let lastSnapAt = 0;
function saveDB() {
  db.rev = (db.rev || 0) + 1;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  if (Date.now() - lastSnapAt > 3600e3) { lastSnapAt = Date.now(); snapshot('auto'); }
}

/* окончательное удаление из корзины по истечении срока (+ файлы фото) */
function purgeTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  const gone = db.items.filter(function (i) { return i.deleted && i.deleted < cutoff; });
  if (!gone.length) return;
  db.items = db.items.filter(function (i) { return !(i.deleted && i.deleted < cutoff); });
  gone.forEach(function (i) {
    if (i.url && i.url.indexOf('/files/') === 0) {
      const still = db.items.some(function (x) { return x.url === i.url; });
      if (!still) { try { fs.unlinkSync(path.join(FILES_DIR, path.basename(i.url))); } catch (e) {} }
    }
  });
  saveDB();
  console.log('Корзина: окончательно удалено записей — ' + gone.length);
}

function uid() { return 'i' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function cleanItem(b, isNew) {
  const src = b || {};
  const item = {
    id: (typeof src.id === 'string' && src.id) ? src.id : uid(),
    kind: src.kind === 'material' ? 'material' : 'task',
    title: String(src.title || '').slice(0, 300),
    note: String(src.note || '').slice(0, 5000),
    url: String(src.url || '').slice(0, 2000),
    tags: Array.isArray(src.tags) ? src.tags.map(function (t) { return String(t).slice(0, 60); }).slice(0, 20) : [],
    created: (typeof src.created === 'number') ? src.created : Date.now()
  };
  /* служебные поля переживают экспорт/импорт */
  if (typeof src.deleted === 'number') item.deleted = src.deleted;
  if (typeof src.doneAt === 'number') item.doneAt = src.doneAt;
  if (typeof src.reminded === 'number') item.reminded = src.reminded;
  if (item.kind === 'task') {
    item.projectId = String(src.projectId || '');
    item.status = STATUS_IDS.indexOf(src.status) !== -1 ? src.status : 'todo';
    item.priority = [0, 1, 2, 3, 4].indexOf(src.priority) !== -1 ? src.priority : 0;
    item.due = /^\d{4}-\d{2}-\d{2}$/.test(src.due || '') ? src.due : '';
    item.dueTime = /^\d{2}:\d{2}$/.test(src.dueTime || '') ? src.dueTime : '';
  }
  return item;
}

/* ---------------- веб-сервер ---------------- */

const app = express();
app.set('trust proxy', 1); /* Render — за прокси: req.ip берётся из X-Forwarded-For */
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', function (req, res) { res.type('text').send('ok v2.2'); });

/* сравнение без утечки по времени */
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* защита от перебора пароля: 30 неверных попыток с адреса — пауза 15 минут */
const authFails = new Map();
function auth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const ip = req.ip || '?';
  const rec = authFails.get(ip);
  if (rec && Date.now() >= rec.until) authFails.delete(ip);
  const cur = authFails.get(ip);
  if (cur && cur.n >= 30) return res.status(429).json({ error: 'too many attempts' });
  const t = req.get('x-auth') || '';
  if (t && safeEq(t, APP_PASSWORD)) { authFails.delete(ip); return next(); }
  if (authFails.size > 5000) authFails.clear();
  const r = cur || { n: 0, until: Date.now() + 15 * 60e3 };
  r.n++; authFails.set(ip, r);
  res.status(401).json({ error: 'unauthorized' });
}

app.use(express.static(path.join(__dirname, 'public')));

/* файлы из Telegram (фото, аудио): по файловому токену или по заголовку x-auth */
app.get('/files/:name', function (req, res) {
  const t = String(req.query.t || '');
  const h = req.get('x-auth') || '';
  const ok = !APP_PASSWORD
    || (FILE_TOKEN && t && safeEq(t, FILE_TOKEN))
    || (h && safeEq(h, APP_PASSWORD));
  if (!ok) return res.sendStatus(401);
  const p = path.join(FILES_DIR, path.basename(req.params.name));
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

/* ---------------- API ---------------- */

app.get('/api/state', auth, function (req, res) {
  const etag = '"' + (db.rev || 0) + '-' + meetRev + '"';
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.json({ rev: db.rev || 0, mrev: meetRev, projects: db.projects, items: db.items, meetings: MEETINGS, fileToken: FILE_TOKEN, calToken: CAL_TOKEN });
});

app.post('/api/items', auth, function (req, res) {
  const item = cleanItem(req.body, true);
  if (!item.title) return res.status(400).json({ error: 'title required' });
  db.items.unshift(item);
  saveDB();
  res.json({ item: item, rev: db.rev });
});

app.patch('/api/items/:id', auth, function (req, res) {
  const it = db.items.find(function (x) { return x.id === req.params.id; });
  if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.title === 'string') it.title = b.title.slice(0, 300);
  if (typeof b.note === 'string') it.note = b.note.slice(0, 5000);
  if (typeof b.url === 'string') it.url = b.url.slice(0, 2000);
  if (Array.isArray(b.tags)) it.tags = b.tags.map(function (t) { return String(t).slice(0, 60); }).slice(0, 20);
  if (STATUS_IDS.indexOf(b.status) !== -1 && b.status !== it.status) {
    it.status = b.status;
    if (b.status === 'done') it.doneAt = Date.now(); else delete it.doneAt;
  }
  if ([0, 1, 2, 3, 4].indexOf(b.priority) !== -1) it.priority = b.priority;
  if (typeof b.due === 'string' && (b.due === '' || /^\d{4}-\d{2}-\d{2}$/.test(b.due))) it.due = b.due;
  if (typeof b.dueTime === 'string' && (b.dueTime === '' || /^\d{2}:\d{2}$/.test(b.dueTime))) {
    if (b.dueTime !== it.dueTime) delete it.reminded; /* время сменили — напомним заново */
    it.dueTime = b.dueTime;
  }
  if (typeof b.projectId === 'string') it.projectId = b.projectId;
  saveDB();
  res.json({ item: it, rev: db.rev });
});

/* удаление — мягкое: запись уходит в корзину на TRASH_DAYS дней */
app.delete('/api/items/:id', auth, function (req, res) {
  const it = db.items.find(function (x) { return x.id === req.params.id; });
  if (!it) return res.status(404).json({ error: 'not found' });
  it.deleted = Date.now();
  saveDB();
  res.json({ ok: true, rev: db.rev });
});

app.post('/api/items/:id/restore', auth, function (req, res) {
  const it = db.items.find(function (x) { return x.id === req.params.id; });
  if (!it) return res.status(404).json({ error: 'not found' });
  delete it.deleted;
  saveDB();
  res.json({ item: it, rev: db.rev });
});

/* перестановка карточек на доске (drag&drop) */
app.post('/api/reorder', auth, function (req, res) {
  const b = req.body || {};
  const it = db.items.find(function (x) { return x.id === b.id; });
  if (!it || !Array.isArray(b.orderedIds)) return res.status(400).json({ error: 'bad request' });
  if (STATUS_IDS.indexOf(b.status) !== -1 && b.status !== it.status) {
    it.status = b.status;
    if (b.status === 'done') it.doneAt = Date.now(); else delete it.doneAt;
  }
  const byId = {};
  db.items.forEach(function (x) { byId[x.id] = x; });
  const colTasks = b.orderedIds.map(function (cid) { return byId[cid]; }).filter(Boolean);
  const inCol = {};
  colTasks.forEach(function (x) { inCol[x.id] = 1; });
  db.items = db.items.filter(function (x) { return !inCol[x.id]; }).concat(colTasks);
  saveDB();
  res.json({ ok: true, rev: db.rev });
});

app.post('/api/projects', auth, function (req, res) {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const p = { id: (typeof b.id === 'string' && b.id) ? b.id : uid(), name: name, color: String(b.color || '#0e6e73').slice(0, 20) };
  db.projects.push(p);
  saveDB();
  res.json({ project: p, rev: db.rev });
});

app.delete('/api/projects/:id', auth, function (req, res) {
  db.projects = db.projects.filter(function (p) { return p.id !== req.params.id; });
  db.items.forEach(function (i) { if (i.projectId === req.params.id) i.projectId = ''; });
  saveDB();
  res.json({ ok: true, rev: db.rev });
});

/* полная замена данных (кнопка «Импорт») — с автоснимком до замены */
app.post('/api/import', auth, function (req, res) {
  const b = req.body || {};
  if (!Array.isArray(b.items) || !Array.isArray(b.projects)) return res.status(400).json({ error: 'bad file' });
  const snap = snapshot('pre-import');
  db = {
    rev: (db.rev || 0),
    digestDate: db.digestDate,
    backupDate: db.backupDate,
    projects: b.projects.map(function (p) {
      return { id: String(p.id || uid()), name: String(p.name || '').slice(0, 60), color: String(p.color || '#0e6e73').slice(0, 20) };
    }),
    items: b.items.map(function (i) { return cleanItem(i, false); })
  };
  saveDB();
  res.json({ ok: true, rev: db.rev, snapshot: snap });
});

/* откат последнего импорта к снимку pre-import */
app.post('/api/import-undo', auth, function (req, res) {
  const names = listBackups().filter(function (n) { return n.indexOf('pre-import') !== -1; });
  if (!names.length) return res.status(404).json({ error: 'no snapshot' });
  try {
    const d = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, names[0]), 'utf8'));
    if (!validDB(d)) throw new Error('bad snapshot');
    snapshot('pre-undo');
    d.rev = (db.rev || 0);
    db = d;
    saveDB();
    res.json({ ok: true, rev: db.rev });
  } catch (e) {
    console.error('import-undo:', e.message);
    res.status(500).json({ error: 'restore failed' });
  }
});

/* список автокопий и скачивание любой из них (история данных) */
app.get('/api/backups', auth, function (req, res) {
  const rows = listBackups().map(function (n) {
    let st = null;
    try { st = fs.statSync(path.join(BACKUP_DIR, n)); } catch (e) { return null; }
    return { name: n, size: st.size, time: st.mtimeMs };
  }).filter(Boolean);
  res.json({ backups: rows });
});

app.get('/api/backups/:name', auth, function (req, res) {
  const n = path.basename(req.params.name);
  const p = path.join(BACKUP_DIR, n);
  if (!/\.json$/.test(n) || !fs.existsSync(p)) return res.sendStatus(404);
  res.download(p);
});

/* ---------------- голос из веб-приложения ----------------
   Кнопка-микрофон на сайте шлёт сюда аудио: Whisper → парсер → задача. */
app.post('/api/voice', auth, express.raw({ type: function () { return true; }, limit: '25mb' }), async function (req, res) {
  if (!OPENAI_KEY) return res.status(400).json({ error: 'no-openai' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 800) return res.status(400).json({ error: 'empty' });
  try {
    const mime = (req.get('content-type') || 'audio/webm').split(';')[0].trim();
    const extMap = { 'audio/webm': '.webm', 'audio/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac' };
    const recognized = await transcribe(req.body, 'voice' + (extMap[mime] || '.webm'));
    if (!recognized) return res.status(422).json({ error: 'no-speech' });
    const item = addParsed(await parseText(recognized));
    res.json({ item: item, recognized: recognized, rev: db.rev });
  } catch (e) {
    console.error('api/voice:', e.message);
    if (/transcribe/.test(String(e.message))) return res.status(422).json({ error: 'no-speech' });
    res.status(500).json({ error: 'fail' });
  }
});

/* ---------------- входящие от автоматизаций (Make/Zapier) ----------------
   Конспекты встреч из Plaud/Granola: POST JSON {source, title, text, url?}
   с заголовком x-auth. Создаёт материал в библиотеке (тег «встреча» + источник)
   и задачи из договорённостей, касающихся владельца. */
function meetingPrompt() {
  const names = db.projects.map(function (p) { return p.name; }).join(', ');
  return 'Ты обрабатываешь конспект встречи для личного таск-менеджера Юлии. Сегодня ' + kyivToday() +
    ' (Europe/Kyiv). Верни ТОЛЬКО JSON:\n' +
    '{"summary":"...","tasks":[{"title":"...","note":"...","due":"YYYY-MM-DD"|null,"dueTime":"HH:MM"|null,"priority":0|1|2|3|4,"project":"..."|null}]}\n' +
    'summary — суть встречи по-русски, 2–4 предложения: решения, договорённости, сроки. ' +
    'tasks — только конкретные действия, которые касаются Юлии (ей поручили или она обещала сделать), до 8 штук. ' +
    'due/dueTime — только если срок или время явно названы. priority 3–4 — только если подчёркнута срочность. ' +
    'Не выдумывай задачи: нет действий — верни пустой массив. ' +
    'project — только если встреча явно про один из: ' + names + '. Иначе null.';
}

app.post('/api/inbox', auth, async function (req, res) {
  const b = req.body || {};
  const rawText = String(b.text || b.transcript || b.summary || '').trim();
  const title = (String(b.title || '').trim() || 'Встреча').slice(0, 200);
  const source = String(b.source || '').trim().slice(0, 30).toLowerCase();
  if (!rawText && !b.url) return res.status(400).json({ error: 'text required' });
  try {
    let summary = rawText.slice(0, 1500);
    let extracted = [];
    if (OPENAI_KEY && rawText) {
      try {
        const r = await openaiChat([
          { role: 'system', content: meetingPrompt() },
          { role: 'user', content: ('Название встречи: ' + title + '\n\n' + rawText).slice(0, 24000) }
        ]);
        if (r && typeof r.summary === 'string' && r.summary) summary = r.summary.slice(0, 2000);
        if (r && Array.isArray(r.tasks)) extracted = r.tasks.slice(0, 8);
      } catch (e) { console.error('inbox parse:', e.message); }
    }
    const mat = {
      id: uid(), kind: 'material',
      title: '🎧 ' + title,
      note: summary,
      url: String(b.url || '').slice(0, 2000),
      tags: ['встреча'].concat(source ? [source] : []),
      created: Date.now()
    };
    db.items.unshift(mat);
    const made = [];
    extracted.forEach(function (t) {
      if (!t || !t.title) return;
      const task = {
        id: uid(), kind: 'task',
        title: String(t.title).slice(0, 200),
        note: ((t.note ? String(t.note).slice(0, 1000) + '\n' : '') + 'Из встречи: ' + title).slice(0, 5000),
        url: '', tags: ['встреча'],
        projectId: matchProject(b.project || t.project),
        status: 'todo',
        priority: [0, 1, 2, 3, 4].indexOf(t.priority) !== -1 ? t.priority : 0,
        due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '',
        dueTime: /^\d{2}:\d{2}$/.test(t.dueTime || '') ? t.dueTime : '',
        created: Date.now()
      };
      if (task.dueTime && !task.due) task.dueTime = '';
      db.items.unshift(task);
      made.push(task);
    });
    saveDB();
    if (TG_TOKEN && TG_CHAT) {
      send(TG_CHAT, '🎧 Встреча «' + title + '» сохранена в библиотеку.' +
        (made.length ? '\nЗадачи из встречи:\n' + made.map(function (t) { return '• ' + t.title + (t.due ? ' (' + fmtDue(t.due) + ')' : ''); }).join('\n') : ''))
        .catch(function () {});
    }
    res.json({ material: mat, tasks: made, rev: db.rev });
  } catch (e) {
    console.error('api/inbox:', e.message);
    res.status(500).json({ error: 'fail' });
  }
});

/* ---------------- рабочий календарь (импорт ICS) ----------------
   CALENDAR_ICS_URL — секретный iCal-адрес рабочего календаря (Google:
   настройки календаря → «Секретный адрес в формате iCal»). Раз в 30 минут
   забираем встречи на ближайшие 2 недели: они видны в календаре «Свода»
   и попадают в утреннюю сводку. Только чтение, в календарь ничего не пишем. */
const CAL_ICS_URL = process.env.CALENDAR_ICS_URL || '';
let MEETINGS = [];
let meetRev = 0;

function icsUnfold(s) { return String(s).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function tzOffsetMs(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  dtf.formatToParts(ms).forEach(function (x) { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - ms;
}
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  guess = Date.UTC(y, mo - 1, d, h, mi, s || 0) - tzOffsetMs(guess, tz);
  guess = Date.UTC(y, mo - 1, d, h, mi, s || 0) - tzOffsetMs(guess, tz);
  return guess;
}
function kyivDayOf(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }); }
function kyivTimeOf(ms) { return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false }); }

/* DTSTART/DTEND/EXDATE → {ms, allDay, wall, tz}; wall+tz нужны, чтобы
   повторы шли по «настенному» времени и не съезжали на переводе часов */
function parseIcsDt(val, params) {
  const m = String(val).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (!m[4]) return { ms: Date.UTC(y, mo - 1, d), allDay: true, wall: { y: y, mo: mo, d: d, h: 0, mi: 0, s: 0 }, tz: null };
  const h = +m[4], mi = +m[5], s = +(m[6] || 0);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, wall: null, tz: null };
  const tzm = String(params || '').match(/TZID=([^;:]+)/);
  const tz = tzm ? tzm[1].replace(/^"|"$/g, '') : 'Europe/Kyiv';
  try {
    return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, wall: { y: y, mo: mo, d: d, h: h, mi: mi, s: s }, tz: tz };
  } catch (e) { return null; }
}

function occMs(st, dayN) {
  if (!dayN) return st.ms;
  if (st.wall && st.tz) {
    const base = new Date(Date.UTC(st.wall.y, st.wall.mo - 1, st.wall.d + dayN));
    return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), st.wall.h, st.wall.mi, st.wall.s, st.tz);
  }
  return st.ms + dayN * 864e5;
}
function occDow(st, dayN) {
  if (st.wall) return new Date(Date.UTC(st.wall.y, st.wall.mo - 1, st.wall.d + dayN)).getUTCDay();
  return new Date(st.ms + dayN * 864e5).getUTCDay();
}

function parseIcsEvents(text, winStart, winEnd) {
  const out = [];
  const blocks = icsUnfold(text).split('BEGIN:VEVENT').slice(1);
  for (let bi = 0; bi < blocks.length && out.length < 300; bi++) {
    const body = blocks[bi].split('END:VEVENT')[0];
    const prop = {};
    const exdates = [];
    body.split('\n').forEach(function (line) {
      const ci = line.indexOf(':');
      if (ci < 1) return;
      const head = line.slice(0, ci), val = line.slice(ci + 1);
      const name = head.split(';')[0].toUpperCase();
      if (name === 'EXDATE') { exdates.push({ val: val, params: head }); return; }
      if (!prop[name]) prop[name] = { val: val, params: head };
    });
    if (!prop.DTSTART || !prop.SUMMARY) continue;
    if (prop.STATUS && /CANCELLED/i.test(prop.STATUS.val)) continue;
    const st = parseIcsDt(prop.DTSTART.val, prop.DTSTART.params);
    if (!st) continue;
    let durMs = st.allDay ? 864e5 : 3600e3;
    if (prop.DTEND) {
      const en = parseIcsDt(prop.DTEND.val, prop.DTEND.params);
      if (en && en.ms > st.ms) durMs = en.ms - st.ms;
    }
    const title = String(prop.SUMMARY.val).replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim().slice(0, 140);
    if (!title) continue;
    const exSet = {};
    exdates.forEach(function (e) {
      String(e.val).split(',').forEach(function (v) {
        const p = parseIcsDt(v.trim(), e.params);
        if (p) exSet[(p.allDay && p.wall) ? (p.wall.y + '-' + String(p.wall.mo).padStart(2, '0') + '-' + String(p.wall.d).padStart(2, '0')) : (kyivDayOf(p.ms) + 'T' + kyivTimeOf(p.ms))] = 1;
      });
    });
    const uidStr = prop.UID ? prop.UID.val : title;
    function pushOcc(dayN) {
      const ms = occMs(st, dayN);
      if (ms + durMs < winStart || ms > winEnd) return;
      const day = (st.allDay && st.wall)
        ? new Date(Date.UTC(st.wall.y, st.wall.mo - 1, st.wall.d + dayN)).toISOString().slice(0, 10)
        : kyivDayOf(ms);
      const key = st.allDay ? day : (day + 'T' + kyivTimeOf(ms));
      if (exSet[key]) return;
      out.push({
        id: 'm' + crypto.createHash('md5').update(uidStr + '|' + ms).digest('hex').slice(0, 10),
        title: title,
        day: day,
        time: st.allDay ? '' : kyivTimeOf(ms),
        end: st.allDay ? '' : kyivTimeOf(ms + durMs),
        allDay: !!st.allDay
      });
    }
    const rr = prop.RRULE ? prop.RRULE.val : '';
    if (!rr) { pushOcc(0); continue; }
    const R = {};
    rr.split(';').forEach(function (kv) { const p = kv.split('='); if (p[0]) R[p[0].toUpperCase()] = p[1] || ''; });
    if (R.FREQ !== 'DAILY' && R.FREQ !== 'WEEKLY') { pushOcc(0); continue; } /* месячные/годовые повторы не разворачиваем */
    const interval = Math.max(1, parseInt(R.INTERVAL || '1', 10) || 1);
    let until = Infinity;
    if (R.UNTIL) { const u = parseIcsDt(R.UNTIL, ''); if (u) until = u.ms + (u.allDay ? 864e5 : 0); }
    const count = R.COUNT ? (parseInt(R.COUNT, 10) || Infinity) : Infinity;
    const DAYMAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const byday = (R.FREQ === 'WEEKLY' && R.BYDAY)
      ? R.BYDAY.split(',').map(function (x) { return DAYMAP[x.replace(/^[+-]?\d+/, '').trim()]; }).filter(function (x) { return x !== undefined; })
      : null;
    let occ = 0;
    for (let dayN = 0; dayN < 5000 && occ < count; dayN++) {
      const ms = occMs(st, dayN);
      if (ms > winEnd || ms > until) break;
      let hit;
      if (R.FREQ === 'DAILY') hit = dayN % interval === 0;
      else {
        const weekIdx = Math.floor(dayN / 7);
        const slot = byday ? byday.indexOf(occDow(st, dayN)) !== -1 : dayN % 7 === 0;
        hit = weekIdx % interval === 0 && slot;
      }
      if (!hit) continue;
      occ++;
      pushOcc(dayN);
    }
  }
  return out;
}

async function syncCalendar() {
  if (!CAL_ICS_URL) return;
  try {
    const r = await fetchT(CAL_ICS_URL, {}, 30000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const now = Date.now();
    const evs = parseIcsEvents(text, now - 864e5, now + 14 * 864e5);
    evs.sort(function (a, b) {
      const ka = a.day + ' ' + (a.time || '00:00'), kb = b.day + ' ' + (b.time || '00:00');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    if (JSON.stringify(evs) !== JSON.stringify(MEETINGS)) { MEETINGS = evs; meetRev++; }
  } catch (e) { console.error('calendar sync:', e.message); }
}

/* голосовая диктовка с сайта: аудио → Whisper → GPT-разбор → запись.
   Клиент шлёт «сырое» аудио; ошибки отдаём кодами, которые понимает интерфейс. */
app.post('/api/voice', auth, express.raw({ type: function () { return true; }, limit: '25mb' }), async function (req, res) {
  if (!OPENAI_KEY) return res.status(503).json({ error: 'no-openai' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 500) return res.status(400).json({ error: 'no-audio' });
  try {
    const mime = String(req.get('content-type') || 'audio/webm');
    const ext = mime.indexOf('mp4') !== -1 ? '.mp4' : (mime.indexOf('ogg') !== -1 ? '.ogg' : '.webm');
    const recognized = await transcribe(buf, 'voice' + ext);
    if (!recognized || !recognized.trim()) return res.status(422).json({ error: 'no-speech' });
    const item = addParsed(await parseText(recognized));
    res.json({ item: item, recognized: recognized, rev: db.rev });
  } catch (e) {
    console.error('web voice:', e.message);
    res.status(502).json({ error: 'transcribe-failed' });
  }
});

/* ---------------- подписка календаря (ICS) ----------------
   Google Calendar / календарь iPhone подписываются на этот адрес и сами
   подтягивают задачи со сроками. Доступ — по секретному ключу в URL. */

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/* сворачивание длинных строк по RFC 5545 (75 байт) */
function icsFold(line) {
  const out = [];
  let s = line;
  while (Buffer.byteLength(s, 'utf8') > 73) {
    let cut = 73;
    while (cut > 1 && Buffer.byteLength(s.slice(0, cut), 'utf8') > 73) cut--;
    out.push(s.slice(0, cut));
    s = ' ' + s.slice(cut);
  }
  out.push(s);
  return out.join('\r\n');
}

const VTIMEZONE_KYIV = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Kyiv',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:EEST',
  'DTSTART:19700329T030000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:EET',
  'DTSTART:19701025T040000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE'
].join('\r\n');

app.get('/calendar.ics', function (req, res) {
  if (APP_PASSWORD) {
    const k = String(req.query.key || '');
    if (!CAL_TOKEN || !k || !safeEq(k, CAL_TOKEN)) return res.sendStatus(401);
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//svod//RU', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Свод', 'X-WR-TIMEZONE:Europe/Kyiv', VTIMEZONE_KYIV];
  aliveItems().forEach(function (i) {
    if (i.kind !== 'task' || !i.due || i.status === 'done') return;
    const d = i.due.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + i.id + '@svod');
    lines.push('DTSTAMP:' + new Date(i.created || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
    if (i.dueTime) {
      const t = i.dueTime.replace(':', '') + '00';
      const endH = (parseInt(i.dueTime.slice(0, 2), 10) + 1) % 24;
      const endT = (endH < 10 ? '0' : '') + endH + i.dueTime.slice(3) + '00';
      /* событие в конкретное время (час длительности) */
      lines.push('DTSTART;TZID=Europe/Kyiv:' + d + 'T' + t);
      lines.push('DTEND;TZID=Europe/Kyiv:' + d + 'T' + endT);
    } else {
      /* задача без времени — событие «на весь день» */
      const nd = new Date(+i.due.slice(0, 4), +i.due.slice(5, 7) - 1, +i.due.slice(8, 10) + 1);
      const nds = nd.getFullYear() + (nd.getMonth() < 9 ? '0' : '') + (nd.getMonth() + 1) + (nd.getDate() < 10 ? '0' : '') + nd.getDate();
      lines.push('DTSTART;VALUE=DATE:' + d);
      lines.push('DTEND;VALUE=DATE:' + nds);
    }
    lines.push(icsFold('SUMMARY:' + icsEscape(i.title)));
    if (i.note) lines.push(icsFold('DESCRIPTION:' + icsEscape(String(i.note).slice(0, 500))));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(lines.join('\r\n') + '\r\n');
});

/* ---------------- Telegram-бот ---------------- */

/* fetch с таймаутом: зависший внешний сервис не блокирует обработку навсегда */
function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms || 30000);
  opts = opts || {};
  opts.signal = ctl.signal;
  return fetch(url, opts).finally(function () { clearTimeout(timer); });
}

function tg(method, payload) {
  return fetchT('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 15000).then(function (r) { return r.json(); });
}

/* отправка файла (multipart) — для резервных копий базы */
async function tgSendDocument(chatId, filePath, caption) {
  const fd = new FormData();
  fd.append('chat_id', chatId);
  fd.append('disable_notification', 'true');
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob([fs.readFileSync(filePath)], { type: 'application/json' }), path.basename(filePath));
  const r = await fetchT('https://api.telegram.org/bot' + TG_TOKEN + '/sendDocument', { method: 'POST', body: fd }, 60000);
  return r.json();
}

function send(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text: text, disable_web_page_preview: true });
}

function sendKb(chatId, text, kb) {
  return tg('sendMessage', { chat_id: chatId, text: text, disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } });
}

function editKb(chatId, messageId, text, kb) {
  return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: text, disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } });
}

async function tgFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f.ok) throw new Error('getFile failed: ' + JSON.stringify(f));
  const fp = f.result.file_path;
  const r = await fetchT('https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fp, {}, 60000);
  if (!r.ok) throw new Error('file download failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf: buf, path: fp };
}

function kyivToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
}

function mimeFromExt(ext) {
  const m = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  return m[ext.toLowerCase()] || 'image/jpeg';
}

function kyivWeekday() {
  return new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kyiv', weekday: 'long' });
}

function parserPrompt() {
  const names = db.projects.map(function (p) { return p.name; }).join(', ');
  return 'Ты — парсер входящих сообщений для личного таск-менеджера. Сегодня ' + kyivToday() +
    ', ' + kyivWeekday() + ' (часовой пояс Europe/Kyiv). Верни ТОЛЬКО JSON:\n' +
    '{"kind":"task"|"material","status":"todo"|"idea","title":"...","note":"...","due":"YYYY-MM-DD"|null,' +
    '"dueTime":"HH:MM"|null,"priority":0|1|2|3|4,"url":"..."|null,"tags":["..."],"project":"..."|null}\n' +
    'Правила: kind="material" — если это ссылка/статья/видео/книга для сохранения в библиотеку, а не действие. ' +
    'status="idea" — если это идея или мысль, а не конкретное действие. ' +
    'title — краткая формулировка до 100 символов, с большой буквы. note — остальные детали. ' +
    'due — только если срок явно упомянут («завтра», «в пятницу», «25 числа»), иначе null; ' +
    'дни недели считай аккуратно от сегодняшней даты и сегодняшнего дня недели. ' +
    'dueTime — только если время явно названо («в 15:00», «в три часа дня», «утром в 9») — 24-часовой формат; иначе null. ' +
    'priority: 4 — срочно, 3 — важно/высокий, 2 — средний, 1 — низкий, 0 — не указан. ' +
    'project — только если явно упомянут один из: ' + names + '. Иначе null.\n' +
    'Примеры: «завтра в 15:00 позвонить врачу, срочно» → {"kind":"task","status":"todo","title":"Позвонить врачу",' +
    '"note":"","due":"<завтрашняя дата>","dueTime":"15:00","priority":4,"url":null,"tags":[],"project":null}. ' +
    '«идея: сделать фотокнигу» → {"kind":"task","status":"idea","title":"Сделать фотокнигу","note":"","due":null,' +
    '"dueTime":null,"priority":0,"url":null,"tags":[],"project":null}.';
}

async function openaiChat(messages) {
  const r = await fetchT('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: messages })
  }, 45000);
  const j = await r.json();
  if (!j.choices || !j.choices[0]) throw new Error('openai error: ' + JSON.stringify(j).slice(0, 300));
  return JSON.parse(j.choices[0].message.content);
}

function fallbackParse(text) {
  const t = String(text || '').trim();
  const urlM = t.match(/https?:\/\/\S+/);
  const lines = t.split('\n');
  const isMaterial = !!urlM && (t.length - urlM[0].length) < 20;
  return {
    kind: isMaterial ? 'material' : 'task', status: 'todo',
    title: (lines[0] || 'Без названия').slice(0, 140),
    note: lines.slice(1).join('\n').trim(),
    due: null, priority: 0, url: urlM ? urlM[0] : null, tags: [], project: null
  };
}

async function parseText(text) {
  if (!OPENAI_KEY) return fallbackParse(text);
  try {
    return await openaiChat([
      { role: 'system', content: parserPrompt() },
      { role: 'user', content: text }
    ]);
  } catch (e) { console.error('parseText:', e.message); return fallbackParse(text); }
}

async function parseImage(buf, mime, caption) {
  if (!OPENAI_KEY) return fallbackParse(caption || 'Фото-заметка');
  try {
    return await openaiChat([
      { role: 'system', content: parserPrompt() },
      {
        role: 'user', content: [
          { type: 'text', text: 'Создай запись по этому изображению (скриншот, записка, документ, афиша и т.п.).' + (caption ? ' Подпись пользователя: «' + caption + '»' : '') },
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } }
        ]
      }
    ]);
  } catch (e) { console.error('parseImage:', e.message); return fallbackParse(caption || 'Фото-заметка'); }
}

async function transcribe(buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  fd.append('model', 'whisper-1');
  fd.append('language', 'ru');
  const r = await fetchT('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + OPENAI_KEY }, body: fd
  }, 60000);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('transcribe: ' + ((j.error && j.error.message) || r.status));
  return j.text || '';
}

function matchProject(name) {
  if (name) {
    const p = db.projects.find(function (x) { return x.name.toLowerCase() === String(name).toLowerCase(); });
    if (p) return p.id;
  }
  return db.projects[0] ? db.projects[0].id : '';
}

function addParsed(p, fileUrl) {
  const kind = p.kind === 'material' ? 'material' : 'task';
  const item = {
    id: uid(), kind: kind,
    title: String(p.title || 'Без названия').slice(0, 300),
    note: String(p.note || '').slice(0, 5000),
    url: fileUrl || String(p.url || '').slice(0, 2000),
    tags: Array.isArray(p.tags) ? p.tags.map(function (t) { return String(t).slice(0, 60); }).slice(0, 10) : [],
    created: Date.now()
  };
  if (fileUrl && p.url) item.note = (item.note ? item.note + '\n' : '') + p.url;
  if (kind === 'task') {
    item.projectId = matchProject(p.project);
    item.status = p.status === 'idea' ? 'idea' : 'todo';
    item.priority = [0, 1, 2, 3, 4].indexOf(p.priority) !== -1 ? p.priority : 0;
    item.due = /^\d{4}-\d{2}-\d{2}$/.test(p.due || '') ? p.due : '';
    item.dueTime = (item.due && /^\d{2}:\d{2}$/.test(p.dueTime || '')) ? p.dueTime : '';
  }
  db.items.unshift(item);
  saveDB();
  return item;
}

const PRIO_NAMES = { 1: 'низкий', 2: 'средний', 3: 'высокий', 4: 'срочно' };

function confirmText(item) {
  let out = item.kind === 'material'
    ? '📚 Материал сохранён в библиотеку:\n«' + item.title + '»'
    : (item.status === 'idea' ? '💡 Идея записана:\n«' + item.title + '»' : '✅ Задача добавлена:\n«' + item.title + '»');
  const bits = [];
  if (item.due) bits.push('срок: ' + item.due + (item.dueTime ? ' ' + item.dueTime : ''));
  if (item.priority) bits.push('приоритет: ' + PRIO_NAMES[item.priority]);
  if (bits.length) out += '\n' + bits.join(' · ');
  if (PUBLIC_URL) out += '\n\n' + PUBLIC_URL;
  return out;
}

/* ---------- панель управления (/menu) ---------- */

function aliveItems() {
  return db.items.filter(function (i) { return !i.deleted; });
}

function activeTasks() {
  return aliveItems().filter(function (i) { return i.kind === 'task' && (i.status === 'todo' || i.status === 'doing'); });
}

function byDuePrio(a, b) {
  const ad = (a.due || '9999') + ' ' + (a.dueTime || '99'), bd = (b.due || '9999') + ' ' + (b.dueTime || '99');
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (b.priority || 0) - (a.priority || 0);
}

function fmtDue(d) { return d ? d.slice(8, 10) + '.' + d.slice(5, 7) : ''; }

function taskLine(i, today) {
  const bits = [];
  if (i.due) bits.push((i.due < today ? '❗ ' : '') + fmtDue(i.due) + (i.dueTime ? ' ' + i.dueTime : ''));
  if (i.priority) bits.push(PRIO_NAMES[i.priority]);
  if (i.status === 'doing') bits.push('в работе');
  return '• ' + i.title + (bits.length ? ' (' + bits.join(', ') + ')' : '');
}

function capList(lines, n) {
  return lines.length <= n ? lines : lines.slice(0, n).concat(['…и ещё ' + (lines.length - n)]);
}

function listText() {
  const today = kyivToday();
  const act = activeTasks().sort(byDuePrio);
  if (!act.length) return 'Активных задач нет 🎉';
  return '📋 Активные задачи:\n' + capList(act.map(function (i) { return taskLine(i, today); }), 15).join('\n');
}

function todayText(withGreeting) {
  const today = kyivToday();
  const act = activeTasks();
  const dueToday = act.filter(function (i) { return i.due === today; }).sort(byDuePrio);
  const overdue = act.filter(function (i) { return i.due && i.due < today; }).sort(byDuePrio);
  const parts = [];
  if (withGreeting) parts.push('☀️ Доброе утро! ' + kyivDateHuman() + '.');
  const meetsToday = MEETINGS.filter(function (m) { return m.day === today; });
  if (meetsToday.length) parts.push('🗓 Встречи сегодня:\n' + capList(meetsToday.map(function (m) { return '• ' + (m.time ? m.time + ' — ' : '') + m.title; }), 10).join('\n'));
  if (dueToday.length) parts.push('📅 На сегодня:\n' + capList(dueToday.map(function (i) { return taskLine(i, today); }), 12).join('\n'));
  if (overdue.length) parts.push('❗ Просрочено:\n' + capList(overdue.map(function (i) { return taskLine(i, today); }), 12).join('\n'));
  if (!dueToday.length && !overdue.length) parts.push('Задач со сроком на сегодня нет 🎉' + (act.length ? '\nВсего активных: ' + act.length : ''));
  return parts.join('\n\n');
}

function ideasText() {
  const ideas = aliveItems().filter(function (i) { return i.kind === 'task' && i.status === 'idea'; });
  if (!ideas.length) return 'Идей пока нет 💡 Напишите или наговорите мысль — я запишу её в идеи.';
  return '💡 Идеи:\n' + capList(ideas.map(function (i) { return '• ' + i.title; }), 15).join('\n');
}

function libText() {
  const mats = aliveItems().filter(function (i) { return i.kind === 'material'; });
  if (!mats.length) return 'Библиотека пуста 📚 Пришлите ссылку на статью или видео — сохраню.';
  const out = mats.slice(0, 10).map(function (i) {
    const link = i.url && /^https?:/.test(i.url) ? '\n   ' + i.url : '';
    return '• ' + i.title + link;
  });
  return '📚 Библиотека' + (mats.length > 10 ? ' (последние 10 из ' + mats.length + ')' : '') + ':\n' + out.join('\n');
}

function statsText() {
  const today = kyivToday();
  const alive = aliveItems();
  const tasks = alive.filter(function (i) { return i.kind === 'task'; });
  function n(s) { return tasks.filter(function (i) { return i.status === s; }).length; }
  const act = activeTasks();
  const overdue = act.filter(function (i) { return i.due && i.due < today; }).length;
  const dueToday = act.filter(function (i) { return i.due === today; }).length;
  return '📊 Сводка:\n' +
    '• на сегодня: ' + dueToday + (overdue ? ' · просрочено: ' + overdue : '') + '\n' +
    '• в очереди: ' + n('todo') + ' · в работе: ' + n('doing') + '\n' +
    '• идей: ' + n('idea') + ' · сделано: ' + n('done') + '\n' +
    '• материалов в библиотеке: ' + (alive.length - tasks.length);
}

const BACK_KB = [[{ text: '‹ Меню', callback_data: 'menu' }]];

function viewMenu() {
  return {
    text: '🗂 Свод — панель управления. Что показать?',
    kb: [
      [{ text: '📅 Сегодня', callback_data: 'v:today' }, { text: '📋 Активные', callback_data: 'v:active' }],
      [{ text: '💡 Идеи', callback_data: 'v:ideas' }, { text: '📚 Библиотека', callback_data: 'v:lib' }],
      [{ text: '📁 Проекты', callback_data: 'v:proj' }, { text: '📊 Сводка', callback_data: 'v:stats' }]
    ]
  };
}

function viewProjects() {
  const act = activeTasks();
  const rows = db.projects.map(function (p) {
    const n = act.filter(function (i) { return i.projectId === p.id; }).length;
    return [{ text: '📁 ' + p.name + (n ? ' — ' + n : ''), callback_data: 'p:' + p.id }];
  });
  rows.push(BACK_KB[0]);
  return { text: '📁 Проекты (и число активных задач):', kb: rows };
}

function projectText(id) {
  const p = db.projects.find(function (x) { return x.id === id; });
  if (!p) return 'Проект не найден.';
  const today = kyivToday();
  const tasks = activeTasks().filter(function (i) { return i.projectId === id; }).sort(byDuePrio);
  if (!tasks.length) return '📁 ' + p.name + ': активных задач нет 🎉';
  return '📁 ' + p.name + ':\n' + capList(tasks.map(function (i) { return taskLine(i, today); }), 15).join('\n');
}

function viewFor(data) {
  if (data === 'menu') return viewMenu();
  if (data === 'v:today') return { text: todayText(false), kb: BACK_KB };
  if (data === 'v:active') return { text: listText(), kb: BACK_KB };
  if (data === 'v:ideas') return { text: ideasText(), kb: BACK_KB };
  if (data === 'v:lib') return { text: libText(), kb: BACK_KB };
  if (data === 'v:proj') return viewProjects();
  if (data === 'v:stats') return { text: statsText(), kb: BACK_KB };
  if (data.slice(0, 2) === 'p:') {
    return { text: projectText(data.slice(2)), kb: [[{ text: '‹ Проекты', callback_data: 'v:proj' }, { text: '‹ Меню', callback_data: 'menu' }]] };
  }
  return null;
}

/* ---------- утренняя сводка ---------- */

function kyivHour() {
  return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }), 10);
}

function kyivDateHuman() {
  const s = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kyiv', weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function morningDigest() {
  if (!TG_TOKEN || !TG_CHAT) return;
  const today = kyivToday();
  const h = kyivHour();
  if (h < DIGEST_HOUR || h > DIGEST_HOUR + 2 || db.digestDate === today) return;
  await send(TG_CHAT, todayText(true));
  db.digestDate = today;
  saveDB();
}

function kyivHM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false });
}

/* напоминание в Telegram, когда наступает время задачи (due + dueTime).
   Шлём все ненапомненные с временем <= сейчас — перезапуск/деплой ничего не съест. */
async function timeReminders() {
  if (!TG_TOKEN || !TG_CHAT) return;
  const today = kyivToday(), hm = kyivHM();
  let changed = false;
  const dueNow = [];
  activeTasks().forEach(function (i) {
    if (!i.due || !i.dueTime || i.reminded) return;
    if (i.due > today || (i.due === today && i.dueTime > hm)) return; /* ещё не время */
    /* задача заведена уже после своего времени — напоминание не нужно */
    const cd = new Date(i.created || 0);
    const createdKyiv = cd.toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' }) + ' ' +
      cd.toLocaleTimeString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false });
    if (createdKyiv > i.due + ' ' + i.dueTime) { i.reminded = Date.now(); changed = true; return; }
    dueNow.push(i);
  });
  for (let k = 0; k < dueNow.length; k++) {
    const i = dueNow[k];
    await send(TG_CHAT, '⏰ ' + i.dueTime + ' — напоминание:\n«' + i.title + '»' + (i.due < today ? '\n(было запланировано на ' + fmtDue(i.due) + ')' : ''));
    i.reminded = Date.now();
    changed = true;
  }
  if (changed) saveDB();
}

/* раз в сутки — файл базы документом в Telegram: копия данных вне Render */
async function dailyBackup() {
  if (!TG_TOKEN || !TG_CHAT || !fs.existsSync(DB_FILE)) return;
  const today = kyivToday();
  if (db.backupDate === today || kyivHour() < DIGEST_HOUR) return;
  const r = await tgSendDocument(TG_CHAT, DB_FILE, '💾 Резервная копия «Свода» за ' + today + '. Хранится в этом чате — при необходимости её можно импортировать через сайт.');
  if (r && r.ok) {
    db.backupDate = today;
    saveDB();
  } else {
    console.error('backup send:', JSON.stringify(r || {}).slice(0, 200));
  }
}

const HELP = 'Я записываю всё в ваш «Свод».\n\n' +
  '— Напишите текст («завтра позвонить в лабораторию, срочно») — создам задачу с датой и приоритетом.\n' +
  '— Отправьте голосовое — распознаю и создам задачу.\n' +
  '— Пришлите фото (записку, скриншот, афишу) — пойму, что на нём, и создам запись.\n' +
  '— Ссылка на статью или видео — сохраню в библиотеку.\n\n' +
  'Каждое утро в ' + DIGEST_HOUR + ':00 пришлю план на день. ' +
  'Если у задачи указано время («завтра в 15:00 позвонить врачу») — напомню в назначенный час.\n\n' +
  'Команды:\n/menu — панель управления\n/list — активные задачи\n/help — эта подсказка';

async function handleCallback(cb) {
  tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(function () {});
  const chat = cb.message && cb.message.chat;
  if (!chat) return;
  const chatId = String(chat.id);
  if (TG_CHAT && chatId !== TG_CHAT) return;
  const view = viewFor(String(cb.data || ''));
  if (!view) return;
  await editKb(chatId, cb.message.message_id, view.text, view.kb);
}

async function handleUpdate(update) {
  if (update.callback_query) { await handleCallback(update.callback_query); return; }
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  if (TG_CHAT && chatId !== TG_CHAT) {
    await send(chatId, 'Это личный бот. Ваш chat id: ' + chatId);
    return;
  }
  const text = (msg.text || '').trim();

  if (text === '/start' || text === '/help') { await send(chatId, HELP); return; }
  if (text === '/menu' || text.toLowerCase() === 'меню') { const m = viewMenu(); await sendKb(chatId, m.text, m.kb); return; }
  if (text === '/list' || text.toLowerCase() === 'задачи') { await send(chatId, listText()); return; }

  /* голосовые и аудио */
  const voice = msg.voice || msg.audio || msg.video_note;
  if (voice) {
    if (!OPENAI_KEY) { await send(chatId, 'Для голосовых нужен OPENAI_API_KEY в настройках Render.'); return; }
    let f = null;
    try {
      f = await tgFile(voice.file_id);
    } catch (e) {
      console.error('voice download:', e);
      await send(chatId, 'Не удалось скачать голосовое из Telegram. Попробуйте ещё раз.');
      return;
    }
    try {
      const name = 'voice' + (path.extname(f.path) || '.ogg');
      const recognized = await transcribe(f.buf, name);
      if (!recognized) throw new Error('пустая расшифровка');
      const item = addParsed(await parseText(recognized));
      await send(chatId, '🎙 Распознано: «' + recognized + '»\n\n' + confirmText(item));
    } catch (e) {
      console.error('voice:', e);
      /* распознать не вышло — сохраняем сам файл, чтобы содержимое не потерялось */
      try {
        const fname = uid() + (path.extname(f.path) || '.ogg');
        fs.writeFileSync(path.join(FILES_DIR, fname), f.buf);
        const item = addParsed({
          kind: 'task', status: 'todo', title: '🎙 Голосовое (не распозналось)',
          note: 'Распознавание не сработало, но аудио сохранено — откройте задачу и послушайте по ссылке.',
          due: null, priority: 0, url: null, tags: [], project: null
        }, '/files/' + fname);
        await send(chatId, 'Распознать не получилось, но аудио я сохранил задачей:\n«' + item.title + '»\nПослушать можно из карточки задачи.');
      } catch (e2) {
        console.error('voice save:', e2);
        await send(chatId, 'Не получилось обработать голосовое. Попробуйте ещё раз.');
      }
    }
    return;
  }

  /* фото и картинки-документы */
  const photo = msg.photo ? msg.photo[msg.photo.length - 1]
    : (msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (photo) {
    try {
      const f = await tgFile(photo.file_id);
      const ext = path.extname(f.path) || '.jpg';
      const fname = uid() + ext;
      fs.writeFileSync(path.join(FILES_DIR, fname), f.buf);
      const parsed = await parseImage(f.buf, mimeFromExt(ext), msg.caption || '');
      const item = addParsed(parsed, '/files/' + fname);
      await send(chatId, '🖼 Фото сохранено.\n\n' + confirmText(item));
    } catch (e) {
      console.error('photo:', e);
      await send(chatId, 'Не получилось обработать фото. Попробуйте ещё раз.');
    }
    return;
  }

  /* обычный текст */
  if (text) {
    try {
      const item = addParsed(await parseText(text));
      await send(chatId, confirmText(item));
    } catch (e) {
      console.error('text:', e);
      await send(chatId, 'Не получилось сохранить. Попробуйте ещё раз.');
    }
    return;
  }

  await send(chatId, 'Пришлите текст, голосовое или фото — я создам задачу.');
}

/* подтверждаем приём ПОСЛЕ обработки: если процесс перезапустился на середине
   (деплой), Telegram доставит сообщение повторно и оно не потеряется.
   update_id защищает от двойной обработки при повторах. */
const tgDone = [];            /* последние успешно обработанные update_id */
const tgInFlight = new Set(); /* обрабатываются прямо сейчас */
app.post('/tg-webhook', async function (req, res) {
  if (TG_SECRET && req.get('x-telegram-bot-api-secret-token') !== TG_SECRET) return res.sendStatus(401);
  const upId = req.body && req.body.update_id;
  if (typeof upId === 'number') {
    if (tgDone.indexOf(upId) !== -1 || tgInFlight.has(upId)) return res.sendStatus(200);
    tgInFlight.add(upId);
  }
  try {
    await handleUpdate(req.body);
    if (typeof upId === 'number') { tgDone.push(upId); if (tgDone.length > 200) tgDone.shift(); }
    res.sendStatus(200);
  } catch (e) {
    console.error('tg update:', e);
    res.sendStatus(500); /* Telegram пришлёт повтор */
  } finally {
    if (typeof upId === 'number') tgInFlight.delete(upId);
  }
});

async function initTelegram() {
  if (!TG_TOKEN) { console.log('Telegram: TELEGRAM_BOT_TOKEN не задан — бот выключен'); return; }
  if (!PUBLIC_URL) { console.log('Telegram: нет RENDER_EXTERNAL_URL — webhook не установлен'); return; }
  try {
    const r = await tg('setWebhook', { url: PUBLIC_URL + '/tg-webhook', secret_token: TG_SECRET, allowed_updates: ['message', 'callback_query'] });
    console.log('Telegram webhook:', JSON.stringify(r));
    await tg('setMyCommands', {
      commands: [
        { command: 'menu', description: 'Панель управления' },
        { command: 'list', description: 'Активные задачи' },
        { command: 'help', description: 'Как пользоваться' }
      ]
    });
  } catch (e) { console.error('Telegram init:', e); }
}

const server = app.listen(PORT, function () {
  console.log('🗂 Свод запущен на порту ' + PORT + (APP_PASSWORD ? ' (вход по паролю)' : ' (ВНИМАНИЕ: пароль не задан)'));
  initTelegram();
  purgeTrash();
  syncCalendar();
  setInterval(function () {
    morningDigest().catch(function (e) { console.error('digest:', e); });
    timeReminders().catch(function (e) { console.error('reminders:', e); });
    if (new Date().getMinutes() % 10 === 5) dailyBackup().catch(function (e) { console.error('backup:', e); });
    if (new Date().getMinutes() === 0) purgeTrash();
    if (new Date().getMinutes() % 30 === 7) syncCalendar();
  }, 60 * 1000);
});

/* Render при деплое шлёт SIGTERM: дообрабатываем текущие запросы и выходим */
process.on('SIGTERM', function () {
  console.log('SIGTERM — корректная остановка');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 8000).unref();
});
