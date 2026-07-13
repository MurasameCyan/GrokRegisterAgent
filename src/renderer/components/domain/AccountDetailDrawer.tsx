import { useEffect, useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  RefreshCcw,
  ShieldCheck,
  ShieldX
} from 'lucide-react';
import { Drawer } from '@renderer/components/ui/Drawer';
import { Button } from '@renderer/components/ui/Button';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';
import { fmtBeijing } from '@renderer/lib/time';
import type { MailCodeResult, SsoCheckResult } from '@shared/ipc';
import type { AccountRecord } from '@shared/runEvents';

export function AccountDetailDrawer({
  account,
  open,
  onClose,
  ssoResult,
  onSsoResult
}: {
  account: AccountRecord | null;
  open: boolean;
  onClose(): void;
  ssoResult?: SsoCheckResult;
  onSsoResult(result: SsoCheckResult): void;
}) {
  const push = useToastStore((s) => s.push);
  const [showPw, setShowPw] = useState(false);
  const [showSso, setShowSso] = useState(false);
  const [code, setCode] = useState<MailCodeResult | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);

  // 切换账号时重置局部状态
  useEffect(() => {
    setShowPw(false);
    setShowSso(false);
    setCode(null);
  }, [account?.id]);

  if (!account) {
    return <Drawer open={open} onClose={onClose} title="" subtitle="账号详情" children={null} />;
  }

  const copy = async (value: string, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      push({ tone: 'ok', title: `已复制${label}` });
    } catch {
      push({ tone: 'danger', title: '复制失败' });
    }
  };

  const refreshCode = async () => {
    if (!account.email) {
      push({ tone: 'warn', title: '该账号没有邮箱地址' });
      return;
    }
    setCodeLoading(true);
    try {
      const result = await window.api.getMailCode(account.email);
      setCode(result);
      if (result.error) {
        push({ tone: 'danger', title: '取码失败', description: result.error });
      }
    } catch (err) {
      push({ tone: 'danger', title: '取码失败', description: String(err) });
    } finally {
      setCodeLoading(false);
    }
  };

  const verify = async () => {
    setSsoLoading(true);
    try {
      const [result] = await window.api.checkSso([{ id: account.id, sso: account.sso }]);
      if (result) onSsoResult(result);
    } catch (err) {
      push({ tone: 'danger', title: '验活失败', description: String(err) });
    } finally {
      setSsoLoading(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={account.email || '(无邮箱)'} subtitle="账号详情" width={460}>
      <div className="space-y-4 p-4">
        <div className="text-[12px] text-muted-foreground">
          创建于 {fmtBeijing(account.createdAt)}（北京时间）
        </div>

        {/* 账号凭据 */}
        <section className="space-y-3">
          <CredRow
            label="密码"
            value={account.password}
            masked={!showPw}
            onToggle={() => setShowPw((v) => !v)}
            onCopy={() => void copy(account.password, '密码')}
          />
          <CredRow
            label="SSO"
            value={account.sso}
            masked={!showSso}
            mono
            onToggle={() => setShowSso((v) => !v)}
            onCopy={() => void copy(account.sso, 'SSO')}
          />
        </section>

        {/* 验证码 */}
        <section className="rounded-[14px] bg-muted/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
              <Mail className="h-4 w-4 text-muted-foreground" />
              最新验证码
            </div>
            <Button variant="secondary" size="sm" onClick={() => void refreshCode()} disabled={codeLoading}>
              <RefreshCcw className={cn('h-3.5 w-3.5', codeLoading && 'animate-spin')} />
              刷新
            </Button>
          </div>
          <div className="mt-3 text-center">
            {code?.code ? (
              <button
                type="button"
                onClick={() => void copy(code.code!, '验证码')}
                className="text-[28px] font-semibold tracking-[0.18em] text-primary transition-opacity hover:opacity-70"
                title="点击复制"
              >
                {code.code}
              </button>
            ) : (
              <span className="text-[22px] font-medium text-muted-foreground">
                {codeLoading ? '获取中…' : code ? '暂无验证码' : '— — —'}
              </span>
            )}
          </div>
          {code && (
            <div className="mt-3 space-y-1 text-center text-[12px] text-muted-foreground">
              {code.subject && <div className="truncate" title={code.subject}>主题：{code.subject}</div>}
              {code.receivedAt && <div>收件：{fmtBeijing(code.receivedAt)}</div>}
              {!code.hasMail && !code.error && <div>该邮箱暂无邮件</div>}
            </div>
          )}
        </section>

        {/* SSO 验活 */}
        <section className="rounded-[14px] bg-muted/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              SSO 验活
            </div>
            <Button variant="secondary" size="sm" onClick={() => void verify()} disabled={ssoLoading}>
              <RefreshCcw className={cn('h-3.5 w-3.5', ssoLoading && 'animate-spin')} />
              验活
            </Button>
          </div>

          {ssoResult ? (
            <div className="mt-3 space-y-2">
              <div
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
                  ssoResult.alive
                    ? 'bg-ok/12 text-ok'
                    : 'bg-danger/12 text-danger'
                )}
              >
                {ssoResult.alive ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
                {ssoResult.alive ? '存活' : ssoResult.error ? '检查异常' : '已失效'}
                <span className="opacity-60">HTTP {ssoResult.status}</span>
              </div>

              {ssoResult.alive && (
                <div className="space-y-1.5 rounded-[12px] bg-card p-3 text-[12px]">
                  <KV label="grok 邮箱" value={ssoResult.email} highlight={ssoResult.email !== account.email} />
                  <KV
                    label="姓名"
                    value={[ssoResult.givenName, ssoResult.familyName].filter(Boolean).join(' ') || undefined}
                  />
                  <KV label="账户层级" value={ssoResult.sessionTierId} />
                  <KV label="邮箱已验证" value={ssoResult.emailConfirmed == null ? undefined : ssoResult.emailConfirmed ? '是' : '否'} />
                  <KV label="注册时间" value={ssoResult.createTime ? fmtBeijing(ssoResult.createTime) : undefined} />
                </div>
              )}
              {ssoResult.error && (
                <div className="rounded-[12px] bg-danger/10 px-3 py-2 text-[12px] text-danger">
                  {ssoResult.error}
                </div>
              )}
              <div className="text-[12px] text-muted-foreground">
                检查于 {fmtBeijing(ssoResult.checkedAt)}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-center text-[12px] text-muted-foreground">
              {ssoLoading ? '验活中…' : '点击「验活」检查 grok 账户实时状态'}
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

function CredRow({
  label,
  value,
  masked,
  mono,
  onToggle,
  onCopy
}: {
  label: string;
  value: string;
  masked: boolean;
  mono?: boolean;
  onToggle(): void;
  onCopy(): void;
}) {
  return (
    <div className="rounded-[14px] bg-muted/60 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="field-label">{label}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={masked ? '显示' : '隐藏'}
          >
            {masked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="复制"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className={cn('mt-1.5 break-all text-[13px] font-medium tracking-tight', mono && 'font-mono text-[12px]')}>
        {masked ? '••••••••••••' : value || '(无)'}
      </div>
    </div>
  );
}

function KV({ label, value, highlight }: { label: string; value?: string; highlight?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('break-all text-right font-mono', highlight && 'text-warn')}>
        {value || '—'}
      </span>
    </div>
  );
}
