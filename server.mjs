/**
 * Runway Studio - backend cho su dung noi bo.
 *
 * Ba nguyen tac thiet ke:
 *
 *  1. API key chi ton tai o server. Trinh duyet khong bao gio nhan key.
 *
 *  2. Hang doi nam o SERVER, khong nam o browser. Tier cua Runway cho phep
 *     maxConcurrentGenerations = 1 voi moi model video - tuc ca to chuc chi
 *     chay duoc 1 video cung luc. Neu de browser tu goi thi nhieu nguoi bam
 *     cung luc se dinh 429. Server giu queue chung, dispatch khi co slot.
 *
 *  3. Server tu poll task. Nguoi dung dong tab thi job van chay tiep va
 *     ket qua van vao lich su.
 */
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // mo ra LAN cho noi bo
const API_BASE = 'https://api.dev.runwayml.com/v1';
const API_VERSION = '2024-11-06';

const DATA_DIR = join(__dirname, 'data');
const OUT_DIR = join(__dirname, 'outputs');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const USERS_FILE = join(DATA_DIR, 'users.json');
const SECRET_FILE = join(DATA_DIR, 'secret.key');
for (const d of [DATA_DIR, OUT_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const readJson = (f, fallback) => {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// API key: env -> .env -> registry (Windows, khong can restart terminal)
// ---------------------------------------------------------------------------
let API_KEY = null;

function loadKeyFromDotEnv() {
  const p = join(__dirname, '.env');
  if (!existsSync(p)) return null;
  const line = readFileSync(p, 'utf8').split(/\r?\n/).find((l) => /^\s*RUNWAY_API_KEY\s*=/.test(l));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null;
}

function loadKeyFromRegistry() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', 'RUNWAY_API_KEY'], (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/RUNWAY_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/);
      resolve(m ? m[1] : null);
    });
  });
}

// ---------------------------------------------------------------------------
// Nguoi dung + phien dang nhap
// ---------------------------------------------------------------------------
const SECRET = (() => {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(SECRET_FILE, s, 'utf8');
  return s;
})();

function ensureUsers() {
  let users = readJson(USERS_FILE, null);
  if (!Array.isArray(users) || !users.length) {
    users = [{ name: 'admin', code: randomBytes(4).toString('hex'), role: 'admin' }];
    writeJson(USERS_FILE, users);
  }
  return users;
}
let USERS = ensureUsers();
const reloadUsers = () => { USERS = ensureUsers(); return USERS; };

const sign = (v) => createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);

function makeToken(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, t: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expect = sign(payload);
  if (mac.length !== expect.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const { n, t } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - t > 30 * 24 * 3600 * 1000) return null; // het han 30 ngay
    return USERS.find((u) => u.name === n) || null;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  return readToken(parseCookies(req).rs_session);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Chua dang nhap', code: 'UNAUTHORIZED' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Can quyen admin' });
  next();
}

// ---------------------------------------------------------------------------
// Goi Runway
// ---------------------------------------------------------------------------
async function runway(path, { method = 'GET', body } = {}) {
  if (!API_KEY) {
    const e = new Error('Server chua cau hinh RUNWAY_API_KEY'); e.status = 500; throw e;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-Runway-Version': API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = new Error(data?.error || data?.message || `Runway API ${res.status}`);
    e.status = res.status; e.details = data; throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Lich su
// ---------------------------------------------------------------------------
const readHistory = () => readJson(HISTORY_FILE, []);
const writeHistory = (items) => writeJson(HISTORY_FILE, items.slice(0, 1000));

function upsertHistory(entry) {
  const items = readHistory();
  const i = items.findIndex((x) => x.jobId === entry.jobId);
  if (i >= 0) items[i] = { ...items[i], ...entry };
  else items.unshift(entry);
  writeHistory(items);
}

// ---------------------------------------------------------------------------
// Han muc tier (lay tu /organization, refresh dinh ky)
// ---------------------------------------------------------------------------
let TIER = { models: {}, fetchedAt: 0 };

async function refreshTier() {
  try {
    const org = await runway('/organization');
    TIER = { models: org.tier?.models || {}, fetchedAt: Date.now(), creditBalance: org.creditBalance };
    return org;
  } catch { return null; }
}

const limitsFor = (model) => TIER.models?.[model] || { maxConcurrentGenerations: 1, maxDailyGenerations: 50 };

// ---------------------------------------------------------------------------
// Hang doi
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} jobId -> job */
const JOBS = new Map();
const QUEUE = []; // jobId cho dispatch, FIFO
let nextJobSeq = 1;

const runningCountFor = (model) =>
  [...JOBS.values()].filter((j) => j.model === model && (j.state === 'RUNNING' || j.state === 'SUBMITTED')).length;

function jobView(j) {
  return {
    jobId: j.jobId, taskId: j.taskId, state: j.state, path: j.path, model: j.model,
    title: j.title, promptText: j.promptText, user: j.user, queuePosition: j.queuePosition ?? null,
    progress: j.progress ?? null, output: j.output ?? null, error: j.error ?? null,
    estimatedCost: j.estimatedCost ?? null, cost: j.cost ?? null,
    createdAt: j.createdAt, startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null,
    // Can cho nut "Dung lai" - thieu cai nay thi job cua phien hien tai
    // khong nap lai duoc tham so, trong khi job trong lich su thi duoc
    payload: j.payload ?? null,
  };
}

// --- SSE: day trang thai realtime cho moi client dang mo ---
const CLIENTS = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of CLIENTS) {
    try { res.write(payload); } catch { CLIENTS.delete(res); }
  }
}

function updateQueuePositions() {
  QUEUE.forEach((jobId, i) => {
    const j = JOBS.get(jobId);
    if (j) j.queuePosition = i + 1;
  });
}

function pushJobUpdate(j) {
  broadcast('job', jobView(j));
  upsertHistory({
    jobId: j.jobId, taskId: j.taskId, path: j.path, model: j.model, title: j.title,
    promptText: j.promptText, user: j.user, state: j.state, output: j.output ?? null,
    error: j.error ?? null, cost: j.cost ?? null, estimatedCost: j.estimatedCost ?? null,
    createdAt: j.createdAt, finishedAt: j.finishedAt ?? null, payload: j.payload,
  });
}

function enqueue({ path, payload, title, user }) {
  const job = {
    jobId: `j${nextJobSeq++}_${randomBytes(3).toString('hex')}`,
    taskId: null,
    path,
    payload,
    model: payload?.model || '(default)',
    title,
    promptText: payload?.promptText || payload?.text || null,
    user,
    state: 'QUEUED',
    createdAt: new Date().toISOString(),
  };
  JOBS.set(job.jobId, job);
  QUEUE.push(job.jobId);
  updateQueuePositions();
  pushJobUpdate(job);
  setImmediate(dispatch);
  return job;
}

/** Day job tu queue sang Runway khi con slot cho model do. */
async function dispatch() {
  for (let i = 0; i < QUEUE.length; i++) {
    const job = JOBS.get(QUEUE[i]);
    if (!job || job.state !== 'QUEUED') { QUEUE.splice(i, 1); i--; continue; }

    const limit = limitsFor(job.model).maxConcurrentGenerations ?? 1;
    if (runningCountFor(job.model) >= limit) continue; // het slot, thu job khac

    QUEUE.splice(i, 1); i--;
    job.state = 'SUBMITTED';
    job.startedAt = new Date().toISOString();
    job.queuePosition = null;
    updateQueuePositions();
    pushJobUpdate(job);

    try {
      const apiPath = job.path.replace(/^\/v1/, '');
      const result = await runway(apiPath, { method: 'POST', body: job.payload });
      job.taskId = result.id;
      job.estimatedCost = result.estimatedCost ?? null;
      job.state = 'RUNNING';
      pushJobUpdate(job);
      pollTask(job);
    } catch (e) {
      // 429 = het slot that su -> tra ve queue thay vi bao loi cho nguoi dung
      if (e.status === 429) {
        job.state = 'QUEUED';
        job.startedAt = null;
        QUEUE.unshift(job.jobId);
        updateQueuePositions();
        pushJobUpdate(job);
        setTimeout(dispatch, 15000);
      } else {
        job.state = 'FAILED';
        job.error = e.message + (e.details ? ` - ${JSON.stringify(e.details).slice(0, 300)}` : '');
        job.finishedAt = new Date().toISOString();
        pushJobUpdate(job);
        setImmediate(dispatch);
      }
    }
  }
}

/** Server tu poll task cho den khi xong. Khong phu thuoc browser. */
async function pollTask(job) {
  const started = Date.now();
  const TIMEOUT = 30 * 60 * 1000;

  while (Date.now() - started < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 3000));
    if (job.state === 'CANCELLED') return;

    let task;
    try {
      task = await runway(`/tasks/${encodeURIComponent(job.taskId)}`);
    } catch (e) {
      if (e.status === 404) { job.state = 'FAILED'; job.error = 'Task khong ton tai'; break; }
      continue; // loi mang tam thoi -> thu lai
    }

    if (task.status === 'RUNNING' || task.status === 'PENDING' || task.status === 'THROTTLED') {
      const p = task.progress ?? null;
      if (p !== job.progress) { job.progress = p; broadcast('job', jobView(job)); }
      continue;
    }

    if (task.status === 'SUCCEEDED') {
      job.state = 'SUCCEEDED';
      job.output = task.output || [];
      job.cost = task.cost ?? null;
    } else if (task.status === 'FAILED') {
      job.state = 'FAILED';
      job.error = task.failure || task.failureCode || 'Task that bai';
      job.cost = task.cost ?? null;
    } else if (task.status === 'CANCELLED') {
      job.state = 'CANCELLED';
    }
    break;
  }

  if (job.state === 'RUNNING') { job.state = 'FAILED'; job.error = 'Qua thoi gian cho (30 phut)'; }
  job.finishedAt = new Date().toISOString();
  job.progress = null;
  pushJobUpdate(job);
  refreshTier();
  setImmediate(dispatch);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) =>
  res.status(e.status || 500).json({ error: e.message, details: e.details ?? null })
);

// --- Auth ---
app.post('/api/login', wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  reloadUsers();
  const user = USERS.find((u) => u.code === code);
  if (!user) return res.status(401).json({ error: 'Ma truy cap khong dung' });

  res.setHeader(
    'Set-Cookie',
    `rs_session=${makeToken(user.name)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`
  );
  res.json({ name: user.name, role: user.role || 'member' });
}));

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'rs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Chua dang nhap' });
  res.json({ name: u.name, role: u.role || 'member', hasKey: !!API_KEY });
});

// Tat ca /api/* con lai deu can dang nhap
app.use('/api', (req, res, next) => {
  if (['/login', '/logout', '/me'].includes(req.path)) return next();
  requireAuth(req, res, next);
});

// --- Trang thai / han muc ---
app.get('/api/organization', wrap(async (_req, res) => {
  const org = await refreshTier();
  res.json(org ?? { error: 'Khong lay duoc thong tin tai khoan' });
}));

// --- Queue ---
app.get('/api/jobs', wrap(async (_req, res) => {
  res.json([...JOBS.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(jobView));
}));

app.post('/api/generate', wrap(async (req, res) => {
  const { path, payload, title } = req.body || {};
  if (typeof path !== 'string' || !path.startsWith('/v1/')) {
    return res.status(400).json({ error: 'Thieu hoac sai `path`' });
  }
  const job = enqueue({ path, payload, title: title || path, user: req.user.name });
  res.json(jobView(job));
}));

app.delete('/api/jobs/:jobId', wrap(async (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Khong tim thay job' });
  if (job.user !== req.user.name && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Chi nguoi tao hoac admin moi huy duoc' });
  }
  if (job.taskId && (job.state === 'RUNNING' || job.state === 'SUBMITTED')) {
    try { await runway(`/tasks/${encodeURIComponent(job.taskId)}`, { method: 'DELETE' }); } catch { /* da xong */ }
  }
  job.state = 'CANCELLED';
  job.finishedAt = new Date().toISOString();
  const qi = QUEUE.indexOf(job.jobId);
  if (qi >= 0) QUEUE.splice(qi, 1);
  updateQueuePositions();
  pushJobUpdate(job);
  setImmediate(dispatch);
  res.json({ ok: true });
}));

// --- SSE ---
app.get('/api/stream', (req, res) => {
  if (!currentUser(req)) return res.status(401).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  CLIENTS.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); CLIENTS.delete(res); });
});

// --- Upload (client gui raw bytes, ten file o header) ---
app.post('/api/upload', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  // Client ma hoa ten file (co the chua dau tieng Viet) de header hop le
  const rawName = req.get('X-Filename') || 'upload.bin';
  let filename;
  try { filename = decodeURIComponent(rawName); } catch { filename = rawName; }
  const contentType = req.get('X-Content-Type') || 'application/octet-stream';
  if (!req.body?.length) return res.status(400).json({ error: 'Body rong' });

  const init = await runway('/uploads', { method: 'POST', body: { filename, type: contentType } });
  const form = new FormData();
  for (const [k, v] of Object.entries(init.fields || {})) form.append(k, v);
  form.append('file', new Blob([req.body], { type: contentType }), filename);

  const up = await fetch(init.uploadUrl, { method: 'POST', body: form });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    return res.status(502).json({ error: `Upload that bai (${up.status})`, details: t.slice(0, 400) });
  }
  res.json({ uri: init.runwayUri, filename });
}));

// --- Lich su ---
app.get('/api/history', wrap(async (req, res) => {
  const all = readHistory();
  res.json(req.query.mine === '1' ? all.filter((x) => x.user === req.user.name) : all);
}));

app.delete('/api/history/:jobId', wrap(async (req, res) => {
  const items = readHistory();
  const item = items.find((x) => x.jobId === req.params.jobId);
  if (item && item.user !== req.user.name && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Khong co quyen xoa muc nay' });
  }
  writeHistory(items.filter((x) => x.jobId !== req.params.jobId));
  res.json({ ok: true });
}));

// --- Luu output ve may chu (link Runway het han sau ~24-48h) ---
app.post('/api/save', wrap(async (req, res) => {
  const { url, jobId, index = 0 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Thieu `url`' });
  const r = await fetch(url);
  if (!r.ok) return res.status(502).json({ error: `Tai that bai (${r.status})` });

  let ext = extname(new URL(url).pathname);
  if (!ext) {
    const ct = r.headers.get('content-type') || '';
    ext = ct.includes('mp4') ? '.mp4' : ct.includes('png') ? '.png' : ct.includes('jpeg') ? '.jpg'
      : ct.includes('webp') ? '.webp' : ct.includes('mpeg') ? '.mp3' : ct.includes('wav') ? '.wav' : '.bin';
  }
  const name = `${String(jobId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '')}_${index}${ext}`;
  await pipeline(Readable.fromWeb(r.body), createWriteStream(join(OUT_DIR, name)));
  res.json({ ok: true, file: name, localUrl: `/outputs/${name}` });
}));

// --- Quan tri nguoi dung ---
app.get('/api/users', requireAdmin, wrap(async (_req, res) => {
  res.json(reloadUsers().map((u) => ({ name: u.name, role: u.role || 'member', code: u.code })));
}));

app.post('/api/users', requireAdmin, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Thieu ten' });
  const users = reloadUsers();
  if (users.some((u) => u.name === name)) return res.status(409).json({ error: 'Ten da ton tai' });
  const user = { name, code: randomBytes(4).toString('hex'), role: req.body?.role === 'admin' ? 'admin' : 'member' };
  users.push(user);
  writeJson(USERS_FILE, users);
  reloadUsers();
  res.json(user);
}));

app.delete('/api/users/:name', requireAdmin, wrap(async (req, res) => {
  const users = reloadUsers();
  if (users.length <= 1) return res.status(400).json({ error: 'Phai con it nhat 1 tai khoan' });
  writeJson(USERS_FILE, users.filter((u) => u.name !== req.params.name));
  reloadUsers();
  res.json({ ok: true });
}));

// --- Static (dat sau /api de khong che route) ---
const DIST = join(__dirname, 'public', 'dist');
const CATALOG_FILE = join(__dirname, 'public', 'catalog.json');

// catalog.json nam ngoai dist vi duoc sinh lai bang `npm run catalog`
// ma khong can build lai frontend
app.get('/catalog.json', (_req, res) => res.sendFile(CATALOG_FILE));

app.use('/outputs', express.static(OUT_DIR));
app.use(express.static(DIST));

// SPA fallback - dat cuoi cung, sau moi route /api
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Khong tim thay route' });
  if (!existsSync(join(DIST, 'index.html'))) {
    return res
      .status(503)
      .type('text/plain')
      .send('Chua build frontend. Chay: cd web && npm install && npm run build');
  }
  res.sendFile(join(DIST, 'index.html'));
});

// ---------------------------------------------------------------------------
API_KEY = process.env.RUNWAY_API_KEY || loadKeyFromDotEnv() || (await loadKeyFromRegistry());
if (API_KEY) await refreshTier();
setInterval(refreshTier, 5 * 60 * 1000);

app.listen(PORT, HOST, () => {
  console.log('\n  Runway Studio');
  console.log(`  Local    : http://localhost:${PORT}`);
  for (const ip of localIPs()) console.log(`  LAN      : http://${ip}:${PORT}`);
  console.log(`  API key  : ${API_KEY ? `${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)} OK` : 'KHONG TIM THAY'}`);
  const admin = USERS.find((u) => u.role === 'admin');
  if (admin) console.log(`  Admin    : ${admin.name} / ma dang nhap: ${admin.code}`);
  console.log('');
});

function localIPs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}
