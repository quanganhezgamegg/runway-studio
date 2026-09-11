/**
 * Boc rang buoc loai tru tu MO TA field trong OpenAPI spec.
 *
 * Runway khong dien cac rang buoc nay bang tu khoa JSON Schema - spec khong
 * dung mot lan nao `not`, `if/then`, hay `dependentRequired`. Chung nam trong
 * `description` dang van xuoi, vi du:
 *
 *   "Use position first/last for keyframe mode, or omit position for
 *    reference images. The two modes cannot be mixed."
 *   "Audio references require at least one image reference."
 *   "Use adaptive only when image or video references are provided."
 *
 * Van xuoi nhung co quy luat nen boc bang regex duoc, va van giu duy nhat
 * mot nguon su that: Runway sua mo ta thi chay lai `npm run catalog` la co
 * rang buoc moi, khong phai bao tri 72 bo luat viet tay.
 */

const PATTERNS = [
  // "The two modes cannot be mixed" -> khung dau/cuoi vs anh tham chieu
  {
    test: /two modes cannot be mixed/i,
    make: (field) => ({
      kind: 'exclusive-keyframe-reference',
      field,
      message:
        'Model này không cho dùng đồng thời khung đầu/cuối và ảnh tham chiếu. Chọn một trong hai.',
    }),
  },

  {
    test: /last frame requires a first frame/i,
    make: (field) => ({
      kind: 'last-frame-needs-first',
      field,
      message: 'Phải có khung đầu trước khi thêm khung cuối.',
    }),
  },

  {
    test: /require(?:s)? at least one image reference/i,
    make: (field) => ({
      kind: 'requires-field',
      field,
      needs: 'referenceImages',
      message: 'Tham chiếu âm thanh chỉ dùng được khi đã có ít nhất một ảnh tham chiếu.',
    }),
  },

  {
    test: /require(?:s)? a text prompt/i,
    make: (field) => ({
      kind: 'requires-field',
      field,
      needs: 'promptText',
      message: 'Tham chiếu âm thanh cần có mô tả chữ.',
    }),
  },

  {
    test: /combined.{0,60}duration.{0,60}must not exceed (\d+) seconds/i,
    make: (field, desc) => {
      const n = Number(/must not exceed (\d+) seconds/i.exec(desc)[1]);
      return {
        kind: 'max-total-duration',
        field,
        seconds: n,
        message: `Tổng thời lượng các file này không được vượt ${n} giây.`,
      };
    },
  },

  {
    test: /each clip must be between (\d+) and (\d+) seconds/i,
    make: (field, desc) => {
      const m = /each clip must be between (\d+) and (\d+) seconds/i.exec(desc);
      return {
        kind: 'clip-duration-range',
        field,
        min: Number(m[1]),
        max: Number(m[2]),
        message: `Mỗi file phải dài ${m[1]}–${m[2]} giây.`,
      };
    },
  },

  {
    test: /use adaptive only when/i,
    make: (field) => ({
      kind: 'value-needs-asset',
      field,
      value: 'adaptive',
      assets: ['image', 'video'],
      message:
        'Tỉ lệ "adaptive" chỉ dùng được khi đã nạp ảnh hoặc video. Yêu cầu chỉ có chữ phải chọn tỉ lệ cụ thể.',
    }),
  },

  {
    test: /at least (\d+) pixels on both sides/i,
    make: (field, desc) => {
      const n = Number(/at least (\d+) pixels on both sides/i.exec(desc)[1]);
      return {
        kind: 'min-image-size',
        field,
        px: n,
        message: `Ảnh phải có cả hai cạnh từ ${n}px trở lên.`,
      };
    },
  },

  {
    test: /`extend`[^.]{0,80}requires `promptText`/i,
    make: (field) => ({
      kind: 'value-requires-field',
      field,
      value: 'extend',
      needs: 'promptText',
      message: 'Chế độ "extend" (kéo dài video) cần có mô tả chữ.',
    }),
  },
];

/** Doc mo ta cua moi field trong mot variant, tra ve danh sach rule. */
export function extractConstraints(fields) {
  const rules = [];
  const seen = new Set();

  for (const f of fields) {
    const desc = f.description || '';
    if (!desc) continue;

    for (const p of PATTERNS) {
      if (!p.test.test(desc)) continue;
      const rule = p.make(f.name, desc);
      const key = `${rule.kind}:${rule.field}:${rule.value ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(rule);
    }
  }

  return rules;
}
