import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 440
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex justify-end transition-opacity duration-200',
        open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
      )}
    >
      <div
        className={cn(
          'absolute inset-0 bg-black/25 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />
      <div
        style={{ width: `min(100vw, ${width}px)` }}
        className={cn(
          'relative flex h-full flex-col border-l border-border bg-card shadow-[var(--ios-shadow)] transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/80 px-4 py-3.5">
          <div className="min-w-0">
            {subtitle && <div className="brand-subtitle">{subtitle}</div>}
            <h3
              className={cn(
                'truncate text-[17px] font-semibold tracking-[-0.02em]',
                subtitle && 'mt-0.5'
              )}
            >
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
