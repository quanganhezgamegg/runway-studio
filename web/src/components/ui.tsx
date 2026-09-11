/** Cac manh giao dien dung lai nhieu noi. */
import * as Popover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap';
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-4 py-2 text-[13px]' };
  const variants = {
    default: 'bg-surface-2 border border-line hover:border-ink-faint text-ink',
    primary: 'bg-accent text-[#17120a] hover:brightness-110 font-semibold',
    ghost: 'text-ink-muted hover:text-ink hover:bg-surface-2',
    danger: 'text-err hover:bg-surface-2',
  };
  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />;
}

// ---------------------------------------------------------------------------
/** Chip tham so: bam mo popover chua dieu khien. */
export function Chip({
  label,
  value,
  highlight = false,
  children,
}: {
  label: string;
  value: ReactNode;
  highlight?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
            highlight
              ? 'border-accent/60 bg-accent-soft text-accent'
              : 'border-line bg-surface-2 text-ink-muted hover:border-ink-faint'
          }`}
        >
          <span>{label}</span>
          <span className={`font-mono font-medium ${highlight ? 'text-accent' : 'text-ink'}`}>{value}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          className="z-50 w-72 max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface p-3 shadow-2xl"
        >
          {children}
          <Popover.Arrow className="fill-[var(--line)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-1.5 text-[12px] font-medium text-ink">
        {label}
        {hint && <span className="font-mono text-[10px] font-normal text-ink-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink outline-none transition-colors focus:border-accent';

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={`${inputCls} ${p.className ?? ''}`} />
);

export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`${inputCls} ${p.className ?? ''}`} />
);

// ---------------------------------------------------------------------------
export function StatePill({ state }: { state: string }) {
  const map: Record<string, string> = {
    QUEUED: 'bg-[#23282d] text-ink-muted',
    SUBMITTED: 'bg-[#2a2110] text-accent',
    RUNNING: 'bg-[#2a2110] text-accent',
    SUCCEEDED: 'bg-[#14301f] text-ok',
    FAILED: 'bg-[#331817] text-err',
    CANCELLED: 'bg-[#23282d] text-ink-faint',
  };
  const label: Record<string, string> = {
    QUEUED: 'chờ',
    SUBMITTED: 'đang gửi',
    RUNNING: 'đang chạy',
    SUCCEEDED: 'xong',
    FAILED: 'lỗi',
    CANCELLED: 'đã huỷ',
  };
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
        map[state] ?? 'bg-surface-2 text-ink-muted'
      }`}
    >
      {label[state] ?? state}
    </span>
  );
}

// ---------------------------------------------------------------------------
/** Thanh tien do; khong biet phan tram thi chay kieu khong xac dinh. */
export function Progress({ value }: { value: number | null }) {
  return (
    <div className="relative mt-2 h-[3px] overflow-hidden rounded-full bg-line">
      {value == null ? (
        <div className="shimmer absolute inset-0" />
      ) : (
        <i
          className="block h-full bg-accent transition-[width] duration-500"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'err' | '';
}

let toastSeq = 0;
const listeners = new Set<(t: Toast) => void>();

export const toast = (msg: string, kind: Toast['kind'] = '') => {
  for (const l of listeners) l({ id: ++toastSeq, msg, kind });
};

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const add = (t: Toast) => {
      setItems((cur) => [...cur, t]);
      setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), t.kind === 'err' ? 7000 : 3400);
    };
    listeners.add(add);
    return () => void listeners.delete(add);
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[300] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto max-w-[min(520px,calc(100vw-32px))] rounded-lg border px-4 py-2.5 text-[13px] shadow-2xl ${
            t.kind === 'err'
              ? 'border-[#4d2020] bg-[#1d1314] text-[#ffb4b4]'
              : t.kind === 'ok'
                ? 'border-[#16412f] bg-[#0f1c16] text-[#9ae6c4]'
                : 'border-line bg-surface-2 text-ink'
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
export const fmt = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('vi-VN').format(n);

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}p`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "1280:720" -> "1280:720 · 16:9" */
export function ratioLabel(v: string): string {
  const m = /^(\d+):(\d+)$/.exec(v);
  if (!m) return v;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 50 || h < 50) return v;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${v} · ${w / g}:${h / g}`;
}

export const titleCase = (s: string) =>
  s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
