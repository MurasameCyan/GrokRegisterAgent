/** 统一把 ISO 时间显示为 UTC+8 北京时间 */

const TZ = 'Asia/Shanghai';

/** 完整日期时间，如 2026-06-07 22:49:00 */
export function fmtBeijing(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('zh-CN', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {})
  });
}

/** 仅时分秒，如 22:49:00 */
export function fmtBeijingTime(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('zh-CN', {
    timeZone: TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {})
  });
}

/** 当前北京时间字符串 */
export function nowBeijing(withSeconds = true): string {
  return fmtBeijing(new Date().toISOString(), withSeconds);
}
