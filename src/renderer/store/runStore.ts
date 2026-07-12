import { create } from 'zustand';
import type { LogLevel, RunEvent, RunStatus } from '@shared/runEvents';
import { EMPTY_STATUS } from '@shared/runEvents';

const MAX_LOG = 500;

export interface LogLine {
  id: number;
  level: LogLevel | 'stderr';
  text: string;
  ts: number;
}

interface RunState {
  status: RunStatus;
  logs: LogLine[];
  applyEvent(e: RunEvent): void;
  setStatus(s: RunStatus): void;
  clearLogs(): void;
}

let logCounter = 0;

export const useRunStore = create<RunState>((set) => ({
  status: { ...EMPTY_STATUS },
  logs: [],
  applyEvent: (e: RunEvent) =>
    set((state) => {
      const next = { ...state };
      switch (e.type) {
        case 'started':
          next.status = {
            ...EMPTY_STATUS,
            phase: 'running',
            runId: e.runId,
            pid: e.pid,
            startedAt: Date.now(),
            total: e.total
          };
          next.logs = [];
          break;
        case 'stdout': {
          const line: LogLine = {
            id: ++logCounter,
            level: e.level,
            text: e.text,
            ts: e.ts
          };
          next.logs = appendCircular(state.logs, line);
          break;
        }
        case 'stderr': {
          const line: LogLine = {
            id: ++logCounter,
            level: 'stderr',
            text: e.text,
            ts: e.ts
          };
          next.logs = appendCircular(state.logs, line);
          break;
        }
        case 'progress':
          next.status = {
            ...state.status,
            current: e.current,
            total: e.total
          };
          break;
        case 'success':
          next.status = {
            ...state.status,
            success: e.success,
            total: e.total
          };
          break;
        case 'exit':
          next.status = {
            ...state.status,
            phase: e.killed ? 'killed' : e.code === 0 ? 'done' : 'error',
            exitCode: e.code,
            finishedAt: Date.now(),
            errorMessage:
              e.code !== 0 && !e.killed ? `进程退出码 ${e.code}` : null
          };
          break;
        case 'sso':
          // 在此可以触发"实时 token 列表"，目前仅静默
          break;
      }
      return next;
    }),
  setStatus: (s) => set({ status: s }),
  clearLogs: () => set({ logs: [] })
}));

function appendCircular(arr: LogLine[], line: LogLine): LogLine[] {
  if (arr.length < MAX_LOG) return [...arr, line];
  return [...arr.slice(arr.length - MAX_LOG + 1), line];
}
