/**
 * Thanh soan prompt.
 *
 * Endpoint KHONG duoc chon o day - no suy ra tu (loai ket qua + file dinh kem).
 * Dong chu nho duoi cung hien endpoint that su se duoc goi, de nguoi dung
 * hieu vi sao danh sach model thay doi khi ho dinh them file.
 */
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, kindOfFile } from '@/api/client';
import type { Field as FieldDef } from '@/lib/catalog';
import { blockedTargets, buildPayload, missingRequired } from '@/lib/catalog';
import { attachedKinds, selectActive, selectTargets, useStore } from '@/store';
import { Button, Chip, Field, Input, Select, fmt, ratioLabel, titleCase, toast } from './ui';

const KIND_LABEL: Record<string, string> = { image: 'ảnh', video: 'video', audio: 'âm thanh', file: 'file' };

export function Composer() {
  const store = useStore();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

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
      store.beginUpload();
      try {
        const { uri } = await api.upload(file);
        store.addAttachment({
          uri,
          kind: kindOfFile(file),
          name: file.name,
          preview: URL.createObjectURL(file),
        });
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Tải lên thất bại', 'err');
      } finally {
        store.endUpload();
      }
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

  // Asset dinh kem nhung model dang chon khong dung den
  const acceptedKinds = new Set(
    (variant?.fields ?? [])
      .filter((f) => f.control === 'asset' || f.control === 'asset-list')
      .flatMap((f) => f.assetKinds ?? (f.asset ? [f.asset] : []))
  );
  const unused = store.attachments.filter((a) => !acceptedKinds.has(a.kind));

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
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        {store.attachments.map((a) => (
          <div
            key={a.uri}
            className="group relative h-14 w-14 overflow-hidden rounded-lg border border-line bg-surface-2"
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
        ))}

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="grid h-14 w-14 place-items-center rounded-lg border border-dashed border-line text-ink-faint transition-colors hover:border-accent hover:text-accent"
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

        {[...hints].map(([kind, n]) => (
          <span key={kind} className="font-mono text-[10px] text-ink-faint">
            + đính {KIND_LABEL[kind]} → mở khoá {n} model
          </span>
        ))}
      </div>

      {/* Prompt + nut tao */}
      <div className="flex items-stretch gap-2">
        <textarea
          id="prompt"
          rows={1}
          value={store.prompt}
          onChange={(e) => {
            store.setPrompt(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 168)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              generate.mutate();
            }
          }}
          placeholder="Mô tả điều bạn muốn tạo…   (Ctrl+Enter để tạo)"
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none transition-colors focus:border-accent"
        />
        <Button type="submit" variant="primary" disabled={busy || !active} className="px-6">
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
              onChange={(e) => store.setModel(e.target.value)}
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
  const value = useStore((s) => s.values[field.name]);
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

    case 'number':
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
