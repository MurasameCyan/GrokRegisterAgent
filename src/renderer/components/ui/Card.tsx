import { type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export function Card({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'terminal-card text-card-foreground',
        className
      )}
    >
      {children}
    </div>
  );
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
    <div className="terminal-card-header">
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold leading-none tracking-tight">{title}</h3>
        {description && (
          <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
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
  return <div className={cn('terminal-card-body', className)}>{children}</div>;
}
