/**
 * 解析当前应使用的 HTTP 代理（单条 settings.proxy 或 CF/sing-box 本地）。
 * 代理池轮换仅注册机 Python 侧使用；Node 出站（验活/Auth）用单条 proxy。
 */
import type { AppSettings } from '@shared/settings';
import { buildCfLocalProxyUrl, buildSingBoxLocalProxyUrl } from '@shared/settings';

/**
 * @param purpose 号池验活 / Auth mint·重签·测活；undefined 时仅看总开关
 */
export function resolveHttpProxy(
  settings: AppSettings,
  purpose?: 'ssoCheck' | 'cpaAuth'
): string {
  // sing-box / CF 独立代理：与普通代理互斥，本地 127.0.0.1:port
  if (settings.singBoxEnabled) {
    if (purpose === 'ssoCheck' && settings.ssoCheckUseProxy === false) return '';
    if (purpose === 'cpaAuth' && settings.cpaAuthUseProxy === false) return '';
    return buildSingBoxLocalProxyUrl(settings);
  }
  if (settings.cfProxyEnabled) {
    if (purpose === 'ssoCheck' && settings.ssoCheckUseProxy === false) return '';
    if (purpose === 'cpaAuth' && settings.cpaAuthUseProxy === false) return '';
    return buildCfLocalProxyUrl(settings);
  }
  if (!settings.proxyEnabled) return '';
  if (purpose === 'ssoCheck' && settings.ssoCheckUseProxy === false) return '';
  if (purpose === 'cpaAuth' && settings.cpaAuthUseProxy === false) return '';
  return String(settings.proxy || '').trim();
}