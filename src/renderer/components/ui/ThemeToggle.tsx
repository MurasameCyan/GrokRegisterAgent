import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@shared/settings';
import { useTheme } from '@renderer/theme/ThemeProvider';
import { cn } from '@renderer/lib/cn';

const items: { mode: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { mode: 'light', label: '浅色', Icon: Sun },
  { mode: 'system', label: '跟随系统', Icon: Monitor },
  { mode: 'dark', label: '深色', Icon: Moon }
];

export function ThemeToggle({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="group"
      className={cn(
        'inline-flex flex-nowrap items-center rounded-full bg-muted p-0.5',
        size === 'md' ? 'text-sm' : 'text-xs'
      )}
    >
      {items.map(({ mode: m, label, Icon }) => (
        <button
          key={m}
          title={label}
          onClick={() => setMode(m)}
          className={cn(
            'flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 font-medium transition-colors duration-150',
            m === mode
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden whitespace-nowrap sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
