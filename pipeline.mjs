/**
 * Route va logic cho pipeline nhieu canh.
 *
 * Tach khoi server.mjs de phan hang doi / auth / proxy da chay dung khong bi
 * dung den. Module nay chi biet: doc ghi store, va goi `enqueue` cua server
 * de day viec vao hang doi chung.
 *
 * Ba buoc cua pipeline, moi buoc la mot job trong hang doi san co:
 *   1. Anh tham chieu cho tung entity   -> text_to_image (gen4_image)
 *   2. Anh khung dau cho tung canh      -> text_to_image (turbo + ref entity)
 *   3. Clip cho tung canh               -> image_to_video (tu anh buoc 2)
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import express from 'express';
import {
  CHAIN_TYPES,
  ENTITY_REF_STYLE,
  ENTITY_TYPES,
  REF_IMAGE_MODEL,
  SCENE_IMAGE_MODEL,
  entities,
  entityByJob,
  entityTag,
  projects,
  sceneByJob,
  scenes,
  videos,
} from './store.mjs';
import {
  concatVideo,
  genAllClips,
  genAllImages,
  genAllRefs,
  hasFfmpeg,
  videoStatus,
} from './batch.mjs';
import { estimateVideo } from './pricing.mjs';

/**
 * @param {object} deps
 * @param {(job: object) => object} deps.enqueue  ham enqueue cua server
 */

/** Nhan @tag suy tu ten, dung chung cho frontend va payload. */
const withTag = (e) => ({ ...e, tag: entityTag(e.name) });

// ---------------------------------------------------------------------------
// Dung payload cho ba buoc.
//
// Tach ra module-level de lenh don va lenh hang loat dung CUNG mot ham -
// hai duong dung payload khac nhau la mam bug kho tim, vi ket qua chi lech
// nhau khi chay hang loat.
// ---------------------------------------------------------------------------

/** Buoc 1: anh tham chieu cho mot entity. */
export function buildRefPayload(e, project) {
  const style = ENTITY_REF_STYLE[e.entity_type] ?? ENTITY_REF_STYLE.other;
  const promptText = [e.description.trim(), style.extra, project?.material?.trim()]
    .filter(Boolean)
    .join('. ');

  return {
    path: '/v1/text_to_image',
    payload: { model: REF_IMAGE_MODEL, promptText, ratio: style.ratio },
    title: `Ref: ${e.name}`,
  };
}

/** Buoc 2: anh khung dau cho mot canh, kem anh tham chieu cua entity trong canh. */
export const MAX_REF_IMAGES = 3;

/** Ky tu con duoc coi la thuoc cung mot tu — dung de chan khop mot phan. */
const WORD_CHAR = /[a-z0-9_]/;

export function buildImagePayload(s, video, project) {
  const all = s.entity_ids
    .map((id) => entities.get(id))
    .filter((e) => e?.ref_uri)
    .map((e) => ({ uri: e.ref_uri, tag: entityTag(e.name), name: e.name }));

  const basePrompt = s.image_prompt.trim();

  // Spec cho TOI DA 3 anh tham chieu moi lan goi. Gui 4 la bi tu choi 400,
  // nen phai tu chon. Uu tien entity ma prompt CO nhac @tag — do la y cua
  // nguoi viet prompt; con lai lay theo thu tu.
  // Tim "@tag" nhung khong cho khop mot phan: tag `sap` khong duoc tinh la
  // da nhac khi prompt viet `@sap_ca`. Khong dung RegExp o day vi tag do
  // nguoi dung dat, nhet thang vao regex la sai khi ten co ky tu dac biet.
  const mentioned = (t) => {
    const hay = basePrompt.toLowerCase();
    const needle = `@${t.toLowerCase()}`;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
      const after = hay[i + needle.length];
      if (after === undefined || !WORD_CHAR.test(after)) return true;
    }
    return false;
  };
  const ordered = [...all.filter((r) => mentioned(r.tag)), ...all.filter((r) => !mentioned(r.tag))];
  const refs = ordered.slice(0, MAX_REF_IMAGES);
  const dropped = ordered.slice(MAX_REF_IMAGES);

  // gen4_image_turbo BAT BUOC co referenceImages. Khong co ref nao thi phai
  // lui ve gen4_image, dat hon nhung khong bi tu choi.
  const model = refs.length ? SCENE_IMAGE_MODEL : REF_IMAGE_MODEL;

  // Tai lieu Runway: tag "is used to reference the image in prompt text".
  // Gui anh tham chieu ma prompt khong nhac @tag thi model bo qua anh do —
  // that am tham, va ket qua la nhan vat khac han giua cac canh. Nen tag nao
  // chua duoc nhac thi tu noi vao cuoi prompt.
  const unmentioned = refs.filter((r) => !mentioned(r.tag)).map((r) => `@${r.tag}`);

  const promptText = [
    basePrompt,
    unmentioned.length ? `Featuring ${unmentioned.join(', ')}` : '',
    project?.material?.trim(),
  ]
    .filter(Boolean)
    .join('. ');

  const payload = { model, promptText, ratio: video?.ratio || '1280:720' };
  if (refs.length) payload.referenceImages = refs;

  return {
    path: '/v1/text_to_image',
    payload,
    title: `Canh ${s.display_order + 1}: anh`,
    usedRefs: refs.map((r) => r.tag),
    droppedRefs: dropped.map((r) => r.name),
  };
}

/** Buoc 3: clip tu anh khung dau. */
export function buildVideoPayload(s, video) {
  // Giong nhan vat: noi voice_description vao prompt de model giu giong
  // nhat quan giua cac canh (y tuong tu Flow Kit)
  const voices = s.entity_ids
    .map((id) => entities.get(id))
    .filter((e) => e?.voice_description?.trim())
    .map((e) => `${e.name}: ${e.voice_description.trim()}`);

  const prompt = (s.video_prompt || s.image_prompt || '').trim();

  // Noi bang dau cham, khong phai dau cach - de model khong doc lien thanh
  // mot cau vo nghia khi ghep mo ta chuyen dong + giong + chu thich nhac
  const promptText = [
    prompt.replace(/\.?$/, ''),
    ...voices,
    // Mac dinh chan nhac nen tu phat sinh - de ghep nhac rieng o hau ky
    'No background music. Keep only natural sound effects and ambient sounds',
  ].join('. ') + '.';

  return {
    path: '/v1/image_to_video',
    payload: {
      model: video?.model || 'gen4_turbo',
      promptImage: s.image_uri,
      promptText,
      ratio: video?.ratio || '1280:720',
      duration: s.duration || 8,
    },
    title: `Canh ${s.display_order + 1}: clip`,
  };
}

/** MIME theo duoi file — Runway can content-type dung khi upload lai. */
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const mimeOf = (file) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Ten file an toan, giu duoi goc. */
function safeName(name) {
  const ext = extname(name || '').toLowerCase().slice(0, 6);
  const stem = basename(name || 'file', extname(name || ''))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // d/D gach ngang khong tach dau khi NFD nen phai doi tay
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${stem || 'file'}${ext || '.bin'}`;
}

export function pipelineRouter({ enqueue, outDir, uploadAsset }) {
  const r = express.Router();

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) =>
      res.status(e.status || 500).json({ error: e.message, details: e.details ?? null })
    );

  const bad = (res, msg) => res.status(400).json({ error: msg });
  const missing = (res, what) => res.status(404).json({ error: `Khong tim thay ${what}` });

  const UP_DIR = join(outDir, 'uploads');

  /**
   * Nhan raw bytes tu client: luu ban goc xuong volume RUOI day len Runway.
   *
   * Phai giu ban goc vi upload cua Runway la "ephemeral" — spec noi ro
   * "will be automatically expired and deleted after a period of time".
   * Khong giu thi vai ngay sau anh tham chieu cua entity bien mat.
   */
  async function takeUpload(req, prefix) {
    if (!req.body?.length) throw Object.assign(new Error('File rong'), { status: 400 });

    let raw = req.get('X-Filename') || 'upload';
    try { raw = decodeURIComponent(raw); } catch { /* giu nguyen */ }
    const contentType = req.get('X-Content-Type') || 'application/octet-stream';

    // Upload TRUOC de lay ten da chuan hoa (da bu duoi file theo MIME), roi
    // moi luu ban goc theo dung ten do. Neu luu theo ten goc thi file dan tu
    // clipboard ("blob", khong duoi) se thanh .bin, va lan upload lai
    // mimeOf() doc ra octet-stream -> Runway tu choi.
    const { uri, filename } = await uploadAsset({ bytes: req.body, filename: raw, contentType });

    const name = `${prefix}-${Date.now()}-${safeName(filename)}`;
    await mkdir(UP_DIR, { recursive: true });
    await writeFile(join(UP_DIR, name), req.body);

    return { uri, local: `/outputs/uploads/${name}` };
  }

  /**
   * Upload LAI tu ban goc de co URI con han.
   *
   * Moi URI cua Runway deu co han — link ket qua ~48h, upload thi "expired
   * after a period of time". Pipeline dung lai anh tham chieu nhieu ngay sau
   * khi sinh, nen cu truoc moi lan sinh thi day lai ban goc len. Upload
   * khong ton credit, doi lay viec khong bao gio gap URI chet.
   */
  async function freshUri(localUrl, currentUri) {
    if (!localUrl) return currentUri;
    const file = join(outDir, localUrl.replace(/^\/outputs\//, ''));
    if (!existsSync(file)) return currentUri;
    try {
      const { uri } = await uploadAsset({
        bytes: await readFile(file), filename: basename(file), contentType: mimeOf(file),
      });
      return uri;
    } catch (e) {
      // Khong chan viec sinh: URI cu co the van con han
      console.warn(`[pipeline] upload lai that bai (${basename(file)}): ${e.message}`);
      return currentUri;
    }
  }

  /** Lam moi URI anh tham chieu cua moi entity trong canh. */
  async function freshSceneRefs(sc) {
    for (const id of sc.entity_ids) {
      const e = entities.get(id);
      if (!e?.ref_local) continue;
      const uri = await freshUri(e.ref_local, e.ref_uri);
      if (uri && uri !== e.ref_uri) entities.update(id, { ref_uri: uri });
    }
  }

  /** Lam moi URI anh khung dau cua canh, tra ve ban da cap nhat. */
  async function freshSceneImage(sc) {
    if (!sc.image_local) return sc;
    const uri = await freshUri(sc.image_local, sc.image_uri);
    if (uri && uri !== sc.image_uri) scenes.update(sc.id, { image_uri: uri });
    return scenes.get(sc.id);
  }

  const rawBody = express.raw({ type: '*/*', limit: '60mb' });

  // -------------------------------------------------------------------------
  // Hang so cho frontend
  // -------------------------------------------------------------------------
  r.get('/meta', (_req, res) =>
    res.json({ entityTypes: ENTITY_TYPES, chainTypes: CHAIN_TYPES, refStyle: ENTITY_REF_STYLE })
  );

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------
  r.get('/projects', wrap(async (_req, res) => res.json(projects.list())));

  r.post('/projects', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return bad(res, 'Thieu ten project');
    res.json(projects.create({ ...req.body, name, owner: req.user.name }));
  }));

  r.get('/projects/:id', wrap(async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return missing(res, 'project');
    res.json({
      ...p,
      entities: entities.listForProject(p.id).map(withTag),
      videos: videos.listForProject(p.id),
    });
  }));

  r.patch('/projects/:id', wrap(async (req, res) => {
    const p = projects.update(req.params.id, req.body ?? {});
    if (!p) return missing(res, 'project');
    res.json(p);
  }));

  r.delete('/projects/:id', wrap(async (req, res) => {
    projects.remove(req.params.id);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Entity
  // -------------------------------------------------------------------------
  /** Moi entity, de tai dung qua project khac. */
  r.get('/entities', wrap(async (_req, res) => res.json(entities.listAll().map(withTag))));

  r.post('/projects/:id/entities', wrap(async (req, res) => {
    if (!projects.get(req.params.id)) return missing(res, 'project');
    const name = String(req.body?.name || '').trim();
    if (!name) return bad(res, 'Thieu ten');

    const type = req.body?.entity_type ?? 'character';
    if (!ENTITY_TYPES.includes(type)) return bad(res, `entity_type khong hop le: ${type}`);

    res.json(withTag(entities.create({ ...req.body, projectId: req.params.id, name, entity_type: type })));
  }));

  r.patch('/entities/:id', wrap(async (req, res) => {
    const e = entities.update(req.params.id, req.body ?? {});
    if (!e) return missing(res, 'entity');
    res.json(withTag(e));
  }));

  r.delete('/entities/:id', wrap(async (req, res) => {
    entities.remove(req.params.id);
    res.json({ ok: true });
  }));

  /** Gan mot entity da co vao project khac (tai dung ca anh tham chieu). */
  r.post('/projects/:pid/entities/:eid', wrap(async (req, res) => {
    if (!projects.get(req.params.pid)) return missing(res, 'project');
    if (!entities.get(req.params.eid)) return missing(res, 'entity');
    entities.attach(req.params.pid, req.params.eid);
    res.json({ ok: true });
  }));

  r.delete('/projects/:pid/entities/:eid', wrap(async (req, res) => {
    entities.detach(req.params.pid, req.params.eid);
    res.json({ ok: true });
  }));

  /**
   * Sinh anh tham chieu cho mot entity.
   *
   * Description chi la ngoai hinh; quy uoc bo cuc theo loai duoc noi vao day
   * chu khong bat nguoi dung tu go. `material` cua project cung duoc noi vao
   * de moi anh trong project cung mot phong cach.
   */
  r.post('/entities/:id/ref', wrap(async (req, res) => {
    const e = entities.get(req.params.id);
    if (!e) return missing(res, 'entity');
    if (!e.description?.trim()) return bad(res, 'Entity chua co mo ta ngoai hinh');

    // material lay tu project dang mo, hoac tu body neu goi truc tiep
    const project = req.body?.material ? { material: req.body.material } : null;
    const job = enqueue({ ...buildRefPayload(e, project), user: req.user.name });

    entities.update(e.id, { ref_job_id: job.jobId });
    res.json({ job, entity: withTag(entities.get(e.id)) });
  }));

  /**
   * Dung anh CO SAN lam anh tham chieu, thay vi sinh ra.
   *
   * Day la duong duy nhat de dua nguoi that / logo that / san pham that vao
   * pipeline — model khong ve lai duoc cai da ton tai.
   */
  r.post('/entities/:id/ref-upload', rawBody, wrap(async (req, res) => {
    const e = entities.get(req.params.id);
    if (!e) return missing(res, 'entity');

    const { uri, local } = await takeUpload(req, `ref-${e.id}`);
    // ref_job_id = null: anh nay khong den tu job nao, xoa de khoi hien "dang sinh"
    entities.update(e.id, { ref_uri: uri, ref_local: local, ref_job_id: null });
    res.json({ entity: withTag(entities.get(e.id)) });
  }));

  // -------------------------------------------------------------------------
  // Video
  // -------------------------------------------------------------------------
  r.post('/projects/:id/videos', wrap(async (req, res) => {
    if (!projects.get(req.params.id)) return missing(res, 'project');
    const title = String(req.body?.title || '').trim();
    if (!title) return bad(res, 'Thieu tieu de');
    res.json(videos.create({ ...req.body, projectId: req.params.id, title }));
  }));

  r.get('/videos/:id', wrap(async (req, res) => {
    const v = videos.get(req.params.id);
    if (!v) return missing(res, 'video');
    res.json({ ...v, scenes: scenes.listForVideo(v.id) });
  }));

  r.patch('/videos/:id', wrap(async (req, res) => {
    const v = videos.update(req.params.id, req.body ?? {});
    if (!v) return missing(res, 'video');
    res.json(v);
  }));

  r.delete('/videos/:id', wrap(async (req, res) => {
    videos.remove(req.params.id);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Scene
  // -------------------------------------------------------------------------
  r.post('/videos/:id/scenes', wrap(async (req, res) => {
    if (!videos.get(req.params.id)) return missing(res, 'video');
    const chain = req.body?.chain_type ?? 'ROOT';
    if (!CHAIN_TYPES.includes(chain)) return bad(res, `chain_type khong hop le: ${chain}`);
    res.json(scenes.create({ ...req.body, videoId: req.params.id, chain_type: chain }));
  }));

  r.patch('/scenes/:id', wrap(async (req, res) => {
    const s = scenes.update(req.params.id, req.body ?? {});
    if (!s) return missing(res, 'scene');
    res.json(s);
  }));

  r.delete('/scenes/:id', wrap(async (req, res) => {
    scenes.remove(req.params.id);
    res.json({ ok: true });
  }));

  r.post('/videos/:id/scenes/reorder', wrap(async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items)) return bad(res, 'Thieu `items`');
    scenes.reorder(items);
    res.json(scenes.listForVideo(req.params.id));
  }));

  /**
   * Buoc 2: sinh anh khung dau cho mot canh.
   *
   * Anh tham chieu cua cac entity trong canh duoc dua vao `referenceImages`
   * kem `tag`, va prompt goi ho bang @tag. Nho vay nguoi dung khong phai ta
   * lai ngoai hinh - do chinh la thu giu nhan vat nhat quan giua cac canh.
   */
  r.post('/scenes/:id/image', wrap(async (req, res) => {
    const s2 = scenes.get(req.params.id);
    if (!s2) return missing(res, 'scene');
    if (!s2.image_prompt?.trim()) return bad(res, 'Canh chua co mo ta hanh dong');

    const v = videos.get(s2.video_id);
    const p = v ? projects.get(v.project_id) : null;

    // URI cua Runway co han, nen day lai ban goc len truoc khi dung
    await freshSceneRefs(s2);
    const { usedRefs, droppedRefs, ...spec } = buildImagePayload(s2, v, p);

    const job = enqueue({ ...spec, user: req.user.name });
    scenes.update(s2.id, { image_job_id: job.jobId });
    res.json({
      job,
      scene: scenes.get(s2.id),
      usedRefs,
      droppedRefs,
      note: droppedRefs.length
        ? `Runway chỉ nhận ${MAX_REF_IMAGES} ảnh tham chiếu mỗi ảnh — đã bỏ: ${droppedRefs.join(', ')}`
        : undefined,
    });
  }));

  /**
   * Dung anh CO SAN lam anh khung dau, bo qua buoc sinh anh.
   * Tiet kiem 2-8 credit moi canh, va cho phep tu chon khung mo dau.
   */
  r.post('/scenes/:id/image-upload', rawBody, wrap(async (req, res) => {
    const sc = scenes.get(req.params.id);
    if (!sc) return missing(res, 'scene');

    const { uri, local } = await takeUpload(req, `frame-${sc.id}`);
    scenes.update(sc.id, { image_uri: uri, image_local: local, image_job_id: null });
    res.json({ scene: scenes.get(sc.id) });
  }));

  /** Buoc 3: sinh clip tu anh khung dau cua canh. */
  r.post('/scenes/:id/video', wrap(async (req, res) => {
    const s2 = scenes.get(req.params.id);
    if (!s2) return missing(res, 'scene');
    if (!s2.image_uri) return bad(res, 'Canh chua co anh khung dau — sinh anh truoc');

    const v = videos.get(s2.video_id);
    const prompt = (s2.video_prompt || s2.image_prompt || '').trim();
    if (!prompt) return bad(res, 'Canh chua co mo ta chuyen dong');

    const fresh = await freshSceneImage(s2);
    const job = enqueue({ ...buildVideoPayload(fresh, v), user: req.user.name });
    scenes.update(s2.id, { video_job_id: job.jobId });
    res.json({ job, scene: scenes.get(s2.id) });
  }));

  // -------------------------------------------------------------------------
  // Lenh hang loat — tuong duong cac skill cua Flow Kit
  // -------------------------------------------------------------------------

  /** Trang thai pipeline: xong gi, con gi, buoc tiep la gi. */
  r.get('/videos/:id/status', wrap(async (req, res) => {
    const st = videoStatus(req.params.id);
    if (!st) return missing(res, 'video');
    res.json({ ...st, ffmpeg: await hasFfmpeg() });
  }));

  /**
   * Uoc tinh credit cho phan CON LAI cua video.
   *
   * Tinh o server de CLI va giao dien khong bao giờ lech con so. Chi tinh
   * viec chua lam — da co anh tham chieu thi khong tinh lai.
   */
  r.get('/videos/:id/cost', wrap(async (req, res) => {
    const v = videos.get(req.params.id);
    if (!v) return missing(res, 'video');
    const p = projects.get(v.project_id);
    res.json(
      estimateVideo({
        video: v,
        scenes: scenes.listForVideo(v.id),
        entities: p ? entities.listForProject(p.id) : [],
        refModel: REF_IMAGE_MODEL,
        sceneImageModel: SCENE_IMAGE_MODEL,
        refRatioOf: (e) => (ENTITY_REF_STYLE[e.entity_type] ?? ENTITY_REF_STYLE.other).ratio,
      })
    );
  }));

  /** Sinh anh tham chieu cho MOI entity chua co. */
  r.post('/projects/:id/gen-refs', wrap(async (req, res) => {
    res.json(
      await genAllRefs(req.params.id, {
        enqueue,
        user: req.user.name,
        buildRefPayload,
      })
    );
  }));

  /**
   * Sinh anh khung dau cho MOI canh chua co.
   * Chan lai neu entity duoc dung trong canh chua co anh tham chieu.
   */
  r.post('/videos/:id/gen-images', wrap(async (req, res) => {
    res.json(
      await genAllImages(req.params.id, {
        enqueue,
        user: req.user.name,
        force: req.body?.force === true,
        refresh: freshSceneRefs,
        buildImagePayload: (sc, v, p) => {
          const { usedRefs, droppedRefs, ...spec } = buildImagePayload(sc, v, p);
          return spec;
        },
      })
    );
  }));

  /** Sinh clip cho MOI canh da co anh khung dau. */
  r.post('/videos/:id/gen-clips', wrap(async (req, res) => {
    res.json(
      await genAllClips(req.params.id, {
        enqueue,
        user: req.user.name,
        refresh: freshSceneImage,
        buildVideoPayload,
      })
    );
  }));

  /** Ghep cac clip thanh mot video bang ffmpeg. */
  r.post('/videos/:id/concat', wrap(async (req, res) => {
    res.json(await concatVideo(req.params.id, { outDir }));
  }));

  return r;
}

/**
 * Goi khi mot job trong hang doi ket thuc.
 *
 * Tim xem job do thuoc entity hay canh nao roi ghi ket qua vao store. Tai
 * ve luon vi link cua Runway co han (~48h), ma anh tham chieu thi phai dung
 * lai nhieu lan sau do.
 */
export async function onJobFinished(job, { download }) {
  if (job.state !== 'SUCCEEDED') return;
  const url = job.output?.[0];
  if (!url) return;

  const ent = entityByJob(job.jobId);
  if (ent) {
    let local = null;
    try {
      local = `/outputs/${await download(url, job.jobId, 0)}`;
    } catch (e) {
      console.warn(`[pipeline] tai anh tham chieu that bai: ${e.message}`);
    }
    entities.update(ent.id, { ref_uri: url, ref_local: local });
    return;
  }

  const sc = sceneByJob(job.jobId);
  if (!sc) return;

  let local = null;
  try {
    local = `/outputs/${await download(url, job.jobId, 0)}`;
  } catch (e) {
    console.warn(`[pipeline] tai ket qua canh that bai: ${e.message}`);
  }

  if (sc.slot === 'image') scenes.update(sc.id, { image_uri: url, image_local: local });
  else scenes.update(sc.id, { video_uri: url, video_local: local });
}
