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
  /**
   * 本次打开抽屉期间，因验活从「无邮箱」补全到的邮箱（服务端已写号池）。
   * 与 account.email 合并展示，避免父级未及时 reload 时标题仍为 (无邮箱)。
   */
  const [filledEmail, setFilledEmail] = useState<string | null>(null);
  /** 验活前号池是否无邮箱（用于判断「本次是否补全」） */
  const [openedWithoutEmail, setOpenedWithoutEmail] = useState(false);

  // 切换账号时重置局部状态
  useEffect(() => {
    setShowPw(false);
    setShowSso(false);
    setCode(null);
    setFilledEmail(null);
    setOpenedWithoutEmail(!String(account?.email || '').trim());
  }, [account?.id]);

  if (!account) {
    return <Drawer open={open} onClose={onClose} title="" subtitle="账号详情" children={null} />;
  }

  const displayEmail =
    String(account.email || '').trim() ||
    filledEmail ||
    (ssoResult?.email && openedWithoutEmail ? String(ssoResult.email).trim() : '') ||
    '';
  const emailJustFilled = Boolean(
    openedWithoutEmail &&
      (filledEmail ||
        (ssoResult?.email && String(ssoResult.email).trim()))
  );

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
    const addr = displayEmail;
    if (!addr) {
      push({
        tone: 'warn',
        title: '该账号没有邮箱地址',
        description: '可先点「验活」：存活时 grok 常返回邮箱并写入号池'
      });
      return;
    }
    setCodeLoading(true);
    try {
      const result = await window.api.getMailCode(addr);
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
    const hadNoEmail = !String(account.email || '').trim() && !filledEmail;
    setSsoLoading(true);
    try {
      const results = await window.api.checkSso([{ id: account.id, sso: account.sso }]);
      const result = results[0];
      if (result) {
        onSsoResult(result);
        const fromGrok =
          typeof result.email === 'string' ? result.email.trim() : '';
        if (hadNoEmail && fromGrok) {
          setFilledEmail(fromGrok);
          push({
            tone: 'ok',
            title: '已补全邮箱',
            description: `${fromGrok}（已写入号池；可回 Auth 按 email 回填 sso）`
          });
        } else if (hadNoEmail && result.alive && !fromGrok) {
          push({
            tone: 'warn',
            title: '验活存活但未返回邮箱',
            description: '无法自动补全，Auth 无邮箱文件仍需重 mint 或手补 sso'
          });
        } else if (hadNoEmail && !result.alive) {
          push({
            tone: 'warn',
            title: result.error ? '检查异常' : '已失效',
            description: '失效号无法补邮箱'
          });
        }
      }
    } catch (err) {
      push({ tone: 'danger', title: '验活失败', description: String(err) });
    } finally {
      setSsoLoading(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={displayEmail || '(无邮箱)'}
      subtitle="账号详情"
      width={460}
    >
      <div className="space-y-4 p-4">
        <div className="text-[12px] text-muted-foreground">
          创建于 {fmtBeijing(account.createdAt)}（北京时间）
        </div>

        {emailJustFilled && displayEmail && (
          <div className="rounded-[12px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-emerald-800 dark:text-emerald-300">
            <span className="font-medium">已补全邮箱</span>
            <span className="text-muted-foreground dark:text-emerald-400/80">
              {' '}
              · 验活从 grok 写入号池：
            </span>
            <span className="font-mono font-medium"> {displayEmail}</span>
            <div className="mt-1 text-[11px] text-muted-foreground dark:text-emerald-400/70">
              可到 Auth 页用「回填SSO」按 email 匹配写入 auth 的 sso 字段。
            </div>
          </div>
        )}

        {!displayEmail && (
          <div className="rounded-[12px] border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-orange-800 dark:text-orange-300">
            <span className="font-medium">无邮箱</span>
            <span className="text-muted-foreground dark:text-orange-400/80">
              {' '}
              · 点下方「验活」：若存活且 grok 返回 email，将自动写入号池。
            </span>
          </div>
        )}

        {/* 账号凭据 */}
        <section className="space-y-3">
          <CredRow
            label="邮箱"
            value={displayEmail}
            masked={false}
            hideToggle
            onCopy={() => void copy(displayEmail, '邮箱')}
          />
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refreshCode()}
              disabled={codeLoading || !displayEmail}
            >
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
              {code.subject && (
                <div className="truncate" title={code.subject}>
                  主题：{code.subject}
                </div>
              )}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void verify()}
              disabled={ssoLoading || !account.sso}
            >
              <RefreshCcw className={cn('h-3.5 w-3.5', ssoLoading && 'animate-spin')} />
              验活
            </Button>
          </div>

          {ssoResult ? (
            <div className="mt-3 space-y-2">
              <div
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
                  ssoResult.alive ? 'bg-ok/12 text-ok' : 'bg-danger/12 text-danger'
                )}
              >
                {ssoResult.alive ? (
                  <ShieldCheck className="h-3.5 w-3.5" />
                ) : (
                  <ShieldX className="h-3.5 w-3.5" />
                )}
                {ssoResult.alive ? '存活' : ssoResult.error ? '检查异常' : '已失效'}
                <span className="opacity-60">HTTP {ssoResult.status}</span>
              </div>

              {ssoResult.alive && (
                <div className="space-y-1.5 rounded-[12px] bg-card p-3 text-[12px]">
                  <KV
                    label="grok 邮箱"
                    value={ssoResult.email}
                    highlight={
                      Boolean(ssoResult.email) &&
                      String(ssoResult.email).trim() !== String(account.email || '').trim()
                    }
                  />
                  {emailJustFilled && ssoResult.email && (
                    <div className="rounded-md bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                      号池邮箱已补全为 {ssoResult.email}
                    </div>
                  )}
                  {openedWithoutEmail && ssoResult.alive && !ssoResult.email && (
                    <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                      存活但未返回邮箱，无法自动补全
                    </div>
                  )}
                  <KV
                    label="姓名"
                    value={
                      [ssoResult.givenName, ssoResult.familyName].filter(Boolean).join(' ') ||
                      undefined
                    }
                  />
                  <KV label="账户层级" value={ssoResult.sessionTierId} />
                  <KV
                    label="邮箱已验证"
                    value={
                      ssoResult.emailConfirmed == null
                        ? undefined
                        : ssoResult.emailConfirmed
                          ? '是'
                          : '否'
                    }
                  />
                  <KV
                    label="注册时间"
                    value={
                      ssoResult.createTime ? fmtBeijing(ssoResult.createTime) : undefined
                    }
                  />
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
              {ssoLoading
                ? '验活中…'
                : openedWithoutEmail
                  ? '无邮箱账号：验活存活时可能自动补全邮箱'
                  : '点击「验活」检查 grok 账户实时状态'}
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
  hideToggle,
  onToggle,
  onCopy
}: {
  label: string;
  value: string;
  masked: boolean;
  mono?: boolean;
  hideToggle?: boolean;
  onToggle?: () => void;
  onCopy(): void;
}) {
  return (
    <div className="rounded-[14px] bg-muted/60 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="field-label">{label}</span>
        <div className="flex items-center gap-0.5">
          {!hideToggle && onToggle && (
            <button
              type="button"
              onClick={onToggle}
              className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={masked ? '显示' : '隐藏'}
            >
              {masked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            disabled={!value}
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            title="复制"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div
        className={cn(
          'mt-1.5 break-all text-[13px] font-medium tracking-tight',
          mono && 'font-mono text-[12px]',
          !value && 'text-muted-foreground'
        )}
      >
        {masked ? '••••••••••••' : value || '(无)'}
      </div>
    </div>
  );
}

function KV({
  label,
  value,
  highlight
}: {
  label: string;
  value?: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('break-all text-right font-mono', highlight && 'text-warn')}>
        {value || '—'}
      </span>
    </div>
  );
}
