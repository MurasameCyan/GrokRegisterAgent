# 注册后关闭 ZDR 设计

## 背景

Grok 部分账号在调用文件相关能力时返回：

- HTTP 400 body：`{"code":"invalid-argument","error":"File content is currently unsupported for ZDR customers."}`
- 响应头：`X-Zero-Retention: true`

这表示服务端将该账号/请求归类为 ZDR（Zero Data Retention）客户侧，从而拒绝 file content。仓库内已有完整的 NSFW 开启链路（SSO cookie + gRPC-web `UpdateUserFeatureControls` + 侧车标签 + Auth 字段 + UI 徽章），但没有关闭 ZDR 或探测 `X-Zero-Retention` 的实现。

公开文档中**没有**已证实的消费端「一键关 ZDR / 允许 file」feature key。企业 API ZDR、Grok Build CLI `/privacy`、消费端「Improve the model」数据控件是不同产品面，不能等同于本错误。社区有区域合规（如欧洲 IP）强制 ZDR 的猜测。

因此本设计采用：**协议优先尝试关闭 + probe 判定 + 标签**；关闭失败不挡注册与导出；协议 key 可配置增补。

## 目标

1. 注册成功拿到 SSO 后，在**导出 SSO**与**转换 Auth**之前，尽量关闭导致 file 400 的账号级 ZDR 状态。
2. 用明确标签展示结果：成功关掉 → **关**；未成功关掉 → **开**。
3. SSO 号池页以 **tag** 展示；Auth 页以 **列** 展示。
4. 默认开启该步骤（设置项默认 true），失败绝不阻断主流程。

## 非目标

- 不实现企业合同级 ZDR 开通/关闭流程。
- 不把 Grok Build CLI `/privacy` 当作消费端 file 开关。
- 首版不做浏览器 UI 点击 Data Controls 自动化（可作后续 fallback）。
- 不因 ZDR 未关而丢弃 SSO、重试整号注册或阻塞 Auth 转换。
- 不伪造「已关」：无足够成功证据时偏向标 **开**。

## 方案选择

| 方案 | 说明 | 结论 |
|------|------|------|
| A | 协议尝试 + probe + 标签（镜像 NSFW，调用更早） | **采用** |
| B | 仅探测打标，不尝试关闭 | 不采用（不满足「优先关掉」） |
| C | 浏览器 UI 点隐私/数据控件 | 首版不做 |

默认行为（用户确认 **A1**）：设置 `enableDisableZdr` 默认 **true**，注册后总是尝试关闭 + 探测 + 打标。

## 成功标准与标签语义

| 结果 | 内部 | UI |
|------|------|-----|
| 关闭尝试成功 **且** probe 判定不再为 ZDR | `zdrClosed=true`, `zdrStatus=closed` | **关**（绿） |
| 尝试失败 / 仍 ZDR / 无 SSO | `zdrClosed=false`, `zdrStatus=open` | **开**（琥珀） |
| 配置关闭或未跑到该步 | `zdrAttempted=false`, `zdrStatus=none` | **—**（灰） |

判定优先级：

1. Probe 读到 `X-Zero-Retention: true` → 仍为 **开**（即使某关闭请求 2xx）。
2. Probe 读到明确非 ZDR（头缺失或 false，且无 file 类 invalid-argument）→ 可标 **关**。
3. 缺少可靠 probe 端点且无强成功信号 → 默认标 **开**（保守）。

## 架构

与 NSFW 同构，**调用时机更早**：

```
注册成功 → SSO cookie 就绪
  → [若 enableDisableZdr] disable_zdr_for_sso（协议尝试 + probe）
  → set_zdr_tag
  → append_sso_to_txt（导出 SSO）
  → 入 Auth 队列
  → mint 前/后：若未 closed 可二次尝试；patch_auth_file_zdr
  → UI 合并 tag / auth 字段 → ZdrBadge
```

与 NSFW 对比：

| 项 | NSFW（现状） | ZDR（本设计） |
|----|--------------|--------------|
| 时机 | mint 成功后 `_maybe_nsfw_and_sub2api` | SSO 落盘前主路径；队列补刀（幂等） |
| 语义 | 开 NSFW = ok | 关 ZDR = 关；失败 = 开 |
| 协议 | 已知 key `always_show_nsfw_content` | 候选 keys + probe；可配置增补 |

## 组件

### 1. `register/zdr_toggle.py`（新）

公开入口：

```python
def disable_zdr_for_sso(
    sso: str,
    *,
    cf_clearance: str = "",
    proxy: str = "",
    log: LogFn | None = None,
    feature_keys: list[str] | None = None,
) -> dict: ...
```

返回字段至少包含：

- `ok: bool` — 是否已判定为 **关**（closed）
- `zdr_status: "closed" | "open" | "unknown"`
- `error: str`
- `steps: list | dict` — 各候选/probe 步骤日志
- `probe: dict` — probe 原始摘要（状态码、是否含 `X-Zero-Retention` 等）

会话约定（对齐 `nsfw_toggle.enable_nsfw_for_sso`）：

- `curl_cffi`（或项目既有 session 工厂）
- Cookie：`sso`、`sso-rw`、可选 `cf_clearance`
- Chrome 系 UA
- 可选 HTTP/SOCKS 代理
- 最多 2 次重试；异常吞掉并写入 `error`，不抛到主流程

**关闭尝试（可插拔）**

- gRPC-web：`POST https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls`
- 帧结构复用 NSFW 编码器形态：`field1` enable flag + `field2` feature 字符串
- Feature key 来自常量候选列表 + 可选调用参数/配置覆盖
- 首版候选 key **未公开证实**，仅作尽力尝试；真实 key 以 HAR/抓包后增补列表为准，不改架构
- 若后续发现稳定 REST（data-controls / user settings），作为第二路径写入同模块

**Probe**

- 优先：轻量已认证请求，检查响应头 `X-Zero-Retention`
- 不做大文件上传；不拖垮注册节奏
- 无合适端点时：`probe.skipped=true`，按成功标准第 3 条保守标 **开**

### 2. `register/account_tags.py`（扩展）

侧车文件仍为 `register/data/account_tags.json`（`by_email` / `by_sso_hash`）。

新增：

- `set_zdr_tag(*, closed: bool, email="", sso="", error="", steps=None) -> dict`
  - 侧车写入（snake_case，与 nsfw 一致）：
    - `zdr_closed: bool`
    - `zdr_attempted: true`
    - `zdr_at: ISO8601`
    - `zdr_error: str`（仅失败时，截断至 300 字符；成功时清空）
    - 可选 `zdr_steps`
- `patch_auth_file_zdr(path, *, closed: bool, error="") -> bool`
  - CPA auth JSON 写入同样 snake_case：`zdr_closed`, `zdr_attempted`, `zdr_at`, `zdr_error`
  - 读取侧（TS）同时兼容 camelCase（`zdrClosed` 等），与 `cpaAuthStore` 读 `nsfw_enabled`/`nsfwEnabled` 的方式一致

`get_tag` 无需改语义，已返回整包 dict。

### 3. 调用点

#### 主路径：`register/DrissionPage_example.py`

顺序（在现有成功路径上插入）：

1. `wait_for_grok_com_landing`
2. `ensure_age_gate_completed`
3. `wait_for_sso_cookie`
4. `claim_sso`（重复则 `AccountRetryNeeded`）
5. **【新】** 若配置启用：提取 `cf_clearance` + 当前 proxy → `disable_zdr_for_sso` → `set_zdr_tag`
6. `append_sso_to_txt`
7. CF context capture / 入 Auth 队列

无 SSO：不调用 disable；可选写 tag `error=no sso` 且 closed=false（若已有 email 上下文）。

#### 队列补刀：`register/auth_export_queue.py`

- 在 mint 前后与 NSFW 并列（或紧邻）：读取 tag；若已 `zdr_closed` 则跳过
- 否则用任务携带的 sso/cf/proxy 再调 `disable_zdr_for_sso`，更新 tag，并对 mint 产出的 auth 路径 `patch_auth_file_zdr`
- 配置键：`enable_disable_zdr` / `enableDisableZdr`（truthy 判断与 NSFW 相同）

### 4. 设置与运行时

| 层 | 键 | 默认 |
|----|-----|------|
| `src/shared/settings.ts` | `enableDisableZdr: boolean` | **`true`** |
| `server/src/bot/registerRuntime.ts` | 映射到注册 config | `enable_disable_zdr` / `enableDisableZdr` |
| SettingsForm | 开关 + 说明 | 「注册成功后、SSO 导出前尝试关闭 ZDR；失败标开、不挡导出」 |

### 5. 前端类型与 UI

扩展（与 nsfw* 对称）：

- `src/shared/runEvents.ts` → `AccountRecord`：`zdrClosed`, `zdrAttempted`, `zdrAt`, `zdrError`, `zdrStatus: 'closed' | 'open' | 'none'`
- `src/shared/ipc.ts` → `CpaAuthItem`：同上
- 新组件 `src/renderer/components/domain/ZdrBadge.tsx`：
  - closed → 绿「ZDR关」
  - open → 琥珀「ZDR开」
  - none → 灰「—」
- `PoolPage`：SSO 列表 tag 区与 NSFW 并排
- `AuthPage`：表头列「ZDR」+ 单元格 `ZdrBadge`

### 6. 存储合并

- `server/src/accountTags.ts`：扩展侧车解析，输出 `zdrClosed` / `zdrAttempted` / `zdrStatus`（`closed`|`open`|`none`）及 error/at。
- `server/src/accountStore.ts`：SSO `AccountRecord` 合并侧车 zdr*。
- `server/src/cpaAuthStore.ts`：auth JSON 优先，否则侧车；映射到 `CpaAuthItem` 的 zdr* 字段（照抄 nsfw 分支）。

## 数据流

```
SSO 就绪
  → disable_zdr_for_sso
      → 候选 UpdateUserFeatureControls…
      → probe X-Zero-Retention / 等价信号
  → set_zdr_tag
  → append_sso_to_txt
  → 队列 mint
      → 可选二次 disable_zdr_for_sso
      → patch_auth_file_zdr
  → UI 读 tag / auth → ZdrBadge
```

## 错误处理

| 情况 | 行为 |
|------|------|
| Cloudflare / 网络错误 | log + tag **开** + 继续导出 |
| 全部候选 key 非成功 | tag **开** |
| Probe 仍 `X-Zero-Retention: true` | tag **开** |
| 协议 key 尚未找到 | 多数账号可能标 **开**（诚实）；HAR 后只改候选列表 |
| `enableDisableZdr=false` | 不调用；UI 未尝试 |
| 单步异常 | 捕获，不向上抛，不挡 claim/export/queue |

## 测试计划

1. **单元**：grpc 编码与 NSFW 同结构、不同 feature key；`set_zdr_tag` / `patch_auth_file_zdr` 读写。
2. **Mock probe**：session 返回带/不带 `X-Zero-Retention: true` 时，断言 closed/open 映射。
3. **手工**（有真号时）：对曾出现 file ZDR 400 的账号跑一轮，核对日志 `steps`、侧车、Auth 列。
4. **构建**：`npm run typecheck` 与 `npm run server:build` 通过。

## 实现范围（文件清单）

| 文件 | 动作 |
|------|------|
| `register/zdr_toggle.py` | 新建 |
| `register/account_tags.py` | 扩展 set/patch |
| `register/DrissionPage_example.py` | SSO 落盘前调用 |
| `register/auth_export_queue.py` | 队列补刀 + patch |
| `src/shared/settings.ts` | `enableDisableZdr` 默认 true |
| `server/src/bot/registerRuntime.ts` | 映射配置 |
| `src/shared/runEvents.ts` | AccountRecord 字段 |
| `src/shared/ipc.ts` | CpaAuthItem 字段 |
| `server/src/accountTags.ts` | 侧车解析 zdr* |
| `server/src/accountStore.ts` | SSO 记录合并 zdr* |
| `server/src/cpaAuthStore.ts` | Auth 列表合并 zdr* |
| `src/renderer/components/domain/ZdrBadge.tsx` | 新建 |
| `src/renderer/pages/PoolPage.tsx` | tag |
| `src/renderer/pages/AuthPage.tsx` | 列 |
| `src/renderer/components/domain/SettingsForm.tsx` | 开关 |

Auth JSON 合并/列表 API 若分散在其它 server 模块，实现时按 nsfw 引用点一并扩展，不另开架构。

## 风险与后续

- **最大风险**：不存在可关开关，或区域强制 ZDR，则标签多为 **开**；产品仍可用于诊断与筛选。
- **后续**：抓包确认真实 feature key 或 REST 路径后，只更新 `zdr_toggle` 候选列表与 probe 端点。
- **可选后续**：方案 C（浏览器 Data Controls）作为协议失败后的 fallback。

## 决策记录

- 用户上下文 C：账号级 ZDR 导致 file API 失败，其它方法可接受。
- 标记语义：关成功=关，失败=开；SSO=tag，Auth=列。
- 时机：导出 SSO 与转换 Auth 之前。
- 协议优先于纯 UI。
- 默认开启尝试（A1）。
- 设计方案 A 已于对话中批准（2026-07-16）。
