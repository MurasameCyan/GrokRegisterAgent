import { useState, type ReactNode } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import type { TestResult } from '@shared/runEvents';
import { cn } from '@renderer/lib/cn';

export function ConnectionTestButton({
  label = '测试连接',
  onTest,
  disabled
}: {
  label?: string;
  onTest(): Promise<TestResult>;
  disabled?: boolean;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const click = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await onTest();
      setResult(r);
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={click} disabled={disabled || busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : result?.ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
        ) : result && !result.ok ? (
          <AlertCircle className="h-3.5 w-3.5 text-danger" />
        ) : null}
        {label}
      </Button>
      {result && (
        <span
          className={cn(
            'font-mono text-[11px]',
            result.ok ? 'text-ok' : 'text-danger'
          )}
          title={result.message}
        >
          {result.ms != null && result.ok ? `${result.message} · ${result.ms}ms` : result.message}
        </span>
      )}
    </div>
  );
}
