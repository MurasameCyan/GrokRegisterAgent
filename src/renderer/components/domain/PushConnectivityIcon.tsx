import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { CardHeaderIcon } from '@renderer/components/domain/CardHeaderIcon';
import { cn } from '@renderer/lib/cn';
import type { AppSettings } from '@shared/settings';

type Tone = 'idle' | 'loading' | 'ok' | 'bad';

type Target = 'cpa' | 'g2' | 'sub2';

/**
 * 推送卡片右侧：仅图标的远程连通检测。
 * - 黄：未点「允许推送」/ 未测 / 目标已开但地址未填全
 * - 绿：所有「已允许」目标均连通
 * - 红：至少一个已允许目标失败
 * grok2api：SSO→g2 与 Auth→g2 任一允许/自动 即检测一次 g2 接口。
 */
export function PushConnectivityIcon({ draft }: { draft: AppSettings }) {
  const allowCpa =
    draft.pushAuthToCpa === true ||
    draft.cpaRemotePushEnabled === true ||
    draft.autoPushAuthToCpa === true;
  const allowG2 =
    draft.pushSsoToGrok2api === true ||
    draft.autoPushSsoToGrok2api === true ||
    draft.pushAuthToGrok2api === true ||
    draft.autoPushAuthToGrok2api === true ||
    draft.grok2apiAutoUpload === true;
  const allowSub2 =
    draft.pushAuthToSub2api === true || draft.autoPushAuthToSub2api === true;

  const cpaUrl = String(draft.cpaRemoteUrl || '').trim();
  const cpaKey = String(draft.cpaManagementKey || '').trim();
  const g2Url = String(draft.grok2apiUrl || '').trim();
  const g2User = String(draft.grok2apiUsername || '').trim();
  const g2Pass = String(draft.grok2apiPassword || '').trim();
  const s2Url = String(draft.sub2apiRemoteUrl || '').trim();
  const s2Token = String(draft.sub2apiAdminToken || '').trim();

  const cpaReady = allowCpa && Boolean(cpaUrl && cpaKey);
  const g2Ready = allowG2 && Boolean(g2Url && g2User && g2Pass);
  const s2Ready = allowSub2 && Boolean(s2Url && s2Token);

  /** 没有任何允许推送 → 不请求，黄 */
  const anyAllow = allowCpa || allowG2 || allowSub2;
  /** 有允许但配置不全 → 不请求，黄 */
  const needProbe =
    (allowCpa && cpaReady) || (allowG2 && g2Ready) || (allowSub2 && s2Ready);
  const incomplete = anyAllow && !needProbe;

  const [tone, setTone] = useState<Tone>('idle');
  const [message, setMessage] = useState('未开启推送');
  const seq = useRef(0);

  const depsKey = useMemo(
    () =>
      [
        allowCpa,
        allowG2,
        allowSub2,
        cpaUrl,
        cpaKey,
        g2Url,
        g2User,
        g2Pass,
        s2Url,
        s2Token
      ].join('|'),
    [allowCpa, allowG2, allowSub2, cpaUrl, cpaKey, g2Url, g2User, g2Pass, s2Url, s2Token]
  );

  const run = useCallback(async () => {
    if (!anyAllow) {
      setTone('idle');
      setMessage('未开启允许推送，跳过检测');
      return;
    }
    if (!needProbe) {
      setTone('idle');
      const miss: string[] = [];
      if (allowCpa && !cpaReady) miss.push('CPA 地址/密钥');
      if (allowG2 && !g2Ready) miss.push('grok2api URL/账号');
      if (allowSub2 && !s2Ready) miss.push('sub2api 地址/Token');
      setMessage(`已允许推送但未填全：${miss.join('、') || '配置'}`);
      return;
    }

    const id = ++seq.current;
    setTone('loading');
    setMessage('检测中…');

    const parts: string[] = [];
    let allOk = true;
    const targets: Target[] = [];
    if (allowCpa && cpaReady) targets.push('cpa');
    if (allowG2 && g2Ready) targets.push('g2');
    if (allowSub2 && s2Ready) targets.push('sub2');

    try {
      for (const t of targets) {
        if (id !== seq.current) return;
        if (t === 'cpa') {
          const r = await window.api.testCpaRemote({ url: cpaUrl, key: cpaKey });
          if (r?.ok) parts.push('CPA OK');
          else {
            allOk = false;
            parts.push('CPA FAIL ' + (r?.message || 'fail'));
          }
        } else if (t === 'g2') {
          const r = await window.api.testGrok2apiRemote({
            url: g2Url,
            username: g2User,
            password: g2Pass
          });
          if (r?.ok) parts.push('g2 OK');
          else {
            allOk = false;
            parts.push('g2 FAIL ' + (r?.message || 'fail'));
          }
        } else {
          const r = await window.api.testSub2apiRemote({
            url: s2Url,
            token: s2Token
          });
          if (r?.ok) parts.push('sub2 OK');
          else {
            allOk = false;
            parts.push('sub2 FAIL ' + (r?.message || 'fail'));
          }
        }
      }
      if (id !== seq.current) return;
      setTone(allOk ? 'ok' : 'bad');
      setMessage(parts.join(' · ') || (allOk ? '连通正常' : '连通失败'));
    } catch (err) {
      if (id !== seq.current) return;
      setTone('bad');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [
    anyAllow,
    needProbe,
    allowCpa,
    allowG2,
    allowSub2,
    cpaReady,
    g2Ready,
    s2Ready,
    cpaUrl,
    cpaKey,
    g2Url,
    g2User,
    g2Pass,
    s2Url,
    s2Token
  ]);

  useEffect(() => {
    if (!anyAllow) {
      setTone('idle');
      setMessage('未开启允许推送，跳过检测');
      return;
    }
    if (!needProbe) {
      setTone('idle');
      const miss: string[] = [];
      if (allowCpa && !cpaReady) miss.push('CPA');
      if (allowG2 && !g2Ready) miss.push('grok2api');
      if (allowSub2 && !s2Ready) miss.push('sub2api');
      setMessage(`配置未填全：${miss.join('+') || '?'}`);
      return;
    }
    const t = window.setTimeout(() => {
      void run();
    }, 700);
    return () => window.clearTimeout(t);
  }, [depsKey, anyAllow, needProbe, allowCpa, allowG2, allowSub2, cpaReady, g2Ready, s2Ready, run]);

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
      ? '推送接口检测中…'
      : tone === 'ok'
        ? `推送连通正常 · ${message}`
        : tone === 'bad'
          ? `推送连通失败 · ${message}`
          : incomplete
            ? `推送配置未填全 · ${message}（点击重试）`
            : !anyAllow
              ? '未开启允许推送 · 不检测（点开开关后再测）'
              : `推送未测 · ${message}（点击检测）`;

  return (
    <CardHeaderIcon
      icon={tone === 'loading' ? Loader2 : Send}
      className={cn(shell)}
      iconClassName={tone === 'loading' ? 'animate-spin' : undefined}
      title={title}
      onClick={() => void run()}
      disabled={tone === 'loading'}
    />
  );
}
