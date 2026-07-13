import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-[12px] border border-input bg-muted/60 px-3.5 py-2 text-[15px] tracking-[-0.01em] transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50',
        invalid && 'border-danger focus-visible:ring-danger/30',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
