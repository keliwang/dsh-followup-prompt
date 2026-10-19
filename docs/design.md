# Followup Prompt 技术方案

面向维护者：这份文档说明插件怎么实现、为什么这样实现、如何开发和验证。使用说明见 [`README.md`](../README.md)，Host↔Client 线协议见 [`protocol.md`](protocol.md)。

- 版本基线：DSH Desktop **0.2.1-rc.2**（`engines.dsh: >=0.2.0 <0.3.0`）
- 参照功能：Codex Composer Predictions

## 1. 目标与约束

**交互**：回合正常结束后，在空输入框内展示一条「用户下一条消息」预测；Tab 接受为可编辑草稿，Esc/× 关闭；打字、新回合、切会话、IME 组合期间隐藏；任何失败都静默。

**硬约束**

- 不依赖任何服务端特殊接口。唯一的外部调用是用户本来就在用的模型 provider。
- 预测请求不进 agent loop：不执行工具、不写会话日志、不触发 compaction。
- 永不自动发送：只写草稿，从不调用 `inputActions.submit()`。
- 预测只存在于 Host 进程内存和浏览器内存。

**非目标（v1）**：逐词补全、多候选、跨会话推荐、遥测上报、修改 agent loop、新增 session 事件类型、注册工具。

**与 Codex 的差异**（DSH 第三方插件拿不到对应能力）：预测正常计费；没有服务端 moderation，只做本地过滤；预测请求不进会话日志，不可审计/重放。

## 2. 总体架构

一个安装式 bundle，两个半边：

```
Host（Node）                                    Client（Web）
session/event → turn/end(completed)             conversation.input.overlay 内联 ghost
  → 继承式一次性 ctx.llm.stream                  ← POST /api/followup-prompt/rpc (suggestions/wait，长轮询)
  → 归一化 + 过滤 + 内存缓存                      Tab → inputActions 写入草稿（不发送）
                                                  → suggestions/dismiss
```

| 文件 | 职责 |
|---|---|
| `host/index.js` | 插件入口：`name`/`inject`/`Config`/`apply`，监听会话事件，注册路由 |
| `host/config.js` | 字段表 `FIELDS`（唯一配置来源）、由它生成的 schemastery `Config` 与 `resolveConfig()`（解包 volatile 引用 + 夹取范围） |
| `host/session.js` | 会话只读视图：`latestCompletedTurn()`、`isSubagentSession()` |
| `host/prediction.js` | 上下文构建、继承式请求、tool-rejection 循环、输出归一化与过滤 |
| `host/cache.js` | 每会话一个 entry 的缓存与调度：去重、waiter 计数、dismiss、采样、并发、TTL |
| `host/channel.js` | `/api/followup-prompt/rpc` Fetch 路由：入参校验、端点分发、错误信封 |
| `client.js` | 浏览器半边：lazy-CJS 模块、overlay slot 注册、状态机、ghost 定位、键盘接受 |
| `cordis.patch.yml` | 插入 Host Loader row，重述全部 config 默认值 |

## 3. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 交付形态 | 独立安装式 bundle | 纯公共 API，可灰度/可卸载，不依赖 dsh 仓库构建 |
| 触发 | 客户端按需请求 + Host 缓存；`prefetchOnTurnEnd` 可选，默认关 | 只为用户正在看的会话付费；打开已结束会话时天然 catch-up |
| 回合判定 | `session/event` 中 `turn/end` 且 `reason.kind === 'completed'` | post-commit、fire-and-forget，历史已完整。不用 `agent/turn-stopping`（被 loop await，会拖慢回合关闭）；不用 `agent/status`（粒度不对） |
| 预测方式 | 继承父会话请求前缀的一次性 `ctx.llm.stream()`，不 fork | 见 §3.1 |
| 工具 | 保留全部 tools 声明，模型调用时统一回 `isError` tool-result，绝不执行 | DSH 没有 `toolChoice`；去掉 tools 会丢前缀缓存 |
| 传输 | `/api` 下的 exact Fetch 路由 + 浏览器 `fetch` | 见 §4.7 |
| UI | `conversation.input.overlay` 内联 ghost | 最接近 Codex；`conversation.input.dock` 上方建议条保留为降级方案 |
| 存储 | 进程内 `Map<sessionId, Entry>` | 第三方插件不能新增 session 事件类型（未知事件会让会话无法 reopen） |
| 配置 | Host `Config` 只暴露用户字段，全部 `.volatile()`；调优参数留在内部 | 0.2.1 Settings 会自动生成表单并写回 profile patch；内部参数待定后再决定是否暴露 |

### 3.1 为什么不 fork

Codex 用 inheriting + ephemeral fork 让预测请求复用父会话前缀且不落盘。DSH 0.2.1 只有持久 fork：子会话会落盘、进列表、启动真实 agent（工具会执行、compaction 会跑），用它做一次性提示会污染会话。

DSH 的一次请求是会话日志的纯函数，所以不 fork 也能复刻前缀：`session.deriveMessages()` + `session.requestHeader().config/.tools` + `session.toolHistory()`，尾部追加一条预测指令，用 `ctx.llm.stream()` 发出。这样同时拿到「前缀复用」和「无副作用」，不需要新的会话生命周期。只有将来要做真实 turn 式预测时，才需要上游提供 ephemeral agent。

### 3.2 已否决的路线

| 路线 | 否决原因 |
|---|---|
| `ctx.connection.rpc.handle` 通道 | 0.2.1 上激活失败：`cannot get property "webServer" without inject`（注册器用 Connection 自身的 ctx 读 `webServer`，调用方的 inject 不生效）。in-repo 插件和 `ds-bot` 都用 Fetch 路由 |
| `@Remote` + Typert | 客户端只挂载构建期生成的 descriptor，第三方 bundle 没有生成链 |
| 自定义 SessionEvent 推送结果 | 无法写 `ignorable: true`，未知事件会让会话拒绝 reopen |
| session projection / `wire.view` | 预测在 `turn/end` 之后才完成，没有新事件触发重新发布 |
| 替换 `conversation.composer` | 要复刻整个 InputBar（Lexical、附件、快捷键、i18n） |
| 往 contenteditable 注入 DOM | Lexical reconciler 会覆盖，破坏选区/undo/IME |
| 裸 `webServer.register` | 要自己复刻鉴权 |

## 4. Host 半边

### 4.1 生命周期

`inject = ['connection', 'llm', 'sessions']`（路由由 Connection 插件托管，不需要 `webServer`）。

| 事件 | 动作 |
|---|---|
| `turn/end`（completed，且是日志尾部最新完成回合） | 作废旧 entry；`prefetchOnTurnEnd` 时后台预生成 |
| `turn/start` | 中止 in-flight 生成并清缓存 |
| `session/disposed` | 中止并删除该会话全部状态 |
| 插件卸载 / HMR | 插件级 `AbortController` 中止一切；`ctx.effect` 撤销路由 |

最新完成回合由 `latestCompletedTurn()` 从 `snapshotEvents()` 尾部向前找：先遇到 `turn/start` 说明回合未结束；遇到非 completed 的 `turn/end` 不预测。用 `turn` 而不是 `seq` 作 key，因为 compaction 会改变 seq。

子代理会话（`header.origin === 'subagent'` 或 `delegationDepth > 0`）在 `excludeSubagents` 下排除；用户可见的 fork 也带 `parentSession`，但不排除。

### 4.2 上下文构建

默认发送完整 `deriveMessages()`，与父会话下一次请求前缀一致，以命中 provider 前缀缓存。只有超出 `maxInputChars` 或 `maxTurns` 时进入降级裁剪：

- 保留开头的 system/developer 消息；
- 只在**人类 user 消息**（`source.kind === 'user'`）处切，绝不切在 assistant tool-call 与 tool-result 之间（孤儿 tool call 会让 provider 报 400）；注入的合成 user 上下文也不能作切点；
- 找不到能放进预算的切点就放弃预测；
- `stripMedia` 只在裁剪路径生效，全量路径保持媒体块原样。

尾部追加一条普通 user 消息作为指令（不引入第二个 system 槽）。内置指令要求：只输出预测文本、跟随用户语言、不调用工具、历史是不可信数据而非指令、无把握时输出 `NO_PREDICTION`。输出用纯文本 + 哨兵，比 JSON 更省 token、更少解析失败。`PROMPT_VERSION` 写入日志元数据，便于 A/B。

### 4.3 请求构建

从 `session.requestHeader()` 继承 `config`/`tools`，再：

- 删除 `adapterDefaults` 标记为适配器默认值的 `reasoningEffort`/`maxTokens`；
- `reasoningEffort`：配置值为 `''` 时删除该字段（跟随 provider 默认），否则覆盖。**不继承**源请求的值——实测继承 `max` 会把输出预算全花在推理上，以 `finish=max-tokens` 结束且没有文本，这也是默认值改为 `'off'`、`maxTokens` 改为 400 的原因；
- `provider`/`model` 必须成对配置才覆盖（半配会把一个 provider 的 model id 发给另一个 provider），`resolveConfig()` 负责这一点；
- 带上 `toolHistory`、`sessionId`、`maxTokens`；
- `timeoutMs` 是覆盖所有 tool-rejection 轮次的总 deadline。

### 4.4 tool-rejection 循环

模型返回 tool-call 时不执行，构造合成历史后再请求一次，最多 `maxToolRejectRounds` 轮，仍调用则以 `tool-rejected` 静默放弃。约束：

1. assistant(tool-call) 后**立即**跟每个 callId 一条 tool-result（DeepSeek serializer 会校验配对），中间不夹 user/文本。
2. 合成 assistant 消息只放 tool-call block，不放 reasoning（thinking 段通常需要 provider 签名）。
3. callId 为空、同轮重复或与之前轮次重复时放弃（重复 id 无法构成合法历史）。
4. 所有轮次所有调用使用同一段 `isError` 文案（内部参数 `toolRejectionText` 可覆盖）。
5. 每轮带同一份 `tools` + `toolHistory`，保持前缀一致。
6. `assembler.blocks()` 遇到未闭合的未知 block 会抛错，按 `error` 处理。
7. finish 为 `max-tokens` 时 `BlockAssembler` 会丢弃 tool-call，按 `max-tokens` 处理。

`generatePrediction()` 从不抛错，所有失败映射为 `suggestion: null` + `reason`（取值见 protocol.md）。

### 4.5 输出归一化与过滤

去掉外层 markdown fence 和引号/反引号；丢弃空文本、含 `NO_PREDICTION`、含 C0 控制字符（制表/换行除外）、形似密钥（`sk-`/`sk-proj-`/`sk-ant-`、`gh[pousr]_`、`AKIA`、`xox[baprs]-`、`AIza`）的结果；超过 `maxSuggestionChars` 截断。过滤是保守启发式，误杀只会少显示一次预测；最后一道闸门是「永不自动发送」。

### 4.6 缓存与调度

`PredictionCache` 每会话一个 entry，`turn` 限定其归属回合：

- 同一回合的并发 `wait` 共享一次生成（多窗口/重试不重复计费）；
- 客户端中止只移除一个 waiter；最后一个 waiter **显式取消**时才中止未被预生成的生成。普通 `waitMs` 超时**不**中止——慢预测仍会落入缓存，供下一次轮询或 catch-up 读取；
- 终态结果（包括 `null`）按回合缓存，避免重复计费。两种例外不缓存：被 waiter 离开取消的生成，以及 `no-route`（会话还没有可用的 request header，未产生计费，稍后可能成功）；
- dismiss 后同一回合返回 `stale`；
- 采样用 `hash(sessionId#turn)` 确定性决定，同一回合结果一致；
- 全局并发超过 `maxConcurrent` 直接返回 `busy`，不排队；
- TTL 清理在每个入口顺带执行，不额外安装定时器。

### 4.7 传输

`ctx.connection.fetch.register({ path: '/api/followup-prompt/rpc', methods: ['POST'], requestBody: 'buffered', fetch })`，在 `ctx.effect` 中注册以便随插件撤销。挂在 `/api` 下自动获得 Host/Origin 校验、浏览器 cookie 鉴权、body 限制和请求取消。处理函数校验每个字段、永不抛错，业务失败一律 HTTP 200 + `{ok:false}` 信封。完整契约见 [`protocol.md`](protocol.md)；改动协议时 Host 与 Client 必须同步修改。

### 4.8 配置

- `FIELDS` 是唯一的配置来源：每个字段声明类型、默认值和范围，`Config` schema、`DEFAULTS` 与 `resolveConfig()` 都由它生成。
- 字段分两类。用户字段进入 `Config`，出现在 Settings 和 `cordis.patch.yml` 中，含义见 README 配置表。标记为 `internal` 的调优参数（`maxToolRejectRounds`、`toolRejectionText`、`maxSuggestionChars`、`stripMedia`、`sampleRate`、`cacheTtlMs`、`maxConcurrent`、`excludeSubagents`）不进 schema，平时取默认值；要暴露某个参数，去掉 `internal` 并在 patch 中补上该字段即可。schemastery 会透传 schema 之外的 key，所以旧 patch 里残留的这些字段仍会被读取和夹取。
- `Config` 每个字段 `.volatile()`：0.2.1 会把它们替换成 Settings 页就地更新的 live 引用（`{ get() }`），所以运行时不能缓存配置快照，每个使用点都通过 `resolveConfig()` 重新解析。
- `resolveConfig()` 是唯一的配置读取入口：解包引用、夹取范围、类型兜底，手改坏的配置不会让会话崩溃。下游代码因此直接读取已解析的值，不再做二次兜底。
- patch 的 `config` 是整体替换，`cordis.patch.yml` 必须按顺序重述全部用户字段，且与 `DEFAULTS` 逐项一致（`npm test` 会校验）。

### 4.9 可观测与隐私

每次预测以 debug 级别记录 `promptVersion, sessionId, turn, provider, model, rounds, toolRejected, degraded, ms, suggestionChars, inputTokens, cacheReadTokens, outputTokens, outcome`，不记录任何对话内容。

## 5. Client 半边

### 5.1 模块形态

`client.js` 是经典脚本，通过 `window.__ModuleLoader__.load({ id: 'dsh-followup-prompt', factory })` 注册，无构建步骤、无 JSX（`React.createElement`），只用模块表提供的 React。`inject: ['slots', 'locale']`。只面向 0.2.1 的真实 API 编写，不为不存在的 API 写兜底分支。在 `ctx.effect` 中注册词典、键盘守卫和 `conversation.input.overlay` slot entry（order 100，排在菜单之后）。

### 5.2 状态机

使用 slot 标准 props：`useSession`（`running`/`blank`/`awaitingFirstTurn`）、`useInput`（`draft`/`phase`/`attachmentIds`）、`inputActions`、`t`。

- **可显示条件**：空闲、非空会话、非首回合等待、草稿为空、`phase === 'plain'`、无附件、非 IME 组合。
- 每个空闲 epoch 只请求一次；`running` 变 true 或切会话都会开启新 epoch（切到空闲会话会立即为它请求）。
- 条件暂时不满足（如打字）时隐藏并取消请求，但不 dismiss；同一回合草稿清空后直接复显本地缓存，不再请求。
- 所有失败（无 fetch、非 200、中止、坏 JSON、`ok:false`）都解析为 `null`，调用方天然静默。客户端另有 20s 兜底超时（`AbortSignal.timeout`）。

完整状态机见 protocol.md。

### 5.3 内联 ghost

- overlay anchor 是卡片顶部的零高度层。ghost 不写死坐标，而是在 layout effect 里读取 `[data-composer-input]` 的 `getBoundingClientRect()` 与 computed font/padding，克隆位置和字体，resize 时重新测量。
- ghost 显示期间隐藏 `[data-composer-placeholder]`，隐藏/卸载时恢复。隐藏与定位放在同一个 layout effect 里，避免一帧的 ghost/placeholder 重叠。
- 除关闭按钮外 pointer-events 穿透，不影响光标和点击。
- 容器 `role="status" aria-live="polite"`，ghost 文本会被读屏播报。
- 样式只用 `--dsw-alias-*` 主题 token，深浅色自动适配。

依赖的 DOM 属性（`data-composer-input`/`-card`/`-placeholder`）是 0.2.1 实现细节，集中定义在 `client.js` 顶部常量中。

### 5.4 接受与关闭

`document` capture 阶段监听 keydown，满足全部条件才处理：有可见 ghost、非 IME（`isComposing` 或 `keyCode 229`）、无修饰键、目标在 `[data-composer-input]` 内、没有可见的 `listbox`/`menu` 弹层。只有接受/关闭真正生效后才 `preventDefault + stopPropagation`，因此 Lexical 的 `TAB_COMMAND` 在未消费时照常工作。不拦截 Enter。

写入草稿只用 `captureInsertion()` + `insertText(text, span)`（一次可撤销插入，带草稿版本校验）；`insertText` 返回 false 时不消费 Tab，也不 dismiss，绝不退回会覆盖草稿的 `setDraft`。ghost 除关闭按钮外点击穿透，接受只能由 composer 内的 Tab 触发，此时编辑器已聚焦，因此不需要归还焦点。接受和关闭都会 fire-and-forget 调用 `suggestions/dismiss`。

键盘守卫通过 `activateBar` 桥接到当前可见的 ghost；只有可见的 ghost 才发布 handle，避免不可见的第二个 composer 抢走手势。

### 5.5 IME 与 i18n

- document 级监听 `compositionstart`/`compositionend`（目标在 composer 内），`compositionend` 后保留 10ms 宽限（Safari 会在其后发出 keydown）。
- 文案通过 `ctx.locale.register('followup-prompt', { en, zh })` 注册；`locale/*.json` 的 `meta.title/description` 供插件管理器展示，与 `client.js` 内词典的 `meta.*` 保持一致。

## 6. 打包与依赖

- `package.json`：`exports` 暴露 Host 入口、`./client`、locale、icon；`dsh.bundle.patch` 指向 patch；`dsh.client` 声明浏览器半边（`inject` 只是包级信息边，不决定激活顺序）；`files` 限定发布内容。
- `@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery` 只声明为可选 peer，不进 `dependencies`。安装后它们由 DSH 的 profile-resolution 拦截层解析到正在运行的 dsh 安装闭包（`app.asar/dsh/node_modules`）。
- **必须用 `.tgz`/npm 安装**：本地目录安装是 pnpm `link:`，Node 按 realpath 从源码目录向上找 `node_modules`，`@deepseek-ai/*` 解析失败。
- 兼容策略：peer 用 `*`，`engines.dsh` 锁定 0.2.x；对 0.2.1 私有实现的依赖集中在少量常量里；出问题可用 `enabled=false` 立即关闭。

## 7. 开发与验证

### 7.1 命令

```bash
npm run links     # 在 ./node_modules/@deepseek-ai 创建指向 DSH 共享依赖目录的软链（仅开发用）
npm test          # node:test 运行 verify/*.test.mjs
npm run pack:dry  # 只看打包内容
```

`npm run links` 找到的共享依赖目录可能来自更早的 Harness 版本，所以离线冒烟验证的是「契约与装配」，不是与运行中版本一致的运行时行为。

### 7.2 离线验证覆盖

- `verify/package.test.mjs`：manifest/exports/files 落盘；locale、icon；patch 按序重述全部用户字段且与 `DEFAULTS` 逐项相等；`pnpm pack --dry-run` 包含全部声明文件（无 pnpm 时跳过）。
- `verify/host.test.mjs`：入口导出与 `Config` schema（默认值、volatile 解包、越界拒绝、provider/model 成对、内部字段不进 schema）；用桩 `ctx` 驱动真实 Host 模块——路由注册、触发与计费次数、缓存、dismiss、错误信封、tool-rejection（配对合法性、轮次上限、跨轮 callId 复用）、采样、并发、中止语义、`timeoutMs` 总 deadline、预生成、TTL、子代理排除、裁剪、轮询超时后生成继续、卸载清理。
- `verify/client.test.mjs`：用假 DOM 与假 hook 运行时驱动 `client.js`——模块注册、locale/slot、fetch 请求形状与静默失败、状态机、切会话、Tab 接受（只走 `insertText`，从不 `submit`）、IME/草稿/运行中隐藏、缓存复显、关闭/Esc、弹层让出 Tab、主题 token 白名单。

覆盖缺口：假 DOM 的 `querySelector` 返回 `null`，ghost 测量与 placeholder 隐藏路径没有覆盖，需要基于 jsdom 的测试补齐。

### 7.3 真机验收（2026-10-19，Desktop profile，dsh 0.2.1-rc.2）

已通过：

| 检查 | 结果 |
|---|---|
| `.tgz` 安装 | `application: applied`，无 warnings |
| Host row 激活 | `fiberPhase: active`；`Config.listConfigs({name:'dsh-followup-prompt'})` 有 schema |
| Client slot 注册 | `Slots.listSubTree`：`conversation.input.overlay` 中 `followup-prompt` order 100 `active` |
| 鉴权传输 | 浏览器 cookie 调 `/api/followup-prompt/rpc`：坏请求、未知 endpoint、未知会话均返回预期结果 |
| 真实 LLM 预测 | 第 2 回合返回 `{"suggestion":"先聊聊测试覆盖率和 CI 流程吧","turn":2}` |
| dismiss | dismiss 后再 wait 返回 `{suggestion:null, reason:"stale"}` |

仍需在页面上人工确认：

1. Tab 与 Lexical / slash 命令弹层的竞争，`[data-composer-input]` 命中情况；
2. `captureInsertion/insertText` 的真实行为、一次撤销；
3. ghost 在深/浅色、附件栏、多行输入、不同字号下的对齐；
4. 切会话不串、IME 组合隐藏、断网静默、多窗口不重复计费、卸载后无残留监听器；
5. 非 DeepSeek provider 对合成 tool-call 历史的接受度（失败则降级为「tool-call 即放弃」）；
6. 前缀缓存 A/B（见下）。

**前缀缓存 A/B**：对比三组请求的 `usage.cacheReadTokens`/`inputTokens`——全量历史 + tools + toolHistory（当前方案）、全量历史不带 tools、裁剪到最近 6 轮 + tools。若前两组差异 <5%，可考虑去掉 tools 继承、省掉 tool-rejection 路径。

### 7.4 升级回归清单

DSH 升级后核对：slot 名与 standardProps；`data-composer-input`/`-placeholder`/`-card` 是否仍在；ghost 对齐；`inputActions.captureInsertion/insertText` 是否仍在；`connection.fetch.register` 契约；`session.deriveMessages/requestHeader/toolHistory/snapshotEvents` 签名。任一项变化先降级（overlay ghost → `conversation.input.dock` 建议条 → `enabled=false`）。

### 7.5 发布

```bash
npm version patch          # 改 version、提交并打 vX.Y.Z tag；预发布用 npm version prerelease --preid rc
git push --follow-tags
```

推送 `v*` tag 触发 `.github/workflows/release.yml`：校验 tag 与 `package.json` 版本一致 → `npm run deps:ci` + `npm test` → `npm publish` → `gh release create`（附 `npm pack` 产物，自动生成 release notes）。带 `-` 后缀的版本发到 npm 的 `next` dist-tag，GitHub release 标为 prerelease。npm 发布失败时不会创建 release；若 npm 已发布而 release 失败，手动补 `gh release create <tag>`，不要重跑整个 job。

- 认证走 npm Trusted Publishing（OIDC），仓库里不存 token，provenance 自动生成；`repository.url` 必须与 GitHub 仓库一致。
- CI 没有 Harness，`deps:ci` 从 npm 安装 peer：`dsh-llm` 固定为与版本基线一致的 `0.2.1-rc.2`（它的 `latest` dist-tag 是更旧的 `0.0.1-rc.1`，测试会失败）。升级 Harness 基线时同步修改。
- 首次发布需在本地 `npm login && npm publish`，之后在 npmjs.com 的包设置 → Trusted Publisher 中登记 `keliwang/dsh-followup-prompt` 与 `release.yml`。

## 8. 风险与技术债

| 风险 | 缓解 |
|---|---|
| 额外计费 | 总开关、采样、超时、路由覆盖、输入预算；README 明示 |
| Client 依赖 0.2.1 私有 DOM 结构，升级后漂移 | 常量集中、特性检测、失败静默、回归清单 |
| `/api` exact Fetch 路由不是 stable 公开 API | `engines` 锁定 0.2.x；可随时关闭 |
| 模型反复调用工具 | 轮次上限 + 总 deadline + 指令约束 |
| 缓存收益未达预期 | §7.3 A/B 实测后再决定是否保留 tools 继承 |
| 键盘桥是全局单槽，未按会话区分 | 只有可见 ghost 发布 handle；彻底解决需要 slot 帧提供会话身份 |
| 本地密钥过滤是启发式 | 永不自动发送 + 用户可编辑 |

## 9. 后续方向

- **设置页**：0.2.x 的 `ctx.settings` 不再提供 `register(ns, schema)`。若需要自定义设置页，由 Host 自持久化 `$DSH_HOME/followup-prompt.json`，Client 注册 `settings.section` 通过路由读写。
- **上游化**：若要默认内置，迁到 dsh 仓库——Host 用 `@Remote` + Typert，预测请求记 log-only session 事件以便审计；`ui-conversation` 提供官方 composer suggestion 扩展点，在 Lexical 文本原点渲染 ghost，替代插件侧绝对定位。Host 预测服务与 Client 呈现已拆成两个薄层，迁移只需替换通信和 UI 挂载。
