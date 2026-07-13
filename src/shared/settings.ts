/**
 * 应用配置（GUI 设置页所有字段的真源）
 * 这些字段会持久化到服务端数据目录，并在每次"开始注册"前同步到内置 register/config.json。
 */
export interface MailSettings {
  /** 邮件后端 API 根地址，例如 https://mail.example.com */
  apiBase: string;
  /** 邮件后端管理密码（vmail 的 X-Admin-Auth 头） */
  adminAuth: string;
  /** 邮件域名后缀，例如 example.com（单域名；可与 mailDomains 池并存） */
  domain: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';

/** 池轮换策略 */
export type PoolMode = 'round_robin' | 'random';

export interface AppSettings {
  /** 用户机器上的 Python 解释器绝对路径 */
  pythonPath: string;
  /** 注册机目录（可留空；服务端会自动使用项目内置 register/） */
  registerDir: string;
  /** 一次"开始注册"要跑的轮数，1..50 */
  runCount: number;
  /**
   * 人机验证「自动通过」等待上限（秒）。
   * 实际每次在 [30, turnstileAutoWaitMax] 内随机；必须 ≥ 30。
   */
  turnstileAutoWaitMax: number;
  mail: MailSettings;
  /**
   * 邮箱域名池（多行或逗号分隔）。非空时优先于 mail.domain 轮换。
   * 写入 Python config：mail_domains
   */
  mailDomains: string;
  /** 域名池轮换模式 */
  mailDomainMode: PoolMode;
  /** Python 进程使用的 HTTP 代理（单代理；可与 proxyPool 并存） */
  proxy: string;
  /**
   * 代理池（多行或逗号分隔）。非空时优先于 proxy 轮换。
   * 写入 Python config：proxy_pool
   */
  proxyPool: string;
  /** 代理池轮换模式 */
  proxyMode: PoolMode;
  /** DrissionPage 浏览器使用的代理；空表示跟随上面的 proxy / 池 */
  browserProxy: string;
  /** Chromium / Chrome / Edge 可执行文件路径；空表示让 DrissionPage 自动探测系统浏览器 */
  browserPath: string;
  /** 注册时随机浏览器/请求指纹（UA、语言、时区、分辨率等） */
  randomFingerprint: boolean;
  /** 注册成功后自动 SSO→CPA auth 导出 */
  autoAuthExport: boolean;
  /**
   * CPA auth 文件目录。空则 DATA_DIR/auth（容器内多为 /data/auth）。
   * 写入 Python config：auth_dir / cpa_auth_dir
   */
  authDir: string;
  /** 主题模式 */
  theme: ThemeMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pythonPath: '',
  registerDir: '',
  runCount: 10,
  turnstileAutoWaitMax: 60,
  mail: {
    apiBase: '',
    adminAuth: '',
    domain: ''
  },
  mailDomains: '',
  mailDomainMode: 'round_robin',
  proxy: '',
  proxyPool: '',
  proxyMode: 'round_robin',
  browserProxy: '',
  browserPath: '',
  randomFingerprint: true,
  autoAuthExport: true,
  authDir: '',
  theme: 'system'
};

function hasDomain(s: AppSettings): boolean {
  return !!(s.mail.domain.trim() || s.mailDomains.trim());
}

export function validateSettings(s: AppSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Number.isInteger(s.runCount) || s.runCount < 1 || s.runCount > 50)
    errors.runCount = '数量必须在 1 到 50 之间';
  if (
    !Number.isInteger(s.turnstileAutoWaitMax) ||
    s.turnstileAutoWaitMax < 30 ||
    s.turnstileAutoWaitMax > 180
  )
    errors.turnstileAutoWaitMax = '人机验证自动等待上限须在 30 到 180 秒之间';
  if (!s.mail.apiBase.trim()) errors['mail.apiBase'] = '请填写邮件后端地址';
  if (!s.mail.adminAuth.trim()) errors['mail.adminAuth'] = '请填写邮件后端管理密码';
  if (!hasDomain(s)) {
    errors['mail.domain'] = '请填写邮件域名，或在域名池中至少填一个域名';
  }
  if (s.mailDomainMode !== 'round_robin' && s.mailDomainMode !== 'random') {
    errors.mailDomainMode = '域名池模式无效';
  }
  if (s.proxyMode !== 'round_robin' && s.proxyMode !== 'random') {
    errors.proxyMode = '代理池模式无效';
  }
  return errors;
}
