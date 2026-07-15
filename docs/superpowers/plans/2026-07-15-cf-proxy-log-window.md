# CF 独立代理日志输出窗口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在设置页「CF 独立代理」面板底部增加 `cfwp` 最近日志输出窗口，并提供刷新、复制、清空显示能力。

**架构：** 后端复用 `cfwpManager` 当前 `lastLogPath`，新增只读日志 API，限制读取大小并脱敏 token。前端在 `SettingsForm` 内增加日志 state 和小型日志卡片，与现有 CF 启停按钮联动刷新。共享 IPC 类型和 Web API 保持现有模式。

**技术栈：** TypeScript、Express、React、Vite、现有 `window.api` Web API 适配层。

---

## 文件结构

- 修改：`server/src/cfwpManager.ts`
  - 新增 `CfwpLogResult` 类型和 `readCfwpLog(settings, tail)` 函数。
  - 函数负责读取当前日志、tail 行、最大字节限制、token 脱敏。
- 修改：`server/src/index.ts`
  - 新增 `GET /api/cf-proxy/log?tail=200`。
- 修改：`src/shared/ipc.ts`
  - 新增 `CfProxyLogResult` 接口。
  - 在 `RendererApi` 增加 `getCfProxyLog(tail?: number)`。
- 修改：`src/renderer/lib/webApi.ts`
  - 实现 `getCfProxyLog` 调用后端接口。
- 修改：`src/renderer/components/domain/SettingsForm.tsx`
  - 增加日志状态、刷新/复制/清空逻辑。
  - 在 CF 独立代理面板内嵌入日志窗口。

## 任务 1：后端日志读取能力

**文件：**
- 修改：`server/src/cfwpManager.ts:7-13, 19-32, 149-181`
- 修改：`server/src/index.ts:215-246`

- [ ] **步骤 1：编写失败的类型检查目标**

在 `server/src/index.ts` 临时加入调用目标（实现前应因未导出函数失败）：

```ts
import { getCfwpStatus, readCfwpLog, stopCfwp, syncCfwpFromSettings } from './cfwpManager.js';
```

并新增接口骨架：

```ts
app.get('/api/cf-proxy/log', async (req, res) => {
  const s = await loadSettings();
  const tail = Number(req.query.tail || 200);
  res.json(readCfwpLog(s, tail));
});
```

- [ ] **步骤 2：运行类型检查验证失败**

运行：

```bash
npm run typecheck
```

预期：FAIL，提示 `cfwpManager` 没有导出 `readCfwpLog`。

- [ ] **步骤 3：实现最少后端日志读取**

在 `server/src/cfwpManager.ts` 的 fs import 中加入：

```ts
readFileSync,
statSync
```

新增类型：

```ts
export type CfwpLogResult = {
  ok: boolean;
  logPath: string | null;
  content: string;
  truncated: boolean;
  error?: string;
};
```

新增函数：

```ts
export function readCfwpLog(settings?: AppSettings, tail = 200): CfwpLogResult {
  const logPath = lastLogPath;
  if (!logPath) {
    return { ok: true, logPath: null, content: '', truncated: false };
  }
  try {
    const maxBytes = 256 * 1024;
    const st = statSync(logPath);
    const raw = readFileSync(logPath);
    const sliced = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
    let content = sliced.toString('utf8');
    const lines = content.split(/\r?\n/);
    const limit = Number.isInteger(tail) && tail > 0 ? Math.min(tail, 1000) : 200;
    const truncatedByLines = lines.length > limit;
    if (truncatedByLines) content = lines.slice(-limit).join('\n');
    const token = String(settings?.cfProxyToken || '').trim();
    if (token) content = content.split(token).join('******');
    return {
      ok: true,
      logPath,
      content,
      truncated: raw.length > maxBytes || st.size > raw.length || truncatedByLines
    };
  } catch (err) {
    return {
      ok: false,
      logPath,
      content: '',
      truncated: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
```

- [ ] **步骤 4：运行类型检查验证通过**

运行：

```bash
npm run typecheck
```

预期：PASS 或只剩前端未接入导致的下一任务错误。

- [ ] **步骤 5：Commit**

```bash
git add server/src/cfwpManager.ts server/src/index.ts
git commit -m "feat: expose cfwp log api"
```

## 任务 2：共享 API 类型和 Web API 适配

**文件：**
- 修改：`src/shared/ipc.ts:472-499`
- 修改：`src/renderer/lib/webApi.ts:268-271`

- [ ] **步骤 1：编写失败的前端调用目标**

在 `SettingsForm.tsx` 的 CF 日志刷新逻辑中会调用：

```ts
const log = await window.api.getCfProxyLog(200);
```

实现前类型检查应失败，因为 `RendererApi` 未定义此方法。

- [ ] **步骤 2：运行类型检查验证失败**

运行：

```bash
npm run typecheck
```

预期：FAIL，提示 `getCfProxyLog` 不存在。

- [ ] **步骤 3：补共享类型**

在 `RendererApi` CF 方法之后加入：

```ts
/** 读取 cfwp 最近日志 */
getCfProxyLog(tail?: number): Promise<CfProxyLogResult>;
```

在 `CfProxyStatus` 后加入：

```ts
export interface CfProxyLogResult {
  ok: boolean;
  logPath: string | null;
  content: string;
  truncated: boolean;
  error?: string;
}
```

- [ ] **步骤 4：实现 Web API**

在 `src/renderer/lib/webApi.ts` 的 CF 方法附近加入：

```ts
getCfProxyLog: (tail = 200) => http('GET', `/api/cf-proxy/log?tail=${encodeURIComponent(String(tail))}`),
```

- [ ] **步骤 5：运行类型检查验证通过**

运行：

```bash
npm run typecheck
```

预期：PASS 或只剩 UI 任务中的新增代码错误。

- [ ] **步骤 6：Commit**

```bash
git add src/shared/ipc.ts src/renderer/lib/webApi.ts
git commit -m "feat: add cf proxy log client api"
```

## 任务 3：设置页日志窗口 UI

**文件：**
- 修改：`src/renderer/components/domain/SettingsForm.tsx:1-14, 346-487, 1551-1581`

- [ ] **步骤 1：编写失败的 UI 状态代码**

在 imports 中加入图标：

```ts
Clipboard,
RefreshCw,
Terminal
```

新增 state：

```ts
const [cfLog, setCfLog] = useState<CfProxyLogResult | null>(null);
const [cfLogLoading, setCfLogLoading] = useState(false);
const [cfLogCleared, setCfLogCleared] = useState(false);
```

此时类型检查应失败，因为 `CfProxyLogResult` 尚未导入。

- [ ] **步骤 2：运行类型检查验证失败**

运行：

```bash
npm run typecheck
```

预期：FAIL，提示 `CfProxyLogResult` 找不到或新增逻辑未完成。

- [ ] **步骤 3：补 UI 逻辑**

从 `@shared/ipc` import：

```ts
import type { CfProxyLogResult, CfProxyStatus } from '@shared/ipc';
```

新增函数：

```ts
const refreshCfLog = async () => {
  try {
    if (typeof window.api?.getCfProxyLog !== 'function') return;
    setCfLogLoading(true);
    const log = await window.api.getCfProxyLog(200);
    setCfLog(log);
    setCfLogCleared(false);
  } catch (err) {
    setCfLog({
      ok: false,
      logPath: cfStatus?.logPath ?? null,
      content: '',
      truncated: false,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    setCfLogLoading(false);
  }
};

const copyCfLog = async () => {
  const text = cfLog?.content || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    push({ tone: 'ok', title: '已复制 cfwp 日志' });
  } catch (err) {
    push({ tone: 'danger', title: '复制失败', description: String(err) });
  }
};
```

在 `runCfAction` 成功设置状态后调用：

```ts
void refreshCfLog();
```

在 CF 面板开启时的 effect 中增加首次读取：

```ts
if (draft?.cfProxyEnabled) void refreshCfLog();
```

- [ ] **步骤 4：添加日志卡片 JSX**

放在「将使用本地代理」卡片之后：

```tsx
<div className="rounded-lg border border-border/50 bg-card/60">
  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
    <div className="flex items-center gap-2 text-[12px] font-medium">
      <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
      cfwp 日志
      {cfLog?.truncated && <span className="text-[11px] text-amber-600">仅显示最近内容</span>}
    </div>
    <div className="flex items-center gap-1.5">
      <Button type="button" size="sm" variant="secondary" className="h-7" disabled={cfLogLoading} onClick={() => void refreshCfLog()}>
        {cfLogLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        刷新
      </Button>
      <Button type="button" size="sm" variant="secondary" className="h-7" disabled={!cfLog?.content} onClick={() => void copyCfLog()}>
        <Clipboard className="h-3.5 w-3.5" />
        复制
      </Button>
      <Button type="button" size="sm" variant="secondary" className="h-7" disabled={!cfLog?.content && !cfLog?.error} onClick={() => setCfLogCleared(true)}>
        清空显示
      </Button>
    </div>
  </div>
  <div className="px-3 py-2">
    <div className="mb-1 truncate font-mono text-[10px] text-muted-foreground">
      {cfLog?.logPath || cfStatus?.logPath || '暂无日志路径'}
    </div>
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950/90 p-3 font-mono text-[11px] leading-5 text-slate-100">
      {cfLogCleared
        ? '已清空当前显示，点击「刷新」重新读取日志。'
        : cfLog?.error
          ? `读取日志失败：${cfLog.error}`
          : cfLog?.content || '暂无日志，保存或启动 CF 独立代理后刷新。'}
    </pre>
  </div>
</div>
```

- [ ] **步骤 5：运行类型检查验证通过**

运行：

```bash
npm run typecheck
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/renderer/components/domain/SettingsForm.tsx
git commit -m "feat: show cfwp logs in settings"
```

## 任务 4：最终验证

**文件：**
- 验证：整个项目

- [ ] **步骤 1：运行 Web 类型检查**

运行：

```bash
npm run typecheck
```

预期：PASS。

- [ ] **步骤 2：运行构建**

运行：

```bash
npm run server:build
```

预期：PASS，Vite 和 server TypeScript 构建成功。

- [ ] **步骤 3：检查 diff**

运行：

```bash
git diff --stat
git diff -- server/src/cfwpManager.ts server/src/index.ts src/shared/ipc.ts src/renderer/lib/webApi.ts src/renderer/components/domain/SettingsForm.tsx
```

预期：diff 只包含 CF 日志窗口相关变更。

- [ ] **步骤 4：最终 Commit**

如果前面没有逐任务 commit，运行：

```bash
git add server/src/cfwpManager.ts server/src/index.ts src/shared/ipc.ts src/renderer/lib/webApi.ts src/renderer/components/domain/SettingsForm.tsx docs/superpowers/specs/2026-07-15-cf-proxy-log-window-design.md docs/superpowers/plans/2026-07-15-cf-proxy-log-window.md
git commit -m "feat: add cf proxy log window"
```

## 自检

- 规格中的 UI、后端接口、数据流、错误处理、安全和验证需求均有对应任务。
- 无 TODO、待定或占位步骤。
- 类型名保持一致：`CfProxyLogResult`、`getCfProxyLog`、`readCfwpLog`。
- 范围聚焦 CF 独立代理日志窗口，没有改普通代理/代理池。
