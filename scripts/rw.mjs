#!/usr/bin/env node
/**
 * CLI dieu khien pipeline Runway Studio.
 *
 * Muc dich: de mot tac tu (Claude Code) viet duoc y tuong thanh project /
 * entity / canh roi chay het pipeline ma khong can bam giao dien. Tuong duong
 * cac skill cua Flow Kit, nhung goi vao API cua chinh app nay.
 *
 * Xac thuc: dang nhap mot lan qua /api/login (duong nay da co chan
 * brute-force) roi giu cookie phien. KHONG them duong xac thuc moi de khong
 * mo them be mat tan cong.
 *
 * Cau hinh, theo do uu tien:
 *   1. bien moi truong RW_BASE / RW_CODE
 *   2. file .rw.json o goc du an  { "base": "...", "code": "..." }
 *
 * Ca hai file .rw.json va .rw-session deu chua bi mat -> da gitignore.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CFG_FILE = join(ROOT, '.rw.json');
const SESSION_FILE = join(ROOT, '.rw-session');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

function die(msg, hint) {
  console.error(`\n${C.r('Lỗi')}: ${msg}`);
  if (hint) console.error(C.dim('  → ' + hint));
  process.exit(1);
}

function config() {
  let file = {};
  if (existsSync(CFG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CFG_FILE, 'utf8'));
    } catch {
      die('.rw.json không phải JSON hợp lệ');
    }
  }
  const base = (process.env.RW_BASE || file.base || 'http://localhost:3000').replace(/\/+$/, '');
  const code = process.env.RW_CODE || file.code || '';
  return { base, code };
}

const { base, code } = config();
const session = () => (existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, 'utf8').trim() : '');

// ---------------------------------------------------------------------------
// Goi API
// ---------------------------------------------------------------------------
async function call(path, { method = 'GET', body, raw, headers = {}, retry = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(session() ? { Cookie: `rs_session=${session()}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Phien het han -> dang nhap lai mot lan roi thu lai
  if (res.status === 401 && retry && code) {
    await login(code, { quiet: true });
    return call(path, { method, body, raw, headers, retry: false });
  }

  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const e = new Error(data && typeof data === 'object' && data.error ? data.error : `HTTP ${res.status}`);
    e.status = res.status;
    e.details = data?.details ?? null;
    throw e;
  }
  return data;
}

async function login(theCode, { quiet = false } = {}) {
  if (!theCode) {
    die('Chưa có mã truy cập', 'Đặt RW_CODE=<mã>, hoặc tạo .rw.json {"base":"...","code":"..."}');
  }
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: theCode }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    die(
      b.error || `Đăng nhập thất bại (HTTP ${res.status})`,
      res.status === 429 ? 'Bị chặn tạm thời vì nhập sai nhiều lần — chờ rồi thử lại' : null
    );
  }
  const m = /rs_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  if (!m) die('Server không trả cookie phiên');
  writeFileSync(SESSION_FILE, m[1], { encoding: 'utf8', mode: 0o600 });
  const me = await res.json();
  if (!quiet) console.log(`${C.g('Đã đăng nhập')} ${C.b(me.name)} (${me.role}) tại ${C.dim(base)}`);
  return me;
}

// ---------------------------------------------------------------------------
// Upload file
// ---------------------------------------------------------------------------
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function uploadFile(path, file) {
  if (!existsSync(file)) die(`Không thấy file: ${file}`);
  const bytes = readFileSync(file);
  const ct = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  return call(path, {
    method: 'POST',
    raw: bytes,
    headers: {
      'Content-Type': ct,
      'X-Filename': encodeURIComponent(basename(file)),
      'X-Content-Type': ct,
    },
  });
}

// ---------------------------------------------------------------------------
// In ra man hinh
// ---------------------------------------------------------------------------
const BAR = 22;
function bar(done, pending, total) {
  if (!total) return C.dim('·'.repeat(BAR));
  const d = Math.round((done / total) * BAR);
  const p = Math.min(Math.round((pending / total) * BAR), BAR - d);
  return C.g('█'.repeat(d)) + C.y('▓'.repeat(p)) + C.dim('·'.repeat(Math.max(0, BAR - d - p)));
}

const NEXT_LABEL = {
  refs: 'sinh ảnh tham chiếu',
  images: 'sinh ảnh khung đầu',
  clips: 'sinh clip',
  concat: 'ghép thành một video',
  done: '— đã xong toàn bộ',
};

function printStatus(st, cost) {
  const rows = [
    ['1 Ảnh tham chiếu', st.refs, st.ready.refs],
    ['2 Ảnh khung đầu', st.images, st.ready.images],
    ['3 Clip', st.clips, st.ready.clips],
  ];
  console.log(
    `\n  ${C.b(st.video.title)}  ${C.dim(`${st.video.model} · ${st.video.ratio} · ${st.clips.total} cảnh · ${st.totalDuration}s`)}`
  );
  console.log('');
  for (const [label, p, ready] of rows) {
    const pend = p.pending ? C.y(` +${p.pending} đang chạy`) : '';
    const rdy = ready ? C.c(` ${ready} sẵn sàng`) : '';
    console.log(`  ${label.padEnd(18)} ${bar(p.done, p.pending, p.total)} ${String(p.done).padStart(2)}/${p.total}${pend}${rdy}`);
  }
  console.log(`\n  ${C.b('Bước tiếp')}: ${NEXT_LABEL[st.next] ?? st.next}`);
  if (!st.ffmpeg && st.next === 'concat') {
    console.log(`  ${C.y('Máy chủ không có ffmpeg')} — không ghép được`);
  }
  if (cost) {
    if (cost.lines.length) {
      console.log(`\n  ${C.b('Còn tốn')}: ${C.y(cost.credits + ' credit')}`);
      for (const l of cost.lines) console.log(`    ${C.dim('· ' + l)}`);
      if (cost.note) console.log(`    ${C.y(cost.note)}`);
    } else {
      console.log(`\n  ${C.dim('Không còn việc nào phải sinh')}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Lenh
// ---------------------------------------------------------------------------
const cmds = {};

cmds.login = async ([c]) => {
  await login(c || code);
};

cmds.whoami = async () => {
  const me = await call('/api/me');
  console.log(
    `${C.b(me.name)} (${me.role}) · ${base} · server ${me.hasKey ? C.g('có API key') : C.r('CHƯA có API key')}`
  );
};

cmds.credits = async () => {
  const org = await call('/api/organization');
  if (org.error) die(org.error);
  console.log(`${C.b(String(org.creditBalance))} credit còn lại`);
};

cmds.projects = async () => {
  const list = await call('/api/pipeline/projects');
  if (!list.length) return console.log(C.dim('Chưa có project nào. Tạo bằng: rw plan <file.json>'));
  for (const p of list) console.log(`  ${C.c(p.id)}  ${C.b(p.name)}  ${C.dim(p.orientation)}`);
};

cmds.show = async ([id]) => {
  if (!id) die('Thiếu projectId', 'rw show <projectId>');
  const p = await call(`/api/pipeline/projects/${id}`);
  console.log(`\n  ${C.b(p.name)}  ${C.dim(p.orientation)}`);
  console.log(`  ${C.dim('Phong cách: ' + (p.material || '—'))}`);
  console.log(`\n  ${C.b('Thực thể')}`);
  for (const e of p.entities) {
    const ref = e.ref_uri ? C.g('có ảnh') : e.ref_job_id ? C.y('đang sinh') : C.r('chưa có ảnh');
    console.log(`    ${C.c(e.id)}  @${(e.tag || '').padEnd(16)} ${e.name.padEnd(20)} ${e.entity_type.padEnd(13)} ${ref}`);
  }
  console.log(`\n  ${C.b('Video')}`);
  for (const v of p.videos) console.log(`    ${C.c(v.id)}  ${v.title}  ${C.dim(`${v.model} · ${v.ratio}`)}`);
  console.log('');
};

cmds.status = async ([id]) => {
  if (!id) die('Thiếu videoId', 'rw status <videoId>');
  const [st, cost] = await Promise.all([
    call(`/api/pipeline/videos/${id}/status`),
    call(`/api/pipeline/videos/${id}/cost`).catch(() => null),
  ]);
  printStatus(st, cost);
};

cmds.cost = async ([id]) => {
  if (!id) die('Thiếu videoId', 'rw cost <videoId>');
  const c = await call(`/api/pipeline/videos/${id}/cost`);
  const org = await call('/api/organization').catch(() => null);
  console.log(`\n  Còn tốn ${C.b(c.credits + ' credit')}`);
  for (const l of c.lines) console.log(`    ${C.dim('· ' + l)}`);
  if (org?.creditBalance != null) {
    const left = org.creditBalance - c.credits;
    console.log(`\n  Số dư ${org.creditBalance} → còn ${left < 0 ? C.r(String(left)) : C.g(String(left))} sau khi chạy hết`);
    if (left < 0) console.log(`  ${C.r('KHÔNG ĐỦ CREDIT')} — thiếu ${-left}`);
  }
  console.log('');
};

cmds['upload-ref'] = async ([entityId, file]) => {
  if (!entityId || !file) die('Thiếu tham số', 'rw upload-ref <entityId> <file>');
  const r = await uploadFile(`/api/pipeline/entities/${entityId}/ref-upload`, file);
  console.log(`${C.g('Đã gắn ảnh')} cho @${r.entity.tag} ${C.dim('→ ' + r.entity.ref_local)}`);
};

cmds['upload-frame'] = async ([sceneId, file]) => {
  if (!sceneId || !file) die('Thiếu tham số', 'rw upload-frame <sceneId> <file>');
  const r = await uploadFile(`/api/pipeline/scenes/${sceneId}/image-upload`, file);
  console.log(`${C.g('Đã gắn ảnh khung đầu')} cảnh ${r.scene.display_order + 1} ${C.dim('→ ' + r.scene.image_local)}`);
};

const batch = (label, fn) => async (args) => {
  if (!args[0]) die('Thiếu id');
  const r = await fn(args[0], args);
  console.log(`${C.g(label)}: đẩy ${C.b(String(r.queued?.length ?? 0))} việc vào hàng đợi`);
  for (const q of r.queued ?? []) {
    console.log(`    ${C.dim(q.entity ? `@${q.entity}` : `cảnh ${q.scene}`)} ${C.dim(q.jobId)}`);
  }
  if (r.skipped?.length) console.log(`  ${C.y('Bỏ qua')}: ${JSON.stringify(r.skipped)}`);
  if (r.warnedMissingRefs?.length) console.log(`  ${C.y('Thiếu ảnh tham chiếu')}: ${r.warnedMissingRefs.join(', ')}`);
  if (r.note) console.log(`  ${C.dim(r.note)}`);
};

cmds.refs = batch('Ảnh tham chiếu', (id) =>
  call(`/api/pipeline/projects/${id}/gen-refs`, { method: 'POST', body: {} })
);
cmds.images = batch('Ảnh khung đầu', (id, args) =>
  call(`/api/pipeline/videos/${id}/gen-images`, { method: 'POST', body: { force: args.includes('--force') } })
);
cmds.clips = batch('Clip', (id) => call(`/api/pipeline/videos/${id}/gen-clips`, { method: 'POST', body: {} }));

cmds.concat = async ([id]) => {
  if (!id) die('Thiếu videoId');
  const r = await call(`/api/pipeline/videos/${id}/concat`, { method: 'POST', body: {} });
  console.log(`${C.g('Đã ghép')} ${r.parts} clip → ${C.b(r.final)}`);
  if (r.skipped?.length) console.log(`  ${C.y('Bỏ qua cảnh')}: ${r.skipped.join(', ')}`);
  if (r.note) console.log(`  ${C.dim(r.note)}`);
};

cmds.watch = async ([id]) => {
  if (!id) die('Thiếu videoId', 'rw watch <videoId>');
  let last = '';
  for (;;) {
    const st = await call(`/api/pipeline/videos/${id}/status`);
    const key = `${st.refs.done}/${st.images.done}/${st.clips.done}/${st.refs.pending}${st.images.pending}${st.clips.pending}`;
    if (key !== last) {
      last = key;
      printStatus(st, null);
    }
    if (!(st.refs.pending + st.images.pending + st.clips.pending)) {
      console.log(C.dim('  Không còn việc đang chạy.'));
      return;
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
};

// ---------------------------------------------------------------------------
// plan: tao ca project tu MOT file JSON — day la lenh chinh
// ---------------------------------------------------------------------------
cmds.plan = async ([file]) => {
  if (!file) die('Thiếu file kịch bản', 'rw plan <file.json>');
  if (!existsSync(file)) die(`Không thấy file: ${file}`);

  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    die(`File không phải JSON hợp lệ: ${e.message}`);
  }

  const dir = dirname(resolve(file));
  const asset = (p) => (isAbsolute(p) ? p : join(dir, p));

  // --- Kiem tra HET truoc khi ghi bat cu thu gi: mot ban ke hoach sai mot
  //     nua roi tao nua voi thi kho don hon la khong tao gi ---
  const problems = [];
  if (!plan.name) problems.push('thiếu `name`');
  if (!Array.isArray(plan.entities) || !plan.entities.length) problems.push('thiếu `entities`');
  if (!Array.isArray(plan.scenes) || !plan.scenes.length) problems.push('thiếu `scenes`');

  const names = new Set((plan.entities ?? []).map((e) => e.name));
  for (const e of plan.entities ?? []) {
    if (!e.name) problems.push('có thực thể thiếu `name`');
    if (!e.ref_image && !e.description) {
      problems.push(`"${e.name}": phải có \`description\` (để sinh ảnh) hoặc \`ref_image\` (ảnh có sẵn)`);
    }
    if (e.ref_image && !existsSync(asset(e.ref_image))) {
      problems.push(`"${e.name}": không thấy ảnh ${e.ref_image}`);
    }
  }
  for (const [i, s] of (plan.scenes ?? []).entries()) {
    if (!s.image_prompt) problems.push(`cảnh ${i + 1}: thiếu \`image_prompt\``);
    for (const n of s.entities ?? []) {
      if (!names.has(n)) problems.push(`cảnh ${i + 1}: không có thực thể tên "${n}"`);
    }
    if (s.frame_image && !existsSync(asset(s.frame_image))) {
      problems.push(`cảnh ${i + 1}: không thấy ảnh ${s.frame_image}`);
    }
  }
  if (problems.length) {
    console.error(`\n${C.r('Kịch bản chưa hợp lệ')} — chưa ghi gì cả:`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }

  // --- Tao ---
  const proj = await call('/api/pipeline/projects', {
    method: 'POST',
    body: {
      name: plan.name,
      story: plan.story ?? '',
      material: plan.material ?? '',
      orientation: plan.orientation ?? 'HORIZONTAL',
    },
  });
  console.log(`${C.g('Project')} ${C.b(proj.name)} ${C.dim(proj.id)}`);

  const byName = new Map();
  for (const e of plan.entities) {
    const ent = await call(`/api/pipeline/projects/${proj.id}/entities`, {
      method: 'POST',
      body: {
        name: e.name,
        entity_type: e.entity_type ?? 'character',
        description: e.description ?? '',
        voice_description: e.voice_description ?? '',
      },
    });
    byName.set(e.name, ent);

    if (e.ref_image) {
      const r = await uploadFile(`/api/pipeline/entities/${ent.id}/ref-upload`, asset(e.ref_image));
      byName.set(e.name, r.entity);
      console.log(`  ${C.g('✓')} @${r.entity.tag} ${C.dim('ảnh có sẵn: ' + basename(asset(e.ref_image)))}`);
    } else {
      console.log(`  ${C.dim('·')} @${ent.tag} ${C.dim('sẽ sinh ảnh tham chiếu')}`);
    }
  }

  const vspec = plan.video ?? {};
  const vertical = (plan.orientation ?? 'HORIZONTAL') === 'VERTICAL';
  const video = await call(`/api/pipeline/projects/${proj.id}/videos`, {
    method: 'POST',
    body: {
      title: vspec.title ?? plan.name,
      ratio: vspec.ratio ?? (vertical ? '720:1280' : '1280:720'),
      model: vspec.model ?? 'gen4_turbo',
    },
  });
  console.log(`${C.g('Video')} ${C.b(video.title)} ${C.dim(`${video.id} · ${video.model} · ${video.ratio}`)}`);

  for (const [i, s] of plan.scenes.entries()) {
    const sc = await call(`/api/pipeline/videos/${video.id}/scenes`, {
      method: 'POST',
      body: {
        image_prompt: s.image_prompt,
        video_prompt: s.video_prompt ?? '',
        duration: s.duration ?? 8,
        chain_type: i === 0 ? 'ROOT' : s.chain_type ?? 'CONTINUATION',
        entity_ids: (s.entities ?? []).map((n) => byName.get(n).id),
      },
    });
    let mark = C.dim('·');
    if (s.frame_image) {
      await uploadFile(`/api/pipeline/scenes/${sc.id}/image-upload`, asset(s.frame_image));
      mark = C.g('✓');
    }
    const tags = (s.entities ?? []).map((n) => '@' + byName.get(n).tag).join(' ');
    console.log(`  ${mark} cảnh ${i + 1} ${C.dim(`${s.duration ?? 8}s`)} ${C.dim(tags)}`);
  }

  const cost = await call(`/api/pipeline/videos/${video.id}/cost`).catch(() => null);
  printStatus(await call(`/api/pipeline/videos/${video.id}/status`), cost);
  console.log(`  ${C.dim('Chạy bước 1:')} node scripts/rw.mjs refs ${proj.id}`);
  console.log(`  ${C.dim('Theo dõi   :')} node scripts/rw.mjs watch ${video.id}\n`);
};

cmds.help = async () => {
  console.log(`
  ${C.b('Runway Studio — CLI pipeline')}   ${C.dim(base)}

  ${C.b('Chuẩn bị')}
    login [mã]                      đăng nhập, lưu phiên vào .rw-session
    whoami                          xem đang là ai
    credits                         số credit còn lại

  ${C.b('Tạo')}
    plan <file.json>                tạo cả project + thực thể + cảnh từ 1 file
    projects                        liệt kê project
    show <projectId>                chi tiết project, lấy id cho bước sau

  ${C.b('Ảnh có sẵn')}
    upload-ref <entityId> <file>    dùng ảnh thật làm ảnh tham chiếu
    upload-frame <sceneId> <file>   dùng ảnh thật làm khung đầu của cảnh

  ${C.b('Chạy pipeline')}
    refs <projectId>                bước 1 — sinh ảnh tham chiếu
    images <videoId> [--force]      bước 2 — sinh ảnh khung đầu
    clips <videoId>                 bước 3 — sinh clip
    concat <videoId>                bước 4 — ghép bằng ffmpeg

  ${C.b('Theo dõi')}
    status <videoId>                đang ở bước nào, còn tốn bao nhiêu credit
    cost <videoId>                  chỉ xem chi phí còn lại
    watch <videoId>                 theo dõi tới khi hàng đợi rỗng

  ${C.dim('Cấu hình: RW_BASE / RW_CODE, hoặc .rw.json {"base":"...","code":"..."}')}
`);
};

// ---------------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
const fn = cmds[cmd ?? 'help'];
if (!fn) die(`Lệnh không có: ${cmd}`, 'Chạy `node scripts/rw.mjs help`');

try {
  await fn(args);
} catch (e) {
  if (e.status === 401) die('Chưa đăng nhập hoặc phiên hết hạn', 'node scripts/rw.mjs login <mã>');
  console.error(`\n${C.r('Lỗi')}: ${e.message}`);
  if (e.details) console.error(C.dim('  ' + JSON.stringify(e.details).slice(0, 500)));
  process.exit(1);
}
