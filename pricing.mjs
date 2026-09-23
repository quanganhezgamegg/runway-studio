/**
 * Uoc tinh credit cho pipeline nhieu canh.
 *
 * Nguon duy nhat: https://docs.dev.runwayml.com/guides/pricing — tai lieu
 * Runway noi ro "Credit costs are documented only in /guides/pricing.md.
 * Do not infer pricing from anywhere else."
 *
 * Module nay CHI phu cac model ma pipeline dung, khong phai ca bang gia.
 * Bang day du cho trang Tao nam o web/src/lib/pricing.ts. De o mot cho de
 * CLI va server khong bao gio bao hai con so khac nhau cho cung mot viec.
 *
 * Day la UOC TINH. So that do Runway tra ve trong `estimatedCost` khi tao.
 */

/** Credit moi giay video, theo model va do phan giai. */
const VIDEO_PER_SECOND = {
  gen4_turbo: { '*': 5 },
  'gen4.5': { '*': 12 },
  veo3_1: { '*': 20 },
  'veo3.1': { '*': 20 },
  'veo3.1_fast': { '*': 10 },
  wan3: { '480p': 5, '720p': 10, '1080p': 20, '*': 10 },
  seedance2: { '480p': 36, '720p': 36, '1080p': 40, '4k': 150, '*': 36 },
  seedance2_fast: { '480p': 29, '720p': 29, '*': 29 },
  seedance2_mini: { '480p': 16, '720p': 16, '*': 16 },
  hailuo3: { '768p': 10, '2k': 15, '*': 10 },
};

/** Model nao co san credit toi thieu moi clip. */
const VIDEO_MIN = { seedance2_mini: 64, seedance2_5: 80, aleph2: 56 };

/** Bac do phan giai suy tu ratio: chieu NHO hon dat ten bac. */
export function resTier(ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio || ''));
  if (!m) return '*';
  return `${Math.min(Number(m[1]), Number(m[2]))}p`;
}

/** Credit cho mot anh, theo model va ratio. */
export function imageCost(model, ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio || ''));
  const mp = m ? (Number(m[1]) * Number(m[2])) / 1_000_000 : null;
  if (model === 'gen4_image_turbo') return 2;
  if (model === 'gen4_image') return mp != null && mp > 1.2 ? 8 : 5;
  return null; // model khong nam trong pham vi pipeline
}

/** Credit cho mot clip. */
export function clipCost(model, ratio, seconds) {
  const tier = VIDEO_PER_SECOND[model];
  if (!tier) return null;
  const per = tier[resTier(ratio)] ?? tier['*'];
  if (per == null) return null;
  return Math.max(per * (seconds || 0), VIDEO_MIN[model] ?? 0);
}

/**
 * Uoc tinh cho ca video: con thieu bao nhieu viec o tung buoc va het bao nhieu.
 *
 * `entities` chi tinh nhung entity THUC SU duoc dung trong cac canh — entity
 * de trong project ma khong canh nao dung thi khong ton gi.
 */
export function estimateVideo({ video, scenes, entities, refModel, sceneImageModel, refRatioOf }) {
  const used = new Set(scenes.flatMap((s) => s.entity_ids ?? []));
  const usedEntities = entities.filter((e) => used.has(e.id));

  // Anh tham chieu dung ratio theo LOAI entity (doc, ngang, vuong), khong
  // theo ratio cua video — nen gia moi anh co the khac nhau
  const refStyleRatio = refRatioOf ?? (() => '720:1280');

  const todoRefs = usedEntities.filter((e) => !e.ref_uri);
  const todoImages = scenes.filter((s) => !s.image_uri);
  const todoClips = scenes.filter((s) => !s.video_uri);

  const lines = [];
  let total = 0;
  let unknown = false;

  if (todoRefs.length) {
    let sum = 0;
    for (const e of todoRefs) {
      const c = imageCost(refModel, refStyleRatio(e));
      if (c == null) { unknown = true; continue; }
      sum += c;
    }
    total += sum;
    lines.push(`${todoRefs.length} ảnh tham chiếu × ${refModel} = ${sum} cr`);
  }

  if (todoImages.length) {
    let sum = 0;
    for (const s of todoImages) {
      /*
       * Canh co anh tham chieu thi dung turbo (2cr), khong thi phai lui ve
       * gen4_image (5cr) vi turbo BAT BUOC co referenceImages.
       *
       * Tinh theo "se co ref khi chay den buoc nay", khong phai "da co ref
       * ngay bay gio": nguoi dung dang can biet chay CA pipeline het bao
       * nhieu, ma buoc 1 luon chay truoc buoc 2. Lay moc "ngay bay gio" se
       * bao dat hon thuc te va lam ho tuong la khong du tien.
       */
      const willHaveRef = (s.entity_ids ?? []).some((id) => {
        const e = entities.find((x) => x.id === id);
        return !!e && (!!e.ref_uri || !!e.ref_job_id || !!e.description?.trim());
      });
      const model = willHaveRef ? sceneImageModel : refModel;
      const c = imageCost(model, video.ratio);
      if (c == null) { unknown = true; continue; }
      sum += c;
    }
    total += sum;
    lines.push(`${todoImages.length} ảnh khung đầu = ${sum} cr`);
  }

  if (todoClips.length) {
    let sum = 0;
    for (const s of todoClips) {
      const c = clipCost(video.model, video.ratio, s.duration);
      if (c == null) { unknown = true; continue; }
      sum += c;
    }
    total += sum;
    const secs = todoClips.reduce((n, s) => n + (s.duration || 0), 0);
    lines.push(`${todoClips.length} clip · ${secs}s × ${video.model} @${resTier(video.ratio)} = ${sum} cr`);
  }

  return {
    credits: total,
    lines,
    unknown,
    remaining: { refs: todoRefs.length, images: todoImages.length, clips: todoClips.length },
    note: unknown ? 'Có model chưa có giá trong bảng — số thật sẽ cao hơn' : undefined,
  };
}
