import type { AppSettings, MailSettings, ThemeMode } from './settings';
import type { AccountRecord, RunEvent, RunStatus, TestResult } from './runEvents';

/** 渲染→主：register:start 的可选覆盖项（保存设置之外的临时调整） */
export type RegisterStartArgs = Partial<Pick<AppSettings, 'runCount'>> & {
  maxParallel?: number;
};

/** 并行注册任务摘要（列表浏览） */
export interface RegisterJobSummary {
  runId: string;
  phase: import('./runEvents').RunPhase;
  pid: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  current: number;
  total: number;
  success: number;
  failed: number;
  errorMessage: string | null;
  focused: boolean;
}

export interface RegisterJobsListResult {
  jobs: RegisterJobSummary[];
  active: number;
  focus: string | null;
}

export interface ThemeState {
  mode: ThemeMode;
  /** 应用到 DOM 上的实际主题：'light' | 'dark' */
  effective: 'light' | 'dark';
}

/** 检查更新结果 */
export interface UpdateInfo {
  /** 本地版本号（来自 package.json） */
  current: string;
  /** GitHub 最新 release 的 tag，无发布时为 null */
  latest: string | null;
  /** 是否有新版本 */
  hasUpdate: boolean;
  /** release 页面 URL */
  htmlUrl: string | null;
  /** 发布时间 ISO，可能为 null */
  publishedAt: string | null;
  /** 检查失败时的错误说明 */
  error?: string;
}

/** 邮箱最新验证码查询结果 */
export interface MailCodeResult {
  code: string | null;
  subject: string | null;
  /** 收件时间 ISO */
  receivedAt: string | null;
  /** 该地址是否有任何邮件 */
  hasMail: boolean;
  error?: string;
}

/** SSO 验活请求项 */
export interface SsoCheckItem {
  id: string;
  sso: string;
}

/** SSO 验活结果 */
export interface SsoCheckResult {
  id: string;
  /** 是否存活（grok get-user 返回 200） */
  alive: boolean;
  /** HTTP 状态码，0 表示请求异常 */
  status: number;
  email?: string;
  givenName?: string;
  familyName?: string;
  emailConfirmed?: boolean;
  /** grok 账户层级 */
  sessionTierId?: string;
  /** grok 账户创建时间 ISO */
  createTime?: string;
  /** 验活时间 ISO */
  checkedAt: string;
  error?: string;
  /** JWT claim bot_flag_source（解码 SSO） */
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
}

/** CPA auth 文件列表项 */
export interface CpaAuthItem {
  filename: string;
  path: string;
  email: string;
  sub: string;
  expired: string;
  disabled: boolean;
  hasRefresh: boolean;
  mtime: number;
  /** 文件名以 xai- 开头 */
  xaiFilename: boolean;
  /** JSON 内 type === "xai" */
  xaiType: boolean;
  /** 文件名或 type 任一为 xai */
  xai: boolean;
  authType: string;
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
}

export interface CpaAuthListResult {
  dir: string;
  items: CpaAuthItem[];
}

export interface CpaAuthResignInput {
  filename?: string;
  path?: string;
  sso?: string;
}

export type CpaAuthResignResult = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  mode?: string;
  email?: string;
  filename?: string;
  path?: string;
  xai?: boolean;
  xaiFilename?: boolean;
  xaiType?: boolean;
};

export interface CpaAuthBatchResultItem {
  filename?: string;
  email?: string;
  ok: boolean;
  error?: string;
  mode?: string;
  path?: string;
  xai?: boolean;
  xaiFilename?: boolean;
  xaiType?: boolean;
  /** mint 预检：alive | dead | banned | unknown | bot_flag */
  verdict?: string;
  skipped?: boolean;
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
  /** cehuo /responses 测活 */
  probeAction?: string;
  probeHttp?: number;
  probeDeleted?: boolean;
}

export interface CpaAuthBatchResult {
  total: number;
  ok: number;
  failed: number;
  /** mint 预检跳过（dead/banned/bot_flag） */
  skipped?: number;
  /** 通过预检进入 mint 的数量 */
  alive?: number;
  /** 预检判 banned */
  banned?: number;
  /** 因 bot_flag_source=1 跳过 */
  botFlagSkipped?: number;
  /** 批量 CPA 测活：dead / 已删 / keep */
  dead?: number;
  deleted?: number;
  keep?: number;
  results: CpaAuthBatchResultItem[];
}

export interface CpaAuthMintItem {
  sso: string;
  email?: string;
}

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  mustChangePassword: boolean;
}

export interface ChangeCredentialsInput {
  currentPassword: string;
  username: string;
  password: string;
  confirmPassword: string;
}

export type SystemHealthLevel = 'ok' | 'warn' | 'error';

export interface SystemHealthCheck {
  id: string;
  label: string;
  level: SystemHealthLevel;
  message: string;
  detail?: string;
}

export interface SystemHealth {
  checkedAt: string;
  summary: {
    ok: number;
    warn: number;
    error: number;
    total: number;
  };
  checks: SystemHealthCheck[];
}

/** preload 暴露给 renderer 的 typed surface（与 src/preload/index.ts 保持一致） */
export interface RendererApi {
  // auth
  getAuthState(): Promise<AuthState>;
  login(username: string, password: string): Promise<AuthState>;
  logout(): Promise<{ ok: true }>;
  changeCredentials(input: ChangeCredentialsInput): Promise<AuthState>;

  // settings
  getSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<{ ok: true }>;

  // register
  startRegister(args?: RegisterStartArgs): Promise<{ runId: string }>;
  stopRegister(runId?: string, opts?: { stopAll?: boolean }): Promise<{ ok: boolean; stopped?: string[] }>;
  getStatus(): Promise<RunStatus>;
  listRegisterJobs(): Promise<RegisterJobsListResult>;
  getRegisterJobStatus(runId: string): Promise<RunStatus>;
  focusRegisterJob(runId: string | null): Promise<{ ok: boolean; runId: string | null }>;
  onRegisterEvent(cb: (e: RunEvent) => void): () => void;

  // accounts
  listAccounts(): Promise<AccountRecord[]>;
  /** 从 DATA_DIR/sso 与旧路径重新扫描导入历史 */
  resyncAccounts(): Promise<{ total: number; imported: number }>;
  /** 按 id 批量删除号池账号 */
  deleteAccounts(ids: string[]): Promise<{
    deleted: number;
    requested: number;
    remaining: number;
  }>;
  /** 粘贴/上传文本导入 SSO 到号池 */
  importAccounts(input: {
    text: string;
    source?: string;
  }): Promise<{
    totalLines: number;
    parsed: number;
    imported: number;
    skipped: number;
    invalid: number;
    remaining: number;
  }>;

  // mail & sso
  getMailCode(address: string): Promise<MailCodeResult>;
  checkSso(items: SsoCheckItem[]): Promise<SsoCheckResult[]>;

  // CPA auth（与登录 /api/auth 区分）
  listCpaAuth(): Promise<CpaAuthListResult>;
  resignCpaAuth(input: CpaAuthResignInput): Promise<CpaAuthResignResult>;
  resignCpaAuthBatch(input: {
    filenames?: string[];
    paths?: string[];
    concurrency?: number;
  }): Promise<CpaAuthBatchResult>;
  mintCpaAuthFromSso(input: {
    items: CpaAuthMintItem[];
    concurrency?: number;
    /** 默认 true：跳过 bot_flag_source=1 的 SSO */
    skipBotFlag1?: boolean;
  }): Promise<CpaAuthBatchResult>;
  /** 批量 CPA 测活（cehuo /responses） */
  probeCpaAuthBatch(input: {
    filenames?: string[];
    paths?: string[];
    concurrency?: number;
    deleteOnDead?: boolean;
  }): Promise<CpaAuthBatchResult>;
  /** 批量删除 CPA auth 文件 */
  deleteCpaAuth(input: {
    filenames?: string[];
    paths?: string[];
  }): Promise<{
    total: number;
    deleted: number;
    failed: number;
    results: CpaAuthBatchResultItem[];
  }>;
  /** 读取 auth 文件内容（导出） */
  exportCpaAuth(input: {
    filenames: string[];
  }): Promise<{
    dir: string;
    files: Array<{ filename: string; email: string; content: string }>;
  }>;

  // theme
  getTheme(): Promise<ThemeState>;
  setTheme(mode: ThemeMode): Promise<ThemeState>;
  onThemeChanged(cb: (e: ThemeState) => void): () => void;

  // tests
  testMail(block: MailSettings): Promise<TestResult>;
  /** 单条代理测活（经代理访问公网 IP） */
  testProxy(proxy: string): Promise<TestResult & { exitIp?: string; latencyMs?: number }>;
  /** 批量并发代理测活（大批量请前端分块调用，避免反向代理 524） */
  testProxyBatch(input: {
    proxies: string[];
    concurrency?: number;
    timeoutMs?: number;
  }): Promise<{
    total: number;
    ok: number;
    fail: number;
    concurrency: number;
    timeoutMs?: number;
    results: Array<
      TestResult & { proxy?: string; scheme?: string; exitIp?: string; latencyMs?: number }
    >;
  }>;

  // system
  getSystemHealth(): Promise<SystemHealth>;
  checkUpdate(): Promise<UpdateInfo>;
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
