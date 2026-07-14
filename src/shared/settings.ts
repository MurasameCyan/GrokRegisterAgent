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
   * 并行注册任务上限（同时 running/starting 的 worker 数）。
   * 默认 3，硬上限 8。
   */
  maxParallelWorkers: number;
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
   * 待定池（多行或逗号分隔）：网页导入 / 测活未过 / 注册使用失败降级。
   * 测活三条件全过才移入 proxyPoolAlive。
   * 支持行尾 #备注：`http://user:pass@ip:port#香港-01`
   */
  proxyPool: string;
  /**
   * 可用池：测活成功的代理（多行）。注册时 **只写入** 本池（不再合并待定池）。
   * 注册中出口 IP / 页面不可达失败时会降级回 proxyPool。
   */
  proxyPoolAlive: string;
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
   * @deprecated 已移除自定义 Auth 目录 UI；始终使用 DATA_DIR/auth。
   * 字段保留兼容旧 settings.json，读写时忽略。
   */
  authDir: string;
  /**
   * Auth → 远程 CPA 推送（「推送授权」卡片 Auth 目标按钮）。
   * 关闭时即使填了 URL/密钥也不写入 Python cpa_remote_*。
   * @deprecated 语义等同 pushAuthToCpa，保留兼容
   */
  cpaRemotePushEnabled: boolean;
  /** Auth 文件/导出 → 远程 CPA Management API */
  pushAuthToCpa: boolean;
  /** SSO Cookie → grok2api（仅 SSO 通道） */
  pushSsoToGrok2api: boolean;
  /** Auth 导出后额外推送到 grok2api（与 SSO 推送可同时开，成功注册时合并一次上传即可） */
  pushAuthToGrok2api: boolean;
  /**
   * 远程 CPA 根地址（Management API），如 http://host:8317。
   * 写入 Python config：cpa_remote_url（需 pushAuthToCpa）
   */
  cpaRemoteUrl: string;
  /**
   * 远程 CPA 管理密钥（remote-management.secret-key 明文）。
   * 写入 Python config：cpa_management_key
   */
  cpaManagementKey: string;
  /**
   * CPA 测活遇 401/402/403 时是否自动删除 auth 文件。
   * 默认 false（仅标记死号）；开则删文件。
   */
  cpaProbeDeleteOnDead: boolean;
  /**
   * Auth 测活死号且已删 auth 时，是否同步删除号池（SSO 列表）中同邮箱账号。
   * 默认 false。不删 SSO 历史 txt 文件，仅 accounts.json。
   */
  cpaProbeDeleteSsoOnDead: boolean;
  /**
   * 同一代理 IP 两次用于注册的最小间隔（秒）。
   * 0=不限制；未到时间时队列暂停等待（优先换其它已冷却 IP）。
   * 写入 Python config：proxy_ip_interval_sec
   */
  proxyIpIntervalSec: number;
  /**
   * 补 Auth / mint 时跳过 SSO JWT 中 bot_flag_source=1 的账号。
   * 默认 true。无法抹掉已签发 claim，仅过滤。
   */
  skipBotFlag1OnMint: boolean;
  /**
   * 号池 SSO 验活是否走 HTTP 代理。
   * 需同时 proxyEnabled=true 且配置了 proxy 才实际走代理。
   */
  ssoCheckUseProxy: boolean;
  /**
   * Auth 转换（mint）/ 重签 / CPA 测活是否走 HTTP 代理。
   * 需同时 proxyEnabled=true 且配置了 proxy 才实际走代理。
   */
  cpaAuthUseProxy: boolean;
  /**
   * 网页拉取代理：默认源（hide.mn 列表页或其它 ip:port 文本页）
   */
  proxyFetchUrl: string;
  /**
   * Plan A 失败后是否启用 Plan B 兜底一次（FlowPilot 人机等待/模拟点击/CF 拦截识别）。
   * 默认 true：A 失败 → B 一次 → 仍失败则跳过下一账号。
   */
  registerPlanBEnabled: boolean;
  /**
   * @deprecated 使用 pushSsoToGrok2api / pushAuthToGrok2api。
   * 兼容旧配置：为 true 时视为 pushSsoToGrok2api。
   */
  grok2apiAutoUpload: boolean;
  /** grok2api 管理面板根 URL，如 http://127.0.0.1:8000 */
  grok2apiUrl: string;
  grok2apiUsername: string;
  grok2apiPassword: string;
  /** 主题模式 */
  theme: ThemeMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pythonPath: '',
  registerDir: '',
  runCount: 10,
  maxParallelWorkers: 3,
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
  proxyPoolAlive: '',
  proxyPoolEnabled: false,
  proxyMode: 'round_robin',
  proxyProbeConcurrency: 8,
  proxyAutoSaveOnRemoveFailed: false,
  /** 默认开：带密码代理走本地转发，避免 DrissionPage set_proxy 丢弃凭据 */
  proxyPreferLocalForward: true,
  browserProxy: '',
  browserPath: '',
  randomFingerprint: true,
  autoAuthExport: true,
  authDir: '',
  cpaRemotePushEnabled: false,
  pushAuthToCpa: false,
  pushSsoToGrok2api: false,
  pushAuthToGrok2api: false,
  cpaRemoteUrl: '',
  cpaManagementKey: '',
  cpaProbeDeleteOnDead: false,
  cpaProbeDeleteSsoOnDead: false,
  proxyIpIntervalSec: 0,
  skipBotFlag1OnMint: true,
  /** 号池验活默认走代理（若总开关与 proxy 已配） */
  ssoCheckUseProxy: true,
  /** Auth mint/重签/测活默认走代理 */
  cpaAuthUseProxy: true,
  proxyFetchUrl: 'https://hide.mn/en/proxy-list/',
  registerPlanBEnabled: true,
  grok2apiAutoUpload: false,
  grok2apiUrl: '',
  grok2apiUsername: '',
  grok2apiPassword: '',
  theme: 'system'
};

/** 代理池单条解析结果（含解码后的地区标签） */
export interface ProxyPoolEntry {
  /** 原始行 */
  raw: string;
  /** 剥离 #备注 后的代理 URL */
  proxy: string;
  /** 解码后的标签，如 香港-02；无备注时为空（不含「成功N」计数展示） */
  label: string;
  /** 展示用短主机（host:port） */
  host: string;
  /**
   * 注册成功次数（写在行尾备注 `#成功N`）。
   * 仅可用池使用；前端绿色显示。
   */
  successCount?: number;
}

/** 从备注文本解析注册成功次数 */
export function parseProxySuccessCount(text: string): number {
  const s = String(text || '');
  const m =
    /(?:^|[\s·|/,_-])(?:成功|ok)[:：\s]*(\d+)\b/i.exec(s) ||
    /#(?:成功|ok)[:：]?(\d+)\b/i.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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

/** host:port 或 user:pass@host:port（无 scheme） */
const HOST_PORT_RE =
  /^(?:([^@\s/]+)@)?((?:\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?|[\w.-]+):(\d{1,5}))$/i;

/**
 * 供应商 CSV 行（整行一条，逗号不当分隔符）：
 * - `18,172.64.149.71:80,美国,HTTP,平均`
 * - `172.64.149.71:80,荷兰,HTTP,平均`
 * - `19,user:pass@45.131.5.33:80,荷兰,HTTP`
 * 字段：可选序号, 代理地址, 地区, 协议, 质量…
 */
function parseCsvProxyLine(rawLine: string): { proxy: string; label: string } | null {
  const s = String(rawLine || '').trim();
  if (!s || s.includes('://')) return null;
  // 至少 3 段（地址 + 2 个元数据）或「序号 + 地址 + 元数据」
  if (!s.includes(',')) return null;
  const parts = s.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return null;

  let addrIdx = -1;
  // 优先：首段是纯数字序号 → 第二段为地址
  if (/^\d+$/.test(parts[0]) && parts.length >= 2 && HOST_PORT_RE.test(parts[1])) {
    addrIdx = 1;
  } else if (HOST_PORT_RE.test(parts[0])) {
    addrIdx = 0;
  } else {
    // 兜底：找第一个像 host:port 的字段
    for (let i = 0; i < parts.length; i++) {
      if (HOST_PORT_RE.test(parts[i])) {
        addrIdx = i;
        break;
      }
    }
  }
  if (addrIdx < 0) return null;

  // 需要至少一段标签元数据，避免把 `a,b` 误判（地址后还有字段）
  if (addrIdx >= parts.length - 1 && parts.length < 3) {
    // `18,ip:port` 仅两段也接受
    if (!(addrIdx === 1 && /^\d+$/.test(parts[0]))) return null;
  }

  const addr = parts[addrIdx];
  const meta = parts.filter((_, i) => i !== addrIdx && !(i < addrIdx && /^\d+$/.test(parts[i])));
  // 去掉序号后的标签：地区 · 协议 · 质量
  const label = meta.join(' · ');
  return { proxy: addr, label };
}

/**
 * 是否为「序号,ip:port,地区,…」类 CSV 代理行（整行勿按逗号拆成多条）
 */
export function isCsvStyleProxyLine(line: string): boolean {
  return parseCsvProxyLine(line) != null;
}

/**
 * 剥离行尾备注/元数据，转为 proxy + label。
 * 支持：
 * - `http://u:p@ip:port#香港-02`
 * - `8.216.35.12:8888（日本，elite，HTTPS）` / 半角 `(日本, elite, HTTPS)`
 * - `18,172.64.149.71:80,美国,HTTP,平均`
 * - 混写：`ip:port（日本）#备用`
 */
function splitProxyAnnotation(rawLine: string): { proxy: string; label: string } {
  let s = String(rawLine || '').trim();
  if (!s) return { proxy: '', label: '' };

  // 0) 供应商 CSV：序号,ip:port,地区,协议,质量
  const csv = parseCsvProxyLine(s);
  if (csv) return csv;

  const labels: string[] = [];

  // 1) 尾部全角/半角括号备注：…（日本，elite，HTTPS） / …(Japan, elite, HTTPS)
  //    从右向左匹配最外层一对括号（供应商列表常见）
  const parenRe = /[（(]([^）)]*)[）)]\s*$/;
  for (let i = 0; i < 3; i++) {
    const m = s.match(parenRe);
    if (!m) break;
    const inner = (m[1] || '').trim();
    if (inner) {
      // 逗号（半角/全角）统一成「 · 」作标签展示
      const pretty = inner.replace(/[,\uFF0C]+/g, ' \u00b7 ');
      labels.push(pretty);
    }
    s = s.slice(0, m.index).trim();
  }

  // 2) 行尾 # 备注（须在 scheme 之后，避免误伤）
  const schemeIdx = s.indexOf('://');
  const searchFrom = schemeIdx >= 0 ? schemeIdx + 3 : 0;
  const hashIdx = s.indexOf('#', searchFrom);
  if (hashIdx >= 0) {
    const hashLabel = decodeProxyLabel(s.slice(hashIdx + 1));
    if (hashLabel) labels.push(hashLabel);
    s = s.slice(0, hashIdx).trim();
  }

  // 3) 无 scheme 时：若括号元数据暗示 socks，可保留由测活/使用侧加 http://
  //    此处不改 scheme；HTTPS 在代理列表里通常表示「支持 HTTPS 隧道」，仍走 http:// 代理协议
  return {
    proxy: s,
    label: labels.filter(Boolean).join(' · ')
  };
}

/** 解析单行代理：URL + 可选 #标签 / （地区） / CSV 序号,ip:port,地区,协议 */
export function parseProxyLine(line: string): ProxyPoolEntry | null {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const { proxy, label } = splitProxyAnnotation(raw);
  if (!proxy) return null;
  const successCount =
    parseProxySuccessCount(raw) || parseProxySuccessCount(label) || 0;
  // 展示标签去掉「成功N」，单独用 successCount 绿色显示
  const labelClean = label
    .replace(/(?:^|[\s·|/,_-])(?:成功|ok)[:：\s]*\d+\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[·\s]+|[·\s]+$/g, '')
    .trim();
  return {
    raw,
    proxy,
    label: labelClean,
    host: proxyHostPort(proxy),
    ...(successCount > 0 ? { successCount } : {})
  };
}

/** 去掉代理行尾 #备注（支持 URL 编码标签，如 #%E9%A6%99%E6%B8%AF-02） */
export function stripProxyComment(line: string): string {
  return parseProxyLine(line)?.proxy || '';
}

/**
 * 拆分代理池文本为行。
 * - 换行分隔
 * - 半角逗号也可分隔多条（兼容旧粘贴 `a,b,c` 多 URL）
 * - 括号内逗号不拆
 * - CSV 供应商行 `18,ip:port,美国,HTTP,平均` 整行保留，不拆
 */
function splitProxyPoolText(raw: string): string[] {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CSV 代理行：整行一条
    if (isCsvStyleProxyLine(trimmed)) {
      out.push(trimmed);
      continue;
    }
    // 保护括号内逗号，避免被当成条目分隔符
    const protectedLine = line.replace(/[（(][^）)]*[）)]/g, (m) =>
      m.replace(/,/g, '\u0000')
    );
    for (const part of protectedLine.split(',')) {
      const one = part.replace(/\u0000/g, ',').trim();
      if (one) out.push(one);
    }
  }
  return out;
}

/** 解析代理池 → 条目列表（保序去重，按 proxy URL） */
export function parseProxyPoolEntries(raw?: string): ProxyPoolEntry[] {
  if (!raw || !String(raw).trim()) return [];
  const seen = new Set<string>();
  const out: ProxyPoolEntry[] = [];
  for (const line of splitProxyPoolText(raw)) {
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

/** 规范化池内去重键：优先 host:port，避免 http://ip:port 与 ip:port 各算一条 */
export function proxyDedupeKey(raw: string): string {
  const entry = parseProxyLine(raw);
  const proxy = entry?.proxy || stripProxyComment(raw) || String(raw || '').trim();
  if (!proxy) return '';
  // 去掉 scheme，统一成 host:port（含 user@）
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) {
      const u = new URL(proxy);
      const auth =
        u.username || u.password
          ? `${decodeURIComponent(u.username)}${u.password ? `:${decodeURIComponent(u.password)}` : ''}@`
          : '';
      return `${auth}${u.hostname}${u.port ? `:${u.port}` : ''}`;
    }
  } catch {
    /* fallthrough */
  }
  return proxy.replace(/^(?:https?|socks5?h?):\/\//i, '');
}

export type AppendProxiesResult = {
  text: string;
  /** 本次新写入行数 */
  added: number;
  /** 因已存在而跳过 */
  skipped: number;
  /** 无法解析而跳过 */
  invalid: number;
};

/**
 * 把代理行追加到池文本（按 host:port 去重；尽量保留带标签的原文行）。
 */
export function appendProxiesToPoolText(
  targetRaw: string,
  proxiesToAdd: string[],
  sourceRaw?: string
): string {
  return appendProxiesToPoolTextDetailed(targetRaw, proxiesToAdd, sourceRaw).text;
}

/** 同 appendProxiesToPoolText，额外返回 added/skipped/invalid 便于 UI 反馈 */
export function appendProxiesToPoolTextDetailed(
  targetRaw: string,
  proxiesToAdd: string[],
  sourceRaw?: string
): AppendProxiesResult {
  const existing = new Set(
    parseProxyPoolEntries(targetRaw).map((e) => proxyDedupeKey(e.proxy) || e.proxy)
  );
  // 原文行：dedupeKey → 带标签的整行
  const sourceLines = new Map<string, string>();
  const feed = (line: string) => {
    const entry = parseProxyLine(line);
    if (!entry) return;
    const k = proxyDedupeKey(entry.proxy) || entry.proxy;
    if (k && !sourceLines.has(k)) sourceLines.set(k, line.trim());
  };
  if (sourceRaw) {
    for (const line of String(sourceRaw).replace(/\r\n/g, '\n').split('\n')) {
      feed(line);
    }
  }
  for (const p of proxiesToAdd) feed(String(p || ''));

  const addLines: string[] = [];
  let skipped = 0;
  let invalid = 0;
  const seenAdd = new Set<string>();

  for (const p of proxiesToAdd) {
    const entry = parseProxyLine(String(p || ''));
    const key = entry
      ? proxyDedupeKey(entry.proxy) || entry.proxy
      : proxyDedupeKey(p) || stripProxyComment(p) || String(p || '').trim();
    if (!key) {
      invalid += 1;
      continue;
    }
    // 必须能解析成代理行，否则写入后 textarea 预览也会丢
    if (!entry && !parseProxyLine(sourceLines.get(key) || key)) {
      invalid += 1;
      continue;
    }
    if (existing.has(key) || seenAdd.has(key)) {
      skipped += 1;
      continue;
    }
    existing.add(key);
    seenAdd.add(key);
    // 优先：source 原文（含国家/协议标签）→ entry.raw → key
    const line =
      sourceLines.get(key) ||
      entry?.raw?.trim() ||
      String(p || '').trim() ||
      key;
    addLines.push(line);
  }

  if (addLines.length === 0) {
    return {
      text: String(targetRaw || '').trim(),
      added: 0,
      skipped,
      invalid
    };
  }
  const base = String(targetRaw || '').trim();
  const stamp = `# 网页导入 ${new Date().toISOString().slice(0, 19).replace('T', ' ')} +${addLines.length}`;
  const block = `${stamp}\n${addLines.join('\n')}`;
  return {
    text: base ? `${base}\n${block}` : block,
    added: addLines.length,
    skipped,
    invalid
  };
}

/**
 * 把代理从「待定」移到「可用」：alive 末尾追加（去重），pending 删除。
 * 返回更新后的两段文本与实际迁移条数。
 */
export function moveProxiesToAlivePool(
  pendingRaw: string,
  aliveRaw: string,
  proxies: string[]
): { proxyPool: string; proxyPoolAlive: string; moved: number } {
  if (!proxies.length) {
    return { proxyPool: pendingRaw, proxyPoolAlive: aliveRaw, moved: 0 };
  }
  const nextAlive = appendProxiesToPoolText(aliveRaw, proxies, pendingRaw);
  const nextPending = removeProxiesFromPoolText(pendingRaw, proxies);
  // 统计真正新增到 alive 的条数（按 URL 集合差）
  const before = new Set(parseProxyPool(aliveRaw));
  const after = new Set(parseProxyPool(nextAlive));
  let moved = 0;
  for (const p of after) {
    if (!before.has(p)) moved += 1;
  }
  return { proxyPool: nextPending, proxyPoolAlive: nextAlive, moved };
}

/**
 * 在可用池文本中给指定代理 +1 成功计数（写入/更新行尾 `#成功N`）。
 * 匹配按 proxyDedupeKey；未命中返回原文本与 bumped=0。
 */
export function bumpProxyRegisterSuccessInPoolText(
  aliveRaw: string,
  proxies: string[],
  delta = 1
): { text: string; bumped: number } {
  const keys = new Set(
    proxies
      .map((p) => proxyDedupeKey(p) || stripProxyComment(p) || String(p || '').trim())
      .filter(Boolean)
  );
  if (keys.size === 0) return { text: String(aliveRaw || ''), bumped: 0 };

  const text = String(aliveRaw || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let bumped = 0;
  const next = lines.map((line) => {
    const entry = parseProxyLine(line);
    if (!entry) return line;
    const k = proxyDedupeKey(entry.proxy) || entry.proxy;
    if (!k || !keys.has(k)) return line;

    const prev =
      parseProxySuccessCount(entry.raw) ||
      parseProxySuccessCount(entry.label) ||
      entry.successCount ||
      0;
    const n = Math.max(0, prev + (Number(delta) || 1));
    bumped += 1;

    let base = line.trim();
    base = base
      .replace(/(?:^|[\s·|/,_-])(?:成功|ok)[:：\s]*\d+\b/gi, ' ')
      .replace(/#(?:成功|ok)[:：]?\d+\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[·\s]+$/g, '')
      .trim();

    const schemeIdx = base.indexOf('://');
    const searchFrom = schemeIdx >= 0 ? schemeIdx + 3 : 0;
    const hashIdx = base.indexOf('#', searchFrom);
    if (hashIdx >= 0) {
      const head = base.slice(0, hashIdx).trimEnd();
      let note = base.slice(hashIdx + 1).trim();
      note = note
        .replace(/(?:^|[\s·|/,_-])(?:成功|ok)[:：\s]*\d+\b/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const merged = note ? `${note} · 成功${n}` : `成功${n}`;
      return `${head}#${merged}`;
    }
    if (/[（(][^）)]*[）)]$/.test(base)) {
      return `${base}#成功${n}`;
    }
    return `${base}#成功${n}`;
  });

  return { text: next.join('\n'), bumped };
}

/**
 * 把代理从「可用」降级到「待定」（注册失败等）。
 * pending 追加（带 #注册失败 备注若无标签），alive 删除。
 */
export function moveProxiesFromAliveToPending(
  pendingRaw: string,
  aliveRaw: string,
  proxies: string[],
  reasonTag = '注册失败'
): { proxyPool: string; proxyPoolAlive: string; moved: number } {
  if (!proxies.length) {
    return { proxyPool: pendingRaw, proxyPoolAlive: aliveRaw, moved: 0 };
  }
  // 尽量保留可用池原文行（含国家标签）
  const aliveLines = String(aliveRaw || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const lineByKey = new Map<string, string>();
  for (const line of aliveLines) {
    const entry = parseProxyLine(line);
    if (!entry) continue;
    const k = proxyDedupeKey(entry.proxy) || entry.proxy;
    if (k && !lineByKey.has(k)) lineByKey.set(k, line.trim());
  }

  const toAdd: string[] = [];
  for (const p of proxies) {
    const entry = parseProxyLine(p) || parseProxyLine(stripProxyComment(p));
    const key = entry
      ? proxyDedupeKey(entry.proxy) || entry.proxy
      : proxyDedupeKey(p) || stripProxyComment(p) || String(p || '').trim();
    if (!key) continue;
    let line = lineByKey.get(key) || entry?.raw?.trim() || String(p || '').trim();
    // 无备注时补降级原因，便于 UI 识别
    if (line && !/#|（|\(/.test(line) && reasonTag) {
      line = `${line}#${reasonTag}`;
    } else if (line && reasonTag && !line.includes(reasonTag)) {
      // 已有标签：行尾追加简短原因（不破坏括号备注）
      if (!line.includes('#')) line = `${line}#${reasonTag}`;
    }
    toAdd.push(line);
  }

  const nextPending = appendProxiesToPoolText(pendingRaw, toAdd, toAdd.join('\n'));
  const nextAlive = removeProxiesFromPoolText(aliveRaw, proxies);
  const before = new Set(
    parseProxyPoolEntries(aliveRaw).map((e) => proxyDedupeKey(e.proxy) || e.proxy)
  );
  const after = new Set(
    parseProxyPoolEntries(nextAlive).map((e) => proxyDedupeKey(e.proxy) || e.proxy)
  );
  let moved = 0;
  for (const k of before) {
    if (!after.has(k)) moved += 1;
  }
  return { proxyPool: nextPending, proxyPoolAlive: nextAlive, moved };
}

/**
 * 注册用代理列表：
 * - 可用池非空 → **只**用可用池（待定池不参与注册）
 * - 可用池为空 → 回退待定池（兼容旧配置/尚未测活）
 */
export function resolveProxyPoolForRuntime(settings: {
  proxyPool?: string;
  proxyPoolAlive?: string;
}): string[] {
  const alive = parseProxyPool(settings.proxyPoolAlive);
  if (alive.length > 0) return alive;
  return parseProxyPool(settings.proxyPool);
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
    !Number.isInteger(s.maxParallelWorkers) ||
    s.maxParallelWorkers < 1 ||
    s.maxParallelWorkers > 8
  )
    errors.maxParallelWorkers = '并行任务上限须在 1 到 8 之间';
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
  // 代理池（待测/可用）允许为空：测活删失败、暂清空后再粘贴都常见；注册启动时再检查
  // 仅「未开池、只开单代理」且单代理也空时提示
  if (s.proxyEnabled && !s.proxyPoolEnabled) {
    if (!s.proxy.trim() && !s.browserProxy.trim()) {
      errors.proxy = '已开启代理，请填写 HTTP 代理或浏览器代理';
    }
  }
  // 确保历史逻辑不会再写入 proxyPool 必填错误
  delete errors.proxyPool;
  return errors;
}
