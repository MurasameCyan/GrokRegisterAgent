import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

/** 配置卡片标题右侧统一圆形图标壳 */
export function CardHeaderIcon({
  icon: Icon,
  className,
  iconClassName,
  title,
  onClick,
  disabled
}: {
  icon: LucideIcon;
  className?: string;
  iconClassName?: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const shell = cn(
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
    className || 'bg-muted text-muted-foreground'
  );
  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cn(shell, 'disabled:cursor-not-allowed disabled:opacity-50')}
      >
        <Icon className={cn('h-4 w-4', iconClassName)} strokeWidth={2} aria-hidden />
      </button>
    );
  }
  return (
    <span className={shell} title={title}>
      <Icon className={cn('h-4 w-4', iconClassName)} strokeWidth={2} aria-hidden />
    </span>
  );
}
