/**
 * Thanh soan prompt.
 *
 * Endpoint KHONG duoc chon o day - no suy ra tu (loai ket qua + file dinh kem).
 * Dong chu nho duoi cung hien endpoint that su se duoc goi, de nguoi dung
 * hieu vi sao danh sach model thay doi khi ho dinh them file.
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Field as FieldDef } from '@/lib/catalog';
import {
  assignAssets,
  blockedTargets,
  buildPayload,
  effectiveValue,
  missingRequired,
  durationChoices,
  mentionStyle,
  roleLabel,
  supportsTags,
  tagsUsedIn,
} from '@/lib/catalog';
import type { AttachedAsset } from '@/lib/catalog';
import { AttachmentTag, TagAutocomplete } from './AttachmentTag';
import { audioNotes, checkConstraints } from '@/lib/constraints';
import { checkFile, cropPreview, probeFile } from '@/lib/media';
import { REJECTION_TIPS } from '@/lib/errors';
import { attachedKinds, selectActive, selectTargets, useStore } from '@/store';
import { Button, Chip, Field, Input, Select, fmt, ratioLabel, titleCase, toast } from './ui';

const KIND_LABEL: Record<string, string> = { image: 'ảnh', video: 'video', audio: 'âm thanh', file: 'file' };

export function Composer() {
  const store = useStore();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFrameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [drag, setDrag] = useState(false);
  /** Vi tri dang go @ trong prompt, null = khong mo goi y. */
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const targets = selectTargets(store);
  const active = selectActive(store);
  const variant = active?.variant;

  const generate = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error('Chưa có tổ hợp model hợp lệ');

      const values = { ...store.values };
      if (store.prompt.trim()) values.promptText = store.prompt.trim();

      const payload = buildPayload(
        active.variant,
        values,
        store.attachments,
        store.lastFrame ?? undefined
      );

      const missing = missingRequired(active.variant, payload);
      if (missing.length) throw new Error(`Thiếu: ${missing.map(titleCase).join(', ')}`);

      return api.generate({
        path: active.endpoint.path,
        payload,
        title: `${active.endpoint.title} · ${active.variant.model}`,
      });
    },
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast(job.state === 'QUEUED' ? 'Đã thêm vào hàng đợi' : 'Đã gửi', 'ok');
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  async function handleFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      // Doc metadata roi kiem tra TRUOC khi upload: bat loi o day thay vi
      // de Runway tu choi sau khi da tai len, hoac sau khi da tieu credit.
      const info = await probeFile(file);
      const issues = checkFile(file, info);

      const blocking = issues.filter((i) => i.level === 'error');
      if (blocking.length) {
        toast(`${file.name}: ${blocking[0]!.message}`, 'err');
        continue;
      }
      for (const w of issues) toast(`${file.name}: ${w.message}`);

      store.beginUpload();
      try {
        const { uri } = await api.upload(file);
        store.addAttachment({
          uri,
          kind: info.kind,
          name: file.name,
          preview: URL.createObjectURL(file),
          width: info.width,
          height: info.height,
          duration: info.duration,
          sizeBytes: info.sizeBytes,
          mime: info.mime,
        });
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Tai len that bai', 'err');
      } finally {
        store.endUpload();
      }
    }
  }

  /** Chon anh lam khung hinh cuoi (muc A3 cua tai lieu). */
  async function pickLastFrame(file: File) {
    const info = await probeFile(file);
    const blocking = checkFile(file, info).filter((i) => i.level === 'error');
    if (blocking.length) return toast(blocking[0]!.message, 'err');

    store.beginUpload();
    try {
      const { uri } = await api.upload(file);
      store.setLastFrame({
        uri,
        kind: 'image',
        name: file.name,
        preview: URL.createObjectURL(file),
        width: info.width,
        height: info.height,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Tai len that bai', 'err');
    } finally {
      store.endUpload();
    }
  }

  // Tham so hien thanh chip. Cac field con lai gom vao mot popover.
  const INLINE = new Set(['ratio', 'resolution', 'duration', 'seed', 'outputCount', 'quality', 'audio']);
  const chipFields = (variant?.fields ?? []).filter(
    (f) => INLINE.has(f.name) && f.control !== 'asset' && f.control !== 'asset-list'
  );
  const restFields = (variant?.fields ?? []).filter(
    (f) =>
      !INLINE.has(f.name) &&
      f.name !== 'promptText' &&
      f.control !== 'asset' &&
      f.control !== 'asset-list'
  );

  // Goi y: dinh them loai file nao thi mo khoa bao nhieu model
  const hints = store.catalog && !store.toolPath
    ? blockedTargets(store.catalog, store.outputKind, attachedKinds(store.attachments))
    : new Map();

  // Vai tro thuc te cua tung asset voi model dang chon.
  // Khong co map nay thi nguoi dung khong biet anh minh dinh vao dang lam gi:
  // khung dau cua video? anh tham chieu goi bang @tag? hay bi bo qua?
  const roles = useMemo(
    () => (variant ? assignAssets(variant, store.attachments) : new Map<string, string>()),
    [variant, store.attachments]
  );
  const unused = store.attachments.filter((a) => !roles.has(a.uri));

  // Cach goi tham chieu: @tag (co truong tag) hay [Image N] (theo vi tri)
  const mention2 = mentionStyle(variant);
  const tagsOn = supportsTags(variant);
  const usedTags = useMemo(() => tagsUsedIn(store.prompt), [store.prompt]);
  const taggable = store.attachments.filter((a) => roles.get(a.uri) === 'referenceImages');

  /** Vi tri cua mot anh trong danh sach tham chieu (dung cho [Image N]). */
  const refIndex = (uri: string) => taggable.findIndex((a) => a.uri === uri);

  /** Chen mot doan text bat ky vao prompt tai vi tri con tro. */
  function insertText(text: string) {
    const el = promptRef.current;
    const cur = store.prompt;
    const from = el?.selectionStart ?? cur.length;
    const before = cur.slice(0, from);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${pad}${text} ${cur.slice(from).replace(/^ /, '')}`;
    store.setPrompt(next);
    requestAnimationFrame(() => {
      const pos = before.length + pad.length + text.length + 1;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  /** Chen @tag vao prompt tai vi tri con tro. */
  function insertMention(asset: AttachedAsset, replaceFrom?: number) {
    const el = promptRef.current;
    const text = store.prompt;
    const from = replaceFrom ?? el?.selectionStart ?? text.length;
    const to = el?.selectionEnd ?? from;

    const before = text.slice(0, from);
    const after = text.slice(replaceFrom != null ? to : to);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${pad}@${asset.tag} ${after.replace(/^ /, '')}`;

    store.setPrompt(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = before.length + pad.length + 1 + (asset.tag?.length ?? 0) + 1;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  /** Sau moi lan go, kiem tra con tro co dang o sau mot @ nao khong. */
  function detectMention(text: string, caret: number) {
    if (!tagsOn || !taggable.length) return setMention(null);
    const upto = text.slice(0, caret);
    const m = /@([a-z0-9_]*)$/i.exec(upto);
    if (!m) return setMention(null);
    setMention({ start: caret - m[0].length, query: m[1]!.toLowerCase() });
    setMentionIndex(0);
  }

  const mentionMatches = mention
    ? taggable.filter((a) => (a.tag ?? '').startsWith(mention.query))
    : [];

  // --- Rang buoc: khoa nut Tao ngay thay vi de nguoi dung bam roi moi bao loi ---
  const violations = useMemo(
    () =>
      checkConstraints(variant, {
        attachments: store.attachments,
        lastFrame: store.lastFrame,
        prompt: store.prompt,
        values: store.values,
      }),
    [variant, store.attachments, store.lastFrame, store.prompt, store.values]
  );
  const notes = useMemo(() => audioNotes(variant, store.values), [variant, store.values]);
  const blocked = violations.some((v) => v.level === 'block');

  // Model nay co nhan khung hinh cuoi khong
  const frameField = (variant?.fields ?? []).find((f) => f.control === 'asset' && f.supportsLastFrame);
  const hasFirstFrame = store.attachments.some((a) => roles.get(a.uri) === frameField?.name);

  // Anh khong dung ti le khung hinh se bi cat tu tam - phai cho thay truoc
  const ratioValue = String(effectiveValue(
    (variant?.fields ?? []).find((f) => f.name === 'ratio') ?? { name: 'ratio', required: false, description: '', control: 'text' },
    store.values
  ) ?? '');
  const crops = store.attachments
    .filter((a) => a.kind === 'image' && a.width && a.height)
    .map((a) => ({ asset: a, crop: cropPreview({ kind: 'image', width: a.width, height: a.height, sizeBytes: a.sizeBytes ?? 0, mime: a.mime ?? '' }, ratioValue) }))
    .filter((x) => x.crop);

  const busy = generate.isPending || store.uploading > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        generate.mutate();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
      }}
      className={`shrink-0 border-t bg-surface px-4 py-3 transition-colors ${
        drag ? 'border-accent bg-accent-soft/30' : 'border-line'
      }`}
    >
      {/* Dinh kem */}
      <div className="mb-2 flex flex-wrap items-start gap-2">
        {store.attachments.map((a) => {
          const role = roles.get(a.uri);
          const isRef = role === 'referenceImages';
          return (
            <div key={a.uri} className="w-[84px]">
              <div
                className={`group relative h-14 w-full overflow-hidden rounded-lg border bg-surface-2 ${
                  role ? 'border-line' : 'border-warn/60'
                }`}
                title={a.name}
              >
                {a.kind === 'image' && a.preview ? (
                  <img src={a.preview} alt="" className="h-full w-full object-cover" />
                ) : a.kind === 'video' && a.preview ? (
                  <video src={a.preview} muted className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full place-items-center text-[10px] text-ink-faint">
                    {KIND_LABEL[a.kind]}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => store.removeAttachment(a.uri)}
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded bg-black/70 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Bỏ ${a.name}`}
                >
                  ✕
                </button>
              </div>

              {/* Vai tro thuc te cua anh nay voi model dang chon */}
              <div className="mt-1">
                {tagsOn && isRef ? (
                  <AttachmentTag
                    asset={a}
                    used={usedTags.has(a.tag ?? '')}
                    taken={store.attachments.filter((x) => x.uri !== a.uri).map((x) => x.tag ?? '')}
                    onRename={(tag) => store.setAttachmentTag(a.uri, tag)}
                    onInsert={() => insertMention(a)}
                  />
                ) : mention2 === 'index' && isRef ? (
                  <button
                    type="button"
                    onClick={() => insertText(`[Image ${refIndex(a.uri) + 1}]`)}
                    title={`Chèn [Image ${refIndex(a.uri) + 1}] vào prompt`}
                    className="w-full truncate rounded bg-surface-2 px-1 py-0.5 text-center font-mono text-[9.5px] text-ink-faint transition-colors hover:bg-line hover:text-ink-muted"
                  >
                    [Image {refIndex(a.uri) + 1}]
                  </button>
                ) : (
                  <div
                    className={`truncate text-center text-[9.5px] ${
                      role ? 'text-ink-faint' : 'text-warn'
                    }`}
                    title={role ? roleLabel(role) : 'Model này không dùng file này'}
                  >
                    {role ? roleLabel(role) : 'không dùng'}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="grid h-14 w-[84px] place-items-center rounded-lg border border-dashed border-line text-ink-faint transition-colors hover:border-accent hover:text-accent"
          aria-label="Thêm file"
        >
          {store.uploading > 0 ? <span className="text-[10px]">…</span> : '+'}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={lastFrameRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickLastFrame(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* Goi y mo khoa them model - de rieng mot dong cho de doc */}
      {hints.size > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
          {[...hints].map(([kind, n]) => (
            <button
              key={kind}
              type="button"
              onClick={() => fileRef.current?.click()}
              className="transition-colors hover:text-accent"
            >
              Đính {KIND_LABEL[kind]} để mở khoá <b className="font-medium text-ink-muted">{n}</b> model khác
            </button>
          ))}
        </div>
      )}

      {/* Khung hinh cuoi - chi hien voi model nhan no va da co khung dau */}
      {frameField && hasFirstFrame && (
        <div className="mb-2 flex items-center gap-2">
          {store.lastFrame ? (
            <>
              <div className="relative h-10 w-[60px] overflow-hidden rounded border border-line">
                {store.lastFrame.preview && (
                  <img src={store.lastFrame.preview} alt="" className="h-full w-full object-cover" />
                )}
              </div>
              <span className="font-mono text-[10px] text-ink-faint">khung cuối</span>
              <button
                type="button"
                onClick={() => store.setLastFrame(null)}
                className="text-[11px] text-ink-faint transition-colors hover:text-err"
              >
                bỏ
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => lastFrameRef.current?.click()}
              className="rounded border border-dashed border-line px-2.5 py-1 text-[11px] text-ink-faint transition-colors hover:border-accent hover:text-accent"
            >
              + Thêm khung hình cuối
            </button>
          )}
        </div>
      )}

      {/* Vi pham rang buoc + canh bao */}
      {(violations.length > 0 || notes.length > 0 || crops.length > 0) && (
        <div className="mb-2 flex flex-col gap-1.5">
          {violations.map((v, i) => (
            <div
              key={`v${i}`}
              className={`rounded-md border px-2.5 py-1.5 text-[11.5px] leading-snug ${
                v.level === 'block'
                  ? 'border-err/50 bg-[#1d1314] text-[#ffb4b4]'
                  : 'border-warn/40 bg-[#1d1a10] text-warn'
              }`}
            >
              {v.message}
            </div>
          ))}
          {notes.map((n, i) => (
            <div
              key={`n${i}`}
              className="rounded-md border border-warn/40 bg-[#1d1a10] px-2.5 py-1.5 text-[11.5px] leading-snug text-warn"
            >
              {n.message}
            </div>
          ))}
          {crops.map(({ asset, crop }) => (
            <div
              key={asset.uri}
              className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-muted"
            >
              "{asset.name}" không đúng tỉ lệ {ratioValue} — sẽ bị cắt {crop!.cropPercent}% theo
              chiều {crop!.axis}, tính từ tâm ảnh.
            </div>
          ))}
        </div>
      )}

      {/* Prompt + nut tao */}
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <textarea
            id="prompt"
            ref={promptRef}
            rows={1}
            value={store.prompt}
            onChange={(e) => {
              store.setPrompt(e.target.value);
              detectMention(e.target.value, e.target.selectionStart);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 168)}px`;
            }}
            onClick={(e) => detectMention(store.prompt, e.currentTarget.selectionStart)}
            onBlur={() => setMention(null)}
            onKeyDown={(e) => {
              // Dieu huong danh sach goi y @tag truoc, roi moi den Ctrl+Enter
              if (mention && mentionMatches.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  return setMentionIndex((i) => (i + 1) % mentionMatches.length);
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  return setMentionIndex(
                    (i) => (i - 1 + mentionMatches.length) % mentionMatches.length
                  );
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const pick = mentionMatches[mentionIndex];
                  if (pick) insertMention(pick, mention.start);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  return setMention(null);
                }
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                generate.mutate();
              }
            }}
            placeholder={
              tagsOn && taggable.length
                ? 'Mô tả điều bạn muốn tạo…   gõ @ để gọi ảnh tham chiếu'
                : 'Mô tả điều bạn muốn tạo…'
            }
            title="Ctrl+Enter để tạo"
            className="min-h-[44px] w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none transition-colors focus:border-accent"
          />
          {mention && (
            <TagAutocomplete
              matches={mentionMatches}
              activeIndex={mentionIndex}
              onPick={(a) => insertMention(a, mention.start)}
            />
          )}
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !active || blocked}
          className="shrink-0 px-6"
          title={blocked ? 'Còn ràng buộc chưa thoả' : 'Ctrl+Enter'}
        >
          {generate.isPending ? 'Đang gửi…' : 'Tạo'}
        </Button>
      </div>

      {/* Chip tham so */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {/* Model */}
        <Chip label="model" value={active?.variant.model ?? '—'} highlight>
          <Field label="Model" hint={`${targets.length} hợp lệ với input hiện tại`}>
            <Select
              value={active?.variant.model ?? ''}
              onChange={(e) => {
                const dropped = store.setModel(e.target.value);
                if (dropped.length) {
                  toast(
                    `Đã bỏ ${dropped.map(titleCase).join(', ')} — model mới không nhận giá trị cũ`
                  );
                }
              }}
            >
              {targets.map((t) => (
                <option key={`${t.endpoint.path}:${t.variant.model}`} value={t.variant.model}>
                  {t.variant.model}
                </option>
              ))}
            </Select>
          </Field>
          {targets.length > 1 && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              Danh sách này đã lọc theo những gì bạn đính kèm. Thêm hoặc bớt file sẽ đổi danh sách.
            </p>
          )}
        </Chip>

        {chipFields.map((f) => (
          <ChipControl key={f.name} field={f} />
        ))}

        <Chip label="?" value="mẹo">
          <div className="text-[12px] font-medium text-ink">Ba nguyên nhân hay bị từ chối</div>
          <ul className="mt-1.5 list-disc pl-4 text-[11.5px] leading-relaxed text-ink-muted">
            {REJECTION_TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Chip>

        {restFields.length > 0 && (
          <Chip label="⚙" value={`${restFields.length} tham số`}>
            <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
              {restFields.map((f) => (
                <Control key={f.name} field={f} />
              ))}
            </div>
          </Chip>
        )}
      </div>

      {/* Endpoint duoc suy ra + canh bao file thua */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-faint">
        {active && <span>→ {active.endpoint.path}</span>}
        {unused.length > 0 && (
          <span className="text-warn">
            model này không dùng {unused.map((a) => KIND_LABEL[a.kind]).join(', ')} bạn đính kèm
          </span>
        )}
        {!active && <span className="text-err">Không có model nào hợp lệ với input hiện tại</span>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
/** Chip hien gia tri hien tai, bam ra popover chua dieu khien. */
function ChipControl({ field }: { field: FieldDef }) {
  const values = useStore((s) => s.values);
  const value = effectiveValue(field, values);
  const shown =
    value == null || value === ''
      ? field.name === 'seed'
        ? 'ngẫu nhiên'
        : 'mặc định'
      : String(value);

  return (
    <Chip label={titleCase(field.name).toLowerCase()} value={shown}>
      <Control field={field} />
    </Chip>
  );
}

/** Dieu khien cho mot field, dung theo control sinh tu OpenAPI spec. */
function Control({ field }: { field: FieldDef }) {
  const value = useStore((s) => s.values[field.name]);
  const setValue = useStore((s) => s.setValue);

  const hint =
    field.control === 'number' && (field.min != null || field.max != null)
      ? `${field.min ?? ''}–${field.max ?? ''}`
      : undefined;

  switch (field.control) {
    case 'select': {
      const opts = field.options ?? [];
      return (
        <Field label={titleCase(field.name)} hint={hint}>
          <Select
            value={(value as string) ?? ''}
            onChange={(e) => setValue(field.name, e.target.value || undefined)}
          >
            {!field.required && <option value="">— mặc định —</option>}
            {opts.map((o) => (
              <option key={o} value={o}>
                {field.hint === 'ratio' ? ratioLabel(o) : o}
              </option>
            ))}
          </Select>
          {field.description && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{field.description}</p>
          )}
        </Field>
      );
    }

    case 'number': {
      // E3: thoi luong phai chon tu danh sach, khong nhap tu do
      const choices = durationChoices(field);
      if (choices) {
        return (
          <Field label={titleCase(field.name)} hint="giây">
            <Select
              value={String(value ?? '')}
              onChange={(e) =>
                setValue(field.name, e.target.value === '' ? undefined : Number(e.target.value))
              }
            >
              {!field.required && <option value="">— mặc định —</option>}
              {choices.map((c) => (
                <option key={c} value={c}>
                  {c} giây
                </option>
              ))}
            </Select>
          </Field>
        );
      }
      return (
        <Field label={titleCase(field.name)} hint={hint}>
          <div className="flex gap-2">
            <Input
              type="number"
              value={(value as number) ?? ''}
              min={field.min ?? undefined}
              max={field.max ?? undefined}
              placeholder={field.name === 'seed' ? 'trống = ngẫu nhiên' : ''}
              onChange={(e) =>
                setValue(field.name, e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
            {field.name === 'seed' && (
              <Button
                type="button"
                size="sm"
                onClick={() => setValue('seed', Math.floor(Math.random() * 4294967295))}
              >
                🎲
              </Button>
            )}
          </div>
        </Field>
      );
    }

    case 'boolean':
      return (
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={Boolean(value ?? field.default ?? false)}
            onChange={(e) => setValue(field.name, e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="text-[12.5px]">{titleCase(field.name)}</span>
        </label>
      );

    case 'json':
      if (field.name === 'contentModeration') {
        return (
          <Field label="Kiểm duyệt nội dung">
            <Select
              value={
                (value as { publicFigureThreshold?: string } | undefined)?.publicFigureThreshold ?? ''
              }
              onChange={(e) =>
                setValue(
                  field.name,
                  e.target.value ? { publicFigureThreshold: e.target.value } : undefined
                )
              }
            >
              <option value="">— mặc định —</option>
              <option value="auto">auto — chặn người nổi tiếng</option>
              <option value="low">low — nới lỏng</option>
            </Select>
          </Field>
        );
      }
      return (
        <Field label={titleCase(field.name)}>
          <textarea
            rows={3}
            defaultValue={value ? JSON.stringify(value, null, 2) : ''}
            onChange={(e) => {
              try {
                setValue(field.name, e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
                e.target.style.borderColor = '';
              } catch {
                e.target.style.borderColor = 'var(--err)';
              }
            }}
            className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
          />
        </Field>
      );

    default:
      return (
        <Field label={titleCase(field.name)} hint={hint}>
          <Input
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => setValue(field.name, e.target.value || undefined)}
          />
          {field.description && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{field.description}</p>
          )}
        </Field>
      );
  }
}

export { fmt };
