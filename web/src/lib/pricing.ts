/**
 * Uoc tinh chi phi credit TRUOC khi bam Tao.
 *
 * Nguon duy nhat: https://docs.dev.runwayml.com/guides/pricing
 * Tai lieu Runway noi ro "Credit costs are documented only in
 * /guides/pricing.md. Do not infer pricing from anywhere else." - nen bang
 * duoi day chep tu do, khong suy tu dau khac.
 *
 * Day la UOC TINH. So tien that do Runway quyet dinh va tra ve trong
 * `estimatedCost` khi tao, roi `cost` khi xong.
 */
import type { AttachedAsset, FormValues, ModelVariant } from './catalog';
import { effectiveValue } from './catalog';

export interface CostEstimate {
  credits: number | null;
  /** Cach tinh, de nguoi dung hieu con so o dau ra. */
  breakdown: string[];
  /** Khong du thong tin de tinh chinh xac. */
  approximate: boolean;
  /**
   * Con so nay la GIOI HAN DUOI - chi phi that luon >= no.
   * Dung khi gia dinh thoi luong theo muc toi thieu cua model, nen neu no
   * da vuot so du thi chac chan that bai, chan duoc an toan.
   */
  lowerBound?: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Video: credit moi giay, theo do phan giai
// ---------------------------------------------------------------------------
type Tier = Record<string, number>;

/** perSecond theo do phan giai. Khoa '*' la moi do phan giai. */
const VIDEO: Record<string, { perSecond: Tier; min?: number; perRefImage?: number }> = {
  wan3: { perSecond: { '480p': 5, '720p': 10, '1080p': 20, '*': 10 } },
  wan3_prime: { perSecond: { '480p': 5, '768p': 8, '*': 8 } },
  seedance2_5: { perSecond: { '480p': 20, '720p': 30, '1080p': 68, '*': 30 }, min: 80 },
  seedance2: { perSecond: { '480p': 36, '720p': 36, '1080p': 40, '4k': 150, '*': 36 } },
  seedance2_fast: { perSecond: { '480p': 29, '720p': 29, '*': 29 } },
  seedance2_mini: { perSecond: { '480p': 16, '720p': 16, '*': 16 }, min: 64 },
  grok_imagine_1_5: { perSecond: { '480p': 10, '720p': 16, '1080p': 29, '*': 16 }, perRefImage: 1 },
  h3_max: { perSecond: { '480p': 5, '768p': 8, '*': 8 } },
  hailuo3: { perSecond: { '768p': 10, '2k': 15, '*': 10 }, perRefImage: 2 },
  aleph2: { perSecond: { '*': 28 }, min: 56 },
  'gen4.5': { perSecond: { '*': 12 } },
  gen4_turbo: { perSecond: { '*': 5 } },
  act_two: { perSecond: { '*': 5 } },
  happyhorse_1_0: { perSecond: { '720p': 15, '1080p': 30, '*': 15 } },
  gemini_omni_flash: { perSecond: { '*': 10 }, perRefImage: 1 },
  'gemini_omni_flash_1.1': { perSecond: { '*': 10 }, perRefImage: 1 },
  // veo3.1 phu thuoc co bat tieng hay khong - xu ly rieng ben duoi
  'veo3.1': { perSecond: { '*': 20 } },
  'veo3.1_fast': { perSecond: { '*': 10 } },
};

/** veo3.1 tinh gap doi khi bat tieng. */
const VIDEO_AUDIO_RATE: Record<string, number> = { 'veo3.1': 40, 'veo3.1_fast': 15 };

// ---------------------------------------------------------------------------
// Anh: credit moi anh
// ---------------------------------------------------------------------------
const GPT_IMAGE_2: Tier = { low_small: 1, low_4k: 2, medium_small: 5, medium_4k: 11, high_small: 20, high_4k: 41, auto_small: 20, auto_4k: 41 };
const GPT_25: Tier = { low_small: 1, low_4k: 2, medium_small: 5, medium_4k: 11, high_small: 16, high_4k: 19, xhigh_small: 28, xhigh_4k: 34, max_small: 63, max_4k: 76 };
const GROK_IMG: Tier = { low_1k: 4, low_2k: 6, medium_1k: 6, medium_2k: 8 };

/** So diem anh de phan bac 1K/2K vs 4K. */
function megapixels(ratio: string): number | null {
  const m = /^(\d+):(\d+)$/.exec(ratio);
  if (!m) return null;
  return (Number(m[1]) * Number(m[2])) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Recipe: gia co dinh cho N giay dau, roi cong them moi giay
// ---------------------------------------------------------------------------
const RECIPE: Record<string, { base: Tier; perExtra: Tier; baseSeconds: number; minSec: number; maxSec: number }> = {
  product_ad: {
    base: { '720p': 200, '1080p': 216, '*': 200 },
    perExtra: { '720p': 36, '1080p': 40, '*': 36 },
    baseSeconds: 4, minSec: 4, maxSec: 15,
  },
  product_ugc: {
    base: { '720p': 192, '1080p': 208, '*': 192 },
    perExtra: { '720p': 36, '1080p': 40, '*': 36 },
    baseSeconds: 4, minSec: 4, maxSec: 15,
  },
};

/** multi_shot_video tinh thang theo giay, khong co gia co dinh. */
const MULTI_SHOT: Tier = { '720p': 13, '1080p': 17, '*': 13 };

// ---------------------------------------------------------------------------
// Phu phi dinh dang chuyen nghiep
// ---------------------------------------------------------------------------
const PRO_FORMAT_SURCHARGE: Record<string, number> = {
  prores: 5,
  png_sequence: 5,
};
const HDR_FORMATS = new Set([
  'hdr10', 'hlg', 'sdr_rec709_10bit', 'hdr_pq_12bit_master', 'hdr_prores',
  'hdr_png_sequence', 'hdr_exr_sequence', 'hdr_exr_acescg_sequence_1_3',
  'hdr_exr_acescg_sequence_2_0',
]);

// ---------------------------------------------------------------------------
const val = (variant: ModelVariant, values: FormValues, name: string): string => {
  const f = variant.fields.find((x) => x.name === name);
  if (!f) return '';
  return String(effectiveValue(f, values) ?? '');
};

const numVal = (variant: ModelVariant, values: FormValues, name: string): number | null => {
  const v = val(variant, values, name);
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : null;
};

/** Chuan hoa do phan giai ve khoa trong bang gia. */
function resolutionKey(variant: ModelVariant, values: FormValues): string {
  const res = val(variant, values, 'resolution').toLowerCase();
  if (res) return res.replace(/^(\d+)p$/i, '$1p');

  // Khong co truong resolution thi suy tu ratio
  const mp = megapixels(val(variant, values, 'ratio'));
  if (mp == null) return '*';
  if (mp > 6) return '4k';
  if (mp > 2.2) return '1080p';
  if (mp > 0.6) return '720p';
  return '480p';
}

export function estimateCost(
  variant: ModelVariant | undefined,
  values: FormValues,
  attachments: AttachedAsset[],
  prompt: string
): CostEstimate {
  if (!variant) return { credits: null, breakdown: [], approximate: true };

  const model = variant.model;
  const breakdown: string[] = [];
  const refImages = attachments.filter((a) => a.kind === 'image').length;

  // ----- RECIPE -----
  // Recipe khong co truong `model` nen nhan dien bang chinh cac truong dac
  // trung cua no. Gia recipe khac han model thuong: co gia co dinh cho vai
  // giay dau roi moi cong theo giay.
  const isUgc = variant.fields.some((f) => f.name === 'characterImage');
  const isAd = variant.fields.some((f) => f.name === 'productImages');
  const isMultiShot = variant.fields.some((f) => f.name === 'firstFrame');

  if (isUgc || isAd || isMultiShot) {
    const resKey = resolutionKey(variant, values);
    const dField = variant.fields.find((f) => f.name === 'duration');
    let seconds = numVal(variant, values, 'duration');
    let guessed = false;
    if (seconds == null) {
      seconds = dField?.min ?? (isMultiShot ? 5 : 4);
      guessed = true;
    }

    if (isMultiShot) {
      const rate = MULTI_SHOT[resKey] ?? MULTI_SHOT['*']!;
      const total = rate * seconds;
      breakdown.push(`${rate} cr/giây × ${seconds} giây${guessed ? ' (giả định)' : ''} = ${total}`);
      return { credits: total, breakdown, approximate: guessed, lowerBound: guessed };
    }

    const r = RECIPE[isUgc ? 'product_ugc' : 'product_ad']!;
    const base = r.base[resKey] ?? r.base['*']!;
    const extra = Math.max(0, seconds - r.baseSeconds);
    const perExtra = r.perExtra[resKey] ?? r.perExtra['*']!;
    const total = base + extra * perExtra;

    breakdown.push(`${base} cr cho ${r.baseSeconds} giây đầu`);
    if (extra) breakdown.push(`+ ${extra} giây × ${perExtra} = ${extra * perExtra}`);
    if (guessed) breakdown.push(`(giả định ${seconds} giây — mức tối thiểu)`);

    return { credits: total, breakdown, approximate: guessed, lowerBound: guessed };
  }

  // ----- VIDEO -----
  const video = VIDEO[model];
  if (video) {
    // `duration` la tuy chon voi mot so model. Khong the vi the ma bo qua uoc
    // tinh - day chinh la luc nguoi dung can con so nhat, vi nhom model dat
    // nhu seedance2 la 36 cr/giay. Gia dinh theo min cua truong roi danh dau
    // la uoc luong.
    let duration = numVal(variant, values, 'duration');
    let assumed = false;
    if (duration == null) {
      const f = variant.fields.find((x) => x.name === 'duration');
      duration = f?.min ?? (f?.options?.length ? Number(f.options[0]) : null) ?? 5;
      assumed = true;
    }

    const resKey = resolutionKey(variant, values);
    const audioOn = values.audio === true;
    let rate = (audioOn && VIDEO_AUDIO_RATE[model]) || video.perSecond[resKey] || video.perSecond['*'] || 0;

    let total = rate * duration;
    breakdown.push(
      `${rate} cr/giây × ${duration} giây${assumed ? ' (giả định)' : ''} = ${total}`
    );
    if (audioOn && VIDEO_AUDIO_RATE[model]) breakdown.push('(đã tính giá có tiếng)');

    if (video.perRefImage && refImages) {
      total += video.perRefImage * refImages;
      breakdown.push(`+ ${refImages} ảnh tham chiếu × ${video.perRefImage} = ${video.perRefImage * refImages}`);
    }

    // Phu phi dinh dang chuyen nghiep, tinh theo giay
    const fmt = val(variant, values, 'outputFormat');
    const surcharge = PRO_FORMAT_SURCHARGE[fmt] ?? (HDR_FORMATS.has(fmt) ? ((megapixels(val(variant, values, 'ratio')) ?? 0) > 4 ? 40 : 20) : 0);
    if (surcharge) {
      total += surcharge * duration;
      breakdown.push(`+ định dạng ${fmt}: ${surcharge} cr/giây × ${duration} = ${surcharge * duration}`);
    }

    if (video.min && total < video.min) {
      breakdown.push(`tối thiểu ${video.min} cr mỗi lần tạo`);
      total = video.min;
    }

    return {
      credits: Math.round(total),
      breakdown,
      approximate: assumed,
      // Gia dinh dung min cua truong nen day la san duoi
      lowerBound: assumed,
      note: assumed ? `chưa chọn thời lượng — tính theo ${duration} giây (mức tối thiểu)` : undefined,
    };
  }

  // ----- ANH -----
  const count = numVal(variant, values, 'outputCount') ?? 1;
  const quality = (val(variant, values, 'quality') || 'high').toLowerCase();
  const mp = megapixels(val(variant, values, 'ratio'));
  const big = mp != null && mp > 6; // ~4K
  const perImageFrom = (t: Tier, q: string) => t[`${q}_${big ? '4k' : 'small'}`] ?? null;

  let per: number | null = null;
  let refCost = 0;

  switch (model) {
    case 'gen4_image':
      per = mp != null && mp > 1.2 ? 8 : 5;
      breakdown.push(per === 8 ? '8 cr/ảnh (1080p)' : '5 cr/ảnh (720p)');
      break;
    case 'gen4_image_turbo':
      per = 2;
      breakdown.push('2 cr/ảnh, mọi độ phân giải');
      break;
    case 'muse_image':
      per = 1;
      breakdown.push('1 cr/ảnh');
      break;
    case 'seedream5_lite':
      per = 4;
      breakdown.push('4 cr/ảnh');
      break;
    case 'seedream5_pro':
      per = mp != null && mp > 2.5 ? 9 : 5;
      breakdown.push(`${per} cr/ảnh`);
      break;
    case 'gemini_2.5_flash':
      per = 5;
      breakdown.push('5 cr/ảnh');
      break;
    case 'gemini_image3_pro':
      per = big ? 40 : 20;
      breakdown.push(`${per} cr/ảnh`);
      break;
    case 'grok_imagine_image_2': {
      const q = quality === 'low' ? 'low' : 'medium';
      per = GROK_IMG[`${q}_${mp != null && mp > 2.5 ? '2k' : '1k'}`] ?? 6;
      refCost = refImages; // 1 cr mỗi ảnh, tính MỘT LẦN cho cả request
      breakdown.push(`${per} cr/ảnh (${q})`);
      if (refCost) breakdown.push(`+ ${refImages} ảnh tham chiếu × 1 = ${refCost} (tính một lần)`);
      break;
    }
    case 'gpt_image_2':
      per = perImageFrom(GPT_IMAGE_2, ['low', 'medium', 'high', 'auto'].includes(quality) ? quality : 'high');
      breakdown.push(`${per} cr/ảnh (${quality})`);
      break;
    case 'gpt_image_2_5_flare':
    case 'gpt_image_2_5_sunburst':
      per = perImageFrom(GPT_25, ['low', 'medium', 'high', 'xhigh', 'max'].includes(quality) ? quality : 'high');
      // Khac grok: anh tham chieu tinh cho TUNG anh sinh ra
      if (per != null) per += refImages;
      breakdown.push(`${per} cr/ảnh (${quality}${refImages ? `, gồm ${refImages} tham chiếu` : ''})`);
      break;
  }

  if (per != null) {
    const total = per * count + refCost;
    if (count > 1) breakdown.push(`× ${count} ảnh = ${per * count}`);
    return { credits: Math.round(total), breakdown, approximate: false };
  }

  // ----- AM THANH + con lai -----
  if (model === 'eleven_v3' || model === 'eleven_multilingual_v2') {
    const chars = prompt.trim().length;
    const c = Math.max(1, Math.ceil(chars / 50));
    return {
      credits: c,
      breakdown: [`1 cr mỗi 50 ký tự × ${chars} ký tự = ${c}`],
      approximate: false,
    };
  }
  if (model === 'seed_audio') {
    const d = numVal(variant, values, 'duration');
    if (d != null) {
      const c = Math.max(5, Math.ceil(d * 0.25));
      return { credits: c, breakdown: [`0,25 cr/giây × ${d} giây`, 'tối thiểu 5 cr'], approximate: false };
    }
  }
  if (model === 'magnific_precision_upscaler_v2') {
    return { credits: 25, breakdown: ['25 cr/ảnh', '150 cr nếu kết quả vượt 4096px'], approximate: true };
  }
  if (model === 'ruby') {
    const d = numVal(variant, values, 'duration');
    return {
      credits: d != null ? 20 * d : null,
      breakdown: ['20 cr/giây', '40 cr/giây nếu nguồn lớn hơn 4 megapixel'],
      approximate: true,
    };
  }

  return { credits: null, breakdown: [], approximate: true, note: 'chưa có bảng giá cho model này' };
}
