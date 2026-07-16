import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Shield } from 'lucide-react';
import { CardHeaderIcon } from '@renderer/components/domain/CardHeaderIcon';
import { cn } from '@renderer/lib/cn';

type Tone = 'idle' | 'loading' | 'ok' | 'bad';

/**
 * 外置 Turnstile Solver 探活图标。
 * - 黄：未启用 / 未测
 * - 绿：可达
 * - 红：启用但不可达
 */
export function TurnstileSolverIcon({
  enabled,
  url
}: {
  enabled: boolean;
  url: string;
}) {
  const [tone, setTone] = useState<Tone>('idle');
  const [message, setMessage] = useState('未检测');
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (!enabled) {
      setTone('idle');
      setMessage('未启用外置 Solver');
      return;
    }
    const id = ++seq.current;
    setTone('loading');
    setMessage('检测中…');
    try {
      const r = await window.api.testTurnstileSolver({
        enabled: true,
        url: String(url || '').trim() || undefined
      });
      if (id !== seq.current) return;
      if (r?.ok) {
        setTone('ok');
        const ms =
          typeof r.latencyMs === 'number' ? ` · ${r.latencyMs}ms` : '';
        setMessage((r.message || '连通正常') + ms);
      } else {
        setTone('bad');
        setMessage(r?.message || '连通失败');
      }
    } catch (err) {
      if (id !== seq.current) return;
      setTone('bad');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [enabled, url]);

  useEffect(() => {
    if (!enabled) {
      setTone('idle');
      setMessage('未启用外置 Solver');
      return;
    }
    const t = window.setTimeout(() => {
      void run();
    }, 600);
    return () => window.clearTimeout(t);
  }, [enabled, url, run]);

  const shell =
    tone === 'ok'
      ? 'bg-ok/15 text-ok hover:bg-ok/25'
      : tone === 'bad'
        ? 'bg-danger/15 text-danger hover:bg-danger/25'
        : tone === 'loading'
          ? 'bg-muted text-muted-foreground'
          : 'bg-warn/15 text-warn hover:bg-warn/25';

  const title =
    tone === 'loading'
      ? 'Turnstile Solver 检测中…'
      : tone === 'ok'
        ? `Solver 可达 · ${message}`
        : tone === 'bad'
          ? `Solver 不可达 · ${message}`
          : `Solver 未启用/未测 · ${message}（点击重试）`;

  return (
    <CardHeaderIcon
      icon={tone === 'loading' ? Loader2 : Shield}
      className={cn(shell)}
      iconClassName={tone === 'loading' ? 'animate-spin' : undefined}
      title={title}
      onClick={() => void run()}
      disabled={tone === 'loading'}
    />
  );
}
