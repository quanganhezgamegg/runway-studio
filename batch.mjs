/**
 * Lenh hang loat cho pipeline — tuong duong cac skill cua Flow Kit
 * (fk-gen-refs, fk-gen-images, fk-gen-videos, fk-concat, fk-status),
 * nhung chay tren API Runway.
 *
 * Diem quan trong muon tu Flow Kit: MOI buoc kiem tra phu thuoc TRUOC khi
 * chay. `fk-gen-images` cua ho "verifies all refs exist first" — khong co
 * buoc do thi sinh anh canh khi entity chua co ref se ra nhan vat khac han,
 * ma van bi tinh tien.
 *
 * Hang doi chung cua server tu ton trong gioi han 1 video dong thoi, nen
 * "sinh tat ca clip" chi la day N job vao hang, khong phai chay song song.
 */
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { entities, entityTag, projects, scenes, videos } from './store.mjs';

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(-500) || err.message));
      resolve(stdout);
    });
  });

/** ffmpeg co san khong — kiem tra mot lan roi nho ket qua. */
let ffmpegOk = null;
export async function hasFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    await run('ffmpeg', ['-version']);
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

// ---------------------------------------------------------------------------
// Trang thai pipeline — tra ve "xong gi, con gi, buoc tiep la gi"
// ---------------------------------------------------------------------------
export function videoStatus(videoId) {
  const v = videos.get(videoId);
  if (!v) return null;

  const list = scenes.listForVideo(videoId);
  const p = projects.get(v.project_id);
  const ents = p ? entities.listForProject(p.id) : [];

  const refs = {
    done: ents.filter((e) => e.ref_uri).length,
    pending: ents.filter((e) => !e.ref_uri && e.ref_job_id).length,
    total: ents.length,
  };
  const images = {
    done: list.filter((s) => s.image_uri).length,
    pending: list.filter((s) => !s.image_uri && s.image_job_id).length,
    total: list.length,
  };
  const clips = {
    done: list.filter((s) => s.video_uri).length,
    pending: list.filter((s) => !s.video_uri && s.video_job_id).length,
    total: list.length,
  };

  // Buoc tiep theo: buoc dau tien chua xong het
  let next = 'concat';
  if (refs.done < refs.total) next = 'refs';
  else if (images.done < images.total) next = 'images';
  else if (clips.done < clips.total) next = 'clips';
  else if (v.final_local) next = 'done';

  return {
    video: v,
    refs,
    images,
    clips,
    next,
    totalDuration: list.reduce((n, s) => n + (s.duration || 0), 0),
    ready: {
      refs: ents.filter((e) => !e.ref_uri && !e.ref_job_id && e.description?.trim()).length,
      images: list.filter((s) => !s.image_uri && !s.image_job_id && s.image_prompt?.trim()).length,
      clips: list.filter((s) => s.image_uri && !s.video_uri && !s.video_job_id).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Sinh hang loat
// ---------------------------------------------------------------------------

/** Buoc 1: anh tham chieu cho moi entity chua co. */
export function genAllRefs(projectId, { enqueue, user, buildRefPayload }) {
  const p = projects.get(projectId);
  if (!p) throw Object.assign(new Error('Khong tim thay project'), { status: 404 });

  const todo = entities
    .listForProject(projectId)
    .filter((e) => !e.ref_uri && !e.ref_job_id);

  const skipped = todo.filter((e) => !e.description?.trim()).map((e) => e.name);
  const jobs = [];

  for (const e of todo) {
    if (!e.description?.trim()) continue;
    const job = enqueue({ ...buildRefPayload(e, p), user });
    entities.update(e.id, { ref_job_id: job.jobId });
    jobs.push({ entity: e.name, jobId: job.jobId });
  }

  return {
    queued: jobs,
    skipped,
    note: skipped.length ? 'Bỏ qua entity chưa có mô tả ngoại hình' : undefined,
  };
}

/**
 * Buoc 2: anh khung dau cho moi canh chua co.
 * Chan neu con entity chua co anh tham chieu — day la kiem tra phu thuoc
 * quan trong nhat, khong co no thi nhan vat se khac nhau giua cac canh.
 */
export async function genAllImages(videoId, { enqueue, user, buildImagePayload, refresh, force = false }) {
  const v = videos.get(videoId);
  if (!v) throw Object.assign(new Error('Khong tim thay video'), { status: 404 });

  const p = projects.get(v.project_id);
  const list = scenes.listForVideo(videoId);

  // Chi tinh entity THUC SU duoc dung trong cac canh cua video nay
  const used = new Set(list.flatMap((s) => s.entity_ids));
  const missing = [...used]
    .map((id) => entities.get(id))
    .filter((e) => e && !e.ref_uri)
    .map((e) => e.name);

  if (missing.length && !force) {
    throw Object.assign(
      new Error(
        `Chưa có ảnh tham chiếu cho: ${missing.join(', ')}. ` +
          'Sinh ảnh tham chiếu trước, nếu không nhân vật sẽ khác nhau giữa các cảnh. ' +
          'Muốn bỏ qua thì gửi force=true.'
      ),
      { status: 409, details: { missing } }
    );
  }

  const todo = list.filter((s) => !s.image_uri && !s.image_job_id && s.image_prompt?.trim());
  const jobs = [];

  for (const s of todo) {
    // Day lai anh tham chieu len truoc khi dung — URI cua Runway co han
    if (refresh) await refresh(s);
    const job = enqueue({ ...buildImagePayload(s, v, p), user });
    scenes.update(s.id, { image_job_id: job.jobId });
    jobs.push({ scene: s.display_order + 1, jobId: job.jobId });
  }

  const noPrompt = list
    .filter((s) => !s.image_uri && !s.image_job_id && !s.image_prompt?.trim())
    .map((s) => s.display_order + 1);

  return {
    queued: jobs,
    warnedMissingRefs: missing,
    skipped: noPrompt,
    note: noPrompt.length ? `Cảnh ${noPrompt.join(', ')} chưa có mô tả hành động` : undefined,
  };
}

/** Buoc 3: clip cho moi canh da co anh khung dau. */
export async function genAllClips(videoId, { enqueue, user, buildVideoPayload, refresh }) {
  const v = videos.get(videoId);
  if (!v) throw Object.assign(new Error('Khong tim thay video'), { status: 404 });

  const p = projects.get(v.project_id);
  const list = scenes.listForVideo(videoId);
  const todo = list.filter((s) => s.image_uri && !s.video_uri && !s.video_job_id);

  const noImage = list
    .filter((s) => !s.image_uri && !s.video_uri)
    .map((s) => s.display_order + 1);

  const jobs = [];
  for (const s of todo) {
    // refresh tra ve canh da cap nhat image_uri, phai dung ban do de dung payload
    const cur = refresh ? await refresh(s) : s;
    const job = enqueue({ ...buildVideoPayload(cur, v, p), user });
    scenes.update(s.id, { video_job_id: job.jobId });
    jobs.push({ scene: s.display_order + 1, jobId: job.jobId });
  }

  return {
    queued: jobs,
    skipped: noImage,
    note: noImage.length ? `Cảnh ${noImage.join(', ')} chưa có ảnh khung đầu` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Ghep thanh mot video
// ---------------------------------------------------------------------------

/**
 * Ghep cac clip theo thu tu canh.
 *
 * Dung concat demuxer voi `-c copy` — khong encode lai nen nhanh va khong
 * mat chat luong. Duoc vi moi clip ra tu cung mot model nen cung codec,
 * cung kich thuoc, cung fps. Neu nguoi dung tron model giua cac canh thi
 * buoc nay se loi, va loi do dang bao ro hon la im lang encode lai.
 */
export async function concatVideo(videoId, { outDir }) {
  if (!(await hasFfmpeg())) {
    throw Object.assign(
      new Error('Máy chủ không có ffmpeg. Thêm ffmpeg vào image rồi deploy lại.'),
      { status: 501 }
    );
  }

  const v = videos.get(videoId);
  if (!v) throw Object.assign(new Error('Khong tim thay video'), { status: 404 });

  const list = scenes.listForVideo(videoId);
  const parts = list
    .filter((s) => s.video_local)
    .map((s) => ({ order: s.display_order, file: join(outDir, s.video_local.replace(/^\/outputs\//, '')) }))
    .filter((x) => existsSync(x.file));

  if (!parts.length) {
    throw Object.assign(
      new Error('Chưa có clip nào được lưu về máy chủ. Sinh clip trước.'),
      { status: 400 }
    );
  }

  const missing = list.filter((s) => !s.video_local).map((s) => s.display_order + 1);

  const listFile = join(outDir, `${videoId}.concat.txt`);
  const outName = `${videoId}_final.mp4`;
  const outFile = join(outDir, outName);

  // Duong dan trong file concat phai escape dau nhay don
  writeFileSync(
    listFile,
    parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  try {
    await run('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outFile,
    ]);
  } catch (e) {
    // Stream copy that bai (thuong do tron model -> khac codec/kich thuoc).
    // Lui ve encode lai, cham hon nhung chac chan ra file dung.
    await run('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      outFile,
    ]);
  } finally {
    try { unlinkSync(listFile); } catch { /* bo qua */ }
  }

  const final = `/outputs/${outName}`;
  videos.update(videoId, { final_local: final });

  return {
    final,
    parts: parts.length,
    skipped: missing,
    note: missing.length ? `Cảnh ${missing.join(', ')} chưa có clip, đã bỏ qua khi ghép` : undefined,
  };
}
