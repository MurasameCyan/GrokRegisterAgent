import { useCallback, useEffect } from 'react';
import { Loader2, Network, Unplug } from 'lucide-react';
import { CardHeaderIcon } from '@renderer/components/domain/CardHeaderIcon';
import { cn } from '@renderer/lib/cn';
import type { SingBoxStatus } from '@shared/ipc';

/**
 * 代理卡片右侧状态图标：
 * - 直连：永远绿（Unplug）
 * - Sing-Box：绿=运行中 / 黄=已开未运行或状态未知 / 红=lastError 或异常
 * 点图标可刷新 sing-box 状态（直连时仅提示）。
 */
export function ProxyModeIcon({
  singBoxEnabled,
  status,
  onRefresh
}: {
  singBoxEnabled: boolean;
  status: SingBoxStatus | null;
  onRefresh?: () => void | Promise<void>;
}) {
  const refresh = useCallback(() => {
    if (onRefresh) void onRefresh();
  }, [onRefresh]);

  // 切到 Sing-Box 时拉一次状态
  useEffect(() => {
    if (singBoxEnabled) refresh();
  }, [singBoxEnabled, refresh]);

  if (!singBoxEnabled) {
    return (
      <CardHeaderIcon
        icon={Unplug}
        className="bg-ok/15 text-ok"
        title="直连 · 不经本地代理"
      />
    );
  }

  const running = status?.running === true;
  const err = String(status?.lastError || '').trim();
  const loading = status === null;

  let shell = 'bg-warn/15 text-warn hover:bg-warn/25';
  let title = 'Sing-Box · 未运行（保存设置后自动启停，或点此刷新）';
  let Icon = Network;

  if (loading) {
    shell = 'bg-muted text-muted-foreground';
    title = 'Sing-Box · 状态读取中…';
    Icon = Loader2;
  } else if (err && !running) {
    shell = 'bg-danger/15 text-danger hover:bg-danger/25';
    title = `Sing-Box · 异常 ${err}`;
  } else if (running) {
    shell = 'bg-ok/15 text-ok hover:bg-ok/25';
    title = `Sing-Box · 运行中${status?.pid != null ? ` pid ${status.pid}` : ''}${
      status?.selectedName || status?.selected
        ? ` · ${status.selectedName || status.selected}`
        : ''
    }`;
  } else if (err) {
    // running but had error string — still show yellow/red soft
    shell = 'bg-warn/15 text-warn hover:bg-warn/25';
    title = `Sing-Box · ${err}`;
  }

  return (
    <CardHeaderIcon
      icon={Icon}
      className={cn(shell)}
      iconClassName={loading ? 'animate-spin' : undefined}
      title={title}
      onClick={refresh}
    />
  );
}
