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

  setStatus: (status) =>
    set((s) => ({
      status,
      focusRunId: status.runId || s.focusRunId
    })),

  setFocusRunId: (runId) => set({ focusRunId: runId }),

  setJobs: (jobs, active) =>
    set({
      jobs,
      jobsActive: active !== undefined ? active : jobs.filter((j) => isActive(j.phase)).length
    }),

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

      switch (event.type) {
        case 'started': {
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
          logs = [
            ...logs,
            {
              id: `${Date.now()}-${seq++}`,
              ts: event.ts,
              level: event.level,
              text: event.text,
              runId: event.runId
            }
          ].slice(-2000);
          break;
        case 'stderr':
          logs = [
            ...logs,
            {
              id: `${Date.now()}-${seq++}`,
              ts: event.ts,
              level: 'stderr',
              text: event.text,
              runId: event.runId
            }
          ].slice(-2000);
          break;
        case 'progress':
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
        case 'success':
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
        case 'failed':
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
