# DSH fork 式预测调研：现状、可行路径、缺口与上游改动面

> **调研对象**：`/Users/keli/Workspace/personal/works/deepseek-harness`（只读 checkout），版本 **`0.2.1-rc.2`**（根 `package.json:3`，`packages/core/agent-loop/package.json:4`、`packages/core/session/package.json:4`；git HEAD `687f282e86`，2026-10-19）。运行中的 DSH Desktop 也是 0.2.1-rc.2，源码与活体同代。
> **任务**：判断 composer-predictions 在 DSH 里如何实现 / 是否值得实现 Codex 式 **inheriting fork / ephemeral fork**，以及上游最小改动面。
> **参考方案**：`dsh-composer-predictions-plan.md` §0、§2.2、§2.3、§4.2、§4.4（本文对其中若干断言做源码级修正，见 §6.4）。
> **证据约定**：`file:line` 均相对 checkout 根目录；行号为上述 checkout 的实际行号。凡无直接源码/笔记/test 支撑的结论标 **「未证实」** 或 **「推断」**。
> **关于 skill**：任务提到的已安装 skill `cordis-plugin-development` 不在本会话的 skill catalog 中，本机 `~/.dsh` 也没有 skills 目录；插件边界部分改用仓库内 `AGENTS.md`、`docs/architecture.md`、`docs/user/develop/framework/service.md`、`docs/cookbook/extension-cookbook.md`、`docs/api-gateway.md` 与 `packages/*/README.md` 取证。
> **一句话结论**：DSH 0.2.1-rc.2 **没有** ephemeral session / ephemeral agent / fork 式预测概念；但「一次请求 = 会话日志的纯函数」使得**第三方插件今天就能复刻父会话的完整请求前缀**（路线 B），既不需要 fork、也不产生任何会话副作用。Codex 式 C 的额外收益主要是“隔离不污染”，而这恰好是 B 天然具备的——因此 **推荐 B（插件层继承式请求）+ A 兜底，不建议为 v1 做上游 C**；若产品化，C 的最小改动集中在 agent-loop 的 publish/persist 分支，约 1–2 周。

---

## 0. 结论速览（每条附关键证据）

1. **一次模型请求是一个可从日志复刻的纯函数**：loop 把请求装配成 `{...EpochHeader.config, messages: session.deriveMessages(), toolHistory: session.toolHistory(), tools: EpochHeader.tools, sessionId, signal}`，system prompt 是派生历史（surface node 0 的 `system/message`），不是独立 `instructions` 字段。证据：`packages/core/agent-loop/src/agent.ts:616-703`；`packages/core/session/src/index.ts:912-922,953-957,984-1005`；`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md:17-31`；`docs/architecture.md:124`。
2. **插件的 `ctx.llm.stream()` 可以传 `tools` / `toolHistory`**，且与 loop 走同一条 adapter 投影路径（`projectToolUpdates`、图片/文件投影）。证据：`packages/llm/llm/src/types.ts:529-571`；`packages/llm/llm/src/index.ts:1107,1166`；`packages/compaction/compaction-basic/src/summarizer.ts:120-163`（官方 compaction 摘要调用就带 tools+toolHistory）。
3. **DSH 没有 `promptCacheKey` / `cache_control` / `instructions` / `toolChoice` 的调用面**：`GenerateOptions` 里不存在这些字段，DeepSeek wire 请求也没有缓存提示；DeepSeek 的缓存是 provider 侧「前缀不变即可复用」的自动缓存，DSH 只是在 usage 里映射 `cache_read_input_tokens`。证据：`packages/llm/llm/src/types.ts:529-571`；`packages/llm/llm/src/call-config.ts:16-34`；`packages/llm/llm-deepseek/src/serialize.ts:57-169`；`packages/llm/llm-deepseek/src/wire-types.ts:1-40`；`packages/llm/llm-deepseek/src/translate.ts:36`；`packages/llm/llm-deepseek/README.md:181,195`。
4. **缓存复用有真机证据**：未变前缀 → `cacheReadTokens > 0`，且官方 e2e 断言了「追加 tools 后仍复用前述会话输入」。证据：`packages/core/agent-loop/tests/request-cache.e2e.ts:18-25,85-95`；`apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:136-163`；`packages/llm/llm-deepseek/tests/runtime.e2e.ts:358-440`。
5. **最大风险在「漏传 tools」**：官方文档明说 tool declaration 变化会从首个受影响 token 起中断复用。路线 A（不传 tools）因此可能丢掉整段前缀缓存，而不只是“少量命中”——具体断点位置取决于 provider 内部序列化顺序，**未证实**，需真机 A/B 测。证据：`packages/core/agent-loop/README.md:164`；`packages/llm/llm-deepseek/README.md:181`。
6. **`ctx.agents.create()` 一律持久化**（mount 了 persistence 时），并会 `enter`+`announce` session/agent，进入 `ctx.sessions.list()` → 进会话列表 API；只有 agent-loop 的发布路径会挂写句柄。证据：`packages/core/agent-loop/src/index.ts:650-670,688-706,715-746,750-790`；`packages/core/session/src/index.ts:1045-1048`；`docs/subsystems/persistence.md:226`。
7. **`ctx.sessions.fork()` 本身不持久化**：它只 `create()`（enter+announce），没有 `persistence.create`，因此产生一个“live 但不落盘”的幽灵会话；它会出现在会话列表（列表合并 `ctx.sessions.list()`），点开 resume 会失败（代码路径推断）。官方用户级 Fork（Remote `session/fork`）走的是 `ctx.agents.create`，所以**会**持久化。证据：`packages/core/session/src/index.ts:1111-1120,1380-1395`；`packages/api/session-controller/src/commands.ts:227-300`；`packages/session-query/session-query/src/corpus.ts:62-86`；`packages/api/session-controller/src/list.ts:132-163`。
8. **隐藏会话只有一个先例：`origin: 'subagent'`**（客户端树过滤；API 路由拒普通访问；父会话持有 `subagentCatalog` projection）。没有 ephemeral 标志，没有会话删除能力（只能 archive）。证据：`packages/core/session/src/types.ts:110-119`；`packages/subagent/subagent/src/child-agent.ts:135-160`；`packages/client/ui-workspace/src/client/tree.ts:238-254`；`packages/api/session-controller/src/agent.ts:115-126`；`packages/client/ui-workspace/README.md:222`。
9. **第三方 Host 插件在本进程内、沙箱之外运行，没有服务注入白名单**；可 `inject` `llm/sessions/agents/sessionQuery/sessionPersistence/...`，可调 `ctx.sessions.fork`、`ctx.agents.create`、`ctx.agentLoop.createAgent`。它**不能**：构建期生成 `@Remote` 描述符、阻止 agent-loop 持久化、删除已持久化会话；但可以用 public API 拼出「几乎 C」的有污染版本。证据：`packages/boot/plugin-manager/README.md:31`；`docs/user/develop/framework/service.md:5,21-32`；`docs/cookbook/extension-cookbook.md:75`；`docs/api-gateway.md:100-118`；`packages/core/session/src/index.ts:478-510`；`packages/core/session/src/known-event-types.ts:15-20`。
10. **推荐**：在现有插件里把路线 A 升级为 **B（cache-aligned inheriting request）**：`session.deriveMessages()` 全量（默认不裁剪）+ `session.requestHeader().config/.tools/.adapterDefaults` + `session.toolHistory()` + 尾部一条预测指令，用 `ctx.llm.stream()` 发出；用 `usage.cacheReadTokens` 做真机验证；不进入 agent loop 就没有工具执行/compaction/遥测/列表/持久化任何副作用。C 只在官方产品化时做，最小改动集中在 agent-loop 的“不持久化 + 不发布（或发布后过滤）”分支（§5）。

---

## 1. 一次模型请求在 DSH 里是怎么装配的（源码级）

### 1.1 装配主链

一次 step 的请求装配全部在 `packages/core/agent-loop/src/agent.ts`：

| 阶段 | 位置 | 做了什么 |
|---|---|---|
| 回合/步骤骨架 | `agent.ts:298-398` | `turn/start`、claim inbox、per-step 循环、`turn/end`（`finally` 中写，`agent.ts:384-391`） |
| pre-step 组装 | `agent.ts:267-288` | `loopCtx.systemPrompt.assemble(...)` 渲染 system prompt + tools；`agent/pre-step` waterfall 可改写/拒绝本批消息 |
| 工具变更判定 | `agent.ts:290-295` | 比较当前 assembly tools 与已记录 header 的工具（`headerEquals`） |
| 请求前准备 | `agent.ts:564-613` | 从 `AgentOptions`/折叠后的 `requestHeader()` 得到 route 种子 → `agent/request` waterfall → `llm.prepareCall()` materialize adapter 默认值 |
| 提交 prompt/用户消息 | `agent.ts:415-440` | `systemPrompt.project()` 决定 `system/message` append/replace；本批 `user/message` 只准入一次 |
| 构建请求 | `agent.ts:616-703` | 记录 `request/header`（`initial`/`resume`/`change`/`series`）、`request/context`；`deriveMessages()` + `toolHistory()` + tools + sessionId + signal；`markAgentLoopRequest` |
| 派发 | `agent.ts:453-460` | `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`，逐 chunk 消费 |
| 工具执行 | `agent.ts:549-555` | assistant 消息含 tool-call 时 `executeToolCalls(...)`；否则 step 结束 |

**请求体原文**（`agent.ts:695-703`）：

```ts
const request = markAgentLoopRequest(Object.freeze({
  ...header.config,
  messages: boundaryMessages,
  toolHistory: session.toolHistory(),
  ...header.tools !== undefined ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal,
}))
```

要点：

- 请求里**没有 `system` 字段**（deprecated / 由 system message 承载），没有 `instructions`、没有 `toolChoice`、没有 `promptCacheKey`。
- `messages` 是 `session.deriveMessages()` 的冻结快照（`agent.ts:688-694`）：先取数组，深冻结新出现的 message，再冻结数组。
- `tools` 来自 `EpochHeader.tools`（`canonicalHeader` 归一化：空数组缺省，`packages/core/session/src/request-header.ts:21-30`）。
- 请求是 loop 身份的（`markAgentLoopRequest`），供 `llm/stream` 监听者区分“对话请求”与“直接 one-shot”（`packages/llm/llm/src/call-config.ts:84-95`）。

### 1.2 `request/header` 事件与 `requestHeader()`

- 事件定义：`'request/header': { header: EpochHeader, reason, startsSeries? }`，log-only、非 surface 事件（`packages/core/session/src/types.ts:385-397`）。
- `EpochHeader` = `{ config: LlmCallConfig, adapterDefaults?, tools?: ToolSchema[], system?: never }`（`packages/core/session/src/types.ts:241-256`）。
- 写入规则：实例首个请求 `initial`，后续实例 `resume`，真实变化 `change`，显式声明新消息序列/替换后不变 `series`；只在 header 值变化或需要标记 series 时写（`agent.ts:626-651`；文档 `docs/subsystems/session.md:181-206`）。
- 读取：`Session.requestHeader()` 增量 fold 最近一次 `request/header`（`packages/core/session/src/index.ts:899-922`），纯离线版本 `foldRequestHeader()`（`request-header.ts:63-69`）；字段级相等 `headerEquals()`（`request-header.ts:32-52`）。
- `request/context`（route capacity / `systemPromptUpdate` mode）另存、不参与 header 相等（`types.ts:255-262`；`docs/subsystems/session.md:210`）。

**对预测的意义**：父会话“下一次请求的调用配置与工具声明”就折叠在 `requestHeader()` 里，插件读它即可；无需 fork 也能拿到与 loop 完全一致的 header 输入。

### 1.3 system prompt / “instructions”

- DSH 没有 Codex 的 `instructions` 顶层字段。**渲染后的 system prompt 是派生历史**：`system/message` 事件（surface node 0，以及 in-history 路由追加的后续 system 节点）经 `deriveMessages()` 成为 messages 里的 system-role message（`.agents/notes/.../2026-07-05-reconstructable-requests.md:25`；`docs/subsystems/llm-streaming.md:765`；`packages/core/session/README.md:58`）。
- loop 每 step 重新 assemble prompt 并投影：`SystemPromptProjection.project(rendered, {inHistory, startsSeries})` 决定 append 还是 replace 节点 0（`agent.ts:415-424`；`packages/core/agent-loop/src/runtime-context.ts:65-107`）。
- 因此 **“instructions 相同”在 DSH 等价于“deriveMessages() 开头的 system message 内容相同”**；这也意味着预测请求只要复用同一份 `deriveMessages()`，system prompt 自动一致。

### 1.4 tools 与 toolHistory

- `tools` 是 `PromptAssembly.tools`（`packages/core/system-prompt/src/index.ts:122-127`），由 tool registry 的 scoped 可见集 + `toolOrder` 装配（`system-prompt/src/index.ts:201-239,545-549,674`）。
- 动态工具更新（`deferLoading` / addition / removal）不重写 header 的工具列表时，靠 `Session.toolHistory()` 折叠历史 header 与 `developer/message`，供 `LlmRuntime` 在派发时投影出 provider 声明（`packages/core/session/src/index.ts:943-957`；`packages/core/session/README.md:185`；`packages/llm/llm/src/index.ts:1107`）。
- loop 把 `tools` 与 `toolHistory` 都放进请求（`agent.ts:698-700`），所以**预测请求要“逐字节翻版”父请求，这两者必须一起传**。

### 1.5 `deriveMessages()` 与消息投影

- `Session.deriveMessages()`：沿 surface 的 message-producing 事件序列投影，缓存、每次返回新数组、message 对象共享且深冻结；compaction 的 surface replace 会重建（`packages/core/session/src/index.ts:959-1005`；`docs/subsystems/session.md:668`）。
- 投影规则由 `deriveEventMessage(event)` 公开（`index.ts:1007-1015`），外部重建器用同一纯函数，保证“外部读法 = 缓存读法”（`.agents/notes/.../2026-07-05-reconstructable-requests.md:23`）。
- 插件内容变更走 `registerMessageProjection`（`packages/core/session/src/index.ts:1066-1078`），只改内容不改 surface 成员/消息身份。
- `turn/end` 是 append 后同步通知（`packages/core/session/src/index.ts:876-897`），且 loop 在 `finally` 里写完 `turn/end`（`agent.ts:384-391`）——因此**在 `turn/end` 的 `session/event` 监听里读到的最新 assistant 消息必然已经在日志里**，预测看到的 messages 与父会话“下一次请求时”的前缀一致（父会话下一次请求会在这个前缀后追加新用户消息）。

### 1.6 “可重建性”的官方契约

- 原则：**Model-visible ⟺ durably referenced/logged**。任何进入模型请求的内容必须能由日志 + 引用对象 + 固定代码版本逐字节重建；直接 one-shot（compaction 的 summarize、title 等）在不变式之外，只有 loop 的请求才打 `markAgentLoopRequest`（`.agents/notes/.../2026-07-05-reconstructable-requests.md:17-31`；`docs/architecture.md:124`）。
- 前缀缓存的稳定性是**推论**：追加式日志 + 每节点纯函数 → 只要 header 不变，后一请求就是前一请求的追加扩展（同上 note:19）。
- 关键测试：
  - `packages/core/agent-loop/tests/request-reconstruction.spec.ts:85,111,127,148,177,504,575,605,723`：step/turn append-extension、series 边界、compaction reshuffle、in-history prompt 追加、tool-schema 变化 re-baseline。
  - `packages/core/agent-loop/tests/request-freeze.spec.ts`、`request-error.spec.ts`（冻结与重试边界）。
  - 真机缓存：`packages/core/agent-loop/tests/request-cache.e2e.ts:18-25,85-95`（带 key 时首请求之后每请求 `cacheReadTokens > 0`，注释说明 provider cache-block 粒度约 64 tokens）。
  - `apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:136-163`（追加工具后 `added.body.messages.slice(0, before.length)` 与之前完全相等，且 `cached >= precedingInput - 256`）。
  - `packages/llm/llm-deepseek/tests/runtime.e2e.ts:358-440`（直接 `ctx.llm.stream` 手搓请求，重复相同 messages 得到 `cacheReadTokens > 0`）。

### 1.7 小结：为什么请求可以被“继承”

一次请求的输入被拆成两半：

- **历史**：`deriveMessages()`（含 system prompt、user/assistant/tool/developer 消息、runtime context 快照）——纯函数；
- **非历史状态**：`EpochHeader.config` + `EpochHeader.tools` + `toolHistory` —— 折叠自日志。

插件只要拿到 active `Session`，这两半都能只读拿到。**这就是“inheriting request”的全部输入**；fork 只是“让另一次请求在另一个会话里发生”的手段，不是拿到前缀的必要条件。

---

## 2. LLM 调用面：`GenerateOptions` vs loop 请求、DeepSeek 缓存语义

### 2.1 字段对照

`GenerateOptions`（`packages/llm/llm/src/types.ts:529-571`）：

| 字段 | 出现在 loop 请求? | 出现在插件 one-shot? | 备注 |
|---|---|---|---|
| `provider` / `model` | 是（来自 `header.config`） | 是 | 决定 cache domain（DeepSeek README:195） |
| `reasoningEffort` | 是（可被 adapter 默认值 materialize，`adapterDefaults`） | 可传 | 映射到 wire 的 `thinking`/`output_config`，不是 prompt token |
| `messages` | `deriveMessages()` | 插件自组 | 前缀主体 |
| `system` | **否**（loop 用 system message 历史） | 可传（title 等 one-shot 用） | `llm-streaming.md:765` |
| `tools` | 是（`EpochHeader.tools`） | **可传** | adapter 映射到 `tools` |
| `toolHistory` | 是（`session.toolHistory()`） | **可传** | 决定 in-history 工具更新投影 |
| `toolChoice` | **DSH 无此字段** | 无 | DeepSeek wire 也没有（`wire-types.ts:24-40`） |
| `instructions` | **DSH 无此字段** | 无 | 等价物是 system message |
| `promptCacheKey` | **DSH 无此字段** | 无 | provider 自动前缀缓存 |
| `temperature` / `maxTokens` / `stop` | 可出现在 `header.config` | 可传 | 生成参数，通常不进 prompt 前缀（推断） |
| `signal` | loop 的 turn signal | 插件自己的 AbortSignal | — |
| `sessionId` | 是 | 可选 | adapter 加 `x-deepseek-harness-session-id` 传输头（`adapter.ts:147`），并触发 checkpoint flush（`session-checkpoint-policy/src/index.ts:64-68`） |
| `purpose` | 否（`'compaction' \| 'session-title'` 封闭联合） | 只能传这两个值 | 没有 prediction 语义（`packages/llm/llm/src/types.ts:565-570`） |

`LlmCallConfig` 也只有 provider/model/reasoningEffort/temperature/maxTokens/stop（`packages/llm/llm/src/call-config.ts:16-34`），**不含 tools / 缓存键**；`tools` 属于 `EpochHeader` 而不是 call config（`packages/core/session/src/types.ts:241-256`）。

### 2.2 `ctx.llm.stream` 能传 tools（有官方先例）

- `LlmRuntime.stream(options)` 接受完整 `GenerateOptions`（`packages/llm/llm/src/index.ts:1166-1177`）。
- 派发前统一投影：文件→文本、图片→文本（不支持图片的路由）、**工具更新投影** `projectToolUpdates(messages, options.tools, modelInfo.toolUpdate, options.toolHistory)`（`llm/src/index.ts:1100-1110`）——即 loop 请求与插件请求走完全相同的 adapter 输入投影。
- 官方 one-shot 先例：
  - compaction 摘要调用直接传 `tools` + `session.toolHistory()` + `purpose: 'compaction'`，并刻意把指令作为最后一条 user message 以**复用 conversation 前缀缓存**（`packages/compaction/compaction-basic/src/summarizer.ts:26-32,110-163`；`compaction-basic/src/index.ts:238-256`）。
  - `experimental-auto-review` 用 `ctx.llm.stream` 发 review 请求，“never enters a Session log”（`packages/experimental/auto-review/src/index.ts:623-635`，inject 见 `:127`）。
  - session-title 走另一套：把精确请求以 in-tree 事件 `session/title-llm-request` 记进日志（`packages/session/session-title-llm/src/index.ts:51-57,267`；`packages/session/session-title/src/index.ts:547` 用 `isAgentLoopRequest` 区分）。

**结论**：`ctx.llm.stream` 完全支持 tools；官方 compaction 已经用“同一前缀 + 尾部指令”的方式复用缓存，这是路线 B 的直接范本。

### 2.3 DeepSeek provider 的缓存语义

- **没有显式缓存控制**：`WireRequest` 只有 model/stream/max_tokens/messages/system/thinking/output_config/temperature/stop_sequences/tools（`packages/llm/llm-deepseek/src/wire-types.ts:24-40`）；adapter 不发送 `cache_control`、也没有缓存 key；DSH 全仓 grep `promptCacheKey` / `prompt_cache` / `cache_control` 在 DeepSeek adapter 中均无。
- 缓存是 **provider 自动前缀复用**：官方 README 明说“未变 assembly 前缀有资格复用 DeepSeek 缓存，adapter 在 usage 里报告”；改变 model-route/prompt/schema/history/image-budget 都可能从首个受影响 token 起不能复用（`packages/llm/llm-deepseek/README.md:181`）；“改变 provider/model 即切换 cache domain”（`:195`）。
- usage 映射：`cache_read_input_tokens`→`cacheReadTokens`、`cache_creation_input_tokens`→`cacheWriteTokens`（`packages/llm/llm-deepseek/src/translate.ts:36`）；`TokenUsage` 是 disjoint 计数（`packages/llm/llm/src/types.ts:167-189`；`docs/subsystems/llm-streaming.md:336`）。
- 真机证据：重复相同请求 → `cacheReadTokens > 0`（`runtime.e2e.ts:400-410`，且该测试是 `ctx.llm.stream` 手搓请求，不经过 loop）；loop 多步/多回合每请求 `cacheReadTokens > 0`（`request-cache.e2e.ts:85-95`）；追加工具后仍复用前面内容（`dynamic-tool-cache.e2e.ts:136-163`）。

**对预测的推论**：DSH 对缓存唯一的杠杆是 **wire 请求前缀逐字节一致**。“相同 session / 相同 fork”本身不产生缓存，只有“相同 provider+model+prompt+tools 前缀”才产生缓存。

### 2.4 预测请求怎么和“父会话下一次请求”对齐

父会话下一次请求 = `header.config`（不变时）+ 新的 `deriveMessages()`（在现在的基础上追加一条 user message）+ `toolHistory`/`tools`（不变时）。因此预测请求应构造成：

```
[父会话当前 deriveMessages()]  +  [一条预测指令 user message]
```

并带同一份 `requestHeader().config`、`requestHeader().tools`、`session.toolHistory()`。这样预测请求是“父会话下一次请求的严格前缀 + 指令”，两边共享到最新 assistant 消息为止的完整前缀；父会话下一请求到达时，还能命中预测请求刚写入缓存的 assistant 回复段（推断，见 §2.5）。

具体对齐规则（路线 B）：

1. `const header = session.requestHeader()`；`const call = header?.config`。
2. 若 `header.adapterDefaults` 标记了 `reasoningEffort` / `maxTokens`，**删掉这两个字段**再传给 `ctx.llm.stream`，让 `resolveCallWithInfo` 重新 materialize 同一默认值（loop 的 `requestProposal()` 就是这么做的：`agent.ts:64-70,583-592`；LLM 侧 `llm/src/index.ts:908-942`）。直接传 header 里的值通常也得到同一 effective config（推断：wire 只取 effective 值）。
3. `messages = session.deriveMessages()`；**默认不裁剪**（裁剪会破坏与父请求的公共前缀，见 §2.5）。
4. `tools = header?.tools`；`toolHistory = session.toolHistory()`。
5. `maxTokens` 用预测预算（如 160）；`temperature`/`reasoningEffort` 建议与父会话一致或省略（避免输出风格漂移；对缓存影响未证实）。
6. `sessionId = session.id`（可选：带来 checkpoint flush 与传输头归因；不给也不影响前缀）。
7. 尾指令作为最后一条 user message；不要用 `system` 字段（会与 loop 请求不同构）。

### 2.5 缓存收益的边界（哪些是证据、哪些是未证实）

| 结论 | 状态 | 证据 |
|---|---|---|
| provider 自动按前缀复用，DSH 无显式 cache key | 已证实 | `llm-deepseek/README.md:181,195`；`wire-types.ts:24-40`；`runtime.e2e.ts:400-410` |
| 前缀追加（新消息/工具追加）不破坏已缓存前缀 | 已证实 | `request-cache.e2e.ts`；`dynamic-tool-cache.e2e.ts:136-163`；`agent-loop/README.md:164` |
| 改变 tool 声明会从首个受影响 token 起中断复用 | 已证实（仓库文档断言） | `agent-loop/README.md:164`；`llm-deepseek/README.md:181` |
| **漏传 tools（A 路线）导致整段前缀 miss** | **推断/未证实** | 取决于 provider 把 tools 放在 prompt 的哪个位置；Anthropic Messages 语义下 tools 在 system 前（外部协议知识），但 DSH 仓库没有记录序列化顺序。**必须真机 A/B 测 `cacheReadTokens`** |
| **把历史裁到最近 N 轮会丢失被裁掉之后的缓存命中** | **推断（高置信）** | 缓存是位置前缀；裁剪后保留的尾部处于新位置，只有 system+tools 头仍命中。官方 e2e 也只验证“原样前缀”的命中 |
| 预测请求写入的 assistant 回复段可被父会话下一请求命中 | **推断** | provider 磁盘缓存语义；DSH 文档未描述跨请求写回 |
| 更改 maxTokens/ temperature/reasoningEffort 不影响前缀缓存 | **推断** | 它们是生成参数；DSH 未记录其与缓存的交互 |
| 全量历史（不裁剪）是缓存最优 | **推断（机制上必然）** | 与 `agent-loop/README.md:164` 的“byte-identical 前缀”一致 |

> 因此，方案文档 §4.4 的“本方案不传 `tools`……代价是损失少量 prompt-cache 命中”**需要改写**：漏传 tools 是“可能整段 miss”的高风险项，而“裁剪到 6 轮”也会牺牲大部分缓存；两者都应该被实测数据决定。

### 2.6 one-shot 的“日志归属”差异（预测必须知道的副作用）

| 行为 | loop 请求 | 插件 `ctx.llm.stream` one-shot |
|---|---|---|
| 打 loop 标记 | 是（`markAgentLoopRequest`） | 否（`isAgentLoopRequest` 为 false） |
| `llm/stream` 监听者 | title/retry/checkpoint 等按请求语义参与 | title 跳过（`isAgentLoopRequest` 检查）；checkpoint 只按 `sessionId` flush；retry 不生效（它挂在 `agent/request-error`，`packages/llm/llm-retry/src/index.ts:1-6,243`） |
| 用量计入会话统计 | 是（`assistant/message.usage`） | 否；usage 只在 stream chunk/`BlockAssembler.usage`（`packages/llm/llm/src/assembler.ts:181-183`），需插件自己记录 |
| 日志可审计 | 是（request/header + 消息） | 否；第三方只能用 `ctx.logger`，或 `appendPluginRecord` 写 `plugin:*` ignorable 记录（见 §4.4） |
| provider 计费 | 正常 | 正常（无 prediction 免计费语义） |

---

## 3. Agent / Session 创建与生命周期

### 3.1 `ctx.agents.create` 全链（为什么它会持久化、会出现在列表）

`AgentRegistry`（`packages/core/agent/src/index.ts`）：

- 服务键 `ctx.agents`；`create(options)` 把调用方 context 作为 owner 交给工厂（`agent/src/index.ts:393-403`）。
- `CreateAgentOptions` 含：`sessionId`、`parentAgent`、`meta`（`cwd/parentSession/isSeeded/origin/delegationDepth/agentPreset`）、`inheritedEventCount`、`seed`、`agentOptions`、`signal`、`setup`（`agent/src/index.ts:70-121`）。
- `AgentHandle.dispose()` 停止 loop、等待退出、注销 agent、**从 store 移除 session**、卸载 scope（`agent/src/index.ts:147-161`）——注意它不删持久化文件（见 §3.3）。
- `AgentOptions` 只有 provider/model/reasoningEffort/maxTokens（`packages/core/agent/src/runtime-types.ts:26-35`）——**没有“禁用工具/不持久化/单步”等开关**。

AgentLoop 工厂实现（`packages/core/agent-loop/src/index.ts`）：

| 步骤 | 位置 | 语义 |
|---|---|---|
| `createAgent(ownerCtx, options)` | `:750-790` | `sessions.prepare(sessionId, {seed, meta, inheritedEventCount})` → 取持久化写句柄 → setup+发布 |
| `createStoredSession` | `:715-728` | **mount 了 `sessionPersistence` 就 `persistence.create(session.header, {inheritedEventCount})`**；没有后端才返回 undefined |
| `appendUnstoredSuffix` | `:734-746` | 发布前把构造 seed 一次性写入持久化句柄 |
| `publish` | `:650-670` | `sessions.enter(session)` → `agents.enter(agent)` → `sessions.announce(session)` → `agents.announce(...)` |
| `setupAndPublish` | `:790-820` | 组合 setup 提交 + 持久化 seed + publish |
| `resume` | `:843-950` | `persistence.open(id,'write')` → 读日志/补 interrupted closers → prepare → publish |

**结论**：只要装了持久化（Desktop 默认装），`ctx.agents.create` 创建的 session **必落盘**、必 announce、必出现在 `sessionQuery.listSessions()` / `ApiSessionList.list()` / 客户端 `api-session/added` 推送里。`packages/api/session-controller/src/index.ts:191-197` 对所有 `session/created` 发 `api-session/added`，`session/disposed` 发 removed。

### 3.2 `composeAgent` / preset / model selection

- `ApiSessionAgentController.composeAgent(presetId)`：解析 preset → 返回 `{agentPreset, setup}`；`setup` 在 agent 未发布时 `installSelection` 并 `presets.mount(agentCtx, id)`（`packages/api/session-controller/src/agent.ts:387-400`）。
- 普通创建/恢复都走它，所以 fork 子会话能复用源会话的 preset（`commands.ts:273,289`；`agent.ts:280,434,469,490`）。
- 会话 header 的 `agentPreset` 是持久字段，用于 resume 时重建同一套 tools/prompt（`packages/core/session/src/types.ts:121-130`）。

### 3.3 持久化策略：只有 agent-loop 发布路径会持久化

- `SessionStore` 自身不持久化：“Persistence is intentionally not implemented here — the agent lifecycle attaches a session-log writer to each published session's write handle; **a session published outside that lifecycle persists nothing**”（`packages/core/session/src/index.ts:1041-1048`）。
- 官方文档同义句：“**only agent-loop-published sessions persist**, and the loop stores the seed through the new session's write handle before publication”（`docs/subsystems/persistence.md:226`）。
- 实现：JSONL backend 的 live routing 只把事件灌进“已有的 write handle”（`packages/session/session-persistence-jsonl/src/storage.ts:549-568`：`writers.get(session.id)?.enqueueLive(...)`）。
- **dispose 不删除已落盘日志**：teardown 关闭 persistence handle（`agent-loop/src/index.ts:544-590`，`await handle?.close()` 在 `:580`），持久化只是 close/drain（`persistence.md` 的 flush 语义）。没有 delete API（见 §3.5）。

### 3.4 DSH 里的三种“fork”

| 入口 | 实现 | 持久化 | announce / 列表 | 是否跑 agent loop | 证据 |
|---|---|---|---|---|---|
| `SessionStore.fork(source, boundary?, childId?)` | `buildForkSeed()` + `create()` | **否**（无 write handle） | 是（enter+announce） | 否（无 Agent） | `packages/core/session/src/index.ts:1380-1395`；`fork.ts:21-30`；`packages/core/session/src/index.ts:1111-1120` |
| Remote `session/fork`（用户点 Fork） | 读历史 → `buildForkSeed` → `ctx.agents.create({seed,inheritedEventCount,meta:{parentSession,isSeeded,agentPreset}})` | **是** | 是 | 是（创建一个 live Agent，等 prompt 才跑） | `packages/api/session-controller/src/commands.ts:227-300`；`packages/api/session-controller/src/index.ts:442-453` |
| subagent fork provider（`dsh-subagent-fork-in-process`） | 取父会话 `completedTurnPrefix` 作为 seed，交给 subagent manager 的 `ctx.agents.create` | **是** | 是（`origin:'subagent'`，客户端树隐藏） | 是 | `packages/subagent/subagent-fork-in-process/src/index.ts:1-83`；`packages/subagent/subagent/src/manager.ts:421-470,908-922`；`child-agent.ts:135-160` |

补充事实：

- fork seed 在继承前缀末尾写 `session/end-seed { inherited: true }`，只为“开放尾部”补 synthetic closers（`packages/core/session/src/fork.ts:21-30`；`packages/core/session/src/index.ts:674-690`；`docs/subsystems/session.md:681,739`）。
- 子会话的 `inheritedEventCount` 只统计复制的源事件（`fork.ts:21-30`、`index.ts:1391`）。
- fork 的 `parentSession` 只构成 lineage，**不带 `origin:'subagent'`**，所以“fork 不持有源会话的 archive”（`packages/subagent/subagent/src/archive-admission.ts:46-64`）。

### 3.5 announce / list / disposed / archive / delete

- **list 会包含“live 但未持久化”的会话**：`SessionQuery.listSessions()` 先读持久化列表，再合并 `ctx.sessions.list()`（`packages/session-query/session-query/src/corpus.ts:62-86`）；`ApiSessionList.list()` 对 live 记录用 `summaryFor(session)`（`packages/api/session-controller/src/list.ts:112-163`）；`@Remote('list')` 暴露给客户端（`session-controller/src/index.ts:275-280`）。
- 客户端树只过滤三类：`origin:'subagent'`、非当前会话的 `blank`、按 archive 过滤（`packages/client/ui-workspace/src/client/tree.ts:238-254`）。**没有 ephemeral 过滤**。
- `session/created` / `session/disposed` 是全局事件：除 controller 外，还有 permission-presets（`packages/interaction/permission-presets/src/index.ts:245-248`）、schedule（`packages/schedule/schedule/src/index.ts:166-186`）、SDK server（`packages/sdk/server/src/server.ts:120`）等监听者会处理任何新会话。
- **archive**：`ctx.workspaceRegistry.archiveSession()` / `unarchiveSession()`（`packages/workspace/workspace/src/index.ts:365,399`）；archive 只是标记 + 停止活动，行仍保留（客户端灰显）。
- **没有会话删除**：官方明确“sessions can be archived but never deleted”（`packages/client/ui-workspace/README.md:222`）；`SessionPersistence` 契约只有 create/open/stat/list（`docs/subsystems/persistence.md:5-7`），没有 delete。
- `session/disposed` 只在 entered+announced 的会话 detach 时发出（`packages/core/session/src/index.ts:1210-1305`（enter `:1210`、detachEntered `:1247`、emitDisposed `:1296`））——**prepare 但未 enter 的会话不会有 disposed 事件**，这对“不发布”的 ephemeral 方案是优点。

### 3.6 隐藏会话的唯一先例：`origin: 'subagent'`

- `SessionHeader.origin?: 'subagent'`，header 校验只允许这个值（`packages/core/session/src/types.ts:110-119`；`packages/core/session/src/index.ts:124-125`）。注释明确：**presentation metadata，不是可继续性的证明**（`types.ts:110-113`）。
- 产生：`childSessionMeta()` 固定写 `origin:'subagent'`（`packages/subagent/subagent/src/child-agent.ts:135-160`）。
- 隐藏：客户端 `sessionVisible()` 直接 return false（`ui-workspace/src/client/tree.ts:238-254`）；普通 API 路由拒绝访问，必须走 subagent delivery（`session-controller/src/agent.ts:115-126`；`history.ts:340-390`）；父会话通过 `subagentCatalog` projection 持有子项（`packages/subagent/subagent/src/catalog.ts:49-131,121`；`list-children.ts:36-62`；`subagent/src/index.ts:228`）。
- `origin:'subagent'` 不是“免费隐身”：它同时触发了 subagent 路由/目录/交付语义；一个没有 descriptor、没有 catalog 的伪 subagent 在 UI 中不可见，但也没有任何可用的打开路径。

### 3.7 结论

**DSH 0.2.1-rc.2 不存在 ephemeral session/agent/fork。** 能达到“隐藏”的只有 `origin:'subagent'`（有语义代价）和 archive（不隐藏、不可逆删除）。要 C 就必须改上游。

---

## 4. 第三方 Host 插件的边界

### 4.1 加载形态与信任边界

- installable bundle 是 profile 的一个 layer，普通 Cordis 插件树的一部分（`docs/architecture.md:15-25`）。
- 安全模型是“信任的进程内代码”：**installed Host code executes in-process outside the workspace sandbox**（`packages/boot/plugin-manager/README.md:31`）。
- 没有“服务注入白名单”：服务就是 `ctx` 上的能力，`inject` 声明依赖即可，任何插件都可以消费/提供（`docs/user/develop/framework/service.md:5,21-32`）。
- 所以 §4 的答案不是“能不能”，而是“用 public API 做出来会不会有副作用”。

### 4.2 第三方 Host 插件实际可用的能力（本任务相关）

| 能力 | 可用? | 证据 |
|---|---|---|
| `ctx.llm.stream(GenerateOptions)`（含 tools/toolHistory） | 是 | `docs/cookbook/extension-cookbook.md:75`（inject 示例含 `sessionPersistence`）；`auto-review/src/index.ts:127` inject `llm`；`compaction-basics` 先例 |
| `ctx.sessions.get/list`、`session.deriveMessages()/requestHeader()/toolHistory()` | 是 | 都是 `SessionStore`/`Session` 公开方法（`packages/core/session/src/index.ts:912,953,984,1380`） |
| `ctx.sessions.fork(source, boundary?, childId?)` | 是 | public Service 方法（`session/src/index.ts:1380`）；源必须 live |
| `ctx.sessions.prepare/enter/announce`（高级生命周期原语） | 是（文档标注 advanced） | `session/src/index.ts:1111-1305`；`SessionPreparation`（`preparation.ts:1-49`） |
| `ctx.agents.create` / `ctx.agentLoop.createAgent` / `ctx.agents.resume` | 是 | `agent/src/index.ts:393-403`；`agent-loop/src/index.ts:750`；resume 需 persistence |
| `ctx.sessionQuery.observeSession/readSession/listSessions` | 是 | `packages/session-query/session-query/src/index.ts:140-198`；`readSession` 可离线折叠出 detached Session |
| `ctx.agentPresets`（composeAgent 用的 preset mount） | 是（服务存在才 use） | `session-controller/src/agent.ts:387-400` |
| `ctx.workspaceRegistry.archiveSession` | 是 | `workspace/src/index.ts:365` |
| `ctx.tools.guard(fn)`（**scoped 工具守卫**，可只对某 agent scope 生效） | 是 | `packages/core/tools/src/index.ts:1144-1162`（global + scope chain，farthest first） |
| 注册 `@Remote` 方法给客户端 | **否（无构建期生成链）** | `docs/api-gateway.md:100-118`：descriptor 由 `@deepseek-ai/dsh-typert-generator` 在 Host tsdown 阶段从 `ts.Program` 生成；第三方包不在该 build 图内 |
| 新增 released `SessionEventMap` 事件类型 | 否（会破坏 reopen） | `packages/core/session/src/known-event-types.ts:15-20`：build 外事件必须在 `KNOWN_SESSION_EVENT_TYPES` 内或被 `ignorable` 标记；注释明确“Downstream (out-of-repo) plugin events are outside this list by construction” |
| 写 `plugin:*` ignorable 记录 | **是（experimental 语义）** | `Session.appendPluginRecord`（`session/src/index.ts:492-507`）只做类型语法校验；`PluginRecordMap` 可被下游包 merge（`types.ts:527-533`）；持久化读取对 `ignorable` 事件宽容（`known-event-types.ts:15-20`；`docs/experimental-persistence-catalog.md:1-6`）。**但**仓库策略仅允许 `packages/experimental/` 的生产代码调用（`session/src/index.ts:478-490`）——出仓插件不受这条 gate 约束，语义上属未承诺的 experimental |
| 阻止 agent-loop 持久化 / 删除已落盘会话 | **否** | `createStoredSession` 无条件调用（`agent-loop/src/index.ts:715-728`）；persistence 契约无 delete（`docs/subsystems/persistence.md:5-7`） |
| 隐藏一个 live 会话 | 只能 `origin:'subagent'`（创建时 meta）或 archive | `packages/core/session/src/types.ts:110-119`；`packages/client/ui-workspace/src/client/tree.ts:244`；`packages/workspace/workspace/src/index.ts:365` |

### 4.3 “用 public API 拼 C”能走到哪一步（C′，不推荐）

第三方插件**理论上**可以：

1. `ctx.sessionQuery.observeSession(parentId)` 或直接读 live session，取 parent 的完整事件前缀；
2. `buildForkSeed(events, boundary)`（公开导出，`packages/core/session/src/index.ts:27`）；
3. `ctx.agents.create({sessionId: newId, seed, inheritedEventCount, meta:{parentSession, isSeeded:true, origin:'subagent', cwd}, agentOptions:{provider,model}, setup: (agentCtx) => ctx.get('agentPresets')?.mount(agentCtx, parentPresetId)})`（对应官方 `composeAgent` 的 setup，`packages/api/session-controller/src/agent.ts:387-400`）；
4. 在子 agent 上 `followup(predictionInstruction)`，等 `turn/end`，读最后一条 assistant message；
5. `handle.dispose()`。

但代价全部暴露：

- **持久化污染**：子会话必落盘（§3.3），且没有删除 API（§3.5）；长期每回合 end 都留一个会话文件 + 会话列表 API 记录（客户端用 `origin:'subagent'` 隐掉，但 `sessionQuery.search`/`listSessions`/磁盘/telemetry 都有痕迹；`api-session/added` 仍会推送）。
- **工具会真执行**：agent loop 收到 tool-call 就 `executeToolCalls`（`agent.ts:549-555`），Codex 靠 prompt 约束，DSH 若不装 guard 就是真实的文件/shell 副作用。可加 scoped `tools.guard` 拒绝（`tools/src/index.ts:1144-1162`），但模型会收到拒绝并可能重试，需要单步/终止策略。
- **compaction 会跑**：自动压缩挂在全局 `agent/pre-step`，对所有 agent 生效（`packages/compaction/compaction-basic/src/index.ts:155-176`），没有 per-agent 关闭开关；预测子会话继承全量历史，压缩可能把父历史整段总结一遍（昂贵且与预测目的冲突）。
- **遥测/统计会看到子会话事件**：session-telemetry 监听全局 `session/event`（`packages/session/session-telemetry-otel/src/index.ts:159`），子会话事件会进入遥测；同时子 agent 的 `agent/created`/`agent/status` 会通过 controller 推给客户端（`session-controller/src/index.ts:199-213`），即使行被隐藏也有状态流。
- **需要复刻 composition/model selection/preset**：否则子会话的 system prompt/tools 与父不同 → 前缀失效。`agentPreset` 是 durable 线索（`packages/core/session/src/types.ts:121-130`），但 model selection 是 per-agent mutable 状态（`packages/api/session-controller/src/agent.ts:289-345`），复刻不保证与父当前请求一致。
- **fork seed 的 boundary 语义**：`SessionStore.fork` 要求源 live；`buildForkSeed` 会为 open tail 补 synthetic closers（fork.ts:21-30）。在 `turn/end` 后 fork 是安全边界，但要自己保证。

**结论**：C′ 能跑，但把“已否决的污染”全背上了；它证明的恰恰是“C 必须由上游提供 ephemeral 语义，第三方拼不出来”。

### 4.4 对三条路线的判定

- A、B 完全在第三方插件能力内（`ctx.llm` + `ctx.sessions`/`sessionQuery`）。
- C 超出第三方边界：需要 agent-loop 提供“不持久化、不发布/不列举”的一等选项，并提供工具执行/compaction 的关闭语义。
- 任何“阻止持久化/删除会话”的诉求在插件层无解（无拦截点、无 delete API）。

---

## 5. 如果上游实现 ephemeral inheriting fork：最小改动清单

> 本节是**设计提案**（基于现有代码结构推导），不是仓库已有实现；行号指向需要改动的现状代码。

### 5.1 语义定义（与 Codex 对照）

| Codex 语义 | DSH 现状 | 上游需要提供 |
|---|---|---|
| fork 父线程：继承 config/tools/history，最大化 prompt-cache | 可用 `ctx.agents.create({seed, inheritedEventCount, meta:{parentSession,isSeeded}})` 得到，但会持久化+发布 | `ephemeral` 模式：seed 相同但不持久化、不进列表 |
| `ephemeral: true`：不落盘 | 只有“没 mount persistence”才不落盘（`agent-loop/src/index.ts:715-718`） | 显式 `persist:false` / `ephemeral:true` |
| `excludeTurns`：API/UI 不显示 turns | 无 | 不发布或发布后过滤 |
| 继承 tools（不弱化 prompt cache） | 可由 preset composition 继承 | 复用父会话 composition（preset id 已在 header） |
| 预测 turn 不 auto-compaction | 全局 compaction 对所有 agent 生效（`compaction-basic/src/index.ts:155-176`） | ephemeral agent 跳过压缩（agent/session 级标志） |
| 预测 turn 不执行工具（DSH 更严格） | 无开关（`AgentOptions` 仅 4 字段，`runtime-types.ts:26-35`） | 单步 + 工具调用不派发（写配对错误结果后结束 turn）或 scoped guard |
| 0 延迟卸载 | `AgentHandle.dispose()` 已有 | 预测 turn 结束即 dispose；并发/取消由调用方管理 |
| prompt_cache_key 相等 | 无 key；靠 provider+model+字节前缀 | 无需新字段；保证 fork 首请求与父请求前缀一致（header 不变、composition 不变） |

### 5.2 最小改动清单

**方案 C1（推荐形态）：ephemeral agent 完全不发布、不持久化。**

| # | 包 / 文件 | 改动 | 测试 |
|---|---|---|---|
| 1 | `packages/core/agent/src/index.ts` | `CreateAgentOptions` 增加 `ephemeral?: true`（并文档化“不持久化、不发布、仅 owner handle 可见”）；`AgentHandle.dispose` 语义不变 | 类型/契约测试 |
| 2 | `packages/core/agent-loop/src/index.ts` | `createAgent`：ephemeral 时跳过 `createStoredSession`（`:715-728`）与 `appendUnstoredSuffix`（`:734-746`）；`setupAndPublish`/`publish`（`:650-670,790-820`）在 ephemeral 时不 `sessions.enter/announce`、不 `agents.enter/announce`，只完成 prepare+setup+start；teardown 不变（`handle` 为 undefined 已支持） | `scope-lifecycle.spec.ts`、`resource-lifecycle.spec.ts` 增加“无 persistence、无 registry 条目”用例 |
| 3 | `packages/core/agent-loop/src/agent.ts` | `AgentOptions`/loop option 增加 `executeTools?: false`（或 `ephemeral` 隐含）：assistant 消息带 tool-call 时不 `executeToolCalls`（`:549-555`），而是为每个 callId append `tool/result` 错误（复用 `ToolCallRecovery` 的模式）并以 `completed` 结束 turn；`maxSteps` 默认 1 由调用方控制更简单 | `tool-calls.spec.ts` 增“工具不派发但配对完整” |
| 4 | `packages/core/agent/src/runtime-types.ts`（或 `CreateAgentOptions`） | 暴露 ephemeral 语义给 compaction：`agent.session` 上 runtime-only `isEphemeral` 标志（**不要写进 session header**，避免 persistence-type 变更，见 `docs/cookbook/reviewing-persistence-type-changes.md`） | 无持久化 schema 变更的 gate 通过 |
| 5 | `packages/compaction/compaction-basic/src/index.ts` | `agent/pre-step` 监听（`:155-176`）对 `agent.session.isEphemeral` 直接 `next()`；`agent/request-error` 的 overflow 恢复同理跳过 | compaction 测试 + “预测 turn 不产生 `compaction/*` 事件” |
| 6 | `packages/core/session` | 若采用“发布但隐藏”形态：`SessionStore`/`SessionHeader` 需要 ephemeral 标志 + `sessionQuery.listSessions`/`ApiSessionList.list`/`api-session/added` 过滤 + `resolveAgent` 拒绝；若采用 C1（不发布）则**这一步完全不需要** | 列表/API 测试 |
| 7 | `docs/architecture.md` | 按 AGENTS 规则更新 loop 变更（`AGENTS.md:138`）；说明 ephemeral 的可见性契约 | doc-sync |
| 8 | 调用方（官方 feature 包，如 `packages/session/session-prediction`） | 在 `turn/end completed` 后：读 parent header/deriveMessages → `ctx.agents.create({ephemeral:true, seed:buildForkSeed(events,lastEnd), inheritedEventCount, meta:{parentSession,isSeeded:true,cwd}, agentOptions: parent header config})` → `followup(instruction)` → 等 `turn/end` → 读 assistant 文本 → `dispose()`；并发上限/取消/超时/采样全在调用方 | keyless snapshot + 带 key 的 cache e2e（断言子首请求 `cacheReadTokens` 与父请求前缀一致） |

**方案 C2（发布但隐藏）：更少的 loop 改动、更多的全仓改动。** 保留 enter+announce，给 session 加 runtime `isEphemeral`，然后逐处过滤：`sessionQuery/src/corpus.ts:62-86`、`api/session-controller/src/list.ts:112-163`、`session-controller/src/index.ts:191-197`、`history.ts`、`session-telemetry`、`sdk/server`、`schedule`、`permission-presets` 等所有 `session/created`/`list` 消费者。**不推荐**：扩散面大且容易漏，且会触发 `permission-presets` 给 ephemeral 会话 append `permission/preset` 等副作用（`permission-presets/src/index.ts:245-248`）。

### 5.3 风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| 前缀不对齐导致缓存不命中 | 子 agent 的 composition/model selection/system prompt assemble 与父不同，或 runtime-context 差异导致首请求 system 节点被替换（`runtime-context.ts:85-119`） | 复用父 `agentPreset` + `requestHeader().config`；首请求后断言消息/工具与父请求前缀一致（测试） |
| 工具副作用 | 若未加 `executeTools:false`，真实执行 | 上游强制 ephemeral 不派发；模型输出只取文本 |
| compaction 误触发 | 全量历史常触发阈值压缩，成本/延迟爆炸 | 方案 C1 第 5 条 |
| 并发/取消/泄漏 | 每回合 end 创建一个 agent；用户马上发下一条、切会话、关闭进程 | owner fiber 绑生命周期；`AbortController` + `dispose()`；幂等取消；上限 |
| 成本双计 | 预测请求正常计费（无 Codex 的 prediction 免计费） | 产品文案 + 采样 + 预算 |
| 遥测/列表/磁盘 | C1 天然无痕；C2 需逐处过滤 | 选 C1 |
| session id 分配与日志 | 不发布则不占列表，但 `ctx.sessions.list` 也看不到（这是期望行为） | 测试断言 `ctx.sessions.get(childId)===undefined` |
| 持久化类型变更审批 | 若把标志写进 `SessionHeader` 会触发 persistence-type 变更流程 + catalog/gate | 用 runtime-only 标志，不写 header |
| 官方 vs 第三方交付 | C 只能官方做；第三方 bundle 无法复刻（§4） | 产品化才做 |

### 5.4 工作量估算

- 方案 C1：agent-loop 核心改动 + 类型 + 测试约 **3–5 人日**；feature 包（prediction 调用方 + 配置 + 测试 + 文档）约 **3–5 人日**；合计 **1–2 周**（与参考方案 §0.5 的 P3 估计一致）。
- 方案 C2：额外 3–5 人日用于全仓可见性过滤与回归，且遗留漏过滤风险。

---

## 6. 三条路线对比与推荐

### 6.1 对比表

| 维度 | A：现有方案（deriveMessages + 无 tools 的 `ctx.llm.stream`） | B：继承式请求（复用父请求 header/tools/history，不 fork） | C：上游 ephemeral inheriting fork（C1） |
|---|---|---|---|
| 实现成本 | **最低**：已在方案中，0 upstream；P0 0.5–1 天 | **低–中**：仍是插件，约 +0.5–1 天（多传 tools/toolHistory、全量 history 默认、缓存指标） | **高**：1–2 周上游 + feature 包；核心 loop 变更，需 docs/architecture 更新与评审 |
| prompt-cache 收益证据 | 可能整段 miss（漏 tools；**未证实，需实测**）；裁剪历史进一步降低命中 | **最有希望**：与父请求 byte-identical 前缀（system+tools+history），官方 compaction 同款做法 + 真机 cache e2e 支撑机制；实际命中率取决于 provider 与裁剪策略，**需实测** | 与 B 相同的理论前缀；C 的价值是“隔离”，不是更多缓存 |
| 隔离/安全 | **最强**：不进 loop，无工具、无 compaction、无记忆、无 session 事件 | 同 A（不进 loop） | 需显式禁工具/禁压缩；否则等价于开一个真 agent |
| 对会话列表/持久化污染 | **零** | **零** | C1 零；C2 有列表/API 过滤负担；第三方 C′ 严重污染（每回合一个落盘会话、不可删） |
| 工具副作用风险 | 无（未声明 tools） | 无（`ctx.llm.stream` 不执行工具；输出解析只取文本） | 若无 `executeTools:false` 有真实副作用 |
| 与 compaction/遥测关系 | 无交互（不写 session 事件；usage 不进会话统计） | 同 A | 需改 compaction 跳过；C2 还需遥测过滤 |
| 对官方/第三方两种交付形态 | 第三方 bundle 即可；官方也可复用 | 第三方 bundle 即可；官方也可复用 | 只能官方（第三方拼不出，见 §4.3） |
| 前缀裁剪自由度 | 可自由裁剪（反正不追求 cache） | **建议不裁剪**或仅在超预算时裁，且接受缓存下降 | 不裁剪（继承全量） |
| Codex 对照 | “独立建议生成 + 明确挑选最近对话”（Codex 文档推荐给类似产品） | “继承前缀 + 末尾指令”（Codex inheriting fork 的请求形状，但走 one-shot） | Codex 原样（ephemeral fork + prediction turn） |

### 6.2 推荐

**推荐路线：B 为主，A 为兜底，C 不作为 v1。**

1. **B 作为默认模式（cache-aligned）**：
   - 触发：`turn/end {reason.kind:'completed'}`（`types.ts` 的 TurnEndReasonMap；loop 在 `agent.ts:384-391` 写入）。
   - 上下文：`session.deriveMessages()` **全量**（不按 6 轮裁剪）；若超过输入预算，先按“最旧的人类回合”从**头部**裁剪并接受缓存损失/记录降级原因。
   - 路由与工具：`session.requestHeader()?.config`、`.tools`、`.adapterDefaults`（strip 默认值字段）；`session.toolHistory()`；用 `provider/model` 与父一致。
   - 尾指令：一条 user message（沿用方案 §4.3 的 prompt）。
   - 调用：`ctx.llm.stream({...})`，`maxTokens` 小、`signal` 超时、不重试；从 `usage.cacheReadTokens/inputTokens` 记录缓存指标（`BlockAssembler.usage`，`assembler.ts:181-183`）。
   - 失败/预算/无 header/非 DeepSeek provider：降级到 A（不传 tools、按轮裁剪）。
2. **A 保留为安全降级路径**：当 `requestHeader()?.tools` 为 undefined（纯文本会话）、provider 不确定是否支持自动前缀缓存、或输入超预算时使用。
3. **C 只在“官方产品化”时做**：如果体验验证证明缓存收益显著、且官方愿意维护 ephemeral agent，再按 §5.2 C1 落地；在那之前不做第三方 C′（污染/工具/压缩三个风险都不值得）。
4. **交付形态**：官方/第三方都可交付 B（纯公共 API，无上游改动）；这也符合 bundle 卸载/灰度诉求（参考方案 §0.3）。

### 6.3 P0 真机验证（把“未证实”变成数据）

实验：同一会话、同一 turn/end 之后，对同一历史发三种请求，记录 `usage`：

| 组 | 请求 | 预期 |
|---|---|---|
| P0-1 | 全量 `deriveMessages` + header.tools + toolHistory + 尾指令（B） | `cacheReadTokens` 接近父会话上一请求的 prompt 大小 |
| P0-2 | 全量 `deriveMessages`，**不带 tools**（A） | `cacheReadTokens` 显著下降（若命中率≈0 则证明 tools 在 prompt 头部） |
| P0-3 | 裁到最近 6 轮 + tools | 只命中 system+tools 头（或更少） |

再验证父会话下一请求的 cache：预测之后用户发一条消息，观察其 `cacheReadTokens` 是否覆盖到最新 assistant 回复（判断预测是否“预热”了缓存）。

判据：若 P0-1 明显优于 P0-2，B 成为默认；若差异 <5%，A 足够（省去 tools 传递的兼容性风险）。

### 6.4 对参考方案文档的修正建议（源码级）

| 原文位置 | 原文断言 | 修正 |
|---|---|---|
| §2.3 / §0.2 | “`ctx.sessions.fork()` 产生的是真实、持久、会被 announced 的会话” | **announce 是、持久化不是**：`SessionStore.fork` 只 `create()`（enter+announce），没有 persistence.create；持久化的是 `ctx.agents.create` 路径和用户级 Remote fork（`session/src/index.ts:1045-1048,1111-1120,1380-1395`；`agent-loop/src/index.ts:715-728`；`commands.ts:227-300`）。 |
| §4.4 | “不传 tools……代价是损失少量 prompt-cache 命中” | 漏传 tools 可能丢掉**整段**前缀缓存（`agent-loop/README.md:164`；`llm-deepseek/README.md:181`）；`maxTurns=6` 裁剪同样牺牲大部分命中。建议改 B 并实测（§2.5/§6.3）。 |
| §2.2（对 DSH 的推论） | 暗示“多轮 messages 复用真实请求前缀”即可 | DSH 的“真实请求前缀”还包括 `tools` 与 `toolHistory`（`agent.ts:695-703`；`llm/src/index.ts:1107`），只复用 messages 不够。 |
| §0.4 / §2.4 | “第三方插件不能新增 session 事件 type（会破坏 reopen）” | 对 **released 事件** 正确（`known-event-types.ts:15-20`）；但存在官方 ignorable 机制 `appendPluginRecord` + `plugin:*`（`session/src/index.ts:478-510`；`types.ts:527-533`；`docs/experimental-persistence-catalog.md`），可做“一次预测请求的 log-only 审计记录”，代价是 experimental 语义与对会话日志的写入。是否使用建议单独决策。 |
| §4.4 | `purpose` 是封闭联合、无 prediction 语义 | 正确（`packages/llm/llm/src/types.ts:565-570`）；若上游化，可考虑新增 `purpose:'prediction'` 做归因（非必需）。 |
| §0.3 | 会话读取 `session.deriveMessages() + session.requestHeader()?.config` | 基本正确，但 B 还需要 `requestHeader()?.tools` 与 `session.toolHistory()`（§2.4）。 |

---

## 7. 关键证据索引

| 主题 | file:line |
|---|---|
| loop 请求装配 | `packages/core/agent-loop/src/agent.ts:267-288,400-442,564-613,616-703` |
| 请求 header 事件 / 折叠 | `packages/core/session/src/types.ts:241-256,385-397`；`packages/core/session/src/index.ts:899-922`；`packages/core/session/src/request-header.ts:21-69`；`docs/subsystems/session.md:181-210` |
| deriveMessages / toolHistory | `packages/core/session/src/index.ts:943-1005,1007-1015`；`packages/core/session/README.md:58,185` |
| 可重建性契约 | `.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md:17-31`；`docs/architecture.md:124`；`docs/subsystems/llm-streaming.md:765` |
| 请求前缀测试 | `packages/core/agent-loop/tests/request-reconstruction.spec.ts:85,111,127,148,177,504,575,605,723`；`request-freeze.spec.ts`；`request-cache.e2e.ts:18-25,85-95` |
| GenerateOptions / call config | `packages/llm/llm/src/types.ts:529-571`；`packages/llm/llm/src/call-config.ts:16-34,54-57,84-95`；`packages/llm/llm/src/index.ts:908-942,956-1004,1100-1110,1166-1177` |
| DeepSeek 缓存语义 | `packages/llm/llm-deepseek/src/serialize.ts:57-169`；`wire-types.ts:1-40`；`translate.ts:36`；`packages/llm/llm-deepseek/README.md:181,195`；`tests/runtime.e2e.ts:358-440`；`apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:136-163` |
| one-shot 先例 | `packages/compaction/compaction-basic/src/summarizer.ts:26-32,110-163`；`compaction-basic/src/index.ts:238-256`；`packages/experimental/auto-review/src/index.ts:127,623-635`；`packages/session/session-title-llm/src/index.ts:51-57,267` |
| SessionStore create/prepare/enter/announce/fork | `packages/core/session/src/index.ts:1041-1048,1111-1120,1143-1185,1210-1305,1380-1395`；`packages/core/session/src/fork.ts:21-30` |
| agent 创建/持久化/发布 | `packages/core/agent/src/index.ts:70-121,147-161,393-403`；`packages/core/agent-loop/src/index.ts:497-820,843-950`；`docs/subsystems/persistence.md:226` |
| 会话列表 / announce | `packages/session-query/session-query/src/corpus.ts:62-86`；`packages/api/session-controller/src/list.ts:112-163`；`packages/api/session-controller/src/index.ts:191-197,275-280`；`packages/client/ui-workspace/src/client/tree.ts:238-254` |
| subagent 隐藏先例 | `packages/core/session/src/types.ts:110-119`；`packages/subagent/subagent/src/child-agent.ts:135-160`；`packages/subagent/subagent/src/catalog.ts:49-131`；`packages/subagent/subagent/src/archive-admission.ts:46-64`；`packages/client/ui-workspace/src/client/tree.ts:244`；`session-controller/src/agent.ts:115-126`；`history.ts:340-390` |
| fork 的三种入口 | `packages/core/session/src/index.ts:1380-1395`；`packages/api/session-controller/src/commands.ts:227-300`；`packages/subagent/subagent-fork-in-process/src/index.ts:1-83`；`tests/subagent-fork-in-process.spec.ts:74,90,118` |
| archive / 无删除 | `packages/workspace/workspace/src/index.ts:365,399`；`packages/client/ui-workspace/README.md:222`；`docs/subsystems/persistence.md:5-7` |
| compaction 全局钩子 | `packages/compaction/compaction-basic/src/index.ts:155-176` |
| 插件边界/信任 | `packages/boot/plugin-manager/README.md:31`；`docs/user/develop/framework/service.md:5,21-32`；`docs/cookbook/extension-cookbook.md:75`；`docs/api-gateway.md:100-118` |
| plugin record（ignorable 日志） | `packages/core/session/src/index.ts:478-510`；`packages/core/session/src/types.ts:527-533`；`packages/core/session/src/known-event-types.ts:15-20`；`docs/experimental-persistence-catalog.md:1-6` |
| 工具守卫（scoped 禁用工具） | `packages/core/tools/src/index.ts:1144-1162` |
| 模型选择/preset 组合 | `packages/api/session-controller/src/agent.ts:289-345,387-400`；`packages/core/session/src/types.ts:121-130` |

---

### 附：本文未采用/未验证的点

- DeepSeek 的 wire prompt 序列化顺序（tools 在 system/messages 之前还是之后）**未在仓库中记录**；§2.5 的“漏 tools 可能整段 miss”是根据 Anthropic Messages 语义的外部推断，必须由 §6.3 的真实请求验证。
- “预测请求预热父会话下一请求缓存”是机制推断，仓库无跨请求缓存写回的文档。
- 运行中的 0.2.1 Desktop 与 checkout 同版本号，但未对活体安装产物逐行比对；本文所有结论以 checkout 为准。
- `cordis-plugin-development` skill 在本会话/本机不可用，插件规范以仓库文档为准（见文首说明）。
