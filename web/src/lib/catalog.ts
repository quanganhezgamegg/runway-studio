/**
 * Catalog + logic suy ra endpoint.
 *
 * Quyet dinh thiet ke cot loi: nguoi dung KHONG chon endpoint.
 * Ho chon "muon ra gi" (video / anh / am thanh) va dinh kem file.
 * Tu hai thu do suy ra endpoint nao duoc goi va model nao hop le.
 *
 * Toan bo suy luan doc tu catalog.json (sinh tu OpenAPI spec), khong hard-code
 * duong dan. Runway them model moi -> chay lai `npm run catalog` la co, khong sua file nay.
 */

// ---------------------------------------------------------------------------
// Kieu du lieu cua catalog
// ---------------------------------------------------------------------------
export type Control =
  | 'text' | 'textarea' | 'select' | 'number' | 'boolean'
  | 'asset' | 'asset-list' | 'json';

export type AssetKind = 'image' | 'video' | 'audio' | 'file';

/** Nhanh cua asset boc trong object co the: { type: 'image', uri } */
export interface AssetVariant {
  type: string | null;
  asset: AssetKind;
  required: string[];
}

export interface Field {
  name: string;
  required: boolean;
  description: string;
  control: Control;
  options?: string[];
  allowCustom?: boolean;
  hint?: 'ratio';
  min?: number | null;
  max?: number | null;
  step?: number | 'any';
  default?: boolean;
  asset?: AssetKind;
  /** Moi loai asset field nay chap nhan. `character` nhan ca image lan video. */
  assetKinds?: AssetKind[];
  /** 'object' = payload phai la {type, uri} thay vi chuoi uri. */
  wrap?: 'object';
  variants?: AssetVariant[];
  maxItems?: number | null;
  itemFields?: Field[];
  supportsLastFrame?: boolean;
  maxLength?: number;
}

export interface ModelVariant {
  model: string;
  hasModelField: boolean;
  modelOptions: string[] | null;
  fields: Field[];
}

export type EndpointKind = 'video' | 'image' | 'audio' | 'enhance' | 'recipe' | 'other';

export interface Endpoint {
  path: string;
  id: string;
  title: string;
  kind: EndpointKind;
  summary: string;
  description: string;
  models: ModelVariant[];
}

export interface Catalog {
  generatedAt: string;
  apiVersion: string;
  server: string;
  endpoints: Endpoint[];
}

// ---------------------------------------------------------------------------
// Suy ra endpoint
// ---------------------------------------------------------------------------

/** Loai ket qua nguoi dung muon tao. */
export type OutputKind = 'video' | 'image' | 'audio';

/** Mot lua chon cu the: goi endpoint nao voi model nao. */
export interface Target {
  endpoint: Endpoint;
  variant: ModelVariant;
  /** Diem xep hang: input bat buoc duoc dap ung tinh nang hon input tuy chon. */
  score: number;
}

const isAssetField = (f: Field) => f.control === 'asset' || f.control === 'asset-list';

/** Moi loai asset mot field chap nhan (`character` nhan ca image lan video). */
function kindsOf(f: Field): AssetKind[] {
  const kinds = f.assetKinds ?? (f.asset ? [f.asset] : []);
  return kinds.filter((k) => k !== 'file');
}

/**
 * Cac loai asset mot model BAT BUOC phai co.
 *
 * Field nhan nhieu loai (image HOAC video) chi tinh la bat buoc khi
 * khong loai nao trong so do co san - nen tra ve mang cac tap "phai co it nhat 1".
 */
export function requiredInputGroups(variant: ModelVariant): AssetKind[][] {
  const groups: AssetKind[][] = [];
  for (const f of variant.fields) {
    if (!f.required || !isAssetField(f)) continue;
    const kinds = kindsOf(f);
    if (kinds.length) groups.push(kinds);
  }
  return groups;
}

/** Tap phang cac loai asset bat buoc - dung cho hien thi goi y. */
export function requiredInputs(variant: ModelVariant): Set<AssetKind> {
  return new Set(requiredInputGroups(variant).flat());
}

/** Cac loai asset model co the nhan them (khong bat buoc). */
export function optionalInputs(variant: ModelVariant): Set<AssetKind> {
  const accepts = new Set<AssetKind>();
  for (const f of variant.fields) {
    if (f.required || !isAssetField(f)) continue;
    for (const k of kindsOf(f)) accepts.add(k);
  }
  return accepts;
}

/** Endpoint nay sinh ra loai ket qua gi. */
export function outputOf(ep: Endpoint): OutputKind | null {
  if (ep.kind === 'video') return 'video';
  if (ep.kind === 'image') return 'image';
  if (ep.kind === 'audio') return 'audio';
  return null; // enhance / recipe / other -> vao nhom "Cong cu", khong suy ra
}

/**
 * Tim moi to hop (endpoint, model) hop le voi:
 *   - loai ket qua mong muon
 *   - tap loai asset dang dinh kem
 *
 * Xep hang theo so loai asset duoc dung den, roi chi giu nhom cao nhat.
 * Nho vay dinh mot tam anh + chon Video se ra image_to_video chu khong phai
 * text_to_video (endpoint sau cung "hop le" nhung bo qua tam anh).
 */
export function resolveTargets(
  catalog: Catalog,
  output: OutputKind,
  attached: Set<AssetKind>
): Target[] {
  const candidates: Target[] = [];

  for (const ep of catalog.endpoints) {
    if (outputOf(ep) !== output) continue;

    for (const variant of ep.models) {
      const groups = requiredInputGroups(variant);

      // Moi nhom bat buoc phai duoc dap ung boi it nhat mot thu dang dinh kem
      const satisfied = groups.every((g) => g.some((k) => attached.has(k)));
      if (!satisfied) continue;

      // Cham diem: dap ung input BAT BUOC nang hon dung lam input tuy chon.
      //
      // Khong co trong so nay thi dinh 1 anh + chon Video se tra ve ca
      // text_to_video (nhan anh lam `references` tuy chon) lan image_to_video,
      // trong khi y dinh ro rang la image_to_video.
      const required = new Set(groups.flat());
      const optional = optionalInputs(variant);

      let score = 0;
      for (const a of attached) {
        if (required.has(a)) score += 10;
        else if (optional.has(a)) score += 1;
      }

      candidates.push({ endpoint: ep, variant, score });
    }
  }

  if (!candidates.length) return [];

  // Loc theo diem o cap ENDPOINT, khong phai cap model.
  //
  // Diem dung de chon endpoint nao khop y dinh nhat. Trong cung mot endpoint
  // thi giu lai het model hop le: dinh anh tham chieu vao Text -> Image khong
  // duoc lam bien mat gen4_image chi vi gen4_image_turbo bat buoc co reference.
  const bestByEndpoint = new Map<string, number>();
  for (const c of candidates) {
    const cur = bestByEndpoint.get(c.endpoint.path) ?? -1;
    if (c.score > cur) bestByEndpoint.set(c.endpoint.path, c.score);
  }

  const topScore = Math.max(...bestByEndpoint.values());
  const winners = new Set(
    [...bestByEndpoint].filter(([, s]) => s === topScore).map(([p]) => p)
  );

  return candidates.filter((c) => winners.has(c.endpoint.path));
}

/**
 * Cac to hop bi loai vi thieu asset - dung de goi y
 * "dinh them 1 video de mo khoa 8 model nua".
 */
export function blockedTargets(
  catalog: Catalog,
  output: OutputKind,
  attached: Set<AssetKind>
): Map<AssetKind, number> {
  const missing = new Map<AssetKind, number>();

  for (const ep of catalog.endpoints) {
    if (outputOf(ep) !== output) continue;
    for (const variant of ep.models) {
      const groups = requiredInputGroups(variant);
      const unmet = groups.filter((g) => !g.some((k) => attached.has(k)));
      if (unmet.length !== 1) continue; // chi goi y khi thieu dung 1 nhom
      for (const k of unmet[0]!) missing.set(k, (missing.get(k) ?? 0) + 1);
    }
  }
  return missing;
}

/** Endpoint chuyen biet khong suy ra duoc - hien o nhom "Cong cu". */
export function toolEndpoints(catalog: Catalog): Endpoint[] {
  return catalog.endpoints.filter((ep) => outputOf(ep) === null);
}

// ---------------------------------------------------------------------------
// Dung payload gui len server
// ---------------------------------------------------------------------------
export interface AttachedAsset {
  uri: string;
  kind: AssetKind;
  name: string;
  /** blob URL de xem truoc, chi ton tai o phien hien tai */
  preview?: string;
}

export type FormValues = Record<string, unknown>;

/**
 * Gia tri mac dinh cho truong BAT BUOC ma nguoi dung chua dong den.
 *
 * Khong co cai nay thi `ratio` va `duration` cua gen4.5 bo trong, bam Tao
 * la bao "thieu truong bat buoc" du nguoi dung khong lam gi sai.
 * Dung chung cho ca hien thi chip lan dung payload de hai noi khong lech nhau.
 */
export function defaultFor(f: Field): unknown {
  if (!f.required) return undefined;
  if (f.control === 'select') return f.options?.[0];
  if (f.control === 'number') {
    // 5 giay la do dai hop ly nhat cho phan lon model video
    if (f.name === 'duration') return Math.min(5, f.max ?? 5);
    return f.min ?? undefined;
  }
  return undefined;
}

/** Gia tri thuc su se duoc gui di cho mot truong. */
export function effectiveValue(f: Field, values: FormValues): unknown {
  const v = values[f.name];
  return v == null || v === '' ? defaultFor(f) : v;
}

/**
 * Gan asset dang dinh kem vao dung field cua variant, roi tron voi gia tri form.
 * Field asset don lay cai dau tien cung loai; field danh sach lay tat ca.
 */
export function buildPayload(
  variant: ModelVariant,
  values: FormValues,
  attachments: AttachedAsset[],
  lastFrame?: AttachedAsset
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (variant.hasModelField) payload.model = variant.model;

  const used = new Set<AttachedAsset>();

  for (const f of variant.fields) {
    // --- Field nhan 1 asset ---
    if (f.control === 'asset') {
      const pick = attachments.find((a) => a.kind === f.asset && !used.has(a));
      if (!pick) continue;
      used.add(pick);

      // promptImage ho tro [{uri, position}] khi co khung hinh cuoi
      if (f.name === 'promptImage' && lastFrame) {
        payload[f.name] = [
          { uri: pick.uri, position: 'first' },
          { uri: lastFrame.uri, position: 'last' },
        ];
      } else {
        payload[f.name] = pick.uri;
      }
      continue;
    }

    // --- Field nhan danh sach asset ---
    if (f.control === 'asset-list') {
      const picks = attachments.filter((a) => a.kind === f.asset && !used.has(a));
      if (!picks.length) continue;
      const limited = f.maxItems ? picks.slice(0, f.maxItems) : picks;
      for (const p of limited) used.add(p);

      payload[f.name] = limited.map((p) => {
        const item: Record<string, unknown> = { uri: p.uri };
        // Field phu bat buoc cua tung item (vd: `type` cua referenceAudio)
        for (const sub of f.itemFields ?? []) {
          const v = (values[`${f.name}.${p.uri}.${sub.name}`] ?? values[`${f.name}.${sub.name}`]);
          if (v != null && v !== '') item[sub.name] = v;
        }
        return item;
      });
      continue;
    }

    // --- Field thuong ---
    const v = effectiveValue(f, values);
    if (v == null || v === '') continue;
    payload[f.name] = v;
  }

  return payload;
}

/** Truong bat buoc con thieu - tra ve ten de bao nguoi dung. */
export function missingRequired(
  variant: ModelVariant,
  payload: Record<string, unknown>
): string[] {
  return variant.fields
    .filter((f) => f.required && (payload[f.name] == null || payload[f.name] === ''))
    .map((f) => f.name);
}
