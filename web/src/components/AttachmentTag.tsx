/**
 * Nhan @tag cho anh tham chieu.
 *
 * Runway cho dat nhan len tung anh trong `referenceImages`, roi goi lai trong
 * prompt bang @tag — vi du "@logo dat tren @background". Rang buoc tu spec:
 * 3-16 ky tu, bat dau bang chu cai, chi chu thuong / so / gach duoi.
 *
 * Chi 8 model cua /v1/text_to_image nhan nhan nay, nen component chi duoc
 * render khi supportsTags(variant) tra ve true.
 */
import { useEffect, useRef, useState } from 'react';
import { TAG_MAX, sanitizeTag, tagError } from '@/lib/catalog';
import type { AttachedAsset } from '@/lib/catalog';

export function AttachmentTag({
  asset,
  used,
  taken,
  onRename,
  onInsert,
}: {
  asset: AttachedAsset;
  /** Nhan nay da duoc goi trong prompt chua. */
  used: boolean;
  /** Cac nhan khac dang dung, de chan trung. */
  taken: string[];
  onRename: (tag: string) => void;
  onInsert: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asset.tag ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const err = editing
    ? (tagError(draft) ?? (taken.includes(draft) ? 'Nhãn này đã dùng cho ảnh khác' : null))
    : null;

  function commit() {
    if (err || !draft) {
      setDraft(asset.tag ?? '');
      setEditing(false);
      return;
    }
    onRename(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="relative">
        <input
          ref={inputRef}
          value={draft}
          maxLength={TAG_MAX}
          onChange={(e) => setDraft(sanitizeTag(e.target.value))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(asset.tag ?? '');
              setEditing(false);
            }
          }}
          className={`w-full rounded border bg-surface px-1 py-0.5 text-center font-mono text-[9.5px] outline-none ${
            err ? 'border-err text-err' : 'border-accent text-ink'
          }`}
        />
        {err && (
          <div className="absolute bottom-full left-0 z-20 mb-1 w-44 rounded border border-err bg-surface px-2 py-1 text-[10px] leading-snug text-err shadow-lg">
            {err}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onInsert}
        title={`Chèn @${asset.tag} vào prompt`}
        className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 font-mono text-[9.5px] transition-colors ${
          used
            ? 'bg-accent-soft text-accent'
            : 'bg-surface-2 text-ink-faint hover:bg-line hover:text-ink-muted'
        }`}
      >
        @{asset.tag}
      </button>
      <button
        type="button"
        onClick={() => {
          setDraft(asset.tag ?? '');
          setEditing(true);
        }}
        title="Đổi tên nhãn"
        className="shrink-0 px-0.5 text-[9px] text-ink-faint transition-colors hover:text-ink"
      >
        ✎
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Danh sach goi y khi nguoi dung dang go @ trong prompt. */
export function TagAutocomplete({
  matches,
  activeIndex,
  label,
  onPick,
}: {
  matches: AttachedAsset[];
  activeIndex: number;
  /** Cu phap goi anh, khac nhau theo model: @ten hoac [Image N]. */
  label: (asset: AttachedAsset) => string;
  onPick: (asset: AttachedAsset) => void;
}) {
  if (!matches.length) return null;

  return (
    <ul
      role="listbox"
      className="absolute bottom-full left-0 z-30 mb-1.5 max-h-52 w-60 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-2xl"
    >
      {matches.map((a, i) => (
        <li key={a.uri}>
          <button
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(e) => {
              e.preventDefault(); // giu focus o textarea
              onPick(a);
            }}
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${
              i === activeIndex ? 'bg-surface-2' : 'hover:bg-surface-2'
            }`}
          >
            {a.preview && a.kind === 'image' ? (
              <img src={a.preview} alt="" className="h-7 w-7 shrink-0 rounded object-cover" />
            ) : (
              <span className="h-7 w-7 shrink-0 rounded bg-surface-2" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[11.5px] text-accent">{label(a)}</span>
              <span className="block truncate text-[10px] text-ink-faint">{a.name}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
