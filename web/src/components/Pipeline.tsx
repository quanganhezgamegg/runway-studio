/**
 * Giao dien pipeline nhieu canh.
 *
 * Muc tieu: nhin mot cai la thay pipeline dang o dau. Bon tang o dau trang
 * la trung tam — moi tang co thanh tien do va mot nut chay hang loat, dung
 * thu tu phu thuoc: ref -> anh khung dau -> clip -> ghep.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ENTITY_LABEL,
  entityStep,
  imageStep,
  pipe,
  videoStep,
} from '@/api/pipeline';
import type { Entity, EntityType, Scene, StepState } from '@/api/pipeline';
import { Button, Field, Input, Select, fmt, toast } from './ui';

// ---------------------------------------------------------------------------
export function Pipeline() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);

  const { data: list = [] } = useQuery({ queryKey: ['pj'], queryFn: pipe.projects });

  // Tu chon project dau tien de khong phai bam thu cong
  useEffect(() => {
    if (!projectId && list.length) setProjectId(list[0]!.id);
  }, [list, projectId]);

  const { data: project } = useQuery({
    queryKey: ['pj', projectId],
    queryFn: () => pipe.project(projectId!),
    enabled: !!projectId,
  });

  useEffect(() => {
    if (project && !project.videos.some((v) => v.id === videoId)) {
      setVideoId(project.videos[0]?.id ?? null);
    }
  }, [project, videoId]);

  const newProject = useMutation({
    mutationFn: (name: string) => pipe.createProject({ name }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['pj'] });
      setProjectId(p.id);
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  if (!list.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mb-2 font-display text-lg font-semibold">Chưa có dự án nào</div>
          <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
            Dự án giữ nhân vật và bối cảnh dùng chung cho nhiều cảnh. Ảnh tham chiếu sinh
            một lần rồi dùng lại ở mọi cảnh — đó là cách giữ nhân vật không đổi mặt giữa
            các cảnh.
          </p>
          <Button
            variant="primary"
            onClick={() => {
              const name = prompt('Tên dự án');
              if (name?.trim()) newProject.mutate(name.trim());
            }}
          >
            Tạo dự án đầu tiên
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Chon du an */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <Select
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-auto min-w-[200px]"
        >
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          onClick={() => {
            const name = prompt('Tên dự án');
            if (name?.trim()) newProject.mutate(name.trim());
          }}
        >
          + Dự án
        </Button>
        {project && <ProjectSettings project={project} />}
      </div>

      {project && (
        <div className="px-4 py-4">
          <VideoBar
            project={project}
            videoId={videoId}
            onPick={setVideoId}
          />
          {videoId && <Stages projectId={project.id} videoId={videoId} />}
          <Entities project={project} />
          {videoId ? (
            <Scenes videoId={videoId} entities={project.entities} />
          ) : (
            <p className="mt-6 text-[13px] text-ink-muted">
              Tạo một video để bắt đầu thêm cảnh.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ProjectSettings({ project }: { project: { id: string; material: string; orientation: string } }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [material, setMaterial] = useState(project.material);

  const save = useMutation({
    mutationFn: () => pipe.updateProject(project.id, { material }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pj'] });
      setOpen(false);
      toast('Đã lưu phong cách', 'ok');
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="truncate text-[11.5px] text-ink-faint transition-colors hover:text-ink"
        title="Phong cách nối vào mọi prompt ảnh của dự án"
      >
        {project.material ? `phong cách: ${project.material}` : '+ đặt phong cách hình ảnh'}
      </button>
    );
  }

  return (
    <div className="flex flex-1 items-center gap-2">
      <Input
        value={material}
        autoFocus
        placeholder="Pixar-style 3D render, warm cinematic lighting"
        onChange={(e) => setMaterial(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save.mutate()}
      />
      <Button size="sm" variant="primary" onClick={() => save.mutate()}>
        Lưu
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Bỏ
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
function VideoBar({
  project,
  videoId,
  onPick,
}: {
  project: { id: string; videos: { id: string; title: string; ratio: string; model: string }[] };
  videoId: string | null;
  onPick: (id: string) => void;
}) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (title: string) => pipe.createVideo(project.id, { title }),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ['pj', project.id] });
      onPick(v.id);
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      {project.videos.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onPick(v.id)}
          className={`rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
            v.id === videoId
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line text-ink-muted hover:text-ink'
          }`}
        >
          {v.title}
          <span className="ml-1.5 font-mono text-[10px] opacity-70">{v.ratio}</span>
        </button>
      ))}
      <Button
        size="sm"
        onClick={() => {
          const t = prompt('Tên video');
          if (t?.trim()) add.mutate(t.trim());
        }}
      >
        + Video
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Bon tang pipeline — phan trung tam cua man hinh. */
function Stages({ projectId, videoId }: { projectId: string; videoId: string }) {
  const qc = useQueryClient();

  const { data: st } = useQuery({
    queryKey: ['pl-status', videoId],
    queryFn: () => pipe.status(videoId),
    refetchInterval: 5000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pl-status', videoId] });
    qc.invalidateQueries({ queryKey: ['pj', projectId] });
    qc.invalidateQueries({ queryKey: ['pl-video', videoId] });
    qc.invalidateQueries({ queryKey: ['jobs'] });
  };

  const report = (r: { queued?: unknown[]; skipped?: unknown[]; note?: string }) => {
    const n = r.queued?.length ?? 0;
    toast(n ? `Đã đưa ${n} việc vào hàng đợi` : 'Không có việc nào để chạy', n ? 'ok' : '');
    if (r.note) toast(r.note);
    refresh();
  };

  const genRefs = useMutation({
    mutationFn: () => pipe.genAllRefs(projectId),
    onSuccess: report,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const genImages = useMutation({
    mutationFn: (force: boolean) => pipe.genAllImages(videoId, force),
    onSuccess: report,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const genClips = useMutation({
    mutationFn: () => pipe.genAllClips(videoId),
    onSuccess: report,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const concat = useMutation({
    mutationFn: () => pipe.concat(videoId),
    onSuccess: (r) => {
      toast(`Đã ghép ${r.parts} cảnh`, 'ok');
      if (r.note) toast(r.note);
      refresh();
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  if (!st) return null;

  const steps = [
    {
      n: 1,
      label: 'Ảnh tham chiếu',
      hint: 'Sinh một lần cho mỗi nhân vật/bối cảnh, dùng lại ở mọi cảnh',
      p: st.refs,
      ready: st.ready.refs,
      run: () => genRefs.mutate(),
      busy: genRefs.isPending,
    },
    {
      n: 2,
      label: 'Ảnh khung đầu',
      hint: 'Mỗi cảnh một ảnh, dùng ảnh tham chiếu của entity trong cảnh',
      p: st.images,
      ready: st.ready.images,
      run: () => genImages.mutate(false),
      busy: genImages.isPending,
    },
    {
      n: 3,
      label: 'Clip',
      hint: 'Mỗi cảnh một clip, sinh từ ảnh khung đầu',
      p: st.clips,
      ready: st.ready.clips,
      run: () => genClips.mutate(),
      busy: genClips.isPending,
    },
  ];

  const nextLabel: Record<string, string> = {
    refs: 'Bước tiếp: sinh ảnh tham chiếu',
    images: 'Bước tiếp: sinh ảnh khung đầu',
    clips: 'Bước tiếp: sinh clip',
    concat: 'Bước tiếp: ghép thành một video',
    done: 'Đã xong toàn bộ',
  };

  return (
    <section className="mb-6 rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-accent">
          {nextLabel[st.next] ?? st.next}
        </span>
        <span className="font-mono text-[10.5px] text-ink-faint">
          {st.clips.total} cảnh · tổng {st.totalDuration}s
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <div key={s.n} className="rounded-lg border border-line-soft bg-surface-2 p-3">
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="font-mono text-[10px] text-accent">{s.n}</span>
              <span className="flex-1 text-[12.5px] font-medium">{s.label}</span>
              <span className="font-mono text-[11px] text-ink-muted">
                {s.p.done}/{s.p.total}
              </span>
            </div>
            <Bar done={s.p.done} pending={s.p.pending} total={s.p.total} />
            <p className="mt-1.5 text-[10.5px] leading-snug text-ink-faint">{s.hint}</p>
            <Button
              size="sm"
              className="mt-2 w-full"
              disabled={s.busy || s.ready === 0}
              onClick={s.run}
              title={s.ready === 0 ? 'Không có việc nào sẵn sàng chạy' : `${s.ready} việc sẵn sàng`}
            >
              {s.busy ? 'Đang gửi…' : s.ready ? `Sinh tất cả (${s.ready})` : 'Không có việc'}
            </Button>
          </div>
        ))}

        {/* Ghep */}
        <div className="rounded-lg border border-line-soft bg-surface-2 p-3">
          <div className="mb-1 flex items-baseline gap-1.5">
            <span className="font-mono text-[10px] text-accent">4</span>
            <span className="flex-1 text-[12.5px] font-medium">Ghép video</span>
          </div>
          <Bar done={st.video.final_local ? 1 : 0} pending={0} total={1} />
          <p className="mt-1.5 text-[10.5px] leading-snug text-ink-faint">
            {st.ffmpeg ? 'Nối các clip bằng ffmpeg, không encode lại' : 'Máy chủ chưa có ffmpeg'}
          </p>
          {st.video.final_local ? (
            <a
              href={st.video.final_local}
              download
              className="mt-2 flex w-full items-center justify-center rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ok"
            >
              Tải video hoàn chỉnh
            </a>
          ) : (
            <Button
              size="sm"
              className="mt-2 w-full"
              disabled={concat.isPending || !st.ffmpeg || st.clips.done === 0}
              onClick={() => concat.mutate()}
            >
              {concat.isPending ? 'Đang ghép…' : 'Ghép'}
            </Button>
          )}
        </div>
      </div>

      {/* Cho phep bo qua kiem tra phu thuoc, nhung phai bam co y */}
      {st.next === 'images' && st.ready.images > 0 && st.refs.done < st.refs.total && (
        <button
          type="button"
          onClick={() => genImages.mutate(true)}
          className="mt-3 text-[11px] text-warn underline decoration-dotted transition-colors hover:text-ink"
        >
          Sinh ảnh cảnh dù còn {st.refs.total - st.refs.done} entity chưa có ảnh tham chiếu —
          nhân vật sẽ khác nhau giữa các cảnh
        </button>
      )}
    </section>
  );
}

function Bar({ done, pending, total }: { done: number; pending: number; total: number }) {
  const pctDone = total ? (done / total) * 100 : 0;
  const pctPending = total ? (pending / total) * 100 : 0;
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-line">
      <i className="block bg-ok transition-[width] duration-500" style={{ width: `${pctDone}%` }} />
      <i className="shimmer relative block bg-accent/40" style={{ width: `${pctPending}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
function Entities({
  project,
}: {
  project: { id: string; material: string; entities: Entity[] };
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['pj', project.id] });

  const genRef = useMutation({
    mutationFn: (id: string) => pipe.genRef(id, project.material),
    onSuccess: () => {
      toast('Đã đưa vào hàng đợi', 'ok');
      refresh();
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const del = useMutation({
    mutationFn: (id: string) => pipe.deleteEntity(id),
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10.5px] uppercase tracking-wider text-ink-faint">
          Nhân vật &amp; bối cảnh — {project.entities.length}
        </h3>
        <Button size="sm" onClick={() => setAdding(true)}>
          + Thêm
        </Button>
      </div>

      <p className="mb-3 max-w-[70ch] text-[11.5px] leading-relaxed text-ink-faint">
        Mô tả ở đây <b className="font-medium text-ink-muted">chỉ là ngoại hình</b> — nó sinh ra
        ảnh tham chiếu. Hành động thì viết trong từng cảnh, gọi lại bằng
        <code className="mx-1 rounded bg-surface-2 px-1 font-mono">@tên</code>.
      </p>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        {project.entities.map((e) => (
          <EntityCard
            key={e.id}
            entity={e}
            onGen={() => genRef.mutate(e.id)}
            onDelete={() => del.mutate(e.id)}
            projectId={project.id}
          />
        ))}
      </div>

      {adding && <EntityForm projectId={project.id} onDone={() => setAdding(false)} />}
    </section>
  );
}

const STEP_COLOR: Record<StepState, string> = {
  done: 'border-ok/40',
  pending: 'border-accent/50',
  empty: 'border-line',
};

function EntityCard({
  entity,
  projectId,
  onGen,
  onDelete,
}: {
  entity: Entity;
  projectId: string;
  onGen: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const step = entityStep(entity);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EntityForm
        projectId={projectId}
        entity={entity}
        onDone={() => {
          setEditing(false);
          qc.invalidateQueries({ queryKey: ['pj', projectId] });
        }}
      />
    );
  }

  return (
    <article className={`group overflow-hidden rounded-lg border bg-surface ${STEP_COLOR[step]}`}>
      <div className="relative aspect-[3/4] bg-[#0b0d0f]">
        {entity.ref_local || entity.ref_uri ? (
          <img
            src={entity.ref_local ?? entity.ref_uri!}
            alt={entity.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="grid h-full place-items-center px-2 text-center">
            <span className="font-mono text-[10px] text-ink-faint">
              {step === 'pending' ? 'đang sinh…' : 'chưa có ảnh'}
            </span>
          </div>
        )}
      </div>

      <div className="p-2">
        <div className="truncate text-[12px] font-medium">{entity.name}</div>
        <div className="flex items-baseline gap-1.5">
          <code className="font-mono text-[10px] text-accent">@{entity.tag}</code>
          <span className="truncate text-[10px] text-ink-faint">
            {ENTITY_LABEL[entity.entity_type]}
          </span>
        </div>

        <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {step !== 'pending' && (
            <Button size="sm" variant="ghost" onClick={onGen} title="Sinh ảnh tham chiếu">
              {step === 'done' ? 'Sinh lại' : 'Sinh ảnh'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Sửa
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            Xoá
          </Button>
        </div>
      </div>
    </article>
  );
}

function EntityForm({
  projectId,
  entity,
  onDone,
}: {
  projectId: string;
  entity?: Entity;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(entity?.name ?? '');
  const [type, setType] = useState<EntityType>(entity?.entity_type ?? 'character');
  const [desc, setDesc] = useState(entity?.description ?? '');
  const [voice, setVoice] = useState(entity?.voice_description ?? '');

  const save = useMutation({
    mutationFn: () => {
      const data = { name, entity_type: type, description: desc, voice_description: voice };
      return entity ? pipe.updateEntity(entity.id, data) : pipe.createEntity(projectId, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pj', projectId] });
      onDone();
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  return (
    <div className="col-span-full mt-2 rounded-lg border border-accent/50 bg-surface p-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="Tên">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Loại" hint="quyết định tỉ lệ và bố cục ảnh tham chiếu">
          <Select value={type} onChange={(e) => setType(e.target.value as EntityType)}>
            {(Object.keys(ENTITY_LABEL) as EntityType[]).map((k) => (
              <option key={k} value={k}>
                {ENTITY_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Mô tả ngoại hình" hint="chỉ ngoại hình, không mô tả hành động">
        <textarea
          rows={2}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Mèo vàng béo, mắt xanh to, tạp dề xanh, mũ cói"
          className="w-full resize-y rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
        />
      </Field>

      {(type === 'character' || type === 'creature') && (
        <Field label="Mô tả giọng" hint="tối đa ~30 từ, tự nối vào prompt clip">
          <Input
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            placeholder="Giọng trẻ, tò mò, hơi rung"
          />
        </Field>
      )}

      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!name.trim()}>
          {entity ? 'Lưu' : 'Thêm'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Bỏ
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Scenes({ videoId, entities }: { videoId: string; entities: Entity[] }) {
  const qc = useQueryClient();
  const { data: video } = useQuery({
    queryKey: ['pl-video', videoId],
    queryFn: () => pipe.video(videoId),
    refetchInterval: 5000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pl-video', videoId] });
    qc.invalidateQueries({ queryKey: ['pl-status', videoId] });
  };

  const add = useMutation({
    mutationFn: () =>
      pipe.createScene(videoId, {
        chain_type: (video?.scenes.length ?? 0) === 0 ? 'ROOT' : 'CONTINUATION',
        parent_scene_id: video?.scenes.at(-1)?.id ?? null,
        duration: 8,
      }),
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const total = useMemo(
    () => (video?.scenes ?? []).reduce((n, s) => n + (s.duration || 0), 0),
    [video]
  );

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10.5px] uppercase tracking-wider text-ink-faint">
          Cảnh — {video?.scenes.length ?? 0} · tổng {total}s
        </h3>
        <Button size="sm" onClick={() => add.mutate()}>
          + Thêm cảnh
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {(video?.scenes ?? []).map((s) => (
          <SceneRow key={s.id} scene={s} entities={entities} onChange={refresh} />
        ))}
      </div>

      {!video?.scenes.length && (
        <p className="py-8 text-center text-[12.5px] text-ink-faint">
          Chưa có cảnh nào. Mỗi cảnh ra một clip 4–10 giây; video 30 giây cần khoảng 4 cảnh.
        </p>
      )}
    </section>
  );
}

function SceneRow({
  scene,
  entities,
  onChange,
}: {
  scene: Scene;
  entities: Entity[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [imagePrompt, setImagePrompt] = useState(scene.image_prompt);
  const [videoPrompt, setVideoPrompt] = useState(scene.video_prompt);
  const [duration, setDuration] = useState(scene.duration);
  const [picked, setPicked] = useState<string[]>(scene.entity_ids);

  const iStep = imageStep(scene);
  const vStep = videoStep(scene);

  const save = useMutation({
    mutationFn: () =>
      pipe.updateScene(scene.id, {
        image_prompt: imagePrompt,
        video_prompt: videoPrompt,
        duration,
        entity_ids: picked,
      }),
    onSuccess: () => {
      onChange();
      toast('Đã lưu cảnh', 'ok');
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const genImage = useMutation({
    mutationFn: () => pipe.genSceneImage(scene.id),
    onSuccess: (r) => {
      toast(r.usedRefs.length ? `Dùng ref: ${r.usedRefs.map((t) => '@' + t).join(', ')}` : 'Không có ref nào', 'ok');
      onChange();
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const genVideo = useMutation({
    mutationFn: () => pipe.genSceneVideo(scene.id),
    onSuccess: () => {
      toast('Đã đưa clip vào hàng đợi', 'ok');
      onChange();
    },
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const del = useMutation({
    mutationFn: () => pipe.deleteScene(scene.id),
    onSuccess: onChange,
    onError: (e: Error) => toast(e.message, 'err'),
  });

  const names = picked
    .map((id) => entities.find((e) => e.id === id))
    .filter(Boolean)
    .map((e) => `@${e!.tag}`);

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-stretch gap-2.5 p-2.5">
        <div className="flex w-7 shrink-0 items-center justify-center font-mono text-[12px] text-ink-faint">
          {scene.display_order + 1}
        </div>

        {/* Hai o xem truoc: anh khung dau va clip — thay ngay canh nay den dau */}
        <Thumb
          step={iStep}
          src={scene.image_local ?? scene.image_uri}
          kind="image"
          label="ảnh"
        />
        <Thumb
          step={vStep}
          src={scene.video_local ?? scene.video_uri}
          kind="video"
          label="clip"
        />

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="block w-full truncate text-left text-[12.5px] text-ink hover:text-accent"
          >
            {scene.image_prompt || <span className="text-ink-faint">chưa có mô tả hành động</span>}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-ink-faint">
            <span>{scene.duration}s</span>
            <span>{scene.chain_type === 'ROOT' ? 'mở đầu' : 'tiếp nối'}</span>
            {names.length > 0 && <span className="text-accent">{names.join(' ')}</span>}
            {!names.length && <span className="text-warn">chưa chọn entity</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={iStep === 'pending' || !scene.image_prompt?.trim()}
            onClick={() => genImage.mutate()}
            title="Sinh ảnh khung đầu"
          >
            {iStep === 'done' ? '↻ ảnh' : 'ảnh'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={vStep === 'pending' || !scene.image_uri}
            onClick={() => genVideo.mutate()}
            title={scene.image_uri ? 'Sinh clip' : 'Cần ảnh khung đầu trước'}
          >
            {vStep === 'done' ? '↻ clip' : 'clip'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? '▴' : '▾'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-t border-line-soft bg-surface-2 p-3">
          <Field label="Hành động (ảnh khung đầu)" hint="gọi entity bằng tên, đừng tả lại ngoại hình">
            <textarea
              rows={2}
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              placeholder="Pippip xếp cá lên đá sau Sạp Cá, bình minh"
              className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
            />
          </Field>

          <Field label="Chuyển động (clip)" hint="nên có mốc thời gian và góc máy">
            <textarea
              rows={3}
              value={videoPrompt}
              onChange={(e) => setVideoPrompt(e.target.value)}
              placeholder={'0-3s: cần cẩu hạ, Pippip xếp cá\n3-6s: cận bàn tay, DOF mỏng\n6-8s: cận mặt, ánh sáng giờ vàng'}
              className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-accent"
            />
          </Field>

          <div className="grid gap-2.5 sm:grid-cols-[110px_1fr]">
            <Field label="Thời lượng" hint="giây">
              <Select value={String(duration)} onChange={(e) => setDuration(Number(e.target.value))}>
                {[4, 5, 6, 8, 10].map((d) => (
                  <option key={d} value={d}>
                    {d} giây
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Entity xuất hiện trong cảnh" hint="ảnh tham chiếu của chúng được đưa vào">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {entities.map((e) => {
                  const on = picked.includes(e.id);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() =>
                        setPicked(on ? picked.filter((x) => x !== e.id) : [...picked, e.id])
                      }
                      title={e.ref_uri ? 'đã có ảnh tham chiếu' : 'chưa có ảnh tham chiếu'}
                      className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                        on
                          ? e.ref_uri
                            ? 'border-accent/60 bg-accent-soft text-accent'
                            : 'border-warn/60 bg-[#1d1a10] text-warn'
                          : 'border-line text-ink-faint hover:text-ink'
                      }`}
                    >
                      @{e.tag}
                      {on && !e.ref_uri && ' ⚠'}
                    </button>
                  );
                })}
                {!entities.length && (
                  <span className="text-[11px] text-ink-faint">Chưa có entity nào</span>
                )}
              </div>
            </Field>
          </div>

          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => save.mutate()}>
              Lưu cảnh
            </Button>
            <Button size="sm" variant="danger" onClick={() => del.mutate()}>
              Xoá cảnh
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function Thumb({
  step,
  src,
  kind,
  label,
}: {
  step: StepState;
  src: string | null;
  kind: 'image' | 'video';
  label: string;
}) {
  return (
    <div
      className={`relative h-14 w-[74px] shrink-0 overflow-hidden rounded border bg-[#0b0d0f] ${STEP_COLOR[step]}`}
      title={label}
    >
      {step === 'done' && src ? (
        kind === 'video' ? (
          <video
            src={src}
            muted
            loop
            playsInline
            className="h-full w-full object-cover"
            onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
        ) : (
          <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
        )
      ) : (
        <div className="grid h-full place-items-center">
          <span
            className={`font-mono text-[9px] ${step === 'pending' ? 'text-accent' : 'text-ink-faint'}`}
          >
            {step === 'pending' ? '…' : label}
          </span>
        </div>
      )}
    </div>
  );
}

export { fmt };
