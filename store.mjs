/**
 * Lop luu tru cho pipeline nhieu canh.
 *
 * Runway API khong co project / folder / asset library (da doi chieu tren toan
 * bo 49 path cua spec). Muon lam video nhieu canh giu duoc nhan vat nhat quan
 * thi phai tu dung tang du lieu nay o phia minh.
 *
 * Mo hinh lay tu Flow Kit (github.com/crisng95/flowkit), chay tren API Runway
 * chinh thuc thay vi API noi bo cua Google Flow:
 *
 *   project ──┬── entity (nhan vat / dia diem / dao cu)  -> anh tham chieu
 *             └── video ── scene (chuoi canh)            -> anh + clip
 *
 * Diem mau chot muon tu Flow Kit: entity la thuc the DOC LAP, khong thuoc
 * project. Mot nhan vat dung lai duoc qua nhieu project. Neu gan cung vao
 * project thi moi lan lam video moi lai phai tao lai nhan vat va anh tham
 * chieu - mat ca tien lan tinh nhat quan.
 *
 * Dung node:sqlite co san trong Node 22.5+ nen khong them dependency nao,
 * va Docker khong phai build native module.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const newId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const now = () => new Date().toISOString();

/** Loai thuc the. Bon loai dau co quy uoc bo cuc anh tham chieu rieng. */
export const ENTITY_TYPES = ['character', 'location', 'creature', 'visual_asset', 'other'];

export const CHAIN_TYPES = ['ROOT', 'CONTINUATION'];

/**
 * Quy uoc bo cuc anh tham chieu theo tung loai thuc the.
 *
 * Lay tu Flow Kit. Ly do quan trong: anh tham chieu cua nhan vat phai la
 * toan than chinh dien tren nen trong, vi model se doc dac diem tu do. Neu
 * anh tham chieu la mot canh co boi canh phuc tap thi boi canh do se ro ri
 * sang moi canh dung nhan vat nay.
 *
 * `extra` duoc noi vao description khi sinh anh tham chieu.
 */
export const ENTITY_REF_STYLE = {
  character: {
    ratio: '720:1280',
    extra: 'full body head-to-toe, front-facing, centered, neutral plain studio background, even lighting, single subject only',
  },
  creature: {
    ratio: '720:1280',
    extra: 'full body, natural stance, distinctive features clearly visible, plain background',
  },
  location: {
    ratio: '1280:720',
    extra: 'establishing wide shot, level horizon, atmospheric lighting, no people in frame',
  },
  visual_asset: {
    ratio: '720:1280',
    extra: 'detailed view, clear textures, plain background, single object centered',
  },
  other: {
    ratio: '1024:1024',
    extra: 'clear centered view, plain background',
  },
};

/**
 * Model sinh anh:
 *   - Anh tham chieu: gen4_image. KHONG dung duoc turbo vi turbo BAT BUOC
 *     co referenceImages, ma luc tao anh tham chieu thi chua co ref nao.
 *   - Anh canh: gen4_image_turbo (2 cr/anh, re hon gen4_image 5-8 cr) vi luc
 *     nay da co anh tham chieu cua entity de truyen vao.
 */
export const REF_IMAGE_MODEL = 'gen4_image';
export const SCENE_IMAGE_MODEL = 'gen4_image_turbo';

/** Nhan hop le cho @tag: 3-16 ky tu, bat dau bang chu thuong. */
export function entityTag(name) {
  let t = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[dđ]/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_{2,}/g, '_')
    .replace(/_+$/, '')
    .slice(0, 16);
  if (t.length < 3) t = `ref${t}`.slice(0, 16);
  return t;
}

let db = null;

export function openStore(dataDir) {
  db = new DatabaseSync(join(dataDir, 'studio.db'));

  // WAL cho phep doc trong khi dang ghi - can vi worker poll task lien tuc
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      story       TEXT DEFAULT '',
      -- Phong cach hinh anh dung cho MOI anh trong project, de ca video
      -- khong bi lech style giua cac canh
      material    TEXT DEFAULT '',
      orientation TEXT DEFAULT 'HORIZONTAL',
      owner       TEXT DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      entity_type       TEXT NOT NULL DEFAULT 'character',
      -- CHI mo ta ngoai hinh. Day la thu sinh ra anh tham chieu, nen tron
      -- hanh dong vao se lam anh tham chieu sai muc dich.
      description       TEXT DEFAULT '',
      voice_description TEXT DEFAULT '',
      -- Anh tham chieu: uri cua Runway (co han) va ban da tai ve (khong han)
      ref_uri           TEXT,
      ref_local         TEXT,
      ref_job_id        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    -- Entity doc lap nen can bang lien ket M:N
    CREATE TABLE IF NOT EXISTS project_entity (
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      entity_id  TEXT NOT NULL REFERENCES entity(id)  ON DELETE CASCADE,
      PRIMARY KEY (project_id, entity_id)
    );

    CREATE TABLE IF NOT EXISTS video (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      ratio      TEXT DEFAULT '1280:720',
      -- Model dung cho moi canh cua video nay, giu nhat quan
      model      TEXT DEFAULT 'gen4_turbo',
      -- File cuoi sau khi ghep bang ffmpeg
      final_local TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scene (
      id            TEXT PRIMARY KEY,
      video_id      TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
      display_order INTEGER NOT NULL DEFAULT 0,
      -- Hai prompt tach biet:
      --   image_prompt = khung hinh dau, ta HANH DONG (khong ta lai ngoai hinh)
      --   video_prompt = chuyen dong 8 giay, co moc thoi gian va goc may
      image_prompt  TEXT DEFAULT '',
      video_prompt  TEXT DEFAULT '',
      duration      INTEGER DEFAULT 8,
      chain_type    TEXT DEFAULT 'ROOT',
      parent_scene_id TEXT REFERENCES scene(id) ON DELETE SET NULL,
      -- Ket qua tung buoc
      image_uri     TEXT,
      image_local   TEXT,
      image_job_id  TEXT,
      video_uri     TEXT,
      video_local   TEXT,
      video_job_id  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- Entity nao xuat hien trong canh nay -> anh tham chieu cua chung duoc
    -- dua vao khi sinh anh canh
    CREATE TABLE IF NOT EXISTS scene_entity (
      scene_id  TEXT NOT NULL REFERENCES scene(id)  ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      PRIMARY KEY (scene_id, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_video_project ON video(project_id);
    CREATE INDEX IF NOT EXISTS idx_scene_video   ON scene(video_id, display_order);
  `);

  return db;
}

const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------
export const projects = {
  list: () => all('SELECT * FROM project ORDER BY updated_at DESC'),

  get(id) {
    return db.prepare('SELECT * FROM project WHERE id = ?').get(id) ?? null;
  },

  create({ name, story = '', material = '', orientation = 'HORIZONTAL', owner = '' }) {
    const id = newId('p');
    const t = now();
    run(
      `INSERT INTO project (id, name, story, material, orientation, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, story, material, orientation, owner, t, t
    );
    return projects.get(id);
  },

  update(id, patch) {
    const cur = projects.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated_at: now() };
    run(
      `UPDATE project SET name=?, story=?, material=?, orientation=?, updated_at=? WHERE id=?`,
      next.name, next.story, next.material, next.orientation, next.updated_at, id
    );
    return projects.get(id);
  },

  remove(id) {
    run('DELETE FROM project WHERE id = ?', id);
  },
};

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------
export const entities = {
  /** Entity cua mot project (qua bang lien ket). */
  listForProject(projectId) {
    return all(
      `SELECT e.* FROM entity e
         JOIN project_entity pe ON pe.entity_id = e.id
        WHERE pe.project_id = ?
        ORDER BY e.entity_type, e.name`,
      projectId
    );
  },

  /** Moi entity, de tai dung qua project khac. */
  listAll: () => all('SELECT * FROM entity ORDER BY entity_type, name'),

  get(id) {
    return db.prepare('SELECT * FROM entity WHERE id = ?').get(id) ?? null;
  },

  create({ projectId, name, entity_type = 'character', description = '', voice_description = '' }) {
    const id = newId('e');
    const t = now();
    run(
      `INSERT INTO entity (id, name, entity_type, description, voice_description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, name, entity_type, description, voice_description, t, t
    );
    if (projectId) entities.attach(projectId, id);
    return entities.get(id);
  },

  update(id, patch) {
    const cur = entities.get(id);
    if (!cur) return null;
    const n = { ...cur, ...patch, updated_at: now() };
    run(
      `UPDATE entity SET name=?, entity_type=?, description=?, voice_description=?,
              ref_uri=?, ref_local=?, ref_job_id=?, updated_at=? WHERE id=?`,
      n.name, n.entity_type, n.description, n.voice_description,
      n.ref_uri ?? null, n.ref_local ?? null, n.ref_job_id ?? null, n.updated_at, id
    );
    return entities.get(id);
  },

  attach(projectId, entityId) {
    run(
      'INSERT OR IGNORE INTO project_entity (project_id, entity_id) VALUES (?, ?)',
      projectId, entityId
    );
  },

  detach(projectId, entityId) {
    run('DELETE FROM project_entity WHERE project_id = ? AND entity_id = ?', projectId, entityId);
  },

  remove(id) {
    run('DELETE FROM entity WHERE id = ?', id);
  },
};

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------
export const videos = {
  listForProject(projectId) {
    return all('SELECT * FROM video WHERE project_id = ? ORDER BY created_at DESC', projectId);
  },

  get(id) {
    return db.prepare('SELECT * FROM video WHERE id = ?').get(id) ?? null;
  },

  create({ projectId, title, ratio = '1280:720', model = 'gen4_turbo' }) {
    const id = newId('v');
    const t = now();
    run(
      `INSERT INTO video (id, project_id, title, ratio, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, projectId, title, ratio, model, t, t
    );
    return videos.get(id);
  },

  update(id, patch) {
    const cur = videos.get(id);
    if (!cur) return null;
    const n = { ...cur, ...patch, updated_at: now() };
    run(
      'UPDATE video SET title=?, ratio=?, model=?, final_local=?, updated_at=? WHERE id=?',
      n.title, n.ratio, n.model, n.final_local ?? null, n.updated_at, id
    );
    return videos.get(id);
  },

  remove(id) {
    run('DELETE FROM video WHERE id = ?', id);
  },
};

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
export const scenes = {
  listForVideo(videoId) {
    const rows = all(
      'SELECT * FROM scene WHERE video_id = ? ORDER BY display_order, created_at',
      videoId
    );
    // Kem danh sach entity cua tung canh de frontend khong phai goi N+1 lan
    for (const s of rows) s.entity_ids = scenes.entityIds(s.id);
    return rows;
  },

  get(id) {
    const s = db.prepare('SELECT * FROM scene WHERE id = ?').get(id) ?? null;
    if (s) s.entity_ids = scenes.entityIds(id);
    return s;
  },

  entityIds(sceneId) {
    return all('SELECT entity_id FROM scene_entity WHERE scene_id = ?', sceneId)
      .map((r) => r.entity_id);
  },

  create({ videoId, display_order = null, image_prompt = '', video_prompt = '',
           duration = 8, chain_type = 'ROOT', parent_scene_id = null, entity_ids = [] }) {
    const id = newId('s');
    const t = now();

    // Khong truyen thu tu thi xep cuoi
    const order = display_order ?? (
      db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM scene WHERE video_id = ?')
        .get(videoId)?.n ?? 0
    );

    run(
      `INSERT INTO scene (id, video_id, display_order, image_prompt, video_prompt,
                          duration, chain_type, parent_scene_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, videoId, order, image_prompt, video_prompt, duration, chain_type, parent_scene_id, t, t
    );
    scenes.setEntities(id, entity_ids);
    return scenes.get(id);
  },

  update(id, patch) {
    const cur = scenes.get(id);
    if (!cur) return null;
    const n = { ...cur, ...patch, updated_at: now() };
    run(
      `UPDATE scene SET display_order=?, image_prompt=?, video_prompt=?, duration=?,
              chain_type=?, parent_scene_id=?, image_uri=?, image_local=?, image_job_id=?,
              video_uri=?, video_local=?, video_job_id=?, updated_at=? WHERE id=?`,
      n.display_order, n.image_prompt, n.video_prompt, n.duration,
      n.chain_type, n.parent_scene_id ?? null,
      n.image_uri ?? null, n.image_local ?? null, n.image_job_id ?? null,
      n.video_uri ?? null, n.video_local ?? null, n.video_job_id ?? null,
      n.updated_at, id
    );
    if (Array.isArray(patch.entity_ids)) scenes.setEntities(id, patch.entity_ids);
    return scenes.get(id);
  },

  setEntities(sceneId, entityIds) {
    run('DELETE FROM scene_entity WHERE scene_id = ?', sceneId);
    const ins = db.prepare('INSERT OR IGNORE INTO scene_entity (scene_id, entity_id) VALUES (?, ?)');
    for (const eid of entityIds ?? []) ins.run(sceneId, eid);
  },

  /** Doi thu tu hang loat: [{id, display_order}] */
  reorder(items) {
    const upd = db.prepare('UPDATE scene SET display_order = ?, updated_at = ? WHERE id = ?');
    const t = now();
    for (const it of items) upd.run(it.display_order, t, it.id);
  },

  remove(id) {
    run('DELETE FROM scene WHERE id = ?', id);
  },
};

/** Tim canh theo job da gui, de cap nhat ket qua khi task xong. */
export function sceneByJob(jobId) {
  return (
    db.prepare('SELECT *, \'image\' AS slot FROM scene WHERE image_job_id = ?').get(jobId) ??
    db.prepare('SELECT *, \'video\' AS slot FROM scene WHERE video_job_id = ?').get(jobId) ??
    null
  );
}

export function entityByJob(jobId) {
  return db.prepare('SELECT * FROM entity WHERE ref_job_id = ?').get(jobId) ?? null;
}
