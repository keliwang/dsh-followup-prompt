# DSH Followup Prompt（Composer Predictions）插件方案

> 参考功能：Codex Composer Predictions（Codex 官方功能）
> 项目名：**`dsh-followup-prompt`（Followup Prompt）**——产品名与工作区一致；npm 包名 2026-10-19 实测 404 可用，对标 Codex Composer Predictions（命名见 §2.1）。
> 调研日期：2026-10-19
> 版本基线：运行中的 DSH Desktop 为 **0.2.1-rc.2**（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`）；源码 checkout 为 **0.2.1-rc.2**（`/Users/keli/Workspace/personal/works/deepseek-harness`，HEAD `687f282e86`，2026-10-17），与活体同代（原 0.1.5 checkout 已过时）。Fork 会话仅作为参照路径（Codex inheriting fork / DSH 持久 fork），不作为本方案的实现依赖；取舍与证据见 §13。
> 结论摘要：**可行，且完全不需要服务端特殊接口**；推荐做成一个「安装式 bundle」，Host 用标准 LLM 通道做一次性预测，Client 用官方 composer 浮层槽位展示，Tab 接受为可编辑草稿。
> 补充结论（2026-10-19）：DSH 0.2.1 已内置**用户可见的 fork 会话能力**（会话菜单/快捷键/消息尾部分支），但本方案不依赖 fork：预测改用「继承请求 + tool-rejection」，理由见 §13。

---

## 0. 一页结论

### 0.1 推荐方案（一句话）

一个 bundle 两个半边：**Host 半边**在回合结束事件后，用 `ctx.llm.stream()` 对当前会话做一次**不进 loop、不执行工具、不写会话日志**的继承式模型调用（保留 tools 定义以复用前缀；模型若调用 tool，统一回错误 tool-result 拒绝），结果放进进程内缓存；**Client 半边**在 composer 空输入时通过 DSH 自带的鉴权 RPC 通道长轮询取回建议，渲染在 `conversation.input.overlay`（或 `conversation.composer.dock`）里，用户按 **Tab** 接受后通过官方 `inputActions` 写入草稿——**不发送**。

### 0.2 核心链路（5 步）

```
用户发的消息得到回复 → 回合结束
 ① Host：ctx.on('session/event') 收到 turn/end(reason=completed)
 ② Client：useSession(running) 由 true→false 且草稿为空 → connection.rpc.call('suggestions/wait')
 ③ Host：校验最新回合 → 命中缓存直接返回；否则 ctx.llm.stream(会话历史 + 预测指令) → 归一化 → 缓存
 ④ Client：渲染 ghost / 建议条（仅空输入框、空闲、非 IME 组合）
 ⑤ 用户 Tab → inputActions（captureInsertion + insertText）写入可编辑草稿；不调用 submit()
```

Codex 的「inheriting fork（继承父会话前缀以复用 prompt cache）+ ephemeral 预测线程」在 DSH 中**不需要 fork**：不进入 agent loop 就已经天然隔离（不执行工具、无记忆检索、无系统提示重建、无会话副作用），上下文直接在本地从已持久化的会话日志派生；`tools` 定义仍保留以对齐请求前缀，模型调用时统一回错误 tool-result 拒绝。Codex 源码级细节与对照见 §2.2。

### 0.3 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 交付形态 | **独立安装式 bundle**（Host + Client 同一包） | 纯公共 API、可灰度/可卸载、不依赖 dsh 仓库构建；适合先验证体验 |
| 触发 | **客户端按需 + Host 缓存**（`suggestions/wait` 长轮询），可选 Host 预生成（默认关） | 只为用户可见会话付费；天然 catch-up（打开已结束会话时同样一条请求） |
| 结果通道 | **`ctx.connection.rpc.handle('/followup-prompt')`** + 客户端 `connection.rpc.call`（需 host inject `webServer`）；或改用 `/api/followup-prompt/rpc` exact Fetch 路由 + 普通 `fetch`（不需 webServer） | DSH 自带的鉴权通道：自动 Host/Origin 校验 + 浏览器 cookie；**无 Typert codegen、不占用 `/api` 的 Gateway 通道、不改 profile 装配** |
| 回合判定 | Host：`session/event` 的 `turn/end` 且 `reason.kind === 'completed'` | post-commit、fire-and-forget；历史已完整；不用 `agent/turn-stopping`（会被 loop await，延迟回合关闭），不用 `agent/status`（粒度不对且文档禁止轮询） |
| 会话读取 | `session.deriveMessages()` + `session.requestHeader()?.config/.tools` + `session.toolHistory()` | 都是活体公开签名；历史 + tools + toolHistory 与主请求前缀一致，利于 provider 上下文缓存 |
| 工具调用 | **保留全部 tools 定义，但绝不执行**；模型返回 tool-call 时构造统一错误 tool-result 让它继续（`maxToolRejectRounds` 默认 1） | DSH 无 `toolChoice`，请求层无法禁止；拒绝回执既保持前缀又避免副作用（§4.4.1） |
| UI 落点 | P1 `conversation.composer.dock` 建议条；P2 `conversation.input.overlay` 内联 ghost | 前者最稳；后者更像 Codex，但依赖 0.2.1 版式常量做像素对齐 |
| 接受草稿 | `inputActions.captureInsertion()` + `insertText(text, span)`（0.2.1），回退 `setDraft(text)` | 一次可撤销插入、不发送；`SessionInput.focus()` 仅点击接受时需要 |
| 存储 | 全部进程内缓存（key = `[sessionId, turn]`），**不写 session log、不落盘** | 第三方插件不能新增 session 事件 type（会破坏会话 reopen）；预测是一次性提示 |
| 配置 | Host `Config`（schemastery，字段 `.volatile()`） | 0.2.1 Settings 会为 loader entry 的 volatile 字段生成表单并写回 profile patch；若该入口不可用，按 §4.8 的注意项改用 `settings.section` + 自持久化 JSON |

### 0.4 与 Codex 的三个本质差异（要如实告知用户）

1. **不免费**：Codex 的预测调用不计 usage；DSH 这里是普通 `GenerateOptions` 请求，会按用户配置的 provider 正常计费。必须提供总开关/采样率/超时，并在产品文案中说明。
2. **无服务端 moderation**：Codex 读取 `turn/moderationMetadata` 做展示过滤；DSH 第三方插件没有等价数据。用「不自动发送 + 用户可编辑 + 本地保守过滤（长度、控制字符、密钥样式、`NO_PREDICTION`）」缓解。
3. **不可从日志审计/重放**：shipped 的 session-title 会把精确请求 append 成 log-only 事件；第三方插件不允许新增事件 type，所以预测请求只能进 `ctx.logger`。预测请求不是 loop 请求、不在「model-visible ⟺ logged」的 invariant 范围内（与官方 one-shot 的 compaction/title 同类）；tool 调用只产生本地错误回执、不执行任何工具，但审计能力仍缺失。

### 0.5 投入估算

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 Spike | 装上骨架，打通「回合结束 → 一次模型调用 → 通道 → 空输入显示 → Tab 入草稿」 | 0.5–1 天 |
| P1 MVP | 触发/缓存/取消/配置/建议条 UI/错误静默/i18n/冒烟测试 | 2–4 天 |
| P2 体验 | 内联 ghost 对齐、IME/快捷键打磨、采样、设置面板、README | 2–3 天 |
| P3 可选 | 上游化（真正的 composer decoration 扩展点 + `@Remote` + 审计事件） | 1–2 周（需改 dsh-repo） |

---

## 1. 需求定义与硬约束

### 1.1 交互定义

- 一轮对话结束后（assistant 已经答完、回合已关闭），在**空输入框**中展示一条系统预测的「用户下一条消息」。
- 用户按 **Tab**（或点击）接受 → 建议成为**可编辑草稿**，光标在末尾；**不自动发送**，也不需要额外确认发送。
- 用户继续打字、切换会话、开始新回合、或显式关闭 → 建议消失/作废。
- IME 组合输入期间隐藏建议。
- 帮助请求失败、无建议、成本超限时**静默**，绝不打断输入。

### 1.2 硬约束：完全不依赖服务端特殊接口

| Codex 依赖的服务端能力 | DSH 替代方案 | 是否新增服务端依赖 |
|---|---|---|
| `/wham/predictions/config`（远端开关/完整 prompt/采样率/思考级别） | 插件本地 `Config` + 代码内默认 prompt/常量；用户在 Settings/patch 改 | 否 |
| `experimentalPredictionMode`（inheriting fork：继承父会话 config/tools/历史）+ ephemeral fork + 结构化 turn | 不 fork、不进 agent loop：本地 `session.deriveMessages()` 组上下文 + 一次普通 `ctx.llm.stream()` | 否 |
| 服务端按 prediction 语义路由/思考级别 | 透传用户配置；默认沿用源会话 route，可覆盖 provider/model/reasoningEffort | 否 |
| 服务端 moderation metadata | 本地保守过滤 + 永不自动发送 | 否 |
| prediction 不计费的 billing 语义 | 无；如实计费，提供采样/关闭开关 | 否 |
| 服务端推送建议 | 本地 DSH Connection RPC（loopback + cookie 鉴权）长轮询 | 否（DSH 自带能力） |

唯一的外部调用是用户**本来就会用**的模型 provider chat completion，没有任何新增后端接口、没有特殊 query/header、没有服务端开关。

### 1.3 非目标（v1）

- 不做逐字符/逐词补全（Codex 也是整条下一消息预测）。
- 不做多候选、不做自动发送、不做跨会话推荐。
- 不改 agent loop、不新增 session 事件、不注册工具。
- 不做服务端遥测/训练信号上报。

---

## 2. 可行性证据总表

| # | 需要的能力 | DSH 机制 | 证据 |
|---|---|---|---|
| 1 | 一次独立的模型调用（不进 loop / 不执行工具 / 不写会话） | `ctx.llm.stream(GenerateOptions)`；传 `messages` + `tools` + `toolHistory`（继承前缀），tool-call 用统一错误 tool-result 拒绝；不经过 agent loop | 活体 `Service.listService('llm')`；源码 `packages/compaction/compaction-basic/src/summarizer.ts` 是同类 one-shot 范本 |
| 2 | 取会话历史/最新回合/当前路由/工具 | `session.deriveMessages()`、`session.snapshotEvents()`、`session.requestHeader()?.config/.tools`、`session.toolHistory()`、`ctx.sessions.get(id)` | 活体 `Service.listService('sessions')` 的 `Session` 类签名 |
| 3 | 回合结束时机 | `ctx.on('session/event', (session, event) => …)`，筛 `turn/end` + `reason.kind==='completed'` | 活体 Event 目录：`session/event` = "Post-commit, fire-and-forget append feed"；`turn/end` 是 `SessionEventMap` 成员 |
| 4 | Host → Client 结果下发 | `ctx.connection.rpc.handle('/followup-prompt', handler)`；Client `ctx.connection.rpc.call(...)` | 活体 Host `connection.rpc`；源码 `packages/client/connection/src/rpc-host.ts`、`src/client/rpc.ts`；本机第三方 bundle `ds-bot` 已用同机制注册 `/api/bot` fetch route |
| 5 | composer 内浮层/建议条 | slot：`conversation.input.overlay`（卡片内浮层）、`conversation.composer.dock`（卡片下方）、`conversation.input.dock`（卡片上方） | 活体 `Slots.listSubTree`；`ui-input-trigger` 是 overlay 的现成范例 |
| 6 | 读「输入框是否为空/是否运行中」 | slot 标准 props：`useInput(s=>s.draft/phase/attachmentIds)`、`useSession(s=>s.running/blank/awaitingFirstTurn)` | 活体 slot catalog 的 standardProps；0.2.1 安装产物 |
| 7 | 接受 → 可编辑草稿（不发送） | `inputActions.captureInsertion()` + `inputActions.insertText(text, span)`（一次可撤销）；回退 `inputActions.setDraft(text)`；`SessionInput.focus()` | 0.2.1 安装产物 `ui-conversation` client bundle；checkout `contract/input.ts:189-240` |
| 8 | 用户可改的配置 | Host `Config`（schemastery）+ `.volatile()` 字段 → Settings 自动表单写回 profile patch | 0.2.1 安装产物 `dsh-settings`；`ds-bot`/`ui-theme` 先例 |

### 2.1 命名与既有实现

**产品名与包名统一为 `dsh-followup-prompt`（Followup Prompt）**，对标 Codex 的 Composer Predictions。命名决策：

- 产品名：**Followup Prompt**（与工作区 `dsh-followup-prompt` 一致）。
- npm 包名：**`dsh-followup-prompt`**（2026-10-19 npm registry 实测 404，可用；也可用 `@<scope>/dsh-followup-prompt`）。
- 不再使用 `dsh-composer-predictions` 与 `dsh-composer-prediction` 两个旧名：前者虽也可用，但统一到 followup-prompt 避免两套命名；后者已被第三方插件占用（避免混淆）。
- 发布前再跑一次 `npm view dsh-followup-prompt` 校验占用。

标识符统一约定（包名 / Loader row / 插件导出 / 通道 / slot id / locale NS / 配置文件 / 端点 / 组件名）：

| 位置 | 值 |
|---|---|
| npm 包名 | `dsh-followup-prompt`（或 `@scope/dsh-followup-prompt`） |
| Loader row id | `followup-prompt` |
| Host 插件 `export const name` | `followup-prompt` |
| RPC channel | `/followup-prompt` |
| RPC endpoints | `suggestions/wait`、`suggestions/dismiss`（可选 `suggestions/get`） |
| slot 注册 id | `followup-prompt` |
| locale namespace | `followup-prompt` |
| 自持久化配置文件（若采用） | `$DSH_HOME/followup-prompt.json` |
| 组件名 | `FollowupSuggestionOverlay`；菜单行/建议条同理 `followup-prompt` 前缀 |
| 代码内名词 | 单个建议对象用 `suggestion`；产品概念「预测」可继续写作 prediction |

**同功能实现参考**：npm 上的 `dsh-composer-prediction`（单数，v0.7.5，2026-10-18，MIT，作者 Amir Bazylkhanov）功能与本方案相近（回合结束后生成下一条用户消息、overlay ghost、Tab 接受、自带 Settings 页）。该包 README 是外部资料、未独立验证；本方案**不使用它的包名**，仅作先例参考。

### 2.2 参照路径：Codex 的 inheriting fork 与我们的取舍

Codex 的预测实现（本机 checkout `/Users/keli/Downloads/projects/codex`，commit `1b89beea82`）值得参考的不是 fork 本身，而是它如何让预测请求复用父会话的请求前缀：

- **inheriting fork**：从父会话继承 effective config、tools、完整历史，请求基本是「父会话下一次请求的逐字节翻版 + 末尾一条预测指令」，以最大化 prompt-cache 复用；子线程 `ephemeral: true`（不落盘）、`excludeTurns: true`（UI/API 不显示 turn）。
- **关键事实**：预测请求继承 tools（不是无工具调用）；预测 turn 禁止 auto-compaction；`excludeTurns` 不裁剪模型上下文；专用 `thread/prediction/*` API 尚未实现，桌面端用 fork+turn 绕行。
- **对我们唯一有用的结论**：预测请求的形态 = 父会话下一次请求的前缀 + 尾部指令；tools 要在请求里，但绝不能执行。

### 2.3 为什么本方案不 fork

DSH 0.2.1 已有用户可见的持久 fork（会话菜单/快捷键/消息尾部分支），但**没有 ephemeral fork**：fork 子会话会持久化、进列表、启动真实 agent（工具会执行、compaction 会跑），用它做「一次提示」会带来会话污染与副作用。而 DSH 的一次请求是会话日志的纯函数，所以不需要 fork 也能复刻父请求前缀：

- 上下文：`session.deriveMessages()`（含 system prompt）+ `session.requestHeader().config/.tools` + `session.toolHistory()`。
- 追加一条预测 user message，用 `ctx.llm.stream()` 发出，不进入 agent loop。
- 模型若调用 tool：保留 tools 定义、统一回错误 tool-result 让它继续，但**绝不执行**（§4.4.1）。

一句话：**Codex 用 ephemeral fork 换「前缀 + 不落盘」；DSH 用「继承请求」同时拿到这两点，且不需要新的会话生命周期。** fork 作为独立功能在 DSH 已内置；若未来要做真实 turn 式预测，才需要上游 ephemeral agent。详细取舍见 §13。

### 2.4 已否决的路线（避免返工）

| 方案 | 否决原因 |
|---|---|
| `@Remote` + Typert + `ctx.remote` 自定义命名空间 | 客户端只 `$mount` **构建期生成的 strict descriptor**，第三方 bundle 无生成链；手写 descriptor 无文档、随版本漂移 |
| 自定义 SessionEvent 把结果推给前端 | `Session.append()` 无法写 `ignorable: true`；持久化读取遇到未知事件会**拒绝 reopen 会话**；`appendPluginRecord()` 仅限 DSH experimental 包 |
| session projection + `wire.view` | 预测在 `turn/end` 之后才完成，没有新的 session event → projection 不会重新发布 |
| 替换 `conversation.composer`（chain） | 语义是「临时业务接管」，需要复刻整个 InputBar（Lexical 所有权、附件、快捷键、i18n），不现实 |
| 往 contenteditable 注入 DOM / MutationObserver | Lexical reconciler 会覆盖，破坏选区/undo/IME；违反插件规范 |
| 裸 `webServer.register` 路由 | 鉴权要自己复刻；用 `connection` 的通道/路由才是正解 |

---

## 3. 总体架构

```
┌────────────────────────────── Host（Node 进程） ──────────────────────────────┐
│  followup-prompt (function plugin)                                        │
│                                                                               │
│  session/event ──► turn/end(completed) ──► (可选预生成)                         │
│  session/event ──► turn/start / session/disposed ──► abort + invalidate        │
│                                                                               │
│  Predictor                                                                     │
│   ├─ 上下文：session.deriveMessages() 全量（预算内）+ 指令                       │
│   ├─ 路由：session.requestHeader().config（可被 Config 覆盖）                    │
│   ├─ 调用：ctx.llm.stream（继承 tools/toolHistory；不进 loop / 不执行工具 / 不写日志） │
│   ├─ tool-call：统一错误 tool-result 回执，最多 maxToolRejectRounds 轮             │
│   ├─ 过滤：归一化 + 长度 + 控制字符 + 密钥样式 + NO_PREDICTION                    │
│   └─ 缓存：Map<sessionId, Entry{turn,state,suggestion,dismissed,controller}>    │
│                                                                               │
│  Channel：ctx.connection.rpc.handle('/followup-prompt')                    │
│   POST /followup-prompt/suggestions/wait     ← 长轮询（<=15s）              │
│   POST /followup-prompt/suggestions/dismiss  ← 用户接受/关闭后作废           │
└───────────────────────────────────────────────────────────────────────────────┘
                     ▲ 同源 loopback，DSH 浏览器 cookie 鉴权（自动）
                     │ unary JSON（{type:'client-request',rpcId,method,payload}）
┌────────────────────────────── Client（Web 页面） ─────────────────────────────┐
│  followup-prompt client half（lazy-CJS 插件）                              │
│                                                                               │
│  slot: conversation.input.overlay（或 conversation.composer.dock）              │
│   ├─ useSession(s=>s.running / s.blank / s.awaitingFirstTurn)                  │
│   ├─ useInput(s=>s.draft / s.phase / s.attachmentIds)                          │
│   ├─ inputActions（accept 写入草稿）                                            │
│   └─ 状态机 idle → requesting → shown → accepted / hidden                       │
│                                                                               │
│  Tab capture 监听（严格条件）→ captureInsertion + insertText + dismiss RPC       │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 数据面协议（Host 半边）

| endpoint | 请求 payload | 成功 value | 说明 |
|---|---|---|---|
| `suggestions/wait` | `{ sessionId: string, turn?: number, waitMs?: number }` | `{ suggestion: string \| null, turn: number \| null, reason?: string }` | 长轮询：命中缓存立即返回；否则等生成完成/超时/abort。`turn` 用于客户端校验非过期回合 |
| `suggestions/dismiss` | `{ sessionId: string, turn?: number }` | `{ ok: true }` | 用户接受或关闭 → 同一回合不再返回（进程内标记） |

错误语义：业务失败一律 `{ ok:false, error:{ code, message, details } }`；handler 抛异常 = HTTP 500（客户端按传输失败静默处理）。`reason` 取值：`unknown-session` / `no-completed-turn` / `stale` / `sampled-out` / `no-route` / `timeout` / `aborted` / `busy` / `error`。

---

## 4. Host 半边设计

### 4.1 触发与生命周期

```js
export const name = 'followup-prompt'
// rpc.handle 内部走 owner.webServer.register，所以调用方 fiber 要注入 webServer；
// 若改用 /api 的 exact Fetch 路由（connection.fetch.register）则不需要 webServer。
export const inject = ['connection', 'llm', 'sessions', 'webServer']
export function apply(ctx, config) { /* … */ }
```

| 事件 | 动作 |
|---|---|
| `session/event` → `turn/end` 且 `reason.kind === 'completed'` | 删除该会话旧 entry；若 `prefetchOnTurnEnd` 则后台预生成（默认关） |
| `session/event` → `turn/start` | `abort()` 该会话 in-flight + 清缓存（旧建议作废） |
| `session/event` → 其他类型 | 忽略（不要在这里做重活） |
| `session/disposed` | abort + 删除该会话全部状态 |
| 插件卸载 / HMR | 插件级 `AbortController.abort()`；`ctx.effect` 撤销 channel、监听器、定时器 |
| 客户端请求 abort | 只减少 waiter；最后一个 waiter 离开时 abort 生成（除非预生成） |

**不要**用 `agent/turn-stopping`：它是 serial 且被 agent loop await 的「回合关闭前」veto/steer 钩子，在这里 await 预测会延迟回合关闭，且此时 `reason` 尚未确定。

### 4.2 上下文构建（继承前缀模式）

关键规则：**默认全量 `deriveMessages()`**，与父会话下一次请求的前缀一致；只有超过输入预算时才从最旧的人类 user 消息边界裁剪（保留开头 system/developer 头），**绝不在 tool/result 或 assistant tool-call 中间切**，否则 provider 会因孤儿 tool call 报 400。

```js
const FOLLOWUP_INSTRUCTION = [
  'You predict the next message the human user will type in this coding conversation.',
  "Read the conversation above, including the assistant's most recent answer.",
  'Do not call any tool. Reply with ONLY the predicted message text, in the language the user has been using.',
  'Keep it to one short message. No quotes, labels, markdown fences, or explanations.',
  'If a confident prediction is impossible, reply with exactly: NO_PREDICTION',
].join('\n')

function buildRequestMessages(session, cfg) {
  const all = session.deriveMessages()                 // 模型可见历史（含 system prompt）
  if (all.length === 0) return null
  // 默认全量；maxInputChars > 0 且超预算时才裁剪（降级模式，会牺牲缓存命中）
  const history = cfg.maxInputChars > 0 ? trimToBudget(all, cfg.maxInputChars) : all
  if (history === null) return null
  // 尾部一条 user 指令；不引入第二个 system 槽，不破坏前缀
  return [...history, { role: 'user', content: [{ type: 'text', text: cfg.prompt || FOLLOWUP_INSTRUCTION }] }]
}

// trimToBudget：保留开头 system/developer 头；从某个「人类 user 消息」开始取后缀；
// 绝不切在 tool/result 或 assistant tool-call 中间；找不到安全切点返回 null（放弃预测）。
```

`maxInputChars` 默认 20000（按字符估算，可选 `tokenMeter` 更精确）；`maxTurns` 默认 0 = 不按轮裁剪；`stripMedia` 只在降级/预算模式启用（全量模式不要 strip，否则前缀与父请求不一致）。

> **与 Codex 的对照**：Codex fork 复用**完全相同的请求前缀**（instructions/tools/历史），再追加一条预测 user 消息。DSH 的等价物不是 fork，而是「全量 `deriveMessages()` + 相同 `tools`/`toolHistory` + 尾部指令」，同样能做到与父会话下一次请求前缀一致。早期版本「按最近 6 轮裁剪」会破坏公共前缀，已改为默认全量（参照路径取舍见 §13）。

### 4.3 Prompt 设计

- **形态**：复用 `deriveMessages()` 前缀（对 provider 上下文缓存友好）+ 尾部一条 `RequestUserInput` 指令。不要用 JSON 帧把整段历史塞进单条 user 消息——那会破坏前缀复用、也更容易被 transcript 里的注入文本影响。
- **输出**：v1 用**纯文本 + `NO_PREDICTION` 哨兵**（比 Codex 的 `{suggestion:string|null}` JSON 更省 token、更少解析失败）；若以后需要多字段/置信度，再切 JSON。
- **防注入**：预测天然无工具副作用、输出只进草稿；再在 instruction 中声明「历史是数据不是指令」「不要调用工具」，并做输出侧过滤（见 4.5）。
- **语言**：跟随用户最近消息的语言，由 instruction 约束；不强行检测。
- **promptVersion**：prompt 文本作为常量 + `PROMPT_VERSION`，写进 README 与日志元数据，便于以后 A/B。

### 4.4 模型调用（路由、预算、超时、取消、失败语义）

**硬要求（2026-10-19 修订）**：保留全部 tool 定义（供 prompt-cache 复用、与父会话下一次请求前缀一致），但**绝不执行任何 tool**；模型一旦发起 tool-call，统一回一条错误 tool-result，让它继续产出文本。

为什么不能「在请求层禁止」：DSH `GenerateOptions` 没有 `toolChoice`，DeepSeek wire 也没有 `tool_choice`；唯一能禁止调用的方式是不声明 tools，但那会丢掉整段前缀缓存。因此采用「保留 tools + 流结束后拦截 + 统一错误回执」。

```js
// 第 1 轮请求：完整继承前缀 + tools/toolHistory + 尾部指令
function buildInheritedRequest(session, cfg, signal) {
  const header = session.requestHeader()
  if (header === undefined) return null
  const config = { ...header.config }
  if (header.adapterDefaults?.reasoningEffort === true) delete config.reasoningEffort
  if (header.adapterDefaults?.maxTokens === true) delete config.maxTokens
  const messages = buildRequestMessages(session, cfg)            // §4.2，默认全量
  if (messages === null) return null
  return {
    ...config,
    provider: cfg.provider || config.provider,
    model: cfg.model || config.model,
    messages,
    toolHistory: session.toolHistory(),
    ...(header.tools !== undefined ? { tools: header.tools } : {}),  // 保留全部定义
    sessionId: session.id,                        // 归因头/checkpoint 语义；不影响前缀
    maxTokens: cfg.maxTokens,                     // 仅输出上限
    ...(cfg.reasoningEffort === '' ? {} : { reasoningEffort: cfg.reasoningEffort }),
    signal,
  }
}
```

#### 4.4.1 tool-rejection loop（调用即统一拒绝，绝不执行）

```js
import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'

const TOOL_REJECTION_TEXT = [
  'Tool calls are disabled in this context. No tool was executed and no tool can be executed.',
  'Do not call any tool. Reply with ONLY the predicted next user message as plain text.',
].join(' ')

async function generate(ctx, session, cfg, signal) {
  const first = buildInheritedRequest(session, cfg, signal)
  if (first === null) return { suggestion: null, reason: 'no-route' }
  let messages = first.messages
  for (let round = 0; round <= cfg.maxToolRejectRounds; round += 1) {
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream({ ...first, messages })) assembler.push(chunk)
    } catch (error) {
      ctx.logger?.debug?.(`followup-prompt: stream failed: ${String(error)}`)
      return { suggestion: null, reason: 'error' }
    }
    if (signal.aborted) return { suggestion: null, reason: 'aborted' }
    const blocks = assembler.blocks()
    const calls = blocks.filter(block => block.type === 'tool-call')
    if (calls.length === 0) {
      if (assembler.finish.kind !== 'stop') return { suggestion: null, reason: assembler.finish.kind }
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      return { suggestion: normalizeSuggestion(text, cfg) }
    }
    // 达到上限仍想调用 tool → 放弃（静默）；绝不执行
    if (round === cfg.maxToolRejectRounds) return { suggestion: null, reason: 'tool-rejected' }
    // 统一错误回执：assistant(tool-call) + 每个 call 一条 isError tool-result
    messages = [
      ...messages,
      createAssistantMessage({
        content: calls,                            // 只放 tool-call blocks，不放 reasoning/thinking
        source: { provider: first.provider, model: first.model },
      }),
      ...calls.map(call => createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: cfg.toolRejectionText || TOOL_REJECTION_TEXT }],
        isError: true,
      })),
    ]
  }
  return { suggestion: null, reason: 'tool-rejected' }
}
```

必须遵守的 10 条约束（与 §13 的参照结论一致）：

1. **配对完整**：assistant(tool-call) 后**立即**跟每个 callId 的 tool-result；DeepSeek serializer 会校验并抛 `tool calls need immediate results` / `tool result has no matching call`（`packages/llm/llm-deepseek/src/serialize.ts:160-180`）。不要夹带 user 消息或文本。
2. **不夹带 reasoning/thinking**：合成 assistant 消息只放 `tool-call` blocks；thinking 段通常需要 provider 签名（replayState），合成历史里省略才安全。
3. **每个 call 一条 result**：多调用按顺序配对；重复 callId 直接放弃本次预测（避免非法历史）。
4. **错误回执统一**：所有 tool、所有轮次同一段文本（`toolRejectionText` 可覆盖），`isError:true`；文案明确「工具禁用 / 未执行任何工具 / 不要调用工具 / 直接输出预测文本」。
5. **每轮都带同一份 `tools` + `toolHistory`**：否则第二轮前缀不一致、tool-result 可能与声明失配。
6. **轮次上限**：`maxToolRejectRounds` 默认 1（最多 2 次模型请求）；仍调用则返回 null（静默），禁止无限重试。
7. **共享总 deadline**：`timeoutMs` 覆盖所有轮次；每轮 `maxTokens` 小。每轮重发前缀，缓存命中时增量只有 assistant tool-call + 错误文本。
8. **finish 语义**：`tool-calls` finish 或 blocks 含 tool-call 都走拒绝；`max-tokens` 时 `BlockAssembler` 自动丢弃 tool-call（`packages/llm/llm/src/assembler.ts:128-150`），按失败处理。
9. **绝不执行**：tool 参数只用于构造消息，不读取、不执行、不落盘。
10. **assemble 防御**：`assembler.blocks()` 对「未闭合的未知 block」会抛错（`packages/llm/llm/src/assembler.ts:152-160`）；把解析放在 try/catch 内按 `error` 静默。

> **若走真实 agent（fork/ephemeral）而非 one-shot**：不用手搓消息，在子 agent ctx 上注册 `ctx.tools.guard(() => TOOL_REJECTION_TEXT)`——guard 的 reason 会被 materialize 成 `Error: <reason>` 的 `isError` tool-result，循环继续（`packages/core/tools/src/index.ts:1135-1160,1521-1548`；先例 `packages/subagent/subagent/src/structured.ts:112-121`）。但 fork 的持久化/工具执行/compaction 问题仍在（见 §13）。

| 维度 | 建议值 | 说明 |
|---|---|---|
| 超时 | `timeoutMs` 默认 15000（上限 30000） | `AbortController + setTimeout`；**覆盖所有 tool-rejection 轮次** |
| 输出 | `maxTokens` 默认 160 | 只限输出 |
| 输入 | `maxInputChars` 20000；`maxTurns` 默认 0（不裁剪） | 默认全量以对齐父请求前缀；仅超预算时裁剪（牺牲缓存） |
| 工具调用 | `maxToolRejectRounds` 默认 1；`toolRejectionText` 默认空（用内置统一文案） | 保留全部 tools；调用即回错误 tool-result；绝不执行 |
| 思考级别 | `reasoningEffort` 默认空（跟随 provider 默认）；可配 `off/low/high/max` | 非 DeepSeek provider 可能拒绝 `off` → 失败静默；README 提示 |
| 路由 | 默认沿用源会话 `route`；可覆盖 `provider/model` 成更便宜的小模型 | 不强制另配 |
| 并发 | 每会话 1 个 in-flight；全局 `maxConcurrent` 默认 2 | 超限返回 `busy` |
| 重试 | **不重试**（与 Codex 一致） | 失败静默；provider 连续失败可加 60s 冷却 |
| 采样 | `sampleRate` 默认 1.0；用 `hash(sessionId, turn)` 确定性抽样 | 同一回合多次请求结果一致，可缓存 |

> **Codex 对照**：Codex 的预测请求**继承父会话 tools**（为了 prompt-cache 复用），且 fork 禁止 model override（始终用父会话模型）；`reasoningEffort` 由远端 `prediction_reasoning_effort` 逐 turn 覆盖（fork 启用 `reasoning_effort_override`），并且预测 turn 禁止 auto-compaction（超限直接失败）。本方案现在同样保留 `tools` 定义（但不进 loop、不执行工具）：模型一旦调用，按 §4.4.1 回一条统一错误 tool-result 让它继续；这比「不传 tools」多保留整段缓存前缀，代价是可能多一次模型请求。reasoning effort 由 Config 字段达到同样效果；compaction 对我们无影响（只读 `deriveMessages`）。

### 4.5 输出归一化与安全过滤

```js
function normalizeSuggestion(raw, cfg) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```[a-zA-Z]*\n?|```$/g, '').trim()          // 去 fence
  if (text.length >= 2) {
    const first = text[0], last = text.at(-1)
    if ((first === '"' && last === '"') || (first === '`' && last === '`')) text = text.slice(1, -1).trim()
  }
  if (text === '' || text.includes('NO_PREDICTION')) return null
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null   // 控制字符
  if (/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(text)) return null // 密钥样式
  return text.length > cfg.maxSuggestionChars ? text.slice(0, cfg.maxSuggestionChars) : text
}
```

- 图片/文件块：继承前缀模式**默认原样保留**（strip 会破坏与父请求的前缀一致）；只有降级/预算模式才 `stripMedia` 成文本占位。
- 建议永不自动发送，且用户可编辑——这是最后一道人工闸门。

### 4.6 缓存、去重、取消

```
Map<sessionId, Entry>
Entry = { turn, state: 'running'|'done', suggestion: string|null,
          dismissed: boolean, at: number,
          controller, promise, waiters }
```

1. key = `[sessionId, turn]`（turn 是数字，不要用 seq：seq 会因压缩/替换变化）。
2. `turn === 最新 completed 回合` 且 `state==='done'` → 立即返回（含 `suggestion:null`，避免反复计费）。
3. `state==='running'` → 复用同一 promise（多窗口/重试去重）。
4. `dismissed` → 不再返回。
5. 新回合 `turn/start` 或新的 `turn/end(completed)` → 删除旧 entry。
6. TTL（`cacheTtlMs` 默认 10 分钟）+ `session/disposed` 清理，Map 上限 = 活跃会话数。
7. 不持久化：重启后重新生成即可，避免写盘/隐私面。
8. 客户端请求 abort 只减 waiter；最后一个 waiter 离开才 abort 生成（预生成模式除外）。

### 4.7 结果通道与端点实现

```js
const CHANNEL = '/followup-prompt'

ctx.effect(() => {
  const dispose = ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
    try {
      const request = parseRequest(payload)          // 线链路边界：必须校验
      if (request === null) {
        return { ok: false, error: { code: 'followup-prompt/bad-request', message: 'invalid payload', details: {} } }
      }
      if (endpoint === 'suggestions/wait') {
        return { ok: true, value: await waitForPrediction(request, signal) }
      }
      if (endpoint === 'suggestions/dismiss') {
        return { ok: true, value: dismiss(request) }
      }
      return { ok: false, error: { code: 'followup-prompt/bad-endpoint', message: `unknown endpoint ${endpoint}`, details: {} } }
    } catch (error) {
      return { ok: false, error: { code: 'followup-prompt/internal', message: String(error?.message ?? error), details: {} } }
    }
  })
  return () => { void dispose() }
}, 'followup-prompt: rpc channel')
```

机制要点（均已在活体 0.2.1 与源码核对）：

- channel 必须匹配 `^/[A-Za-z0-9._~-]+$` 且**不能是 `/api`**（`/api` 被 Typert Gateway 独占 intercept）。
- `rpc.handle` 在 `connection` 内部注册一条 prefix web route，**先做 Host/Origin 信任检查 + 浏览器 cookie 鉴权**（401/403），再解析 `{type:'client-request', rpcId, method, payload}`；handler 返回 `{ok,value}|{ok:false,error}` 被包成 `{type:'server-response', rpcId, result}`。
- 仅 unary、仅 POST/JSON；预测结果小，长轮询足够。
- 客户端断线/abort 会 abort handler 的 `signal`；Host 侧还有 `timeoutMs` + 插件级 abort 兜底。
- 第三方合法性先例：本机已安装的第三方 bundle `ds-bot` 的 Host 半边 `inject` 就包含 `connection`，并用 `connection.fetch.register('/api/bot')` 注册了鉴权路由；`rpc.handle` 是同一机制上的 RPC 封装。
- **注册路径二选一（重要）**：`connection.rpc.handle` 内部用 `owner.webServer.register(route)` 挂 prefix 路由，因此调用方 fiber 必须 **在 `inject` 里声明 `webServer`**（本机既有插件也记录了这一点：该路径需要 webServer，否则注册抛错）。若不想依赖 webServer，可改用 `/api` 下的 exact Fetch 路由：

  ```js
  ctx.connection.fetch.register({
    path: '/api/followup-prompt/rpc',   // 必须在 /api 下，自动走 /api 鉴权
    methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json()      // 自己校验 payload
      return Response.json(await handle(body, request.signal))
    },
  })
  ```

  客户端相应改用普通同源 `fetch('/api/followup-prompt/rpc', {method:'POST', ...})`（而不是 `rpc.call`）。两条路都只用公共 Service；选定一条后服务端与客户端必须配套，不要混用。

### 4.8 Config（schemastery，全部 `.volatile()`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `provider` / `model` | `''` | 空 = 沿用源会话 route；成对配置 |
| `reasoningEffort` | `''` | `'' \| off \| low \| high \| max` |
| `maxTokens` | `160` | 输出上限 |
| `timeoutMs` | `15000` | 2s–30s；覆盖所有轮次 |
| `maxTurns` | `0` | 0 = 不按轮裁剪（推荐，保前缀）；>0 仅降级模式使用 |
| `maxInputChars` | `20000` | 超预算时从最旧人类回合头部裁剪（会牺牲缓存） |
| `maxToolRejectRounds` | `1` | 保留 tools 时模型调用 tool 的拒绝轮次上限（0 = 直接放弃） |
| `toolRejectionText` | `''` | 统一错误回执文案；空 = 内置文案 |
| `maxSuggestionChars` | `400` | 建议长度上限 |
| `stripMedia` | `false` | 默认不 strip（strip 会破坏与父请求的前缀一致）；仅降级模式启用 |
| `sampleRate` | `1.0` | 确定性采样 |
| `prefetchOnTurnEnd` | `false` | 回合结束即预生成（为所有活跃会话付费，慎用） |
| `cacheTtlMs` | `600000` | 内存缓存 TTL |
| `maxConcurrent` | `2` | 全局并发 |
| `excludeSubagents` | `true` | 子代理会话不预测 |
| `uiMode` | `'dock'` | `dock \| ghost`（客户端读同一 Config 的映射或另立字段） |
| `prompt` | `''` | 高级：覆盖默认指令 |

0.2.1 的 Settings 会为 volatile 字段自动生成表单并写回 profile patch；用户也可直接改 `cordis.patch.yml`。注意 patch 覆盖是**整体替换 config**，覆盖时要把全部字段重述。

> **设置页实现注意（0.2.x，存在两种说法，实现前需实测）**：0.2.1 的 `dsh-settings` 代码里确实有「对含 volatile 字段的 loader entry 生成表单」的逻辑；但本机既有第三方插件报告 shipped Plugins 页面是只读的，且 `ctx.settings` 在 0.2.x 只是 loader 条目的表单层，**不再提供 0.1.x 的 `register(ns, schema)` live namespace**。因此：
> - v1 先保证「改 patch 能生效」；
> - 需要产品化设置页时，采用既有插件验证过的做法：Host 自己持久化一个小 JSON 到 `$DSH_HOME/followup-prompt.json`，Client 注册 `settings.section` 一页，通过 RPC 读写——**不要依赖 `ctx.settings.register(ns, schema)`**。

### 4.9 可观测与隐私

- 只记非敏感元数据：`ctx.logger.debug({sessionId, turn, provider, model, ms, inputTokens, cacheReadTokens, rounds, toolRejected, chars, outcome})`；**不记录 transcript 内容**。
- 预测结果仅在 Host 进程内存 + 浏览器内存中，进程退出即消失。
- README 明确：启用后会把当前会话历史发给**该会话正在使用的 provider/model**（与正常聊天同一信任域）；若覆盖了 provider/model，则数据会流向新 provider，用户需自行确认。
- 无遥测上报；接受率统计如需，只能本地日志（第三方插件做不了正式 telemetry）。

---

## 5. Client 半边设计

### 5.1 模块形态与注册

安装式 bundle 的 browser half 是 lazy-CJS 模块（不需要 tsdown，手写 `client.js` 合法；多文件时用 esbuild 打单文件即可，`ds-bot` 就是这样）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-followup-prompt',
  factory(require) {
    const React = require('react')            // 只允许模块表 baseline；无 JSX，用 React.createElement
    const h = React.createElement
    const NS = 'followup-prompt'

    // …组件与状态…

    return {
      inject: ['slots', 'sessions', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'followup-prompt: dictionaries')
        ctx.inject(['slots', 'sessions', 'connection'], (scope) => {
          const rpc = (endpoint, payload, signal) =>
            scope.connection.rpc.call('/followup-prompt', endpoint, payload, signal)
          scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
            name: 'conversation.input.overlay',
            id: 'followup-prompt',
            order: 100,                          // slash-menu/command-popup/feedback 之后
            locale: NS,
            inject: (sessionId) => ({
              rpc,
              sessionId,
              // 仅点击接受时需要把焦点还给 composer；拿不到 conversation 服务时组件会跳过 focus
              focusComposer: () => {
                const actx = scope.sessions.scope(sessionId)
                const conversation = actx?.get('conversation')
                conversation?.input?.for?.(actx)?.focus?.()
              },
            }),
          }, FollowupSuggestionOverlay))
        })
      },
    }
  },
})
```

### 5.2 状态机与触发条件

```
idle ──(running true→false 且 !blank 且 !awaitingFirstTurn 且 draft==='' 且 attachments=0 且 phase='plain')
      ──> requesting（abort 旧请求；rpc('suggestions/wait', {sessionId})）
requesting ──(suggestion 非空且仍满足条件)──> shown
requesting ──(null/失败/abort/超时)────────> idle（静默）
shown ──(draft !== '' / running / 切会话 / 卸载)──> hidden（abort；不 dismiss）
shown ──(Tab 或点击)──> accepted（写入草稿 + dismiss RPC + 清空）
```

- 「打开已结束的会话」= catch-up：组件挂载时满足条件就直接发一次 `suggestions/wait`；Host 按 `[sessionId, latestCompletedTurn]` 缓存去重，重复请求免费命中。
- 不要在每次按键时请求；只在「空闲 + 空输入」的边沿请求一次。
- 不要请求 `blank`/`awaitingFirstTurn` 的新会话（没有 completed turn）。

### 5.3 呈现方案（两档，按配置切换）

**P1：`conversation.composer.dock` 建议条**（默认，最稳）

- 位置：composer 卡片下方，独占一行；无建议时返回 `null` 不占位。
- 内容：`✨ 预测：<suggestion>` + 右侧 `Tab 接受` 提示 + 关闭按钮。
- 优点：不动 composer 内部、不遮挡 placeholder、无需像素对齐；缺点：不像 Codex 内联 ghost。

**P2：`conversation.input.overlay` 内联 ghost**（更像 Codex，需真机校准）

- overlay anchor 是 `position:absolute; inset:0 0 auto; height:0`，位于卡片顶部；ghost 用绝对定位对齐编辑器首行（0.2.1 参考常量：卡片 `padding-top:8`、输入区 `padding:4px 8px 0 14px`、行高随字号）。
- 重叠处理：用卡片底色 token 的 chip 背景遮住 host 自带 placeholder（或把建议渲染成带底色的 pill），深浅色都要验。
- 风险：DSH 版式升级即需回归；`accessory`/附件栏出现时会偏移；多行/字号变化需重新校准。**保留 `conversation.composer.dock` 作为一键降级。**
- 对齐方法（既有插件已验证的思路）：不要写死 `top/left` 常量；在 `useEffect` 里读取真实 `[data-composer-input]` 元素的 `getBoundingClientRect()` 与 `getComputedStyle`（font-family/size/line-height/padding），把 ghost 的字体与位置克隆过来；ghost 可见期间临时隐藏 native placeholder 并在隐藏时恢复。这样 padding/字号/换行跟随 composer，抗版式变化能力更好。
- 明确不做：改 contenteditable DOM、`::after` 注入、替换整个 composer。

### 5.4 接受与关闭交互

**Tab 接受（核心）**：`document` capture 阶段 keydown，五重条件全部满足才拦截；成功后才 `preventDefault + stopPropagation`。

```js
function onKeyDown(event) {
  if (event.key !== 'Tab' || event.isComposing || event.keyCode === 229) return
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  if (!visible || composing) return true                     // 建议可见 + 非 IME 组合
  const target = event.target
  if (!(target instanceof Element) || target.closest('[data-composer-input]') === null) return
  // TODO(hardening): 若 slash/command 弹层打开（activeElement 有 aria-expanded 等）则让行
  event.preventDefault()
  event.stopPropagation()
  accept()
}
document.addEventListener('keydown', onKeyDown, true)
```

**写入草稿**（不发送、一次可撤销；带版本 CAS）：

```js
function accept() {
  const text = suggestion
  const actions = props.inputActions
  let applied = false
  if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
    const span = actions.captureInsertion()
    applied = actions.insertText(text, span)                 // draftRev 不一致/不可编辑时返回 false
  }
  if (!applied) actions.setDraft(text)                       // 回退：整段替换
  focusComposer?.()                                          // 点击接受时把焦点还给 composer；Tab 场景通常不需要
  void rpc('suggestions/dismiss', { sessionId }).catch(() => {})
  setSuggestion(null)
}
```

- **绝不调用 `submit()`**（`InputActions.submit` 是唯一发送入口）。
- **不拦 Enter**：Enter 是 host 保留键（提交/插话/换行/IME 候选确认）。
- 点击接受：按钮 `onMouseDown={e => e.preventDefault()}` 保持编辑器焦点，再执行同一 `accept()`。
- 关闭：点击 ×；Esc 可选（仅当建议可见且非 IME 时消费，并 dismiss）。
- IME：组件内监听 document 级 `compositionstart`/`compositionend`（target 落在 `[data-composer-input]` 时更新本地 `composing`，compositionend 后保留 10ms 宽限）；组合期间隐藏 ghost/建议条并禁止接受；keydown 里再加 `event.isComposing || event.keyCode === 229` 双保险。
- 失效：草稿非空、`running` 变 true、`phase !== 'plain'`、切换会话、组件卸载 → abort 请求/隐藏。

### 5.5 设置面板

- **v1（推荐）**：不做自定义 UI。Host `Config` 的 volatile 字段自动出现在 **Settings → Plugins → 本插件** 的表单里，写回 profile patch；用户也可改 patch。
- **v2（可选）**：注册 `settings.general.item` 一行（开关 + 模型覆盖），通过 0.2.1 client 服务 `ctx.configForms.get('<patch entry id>')` 读/写（记得 `ctx.locale.register` 文案）。
- 需要每个会话临时开关（不持久化）时，可放 `conversation.input.left/right` 一个小按钮，通过 RPC 发 `suggestions/enable`。

### 5.6 i18n / a11y / 样式

- 文案全部走 `ctx.locale.register(NS, {zh, en})` + slot 注册选项 `locale: NS`，组件用 `t(...)`；另在 `locale/en.json`、`zh.json` 写 `meta.title/meta.description` 供插件管理器展示。
- 无障碍：建议容器 `role="status" aria-live="polite"`；Tab 接受有文字提示；IME 期间不打断。
- 样式：只用 `--dsw-alias-*` token（如 `--dsw-alias-label-caption/secondary`、`--dsw-alias-bg-*`、`--dsw-alias-border-l2`）；不引组件库、不写死颜色；深色/浅色都验。

---

## 6. 打包、安装与升级

### 6.1 包结构

```
dsh-followup-prompt/            # 或 npm 作用域名
├── package.json                        # dsh.bundle.patch + dsh.client + exports + files + peerDeps + engines
├── cordis.patch.yml                    # 插入 1 行 Host entry（browser half 由 dsh.client 自动发现）
├── host/
│   ├── index.js                        # name/inject/Config/apply（函数插件，禁止 default export）
│   ├── config.js                       # schemastery field schema + resolve/validate
│   ├── prediction.js                   # 上下文构建 + llm.stream + 归一化/过滤
│   ├── cache.js                        # entry/in-flight/TTL/采样
│   └── channel.js                      # connection.rpc.handle 端点实现
├── client.js                           # lazy-CJS（或 src/client/*.js + esbuild 产出）
├── locale/{en,zh}.json                 # meta.title/description
├── icon.svg                            # 原创或可再分发授权
├── README.md                           # 安装、配置表、隐私/计费、已知限制
└── verify/                             # 不随包发布：桩驱动冒烟脚本
```

### 6.2 清单要点

```jsonc
// package.json（关键字段）
{
  "name": "dsh-followup-prompt",
  "type": "module",
  "exports": {
    ".": "./host/index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["host/", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"],
  "peerDependencies": { "@deepseek-ai/schemastery": "*" },
  "engines": { "dsh": ">=0.2.0 <0.3.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale",
                           "@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

> 包名：用 **`dsh-followup-prompt`**（或 `@<scope>/dsh-followup-prompt`）；发布前用 `npm view <name>` 校验。**不要用单数 `dsh-composer-prediction`**——npm 上已被同功能第三方插件占用（见 §2.1）。`dsh.client.inject` 只是包级信息边（预取/HMR），不决定激活顺序。

```yaml
# cordis.patch.yml —— 只插 Host row；config 全字段写全（patch 覆盖是整体替换）
- insert:
    - id: followup-prompt
      name: 'dsh-followup-prompt'
      config:
        enabled: true
        provider: ''
        model: ''
        # …（见 4.8 全字段）
```

- Host 若要 `import '@deepseek-ai/schemastery'`（Config 需要），**必须用真实目录安装**（tarball/npm/git），不能直接用本地目录：
  - `install_bundle` 传本地目录 = pnpm `link:` 符号链接；Node 按 realpath 解析，Host 代码会从 workspace 往上找 `node_modules`，`@deepseek-ai/*` 解析失败。
  - 用 `pnpm pack` 得到 `.tgz` 再安装（或发布 npm/git），安装后是 profile 内真实目录，可沿 `$DSH_HOME/profiles/node_modules` 闭包解析到 252 个 `@deepseek-ai/*` 包。
  - 若想本地目录直装：Host 半边保持**零 bare import**（手写配置校验、不导出 `Config`），代价是没有自动 Settings 表单。

### 6.3 安装与回滚（建议先在可丢弃的测试 profile 验证）

1. `cd dsh-followup-prompt && pnpm pack` → `.tgz`。
2. `plugin_manager` → `install_bundle`，`target` 用 `.tgz` 绝对路径（需 `danger-full-access` 批准；会写 profile 的 `package.json`/lock，可能 HMR 激活，替换已装包需重启）。
3. `cordis_inspect_query` 无审批核对：`Config.listConfigs({name:'dsh-followup-prompt'})` 出现 schema/值 = Host row 已激活。
4. 页面刷新后 `Slots.listSubTree` 看 `conversation.input.overlay`/`conversation.composer.dock` 是否出现本插件 id。
5. 手动跑一个完整回合，按 §7.2 清单验证。
6. 回滚：`plugin_manager remove_bundle`；核对 profile patch 未被意外改写；必要时重启。

### 6.4 版本兼容策略

- `peerDependencies` 用 `*`（学 `ds-bot`），`engines.dsh` 设 `>=0.2.0 <0.3.0`。
- 所有对 0.2.1 私有实现（client 的 `data-composer-*` 属性、overlay 版式常量）的依赖都要集中在少量常量/适配函数里，便于升级时一处修复。
- 持有 `sampleRate`/`enabled` 这类可远程关闭的开关（patch 或 Settings 下发），出问题可让用户立即关掉。

---

## 7. 验证计划

### 7.1 已完成（离线，无安装、无 profile 变更）

- `node --check` 通过；package.json/locale JSON/YAML 合法；`pnpm pack --dry-run` 清单正确。
- 桩驱动冒烟（本地 `verify/` 冒烟脚本）：Host 注册 channel/listener、turn/end 恰好触发一次调用、缓存命中、dismiss、坏请求错误码；Client factory id、locale 注册、slot 注册参数、inject face、accept 调 `setDraft`。
- 活体核对：Host `llm`/`sessions`/`connection` Service、`session/event`、`agent/turn-stopping`；Client `conversation.input.overlay`/`composer.dock` 的 standardProps 与注册选项。
- 注意：这些是语法/装配/契约检查，**不是**真机行为验证。

### 7.2 真机验证清单（P0/P1 必做）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 安装后 Host row active，`Config.listConfigs` 有本插件 schema | 无诊断错误 |
| 2 | 发一个问题，等回答结束 | 控制台/log 出现一次预测请求（debug），无 UI 报错 |
| 3 | 空输入框 | 出现建议（建议条或 ghost）；不遮挡/不破坏 placeholder |
| 4 | 按 Tab | 建议文本进入输入框成为草稿；**不发送**；可继续编辑；undo 一次撤销（若用 insertText） |
| 5 | 继续打字 | 建议消失，不影响输入 |
| 6 | 切换会话再切回 | 不串会话；旧请求被 abort |
| 7 | 输入法组合输入（中文） | 组合期间建议隐藏；组合结束后恢复 |
| 8 | 新开会话/空会话 | 不发无意义请求（或请求快速返回 null），不显示建议 |
| 9 | 关闭开关（Settings/patch） | 不再产生模型请求 |
| 10 | 断网/模型报错 | 静默，无 toast/报错；输入不受影响 |
| 11 | 多窗口同一会话 | 不重复计费（in-flight 去重） |
| 12 | 卸载插件 | row/slot 消失；无残留监听器报错 |
| 13 | 模型尝试调用 tool | 不执行任何工具；统一错误回执后继续产出文本；超过 `maxToolRejectRounds` 静默放弃 |
| 14 | 观察日志 | 每次预测记录 `rounds/toolRejected`；不记录 transcript |

### 7.3 本次未能活体验证的点（实现前先核对）

1. 客户端 `conversation.input.for(actx).focus()` 与 `inputActions.captureInsertion/insertText` 的内部实现：已从 0.2.1 安装产物确认存在，但未在运行页面上实际调用；实现时先用 `Slots.listSubTree` + 手动 console 验证，组件已保留 `setDraft` 回退。
2. Tab 与 Lexical 的竞争、`[data-composer-input]` 在 0.2.1 的实际命中、命令弹层打开时 Tab 的归属：需真机验证；失败则退回「只点击接受」。
3. ghost 在 0.2.1 版式下的像素对齐、深浅色、附件栏/多行场景：需真机校准；不通过就默认用建议条。

### 7.4 升级回归清单

- DSH 升级后：`Slots.listSubTree` 核对 slot 名/standardProps 是否仍存在；`data-composer-input` 是否仍在；ghost 像素对齐；`inputActions.captureInsertion/insertText` 是否仍在；`connection.rpc` 契约是否变化。
- 任何一项变化 → 走降级路径（建议条 → 关闭 `uiMode` → 关闭插件）。

### 7.5 预测请求前缀缓存 A/B（P0 必做）

先验证「继承请求」是否真的拿到 provider 前缀缓存，再决定是否保留全量历史/工具继承：

| 组 | 请求 | 预期 |
|---|---|---|
| P0-1 | 全量 history + `header.tools` + `toolHistory` + 尾指令（本方案） | `cacheReadTokens` 接近父会话上一请求的 prompt 大小 |
| P0-2 | 全量 history，但不带 tools（旧路线） | 若命中显著下降 → 证明 tools 在前缀关键位置 |
| P0-3 | 裁到最近 6 轮 + tools | 只命中 system+tools 头（或更少），验证不应默认裁剪 |

记录每次请求的 `usage.cacheReadTokens`/`inputTokens`；再观察「预测之后父会话下一条消息」的 cacheReadTokens 是否覆盖到最新 assistant 回复（判断预热效应）。判据：P0-1 明显优于 P0-2 → 保留 tools 继承；差异 <5% → 可降级为无 tools 的兜底路径。

---

## 8. 风险清单

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | 本地目录直装导致 Host 的 `@deepseek-ai/*` 解析失败 | 高（已验证机制） | 装不上/加载失败 | 用 `.tgz` 安装；或 Host 零 bare import |
| 2 | 额外计费（无 prediction 免费语义） | 确定 | 用户成本 | 总开关/采样率/超时/输入裁剪；产品文案明示 |
| 3 | 隐私：会话内容进模型请求 | 确定 | 合规/信任 | 与正常聊天同一 provider；不发明文新 provider；可关闭；不落盘 |
| 4 | Tab 与 Lexical/命令弹层竞争 | 中 | 快捷键被吃掉/误接受 | capture 严格条件；让行弹层；接受成功才 preventDefault；真机验证 |
| 5 | ghost 像素对齐随版式漂移 | 中 | 视觉错位 | 默认 dock 建议条；ghost 可配置关闭；常量集中 |
| 6 | client API 漂移（useInput/inputActions/overlay props） | 中 | 功能失效 | 只用已确认的标准 props；启动时特性检测；失败静默 |
| 7 | 长轮询在真实页面的 keep-alive/断线行为 | 低 | 偶发拿不到建议 | 超时 + 客户端 abort；必要时退回短轮询 `suggestions/get` |
| 8 | 非 DeepSeek provider 对 `reasoningEffort:'off'` 不支持 | 中 | 该 provider 下永远无建议 | 默认空；失败静默；README 提示按 provider 能力配置 |
| 9 | 第三方不能写请求日志 → 不可审计/重放 | 确定 | 可观测性差 | 已知限制；日志记非敏感元数据；上游化时补事件 |
| 10 | 本地插件在 workspace sandbox 之外运行 | 确定 | 信任边界 | 只读会话、只做模型调用、不写用户文件；代码公开可审计 |
| 11 | 插件管理器安装需要完整权限批准 | 确定 | 安装阻塞 | 文档写清；提供 `.tgz`/npm 两种安装路径 |
| 12 | 版本兼容（connection rpc 契约尚未 stable） | 低 | 升级后失效 | `engines` + peer `*` + 特性检测 + 可远程关闭开关 |
| 13 | 模型反复调用 tool | 中 | 多次请求/成本上升/拿不到建议 | `maxToolRejectRounds` 默认 1；总 deadline；prompt 明确「不要调用工具」；失败静默 |
| 14 | 合成的 assistant(tool-call)+tool-result 历史在非 DeepSeek provider 上被拒 | 低 | 该 provider 下 tool-call 分支失效 | 真机验证 pi-ai/Anthropic；失败则降级为「tool-call 即放弃」 |
| 15 | 缓存收益未达预期 | 中 | 输入成本高于收益 | §7.5 实测；采样/开关/按预算裁剪 |

---

## 9. 里程碑与工作量

### P0 — 可行性 Spike（0.5–1 天）

- 用本地骨架生成 `.tgz`，装到测试 profile。
- 打通：Host 收到 `turn/end` → 打印一次 `llm.stream` 调用 → Client 请求通道拿到字符串 → 建议条显示 → Tab 调 `setDraft` 入草稿。
- 产出：真机截图/日志证据；确认 Tab/Lexical/IME 行为。
- 备选加速：Client 交互（slots 注册、Tab/IME、草稿写入）可以先做成一个**动态 Cordis 包**（`cordis_define`/`cordis_run`）在页面里现场验证，无需打包安装；它刷新即失效、只适合 Spike。注意动态包的服务注入走 guard 白名单，Host 侧预测仍以正式 bundle 验证为准。

### P1 — MVP（2–4 天）

- Host：完整触发/裁剪/prompt/归一化/缓存/取消/采样/并发/Config/日志；tool-rejection loop（保留 tools、统一错误回执、绝不执行）。
- Client：建议条 UI、状态机、Tab/点击接受、IME、i18n、错误静默。
- 打包：`package.json`/patch/README/locale/icon；冒烟脚本；安装/卸载验证。
- 验收：§7.2 清单 1–14 全过。

### P2 — 体验提升（2–3 天）

- 内联 ghost（overlay）与像素校准；`uiMode` 切换。
- 设置面板（Settings 自动表单已可用；可选 `settings.general.item`）。
- 输出质量迭代：prompt 版本、采样、语言、长度；接受率本地统计。
- 文档：README（安装/配置/隐私/限制）+ 升级回归清单。

### P3 — 可选产品化（上游化，1–2 周）

见 §10。

---

## 10. 如果产品化：上游化路线（可选项）

独立 bundle 的上限是「只能消费既有 slot、不能写 session log、无正式遥测」。如果验证有效、希望默认内置给所有用户，建议迁到 dsh-repo 上游：

1. **Host**：新增 `packages/followup-prompt`，用 `@Remote` + Typert codegen（替代 `connection.rpc`），预测请求记 log-only session 事件（像 `session-title-llm-request` 一样可审计），可选 `wire.view` 把预测投影给客户端。
2. **Client**：给 `ui-conversation` 增加官方 **composer suggestion/decoration 扩展点**（新 slot 或 `ctx.composerSuggestions` 服务），由 InputBar 在 Lexical 文本原点渲染真正的 ghost text（处理 placeholder/IME/滚动/多行），而不是插件自己做绝对定位。
3. **产品语义**：官方预测调用可争取类似 Codex 的免计费/采样语义（需要服务端配合——这超出本方案「零服务端接口」的约束，属于产品决策）。
4. 迁移面：Host 的「预测服务」和 Client 的「composer 呈现」从 v1 起就拆成两个薄层，迁移只替换通信与 UI 挂载两处。
5. **可选：ephemeral fork**：若产品希望预测以「真实 turn」形式运行（工具可执行/可中断等），才需要上游 ephemeral agent；v1 不做，判断依据见 §13。

---

## 11. 关键 API 速查

| 目的 | API | 位置 |
|---|---|---|
| 监听回合结束 | `ctx.on('session/event', (session, event) => …)`，`event.type === 'turn/end'` | 活体 Host Event |
| 取活体会话 | `ctx.sessions.get(sessionId)` | 活体 Host Service `sessions` |
| 模型可见历史 | `session.deriveMessages(): Message[]` | 同上 `Session` 类 |
| 最新完成回合 | `session.snapshotEvents()` 尾部向前找 `turn/end`（遇到 `turn/start` 即未完成） | 同上 |
| 当前路由 | `session.requestHeader()?.config` → `{provider, model}` | 同上 |
| 继承前缀所需 | `session.requestHeader()?.tools` + `session.toolHistory()` | 同上 `Session` 类 |
| 一次性模型调用 | `ctx.llm.stream({provider, model, messages, tools, toolHistory, maxTokens, sessionId, signal, …})` | 活体 Host Service `llm` |
| tool-call 拒绝回执 | `BlockAssembler` + `createAssistantMessage` + `createToolResultMessage`（`@deepseek-ai/dsh-llm`） | 0.2.1 `packages/llm/llm/src/{assembler,message}.ts` |
| 真实 agent 的 tool 拒绝 | `ctx.tools.guard(() => 统一错误文本)`（scoped 到该 agent） | `packages/core/tools/src/index.ts:1135-1160` |
| Host→Client 通道 | `ctx.connection.rpc.handle(channel, handler)` | 活体 Host Service `connection` |
| Client→Host 调用 | `ctx.connection.rpc.call(channel, endpoint, payload, signal)` | 0.2.1 client connection |
| composer 浮层槽位 | `conversation.input.overlay`（list/session） | 活体 `Slots.listSubTree` |
| composer 下方建议条 | `conversation.composer.dock`（list/session） | 同上 |
| 读草稿/运行态 | slot props `useInput` / `useSession` | 活体 slot catalog standardProps |
| 接受草稿 | `inputActions.captureInsertion()` + `insertText(text, span)`；回退 `setDraft(text)` | 0.2.1 安装产物 |
| 焦点归还 | `conversation.input.for(actx).focus()`（可选） | live client service |
| 配置 | `export const Config = z.object({...})`，字段 `.volatile()` | 0.2.1 `dsh-settings` |
| 安装 | `plugin_manager install_bundle` + `.tgz` 绝对路径 | live plugin-manager |

---

## 12. 参考与证据

- 三份调研报告（本工作区）：
- 方案的直接证据来源：DSH 0.2.1-rc.2 源码 checkout（上列 API/行为均已按源码核对）+ 活体安装版（下列路径）；早期外部调研报告已不可用，不再引用。
- 关键源码（0.2.1 checkout）：`packages/session/session-title-llm/src/index.ts`、`packages/session/session-title/src/index.ts`、`packages/client/connection/src/rpc.ts`、`src/rpc-host.ts`、`src/client/rpc.ts`、`packages/client/ui-conversation/src/client/contract/{input,slots}.ts`、`packages/client/ui-input-trigger/src/client/index.ts`。
- 活体安装版（0.2.1-rc.2）：`app.asar/dsh/node_modules/@deepseek-ai/dsh-client-connection/`、`dsh-client-ui-conversation/`、`dsh-client-ui-input-trigger/`、`dsh-settings/`。
- 已安装第三方 bundle 先例：`/Users/keli/.dsh/profiles/desktop/node_modules/ds-bot/`（打包形态、Host `inject`、`connection.fetch.register('/api/bot')`）。
- 同功能既有实现（仅作先例参考）：[dsh-composer-prediction](https://github.com/Amir-Bazylkhanov/dsh-composer-prediction)（npm `dsh-composer-prediction@0.7.5`，2026-10-18；外部资料，仅作先例参考）。
- **参照路径（fork）**：Codex 的 inheriting fork 机制与测试见 `/Users/keli/Downloads/projects/codex`（commit `1b89beea82`）的 `app-server/tests/suite/v2/thread_fork.rs`、`core/src/thread_manager.rs`；DSH fork 能力的源码级调研保留在 `research/fork-core.md`、`research/fork-api-ui.md`、`research/fork-prediction.md`。Fork 不参与本方案实现（取舍见 §13）。
- 插件规范：安装版 skill `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`（`references/host-plugin.md`、`ui-plugin.md`、`practices.md`、`templates/decoration/*`）。

---

## 13. 参照路径：fork 会话能力（为什么本方案不依赖它）

> 结论：Fork 只是实现 composer predictions 的一条参照路径。DSH 0.2.1 已内置**持久 fork**，但没有 ephemeral fork；本方案不 fork，改用「继承请求」。本节保留判断依据与后续可选方向，不展开 fork 的内部实现。

### 13.1 Codex vs DSH vs 本方案

| 维度 | Codex inheriting fork | DSH 用户级 fork（已 shipped） | 本方案（继承请求） |
|---|---|---|---|
| 目的 | 预测前缀复用 + 不落盘 | 用户可见的会话分支 | 预测前缀复用 |
| 持久化 | 预测线程 ephemeral 不落盘 | 持久化、进列表、可继续 | 无会话、不落盘 |
| 工具 | 继承 tools，靠 prompt 约束不执行 | 真实 agent，工具会执行 | 继承 tools 定义，调用统一错误拒绝、不执行 |
| compaction | 预测 turn 禁止 | 会跑 | 不进 loop，不触发 |
| 实现成本 | 上游特性 | 0（已内置，但与预测目标不匹配） | 插件内即可 |
| 结论 | 参照 | 作为独立产品功能可用，预测不用 | **采用** |

### 13.2 如果以后需要 fork 作为独立功能

- **DSH 已内置**：会话行菜单/快捷键 `Cmd+Alt+F`（Desktop）/`Cmd+Shift+F`（Web）、消息尾部 branch；无需插件实现。
- **插件里加自定义入口**：客户端挂 `sidebar.workspaces.session.menu.item` / `conversation.chat.turnTail` / `assistant-actions` slot，或调用公开 client `ctx.sessions.fork`；Host 插件可直调 `ctx.sessionController.fork`。注意 core `ctx.sessions.fork()` 只 announce 不持久化，不要用于产品级分叉。
- **Codex 式 ephemeral inheriting fork**（真实 turn 式预测）：需要上游给 agent-loop 增加「不持久化、不发布、不执行工具、跳过 compaction」的 ephemeral agent；这是独立的 1–2 周上游项目，不属于本插件 v1。

### 13.3 证据

fork 能力的源码级调研（实现拆解、产品语义、与预测的可行性对比）保留在：
- `research/fork-core.md` — session core 的 fork/seed/repair/持久化；
- `research/fork-api-ui.md` — `session/fork` Host API 与两入口客户端 UX；
- `research/fork-prediction.md` — inheriting request vs ephemeral fork 的可行性/成本对比。

