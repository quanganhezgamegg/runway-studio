/** Lop goi API cho tang project / entity / video / scene. */

export type EntityType = 'character' | 'location' | 'creature' | 'visual_asset' | 'other';
export type ChainType = 'ROOT' | 'CONTINUATION';

export interface Project {
  id: string;
  name: string;
  story: string;
  /** Phong cach hinh anh dung cho MOI anh trong project, giu style nhat quan. */
  material: string;
  orientation: 'HORIZONTAL' | 'VERTICAL';
  owner: string;
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  /** CHI mo ta ngoai hinh - day la thu sinh ra anh tham chieu. */
  description: string;
  voice_description: string;
  ref_uri: string | null;
  ref_local: string | null;
  ref_job_id: string | null;
  /** Nhan goi trong prompt, suy tu ten. */
  tag: string;
}

export interface Video {
  id: string;
  project_id: string;
  title: string;
  ratio: string;
  model: string;
  final_local: string | null;
}

export interface Scene {
  id: string;
  video_id: string;
  display_order: number;
  /** Mo ta HANH DONG cho khung hinh dau. */
  image_prompt: string;
  /** Mo ta chuyen dong, nen co moc thoi gian va goc may. */
  video_prompt: string;
  duration: number;
  chain_type: ChainType;
  parent_scene_id: string | null;
  image_uri: string | null;
  image_local: string | null;
  image_job_id: string | null;
  video_uri: string | null;
  video_local: string | null;
  video_job_id: string | null;
  entity_ids: string[];
}

export interface ProjectDetail extends Project {
  entities: Entity[];
  videos: Video[];
}

export interface VideoDetail extends Video {
  scenes: Scene[];
}

export interface RefStyle {
  ratio: string;
  extra: string;
}

const B = '/api/pipeline';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(B + path, { credentials: 'same-origin', ...init });
  const type = res.headers.get('content-type') ?? '';
  const body: unknown = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Lỗi ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

const send = <T>(path: string, method: string, data?: unknown) =>
  req<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

export const pipe = {
  meta: () =>
    req<{ entityTypes: EntityType[]; chainTypes: ChainType[]; refStyle: Record<string, RefStyle> }>(
      '/meta'
    ),

  // --- Project ---
  projects: () => req<Project[]>('/projects'),
  project: (id: string) => req<ProjectDetail>(`/projects/${id}`),
  createProject: (data: Partial<Project>) => send<Project>('/projects', 'POST', data),
  updateProject: (id: string, data: Partial<Project>) => send<Project>(`/projects/${id}`, 'PATCH', data),
  deleteProject: (id: string) => send<{ ok: true }>(`/projects/${id}`, 'DELETE'),

  // --- Entity ---
  allEntities: () => req<Entity[]>('/entities'),
  createEntity: (projectId: string, data: Partial<Entity>) =>
    send<Entity>(`/projects/${projectId}/entities`, 'POST', data),
  updateEntity: (id: string, data: Partial<Entity>) => send<Entity>(`/entities/${id}`, 'PATCH', data),
  deleteEntity: (id: string) => send<{ ok: true }>(`/entities/${id}`, 'DELETE'),
  attachEntity: (projectId: string, entityId: string) =>
    send<{ ok: true }>(`/projects/${projectId}/entities/${entityId}`, 'POST'),

  /** Buoc 1: sinh anh tham chieu. `material` cua project duoc noi vao prompt. */
  genRef: (entityId: string, material: string) =>
    send<{ entity: Entity }>(`/entities/${entityId}/ref`, 'POST', { material }),

  // --- Video ---
  video: (id: string) => req<VideoDetail>(`/videos/${id}`),
  createVideo: (projectId: string, data: Partial<Video>) =>
    send<Video>(`/projects/${projectId}/videos`, 'POST', data),
  updateVideo: (id: string, data: Partial<Video>) => send<Video>(`/videos/${id}`, 'PATCH', data),
  deleteVideo: (id: string) => send<{ ok: true }>(`/videos/${id}`, 'DELETE'),

  // --- Scene ---
  createScene: (videoId: string, data: Partial<Scene>) =>
    send<Scene>(`/videos/${videoId}/scenes`, 'POST', data),
  updateScene: (id: string, data: Partial<Scene>) => send<Scene>(`/scenes/${id}`, 'PATCH', data),
  deleteScene: (id: string) => send<{ ok: true }>(`/scenes/${id}`, 'DELETE'),
  reorder: (videoId: string, items: { id: string; display_order: number }[]) =>
    send<Scene[]>(`/videos/${videoId}/scenes/reorder`, 'POST', { items }),

  /** Buoc 2: sinh anh khung dau, dung anh tham chieu cua entity trong canh. */
  genSceneImage: (sceneId: string) =>
    send<{ scene: Scene; usedRefs: string[] }>(`/scenes/${sceneId}/image`, 'POST', {}),

  /** Buoc 3: sinh clip tu anh khung dau. */
  genSceneVideo: (sceneId: string) => send<{ scene: Scene }>(`/scenes/${sceneId}/video`, 'POST', {}),

  // --- Lenh hang loat, tuong duong cac skill cua Flow Kit ---

  /** Trang thai pipeline: xong gi, con gi, buoc tiep la gi. */
  status: (videoId: string) => req<PipelineStatus>(`/videos/${videoId}/status`),

  genAllRefs: (projectId: string) =>
    send<BatchResult>(`/projects/${projectId}/gen-refs`, 'POST', {}),

  /** force=true bo qua kiem tra "entity phai co anh tham chieu truoc". */
  genAllImages: (videoId: string, force = false) =>
    send<BatchResult>(`/videos/${videoId}/gen-images`, 'POST', { force }),

  genAllClips: (videoId: string) => send<BatchResult>(`/videos/${videoId}/gen-clips`, 'POST', {}),

  concat: (videoId: string) =>
    send<{ final: string; parts: number; skipped: number[]; note?: string }>(
      `/videos/${videoId}/concat`,
      'POST',
      {}
    ),
};

export interface StepCount {
  done: number;
  pending: number;
  total: number;
}

export interface PipelineStatus {
  video: Video;
  refs: StepCount;
  images: StepCount;
  clips: StepCount;
  /** Buoc dau tien chua xong het. */
  next: 'refs' | 'images' | 'clips' | 'concat' | 'done';
  totalDuration: number;
  /** So viec SAN SANG chay o tung buoc (du dieu kien, chua gui). */
  ready: { refs: number; images: number; clips: number };
  ffmpeg: boolean;
}

export interface BatchResult {
  queued: { jobId: string; entity?: string; scene?: number }[];
  skipped?: (string | number)[];
  warnedMissingRefs?: string[];
  note?: string;
}

// ---------------------------------------------------------------------------
/** Nhan doc duoc cho tung loai thuc the. */
export const ENTITY_LABEL: Record<EntityType, string> = {
  character: 'Nhân vật',
  location: 'Bối cảnh',
  creature: 'Sinh vật',
  visual_asset: 'Đạo cụ',
  other: 'Khác',
};

/** Trang thai mot buoc cua pipeline, suy tu du lieu chu khong luu rieng. */
export type StepState = 'empty' | 'pending' | 'done';

export const entityStep = (e: Entity): StepState =>
  e.ref_uri ? 'done' : e.ref_job_id ? 'pending' : 'empty';

export const imageStep = (s: Scene): StepState =>
  s.image_uri ? 'done' : s.image_job_id ? 'pending' : 'empty';

export const videoStep = (s: Scene): StepState =>
  s.video_uri ? 'done' : s.video_job_id ? 'pending' : 'empty';

/** Dem tien do cua mot buoc tren ca danh sach. */
export function progress<T>(items: T[], step: (x: T) => StepState) {
  const done = items.filter((x) => step(x) === 'done').length;
  const pending = items.filter((x) => step(x) === 'pending').length;
  return { done, pending, total: items.length };
}
