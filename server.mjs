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
import { openStore } from './store.mjs';
import { onJobFinished, pipelineRouter } from './pipeline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // mo ra LAN cho noi bo
const API_BASE = 'https://api.dev.runwayml.com/v1';
const API_VERSION = '2024-11-06';

/**
 * Duong dan luu tru, cho phep doi bang bien moi truong.
 *
 * Can thiet vi mot so nen tang (Railway) chi cho gan MOT volume moi service.
 * Luc do gan volume vao /app/data roi dat OUTPUTS_DIR=/app/data/outputs
 * la ca hai thu deu nam trong volume do.
 */
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const OUT_DIR = process.env.OUTPUTS_DIR || join(__dirname, 'outputs');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const USERS_FILE = join(DATA_DIR, 'users.json');
const SECRET_FILE = join(DATA_DIR, 'secret.key');
for (const d of [DATA_DIR, OUT_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// SQLite cho tang project/entity/scene. Dung node:sqlite co san nen khong
// them dependency va Docker khong phai build native module.
openStore(DATA_DIR);

/** Duoi file tuong ung MIME type - Runway suy loai media tu duoi file. */
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
  'audio/webm': '.weba', 'audio/flac': '.flac',
};
const extFromMime = (mime) => MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] ?? '.bin';

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
/**
 * Secret ky cookie phien.
 *
 * Uu tien bien moi truong SESSION_SECRET. Quan trong khi deploy tren nen tang
 * hosted: neu sinh ra roi ghi file, moi lan deploy lai ma volume chua gan dung
 * se ra secret khac, va toan bo nguoi dang dang nhap bi day ra ngoai.
 * Dat SESSION_SECRET thi phien song qua moi lan deploy.
 */
const SECRET = (() => {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      console.warn('  CANH BAO : SESSION_SECRET ngan hon 32 ky tu, nen dat dai hon');
    }
    return fromEnv;
  }
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(SECRET_FILE, s, 'utf8');
  return s;
})();

/**
 * Do dai ma truy cap.
 *
 * 16 byte = 32 ky tu hex. Ban dau la 4 byte (8 ky tu) - du cho mang noi bo
 * nhung qua ngan khi app mo ra internet: 8 hex chi co 4.3 ty to hop, va gioi
 * han theo IP khong chan duoc tan cong tu nhieu IP cung luc.
 */
const CODE_BYTES = 16;
const newCode = () => randomBytes(CODE_BYTES).toString('hex');

/** Ma cu ngan hon nguong an toan - canh bao de admin tao lai. */
const WEAK_CODE_LEN = 24;
const isWeakCode = (code) => typeof code === 'string' && code.length < WEAK_CODE_LEN;

function ensureUsers() {
  let users = readJson(USERS_FILE, null);
  if (!Array.isArray(users) || !users.length) {
    users = [{ name: 'admin', code: newCode(), role: 'admin' }];
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
    // Giu rieng ma loi: giao dien dich no thanh thong bao cho nguoi dung,
    // gop vao `error` thi mat thong tin de phan loai
    failureCode: j.failureCode ?? null,
    errorDetails: j.errorDetails ?? null,
    // Duong dan cuc bo sau khi tu luu - dung cai nay thay link Runway da het han
    localOutput: j.localOutput ?? null,
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
    error: j.error ?? null, failureCode: j.failureCode ?? null,
    errorDetails: j.errorDetails ?? null, localOutput: j.localOutput ?? null,
    cost: j.cost ?? null, estimatedCost: j.estimatedCost ?? null,
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
        job.error = e.message;
        // Giu NGUYEN cau truc loi cua Runway. Truoc day stringify roi cat con
        // 300 ky tu, nen danh sach `issues` bi mat va nguoi dung khong biet
        // truong nao sai - dung thu ho can nhat khi gap loi validation.
        job.errorDetails = e.details ?? null;
        // Gan ma rieng cho loi luc GUI yeu cau. Khong co ma thi giao dien
        // se doan sai thanh "loi he thong", trong khi day la tham so sai
        // ma nguoi dung sua duoc.
        // Runway tra 400 cho ca loi tham so LAN loi het credit. Gop chung
        // thanh "tham so khong hop le" la sai han huong xu ly.
        const msg = String(e.message || '');
        job.failureCode =
          /enough credits/i.test(msg) ? 'REQUEST.INSUFFICIENT_CREDITS'
          : e.status === 400 ? 'REQUEST.VALIDATION'
          : e.status === 401 || e.status === 403 ? 'REQUEST.AUTH'
          : e.status >= 500 ? 'REQUEST.SERVER'
          : 'REQUEST.OTHER';
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
      job.error = task.failure || 'Task that bai';
      job.failureCode = task.failureCode ?? null;
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

  // Tu luu ket qua ve dia truoc khi link Runway het han.
  // Khong await: giai phong slot hang doi ngay, tai ve chay nen.
  if (job.state === 'SUCCEEDED') void autoSaveOutputs(job);

  // Ghi ket qua vao tang project/entity/scene neu job nay thuoc pipeline
  void onJobFinished(job, { download: downloadOutput }).catch((e) =>
    console.warn(`[pipeline] ${e.message}`)
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

// Chi tin X-Forwarded-* khi that su nam sau reverse proxy. Bat vo dieu kien
// thi client tu dat X-Forwarded-For la qua duoc moi gioi han theo IP.
// Dat TRUST_PROXY=1 khi chay sau Caddy/nginx/Cloudflare.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '25mb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) =>
  res.status(e.status || 500).json({ error: e.message, details: e.details ?? null })
);

// --- Chong do ma truy cap ---
// Ma chi 8 ky tu hex. Khong gioi han thi ke tan cong cu ban lien tuc,
// nhat la khi app mo ra internet.
const LOGIN_FAILS = new Map(); // ip -> { count, until }
const MAX_FAILS = 5;

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of LOGIN_FAILS) if (rec.until && rec.until < now - 3600_000) LOGIN_FAILS.delete(ip);
}, 600_000).unref();

function loginGate(req, res, next) {
  const rec = LOGIN_FAILS.get(req.ip);
  if (rec?.until && Date.now() < rec.until) {
    const secs = Math.ceil((rec.until - Date.now()) / 1000);
    return res.status(429).json({ error: `Sai quá nhiều lần. Thử lại sau ${secs} giây.` });
  }
  next();
}

/** Cookie chi gan Secure khi that su chay tren HTTPS, neu khong trinh duyet se bo qua. */
function sessionCookie(name) {
  const secure = process.env.FORCE_SECURE_COOKIE === '1';
  return [
    `rs_session=${makeToken(name)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${30 * 24 * 3600}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

// --- Auth ---
app.post('/api/login', loginGate, wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  reloadUsers();
  const user = USERS.find((u) => u.code === code);

  if (!user) {
    const rec = LOGIN_FAILS.get(req.ip) ?? { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= MAX_FAILS) {
      // Cho tang dan: 30s, 60s, 120s... toi da 15 phut
      const wait = Math.min(30_000 * 2 ** (rec.count - MAX_FAILS), 900_000);
      rec.until = Date.now() + wait;
    }
    LOGIN_FAILS.set(req.ip, rec);
    console.warn(`[auth] ma sai tu ${req.ip} (lan ${rec.count})`);
    return res.status(401).json({ error: 'Ma truy cap khong dung' });
  }

  LOGIN_FAILS.delete(req.ip);
  res.setHeader('Set-Cookie', sessionCookie(user.name));
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

/**
 * Ban nao dang chay — KHONG can dang nhap.
 *
 * Can cho viec kiem tra sau khi deploy. Thay doi chi o backend thi khong
 * lam doi hash bundle frontend, nen tu ngoai khong co cach nao biet container
 * moi da len chua; da tung dan den bao sai rang ban moi dang chay trong khi
 * container con dang crash-loop.
 *
 * Chi tra commit ngan va thoi diem khoi dong: khong co bi mat, khong co
 * thong tin ve cau hinh hay moi truong.
 */
const STARTED_AT = new Date().toISOString();
const COMMIT = (
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT ||
  process.env.SOURCE_COMMIT ||
  ''
).slice(0, 7);

app.get('/api/version', (_req, res) => {
  res.json({
    commit: COMMIT || null,
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Tat ca /api/* con lai deu can dang nhap
app.use('/api', (req, res, next) => {
  if (['/login', '/logout', '/me', '/version'].includes(req.path)) return next();
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

/**
 * Chuan hoa ten file theo dung rang buoc cua Runway.
 *
 * Runway suy loai media tu DUOI FILE, khong tu content-type. File khong co
 * duoi (vd: anh dan tu clipboard ten "blob") se bi tu choi, nen tu bu duoi vao.
 * Spec con rang buoc minLength 3 / maxLength 255.
 */
function normalizeFilename(name, contentType) {
  let filename = name || 'upload';
  if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
    filename = `${filename}${extFromMime(contentType)}`;
  }
  if (filename.length < 3) filename = `file-${filename}`;
  if (filename.length > 255) {
    const ext = extname(filename);
    filename = filename.slice(0, 255 - ext.length) + ext;
  }
  return filename;
}

/**
 * Day mot file len Runway, tra ve runway:// URI.
 *
 * Tach ra ham rieng vi tang pipeline cung can upload (anh nhan vat thay
 * cho anh tu sinh, va upload LAI tu ban goc khi URI cu het han).
 */
async function uploadAsset({ bytes, filename, contentType = 'application/octet-stream' }) {
  if (!bytes?.length) throw Object.assign(new Error('File rong'), { status: 400 });
  const name = normalizeFilename(filename, contentType);

  const init = await runway('/uploads', {
    method: 'POST',
    // `type` la LOAI UPLOAD, enum chi nhan "ephemeral" - khong phai MIME type.
    // Gui MIME type vao day se bi tu choi 400 "expected \"ephemeral\"".
    body: { filename: name, type: 'ephemeral' },
  });

  const form = new FormData();
  for (const [k, v] of Object.entries(init.fields || {})) form.append(k, v);
  form.append('file', new Blob([bytes], { type: contentType }), name);

  const up = await fetch(init.uploadUrl, { method: 'POST', body: form });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    throw Object.assign(new Error(`Upload that bai (${up.status})`), {
      status: 502, details: t.slice(0, 400),
    });
  }
  return { uri: init.runwayUri, filename: name };
}

// --- Upload (client gui raw bytes, ten file o header) ---
app.post('/api/upload', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  // Client ma hoa ten file (co the chua dau tieng Viet) de header hop le
  const rawName = req.get('X-Filename') || 'upload';
  let filename;
  try { filename = decodeURIComponent(rawName); } catch { filename = rawName; }

  res.json(await uploadAsset({
    bytes: req.body,
    filename,
    contentType: req.get('X-Content-Type') || 'application/octet-stream',
  }));
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

/**
 * Tai mot output ve OUT_DIR, tra ve ten file cuc bo.
 * Dung chung cho ca tu dong luu (sau khi task xong) va nut Luu thu cong.
 */
async function downloadOutput(url, jobId, index) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`Tai that bai (${r.status})`), { status: 502 });

  let ext = extname(new URL(url).pathname);
  if (!ext) {
    const ct = r.headers.get('content-type') || '';
    ext = ct.includes('mp4') ? '.mp4' : ct.includes('png') ? '.png' : ct.includes('jpeg') ? '.jpg'
      : ct.includes('webp') ? '.webp' : ct.includes('mpeg') ? '.mp3' : ct.includes('wav') ? '.wav' : '.bin';
  }
  const name = `${String(jobId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '')}_${index}${ext}`;
  await pipeline(Readable.fromWeb(r.body), createWriteStream(join(OUT_DIR, name)));
  return name;
}

/**
 * Tu dong luu ket qua ngay khi task xong.
 *
 * Link cua Runway nhung JWT co han (quan sat thuc te ~48h). Tai lieu yeu cau
 * "he thong phai tu luu video lai va cho nguoi dung tai ve bat cu luc nao,
 * khong phu thuoc link goc" - nen khong the de nguoi dung tu bam Luu.
 *
 * Chay khong chan luong chinh: loi tai ve khong duoc lam job thanh FAILED.
 */
async function autoSaveOutputs(job) {
  if (!Array.isArray(job.output) || !job.output.length) return;

  const saved = [];
  for (let i = 0; i < job.output.length; i++) {
    try {
      const file = await downloadOutput(job.output[i], job.jobId, i);
      saved.push(`/outputs/${file}`);
    } catch (e) {
      console.warn(`[autosave] ${job.jobId}#${i}: ${e.message}`);
    }
  }

  if (saved.length) {
    job.localOutput = saved;
    pushJobUpdate(job);
  }
}

// --- Luu output ve may chu (link Runway het han sau ~24-48h) ---
app.post('/api/save', wrap(async (req, res) => {
  const { url, jobId, index = 0 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Thieu `url`' });
  const name = await downloadOutput(url, jobId, index);
  res.json({ ok: true, file: name, localUrl: `/outputs/${name}` });
}));

// --- Pipeline nhieu canh: project / entity / video / scene ---
app.use('/api/pipeline', pipelineRouter({ enqueue, outDir: OUT_DIR, uploadAsset }));

// --- Quan tri nguoi dung ---
app.get('/api/users', requireAdmin, wrap(async (_req, res) => {
  res.json(reloadUsers().map((u) => ({
    name: u.name,
    role: u.role || 'member',
    code: u.code,
    weak: isWeakCode(u.code),
  })));
}));

app.post('/api/users', requireAdmin, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Thieu ten' });
  const users = reloadUsers();
  if (users.some((u) => u.name === name)) return res.status(409).json({ error: 'Ten da ton tai' });
  const user = { name, code: newCode(), role: req.body?.role === 'admin' ? 'admin' : 'member' };
  users.push(user);
  writeJson(USERS_FILE, users);
  reloadUsers();
  res.json({ ...user, weak: isWeakCode(user.code) });
}));

/**
 * Tao lai ma cho mot nguoi. Phien dang nhap hien tai cua ho KHONG bi huy
 * vi token ky theo ten, khong theo ma - nhung ma cu se khong dung duoc nua.
 */
app.post('/api/users/:name/rotate', requireAdmin, wrap(async (req, res) => {
  const users = reloadUsers();
  const user = users.find((u) => u.name === req.params.name);
  if (!user) return res.status(404).json({ error: 'Khong tim thay nguoi dung' });
  user.code = newCode();
  writeJson(USERS_FILE, users);
  reloadUsers();
  res.json({ name: user.name, code: user.code, role: user.role || 'member', weak: false });
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

// File ket qua PHAI yeu cau dang nhap. Ten file chua jobId co the doan duoc,
// de mo thi bat ky ai cung tai duoc noi dung team da tao.
app.use('/outputs', requireAuth, express.static(OUT_DIR));

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
  console.log(`  Data     : ${DATA_DIR}`);
  console.log(`  Outputs  : ${OUT_DIR}`);
  const admin = USERS.find((u) => u.role === 'admin');
  if (admin) console.log(`  Admin    : ${admin.name} / ma dang nhap: ${admin.code}`);

  const weak = USERS.filter((u) => isWeakCode(u.code)).map((u) => u.name);
  if (weak.length) {
    console.log('');
    console.log(`  CANH BAO : ma truy cap qua ngan: ${weak.join(', ')}`);
    console.log('             Chi an toan trong mang noi bo. Neu app mo ra internet,');
    console.log('             vao muc Users bam "Tao lai ma" cho tung nguoi.');
  }
  if (process.env.TRUST_PROXY && !process.env.FORCE_SECURE_COOKIE) {
    console.log('');
    console.log('  CANH BAO : TRUST_PROXY bat nhung FORCE_SECURE_COOKIE tat.');
    console.log('             Neu dang chay sau HTTPS thi nen bat ca hai.');
  }
  console.log('');
});

function localIPs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}
