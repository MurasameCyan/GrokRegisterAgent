import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export type FilterSegmentOption<T extends string> = {
  id: T;
  label: string;
  count?: number;
  title?: string;
  /** 选中时的强调色；默认 primary */
  tone?: 'primary' | 'ok' | 'danger' | 'warn' | 'muted';
};

const activeTone: Record<NonNullable<FilterSegmentOption<string>['tone']>, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm',
  ok: 'bg-emerald-600 text-white shadow-sm',
  danger: 'bg-destructive text-destructive-foreground shadow-sm',
  warn: 'bg-amber-600 text-white shadow-sm',
  muted: 'bg-slate-600 text-white shadow-sm'
};

/**
 * 列表筛选：左侧主色标签 + 分段胶囊轨（SSO / Auth 共用）
 */
export function FilterSegmentGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  className
}: {
  label: string;
  options: readonly FilterSegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="shrink-0 text-[10px] font-semibold tracking-wide text-primary">
        {label}
      </span>
      <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border border-border/70 bg-background/80 p-0.5">
        {options.map((tab) => {
          const active = value === tab.id;
          const tone = tab.tone || 'primary';
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              title={tab.title}
              className={cn(
                'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                active
                  ? activeTone[tone]
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {tab.label}
              {tab.count != null && (
                <span className="ml-1 tabular-nums opacity-80">{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 筛选区外层：多组横排 + 清空 */
export function FilterBar({
  children,
  hasActive,
  onClear,
  className
}: {
  children: ReactNode;
  hasActive?: boolean;
  onClear?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/25 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2">
        {children}
      </div>
      {hasActive && onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 self-start rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:bg-muted hover:text-foreground hover:underline sm:self-center"
        >
          清空筛选
        </button>
      ) : null}
    </div>
  );
}
