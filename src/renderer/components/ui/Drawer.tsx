import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 480
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
        'fixed inset-0 z-50 flex justify-end transition-opacity',
        open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
      )}
    >
      <div
        className={cn(
          'absolute inset-0 bg-foreground/30 backdrop-blur-sm transition-opacity',
          open ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />
      <div
        style={{ width }}
        className={cn(
          'relative h-full border-l border-border bg-card shadow-2xl flex flex-col transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="shell-bar">
          <div className="min-w-0">
            {subtitle && <div className="terminal-title">{subtitle}</div>}
            <h3 className={cn('max-w-[24rem] truncate text-base font-semibold', subtitle && 'mt-1')}>
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
