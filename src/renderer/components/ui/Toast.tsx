import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';

/** 与主按钮 / 系统蓝一致：成功用 primary，避免另起一套翠绿 */
const toneIcon = {
  ok: 'text-primary',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info'
} as const;

const toneBar = {
  ok: 'bg-primary',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info'
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
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(100vw-2rem,20rem)] flex-col gap-2">
      {toasts.map((t) => {
        const I = Icon[t.tone];
        return (
          <div
            key={t.id}
            className="pointer-events-auto overflow-hidden rounded-[14px] border border-border bg-card shadow-[var(--ios-shadow)]"
          >
            <div className="flex items-stretch">
              <span className={cn('w-1 shrink-0', toneBar[t.tone])} aria-hidden />
              <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3.5 py-3">
                <I className={cn('mt-0.5 h-4 w-4 shrink-0', toneIcon[t.tone])} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold tracking-[-0.01em]">{t.title}</p>
                  {t.description && (
                    <p className="mt-0.5 break-words text-[12px] leading-5 text-muted-foreground">
                      {t.description}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
