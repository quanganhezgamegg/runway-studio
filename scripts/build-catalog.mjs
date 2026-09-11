/**
 * Chuyen OpenAPI spec cua Runway thanh mot "catalog" gon nhe ma frontend
 * dung de render form dong.
 *
 * Spec goc dung discriminated union theo `model`: moi endpoint co 1..16 variant,
 * moi variant ung voi mot model va co bo field/ratio/duration rieng. Neu hard-code
 * thi phai viet tay hang tram form; thay vao do ta trich xuat thanh:
 *
 *   { endpoints: [ { path, id, title, kind, models: [ { model, fields: [...] } ] } ] }
 *
 * Chay:  node scripts/build-catalog.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SPEC_PATH = join(ROOT, 'spec', 'runway-openapi.json');
const OUT_PATH = join(ROOT, 'public', 'catalog.json');

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

/** Resolve $ref (co chong lap) thanh schema thuc. */
function deref(node, depth = 0) {
  if (depth > 12 || !node || typeof node !== 'object') return node;
  if (node.$ref) {
    const parts = node.$ref.replace(/^#\//, '').split('/');
    let target = spec;
    for (const p of parts) target = target?.[p];
    return deref(target, depth + 1);
  }
  return node;
}

/** Gop allOf thanh mot object schema phang. */
function flatten(schema, depth = 0) {
  const s = deref(schema, depth);
  if (!s || typeof s !== 'object') return s;
  if (!Array.isArray(s.allOf)) return s;
  const merged = { type: 'object', properties: {}, required: [] };
  for (const part of s.allOf) {
    const p = flatten(part, depth + 1);
    Object.assign(merged.properties, p.properties || {});
    merged.required.push(...(p.required || []));
  }
  for (const [k, v] of Object.entries(s)) {
    if (k === 'allOf') continue;
    if (k === 'properties') Object.assign(merged.properties, v);
    else if (k === 'required') merged.required.push(...v);
    else merged[k] = v;
  }
  return merged;
}

/**
 * Duyet het cac nhanh la cua oneOf/anyOf long nhau.
 * Spec long anyOf trong oneOf nen phai de quy moi lay duoc day du.
 */
function leafBranches(schema, depth = 0, out = []) {
  const s = flatten(schema, depth);
  if (!s || typeof s !== 'object' || depth > 8) return out;
  const branches = s.oneOf || s.anyOf;
  if (Array.isArray(branches)) {
    for (const b of branches) leafBranches(b, depth + 1, out);
  } else {
    out.push(s);
  }
  return out;
}

/**
 * Nhan dien field nhan asset.
 *
 * Dau hieu tin cay la `pattern` cua nhanh string: ^https://, ^runway:// hoac ^data:.
 * KHONG duoc chi dua vao "moi nhanh deu la string" - vi `ratio` dang
 * {enum} | string cung thoa dieu kien do va se bi nham thanh o upload file.
 */
const URI_PATTERN = /\^(https|runway|data)/i;

function isAssetSchema(schema) {
  const leaves = leafBranches(schema);
  if (!leaves.length) return false;
  // Co enum -> day la tap gia tri co dinh, khong phai asset
  if (leaves.some((b) => Array.isArray(b.enum))) return false;
  return leaves.some(
    (b) =>
      b.type === 'string' &&
      (URI_PATTERN.test(b.pattern || '') || b.format === 'uri' || !!b.contentMediaType)
  );
}

/**
 * Asset co the boc trong object co the (`character`, `media`, `speech`…):
 *   oneOf: [ {type: {const:'image'}, uri: <asset>}, {type: {const:'video'}, uri: <asset>} ]
 *
 * Khac voi asset dang chuoi thuan, dang nay payload phai la {type, uri}
 * chu khong phai chuoi. Bo qua no thi character_performance va avatar_videos
 * bi coi nhu khong can input, va suy ra endpoint se sai.
 */
function taggedAssetVariants(schema) {
  const leaves = leafBranches(schema);
  const objs = leaves.filter((b) => b.type === 'object' && b.properties?.uri);
  if (!objs.length || !objs.every((b) => isAssetSchema(b.properties.uri))) return null;

  return objs.map((b) => {
    const typeSchema = flatten(b.properties.type);
    return {
      type: typeSchema?.const ?? (Array.isArray(typeSchema?.enum) ? typeSchema.enum[0] : null),
      asset: assetKind(b.title || '', b.properties.uri),
      required: b.required || [],
    };
  });
}

/** Doan loai asset (image/video/audio) tu contentMediaType, du phong bang ten field. */
function assetKind(name, schema) {
  const media = leafBranches(schema)
    .map((b) => `${b.contentMediaType || ''} ${b.description || ''}`)
    .join(' ')
    .toLowerCase();
  if (/image\/|\bimage\b/.test(media)) return 'image';
  if (/video\/|\bvideo\b/.test(media)) return 'video';
  if (/audio\/|\baudio\b/.test(media)) return 'audio';
  const n = name.toLowerCase();
  if (n.includes('video')) return 'video';
  if (n.includes('audio') || n.includes('voice') || n.includes('speech')) return 'audio';
  if (n.includes('image') || n.includes('reference')) return 'image';
  return 'file';
}

/**
 * Lay enum tu schema, ke ca khi nam trong oneOf/anyOf long nhau.
 * Tra ve { values, allowCustom } - allowCustom=true khi con nhanh string tu do
 * (vd: ratio cua seedream5_lite la {16 gia tri} | string bat ky).
 */
function collectEnum(schema) {
  const leaves = leafBranches(schema);
  if (!leaves.length) return null;
  const values = [];
  let allowCustom = false;
  for (const b of leaves) {
    if (Array.isArray(b.enum)) values.push(...b.enum);
    else if (b.type === 'string') allowCustom = true;
  }
  if (!values.length) return null;
  return { values: [...new Set(values)], allowCustom };
}

/** Bien mot property schema thanh mo ta field cho UI. */
function describeField(name, schema, required) {
  const s = flatten(schema);
  const field = {
    name,
    required: !!required,
    description: s?.description || '',
  };

  // Mang cac asset (referenceImages, referenceVideos, referenceAudio...)
  if (s?.type === 'array') {
    const item = flatten(s.items);
    const itemProps = item?.properties || {};
    if (itemProps.uri && isAssetSchema(itemProps.uri)) {
      field.control = 'asset-list';
      field.asset = assetKind(name, itemProps.uri);
      field.assetKinds = [field.asset];
      field.maxItems = s.maxItems ?? null;
      field.itemFields = Object.entries(itemProps)
        .filter(([k]) => k !== 'uri')
        .map(([k, v]) => describeField(k, v, (item.required || []).includes(k)));
      return field;
    }
    if (isAssetSchema(s.items)) {
      field.control = 'asset-list';
      field.asset = assetKind(name, s.items);
      field.assetKinds = [field.asset];
      field.maxItems = s.maxItems ?? null;
      field.itemFields = [];
      return field;
    }
  }

  // promptImage cua image_to_video: string HOAC [{uri, position}]
  if (name === 'promptImage') {
    field.control = 'asset';
    field.asset = 'image';
    field.assetKinds = ['image'];
    field.supportsLastFrame = JSON.stringify(s).includes('"last"');
    return field;
  }

  // Asset boc trong object co the: {type: 'image'|'video', uri}
  const tagged = taggedAssetVariants(s);
  if (tagged) {
    field.control = 'asset';
    field.wrap = 'object';
    field.variants = tagged;
    field.assetKinds = [...new Set(tagged.map((t) => t.asset))];
    field.asset = field.assetKinds[0];
    return field;
  }

  if (isAssetSchema(s)) {
    field.control = 'asset';
    field.asset = assetKind(name, s);
    field.assetKinds = [field.asset];
    return field;
  }

  const enumInfo = collectEnum(s);
  if (enumInfo) {
    field.control = 'select';
    field.options = enumInfo.values.map((v) => String(v));
    field.allowCustom = enumInfo.allowCustom;
    // ratio dang "1280:720" -> them nhan ty le de nguoi dung de chon
    if (name === 'ratio' || name === 'resolution') field.hint = 'ratio';
    return field;
  }

  if (s?.type === 'boolean') {
    field.control = 'boolean';
    field.default = s.default ?? false;
    return field;
  }

  if (s?.type === 'integer' || s?.type === 'number') {
    field.control = 'number';
    field.min = s.minimum ?? null;
    field.max = s.maximum ?? null;
    field.step = s.type === 'integer' ? 1 : 'any';
    return field;
  }

  // duration doi khi la  integer | string  (oneOf)
  const branches = s?.oneOf || s?.anyOf;
  if (Array.isArray(branches)) {
    const nums = branches.map((b) => flatten(b)).filter((b) => b?.type === 'integer' || b?.type === 'number');
    if (nums.length) {
      field.control = 'number';
      field.min = Math.min(...nums.map((n) => n.minimum ?? 0));
      field.max = Math.max(...nums.map((n) => n.maximum ?? 0));
      field.step = 1;
      return field;
    }
  }

  if (s?.type === 'object') {
    field.control = 'json';
    return field;
  }

  // Mac dinh: text. Prompt thi dung textarea.
  field.control = /prompt|text|description/i.test(name) && name !== 'promptImage' ? 'textarea' : 'text';
  if (s?.maxLength) field.maxLength = s.maxLength;
  return field;
}

/**
 * Nhung endpoint POST tra ve `id` nhung KHONG phai task generation
 * (chung tao resource CRUD, khong poll qua /v1/tasks/{id}).
 */
const NOT_GENERATION = new Set([
  '/v1/voices',
  '/v1/documents',
  '/v1/realtime_sessions',
  '/v1/routers',
  '/v1/workflows/{id}', // poll qua /v1/workflow_invocations/{id}, khac luong
  '/v1/organization/usage',
  '/v1/voices/preview',
  '/v1/avatars',
]);

/** Phan loai endpoint de nhom trong sidebar. */
function classify(path) {
  if (path.startsWith('/v1/recipes/')) return 'recipe';

  // avatar_videos can mot avatar ID tao qua POST /v1/avatars, ma endpoint do
  // chua co giao dien. De no o nhom video thi no thanh model mac dinh cua
  // "Video + khong dinh kem" - nguoi dung bam Tao va luon that bai.
  // Xep vao Cong cu: van thay duoc, nhung khong chan duong gen4.5.
  if (/avatar_videos/.test(path)) return 'other';

  if (/character_performance/.test(path)) return 'video';
  if (/video/i.test(path) && !/upscale|hdr/i.test(path)) return 'video';
  if (/image/i.test(path) && !/upscale/i.test(path)) return 'image';
  if (/speech|sound|voice|audio/i.test(path)) return 'audio';
  if (/upscale|hdr/i.test(path)) return 'enhance';
  return 'other';
}

const TITLES = {
  '/v1/text_to_video': 'Text → Video',
  '/v1/image_to_video': 'Image → Video',
  '/v1/video_to_video': 'Video → Video',
  '/v1/text_to_image': 'Text → Image',
  '/v1/image_upscale': 'Image Upscale',
  '/v1/video_upscale': 'Video Upscale',
  '/v1/video_to_hdr': 'Video → HDR',
  '/v1/character_performance': 'Character Performance',
  '/v1/text_to_speech': 'Text → Speech',
  '/v1/speech_to_speech': 'Speech → Speech',
  '/v1/sound_effect': 'Sound Effect',
  '/v1/voice_isolation': 'Voice Isolation',
  '/v1/voice_dubbing': 'Voice Dubbing',
  '/v1/avatar_videos': 'Avatar Video',
  '/v1/generate/video': 'Generate Video (router)',
  '/v1/generate/image': 'Generate Image (router)',
  '/v1/generate/audio': 'Generate Audio (router)',
  '/v1/recipes/ad_localization': 'Ad Localization',
  '/v1/recipes/marketing_stock_image': 'Marketing Stock Image',
  '/v1/recipes/multi_shot_video': 'Multi-shot Video',
  '/v1/recipes/product_ad': 'Product Ad',
  '/v1/recipes/product_campaign_image': 'Product Campaign Image',
  '/v1/recipes/product_swap': 'Product Swap',
  '/v1/recipes/product_ugc': 'Product UGC',
};

const endpoints = [];

for (const [path, item] of Object.entries(spec.paths)) {
  const op = item.post;
  if (!op) continue;
  if (NOT_GENERATION.has(path)) continue;

  // Endpoint sinh noi dung = tra ve { id, ... } de poll qua /v1/tasks/{id}
  const okResp = flatten(op.responses?.['200']?.content?.['application/json']?.schema);
  const respProps = okResp?.properties || {};
  if (!respProps.id) continue;

  const bodySchema = flatten(op.requestBody?.content?.['application/json']?.schema);
  if (!bodySchema) continue;

  const variants = bodySchema.oneOf || bodySchema.anyOf || [bodySchema];
  const models = [];

  for (const variant of variants) {
    const v = flatten(variant);
    const props = v.properties || {};
    const required = new Set(v.required || []);

    const modelSchema = flatten(props.model);
    const modelName =
      modelSchema?.const ??
      (Array.isArray(modelSchema?.enum) && modelSchema.enum.length === 1 ? modelSchema.enum[0] : null);

    const fields = Object.entries(props)
      .filter(([k]) => k !== 'model')
      .map(([k, v2]) => describeField(k, v2, required.has(k)));

    models.push({
      model: modelName || '(default)',
      hasModelField: !!props.model,
      modelOptions: !modelName && Array.isArray(modelSchema?.enum) ? modelSchema.enum : null,
      fields,
    });
  }

  endpoints.push({
    path,
    id: path.replace('/v1/', '').replace(/\//g, '_'),
    title: TITLES[path] || path.replace('/v1/', ''),
    kind: classify(path),
    summary: op.summary || '',
    description: (op.description || '').slice(0, 400),
    models,
  });
}

// Sap xep: video -> image -> audio -> enhance -> recipe -> other
const ORDER = { video: 0, image: 1, audio: 2, enhance: 3, recipe: 4, other: 5 };
endpoints.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || a.title.localeCompare(b.title));

const catalog = {
  generatedAt: new Date().toISOString(),
  apiVersion: spec.info?.version || '2024-11-06',
  server: spec.servers?.[0]?.url || 'https://api.dev.runwayml.com',
  endpoints,
};

writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2), 'utf8');

const totalModels = endpoints.reduce((n, e) => n + e.models.length, 0);
console.log(`catalog.json: ${endpoints.length} endpoints, ${totalModels} model variants`);
for (const e of endpoints) {
  console.log(`  [${e.kind.padEnd(7)}] ${e.title.padEnd(28)} ${String(e.models.length).padStart(2)} models  ${e.path}`);
}
