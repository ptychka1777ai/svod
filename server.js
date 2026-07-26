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

fs.mkdirSync(FILES_DIR, { recursive: true });

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

function loadDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (d && Array.isArray(d.items) && Array.isArray(d.projects)) return d;
  } catch (e) { /* первый запуск */ }
  return defaultDB();
}

function saveDB() {
  db.rev = (db.rev || 0) + 1;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
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
  if (item.kind === 'task') {
    item.projectId = String(src.projectId || '');
    item.status = STATUS_IDS.indexOf(src.status) !== -1 ? src.status : 'todo';
    item.priority = [0, 1, 2, 3, 4].indexOf(src.priority) !== -1 ? src.priority : 0;
    item.due = /^\d{4}-\d{2}-\d{2}$/.test(src.due || '') ? src.due : '';
  }
  return item;
}

/* ---------------- веб-сервер ---------------- */

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', function (req, res) { res.type('text').send('ok v2.1'); });

function auth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const t = req.get('x-auth') || req.query.t || '';
  if (t === APP_PASSWORD) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.use(express.static(path.join(__dirname, 'public')));

/* фото, присланные в Telegram */
app.get('/files/:name', auth, function (req, res) {
  const p = path.join(FILES_DIR, path.basename(req.params.name));
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

/* ---------------- API ---------------- */

app.get('/api/state', auth, function (req, res) {
  res.json({ rev: db.rev || 0, projects: db.projects, items: db.items });
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
  if (STATUS_IDS.indexOf(b.status) !== -1) it.status = b.status;
  if ([0, 1, 2, 3, 4].indexOf(b.priority) !== -1) it.priority = b.priority;
  if (typeof b.due === 'string' && (b.due === '' || /^\d{4}-\d{2}-\d{2}$/.test(b.due))) it.due = b.due;
  if (typeof b.projectId === 'string') it.projectId = b.projectId;
  saveDB();
  res.json({ item: it, rev: db.rev });
});

app.delete('/api/items/:id', auth, function (req, res) {
  const before = db.items.length;
  db.items = db.items.filter(function (x) { return x.id !== req.params.id; });
  if (db.items.length === before) return res.status(404).json({ error: 'not found' });
  saveDB();
  res.json({ ok: true, rev: db.rev });
});

/* перестановка карточек на доске (drag&drop) */
app.post('/api/reorder', auth, function (req, res) {
  const b = req.body || {};
  const it = db.items.find(function (x) { return x.id === b.id; });
  if (!it || !Array.isArray(b.orderedIds)) return res.status(400).json({ error: 'bad request' });
  if (STATUS_IDS.indexOf(b.status) !== -1) it.status = b.status;
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

/* полная замена данных (кнопка «Импорт») */
app.post('/api/import', auth, function (req, res) {
  const b = req.body || {};
  if (!Array.isArray(b.items) || !Array.isArray(b.projects)) return res.status(400).json({ error: 'bad file' });
  db = {
    rev: (db.rev || 0),
    projects: b.projects.map(function (p) {
      return { id: String(p.id || uid()), name: String(p.name || '').slice(0, 60), color: String(p.color || '#0e6e73').slice(0, 20) };
    }),
    items: b.items.map(function (i) { return cleanItem(i, false); })
  };
  saveDB();
  res.json({ ok: true, rev: db.rev });
});

/* ---------------- Telegram-бот ---------------- */

function tg(method, payload) {
  return fetch('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); });
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
  const r = await fetch('https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fp);
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

function parserPrompt() {
  const names = db.projects.map(function (p) { return p.name; }).join(', ');
  return 'Ты — парсер входящих сообщений для личного таск-менеджера. Сегодня ' + kyivToday() +
    ' (часовой пояс Europe/Kyiv). Верни ТОЛЬКО JSON:\n' +
    '{"kind":"task"|"material","status":"todo"|"idea","title":"...","note":"...","due":"YYYY-MM-DD"|null,' +
    '"priority":0|1|2|3|4,"url":"..."|null,"tags":["..."],"project":"..."|null}\n' +
    'Правила: kind="material" — если это ссылка/статья/видео/книга для сохранения в библиотеку, а не действие. ' +
    'status="idea" — если это идея или мысль, а не конкретное действие. ' +
    'title — краткая формулировка до 100 символов, с большой буквы. note — остальные детали. ' +
    'due — только если срок явно упомянут («завтра», «в пятницу», «25 числа»), иначе null. ' +
    'priority: 4 — срочно, 3 — важно/высокий, 2 — средний, 1 — низкий, 0 — не указан. ' +
    'project — только если явно упомянут один из: ' + names + '. Иначе null.';
}

async function openaiChat(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: messages })
  });
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
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + OPENAI_KEY }, body: fd
  });
  const j = await r.json();
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
  if (item.due) bits.push('срок: ' + item.due);
  if (item.priority) bits.push('приоритет: ' + PRIO_NAMES[item.priority]);
  if (bits.length) out += '\n' + bits.join(' · ');
  if (PUBLIC_URL) out += '\n\n' + PUBLIC_URL;
  return out;
}

/* ---------- панель управления (/menu) ---------- */

function activeTasks() {
  return db.items.filter(function (i) { return i.kind === 'task' && (i.status === 'todo' || i.status === 'doing'); });
}

function byDuePrio(a, b) {
  const ad = a.due || '9999', bd = b.due || '9999';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (b.priority || 0) - (a.priority || 0);
}

function fmtDue(d) { return d ? d.slice(8, 10) + '.' + d.slice(5, 7) : ''; }

function taskLine(i, today) {
  const bits = [];
  if (i.due) bits.push((i.due < today ? '❗ ' : '') + fmtDue(i.due));
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
  if (dueToday.length) parts.push('📅 На сегодня:\n' + capList(dueToday.map(function (i) { return taskLine(i, today); }), 12).join('\n'));
  if (overdue.length) parts.push('❗ Просрочено:\n' + capList(overdue.map(function (i) { return taskLine(i, today); }), 12).join('\n'));
  if (!dueToday.length && !overdue.length) parts.push('Задач со сроком на сегодня нет 🎉' + (act.length ? '\nВсего активных: ' + act.length : ''));
  return parts.join('\n\n');
}

function ideasText() {
  const ideas = db.items.filter(function (i) { return i.kind === 'task' && i.status === 'idea'; });
  if (!ideas.length) return 'Идей пока нет 💡 Напишите или наговорите мысль — я запишу её в идеи.';
  return '💡 Идеи:\n' + capList(ideas.map(function (i) { return '• ' + i.title; }), 15).join('\n');
}

function libText() {
  const mats = db.items.filter(function (i) { return i.kind === 'material'; });
  if (!mats.length) return 'Библиотека пуста 📚 Пришлите ссылку на статью или видео — сохраню.';
  const out = mats.slice(0, 10).map(function (i) {
    const link = i.url && /^https?:/.test(i.url) ? '\n   ' + i.url : '';
    return '• ' + i.title + link;
  });
  return '📚 Библиотека' + (mats.length > 10 ? ' (последние 10 из ' + mats.length + ')' : '') + ':\n' + out.join('\n');
}

function statsText() {
  const today = kyivToday();
  const tasks = db.items.filter(function (i) { return i.kind === 'task'; });
  function n(s) { return tasks.filter(function (i) { return i.status === s; }).length; }
  const act = activeTasks();
  const overdue = act.filter(function (i) { return i.due && i.due < today; }).length;
  const dueToday = act.filter(function (i) { return i.due === today; }).length;
  return '📊 Сводка:\n' +
    '• на сегодня: ' + dueToday + (overdue ? ' · просрочено: ' + overdue : '') + '\n' +
    '• в очереди: ' + n('todo') + ' · в работе: ' + n('doing') + '\n' +
    '• идей: ' + n('idea') + ' · сделано: ' + n('done') + '\n' +
    '• материалов в библиотеке: ' + (db.items.length - tasks.length);
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

const HELP = 'Я записываю всё в ваш «Свод».\n\n' +
  '— Напишите текст («завтра позвонить в лабораторию, срочно») — создам задачу с датой и приоритетом.\n' +
  '— Отправьте голосовое — распознаю и создам задачу.\n' +
  '— Пришлите фото (записку, скриншот, афишу) — пойму, что на нём, и создам запись.\n' +
  '— Ссылка на статью или видео — сохраню в библиотеку.\n\n' +
  'Каждое утро в ' + DIGEST_HOUR + ':00 пришлю план на день.\n\n' +
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
    try {
      const f = await tgFile(voice.file_id);
      const name = 'voice' + (path.extname(f.path) || '.ogg');
      const recognized = await transcribe(f.buf, name);
      if (!recognized) { await send(chatId, 'Не удалось распознать голосовое, попробуйте ещё раз.'); return; }
      const item = addParsed(await parseText(recognized));
      await send(chatId, '🎙 Распознано: «' + recognized + '»\n\n' + confirmText(item));
    } catch (e) {
      console.error('voice:', e);
      await send(chatId, 'Не получилось обработать голосовое. Попробуйте ещё раз.');
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

app.post('/tg-webhook', function (req, res) {
  if (TG_SECRET && req.get('x-telegram-bot-api-secret-token') !== TG_SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  handleUpdate(req.body).catch(function (e) { console.error('tg update:', e); });
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

app.listen(PORT, function () {
  console.log('🗂 Свод запущен на порту ' + PORT + (APP_PASSWORD ? ' (вход по паролю)' : ' (ВНИМАНИЕ: пароль не задан)'));
  initTelegram();
  setInterval(function () { morningDigest().catch(function (e) { console.error('digest:', e); }); }, 60 * 1000);
});
