/**
 * Doc metadata file ngay tren trinh duyet, truoc khi tai len.
 *
 * Muc dich: bat loi o phia nguoi dung thay vi de Runway tu choi sau khi da
 * upload xong (mat thoi gian) hoac sau khi da tao (mat credit).
 *
 * Yeu cau lay tu tai lieu Runway (muc B3):
 *  - Anh: chi JPEG, PNG, WebP. KHONG nhan GIF.
 *  - Anh nen co canh trong khoang 640x640 den 4K.
 *  - Ti le anh phai nam trong khoang cho phep cua model (0.2-4 rong nhat,
 *    0.55-1.8 hep nhat).
 *  - Video/audio: nhan hau het dinh dang pho bien; AVI, FLV van nhan nhung
 *    chat luong kem nen canh bao.
 *  - Dung luong: 5 MB den 200 MB moi file tuy cach nap.
 */
import type { AssetKind } from './catalog';

export interface MediaInfo {
  kind: AssetKind;
  /** Chi co voi anh va video */
  width?: number;
  height?: number;
  /** Chi co voi video va audio, don vi giay */
  duration?: number;
  sizeBytes: number;
  mime: string;
}

export interface FileIssue {
  level: 'error' | 'warn';
  message: string;
}

// --- Rang buoc tu tai lieu ---
const IMAGE_MIME_OK = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_MIME_REJECT: Record<string, string> = {
  'image/gif': 'Runway không nhận GIF. Chuyển sang PNG hoặc JPEG.',
  'image/bmp': 'Định dạng BMP không được hỗ trợ. Chuyển sang PNG.',
  'image/tiff': 'Định dạng TIFF không được hỗ trợ. Chuyển sang PNG.',
};
const LEGACY_VIDEO = /\.(avi|flv|wmv|mpg|mpeg)$/i;

const MIN_EDGE = 640;
const MAX_EDGE = 4096;
const MAX_BYTES = 200 * 1024 * 1024;

/** Doc kich thuoc / thoi luong bang chinh trinh duyet, khong can thu vien. */
export async function probeFile(file: File): Promise<MediaInfo> {
  const mime = file.type || '';
  const kind: AssetKind = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file';

  const base: MediaInfo = { kind, sizeBytes: file.size, mime };
  const url = URL.createObjectURL(file);

  try {
    if (kind === 'image') {
      const { width, height } = await loadImage(url);
      return { ...base, width, height };
    }
    if (kind === 'video') {
      const el = await loadMedia(url, 'video');
      return {
        ...base,
        width: (el as HTMLVideoElement).videoWidth || undefined,
        height: (el as HTMLVideoElement).videoHeight || undefined,
        duration: Number.isFinite(el.duration) ? el.duration : undefined,
      };
    }
    if (kind === 'audio') {
      const el = await loadMedia(url, 'audio');
      return { ...base, duration: Number.isFinite(el.duration) ? el.duration : undefined };
    }
    return base;
  } catch {
    // Khong doc duoc metadata thi van cho upload - de Runway quyet dinh.
    // Tha bo sot mot canh bao con hon chan file thuc ra dung duoc.
    return base;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('load failed'));
    };
    img.src = url;
  });
}

function loadMedia(url: string, tag: 'video' | 'audio'): Promise<HTMLMediaElement> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(el);
    };
    el.onerror = () => {
      clearTimeout(timer);
      reject(new Error('load failed'));
    };
    el.src = url;
  });
}

/**
 * Kiem tra file truoc khi upload.
 * Tra ve loi (chan) va canh bao (cho qua nhung noi ro).
 */
export function checkFile(file: File, info: MediaInfo): FileIssue[] {
  const issues: FileIssue[] = [];

  if (info.sizeBytes > MAX_BYTES) {
    issues.push({
      level: 'error',
      message: `File ${mb(info.sizeBytes)} vượt giới hạn ${mb(MAX_BYTES)}.`,
    });
  }

  if (info.kind === 'image') {
    const reject = IMAGE_MIME_REJECT[info.mime];
    if (reject) {
      issues.push({ level: 'error', message: reject });
    } else if (info.mime && !IMAGE_MIME_OK.includes(info.mime)) {
      issues.push({
        level: 'warn',
        message: `Runway chỉ đảm bảo JPEG, PNG, WebP. File này là ${info.mime}.`,
      });
    }

    if (info.width && info.height) {
      const short = Math.min(info.width, info.height);
      const long = Math.max(info.width, info.height);

      if (short < MIN_EDGE) {
        issues.push({
          level: 'warn',
          message: `Ảnh ${info.width}×${info.height} nhỏ hơn ${MIN_EDGE}px, sẽ bị kéo giãn và giảm chất lượng.`,
        });
      }
      if (long > MAX_EDGE) {
        issues.push({
          level: 'warn',
          message: `Ảnh ${info.width}×${info.height} lớn hơn ${MAX_EDGE}px, sẽ bị co lại.`,
        });
      }

      const ar = info.width / info.height;
      if (ar < 0.2 || ar > 4) {
        issues.push({
          level: 'error',
          message: `Tỉ lệ ${ar.toFixed(2)}:1 nằm ngoài khoảng 0.2–4 mà mọi model cho phép. Ảnh dạng panorama sẽ bị từ chối.`,
        });
      } else if (ar < 0.55 || ar > 1.8) {
        issues.push({
          level: 'warn',
          message: `Tỉ lệ ${ar.toFixed(2)}:1 chỉ một số model nhận (khoảng hẹp nhất là 0.55–1.8).`,
        });
      }
    }
  }

  if (info.kind === 'video' && LEGACY_VIDEO.test(file.name)) {
    issues.push({
      level: 'warn',
      message: 'Định dạng cũ (AVI/FLV/WMV) vẫn nhận nhưng chất lượng kém. Nên chuyển sang MP4.',
    });
  }

  return issues;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Ti le khung hinh dang so, dung de so voi ratio da chon. */
export const aspectOf = (info: MediaInfo): number | null =>
  info.width && info.height ? info.width / info.height : null;

/**
 * Phan bi cat khi anh khong dung ti le khung hinh da chon.
 * Tai lieu yeu cau cho nguoi dung thay truoc phan bi cat (muc B3).
 */
export function cropPreview(
  info: MediaInfo,
  targetRatio: string
): { cropPercent: number; axis: 'ngang' | 'dọc' } | null {
  const m = /^(\d+):(\d+)$/.exec(targetRatio);
  const src = aspectOf(info);
  if (!m || !src) return null;

  const target = Number(m[1]) / Number(m[2]);
  if (Math.abs(src - target) < 0.01) return null;

  if (src > target) {
    // Anh rong hon khung -> cat hai ben
    return { cropPercent: Math.round((1 - target / src) * 100), axis: 'ngang' };
  }
  return { cropPercent: Math.round((1 - src / target) * 100), axis: 'dọc' };
}
