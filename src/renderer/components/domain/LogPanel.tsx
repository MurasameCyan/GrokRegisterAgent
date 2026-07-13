import { useEffect, useRef, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useRunStore } from '@renderer/store/runStore';
import { Button } from '@renderer/components/ui/Button';
import { cn } from '@renderer/lib/cn';

const colorByLevel = {
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-danger',
  tip: 'text-tip',
  plain: 'text-foreground',
  stderr: 'text-danger'
} as const;

export function LogPanel() {
  const logs = useRunStore((s) => s.logs);
  const clearLogs = useRunStore((s) => s.clearLogs);
  const ref = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  const copyAll = async () => {
    const text = logs.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="terminal-card flex h-[min(520px,60vh)] flex-col overflow-hidden">
      <div className="terminal-card-header">
        <div>
          <div className="brand-subtitle">输出</div>
          <div className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">实时日志</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('status-pill', autoScroll ? 'status-pill-ok' : 'status-pill-warn')}>
            {autoScroll ? '自动滚动' : '已暂停'}
          </span>
          <Button variant="ghost" size="sm" onClick={copyAll}>
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
          <Button variant="ghost" size="sm" onClick={clearLogs}>
            <Trash2 className="h-3.5 w-3.5" />
            清空
          </Button>
        </div>
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        className="console-surface m-3 flex-1 overflow-y-auto px-3 py-2.5 font-mono text-[12px] leading-6"
      >
        {logs.length === 0 ? (
          <div className="mt-16 text-center text-[13px] text-muted-foreground">
            尚无日志。开始注册后将实时显示输出。
          </div>
        ) : (
          logs.map((l) => (
            <div
              key={l.id}
              className="grid grid-cols-[72px_18px_minmax(0,1fr)] gap-3 border-b border-border/40 py-1.5 last:border-b-0"
            >
              <span className="text-[11px] text-muted-foreground">
                {new Date(l.ts).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </span>
              <span className={cn('text-center', colorByLevel[l.level])}>›</span>
              <span className={cn('whitespace-pre-wrap break-words', colorByLevel[l.level])}>
                {l.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
