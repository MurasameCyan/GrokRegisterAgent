import { Children, cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

export function Card({
  className,
  children,
  /** 可折叠：点击标题栏展开/收起 */
  collapsible = false,
  /** 默认折叠（仅 collapsible 时有效） */
  defaultCollapsed = true,
  open: openControlled,
  onOpenChange
}: {
  className?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openInternal, setOpenInternal] = useState(!defaultCollapsed);
  const open = openControlled ?? openInternal;
  const setOpen = (v: boolean) => {
    if (openControlled === undefined) setOpenInternal(v);
    onOpenChange?.(v);
  };

  if (!collapsible) {
    return <div className={cn('ios-group text-card-foreground', className)}>{children}</div>;
  }

  return (
    <div className={cn('ios-group text-card-foreground', className)} data-open={open ? '1' : '0'}>
      {Children.map(children, (child, i) => {
        if (!isValidElement(child)) return child;
        const type = child.type as { displayName?: string; name?: string };
        const name = type?.displayName || type?.name || '';
        if (name === 'CardHeader') {
          return cloneElement(child as ReactElement<Record<string, unknown>>, {
            collapsible: true,
            open,
            onToggle: () => setOpen(!open)
          });
        }
        if (name === 'CardBody') {
          if (!open) return null;
          return child;
        }
        if (!open && i > 0) return null;
        return child;
      })}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  right,
  collapsible,
  open,
  onToggle
}: {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const chevron = collapsible ? (
    open ? (
      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
    ) : (
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
    )
  ) : null;

  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 px-4 py-3.5',
        (open || !collapsible) && 'border-b border-border/70',
        collapsible && 'cursor-pointer select-none hover:bg-muted/30'
      )}
      role={collapsible ? 'button' : undefined}
      tabIndex={collapsible ? 0 : undefined}
      onClick={collapsible ? onToggle : undefined}
      onKeyDown={
        collapsible
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {chevron}
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.02em]">{title}</h3>
          {description && (
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {right && (
        <div
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {right}
        </div>
      )}
    </div>
  );
}
CardHeader.displayName = 'CardHeader';

export function CardBody({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('p-4', className)}>{children}</div>;
}
CardBody.displayName = 'CardBody';
