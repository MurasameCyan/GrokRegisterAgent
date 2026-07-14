import type { MouseEvent as ReactMouseEvent } from 'react';
import { cn } from '@renderer/lib/cn';

type SwitchSize = 'sm' | 'md';

const sizeMap: Record<
  SwitchSize,
  { track: string; thumb: string; thumbOn: string }
> = {
  sm: {
    track: 'h-5 w-9',
    thumb: 'h-4 w-4',
    thumbOn: 'translate-x-4'
  },
  md: {
    track: 'h-6 w-11',
    thumb: 'h-5 w-5',
    thumbOn: 'translate-x-5'
  }
};

export function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  className,
  title,
  'aria-label': ariaLabel,
  onClick
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: SwitchSize;
  className?: string;
  title?: string;
  'aria-label'?: string;
  /** 如需阻止冒泡（卡片点击） */
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const s = sizeMap[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (disabled) return;
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-all duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-45',
        s.track,
        checked
          ? 'bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_2px_8px_hsl(var(--primary)/0.35)]'
          : 'bg-muted-foreground/25 shadow-inner dark:bg-muted-foreground/20',
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22),0_0_0_1px_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out',
          s.thumb,
          checked ? s.thumbOn : 'translate-x-0'
        )}
      />
    </button>
  );
}
