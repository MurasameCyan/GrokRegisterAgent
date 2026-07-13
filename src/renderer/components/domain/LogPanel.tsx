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
    <div className="ios-group flex h-[min(520px,60vh)] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
        <h2 className="text-[20px] font-bold tracking-[-0.02em]">实时日志</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('pill', autoScroll ? 'pill-ok' : 'pill-warn')}>
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
        className="log-surface m-3 flex-1 overflow-y-auto px-3 py-2.5 leading-6"
      >
        {logs.length === 0 ? (
          <div className="mt-16 text-center font-sans text-[13px] text-muted-foreground">
            尚无日志。开始注册后将实时显示输出。
          </div>
        ) : (
          logs.map((l) => (
            <div
              key={l.id}
              className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-border/40 py-1.5 last:border-b-0"
            >
              <span className="text-[11px] text-muted-foreground">
                {new Date(l.ts).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </span>
              <span className={cn('whitespace-pre-wrap break-words', colorByLevel[l.level])}>
                <LogText text={l.text} />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 汇总行：成功绿 / 失败红 / 共计蓝 */
function LogText({ text }: { text: string }) {
  const m = text.match(/成功:\s*(\d+)\s+失败:\s*(\d+)\s+共计:\s*(\d+)/);
  if (!m) return <>{text}</>;
  const before = text.slice(0, m.index);
  const after = text.slice((m.index ?? 0) + m[0].length);
  return (
    <>
      {before}
      <span className="font-semibold text-ok">成功: {m[1]}</span>
      <span className="text-muted-foreground">{'  '}</span>
      <span className="font-semibold text-danger">失败: {m[2]}</span>
      <span className="text-muted-foreground">{'  '}</span>
      <span className="font-semibold text-info">共计: {m[3]}</span>
      {after}
    </>
  );
}
