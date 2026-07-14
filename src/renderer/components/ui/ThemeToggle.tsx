import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@shared/settings';
import { useTheme } from '@renderer/theme/ThemeProvider';
import { cn } from '@renderer/lib/cn';

const items: {
  mode: ThemeMode;
  label: string;
  Icon: typeof Sun;
  /** 未选中时的图标色 */
  iconClass: string;
  /** 选中底色 + 图标强调色 */
  activeClass: string;
}[] = [
  {
    mode: 'light',
    label: '浅色',
    Icon: Sun,
    iconClass: 'text-amber-500',
    activeClass: 'bg-card text-amber-500 shadow-sm ring-1 ring-amber-500/25'
  },
  {
    mode: 'system',
    label: '系统',
    Icon: Monitor,
    iconClass: 'text-sky-500',
    activeClass: 'bg-card text-sky-500 shadow-sm ring-1 ring-sky-500/25'
  },
  {
    mode: 'dark',
    label: '深色',
    Icon: Moon,
    iconClass: 'text-violet-400',
    activeClass: 'bg-card text-violet-400 shadow-sm ring-1 ring-violet-400/25'
  }
];

export function ThemeToggle({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { mode, setMode } = useTheme();
  const compact = size === 'sm';

  return (
    <div
      role="group"
      aria-label="主题"
      className={cn(
        'grid w-full grid-cols-3 rounded-full bg-muted p-0.5',
        compact ? 'h-8' : 'h-9'
      )}
    >
      {items.map(({ mode: m, label, Icon, iconClass, activeClass }) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            title={label === '系统' ? '跟随系统' : label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => setMode(m)}
            className={cn(
              'inline-flex h-full min-w-0 items-center justify-center rounded-full transition-all duration-150',
              active ? activeClass : cn(iconClass, 'opacity-70 hover:opacity-100')
            )}
          >
            <Icon
              aria-hidden
              className={cn('shrink-0', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')}
              strokeWidth={2.25}
            />
          </button>
        );
      })}
    </div>
  );
}
