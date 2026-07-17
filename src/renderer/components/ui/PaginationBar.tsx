import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { cn } from '@renderer/lib/cn';

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500, 1000, 2000] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 20;

export function isPageSize(n: number): n is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n);
}

/** 从 localStorage 读取每页条数，非法值回退默认 */
export function loadStoredPageSize(storageKey: string, fallback: PageSize = DEFAULT_PAGE_SIZE): PageSize {
  try {
    const raw = Number(localStorage.getItem(storageKey));
    if (isPageSize(raw)) return raw;
  } catch {
    /* ignore */
  }
  return fallback;
}

export type PaginationBarProps = {
  page: number;
  totalPages: number;
  rangeFrom: number;
  rangeTo: number;
  total: number;
  pageSize: PageSize;
  onChange(page: number): void;
  onPageSizeChange(size: PageSize): void;
};

/** 分页按钮：图标+文字作为整体居中，两侧对称 min-width，避免视觉偏左 */
const pageBtnClass =
  'min-w-[5.75rem] gap-1 px-2.5 leading-none [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0';

export function PaginationBar({
  page,
  totalPages,
  rangeFrom,
  rangeTo,
  total,
  pageSize,
  onChange,
  onPageSizeChange
}: PaginationBarProps) {
  return (
    <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
      <p className="text-center text-[12px] leading-none text-muted-foreground sm:text-left">
        {total === 0 ? '共 0 条' : `第 ${rangeFrom}–${rangeTo} 条 · 共 ${total} 条`}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1.5 sm:justify-end">
        <label className="inline-flex h-9 items-center gap-1.5 text-[12px] leading-none text-muted-foreground">
          <span className="shrink-0">每页</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
            className="h-8 rounded-full border border-border bg-card px-2.5 text-[12px] font-medium leading-none text-foreground outline-none focus:border-primary"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          size="sm"
          className={cn(pageBtnClass)}
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1 || totalPages <= 1}
        >
          <ChevronLeft aria-hidden />
          <span>上一页</span>
        </Button>
        <span
          className="inline-flex h-9 min-w-[4.5rem] items-center justify-center text-center text-[13px] font-medium leading-none tabular-nums"
          aria-current="page"
        >
          {page} / {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className={cn(pageBtnClass)}
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages || totalPages <= 1}
        >
          <span>下一页</span>
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}
