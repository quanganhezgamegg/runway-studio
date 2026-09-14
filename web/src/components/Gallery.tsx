/** Luoi ket qua - noi dung chinh cua man hinh. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { api, credits, kindOfUrl } from '@/api/client';
import type { Job } from '@/api/client';
import { useStore } from '@/store';
import { billedLabel, explainFailure, parseValidationIssues } from '@/lib/errors';
import { Button, Progress, StatePill, fmt, timeAgo, toast } from './ui';

export function Gallery({ jobs, loading }: { jobs: Job[]; loading: boolean }) {
  const [preview, setPreview] = useState<{ url: string; job: Job } | null>(null);

  if (loading) {
    return (
      <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-3 overflow-y-auto p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="relative aspect-[16/10] overflow-hidden rounded-lg border border-line bg-surface-2">
            <div className="shimmer absolute inset-0" />
          </div>
        ))}
      </div>
    );
  }

  if (!jobs.length) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="max-w-sm text-center">
          <div className="mb-3 font-display text-lg font-semibold">Chưa có gì ở đây</div>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Chọn loại kết quả ở cột trái, đính file nếu cần, rồi mô tả điều bạn muốn tạo
            trong ô phía dưới. Model sẽ tự lọc theo những gì bạn đính kèm.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-3 overflow-y-auto p-4">
        {jobs.map((job) => (
          <Card key={job.jobId} job={job} onOpen={(url) => setPreview({ url, job })} />
        ))}
      </div>

      <Dialog.Root open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/90" />
          <Dialog.Content className="fixed inset-0 z-[200] grid place-items-center p-8">
            <Dialog.Title className="sr-only">Xem kết quả</Dialog.Title>
            {preview &&
              (kindOfUrl(preview.url) === 'video' ? (
                <video src={preview.url} controls autoPlay className="max-h-[85vh] max-w-full rounded-xl" />
              ) : kindOfUrl(preview.url) === 'audio' ? (
                <audio src={preview.url} controls autoPlay className="w-full max-w-xl" />
              ) : (
                <img src={preview.url} alt="" className="max-h-[85vh] max-w-full rounded-xl" />
              ))}
            <Dialog.Close asChild>
              <Button className="absolute right-5 top-5">Đóng</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

// ---------------------------------------------------------------------------
function Card({ job, onOpen }: { job: Job; onOpen: (url: string) => void }) {
  const qc = useQueryClient();
  const loadFrom = useStore((s) => s.loadFrom);
  // Uu tien file server da tu luu: link cua Runway co han, file cuc bo thi khong
  const saved = job.localOutput ?? [];
  const outputs = saved.length ? saved : (job.output ?? []);
  const isSaved = saved.length > 0;
  const spent = credits(job.cost) ?? credits(job.estimatedCost);
  const running = job.state === 'RUNNING' || job.state === 'SUBMITTED' || job.state === 'QUEUED';

  const save = useMutation({
    mutationFn: (i: number) => api.save({ url: outputs[i]!, jobId: job.jobId, index: i }),
    onSuccess: (r) => toast(`Đã lưu: ${r.file}`, 'ok'),
    onError: (e: Error) => toast(e.message, 'err'),
  });

  // Dich ma loi ky thuat thanh thong bao nguoi dung (muc K cua tai lieu)
  const failure = job.state === 'FAILED' ? explainFailure(job.failureCode, job.error) : null;
  const issues = failure ? parseValidationIssues(job.errorDetails) : [];

  const retry = useMutation({
    mutationFn: () => {
      if (!job.payload) throw new Error('Không còn tham số của lần tạo này');
      return api.generate({ path: job.path, payload: job.payload, title: job.title });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast('Đã gửi lại', 'ok');
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancel(job.jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast('Đã huỷ');
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  return (
    <article className="group overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-ink-faint">
      <div className="relative aspect-[16/10] bg-[#0b0d0f]">
        {outputs.length > 0 ? (
          kindOfUrl(outputs[0]!) === 'video' ? (
            <video
              src={outputs[0]}
              muted
              loop
              playsInline
              className="h-full w-full cursor-pointer object-cover"
              onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
              onMouseLeave={(e) => {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }}
              onClick={() => onOpen(outputs[0]!)}
            />
          ) : kindOfUrl(outputs[0]!) === 'audio' ? (
            <div className="grid h-full place-items-center px-3">
              <audio src={outputs[0]} controls className="w-full" />
            </div>
          ) : (
            <img
              src={outputs[0]}
              alt=""
              loading="lazy"
              className="h-full w-full cursor-pointer object-cover"
              onClick={() => onOpen(outputs[0]!)}
            />
          )
        ) : (
          <div className="grid h-full place-items-center">
            {running ? (
              <div className="w-3/4 text-center">
                <div className="mb-1 font-mono text-[10px] text-accent">
                  {job.state === 'QUEUED'
                    ? `chờ slot — vị trí ${job.queuePosition ?? '?'}`
                    : job.progress != null
                      ? `${Math.round(job.progress * 100)}%`
                      : 'đang xử lý'}
                </div>
                <Progress value={job.state === 'QUEUED' ? 0 : job.progress} />
              </div>
            ) : (
              <span className="px-3 text-center text-[10.5px] leading-relaxed text-err">
                {failure?.message ?? 'không có kết quả'}
              </span>
            )}
          </div>
        )}

        {outputs.length > 1 && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[9px] text-white">
            {outputs.length}
          </span>
        )}
      </div>

      <div className="p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex-1 truncate font-mono text-[11px] text-ink">{job.model}</span>
          <StatePill state={job.state} />
        </div>

        {job.promptText && (
          <p className="mb-1.5 line-clamp-2 text-[11.5px] leading-snug text-ink-muted">{job.promptText}</p>
        )}

        <div className="flex flex-wrap gap-x-2.5 font-mono text-[10px] text-ink-faint">
          <span>@{job.user}</span>
          <span>{timeAgo(job.createdAt)}</span>
          {spent != null && <span>{fmt(spent)} cr</span>}
          {isSaved && <span className="text-ok">đã lưu</span>}
          {failure && (
            <span className={failure.billed === 'charged' ? 'text-warn' : ''}>
              {billedLabel(failure.billed)}
            </span>
          )}
        </div>

        {/* Loi: thong diep + viec can lam + goi y, khong hien ma ky thuat */}
        {failure && (
          <div className="mt-2 rounded-md border border-err/40 bg-[#1d1314] px-2.5 py-2">
            <div className="text-[11.5px] leading-snug text-[#ffb4b4]">{failure.message}</div>
            {issues.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {issues.map((it, i) => (
                  <li key={i} className="text-[10.5px] leading-snug text-ink-muted">
                    <code className="rounded bg-surface-2 px-1 font-mono text-[10px] text-ink">
                      {it.field}
                    </code>{' '}
                    {it.message}
                  </li>
                ))}
              </ul>
            )}
            {failure.action && issues.length === 0 && (
              <div className="mt-1 text-[10.5px] leading-snug text-ink-muted">{failure.action}</div>
            )}
            {failure.tips && (
              <ul className="mt-1.5 list-disc pl-4 text-[10.5px] leading-snug text-ink-muted">
                {failure.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            {failure.suggestAltModel && (
              <div className="mt-1.5 text-[10.5px] text-ink-muted">
                Thử model khác trong cùng nhóm — danh sách ở chip "model".
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {running && (
            <Button size="sm" variant="danger" onClick={() => cancel.mutate()}>
              Huỷ
            </Button>
          )}
          {isSaved ? (
            <a
              href={outputs[0]}
              download
              className="inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Tải về
            </a>
          ) : (
            outputs.map((_, i) => (
              <Button key={i} size="sm" variant="ghost" onClick={() => save.mutate(i)}>
                {outputs.length > 1 ? `Lưu ${i + 1}` : 'Lưu'}
              </Button>
            ))
          )}
          {failure?.retryable && job.payload && (
            <Button size="sm" variant="ghost" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? 'Đang gửi…' : 'Thử lại'}
            </Button>
          )}
          {job.payload && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                loadFrom(job.path, job.model, job.payload!);
                toast('Đã nạp lại tham số');
              }}
            >
              Dùng lại
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
