import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border text-sm font-display uppercase tracking-[0.12em] ring-offset-background transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        primary:
          'border-primary bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:-translate-y-px hover:bg-primary/92',
        secondary:
          'border-border bg-card text-foreground hover:-translate-y-px hover:bg-accent/85',
        ghost: 'border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-accent/70 hover:text-foreground',
        danger: 'border-danger bg-danger text-white hover:-translate-y-px hover:bg-danger/92',
        outline:
          'border-border bg-transparent text-foreground hover:bg-accent/75'
      },
      size: {
        sm: 'h-9 px-3 text-[11px]',
        md: 'h-10 px-4 text-[11px]',
        lg: 'h-12 px-6 text-[12px]',
        icon: 'h-10 w-10'
      }
    },
    defaultVariants: { variant: 'primary', size: 'md' }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = 'Button';
