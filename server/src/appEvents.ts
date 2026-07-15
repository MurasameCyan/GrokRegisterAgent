/**
 * 应用级事件总线：CPA 重登等非 registerBot 任务也可推 WebSocket。
 * index.ts 在创建 WSS 后 setAppEventBroadcast(broadcast)。
 */
import type { RunEvent } from '@shared/runEvents';

type BroadcastFn = (event: RunEvent) => void;

let broadcastFn: BroadcastFn | null = null;

export function setAppEventBroadcast(fn: BroadcastFn | null): void {
  broadcastFn = fn;
}

export function broadcastAppEvent(event: RunEvent): void {
  try {
    broadcastFn?.(event);
  } catch {
    /* ignore */
  }
}
