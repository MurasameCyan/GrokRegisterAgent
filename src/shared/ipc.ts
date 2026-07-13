import type { AppSettings, MailSettings, ThemeMode } from './settings';
import type { AccountRecord, RunEvent, RunStatus, TestResult } from './runEvents';

/** 渲染→主：register:start 的可选覆盖项（保存设置之外的临时调整） */
export type RegisterStartArgs = Partial<Pick<AppSettings, 'runCount'>>;

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
  stopRegister(runId: string): Promise<{ ok: boolean }>;
  getStatus(): Promise<RunStatus>;
  onRegisterEvent(cb: (e: RunEvent) => void): () => void;

  // accounts
  listAccounts(): Promise<AccountRecord[]>;
  /** 从 DATA_DIR/sso 与旧路径重新扫描导入历史 */
  resyncAccounts(): Promise<{ total: number; imported: number }>;

  // mail & sso
  getMailCode(address: string): Promise<MailCodeResult>;
  checkSso(items: SsoCheckItem[]): Promise<SsoCheckResult[]>;

  // theme
  getTheme(): Promise<ThemeState>;
  setTheme(mode: ThemeMode): Promise<ThemeState>;
  onThemeChanged(cb: (e: ThemeState) => void): () => void;

  // tests
  testMail(block: MailSettings): Promise<TestResult>;

  // system
  getSystemHealth(): Promise<SystemHealth>;
  checkUpdate(): Promise<UpdateInfo>;
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
