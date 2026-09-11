import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '@/api/client';
import type { Job, Me } from '@/api/client';
import type { OutputKind } from '@/lib/catalog';
import { selectActive, selectTools, useStore } from '@/store';
import { Composer } from './components/Composer';
import { Gallery } from './components/Gallery';
import { Button, Field, Input, Select, Toaster, fmt, toast } from './components/ui';

const OUTPUTS: Array<{ key: OutputKind; label: string }> = [
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Ảnh' },
  { key: 'audio', label: 'Âm thanh' },
];

export default function App() {
  const { data: me, isLoading, refetch } = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });

  if (isLoading) return <div className="grid h-full place-items-center text-ink-faint">Đang tải…</div>;
  if (!me) return <><Login onDone={() => void refetch()} /><Toaster /></>;
  return <><Studio me={me} /><Toaster /></>;
}

// ---------------------------------------------------------------------------
function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(code),
    onSuccess: onDone,
  });

  return (
    <div className="grid h-full place-items-center bg-[radial-gradient(900px_500px_at_50%_-10%,#1e1a12_0%,var(--ground)_60%)] px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7"
      >
        <h1 className="mb-1 font-display text-xl font-bold tracking-tight">Runway Studio</h1>
        <p className="mb-6 text-[13px] text-ink-muted">Nhập mã truy cập nội bộ để tiếp tục.</p>
        <Field label="Mã truy cập">
          <Input
            type="password"
            value={code}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={login.isPending}>
          {login.isPending ? 'Đang kiểm tra…' : 'Đăng nhập'}
        </Button>
        {login.error && <p className="mt-3 text-[12.5px] text-err">{(login.error as Error).message}</p>}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Studio({ me }: { me: Me }) {
  const qc = useQueryClient();
  const store = useStore();
  const [tab, setTab] = useState<'session' | 'history'>('session');
  const [showUsers, setShowUsers] = useState(false);

  const { data: catalog } = useQuery({ queryKey: ['catalog'], queryFn: api.catalog, staleTime: Infinity });
  const { data: org } = useQuery({ queryKey: ['org'], queryFn: api.organization, refetchInterval: 60_000 });
  const { data: jobs = [], isLoading: jobsLoading } = useQuery({ queryKey: ['jobs'], queryFn: api.jobs });
  const { data: history = [] } = useQuery({
    queryKey: ['history'],
    queryFn: api.history,
    enabled: tab === 'history',
  });

  useEffect(() => {
    if (catalog) store.setCatalog(catalog);
  }, [catalog]);

  // SSE: server day cap nhat job thang vao cache cua React Query
  useEffect(() => {
    const es = new EventSource('/api/stream', { withCredentials: true });
    es.addEventListener('job', (e) => {
      const job = JSON.parse((e as MessageEvent<string>).data) as Job;
      qc.setQueryData<Job[]>(['jobs'], (cur = []) => {
        const i = cur.findIndex((j) => j.jobId === job.jobId);
        if (i < 0) return [job, ...cur];
        const next = [...cur];
        next[i] = job;
        return next;
      });
      if (job.user === me.name && job.state === 'SUCCEEDED') toast(`Xong: ${job.title}`, 'ok');
      if (job.user === me.name && job.state === 'FAILED') toast(`Thất bại: ${job.error ?? job.title}`, 'err');
      if (job.state === 'SUCCEEDED' || job.state === 'FAILED') qc.invalidateQueries({ queryKey: ['org'] });
    });
    return () => es.close();
  }, [qc, me.name]);

  const active = selectActive(store);
  const tools = useMemo(() => selectTools(catalog ?? null), [catalog]);

  const limits = active ? org?.tier.models[active.variant.model] : undefined;
  const used = active ? (org?.usage.models[active.variant.model]?.dailyGenerations ?? 0) : 0;
  const activeJobs = jobs.filter((j) => ['QUEUED', 'SUBMITTED', 'RUNNING'].includes(j.state));
  const shown = tab === 'session' ? jobs : history;

  return (
    <div className="grid h-full grid-cols-[196px_1fr] max-lg:grid-cols-1 max-lg:grid-rows-[auto_1fr]">
      {/* ---------- Rail trái ---------- */}
      <aside className="flex flex-col overflow-y-auto border-r border-line bg-surface max-lg:max-h-44 max-lg:border-b max-lg:border-r-0">
        <div className="flex items-center gap-2 px-4 pb-3 pt-4">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent" />
          <span className="font-display text-[15px] font-semibold tracking-tight">Studio</span>
        </div>

        <div className="px-2">
          <GroupLabel>Muốn tạo ra gì</GroupLabel>
          {OUTPUTS.map((o) => (
            <NavRow
              key={o.key}
              active={!store.toolPath && store.outputKind === o.key}
              onClick={() => store.setOutputKind(o.key)}
            >
              {o.label}
            </NavRow>
          ))}

          <GroupLabel>Công cụ</GroupLabel>
          {tools.map((ep) => (
            <NavRow key={ep.path} active={store.toolPath === ep.path} onClick={() => store.setTool(ep.path)}>
              {ep.title}
            </NavRow>
          ))}
        </div>

        <div className="mt-auto border-t border-line-soft px-4 py-3">
          <div className="font-mono text-[11.5px] text-ink-muted">
            {org ? `${fmt(org.creditBalance)} credit` : '—'}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <span className="flex-1 font-mono text-[11px] text-ink-faint">@{me.name}</span>
            {me.role === 'admin' && (
              <Button size="sm" variant="ghost" onClick={() => setShowUsers(true)}>
                Users
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api.logout();
                location.reload();
              }}
            >
              Thoát
            </Button>
          </div>
        </div>
      </aside>

      {/* ---------- Không gian làm việc ---------- */}
      <section className="grid min-w-0 grid-rows-[auto_1fr_auto] overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[15px] font-semibold tracking-tight">
              {store.toolPath ? active?.endpoint.title : OUTPUTS.find((o) => o.key === store.outputKind)?.label}
            </h2>
            {limits && (
              <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10.5px] text-ink-faint">
                <span>đồng thời tối đa {limits.maxConcurrentGenerations}</span>
                <span className={used >= limits.maxDailyGenerations ? 'text-err' : used > limits.maxDailyGenerations - 6 ? 'text-warn' : ''}>
                  hôm nay {used}/{limits.maxDailyGenerations}
                </span>
              </div>
            )}
          </div>

          {/* Thanh slot: cho biet co con cho chay ngay khong */}
          {activeJobs.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <span className="font-mono text-[10.5px] text-ink-muted">
                {activeJobs.filter((j) => j.state !== 'QUEUED').length} đang chạy ·{' '}
                {activeJobs.filter((j) => j.state === 'QUEUED').length} chờ
              </span>
            </div>
          )}

          <div className="flex rounded-lg border border-line p-0.5">
            {(['session', 'history'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${
                  tab === t ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t === 'session' ? 'Phiên này' : 'Lịch sử'}
              </button>
            ))}
          </div>
        </header>

        <Gallery jobs={shown} loading={jobsLoading && tab === 'session'} />
        <Composer />
      </section>

      {showUsers && <UsersDialog onClose={() => setShowUsers(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
const GroupLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-2 pb-1.5 pt-4 font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-faint">
    {children}
  </div>
);

function NavRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
        active ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
      }`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${active ? 'bg-accent' : 'bg-line'}`} />
      <span className="truncate">{children}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
function UsersDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const add = useMutation({
    mutationFn: () => api.addUser(name.trim(), role),
    onSuccess: () => {
      setName('');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });
  const remove = useMutation({
    mutationFn: (n: string) => api.removeUser(n),
    onSuccess: invalidate,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[150] bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[150] w-[min(540px,calc(100vw-32px))] max-h-[80vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-6">
          <Dialog.Title className="mb-4 font-display text-base font-semibold">Người dùng nội bộ</Dialog.Title>

          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                <th className="pb-2 pr-3 font-medium">Tên</th>
                <th className="pb-2 pr-3 font-medium">Mã truy cập</th>
                <th className="pb-2 pr-3 font-medium">Quyền</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.name} className="border-b border-line-soft">
                  <td className="py-2 pr-3">{u.name}</td>
                  <td className="py-2 pr-3">
                    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]">{u.code}</code>
                  </td>
                  <td className="py-2 pr-3 text-ink-muted">{u.role}</td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="danger" onClick={() => remove.mutate(u.name)}>
                      Xoá
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex gap-2">
            <Input placeholder="Tên người dùng mới" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')} className="w-32">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </Select>
            <Button variant="primary" onClick={() => add.mutate()} disabled={!name.trim()}>
              Thêm
            </Button>
          </div>

          <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
            Gửi mã truy cập cho từng người. Xoá tài khoản là thu hồi quyền ngay lập tức.
          </p>

          <Dialog.Close asChild>
            <Button className="mt-4 w-full">Đóng</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
