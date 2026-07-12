/**
 * 应用配置（GUI 设置页所有字段的真源）
 * 这些字段会持久化到服务端数据目录，并在每次"开始注册"前同步到内置 register/config.json。
 */
export interface MailSettings {
  /** 邮件后端 API 根地址，例如 https://mail.example.com */
  apiBase: string;
  /** 邮件后端管理密码（vmail 的 X-Admin-Auth 头） */
  adminAuth: string;
  /** 邮件域名后缀，例如 example.com */
  domain: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppSettings {
  /** 用户机器上的 Python 解释器绝对路径 */
  pythonPath: string;
  /** 注册机目录（可留空；服务端会自动使用项目内置 register/） */
  registerDir: string;
  /** 一次"开始注册"要跑的轮数，1..50 */
  runCount: number;
  mail: MailSettings;
  /** Python 进程使用的 HTTP 代理 */
  proxy: string;
  /** DrissionPage 浏览器使用的代理；空表示跟随上面的 proxy */
  browserProxy: string;
  /** Chromium / Chrome / Edge 可执行文件路径；空表示让 DrissionPage 自动探测系统浏览器 */
  browserPath: string;
  /** 主题模式 */
  theme: ThemeMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pythonPath: '',
  registerDir: '',
  runCount: 10,
  mail: {
    apiBase: '',
    adminAuth: '',
    domain: ''
  },
  proxy: '',
  browserProxy: '',
  browserPath: '',
  theme: 'system'
};

export function validateSettings(s: AppSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Number.isInteger(s.runCount) || s.runCount < 1 || s.runCount > 50)
    errors.runCount = '数量必须在 1 到 50 之间';
  if (!s.mail.apiBase.trim()) errors['mail.apiBase'] = '请填写邮件后端地址';
  if (!s.mail.adminAuth.trim()) errors['mail.adminAuth'] = '请填写邮件后端管理密码';
  if (!s.mail.domain.trim()) errors['mail.domain'] = '请填写邮件域名';
  return errors;
}
