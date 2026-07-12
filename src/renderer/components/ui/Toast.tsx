import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';

const toneClasses = {
  ok: 'border-ok/40 bg-card text-foreground',
  warn: 'border-warn/40 bg-card text-foreground',
  danger: 'border-danger/40 bg-card text-foreground',
  info: 'border-info/40 bg-card text-foreground'
} as const;

const Icon = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: AlertCircle,
  info: Info
} as const;

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[60] flex flex-col gap-2 w-80">
      {toasts.map((t) => {
        const I = Icon[t.tone];
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto overflow-hidden rounded-2xl border shadow-lg backdrop-blur',
              toneClasses[t.tone]
            )}
          >
            <div className="shell-bar px-3 py-2">
              <div className="shell-label">{t.tone}</div>
              <button
                onClick={() => dismiss(t.id)}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-start gap-2 px-3 py-3">
              <I className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                {t.description && (
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {t.description}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
