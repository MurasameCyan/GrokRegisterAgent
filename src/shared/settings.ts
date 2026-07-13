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
  /** 用户机器上的 Python 解释器绝对路径（高级/环境变量；UI 不暴露） */
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
   * 邮箱域名池（多行或逗号分隔）。开启 mailDomainPoolEnabled 时使用。
   * 写入 Python config：mail_domains
   */
  mailDomains: string;
  /** 是否使用邮箱域名池（关=只用默认域名） */
  mailDomainPoolEnabled: boolean;
  /** 域名池轮换模式 */
  mailDomainMode: PoolMode;
  /** 是否启用代理（总开关；关=直连） */
  proxyEnabled: boolean;
  /** Python 进程使用的 HTTP 代理（单代理；proxyPoolEnabled 关时使用） */
  proxy: string;
  /**
   * 代理池（多行或逗号分隔）。开启 proxyPoolEnabled 时优先。
   * 支持行尾 #备注：`http://user:pass@ip:port#香港-01`
   * 写入 Python config：proxy_pool
   */
  proxyPool: string;
  /** 是否使用代理池（开=池；关=单代理） */
  proxyPoolEnabled: boolean;
  /** 代理池轮换模式 */
  proxyMode: PoolMode;
  /**
   * 代理池批量测活并发数（1..20，默认 8）。
   * 仅影响设置页「全部测活」，不写 Python 注册配置。
   */
  proxyProbeConcurrency: number;
  /**
   * 删除测活失败代理后是否自动保存配置（默认 false，仅改 draft）。
   */
  proxyAutoSaveOnRemoveFailed: boolean;
  /**
   * 带账号密码代理时优先用本地转发（无认证 127.0.0.1 → 上游认证），
   * 关则先试 MV3 扩展，出口 IP 失败再 fallback。
   */
  proxyPreferLocalForward: boolean;
  /** DrissionPage 浏览器使用的代理；空表示跟随上面的 proxy / 池 */
  browserProxy: string;
  /** Chromium / Chrome / Edge 可执行文件路径；空表示自动探测（UI 不暴露） */
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
  mailDomainPoolEnabled: false,
  mailDomainMode: 'round_robin',
  proxyEnabled: false,
  proxy: '',
  proxyPool: '',
  proxyPoolEnabled: false,
  proxyMode: 'round_robin',
  proxyProbeConcurrency: 8,
  proxyAutoSaveOnRemoveFailed: false,
  proxyPreferLocalForward: false,
  browserProxy: '',
  browserPath: '',
  randomFingerprint: true,
  autoAuthExport: true,
  authDir: '',
  theme: 'system'
};

/** 代理池单条解析结果（含解码后的地区标签） */
export interface ProxyPoolEntry {
  /** 原始行 */
  raw: string;
  /** 剥离 #备注 后的代理 URL */
  proxy: string;
  /** 解码后的标签，如 香港-02；无备注时为空 */
  label: string;
  /** 展示用短主机（host:port） */
  host: string;
}

function decodeProxyLabel(encoded: string): string {
  const t = encoded.trim();
  if (!t) return '';
  try {
    return decodeURIComponent(t.replace(/\+/g, ' '));
  } catch {
    return t;
  }
}

function proxyHostPort(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    // 非标准 URL 时截断显示
    const s = proxyUrl.replace(/^https?:\/\//i, '');
    const at = s.lastIndexOf('@');
    const hostPart = at >= 0 ? s.slice(at + 1) : s;
    return hostPart.split('/')[0] || proxyUrl.slice(0, 40);
  }
}

/** 解析单行代理：URL + 可选 #标签 */
export function parseProxyLine(line: string): ProxyPoolEntry | null {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const schemeIdx = raw.indexOf('://');
  const searchFrom = schemeIdx >= 0 ? schemeIdx + 3 : 0;
  const hashIdx = raw.indexOf('#', searchFrom);
  let proxy = raw;
  let label = '';
  if (hashIdx >= 0) {
    proxy = raw.slice(0, hashIdx).trim();
    label = decodeProxyLabel(raw.slice(hashIdx + 1));
  }
  if (!proxy) return null;
  return {
    raw,
    proxy,
    label,
    host: proxyHostPort(proxy)
  };
}

/** 去掉代理行尾 #备注（支持 URL 编码标签，如 #%E9%A6%99%E6%B8%AF-02） */
export function stripProxyComment(line: string): string {
  return parseProxyLine(line)?.proxy || '';
}

/** 解析代理池 → 条目列表（保序去重，按 proxy URL） */
export function parseProxyPoolEntries(raw?: string): ProxyPoolEntry[] {
  if (!raw || !String(raw).trim()) return [];
  const text = String(raw).replace(/\r\n/g, '\n').replace(/,/g, '\n');
  const seen = new Set<string>();
  const out: ProxyPoolEntry[] = [];
  for (const line of text.split('\n')) {
    const entry = parseProxyLine(line);
    if (!entry) continue;
    if (seen.has(entry.proxy)) continue;
    seen.add(entry.proxy);
    out.push(entry);
  }
  return out;
}

/** 解析代理池文本 → 去重、去备注后的代理 URL 列表 */
export function parseProxyPool(raw?: string): string[] {
  return parseProxyPoolEntries(raw).map((e) => e.proxy);
}

/**
 * 从代理池原文删除指定 proxy URL 对应行（按剥离 # 后的 URL 匹配）。
 * 保留注释行与空行（仅删除命中的数据行）。
 */
export function removeProxiesFromPoolText(raw: string, proxiesToRemove: string[]): string {
  const drop = new Set(
    proxiesToRemove.map((p) => stripProxyComment(p) || String(p || '').trim()).filter(Boolean)
  );
  if (drop.size === 0) return raw;
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      // 压缩连续空行：先收集，末尾再规整
      kept.push('');
      continue;
    }
    if (trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    const entry = parseProxyLine(line);
    if (entry && drop.has(entry.proxy)) continue;
    kept.push(line);
  }
  // 去掉首尾空行，合并中间多余空行
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** 解析通用多行/逗号列表（域名等） */
export function parseStringList(raw?: string): string[] {
  if (!raw || !String(raw).trim()) return [];
  const text = String(raw).replace(/\r\n/g, '\n').replace(/,/g, '\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const it = line.trim();
    if (!it || it.startsWith('#')) continue;
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

function hasDomain(s: AppSettings): boolean {
  if (s.mailDomainPoolEnabled) return parseStringList(s.mailDomains).length > 0;
  return !!s.mail.domain.trim();
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
    errors['mail.domain'] = s.mailDomainPoolEnabled
      ? '请在域名池中至少填一个域名'
      : '请填写邮件域名';
  }
  if (s.mailDomainMode !== 'round_robin' && s.mailDomainMode !== 'random') {
    errors.mailDomainMode = '域名池模式无效';
  }
  if (s.proxyMode !== 'round_robin' && s.proxyMode !== 'random') {
    errors.proxyMode = '代理池模式无效';
  }
  if (
    !Number.isInteger(s.proxyProbeConcurrency) ||
    s.proxyProbeConcurrency < 1 ||
    s.proxyProbeConcurrency > 20
  ) {
    errors.proxyProbeConcurrency = '测活并发须在 1 到 20 之间';
  }
  if (s.proxyEnabled) {
    if (s.proxyPoolEnabled) {
      if (parseProxyPool(s.proxyPool).length === 0) {
        errors.proxyPool = '代理池已开启，请至少填一条代理';
      }
    } else if (!s.proxy.trim() && !s.browserProxy.trim()) {
      errors.proxy = '已开启代理，请填写 HTTP 代理或浏览器代理';
    }
  }
  return errors;
}
