import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  FolderOpen,
  Play,
  Save,
  SlidersHorizontal,
  StopCircle,
  TriangleAlert
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { Slider } from '@renderer/components/ui/Slider';
import { StatusCard } from '@renderer/components/domain/StatusCard';
import { LogPanel } from '@renderer/components/domain/LogPanel';
import { ConnectionTestButton } from '@renderer/components/domain/ConnectionTestButton';
import { useRunStore } from '@renderer/store/runStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AppSettings } from '@shared/settings';

export function RegisterPage({ onOpenSettings }: { onOpenSettings(): void }) {
  const status = useRunStore((s) => s.status);
  const settings = useSettingsStore((s) => s.data);
  const push = useToastStore((s) => s.push);
  const running = status.phase === 'starting' || status.phase === 'running';
  const progress = status.total > 0 ? Math.min(100, Math.round((status.success / status.total) * 100)) : 0;

  const ready = useMemo(
    () =>
      !!settings?.mail.apiBase &&
      !!settings?.mail.adminAuth &&
      !!settings?.mail.domain,
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
    <div className="space-y-6">
      <div className="pane-grid">
        <section className="terminal-card">
          <div className="terminal-card-header">
            <h3 className="text-base font-semibold">注册机运行台</h3>
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <Button variant="danger" size="lg" onClick={stop}>
                  <StopCircle className="h-[18px] w-[18px]" />
                  停止运行
                </Button>
              ) : (
                <Button size="lg" onClick={start} disabled={!ready}>
                  <Play className="h-[18px] w-[18px]" />
                  开始运行
                </Button>
              )}
            </div>
          </div>
          <div className="terminal-card-body space-y-5">
            <StatusCard status={status} />

            <div className="rounded-2xl border border-border bg-muted/45 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="field-label">register progress</div>
                  <div className="mt-2 text-sm text-muted-foreground">
                    成功 {status.success} / 计划 {status.total || settings?.runCount || 0}
                  </div>
                </div>
                <div className="font-mono text-2xl font-semibold">{progress}%</div>
              </div>
              <div className="mt-4 h-3 overflow-hidden rounded-full border border-border bg-card">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>

            {!ready && (
              <div className="rounded-2xl border border-warn/35 bg-warn/8 p-4 text-sm leading-7 text-warn">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-1 h-4 w-4 shrink-0" />
                  <span>启动前请到「配置」页补齐邮箱后端。</span>
                </div>
                <Button className="mt-3" variant="secondary" size="sm" onClick={onOpenSettings}>
                  打开配置页
                </Button>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <InfoBox label="run count" value={String(settings?.runCount ?? '--')} />
              <InfoBox label="proxy" value={settings?.proxy || '直接连接'} />
            </div>
          </div>
        </section>

        <RuntimeSettingsPanel />
      </div>

      <LogPanel />
    </div>
  );
}

function RuntimeSettingsPanel() {
  const data = useSettingsStore((s) => s.data);
  const reload = useSettingsStore((s) => s.reload);
  const push = useToastStore((s) => s.push);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  if (!draft) {
    return (
      <section className="terminal-card">
        <div className="terminal-card-body text-sm text-muted-foreground">正在加载运行参数…</div>
      </section>
    );
  }

  const dirty = !!data && JSON.stringify(data) !== JSON.stringify(draft);
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    try {
      await window.api.saveSettings(draft);
      await reload();
      push({ tone: 'ok', title: '运行参数已保存' });
    } catch (err) {
      push({ tone: 'danger', title: '保存失败', description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="terminal-card flex flex-col">
      <div className="terminal-card-header">
        <h3 className="text-base font-semibold">运行参数</h3>
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="terminal-card-body space-y-5 flex-1 flex flex-col justify-between">
        <div className="space-y-5">
          <div className="rounded-2xl border border-border bg-muted/45 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="field-label">run count</div>
                <div className="mt-1 text-xs text-muted-foreground">单次启动执行轮数，范围 1 到 50，保存后下次启动生效。</div>
              </div>
              <div className="shell-chip">{draft.runCount}</div>
            </div>
            <div className="mt-4">
              <Slider min={1} max={50} value={draft.runCount} onValueChange={(v) => update('runCount', v)} />
            </div>
          </div>

          <Field label="HTTP 代理配置 (可选)" hint="例如 http://127.0.0.1:7890">
            <Input value={draft.proxy} onChange={(e) => update('proxy', e.target.value)} />
          </Field>
          
          <Field label="Python 路径" hint="Python 解释器路径，留空则使用系统 PATH 中的 python">
            <Input value={draft.pythonPath} onChange={(e) => update('pythonPath', e.target.value)} placeholder="python" />
          </Field>

          <Field label="注册脚本目录" hint="可选；留空时自动使用项目内置 register/，Docker 中为 /app/register">
            <Input value={draft.registerDir} onChange={(e) => update('registerDir', e.target.value)} placeholder="/app/register" />
          </Field>
        </div>

        <div className="pt-5">
          <Button onClick={save} disabled={!dirty || saving} className="w-full">
            <Save className="h-4 w-4" />
            {saving ? '保存中…' : '保存运行参数'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint mt-1">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/45 p-4">
      <div className="field-label">{label}</div>
      <div className="mt-2 break-all font-mono text-xs">{value}</div>
    </div>
  );
}
