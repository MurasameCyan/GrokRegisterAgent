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

/** 检查更新结果（以 BUILD_ID / git short SHA 为主） */
export interface UpdateInfo {
  /** 本地构建号：BUILD_ID short hash，无则 package.json version */
  current: string;
  /** 远端 beta 最新 short SHA，失败时为 null */
  latest: string | null;
  /** 本地 hash 与远端 beta HEAD 不一致则为 true */
  hasUpdate: boolean;
  /** 对照用的 commit / 提交列表 URL */
  htmlUrl: string | null;
  /** 远端 commit 时间 ISO，可能为 null */
  publishedAt: string | null;
  /** 与 current 相同，显式 BUILD_ID 字段便于前端展示 */
  buildId?: string;
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
  /**
   * auth 文件内 sso 字段的 SHA-256 hex（规范化 strip sso= 后）。
   * 用于号池无邮箱时与账号 SSO 交叉匹配「已转 Auth」。
   */
  ssoHash?: string | null;
  /** auth 是否写入了 sso 原文（不返回原文，仅布尔） */
  hasSso?: boolean;
  /**
   * mint 通道：A=pkce / B=device。
   * 来自 mint_channel 字段或文件名后缀 -pkce / -device。
   */
  mintChannel?: 'A' | 'B' | null;
  /** 上次测活结果（落盘，刷新后仍显示） */
  probeAction?: string | null;
  probeHttp?: number | null;
  probeAt?: string | null;
  /**
   * 号池是否存在同邮箱且带密码（重登前置校验）。
   * false/undefined 时前端应禁止点重登，避免开浏览器后才失败。
   */
  poolHasPassword?: boolean;
  /** NSFW：true 已开 / false 尝试失败 / null 未尝试 */
  nsfwEnabled?: boolean | null;
  nsfwAttempted?: boolean;
  nsfwAt?: string | null;
  nsfwError?: string | null;
  /** ok | fail | none */
  nsfwStatus?: 'ok' | 'fail' | 'none';
  /** ZDR：true=已关 / false=仍开或失败 / null=未尝试 */
  zdrClosed?: boolean | null;
  zdrAttempted?: boolean;
  zdrAt?: string | null;
  zdrError?: string | null;
  /** closed | open | none */
  zdrStatus?: 'closed' | 'open' | 'none';
}

export interface CpaAuthListResult {
  dir: string;
  items: CpaAuthItem[];
}

export interface CpaAuthResignInput {
  filename?: string;
  path?: string;
  sso?: string;
  /** 重签成功后推送远程 CPA（默认 false） */
  pushRemote?: boolean;
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
  remoteOk?: boolean | null;
  remoteError?: string;
  remoteName?: string;
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
  /** 401/403 密码重登二次测活时，首次触发恢复的 HTTP 状态码 */
  recoverHttp?: number;
  /** Management API 推送：true/false；null/undefined=未配置或未尝试 */
  remoteOk?: boolean | null;
  remoteError?: string;
  remoteName?: string;
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
  /** 远程推送成功/失败计数 */
  remoteOk?: number;
  remoteFailed?: number;
  /** 批量 CPA 测活：dead / 已删 / keep */
  dead?: number;
  deleted?: number;
  keep?: number;
  /** 测活死号同步删除的号池 SSO 数 */
  ssoDeleted?: number;
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
  getAuthQueueMetrics?(): Promise<{
    ok?: boolean;
    pending?: number;
    queue_size?: number;
    done_ok?: number;
    done_fail?: number;
    workers?: number;
    queue_max?: number;
    updated_at?: number;
    updated_iso?: string;
    stale?: boolean;
  }>;
  listRegisterJobs(): Promise<RegisterJobsListResult>;
  getRegisterJobStatus(runId: string): Promise<RunStatus>;
  focusRegisterJob(runId: string | null): Promise<{ ok: boolean; runId: string | null }>;
  /** 清理已停/完成/失败的任务，返回移除数量 */
  clearFinishedRegisterJobs(): Promise<{
    ok: true;
    removed: number;
    removedIds?: string[];
  }>;
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
  /**
   * SSO 验活。服务端会落盘 ssoCheck，并对「号池无邮箱且 grok 返回 email」的账号补全邮箱。
   * 返回 results；emailsFilled 为本次补全邮箱条数。
   */
  checkSso(items: SsoCheckItem[]): Promise<SsoCheckResult[] & { emailsFilled?: number }>;

  // CPA auth（与登录 /api/auth 区分）
  listCpaAuth(): Promise<CpaAuthListResult>;
  resignCpaAuth(input: CpaAuthResignInput): Promise<CpaAuthResignResult>;
  resignCpaAuthBatch(input: {
    filenames?: string[];
    paths?: string[];
    concurrency?: number;
    pushRemote?: boolean;
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
  /**
   * 密码重登激活：浏览器登录 → mint → 随机英文消息 → 二次测活。
   * 单条通常 30～120s。
   */
  reloginCpaAuth(input: {
    filename?: string;
    path?: string;
  }): Promise<
    CpaAuthBatchResultItem & {
      ok: boolean;
      probeAction?: string;
      probeHttp?: number;
      mode?: string;
      error?: string;
      email?: string;
      filename?: string;
    }
  >;
  /** 批量推送已有 auth 到远程 CPA（不重新 mint） */
  pushCpaAuthRemote(input: {
    filenames?: string[];
    paths?: string[];
    concurrency?: number;
  }): Promise<CpaAuthBatchResult & { remoteConfigured?: boolean; remoteUrl?: string }>;
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
  /**
   * 从号池按 email 给 auth 目录回填顶层 sso。
   * 用于旧文件无 sso、号池无邮箱时无法 SSO 哈希匹配。
   */
  backfillCpaAuthSso(input?: {
    filenames?: string[];
    force?: boolean;
    dryRun?: boolean;
  }): Promise<{
    dir: string;
    scanned: number;
    alreadyHasSso: number;
    filled: number;
    skippedNoEmail: number;
    skippedNoMatch: number;
    failed: number;
    dryRun: boolean;
    results: Array<{
      filename: string;
      email: string;
      ok: boolean;
      action: string;
      error?: string;
    }>;
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
  /** 远程 CPA Management API 连通性（地址+密钥；不上传文件） */
  testCpaRemote(input?: { url?: string; key?: string }): Promise<
    TestResult & { status?: number; remoteUrl?: string }
  >;
  /** 远程 grok2api 管理登录连通性（不上传账号） */
  testGrok2apiRemote(input?: {
    url?: string;
    username?: string;
    password?: string;
  }): Promise<TestResult & { status?: number; remoteUrl?: string; latencyMs?: number }>;
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
  /**
   * 从网页拉取代理（hide.mn 表格 / 明文 ip:port）。
   * viaProxy：是否用当前 HTTP 代理去拉页面。
   * pages：hide.mn 翻页数（1–20）。
   */
  fetchProxiesFromUrl(input: {
    url?: string;
    viaProxy?: boolean;
    pages?: number;
  }): Promise<{
    ok: boolean;
    url: string;
    lines: string[];
    count: number;
    format: string;
    message: string;
    sample: string[];
    pagesFetched?: number;
  }>;

  /** CF 独立代理（cfwp）状态 */
  getCfProxyStatus(): Promise<CfProxyStatus>;
  /** 按已保存配置启动/重载 cfwp */
  startCfProxy(): Promise<CfProxyStatus & { ok?: boolean; error?: string }>;
  /** 停止 cfwp 进程 */
  stopCfProxy(): Promise<CfProxyStatus & { ok?: boolean }>;
  /** 按 settings 同步启停 */
  syncCfProxy(): Promise<CfProxyStatus & { ok?: boolean }>;
  /** 读取 cfwp 最近日志 */
  getCfProxyLog(tail?: number): Promise<CfProxyLogResult>;

  /** sing-box 独立代理状态 */
  getSingBoxStatus(): Promise<SingBoxStatus>;
  /** 节点摘要列表 + 当前选中 */
  getSingBoxNodes(): Promise<{ nodes: SingBoxNodeSummary[]; selected: string }>;
  /** 解析节点文本（draft 预览，不写盘） */
  parseSingBoxNodes(
    nodes: string
  ): Promise<{ nodes: SingBoxNodeSummary[]; parseable: number }>;
  /** 按已保存配置启动/重载 sing-box */
  startSingBox(): Promise<SingBoxStatus & { ok?: boolean; error?: string }>;
  /** 停止 sing-box 进程 */
  stopSingBox(): Promise<SingBoxStatus & { ok?: boolean }>;
  /** 按 settings 同步启停 */
  syncSingBox(): Promise<SingBoxStatus & { ok?: boolean }>;
  /** 降级轮换节点 */
  rotateSingBox(
    reason?: string
  ): Promise<SingBoxStatus & { ok?: boolean; rotated?: boolean; message?: string }>;
  /** 读取 sing-box 最近日志 */
  getSingBoxLog(tail?: number): Promise<SingBoxLogResult>;

  // system
  getSystemHealth(): Promise<SystemHealth>;
  checkUpdate(): Promise<UpdateInfo>;
}

/** CF cfwp 本地代理运行状态 */
export interface CfProxyStatus {
  running: boolean;
  pid: number | null;
  port: number;
  localUrl: string;
  binary: string | null;
  binaryExists: boolean;
  domain: string;
  lastError: string | null;
  startedAt: number | null;
  logPath: string | null;
  platform: string;
  arch: string;
}

/** CF cfwp 最近日志 */
export interface CfProxyLogResult {
  ok: boolean;
  logPath: string | null;
  content: string;
  truncated: boolean;
  error?: string;
}

/** sing-box 本地 mixed 代理运行状态 */
export interface SingBoxStatus {
  running: boolean;
  pid: number | null;
  port: number;
  localUrl: string;
  binary: string | null;
  binaryExists: boolean;
  selected: string;
  selectedName: string;
  nodeCount: number;
  lastError: string | null;
  startedAt: number | null;
  logPath: string | null;
  configPath: string | null;
  platform: string;
  arch: string;
}

/** sing-box 节点摘要 */
export interface SingBoxNodeSummary {
  tag: string;
  name: string;
  type: string;
  server: string;
  port: number;
  raw: string;
}

/** sing-box 最近日志 */
export interface SingBoxLogResult {
  ok: boolean;
  logPath: string | null;
  content: string;
  truncated: boolean;
  error?: string;
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
