import { useState } from 'react';
import { Loader2, PlugZap } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { cn } from '@renderer/lib/cn';
import type { TestResult } from '@shared/runEvents';

export function ConnectionTestButton({
  onTest,
  disabled,
  label = '检测远程连通性'
}: {
  onTest: () => Promise<TestResult & { latencyMs?: number; ms?: number }>;
  disabled?: boolean;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<(TestResult & { latencyMs?: number; ms?: number }) | null>(
    null
  );

  const run = async () => {
    setLoading(true);
    try {
      const r = await onTest();
      setResult(r);
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || loading}
        onClick={() => void run()}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <PlugZap className="h-3.5 w-3.5" />
        )}
        {loading ? '检测中…' : label}
      </Button>
      {result && (
        <span
          className={cn(
            'max-w-full text-[12px] leading-5',
            result.ok ? 'text-ok' : 'text-danger'
          )}
          title={result.message}
        >
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
          {(() => {
            const lat = result.latencyMs ?? result.ms;
            return lat != null ? ` · ${lat}ms` : '';
          })()}
        </span>
      )}
    </div>
  );
}
