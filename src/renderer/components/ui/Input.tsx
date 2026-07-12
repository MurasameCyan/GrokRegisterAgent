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
        'flex h-11 w-full rounded-xl border border-input bg-card/85 px-3.5 py-2 font-mono text-sm tracking-[0.01em] transition-colors placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        invalid && 'border-danger focus-visible:ring-danger',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
