import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useRunStore } from '@renderer/store/runStore';
import { Button } from '@renderer/components/ui/Button';
import { cn } from '@renderer/lib/cn';

const colorByLevel = {
  /** 注册机常规 stdout（[*] 状态行等）保持蓝色 */
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-danger',
  tip: 'text-tip',
  plain: 'text-foreground',
  stderr: 'text-danger'
} as const;

/** 汇总行：成功绿 / 失败红 / 共计蓝 */
const SUMMARY_RE =
  /^(.*?)(成功\s*[:：]\s*\d+)(.*?)(失败\s*[:：]\s*\d+)(.*?)(共计\s*[:：]\s*\d+)(.*)$/u;

function renderLogText(text: string, levelClass: string) {
  const m = String(text || '').match(SUMMARY_RE);
  if (!m) {
    return <span className={cn('break-all text-[12px]', levelClass)}>{text}</span>;
  }
  const [, pre, okPart, mid1, failPart, mid2, totalPart, post] = m;
  return (
    <span className="break-all text-[12px] font-medium">
      {pre ? <span className={levelClass}>{pre}</span> : null}
      <span className="text-emerald-600 dark:text-emerald-400">{okPart}</span>
      {mid1 ? <span className="text-muted-foreground">{mid1}</span> : null}
      <span className="text-danger">{failPart}</span>
      {mid2 ? <span className="text-muted-foreground">{mid2}</span> : null}
      <span className="text-info">{totalPart}</span>
      {post ? <span className={levelClass}>{post}</span> : null}
    </span>
  );
}

export function LogPanel() {
  const logs = useRunStore((s) => s.logs);
  const focusRunId = useRunStore((s) => s.focusRunId);
  const clearLogs = useRunStore((s) => s.clearLogs);
  const clearLogsFor = useRunStore((s) => s.clearLogsFor);
  const ref = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  /** all = 全部任务混显；focus = 仅当前聚焦 */
  const [scope, setScope] = useState<'focus' | 'all'>('focus');

  const visible = useMemo(() => {
    if (scope === 'all' || !focusRunId) return logs;
    return logs.filter((l) => l.runId === focusRunId);
  }, [logs, focusRunId, scope]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  const copyAll = async () => {
    const text = visible.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const doClear = () => {
    if (scope === 'focus' && focusRunId) clearLogsFor(focusRunId);
    else clearLogs();
  };

  return (
    <div className="ios-group flex h-[min(520px,60vh)] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
        <div>
          <h2 className="text-[20px] font-bold tracking-[-0.02em]">实时日志</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {scope === 'focus' && focusRunId
              ? `仅 #${focusRunId.slice(0, 8)} · ${visible.length} 行`
              : `全部任务 · ${visible.length} 行`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-border bg-muted/50 p-0.5 text-[11px]">
            <button
              type="button"
              className={cn(
                'rounded-full px-2.5 py-1 font-medium transition-colors',
                scope === 'focus' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
              )}
              onClick={() => setScope('focus')}
            >
              聚焦
            </button>
            <button
              type="button"
              className={cn(
                'rounded-full px-2.5 py-1 font-medium transition-colors',
                scope === 'all' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
              )}
              onClick={() => setScope('all')}
            >
              全部
            </button>
          </div>
          <span className={cn('pill', autoScroll ? 'pill-ok' : 'pill-warn')}>
            {autoScroll ? '自动滚动' : '已暂停'}
          </span>
          <Button variant="ghost" size="sm" onClick={copyAll}>
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
          <Button variant="ghost" size="sm" onClick={doClear}>
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
        {visible.length === 0 ? (
          <div className="mt-16 text-center font-sans text-[13px] text-muted-foreground">
            尚无日志。开始注册后将实时显示输出。
          </div>
        ) : (
          visible.map((l) => (
            <div
              key={l.id}
              className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-border/40 py-1.5 last:border-b-0"
            >
              <span className="text-[11px] text-muted-foreground">
                {new Date(l.ts).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false
                })}
              </span>
              <div className="min-w-0">
                {scope === 'all' && (
                  <span className="mr-2 font-mono text-[10px] text-muted-foreground">
                    #{l.runId.slice(0, 6)}
                  </span>
                )}
                {renderLogText(l.text, colorByLevel[l.level] || 'text-foreground')}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
