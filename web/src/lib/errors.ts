/**
 * Dich ma loi ky thuat cua Runway thanh thong bao cho nguoi dung.
 *
 * Tai lieu chuc nang (muc K) yeu cau: "Khong hien thi ma loi ky thuat. Moi
 * loai co thong diep va huong xu ly rieng." Tai lieu Runway cung noi ro
 * ve failureCode: "treat these as diagnostic messages only rather than
 * exposing them to users."
 *
 * Nguon ma loi: https://docs.dev.runwayml.com/errors/task-failures
 */

/** Ba nguyen nhan thuong gap khien ket qua bi tu choi (muc C4). */
export const REJECTION_TIPS = [
  'Ảnh đầu vào có logo, watermark hoặc chữ đè lên.',
  'Mô tả yêu cầu tạo chữ hiển thị trong video.',
  'Mô tả viết kiểu "hãy viết một prompt cho…" thay vì tả thẳng cảnh quay.',
];

export interface FriendlyError {
  /** Thong diep chinh cho nguoi dung. */
  message: string;
  /** Credit co bi tru khong. Runway KHONG hoan cho SAFETY.INPUT.*. */
  billed: 'charged' | 'refunded' | 'unknown';
  /** Bam "Thu lai" co y nghia khong. */
  retryable: boolean;
  /** Viec nguoi dung can lam. */
  action?: string;
  /** Goi y cu the, vi du ba nguyen nhan o muc C4. */
  tips?: string[];
  /** Nen goi y doi sang model khac. */
  suggestAltModel?: boolean;
}

const CHARGED_NOT_REFUNDED =
  'Lưu ý: Runway không hoàn credit cho trường hợp nội dung đầu vào bị chặn.';

export function explainFailure(failureCode?: string | null, raw?: string | null): FriendlyError {
  const code = (failureCode ?? '').toUpperCase();

  // --- Loi luc GUI yeu cau, khong phai loi task ---
  if (code.startsWith('REQUEST.')) {
    if (code === 'REQUEST.INSUFFICIENT_CREDITS') {
      return {
        message: 'Không đủ credit cho lần tạo này.',
        billed: 'refunded',
        retryable: false,
        action:
          'Giảm thời lượng, hạ độ phân giải, hoặc đổi sang model rẻ hơn. ' +
          'Con số ước tính nằm ngay trên nút Tạo — so với số dư trước khi bấm.',
      };
    }
    if (code === 'REQUEST.VALIDATION') {
      return {
        message: 'Tham số không hợp lệ với model này.',
        billed: 'refunded',
        retryable: false,
        action: 'Kiểm tra lại tham số rồi tạo lại. Chi tiết từ Runway: ' + (raw ?? '').slice(0, 200),
      };
    }
    if (code === 'REQUEST.AUTH') {
      return {
        message: 'Không có quyền gọi model này.',
        billed: 'refunded',
        retryable: false,
        action: 'Kiểm tra API key và hạn mức của tài khoản Runway.',
      };
    }
    return {
      message: 'Không gửi được yêu cầu tới Runway.',
      billed: 'refunded',
      retryable: true,
      action: 'Đợi một lát rồi thử lại.',
    };
  }

  // --- Noi dung dau vao bi chan: CO tinh tien, khong nen thu lai ---
  if (code.startsWith('SAFETY.INPUT') || code === 'INPUT_PREPROCESSING.SAFETY.TEXT') {
    return {
      message: 'Nội dung này không được hỗ trợ. Vui lòng chỉnh mô tả hoặc đổi ảnh.',
      billed: 'charged',
      retryable: false,
      action: CHARGED_NOT_REFUNDED,
    };
  }

  // --- Ket qua tao ra bi chan: hoan lai, khong thu lai y nguyen ---
  if (code.startsWith('SAFETY.OUTPUT') || code.startsWith('SAFETY.')) {
    return {
      message: 'Kết quả không đạt kiểm duyệt. Thử mô tả khác.',
      billed: 'refunded',
      retryable: false,
      action: 'Đổi cách mô tả rồi tạo lại.',
    };
  }

  // --- Ket qua khong dat chat luong: hoan lai, CO the thu lai ---
  if (code.startsWith('INTERNAL.BAD_OUTPUT')) {
    return {
      message: 'Kết quả không đạt chất lượng.',
      billed: 'refunded',
      retryable: true,
      action: 'Sửa theo các gợi ý dưới rồi thử lại.',
      tips: REJECTION_TIPS,
    };
  }

  // --- File dau vao khong hop le: phai doi file ---
  if (code === 'ASSET.INVALID') {
    return {
      message: 'Ảnh/video không phù hợp với model này (kích thước, tỉ lệ hoặc thời lượng).',
      billed: 'refunded',
      retryable: false,
      action: 'Đổi file khác rồi tạo lại. Thử lại với cùng file sẽ lỗi tiếp.',
    };
  }

  // --- Model qua tai: doi model hoac cho ---
  if (code === 'THIRD_PARTY.UNAVAILABLE') {
    return {
      message: 'Model đang bận. Thử lại sau hoặc chọn model khác.',
      billed: 'refunded',
      retryable: true,
      action: 'Đợi một lát rồi thử lại — thử ngay thường vẫn lỗi.',
      suggestAltModel: true,
    };
  }

  // --- Loi he thong / kiem duyet loi: thu lai co delay ---
  if (code === 'INPUT_PREPROCESSING.INTERNAL' || code === 'INTERNAL' || !code) {
    return {
      message: 'Có lỗi xảy ra phía hệ thống.',
      billed: 'refunded',
      retryable: true,
      action: 'Đợi một lát rồi thử lại.',
    };
  }

  // --- Ma la: khong doan, noi that va cho thu lai ---
  return {
    message: raw?.trim() || 'Tạo không thành công.',
    billed: 'unknown',
    retryable: true,
  };
}

/**
 * Loi khi GUI yeu cau (khong phai loi task), vi du 429 hay 400 validation.
 * Cac loi nay server da xu ly phan lon, day la lop cuoi cho giao dien.
 */
export function explainRequestError(status: number, raw: string): string {
  if (status === 429) return 'Đang quá số lượng chạy cùng lúc — hệ thống sẽ tự xếp hàng và thử lại.';
  if (status === 401) return 'Phiên đã hết hạn. Đăng nhập lại.';
  if (status === 403) return 'Bạn không có quyền thực hiện việc này.';
  if (status === 413) return 'File quá lớn.';
  if (status >= 500) return 'Máy chủ đang gặp sự cố. Thử lại sau.';

  // 400 tu Runway thuong la validation - giu nguyen vi no noi ro field nao sai
  if (status === 400) return raw || 'Tham số không hợp lệ.';
  return raw || `Lỗi ${status}`;
}

const BILLED_LABEL: Record<FriendlyError['billed'], string> = {
  charged: 'đã trừ credit',
  refunded: 'credit được hoàn',
  unknown: 'chưa rõ credit',
};

export const billedLabel = (b: FriendlyError['billed']) => BILLED_LABEL[b];


// ---------------------------------------------------------------------------
/**
 * Runway tra loi validation dang:
 *   { error, issues: [{ code, path: ["duration"], message, expected }] }
 *
 * Doc ra thanh dong ngan gon theo tung truong. Khong co buoc nay thi nguoi
 * dung chi thay mot cuc JSON va khong biet phai sua o dau.
 */
export interface ValidationIssue {
  field: string;
  message: string;
}

const CODE_VI: Record<string, string> = {
  invalid_type: 'sai kiểu dữ liệu',
  invalid_value: 'giá trị không nằm trong danh sách cho phép',
  invalid_union: 'không khớp biến thể nào của model này',
  too_small: 'nhỏ hơn mức cho phép',
  too_big: 'lớn hơn mức cho phép',
  invalid_format: 'sai định dạng',
  unrecognized_keys: 'model này không nhận tham số đó',
};

export function parseValidationIssues(details: unknown): ValidationIssue[] {
  if (!details || typeof details !== 'object') return [];
  const raw = (details as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];

  return raw.slice(0, 12).map((i) => {
    const o = (i ?? {}) as {
      path?: unknown[];
      code?: string;
      message?: string;
      expected?: unknown;
      values?: unknown[];
      keys?: unknown[];
    };
    const field = Array.isArray(o.path) && o.path.length ? o.path.join('.') : '(toàn bộ yêu cầu)';

    const parts: string[] = [];
    if (o.code && CODE_VI[o.code]) parts.push(CODE_VI[o.code]!);

    if (Array.isArray(o.values) && o.values.length) {
      parts.push(`chỉ nhận: ${o.values.slice(0, 8).join(', ')}`);
    } else if (Array.isArray(o.keys) && o.keys.length) {
      parts.push(`thừa: ${o.keys.join(', ')}`);
    } else if (o.expected) {
      parts.push(`cần ${String(o.expected)}`);
    }

    if (!parts.length && o.message) parts.push(o.message);
    return { field, message: parts.join(' — ') || 'không hợp lệ' };
  });
}
