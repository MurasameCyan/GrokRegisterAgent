import { create } from 'zustand';
import type { LogLevel, RunEvent, RunStatus } from '@shared/runEvents';
import { EMPTY_STATUS } from '@shared/runEvents';
import type { RegisterJobSummary } from '@shared/ipc';

export interface LogLine {
  id: string;
  ts: number;
  level: LogLevel | 'stderr';
  text: string;
  runId: string;
}

interface RunState {
  status: RunStatus;
  logs: LogLine[];
  /** 前端聚焦的任务 id（与后端 focus 同步） */
  focusRunId: string | null;
  jobs: RegisterJobSummary[];
  jobsActive: number;
  setStatus(status: RunStatus): void;
  setFocusRunId(runId: string | null): void;
  setJobs(jobs: RegisterJobSummary[], active?: number): void;
  applyEvent(event: RunEvent): void;
  clearLogs(): void;
  /** 仅清空某任务日志 */
  clearLogsFor(runId: string): void;
}

let seq = 0;

/** 日志去重：同 run + 同 level + 规范化文本，短窗内丢弃重复行 */
const LOG_DEDUP_MS = 2500;
const lastLogKeyByRun = new Map<string, { key: string; ts: number }>();

/**
 * 已终态 runId 永久锁（进程内）。
 * 解决：WS 回放/刷新时 jobs 尚未 hydrate，或任务已从列表 prune 但仍有 exit/日志，
 * progress/started 不得把条从 0 推回 running。
 */
const terminalRunIds = new Set<string>();

function markTerminalRun(runId: string | null | undefined) {
  const id = String(runId || '').trim();
  if (id) terminalRunIds.add(id);
}

function isLockedTerminal(runId: string): boolean {
  return terminalRunIds.has(runId);
}

function normalizeLogText(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function isActive(phase: string) {
  return phase === 'starting' || phase === 'running';
}

function upsertJob(
  jobs: RegisterJobSummary[],
  patch: Partial<RegisterJobSummary> & { runId: string }
): RegisterJobSummary[] {
  const idx = jobs.findIndex((j) => j.runId === patch.runId);
  if (idx < 0) {
    const row: RegisterJobSummary = {
      runId: patch.runId,
      phase: patch.phase || 'idle',
      pid: patch.pid ?? null,
      startedAt: patch.startedAt ?? Date.now(),
      finishedAt: patch.finishedAt ?? null,
      current: patch.current ?? 0,
      total: patch.total ?? 0,
      success: patch.success ?? 0,
      failed: patch.failed ?? 0,
      planASuccess: patch.planASuccess ?? 0,
      planBSuccess: patch.planBSuccess ?? 0,
      planCSuccess: patch.planCSuccess ?? 0,
      errorMessage: patch.errorMessage ?? null,
      focused: patch.focused ?? false
    };
    return [row, ...jobs].slice(0, 40);
  }
  const next = jobs.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

export const useRunStore = create<RunState>((set) => ({
  status: { ...EMPTY_STATUS },
  logs: [],
  focusRunId: null,
  jobs: [],
  jobsActive: 0,

  setStatus: (status) => {
    if (status?.runId && !isActive(status.phase)) markTerminalRun(status.runId);
    set((s) => ({
      status,
      focusRunId: status.runId || s.focusRunId
    }));
  },

  setFocusRunId: (runId) => set({ focusRunId: runId }),

  setJobs: (jobs, active) => {
    for (const j of jobs) {
      if (j?.runId && !isActive(j.phase)) markTerminalRun(j.runId);
    }
    set({
      jobs,
      jobsActive: active !== undefined ? active : jobs.filter((j) => isActive(j.phase)).length
    });
  },

  clearLogs: () => set({ logs: [] }),

  clearLogsFor: (runId) =>
    set((s) => ({ logs: s.logs.filter((l) => l.runId !== runId) })),

  applyEvent: (event) => {
    set((state) => {
      const focus = state.focusRunId;
      let status = state.status;
      let logs = state.logs;
      let jobs = state.jobs;
      let focusRunId = state.focusRunId;

      const touchJob = (patch: Partial<RegisterJobSummary> & { runId: string }) => {
        jobs = upsertJob(jobs, {
          ...patch,
          focused: patch.runId === focusRunId
        });
      };

      /** 已结束任务：WS 重放不得回退 phase / 清零进度（刷新时会先 listJobs 再重放） */
      const existingJob = (runId: string) => jobs.find((j) => j.runId === runId);
      const isTerminalJob = (runId: string) => {
        if (isLockedTerminal(runId)) return true;
        const j = existingJob(runId);
        return !!j && !isActive(j.phase);
      };

      switch (event.type) {
        case 'started': {
          // 同 runId 若已是 done/error/killed，忽略重放的 started（否则成功/失败被清零并重播进度条）
          if (isTerminalJob(event.runId)) {
            break;
          }
          focusRunId = event.runId;
          status = {
            ...EMPTY_STATUS,
            phase: 'running',
            runId: event.runId,
            pid: event.pid,
            startedAt: Date.now(),
            total: event.total
          };
          touchJob({
            runId: event.runId,
            phase: 'running',
            pid: event.pid,
            startedAt: Date.now(),
            total: event.total,
            success: 0,
            failed: 0,
            current: 0,
            focused: true
          });
          // 其它任务取消 focused 标记
          jobs = jobs.map((j) => ({ ...j, focused: j.runId === event.runId }));
          break;
        }
        case 'stdout':
        case 'stderr': {
          const level = event.type === 'stderr' ? ('stderr' as const) : event.level;
          const text = String(event.text || '');
          const norm = normalizeLogText(text);
          const dedupKey = `${event.runId}|${level}|${norm}`;
          const prev = lastLogKeyByRun.get(event.runId);
          if (
            prev &&
            prev.key === dedupKey &&
            event.ts - prev.ts >= 0 &&
            event.ts - prev.ts < LOG_DEDUP_MS
          ) {
            break;
          }
          lastLogKeyByRun.set(event.runId, { key: dedupKey, ts: event.ts });
          logs = [
            ...logs,
            {
              id: `${Date.now()}-${seq++}`,
              ts: event.ts,
              level,
              text,
              runId: event.runId
            }
          ].slice(-2000);
          break;
        }
        case 'progress':
          // 终态任务：不改 phase，也不用中间 progress 驱动条动画
          if (isTerminalJob(event.runId)) {
            break;
          }
          if (!focus || event.runId === focus || event.runId === status.runId) {
            status = { ...status, current: event.current, total: event.total };
          }
          touchJob({
            runId: event.runId,
            current: event.current,
            total: event.total,
            phase: 'running'
          });
          break;
        case 'success': {
          const pa = Number((event as { planASuccess?: number }).planASuccess);
          const pb = Number((event as { planBSuccess?: number }).planBSuccess);
          const pc = Number((event as { planCSuccess?: number }).planCSuccess);
          const planPatch = {
            planASuccess: Number.isFinite(pa) ? pa : undefined,
            planBSuccess: Number.isFinite(pb) ? pb : undefined,
            planCSuccess: Number.isFinite(pc) ? pc : undefined
          };
          if (isTerminalJob(event.runId)) {
            // 终态：只允许抬高计数（防乱序），绝不改 phase
            const j = existingJob(event.runId)!;
            const success = Math.max(j.success, event.success);
            const failed = Math.max(j.failed, event.failed);
            const total = Math.max(j.total, event.total);
            touchJob({
              runId: event.runId,
              success,
              failed,
              total,
              planASuccess: Math.max(
                Number(j.planASuccess) || 0,
                Number.isFinite(pa) ? pa : 0
              ),
              planBSuccess: Math.max(
                Number(j.planBSuccess) || 0,
                Number.isFinite(pb) ? pb : 0
              ),
              planCSuccess: Math.max(
                Number(j.planCSuccess) || 0,
                Number.isFinite(pc) ? pc : 0
              )
            });
            if (!focus || event.runId === focus || event.runId === status.runId) {
              status = {
                ...status,
                success,
                failed,
                total,
                planASuccess: Math.max(
                  Number(status.planASuccess) || 0,
                  Number.isFinite(pa) ? pa : 0
                ),
                planBSuccess: Math.max(
                  Number(status.planBSuccess) || 0,
                  Number.isFinite(pb) ? pb : 0
                ),
                planCSuccess: Math.max(
                  Number(status.planCSuccess) || 0,
                  Number.isFinite(pc) ? pc : 0
                )
              };
            }
            break;
          }
          if (!focus || event.runId === focus || event.runId === status.runId) {
            status = {
              ...status,
              success: event.success,
              failed: event.failed,
              total: event.total,
              ...(Number.isFinite(pa) ? { planASuccess: pa } : {}),
              ...(Number.isFinite(pb) ? { planBSuccess: pb } : {}),
              ...(Number.isFinite(pc) ? { planCSuccess: pc } : {})
            };
          }
          touchJob({
            runId: event.runId,
            success: event.success,
            failed: event.failed,
            total: event.total,
            ...(planPatch.planASuccess !== undefined
              ? { planASuccess: planPatch.planASuccess }
              : {}),
            ...(planPatch.planBSuccess !== undefined
              ? { planBSuccess: planPatch.planBSuccess }
              : {}),
            ...(planPatch.planCSuccess !== undefined
              ? { planCSuccess: planPatch.planCSuccess }
              : {})
          });
          break;
        }
        case 'failed':
          if (isTerminalJob(event.runId)) {
            const j = existingJob(event.runId)!;
            const success = Math.max(j.success, event.success);
            const failed = Math.max(j.failed, event.failed);
            const total = Math.max(j.total, event.total);
            touchJob({ runId: event.runId, success, failed, total });
            if (!focus || event.runId === focus || event.runId === status.runId) {
              status = { ...status, success, failed, total };
            }
            break;
          }
          if (!focus || event.runId === focus || event.runId === status.runId) {
            status = {
              ...status,
              success: event.success,
              failed: event.failed,
              total: event.total
            };
          }
          touchJob({
            runId: event.runId,
            success: event.success,
            failed: event.failed,
            total: event.total
          });
          break;
        case 'exit': {
          const phase = event.killed ? 'killed' : event.code === 0 ? 'done' : 'error';
          markTerminalRun(event.runId);
          if (!focus || event.runId === focus || event.runId === status.runId) {
            status = {
              ...status,
              phase,
              finishedAt: Date.now(),
              exitCode: event.code,
              runId: event.runId
            };
          }
          touchJob({
            runId: event.runId,
            phase,
            finishedAt: Date.now()
          });
          break;
        }
        default:
          break;
      }

      const jobsActive = jobs.filter((j) => isActive(j.phase)).length;
      return { status, logs, jobs, focusRunId, jobsActive };
    });
  }
}));
