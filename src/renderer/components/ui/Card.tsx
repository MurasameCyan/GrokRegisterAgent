import { type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export function Card({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('ios-group text-card-foreground', className)}>{children}</div>;
}

export function CardHeader({
  title,
  description,
  right
}: {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.02em]">{title}</h3>
        {description && (
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

export function CardBody({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('p-4', className)}>{children}</div>;
}
