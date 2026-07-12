import { create } from 'zustand';

interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: 'ok' | 'warn' | 'danger' | 'info';
  /** ms */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id' | 'duration'> & { duration?: number }): void;
  dismiss(id: number): void;
}

let counter = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = ++counter;
    const toast: Toast = {
      id,
      duration: 4000,
      ...t
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => get().dismiss(id), toast.duration);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}));
