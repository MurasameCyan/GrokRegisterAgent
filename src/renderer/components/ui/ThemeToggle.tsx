import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@shared/settings';
import { useTheme } from '@renderer/theme/ThemeProvider';
import { cn } from '@renderer/lib/cn';

const items: { mode: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { mode: 'light', label: '浅色', Icon: Sun },
  { mode: 'system', label: '系统', Icon: Monitor },
  { mode: 'dark', label: '深色', Icon: Moon }
];

export function ThemeToggle({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { mode, setMode } = useTheme();
  const compact = size === 'sm';

  return (
    <div
      role="group"
      className={cn(
        'grid w-full grid-cols-3 rounded-full bg-muted p-0.5',
        compact ? 'h-8' : 'h-9'
      )}
    >
      {items.map(({ mode: m, label, Icon }) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            title={label === '系统' ? '跟随系统' : label}
            onClick={() => setMode(m)}
            className={cn(
              'inline-flex h-full min-w-0 items-center justify-center gap-1 rounded-full px-1.5 font-medium leading-none transition-colors duration-150',
              compact ? 'text-[11px]' : 'text-[12px]',
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon
              aria-hidden
              className={cn('shrink-0', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')}
              strokeWidth={2}
            />
            <span className="truncate leading-none">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
