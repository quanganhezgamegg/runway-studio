/**
 * Trang thai giao dien.
 *
 * Diem mau chot: `outputKind` + `attachments` la nguon su that.
 * Endpoint va danh sach model KHONG luu trong store - chung duoc suy ra
 * mien phi tu hai thu tren (xem selectTargets). Nho vay khong bao gio co
 * chuyen store giu mot model khong hop le voi input hien tai.
 */
import { create } from 'zustand';
import type { AssetKind, AttachedAsset, Catalog, Endpoint, FormValues, OutputKind, Target } from '@/lib/catalog';
import { resolveTargets, sanitizeTag, TAG_MAX } from '@/lib/catalog';

interface State {
  catalog: Catalog | null;
  outputKind: OutputKind;
  /** Khi chon mot cong cu chuyen biet (Upscale, recipe…) thi bo qua suy luan. */
  toolPath: string | null;
  attachments: AttachedAsset[];
  lastFrame: AttachedAsset | null;
  prompt: string;
  modelName: string | null;
  values: FormValues;
  uploading: number;

  setCatalog: (c: Catalog) => void;
  setOutputKind: (k: OutputKind) => void;
  setTool: (path: string | null) => void;
  addAttachment: (a: AttachedAsset) => void;
  removeAttachment: (uri: string) => void;
  setAttachmentTag: (uri: string, tag: string) => void;
  setLastFrame: (a: AttachedAsset | null) => void;
  setPrompt: (p: string) => void;
  /** Tra ve ten cac tham so bi bo vi khong con hop le voi model moi. */
  setModel: (m: string) => string[];
  setValue: (name: string, v: unknown) => void;
  resetValues: () => void;
  beginUpload: () => void;
  endUpload: () => void;
  loadFrom: (path: string, model: string, payload: Record<string, unknown>) => void;
}

/**
 * Sinh nhan khong trung voi cac nhan dang co.
 * Trung thi them so vao cuoi, van giu trong gioi han 16 ky tu cua spec.
 */
function uniqueTag(name: string, existing: AttachedAsset[]): string {
  const taken = new Set(existing.map((a) => a.tag).filter(Boolean) as string[]);
  const base = sanitizeTag(name);
  if (!taken.has(base)) return base;

  for (let i = 2; i < 100; i++) {
    const suffix = String(i);
    const candidate = base.slice(0, TAG_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

export const useStore = create<State>((set, get) => ({
  catalog: null,
  outputKind: 'video',
  toolPath: null,
  attachments: [],
  lastFrame: null,
  prompt: '',
  modelName: null,
  values: {},
  uploading: 0,

  setCatalog: (catalog) => set({ catalog }),

  // Doi loai ket qua -> model cu gan nhu chac chan khong con hop le
  setOutputKind: (outputKind) => set({ outputKind, toolPath: null, modelName: null, values: {} }),

  setTool: (toolPath) => set({ toolPath, modelName: null, values: {} }),

  addAttachment: (a) =>
    set((s) => {
      const others = s.attachments.filter((x) => x.uri !== a.uri);
      return {
        attachments: [...others, { ...a, tag: a.tag ?? uniqueTag(a.name, others) }],
        // Them file co the doi endpoint duoc suy ra -> bo model cu
        modelName: null,
      };
    }),

  removeAttachment: (uri) =>
    set((s) => ({
      attachments: s.attachments.filter((x) => x.uri !== uri),
      modelName: null,
    })),

  setAttachmentTag: (uri, tag) =>
    set((s) => ({
      attachments: s.attachments.map((a) => (a.uri === uri ? { ...a, tag } : a)),
    })),

  setLastFrame: (lastFrame) => set({ lastFrame }),
  setPrompt: (prompt) => set({ prompt }),
  /**
   * Doi model. Giu lai nhung gia tri VAN con hop le thay vi xoa sach, va tra
   * ve danh sach da bo de giao dien bao cho nguoi dung biet da doi gi
   * (muc D2 cua tai lieu).
   */
  setModel: (modelName) => {
    const s = get();
    const next = selectTargets({ ...s, modelName }).find((t) => t.variant.model === modelName);
    if (!next) {
      set({ modelName, values: {} });
      return [];
    }

    const kept: FormValues = {};
    const dropped: string[] = [];

    for (const [name, value] of Object.entries(s.values)) {
      const f = next.variant.fields.find((x) => x.name === name);
      if (!f) {
        dropped.push(name);
        continue;
      }
      // Gia tri nam ngoai danh sach cho phep -> bo
      if (f.control === 'select' && f.options && !f.options.includes(String(value)) && !f.allowCustom) {
        dropped.push(name);
        continue;
      }
      if (f.control === 'number' && typeof value === 'number') {
        if ((f.min != null && value < f.min) || (f.max != null && value > f.max)) {
          dropped.push(name);
          continue;
        }
      }
      kept[name] = value;
    }

    set({ modelName, values: kept });
    return dropped;
  },
  setValue: (name, v) => set((s) => ({ values: { ...s.values, [name]: v } })),
  resetValues: () => set({ values: {} }),

  beginUpload: () => set((s) => ({ uploading: s.uploading + 1 })),
  endUpload: () => set((s) => ({ uploading: Math.max(0, s.uploading - 1) })),

  /** "Dùng lại": nap prompt + tham so tu mot job cu. */
  loadFrom: (path, model, payload) => {
    const catalog = get().catalog;
    const ep = catalog?.endpoints.find((e) => e.path === path);
    if (!ep) return;

    const kind: OutputKind | null =
      ep.kind === 'video' ? 'video' : ep.kind === 'image' ? 'image' : ep.kind === 'audio' ? 'audio' : null;

    // Bo cac field asset ra khoi values - chung song o `attachments`
    const variant = ep.models.find((m) => m.model === model);
    const assetNames = new Set(
      (variant?.fields ?? [])
        .filter((f) => f.control === 'asset' || f.control === 'asset-list')
        .map((f) => f.name)
    );
    const values: FormValues = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'model' || assetNames.has(k)) continue;
      values[k] = v;
    }

    set({
      outputKind: kind ?? get().outputKind,
      toolPath: kind ? null : path,
      modelName: model,
      prompt: typeof payload.promptText === 'string' ? payload.promptText : '',
      values,
    });
  },
}));

// ---------------------------------------------------------------------------
// Selector suy ra - khong luu trong store
// ---------------------------------------------------------------------------

/** Tap loai asset dang dinh kem. */
export function attachedKinds(attachments: AttachedAsset[]): Set<AssetKind> {
  return new Set(attachments.map((a) => a.kind));
}

/** Moi to hop (endpoint, model) hop le voi input hien tai. */
export function selectTargets(s: State): Target[] {
  if (!s.catalog) return [];

  // Cong cu chuyen biet: khong suy ra, lay thang endpoint do
  if (s.toolPath) {
    const ep = s.catalog.endpoints.find((e) => e.path === s.toolPath);
    if (!ep) return [];
    return ep.models.map((variant) => ({ endpoint: ep, variant, score: 0 }));
  }

  return resolveTargets(s.catalog, s.outputKind, attachedKinds(s.attachments));
}

/** To hop dang duoc chon (theo modelName, mac dinh la cai dau tien). */
export function selectActive(s: State): Target | null {
  const targets = selectTargets(s);
  if (!targets.length) return null;
  if (s.modelName) {
    const hit = targets.find((t) => t.variant.model === s.modelName);
    if (hit) return hit;
  }
  return targets[0] ?? null;
}

/** Cac endpoint chuyen biet hien o nhom "Công cụ". */
export function selectTools(catalog: Catalog | null): Endpoint[] {
  if (!catalog) return [];
  return catalog.endpoints.filter(
    (e) => e.kind === 'enhance' || e.kind === 'recipe' || e.kind === 'other'
  );
}
