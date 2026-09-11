/**
 * Kiem tra rang buoc truoc khi gui yeu cau.
 *
 * Tai lieu (muc B4) yeu cau ro: "Giao dien phai khoa lua chon khong hop le
 * ngay, kem giai thich, khong de nguoi dung nhap xong moi bao loi."
 *
 * Rang buoc duoc boc tu mo ta field trong OpenAPI spec (xem
 * scripts/extract-constraints.mjs) nen khi Runway doi mo ta, chay lai
 * `npm run catalog` la co luat moi - khong phai sua file nay.
 */
import type { AssetKind, AttachedAsset, Field, FormValues, ModelVariant } from './catalog';
import { assignAssets } from './catalog';

export type Constraint =
  | { kind: 'exclusive-keyframe-reference'; field: string; message: string }
  | { kind: 'last-frame-needs-first'; field: string; message: string }
  | { kind: 'requires-field'; field: string; needs: string; message: string }
  | { kind: 'max-total-duration'; field: string; seconds: number; message: string }
  | { kind: 'clip-duration-range'; field: string; min: number; max: number; message: string }
  | { kind: 'value-needs-asset'; field: string; value: string; assets: AssetKind[]; message: string }
  | { kind: 'min-image-size'; field: string; px: number; message: string }
  | { kind: 'value-requires-field'; field: string; value: string; needs: string; message: string };

export interface Violation {
  /** 'block' = khong cho bam Tao. 'warn' = cho qua nhung canh bao. */
  level: 'block' | 'warn';
  message: string;
  /** Field lien quan, de highlight dung cho tren giao dien. */
  field?: string;
}

export interface CheckContext {
  attachments: AttachedAsset[];
  lastFrame: AttachedAsset | null;
  prompt: string;
  values: FormValues;
}

const fieldOf = (variant: ModelVariant, name: string): Field | undefined =>
  variant.fields.find((f) => f.name === name);

/** Field nay dang co asset nao duoc gan vao khong. */
function assetsFor(variant: ModelVariant, attachments: AttachedAsset[], name: string) {
  const assigned = assignAssets(variant, attachments);
  return attachments.filter((a) => assigned.get(a.uri) === name);
}

/** Gia tri thuc te cua mot field khong phai asset. */
const valueOf = (ctx: CheckContext, name: string): unknown =>
  name === 'promptText' ? ctx.prompt.trim() : ctx.values[name];

/** Field co duoc dien gi chua (dung cho luat requires-field). */
function isFilled(variant: ModelVariant, ctx: CheckContext, name: string): boolean {
  const f = fieldOf(variant, name);
  if (f && (f.control === 'asset' || f.control === 'asset-list')) {
    return assetsFor(variant, ctx.attachments, name).length > 0;
  }
  const v = valueOf(ctx, name);
  return v != null && v !== '';
}

export function checkConstraints(
  variant: ModelVariant | undefined,
  ctx: CheckContext
): Violation[] {
  if (!variant) return [];
  const out: Violation[] = [];
  const rules = (variant.constraints ?? []) as Constraint[];

  for (const r of rules) {
    switch (r.kind) {
      // --- Khong dung dong thoi khung dau/cuoi va anh tham chieu ---
      case 'exclusive-keyframe-reference': {
        const keyframeMode = ctx.lastFrame != null;
        const refFields = variant.fields.filter(
          (f) => f.control === 'asset-list' && f.asset === 'image'
        );
        const hasRefImages = refFields.some(
          (f) => assetsFor(variant, ctx.attachments, f.name).length > 0
        );
        if (keyframeMode && hasRefImages) {
          out.push({ level: 'block', message: r.message, field: r.field });
        }
        break;
      }

      // --- Khung cuoi can co khung dau ---
      case 'last-frame-needs-first': {
        if (ctx.lastFrame && assetsFor(variant, ctx.attachments, r.field).length === 0) {
          out.push({ level: 'block', message: r.message, field: r.field });
        }
        break;
      }

      // --- Field A can field B da duoc dien ---
      case 'requires-field': {
        const used = assetsFor(variant, ctx.attachments, r.field).length > 0;
        if (used && !isFilled(variant, ctx, r.needs)) {
          out.push({ level: 'block', message: r.message, field: r.field });
        }
        break;
      }

      // --- Tong thoi luong khong vuot nguong ---
      case 'max-total-duration': {
        const items = assetsFor(variant, ctx.attachments, r.field);
        const known = items.filter((a) => a.duration != null);
        if (!known.length) break;
        const total = known.reduce((n, a) => n + (a.duration ?? 0), 0);
        if (total > r.seconds) {
          out.push({
            level: 'block',
            message: `${r.message} Hiện tổng ${total.toFixed(1)} giây.`,
            field: r.field,
          });
        }
        break;
      }

      // --- Moi file phai nam trong khoang thoi luong ---
      case 'clip-duration-range': {
        for (const a of assetsFor(variant, ctx.attachments, r.field)) {
          if (a.duration == null) continue;
          if (a.duration < r.min || a.duration > r.max) {
            out.push({
              level: 'block',
              message: `"${a.name}" dài ${a.duration.toFixed(1)} giây. ${r.message}`,
              field: r.field,
            });
          }
        }
        break;
      }

      // --- Gia tri nay chi dung duoc khi co asset loai X ---
      case 'value-needs-asset': {
        if (valueOf(ctx, r.field) !== r.value) break;
        const has = ctx.attachments.some((a) => r.assets.includes(a.kind));
        if (!has) {
          out.push({ level: 'block', message: r.message, field: r.field });
        }
        break;
      }

      // --- Gia tri nay yeu cau field khac da dien ---
      case 'value-requires-field': {
        if (valueOf(ctx, r.field) !== r.value) break;
        if (!isFilled(variant, ctx, r.needs)) {
          out.push({ level: 'block', message: r.message, field: r.field });
        }
        break;
      }

      // --- Anh phai du lon ---
      case 'min-image-size': {
        for (const a of ctx.attachments) {
          if (a.kind !== 'image' || a.width == null || a.height == null) continue;
          if (Math.min(a.width, a.height) < r.px) {
            out.push({
              level: 'block',
              message: `"${a.name}" là ${a.width}×${a.height}. ${r.message}`,
              field: r.field,
            });
          }
        }
        break;
      }
    }
  }

  return out;
}

/**
 * Canh bao khong den tu spec ma tu tai lieu chuc nang (muc F1).
 * Tach rieng vi day la kien thuc san pham, khong phai rang buoc ky thuat.
 */
export function audioNotes(variant: ModelVariant | undefined, values: FormValues): Violation[] {
  if (!variant) return [];
  const hasAudioToggle = variant.fields.some((f) => f.name === 'audio' && f.control === 'boolean');
  if (!hasAudioToggle || values.audio !== true) return [];

  return [
    {
      level: 'warn',
      field: 'audio',
      message:
        'Bật tiếng làm chi phí tăng ở một số model. Không chọn được giọng cụ thể — mỗi lần tạo là một giọng khác, nên chuỗi nhiều clip sẽ không đồng nhất giọng. Khẩu hình hiện chỉ khớp tiếng Anh, Trung, Nhật, Hàn, Đức, Pháp — chưa có tiếng Việt.',
    },
  ];
}

/** Ba nguyen nhan thuong gap khien ket qua bi tu choi (muc C4). */
export const REJECTION_TIPS = [
  'Ảnh đầu vào có logo, watermark hoặc chữ đè lên.',
  'Mô tả yêu cầu tạo chữ hiển thị trong video.',
  'Mô tả viết kiểu "hãy viết một prompt cho…" thay vì tả thẳng cảnh quay.',
];
