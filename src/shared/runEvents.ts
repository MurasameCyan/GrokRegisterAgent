/**
 * Python 子进程往渲染进程流式推送的事件。
 * stdout 行已经按前缀分级，渲染端只关心 level + text。
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'tip' | 'plain';

export type RunPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'done'
  | 'error'
  | 'killed';

export interface RunStatus {
  phase: RunPhase;
  runId: string | null;
  pid: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  /** 当前轮次 */
  current: number;
  /** 计划总轮次 */
  total: number;
  /** 注册成功数 */
  success: number;
  /** 注册失败数 */
  failed: number;
  /** 错误摘要，仅 phase==='error' 时有值 */
  errorMessage: string | null;
}

/** 一条完整账号记录：邮箱 + 密码 + sso，由 registerBot 从 Python stdout 关联生成 */
export interface AccountRecord {
  id: string;
  runId: string;
  email: string;
  password: string;
  sso: string;
  /** ISO 字符串 */
  createdAt: string;
}

export type RunEvent =
  | { type: 'started'; runId: string; pid: number; total: number }
  | { type: 'stdout'; runId: string; level: LogLevel; text: string; ts: number }
  | { type: 'stderr'; runId: string; text: string; ts: number }
  | { type: 'progress'; runId: string; current: number; total: number }
  | { type: 'success'; runId: string; success: number; total: number }
  | { type: 'sso'; runId: string; token: string }
  | { type: 'account'; runId: string; record: AccountRecord }
  | {
      type: 'exit';
      runId: string;
      code: number | null;
      signal: string | null;
      killed: boolean;
    };

/** 测试连接的统一返回 */
export interface TestResult {
  ok: boolean;
  message: string;
  /** 调用耗时（ms） */
  ms?: number;
  /** 服务端返回的额外信息（例如 token 总数、Python 版本） */
  detail?: Record<string, unknown>;
}

export const EMPTY_STATUS: RunStatus = {
  phase: 'idle',
  runId: null,
  pid: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  current: 0,
  total: 0,
  success: 0,
  failed: 0,
  errorMessage: null
};
