import { type InputHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/cn';

interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: number;
  onValueChange(v: number): void;
  min?: number;
  max?: number;
  step?: number;
}

export function Slider({
  value,
  onValueChange,
  min = 1,
  max = 50,
  step = 1,
  className,
  ...rest
}: SliderProps) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      className={cn(
        'h-2 w-full appearance-none rounded-full bg-muted',
        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-[18px] [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:cursor-pointer',
        className
      )}
      {...rest}
    />
  );
}
