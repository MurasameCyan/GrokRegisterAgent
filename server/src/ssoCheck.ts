/**
 * SSO 验活：用 sso token 作 cookie 请求 grok.com 的用户信息接口。
 * 200 = 存活并返回账户信息；401/403 = 失效。请求走 settings.proxy。
 * 额外解码 JWT 中的 bot_flag_source（只读）。
 */
import { proxiedRequest } from './httpClient.js';
import { readBotFlagFromToken } from './jwtBotFlag.js';

const GET_USER_URL = 'https://grok.com/rest/auth/get-user';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface SsoCheckOutcome {
  alive: boolean;
  status: number;
  email?: string;
  givenName?: string;
  familyName?: string;
  emailConfirmed?: boolean;
  sessionTierId?: string;
  createTime?: string;
  error?: string;
  /** JWT claim bot_flag_source（可能为 null） */
  botFlagSource?: number | string | null;
  /** bot_flag_source === 1 */
  isBotFlag1?: boolean;
}

export async function checkSso(sso: string, proxy?: string): Promise<SsoCheckOutcome> {
  const token = (sso || '').replace(/^sso=/, '').trim();
  if (!token) return { alive: false, status: 0, error: '缺少 sso token' };

  const flag = readBotFlagFromToken(token);

  try {
    const res = await proxiedRequest(GET_USER_URL, {
      headers: {
        Cookie: `sso=${token}; sso-rw=${token}`,
        'User-Agent': UA,
        Accept: 'application/json'
      },
      proxy
    });

    if (res.status === 200) {
      const u = res.data as Record<string, unknown>;
      return {
        alive: true,
        status: 200,
        email: typeof u.email === 'string' ? u.email : undefined,
        givenName: typeof u.givenName === 'string' ? u.givenName : undefined,
        familyName: typeof u.familyName === 'string' ? u.familyName : undefined,
        emailConfirmed: typeof u.emailConfirmed === 'boolean' ? u.emailConfirmed : undefined,
        sessionTierId: u.sessionTierId != null ? String(u.sessionTierId) : undefined,
        createTime: typeof u.createTime === 'string' ? u.createTime : undefined,
        botFlagSource: flag.botFlagSource,
        isBotFlag1: flag.isBotFlag1
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        alive: false,
        status: res.status,
        botFlagSource: flag.botFlagSource,
        isBotFlag1: flag.isBotFlag1
      };
    }

    return {
      alive: false,
      status: res.status,
      error: `grok 返回 HTTP ${res.status}`,
      botFlagSource: flag.botFlagSource,
      isBotFlag1: flag.isBotFlag1
    };
  } catch (e) {
    return {
      alive: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
      botFlagSource: flag.botFlagSource,
      isBotFlag1: flag.isBotFlag1
    };
  }
}
