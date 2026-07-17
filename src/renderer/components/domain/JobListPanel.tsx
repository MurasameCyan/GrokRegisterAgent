import { useCallback, useEffect } from 'react';
import { Eraser, Layers, StopCircle } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { LiveProgressBar, liveProgressPercent } from '@renderer/components/ui/LiveProgressBar';
import { useRunStore } from '@renderer/store/runStore';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';
import type { RegisterJobSummary } from '@shared/ipc';
import type { RunPhase } from '@shared/runEvents';

function phaseLabel(p: RunPhase): string {
  switch (p) {
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    case 'killed':
      return '已停';
    default:
      return p;
  }
}

function phaseClass(p: RunPhase): string {
  if (p === 'running' || p === 'starting') return 'bg-primary/15 text-primary';
  if (p === 'done') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
  if (p === 'error') return 'bg-destructive/15 text-destructive';
  if (p === 'killed') return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
  return 'bg-muted text-muted-foreground';
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function fmtTime(ts: number | null) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

export function JobListPanel({
  maxParallel,
  /** 注册页右侧：与「实时状态」同列拉高列表可视区 */
  tall = false
}: {
  maxParallel: number;
  tall?: boolean;
}) {
  const jobs = useRunStore((s) => s.jobs);
  const jobsActive = useRunStore((s) => s.jobsActive);
  const focusRunId = useRunStore((s) => s.focusRunId);
  const setJobs = useRunStore((s) => s.setJobs);
  const setFocusRunId = useRunStore((s) => s.setFocusRunId);
  const setStatus = useRunStore((s) => s.setStatus);
  const push = useToastStore((s) => s.push);

  const reloadJobs = useCallback(async () => {
    try {
      const r = await window.api.listRegisterJobs();
      setJobs(r.jobs, r.active);
      if (r.focus) setFocusRunId(r.focus);
    } catch {
      /* ignore */
    }
  }, [setFocusRunId, setJobs]);

  useEffect(() => {
    void reloadJobs();
    const t = window.setInterval(() => void reloadJobs(), 2500);
    return () => window.clearInterval(t);
  }, [reloadJobs]);

  const focusJob = async (job: RegisterJobSummary) => {
    try {
      await window.api.focusRegisterJob(job.runId);
      setFocusRunId(job.runId);
      const st = await window.api.getRegisterJobStatus(job.runId);
      setStatus(st);
      setJobs(
        jobs.map((j) => ({ ...j, focused: j.runId === job.runId })),
        jobsActive
      );
    } catch (err) {
      push({
        tone: 'danger',
        title: '切换任务失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const stopJob = async (job: RegisterJobSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.api.stopRegister(job.runId);
      push({ tone: 'ok', title: '已停止', description: `#${shortId(job.runId)}` });
      await reloadJobs();
    } catch (err) {
      push({
        tone: 'danger',
        title: '停止失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const stopAll = async () => {
    try {
      const r = await window.api.stopRegister(undefined, { stopAll: true });
      push({
        tone: 'ok',
        title: '已停止全部',
        description: `${r.stopped?.length ?? 0} 个任务`
      });
      await reloadJobs();
    } catch (err) {
      push({
        tone: 'danger',
        title: '全部停止失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const finishedCount = jobs.filter(
    (j) => j.phase !== 'running' && j.phase !== 'starting'
  ).length;

  const clearFinished = async () => {
    try {
      const r = await window.api.clearFinishedRegisterJobs();
      // 同步前端 store：去掉已结束任务
      const next = jobs.filter(
        (j) => j.phase === 'running' || j.phase === 'starting'
      );
      setJobs(next, next.length);
      if (focusRunId && !next.some((j) => j.runId === focusRunId)) {
        setFocusRunId(next[0]?.runId ?? null);
        if (next[0]) {
          try {
            const st = await window.api.getRegisterJobStatus(next[0].runId);
            setStatus(st);
          } catch {
            /* ignore */
          }
        }
      }
      push({
        tone: 'ok',
        title: '已清理队列',
        description:
          r.removed > 0
            ? `移除 ${r.removed} 个已停/完成任务`
            : '没有可清理的已结束任务'
      });
      await reloadJobs();
    } catch (err) {
      push({
        tone: 'danger',
        title: '清理失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  return (
    <section
      className={cn(
        'ios-group flex min-h-0 flex-col',
        tall ? 'h-full min-h-[520px]' : ''
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3.5">
        <div className="min-w-0">
          <p className="page-kicker">并行</p>
          <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">任务列表</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            活跃 {jobsActive}/{maxParallel || 3}
            {focusRunId ? ` · 聚焦 #${shortId(focusRunId)}` : ''}
            {finishedCount > 0 ? ` · 可清理 ${finishedCount}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void clearFinished()}
            disabled={finishedCount === 0}
            title="移除已停/完成/失败任务，不影响运行中任务"
          >
            <Eraser className="h-3.5 w-3.5" />
            清理已停/完成
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void stopAll()}
            disabled={jobsActive === 0}
          >
            <StopCircle className="h-3.5 w-3.5" />
            全部停止
          </Button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
          暂无任务。点「开始 / 再开一路」启动并行注册。
        </div>
      ) : (
        <div
          className={cn(
            'min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3',
            tall ? 'max-h-none' : 'max-h-[280px]'
          )}
        >
          {jobs.map((job) => {
            const focused = job.runId === focusRunId || job.focused;
            const active = job.phase === 'running' || job.phase === 'starting';
            const terminal = !active;
            // 运行中：跟手百分比；正常完成：满条；中止/失败：按已完成轮真实比例
            let pct = liveProgressPercent({
              success: job.success,
              failed: job.failed,
              current: job.current,
              total: job.total
            });
            if (job.phase === 'done') {
              pct = 100;
            } else if (terminal && job.total > 0) {
              const finished = Math.max(0, job.success) + Math.max(0, job.failed);
              pct = Math.min(100, Math.round((finished / job.total) * 100));
            }
            const barTone =
              job.phase === 'done'
                ? 'ok'
                : job.phase === 'error'
                  ? 'danger'
                  : job.phase === 'killed'
                    ? 'warn'
                    : 'primary';
            return (
              <button
                key={job.runId}
                type="button"
                onClick={() => void focusJob(job)}
                className={cn(
                  'w-full rounded-xl border px-3 py-2.5 text-left transition-colors',
                  focused
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border/70 bg-card hover:border-primary/30'
                )}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[12px] font-semibold">
                        #{shortId(job.runId)}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                          phaseClass(job.phase)
                        )}
                      >
                        {phaseLabel(job.phase)}
                      </span>
                      {focused && (
                        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                          聚焦
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      成功 {job.success}/{job.total} · 失败 {job.failed}
                      {job.current ? ` · 第 ${job.current} 轮` : ''}
                      {` · ${fmtTime(job.startedAt)}`}
                      {job.pid ? ` · pid ${job.pid}` : ''}
                    </p>
                    {/* 轨道始终拉满卡片内容区宽度，避免随文案变短 */}
                    <div className="mt-1.5 w-full min-w-0">
                      <LiveProgressBar
                        value={pct}
                        active={active}
                        height="sm"
                        tone={barTone}
                      />
                    </div>
                  </div>
                  {active && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={(e) => void stopJob(job, e)}
                      title="停止此任务"
                    >
                      <StopCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
