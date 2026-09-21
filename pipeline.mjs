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
export function buildImagePayload(s, video, project) {
  const refs = s.entity_ids
    .map((id) => entities.get(id))
    .filter((e) => e?.ref_uri)
    .map((e) => ({ uri: e.ref_uri, tag: entityTag(e.name) }));

  // gen4_image_turbo BAT BUOC co referenceImages. Khong co ref nao thi phai
  // lui ve gen4_image, dat hon nhung khong bi tu choi.
  const model = refs.length ? SCENE_IMAGE_MODEL : REF_IMAGE_MODEL;
  const promptText = [s.image_prompt.trim(), project?.material?.trim()]
    .filter(Boolean)
    .join('. ');

  const payload = { model, promptText, ratio: video?.ratio || '1280:720' };
  if (refs.length) payload.referenceImages = refs;

  return {
    path: '/v1/text_to_image',
    payload,
    title: `Canh ${s.display_order + 1}: anh`,
    usedRefs: refs.map((r) => r.tag),
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

export function pipelineRouter({ enqueue, outDir }) {
  const r = express.Router();

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) =>
      res.status(e.status || 500).json({ error: e.message, details: e.details ?? null })
    );

  const bad = (res, msg) => res.status(400).json({ error: msg });
  const missing = (res, what) => res.status(404).json({ error: `Khong tim thay ${what}` });

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
    const { usedRefs, ...spec } = buildImagePayload(s2, v, p);

    const job = enqueue({ ...spec, user: req.user.name });
    scenes.update(s2.id, { image_job_id: job.jobId });
    res.json({ job, scene: scenes.get(s2.id), usedRefs });
  }));

  /** Buoc 3: sinh clip tu anh khung dau cua canh. */
  r.post('/scenes/:id/video', wrap(async (req, res) => {
    const s2 = scenes.get(req.params.id);
    if (!s2) return missing(res, 'scene');
    if (!s2.image_uri) return bad(res, 'Canh chua co anh khung dau — sinh anh truoc');

    const v = videos.get(s2.video_id);
    const prompt = (s2.video_prompt || s2.image_prompt || '').trim();
    if (!prompt) return bad(res, 'Canh chua co mo ta chuyen dong');

    const job = enqueue({ ...buildVideoPayload(s2, v), user: req.user.name });
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

  /** Sinh anh tham chieu cho MOI entity chua co. */
  r.post('/projects/:id/gen-refs', wrap(async (req, res) => {
    res.json(
      genAllRefs(req.params.id, {
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
      genAllImages(req.params.id, {
        enqueue,
        user: req.user.name,
        force: req.body?.force === true,
        buildImagePayload: (sc, v, p) => {
          const { usedRefs, ...spec } = buildImagePayload(sc, v, p);
          return spec;
        },
      })
    );
  }));

  /** Sinh clip cho MOI canh da co anh khung dau. */
  r.post('/videos/:id/gen-clips', wrap(async (req, res) => {
    res.json(
      genAllClips(req.params.id, {
        enqueue,
        user: req.user.name,
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
