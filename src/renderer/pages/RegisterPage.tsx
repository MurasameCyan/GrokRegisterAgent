import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Play, Save, SlidersHorizontal, StopCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { Slider } from '@renderer/components/ui/Slider';
import { StatusCard } from '@renderer/components/domain/StatusCard';
import { LogPanel } from '@renderer/components/domain/LogPanel';
import { useRunStore } from '@renderer/store/runStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AppSettings } from '@shared/settings';

export function RegisterPage({ onOpenSettings }: { onOpenSettings(): void }) {
  const status = useRunStore((s) => s.status);
  const settings = useSettingsStore((s) => s.data);
  const push = useToastStore((s) => s.push);
  const running = status.phase === 'starting' || status.phase === 'running';
  const progress =
    status.total > 0 ? Math.min(100, Math.round((status.success / status.total) * 100)) : 0;

  const ready = useMemo(
    () =>
      !!settings?.mail.apiBase &&
      !!settings?.mail.adminAuth &&
      !!(settings?.mail.domain || settings?.mailDomains?.trim()),
    [settings]
  );

  const start = async () => {
    try {
      await window.api.startRegister({});
    } catch (err) {
      push({
        tone: 'danger',
        title: '启动失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const stop = async () => {
    if (!status.runId) return;
    await window.api.stopRegister(status.runId);
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.9fr]">
        <section className="ios-group">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
            <h2 className="text-[20px] font-bold tracking-[-0.02em]">实时状态</h2>
            {running ? (
              <Button variant="danger" size="md" onClick={stop}>
                <StopCircle className="h-4 w-4" />
                停止
              </Button>
            ) : (
              <Button size="md" onClick={start} disabled={!ready}>
                <Play className="h-4 w-4" />
                开始
              </Button>
            )}
          </div>
          <div className="space-y-4 p-4">
            <StatusCard status={status} />

            <div className="rounded-xl bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="field-label">进度</div>
                  <div className="mt-1 text-[13px] text-muted-foreground">
                    成功 {status.success} / 计划 {status.total || settings?.runCount || 0}
                  </div>
                </div>
                <div className="text-[22px] font-bold tabular-nums tracking-tight">{progress}%</div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
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

            <div className="grid gap-3 sm:grid-cols-2">
              <InfoBox label="轮数" value={String(settings?.runCount ?? '--')} />
              <InfoBox
                label="代理"
                value={
                  settings?.proxyPool?.trim()
                    ? '代理池'
                    : settings?.proxy || '直接连接'
                }
              />
            </div>
          </div>
        </section>

        <RuntimeSettingsPanel onOpenSettings={onOpenSettings} />
      </div>

      <LogPanel />
    </div>
  );
}

function RuntimeSettingsPanel({ onOpenSettings }: { onOpenSettings(): void }) {
  const data = useSettingsStore((s) => s.data);
  const reload = useSettingsStore((s) => s.reload);
  const push = useToastStore((s) => s.push);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (!draft) {
    return (
      <section className="ios-group">
        <div className="p-6 text-sm text-muted-foreground">正在加载运行参数…</div>
      </section>
    );
  }

  const dirty =
    !!data &&
    (data.runCount !== draft.runCount || data.proxy !== draft.proxy);
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    try {
      // 只更新运行相关字段，其余保持服务端当前值
      const next = { ...data!, runCount: draft.runCount, proxy: draft.proxy };
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
    <section className="ios-group flex flex-col">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
        <div>
          <p className="page-kicker">参数</p>
          <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">运行设置</h3>
        </div>
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex flex-1 flex-col justify-between space-y-4 p-4">
        <div className="space-y-4">
          <div className="rounded-xl bg-muted/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="field-label">轮数</div>
                <div className="mt-1 text-[12px] text-muted-foreground">单次 1–50，保存后下次启动生效</div>
              </div>
              <span className="chip tabular-nums">{draft.runCount}</span>
            </div>
            <div className="mt-3">
              <Slider min={1} max={50} value={draft.runCount} onValueChange={(v) => update('runCount', v)} />
            </div>
          </div>

          <Field label="HTTP 代理（可选）" hint="例如 http://127.0.0.1:7890；代理池请在「配置」页设置">
            <Input value={draft.proxy} onChange={(e) => update('proxy', e.target.value)} />
          </Field>

          <p className="text-[12px] leading-5 text-muted-foreground">
            人机验证、域名池、代理池、指纹与 Auth 导出请在{' '}
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={onOpenSettings}
            >
              配置
            </button>{' '}
            页修改。
          </p>
        </div>

        <Button onClick={save} disabled={!dirty || saving} className="w-full">
          <Save className="h-4 w-4" />
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/70 p-3.5">
      <div className="field-label">{label}</div>
      <div className="mt-1.5 break-all text-[13px] font-medium">{value}</div>
    </div>
  );
}
