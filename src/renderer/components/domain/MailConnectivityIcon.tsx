import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { CardHeaderIcon } from '@renderer/components/domain/CardHeaderIcon';
import { cn } from '@renderer/lib/cn';
import type { MailSettings } from '@shared/settings';

type Tone = 'idle' | 'loading' | 'ok' | 'bad';

/**
 * 邮件卡片右侧：仅图标的连通性测试。
 * - 黄：未设定 / 未测 / 配置不全
 * - 绿：连通成功
 * - 红：连通失败
 * 进入页自动测一次；配置变化防抖重测；点击可手动重测。
 */
export function MailConnectivityIcon({
  mail,
  enabled,
  provider = 'cloudflare'
}: {
  mail: MailSettings;
  /** false 时显示黄点，不发起请求 */
  enabled: boolean;
  /** cloudflare | duckmail | yyds | gptmail —— 决定探活协议 */
  provider?: string;
}) {
  const [tone, setTone] = useState<Tone>('idle');
  const [message, setMessage] = useState('未检测');
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (!enabled) {
      setTone('idle');
      setMessage('未设定完整邮件配置');
      return;
    }
    const id = ++seq.current;
    setTone('loading');
    setMessage('检测中…');
    try {
      const r = await window.api.testMail({ ...mail, provider } as MailSettings & { provider?: string });
      if (id !== seq.current) return;
      if (r?.ok) {
        setTone('ok');
        setMessage(r.message || '连通正常');
      } else {
        setTone('bad');
        setMessage(r?.message || '连通失败');
      }
    } catch (err) {
      if (id !== seq.current) return;
      setTone('bad');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [enabled, mail.apiBase, mail.adminAuth, mail.domain, provider]);

  // 自动检测：enabled 或关键字段变化后防抖
  useEffect(() => {
    if (!enabled) {
      setTone('idle');
      setMessage('未设定完整邮件配置');
      return;
    }
    const t = window.setTimeout(() => {
      void run();
    }, 600);
    return () => window.clearTimeout(t);
  }, [enabled, mail.apiBase, mail.adminAuth, mail.domain, provider, run]);

  const shell =
    tone === 'ok'
      ? 'bg-ok/15 text-ok hover:bg-ok/25'
      : tone === 'bad'
        ? 'bg-danger/15 text-danger hover:bg-danger/25'
        : tone === 'loading'
          ? 'bg-muted text-muted-foreground'
          : 'bg-warn/15 text-warn hover:bg-warn/25';

  const title =
    tone === 'loading'
      ? '邮件连通性检测中…'
      : tone === 'ok'
        ? `邮件连通正常 · ${message}`
        : tone === 'bad'
          ? `邮件连通失败 · ${message}`
          : `邮件未测/未设定 · ${message}（点击重试）`;

  return (
    <CardHeaderIcon
      icon={tone === 'loading' ? Loader2 : Mail}
      className={cn(shell)}
      iconClassName={tone === 'loading' ? 'animate-spin' : undefined}
      title={title}
      onClick={() => void run()}
      disabled={tone === 'loading'}
    />
  );
}
