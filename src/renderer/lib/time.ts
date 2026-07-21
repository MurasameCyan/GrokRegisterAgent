/** 统一把 ISO 时间显示为 UTC+8 北京时间 */

const TZ = 'Asia/Shanghai';

/** 完整日期时间，如 2026-06-07 22:49:00（locale 可能带 /） */
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

/**
 * 纯数字日期时间：`2026-07-21 08:45:57`（UTC+8）。
 * 去掉 ISO 的 T/Z 与 locale 多余符号，适合表格窄列。
 */
export function fmtBeijingPlain(
  iso: string | null | undefined,
  withSeconds = true
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // 已是本地可读串则尽量规整；否则原样
    const s = String(iso).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(s)) {
      return s
        .replace('T', ' ')
        .replace(/Z$/i, '')
        .replace(/\.\d+/, '')
        .slice(0, withSeconds ? 19 : 16);
    }
    return s || '—';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
    hour12: false
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = withSeconds
    ? `${get('hour')}:${get('minute')}:${get('second')}`
    : `${get('hour')}:${get('minute')}`;
  return `${date} ${time}`;
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
