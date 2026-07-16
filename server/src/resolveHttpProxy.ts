/**
 * 解析当前应使用的 HTTP 代理（仅 sing-box 本地，或直连）。
 * 普通代理 / CF 独立代理已移除。
 */
import type { AppSettings } from '@shared/settings';
import { buildSingBoxLocalProxyUrl } from '@shared/settings';

/**
 * @param purpose 号池验活 / Auth mint·重签·测活；undefined 时仅看总开关
 */
export function resolveHttpProxy(
  settings: AppSettings,
  purpose?: 'ssoCheck' | 'cpaAuth'
): string {
  if (!settings.singBoxEnabled) return '';
  if (purpose === 'ssoCheck' && settings.ssoCheckUseProxy === false) return '';
  if (purpose === 'cpaAuth' && settings.cpaAuthUseProxy === false) return '';
  return buildSingBoxLocalProxyUrl(settings);
}
