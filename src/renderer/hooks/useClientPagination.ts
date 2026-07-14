import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_PAGE_SIZE,
  loadStoredPageSize,
  type PageSize
} from '@renderer/components/ui/PaginationBar';

export type UseClientPaginationResult<T> = {
  /** 用户请求的页码（可能被 total 纠正前的状态由 currentPage 反映） */
  page: number;
  pageSize: PageSize;
  total: number;
  totalPages: number;
  /** 纠正后的当前页（1-based） */
  currentPage: number;
  pageStart: number;
  pageItems: T[];
  rangeFrom: number;
  rangeTo: number;
  setPage: (page: number | ((p: number) => number)) => void;
  changePageSize: (size: PageSize) => void;
  /** 筛选变化时回到第 1 页 */
  resetPage: () => void;
};

/**
 * 客户端列表分页：page / pageSize（localStorage）/ slice / 区间文案。
 * @param items 已筛选后的完整列表
 * @param storageKey 每页条数 localStorage key（如 gra-pool-page-size）
 */
export function useClientPagination<T>(
  items: T[],
  storageKey: string,
  defaultPageSize: PageSize = DEFAULT_PAGE_SIZE
): UseClientPaginationResult<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() =>
    loadStoredPageSize(storageKey, defaultPageSize)
  );

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);

  // 列表变短时纠正页码（不回写 selected 等业务状态）
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;

  const pageItems = useMemo(
    () => items.slice(pageStart, pageStart + pageSize),
    [items, pageStart, pageSize]
  );

  const rangeFrom = total === 0 ? 0 : pageStart + 1;
  const rangeTo = Math.min(pageStart + pageSize, total);

  const changePageSize = useCallback(
    (size: PageSize) => {
      setPageSize(size);
      setPage(1);
      try {
        localStorage.setItem(storageKey, String(size));
      } catch {
        /* ignore */
      }
    },
    [storageKey]
  );

  const resetPage = useCallback(() => setPage(1), []);

  return {
    page,
    pageSize,
    total,
    totalPages,
    currentPage,
    pageStart,
    pageItems,
    rangeFrom,
    rangeTo,
    setPage,
    changePageSize,
    resetPage
  };
}
