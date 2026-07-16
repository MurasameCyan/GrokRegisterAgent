import { useEffect, useMemo, useState } from 'react';
import {
  Layers,
  Play,
  Save,
  StopCircle,
  TriangleAlert
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { LiveProgressBar, liveProgressPercent } from '@renderer/components/ui/LiveProgressBar';
import { Slider } from '@renderer/components/ui/Slider';
import { StatusCard } from '@renderer/components/domain/StatusCard';
import { LogPanel } from '@renderer/components/domain/LogPanel';
import { JobListPanel } from '@renderer/components/domain/JobListPanel';
import { useRunStore } from '@renderer/store/runStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AppSettings } from '@shared/settings';

export function RegisterPage({ onOpenSettings }: { onOpenSettings(): void }) {
  const status = useRunStore((s) => s.status);
  const jobsActive = useRunStore((s) => s.jobsActive);
  const settings = useSettingsStore((s) => s.data);
  const push = useToastStore((s) => s.push);
  const running = status.phase === 'starting' || status.phase === 'running';
  const maxParallel = settings?.maxParallelWorkers ?? 3;
  const canStartMore = jobsActive < maxParallel;
  const progress = liveProgressPercent({
    success: status.success,
    failed: status.failed,
    current: status.current,
    total: status.total || settings?.runCount || 0
  });

  const ready = useMemo(
    () =>
      !!settings?.mail.apiBase &&
      !!settings?.mail.adminAuth &&
      !!(settings?.mail.domain || settings?.mailDomains?.trim()),
    [settings]
  );

  const start = async () => {
    try {
      const r = await window.api.startRegister({});
      push({
        tone: 'ok',
        title: jobsActive > 0 ? '已再开一路' : '已启动',
        description: `任务 #${r.runId.slice(0, 8)} · 活跃将至 ${Math.min(jobsActive + 1, maxParallel)}/${maxParallel}`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '启动失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const stop = async () => {
    if (!status.runId) {
      await window.api.stopRegister(undefined);
      return;
    }
    await window.api.stopRegister(status.runId);
  };

  const stopAll = async () => {
    try {
      const r = await window.api.stopRegister(undefined, { stopAll: true });
      push({
        tone: 'ok',
        title: '已停止全部',
        description: `${r.stopped?.length ?? 0} 个任务`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '停止失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  return (
    <div className="space-y-5">
      {/* 左：实时状态（含运行设置）；右：任务列表加高；两列等高拉伸 */}
      <div className="grid items-stretch gap-4 lg:grid-cols-[1.3fr_0.9fr]">
        <section className="ios-group flex h-full min-h-[520px] flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3.5">
            <div>
              <h2 className="text-[20px] font-bold tracking-[-0.02em]">实时状态</h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                并行活跃 {jobsActive}/{maxParallel}
                {status.runId ? ` · 聚焦 #${status.runId.slice(0, 8)}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {jobsActive > 0 && (
                <Button variant="secondary" size="md" onClick={() => void stopAll()}>
                  <StopCircle className="h-4 w-4" />
                  全部停止
                </Button>
              )}
              {running && status.runId ? (
                <Button variant="danger" size="md" onClick={() => void stop()}>
                  <StopCircle className="h-4 w-4" />
                  停止当前
                </Button>
              ) : null}
              <Button
                size="md"
                onClick={() => void start()}
                disabled={!ready || !canStartMore}
                title={
                  !canStartMore
                    ? `已达并行上限 ${maxParallel}`
                    : jobsActive > 0
                      ? '再开一路并行注册'
                      : '开始注册'
                }
              >
                {jobsActive > 0 ? <Layers className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {!canStartMore
                  ? `已满 ${maxParallel}`
                  : jobsActive > 0
                    ? '再开一路'
                    : '开始'}
              </Button>
            </div>
          </div>
          <div className="flex flex-1 flex-col space-y-4 p-4">
            <StatusCard status={status} />

            <div className="rounded-xl border border-border/60 bg-card/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="field-label">进度（聚焦任务）</div>
                  <div className="mt-1 text-[13px] text-muted-foreground">
                    成功 {status.success} / 计划 {status.total || settings?.runCount || 0}
                  </div>
                </div>
                <div className="text-[22px] font-bold tabular-nums tracking-tight">{progress}%</div>
              </div>
              <div className="mt-3">
                <LiveProgressBar
                  value={progress}
                  active={running}
                  height="md"
                />
              </div>
            </div>

            {!ready && (
              <div className="rounded-xl bg-warn/10 p-4 text-[13px] leading-5 text-warn">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>启动前请到「配置」页补齐邮箱后端与域名（或域名池）。</span>
                </div>
                <Button className="mt-3" variant="secondary" size="sm" onClick={onOpenSettings}>
                  打开配置
                </Button>
              </div>
            )}

            {/* 原「运行设置」合并进实时状态 */}
            <RuntimeSettingsInline />
            <AuthQueueMetricsCard />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoBox label="轮数" value={String(settings?.runCount ?? '--')} />
              <InfoBox label="并行上限" value={String(maxParallel)} />
              <InfoBox
                label="代理"
                value={settings?.singBoxEnabled === true ? 'Sing-Box' : '直连'}
              />
              <InfoBox label="活跃任务" value={`${jobsActive} / ${maxParallel}`} />
            </div>
          </div>
        </section>

        <div className="flex h-full min-h-0 flex-col">
          <JobListPanel maxParallel={maxParallel} tall />
        </div>
      </div>

      <LogPanel />
    </div>
  );
}

/** 轮数 / 并行上限：嵌在实时状态卡内，不再单独成卡 */
function RuntimeSettingsInline() {
  const data = useSettingsStore((s) => s.data);
  const reload = useSettingsStore((s) => s.reload);
  const push = useToastStore((s) => s.push);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (!draft) {
    return (
      <div className="rounded-xl border border-border bg-card/80 p-3 text-[13px] text-muted-foreground shadow-[var(--ios-shadow)]">
        正在加载运行参数…
      </div>
    );
  }

  const dirty =
    !!data &&
    (data.runCount !== draft.runCount ||
      data.maxParallelWorkers !== draft.maxParallelWorkers);
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    try {
      const next = {
        ...data!,
        runCount: draft.runCount,
        maxParallelWorkers: draft.maxParallelWorkers
      };
      await window.api.saveSettings(next);
      await reload();
      push({ tone: 'ok', title: '运行参数已保存' });
    } catch (err) {
      push({ tone: 'danger', title: '保存失败', description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/80 p-3.5 shadow-[var(--ios-shadow)]">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold tracking-[-0.02em]">运行设置</div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            保存后下次启动生效
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="shrink-0"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-muted/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="field-label">轮数（每路）</div>
            <span className="chip tabular-nums">{draft.runCount}</span>
          </div>
          <div className="mt-2">
            <Slider
              min={1}
              max={50}
              value={draft.runCount}
              onValueChange={(v) => update('runCount', v)}
            />
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="field-label">并行上限</div>
            <span className="chip tabular-nums">{draft.maxParallelWorkers ?? 3}</span>
          </div>
          <div className="mt-2">
            <Slider
              min={1}
              max={8}
              value={draft.maxParallelWorkers ?? 3}
              onValueChange={(v) => update('maxParallelWorkers', v)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-3.5">
      <div className="field-label">{label}</div>
      <div className="mt-1.5 break-all text-[13px] font-medium">{value}</div>
    </div>
  );
}

/** 授权队列 metrics（pending / workers / done） */
function AuthQueueMetricsCard() {
  const [m, setM] = useState<{
    pending?: number;
    queue_size?: number;
    done_ok?: number;
    done_fail?: number;
    workers?: number;
    queue_max?: number;
    updated_iso?: string;
    stale?: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const api = window.api as {
          getAuthQueueMetrics?: () => Promise<Record<string, unknown>>;
        };
        if (!api.getAuthQueueMetrics) return;
        const r = await api.getAuthQueueMetrics();
        if (!cancelled && r) setM(r as typeof m);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const pending = m?.pending ?? m?.queue_size ?? 0;
  const workers = m?.workers ?? 0;
  const ok = m?.done_ok ?? 0;
  const fail = m?.done_fail ?? 0;
  const qmax = m?.queue_max ?? 0;

  return (
    <div className="rounded-xl border border-border bg-card/80 p-3.5 shadow-[var(--ios-shadow)]">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold tracking-[-0.02em]">
          授权队列
        </div>
        <span className="text-[10px] text-muted-foreground">
          {m?.stale
            ? '暂无运行中数据'
            : m?.updated_iso
              ? `更新 ${String(m.updated_iso).slice(11, 19)}`
              : '—'}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-border/50 bg-muted/50 px-2.5 py-2">
          <div className="text-[10px] text-muted-foreground">排队</div>
          <div className="text-[15px] font-semibold tabular-nums">{pending}</div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/50 px-2.5 py-2">
          <div className="text-[10px] text-muted-foreground">Workers</div>
          <div className="text-[15px] font-semibold tabular-nums">
            {workers}
            {qmax ? (
              <span className="text-[11px] font-normal text-muted-foreground">
                {' '}
                / max{qmax}
              </span>
            ) : null}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/50 px-2.5 py-2">
          <div className="text-[10px] text-muted-foreground">成功</div>
          <div className="text-[15px] font-semibold tabular-nums text-emerald-600">
            {ok}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-muted/50 px-2.5 py-2">
          <div className="text-[10px] text-muted-foreground">失败</div>
          <div className="text-[15px] font-semibold tabular-nums text-amber-600">
            {fail}
          </div>
        </div>
      </div>
    </div>
  );
}
