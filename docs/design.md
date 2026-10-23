# Followup Prompt 技术方案

面向维护者，说明插件怎么实现、为什么这样实现、怎么开发和发布。使用说明见 [`README.zh.md`](../README.zh.md)；Host 与浏览器之间的接口契约见 [`protocol.md`](protocol.md)，本文不重复契约细节。

- 版本基线：DSH Desktop **0.2.1-rc.2**（`engines.dsh: >=0.2.1-rc.2 <0.3.0`）
- 参照功能：Codex Composer Predictions

## 1. 目标与约束

**要做的事**：回合正常结束后，在空输入框里显示一条「用户下一条消息」的预测。Tab 接受为可编辑草稿，Esc 关闭；打字、新回合、切会话、输入法组字时隐藏；任何失败都静默。

**硬约束**

- 只用公开插件 API，不依赖服务端特殊接口；唯一的外部调用是用户本来就在用的模型 provider。
- 预测请求不进 agent loop：不发送也不执行工具，不写会话日志，不触发 compaction。
- 永不自动发送：只写草稿，从不调用 `inputActions.submit()`。
- 预测只存在于 Host 进程内存和浏览器内存。

**非目标**：逐词补全、多候选、跨会话推荐、遥测、修改 agent loop、新增会话事件类型、注册工具。

**与 Codex 的差异**（第三方插件拿不到对应能力）：预测正常计费；没有服务端 moderation，只做本地过滤；预测请求不进会话日志，无法审计或重放。

## 2. 架构

一个安装式 bundle，分成 Host（Node）和 Client（浏览器）两半，通过一条 `/api` Fetch 路由通信：

```
Host                                                Client
 session/event ──► index.js ──► cache.js ◄── channel.js ◄── POST /api/followup-prompt/rpc ◄── client.js
                                   │                                                         （composer overlay 里的 ghost）
                                   ▼
                             prediction.js ──► ctx.llm.stream()
```

| 文件 | 职责 | 依赖 |
|---|---|---|
| `host/index.js` | 插件入口：`name`/`inject`/`Config`/`apply`；把会话事件翻译成缓存操作，注册路由 | 其余全部 |
| `host/channel.js` | Fetch 路由：解析信封、校验参数、分发端点、回答「禁用 / 未知会话 / 无完成回合」 | `session.js` |
| `host/cache.js` | 每会话一个 entry 的调度与缓存：去重、waiter 计数、dismiss、并发上限 | 无（不读配置） |
| `host/prediction.js` | 构建压缩对话和请求、调用模型、归一化与过滤输出；从不抛错 | `@deepseek-ai/dsh-llm` |
| `host/session.js` | 会话只读视图：`latestCompletedTurn()`、`isSubagentSession()` | 无 |
| `host/config.js` | 字段表 `FIELDS` 及由它生成的 schema、`DEFAULTS`、`resolveConfig()` | `@deepseek-ai/schemastery` |
| `client.js` | 浏览器半边：overlay slot、状态机、ghost 定位、键盘接受、`plugins.row.config` 配置页 | 宿主注入的 React、`@deepseek-ai/dsh-client-ui-primitives`，以及可选的 `remote.session` 模型目录 |
| `cordis.patch.yml` | 插入 Host Loader row，按顺序重述全部配置默认值 | — |

依赖方向是单向的：`cache.js` 只管调度，生成函数由 `index.js` 注入（闭包里读取当时的配置）；`prediction.js` 不知道缓存和传输的存在。

## 3. 一次预测的完整流程

1. **回合结束**。Host 收到 `turn/end`（`reason.kind === 'completed'`），且它就是日志尾部最新完成的回合时，先作废该会话的旧 entry。
2. **Client 发起请求**。会话进入空闲、输入框为空时，Client 在这个空闲周期内只调用一次 `suggestions/wait`。
3. **Host 选定回合**。`channel.js` 依次检查会话是否存在、是否为子代理会话，再用 `latestCompletedTurn()` 确定回合，然后交给缓存。
4. **缓存调度**。同一回合已有 entry 就复用（等待中的就一起等，已完成的直接返回）；没有就新建并启动生成；全局运行数达到上限时回答 `busy`。
5. **生成**。`prediction.js` 从会话日志构建压缩对话（§4.1），继承会话的路由和采样参数组成请求（§4.2），流式调用模型，最后归一化与过滤（§4.3）。
6. **返回**。长轮询在生成结束后返回结果；终态结果按回合缓存，重复请求不会重复计费。
7. **显示与接受**。Client 把预测渲染成输入框里的灰色 ghost（§5.2）；Tab 写入草稿，Esc 关闭，两种情况都会 fire-and-forget 地调用 `suggestions/dismiss`。
8. **作废**。下一次 `turn/start`、`session/disposed` 或插件卸载时，Host 中止进行中的生成并删除 entry。

## 4. Host

### 4.1 压缩对话

预测请求不复用主对话的原始历史，而是用一条**独立、只追加**的压缩对话：

- 按 `session.deriveMessages()` 里的人类消息（`role === 'user'` 且 `source.kind === 'user'`）切轮；注入的 system-reminder、skill、goal 等上下文不构成新轮。
- 每轮只保留「用户消息全文 + 该轮所有 assistant 文本块按顺序拼接」；thinking、tool call、工具输出全部丢弃。没有 assistant 文本的轮次不计入。
- 消息序列为「每轮一对 user/assistant」，末尾加一条固定短 cue（`PREDICTION_CUE`）。预测指令放在请求的 system prompt 里；cue 只是给生成一个合法的回合，因为开启 thinking 的请求不能以 assistant 消息结尾。

这样设计是为了前缀缓存：压缩对话完全由会话日志决定，上一次请求去掉末尾 cue 后，就是下一次请求的严格前缀，每轮真正新增的只有一对消息和 cue。真机上暖机一轮后命中率约 97%（§7.3）。压缩对话只有可见文本，远小于原始历史，也不会把模型带回「继续干活」的状态。

内置指令（`FOLLOWUP_INSTRUCTION`，可用配置 `prompt` 覆盖）说明压缩格式，并把「可预测」「不可编造」「不跳跃」分开写：

- 只预测**紧接 assistant 最后一条消息**的那一句：不跳到后续步骤、后续话题或更早轮次留下的开放问题；assistant 以问题/提议结尾时预测用户的回答或选择。assistant 要求用户执行某个具体步骤（运行命令、登录、发布、打开或确认某物）并回复时，预测用户对该步骤的即时回应（接受、开始或追问），不要预测该步骤完成之后的事；其余情况预测推动当前步骤的请求、指令或决定。
- 不要预测空泛的确认/感谢/告别，或纯粹的场外状态更新；但对 assistant 刚要求的某个具体步骤表示接受/开始执行属于合法的即时回应。只有这些内容时输出 `NO_PREDICTION`。
- 压缩对话丢掉了工具调用和工具输出，所以外部事实被明确标成不可知：机器名、主机、IP、服务、路径、命令、报错、ID、日期和结果只能复用转录里出现过的值，禁止推断、改名、编号或延续列表（只出现一台机器时不能预测第二台的名字）；也不得声称用户已经做过、跑过、看过或决定了某事，除非用户自己的消息里写了——assistant 的提议不代表用户已经执行；无法诚实汇报未知动作/结果时，预测用户接受/开始该步骤或追问该步骤，而不是跳到后面的步骤；需要未知事实时留泛化措辞或 `NO_PREDICTION`。
- 输出前自检：草稿里每个名字、数字、命令和过去动作都要能在转录里找到依据，并且必须回答 assistant 的最后一条消息、停留在当前步骤，否则删掉、泛化、往近处改一步或输出 `NO_PREDICTION`。

末尾 cue（`PREDICTION_CUE`）会再重复一次「紧接当前步骤 + 只用转录里的事实」，利用最后一个用户轮次的近因效应。改动指令时递增 `PROMPT_VERSION`（当前 7），它会写进 debug 元数据便于比较效果。

### 4.2 请求构建

请求以 `session.requestHeader().config` 为底（temperature 等采样参数原样继承），再按以下规则覆盖：

| 字段 | 取值 | 原因 |
|---|---|---|
| `provider` / `model` | 配置中的成对值，否则沿用会话的 | 半配会把一个 provider 的 model id 发给另一个 provider，所以 `resolveConfig()` 要求两项同时填写 |
| `reasoningEffort` | 配置值；`''` 表示删除该字段、用 provider 默认值 | 从不继承会话的值：会话用 `max` 时，推理会耗尽全部输出预算 |
| `maxTokens` | 配置值（默认 8192） | 推理 token 也算在内；实际输出很短 |
| `system` | `config.prompt \|\| FOLLOWUP_INSTRUCTION` | 不发送主对话的 system prompt |
| `messages` | 压缩对话 + cue | §4.1 |
| `sessionId` | 当前会话 id | — |

不发送 `tools` 和 `toolHistory`。早期方案保留全部工具声明以复用主对话的前缀缓存，但工具声明会诱导模型继续执行 agent 动作；压缩对话不依赖主对话的前缀缓存，工具就只剩坏处。

缺 provider/model 或者还没有完整的一轮时，请求无法构建，结果为 `no-route`。这种情况没有计费，而且稍后可能成功，所以不缓存。

### 4.3 输出处理

`generatePrediction()` 从不抛错，所有失败都映射成 `{ suggestion: null, reason }`。`timeoutMs` 用 `AbortSignal.timeout` 和调用方的信号合并成整次请求的 deadline。流的终态映射如下：`stop` 进入过滤；`max-tokens` 回答 `max-tokens`；中止时，超时回答 `timeout`，否则回答 `aborted`；其余情况和流异常都回答 `error`。

过滤是保守的启发式规则，误杀只是少显示一次预测，最后一道闸门是「永不自动发送」：

- 去掉外层 markdown fence 和成对的引号或反引号；
- 丢弃空文本、含 `NO_PREDICTION` 的文本、含 C0 控制字符（制表、换行、回车除外）的文本，以及形似密钥的文本（`sk-`/`sk-proj-`/`sk-ant-`、`gh[pousr]_`、`AKIA`、`xox[baprs]-`、`AIza`）；
- 超过 `MAX_SUGGESTION_CHARS`（400）时截断。

### 4.4 缓存与调度

`PredictionCache` 每个会话最多一个 entry，entry 记录它所属的 `turn`：

- **去重**：同一回合的并发 `wait` 共享一次生成，多窗口或重试不会重复计费。
- **等待**：长轮询一直等到生成结束。生成自身受 `timeoutMs` 约束；`wait` 另设 `timeoutMs + WAIT_GRACE_MS`（2 s）的兜底，防止 provider 忽略中止信号时一直挂着。
- **离开**：客户端中止只移除一个 waiter。最后一个 waiter 离开时，生成会被中止并从缓存中移除，同时释放它的并发名额（即使 provider 不理会中止信号）。
- **缓存**：终态结果按回合缓存，包括 `null`，避免重复计费；`no-route` 和被取消的生成不缓存。dismiss 之后同一回合回答 `stale`。
- **并发**：全局运行中的生成达到 `MAX_CONCURRENT`（2）时直接回答 `busy`，不排队。
- **生命周期**：没有 TTL。entry 在下一次 `turn/start`、`session/disposed` 或插件卸载时清除；每个会话最多一条，内容不超过 400 字符。按时间过期反而会让同一回合重复计费。

回合判定用 `turn` 而不是 `seq` 作 key，因为 compaction 会改变 `seq`。`latestCompletedTurn()` 从 `snapshotEvents()` 尾部往前找：先遇到 `turn/start` 说明回合还没结束；遇到非 completed 的 `turn/end` 就不预测。

子代理会话（`header.origin === 'subagent'` 或 `delegationDepth > 0`）一律不预测：它们的流量不该让用户付费，也不会出现在输入框里。用户可见的 fork 也带 `parentSession`，但不排除。

### 4.5 配置

- `FIELDS` 是唯一的配置来源。每个字段声明类型、默认值和范围，`Config` schema、`DEFAULTS` 和 `resolveConfig()` 都由它生成。字段含义见 README 配置表。
- 每个字段都是 `.volatile()`：设置服务据此把它们投影成可编辑表单，运行时把它们替换成 live 引用（`{ get() }`）。所以运行时不缓存配置快照，每个使用点都通过 `resolveConfig()` 重新解析。它负责解包引用、夹取范围、按字段兜底，手改坏的配置不会让会话崩溃，下游代码直接使用解析后的值。
- 可视化入口是 Plugins 页的 `plugins.row.config` 插槽（key 是 `<包名>#<行 id>`，即 `dsh-followup-prompt#followup-prompt`），页面由本包的 browser half 注册。Host 侧通过可选的 `ctx.inject(['settings'], ...)` 调用 `settings.configure({ auto: false }, ctx.fiber)`，声明本行有自己的页面，避免将来设置服务自动生成重复页面；不注入 settings 的部署照常运行。
- 页面只编辑 volatile 字段：`form.state` 提供 Host 解析值、继承层、profile 覆盖层、revision 和可写性，`form.mutate` 一次提交全部改动。保存经设置服务和 ConfigEditor 写入活动 profile 的 patch（写出的 `config` 包含全部字段），Loader 就地更新 volatile 引用，不需要重启。
- 用户不需要调的值是模块常量，不是配置：`MAX_SUGGESTION_CHARS`、`MAX_CONCURRENT`、`WAIT_GRACE_MS`。需要暴露时再加进 `FIELDS`。旧 patch 里残留的未知字段会被忽略。
- profile patch 的 `config` 是整体替换，所以 `cordis.patch.yml` 必须按顺序重述全部字段，并与 `DEFAULTS` 逐项一致（`npm test` 会校验）。browser half 无法 import Host schema，所以 `client.js` 里的 `CONFIG_FIELDS` 是 JSON 字面量，由 `verify/package.test.mjs` 与 `FIELDS` 逐项比对，防止漂移。

### 4.6 可观测性

每次发出模型请求后，以 debug 级别记录一条元数据：`promptVersion, sessionId, turn, provider, model, ms, suggestionChars, inputTokens, cacheReadTokens, outputTokens, outcome`。从不记录对话或预测内容。

发行版 profile 默认过滤 debug 日志，桌面版也看不到 Host 的 stdout，所以这些数据目前只在开发时可见（见 §9）。

## 5. Client

### 5.1 模块形态

`client.js` 是经典脚本，通过 `window.__ModuleLoader__.load({ id: 'dsh-followup-prompt', factory })` 注册。没有构建步骤和 JSX，只使用模块表提供的 React 与 baseline 模块 `@deepseek-ai/dsh-client-ui-primitives`（`SettingsForm`/`Switch`/`Tag`/`Button`），`inject: ['slots', 'locale']`。它只按 0.2.1 的真实 API 编写，不为不存在的 API 写兜底分支。`apply` 在 `ctx.effect` 中注册四样东西：词典、document 级键盘守卫、`conversation.input.overlay` slot entry（order 100，排在菜单之后）、`plugins.row.config` slot entry（插件配置页）。

所有 RPC 失败（网络错误、非 200、中止、坏 JSON、`ok: false`）都在 `call()` 里折叠成 `null`，组件只需要区分「有预测」和「没有」。

### 5.2 状态机

组件使用 slot 标准 props：`useSession`（`running`/`blank`/`awaitingFirstTurn`）、`useInput`（`draft`/`phase`/`attachmentIds`）、`inputActions`、`t`。

- **可显示**：会话空闲、不是空会话、不在等待首回合、草稿为空、`phase === 'plain'`、没有附件、不在输入法组字中。
- **请求时机**：每个空闲周期只请求一次。`running` 变为 true 或切换会话都会开启新周期；打开一个已经空闲的会话会立即请求，由 Host 缓存补上结果（catch-up）。
- **暂时隐藏**：条件不满足（比如开始打字）时隐藏并取消进行中的请求，但不 dismiss；同一周期内草稿再次清空时，直接用本地缓存的结果重新显示，不再请求。
- **结束**：接受或关闭后清空本地缓存并调用 `suggestions/dismiss`，这个回合不再出现。
- 客户端有 35 s 的兜底超时（`AbortSignal.timeout`），大于 Host 长轮询的上限 32 s。

### 5.3 内联 ghost

- overlay 的锚点是卡片顶部一个零高度层。ghost 不写死坐标：在 layout effect 里读取 `[data-composer-input]` 的 `getBoundingClientRect()` 和计算后的字体、padding，复制位置和字体；尺寸变化时重新测量。
- ghost 显示期间隐藏 `[data-composer-placeholder]`，隐藏或卸载时恢复。隐藏和定位在同一个 layout effect 里完成，避免 ghost 和 placeholder 重叠一帧。
- 整层 pointer-events 穿透，不影响光标和点击。容器是 `role="status" aria-live="polite"`，读屏会播报 ghost 文本。
- 样式只用 `--dsw-alias-*` 主题 token，深浅色自动适配。

依赖的 DOM 属性（`data-composer-input`、`-card`、`-placeholder`）是 0.2.1 的实现细节，集中定义在 `client.js` 顶部常量中。

### 5.4 键盘与输入法

- document 在 capture 阶段监听 keydown，以下条件全部满足时才处理：有可见的 ghost、不在输入法组字中（`isComposing` 或 `keyCode 229`）、没有修饰键、目标在 `[data-composer-input]` 内、没有可见的 `listbox`/`menu` 弹层。只有接受或关闭真正生效后才 `preventDefault` + `stopPropagation`，所以 Lexical 的 `TAB_COMMAND` 在没被消费时照常工作。不拦截 Enter。
- ghost 上不渲染任何按钮或按键提示：右侧不再有 `Tab 接受` 和关闭 `×`，Esc 是唯一的显式关闭入口；打字等自动隐藏后，清空草稿会重新显示本次预测。
- 写入草稿只用 `captureInsertion()` + `insertText(text, span)`：一次可撤销的插入，带草稿版本校验。`insertText` 返回 false 时不消费 Tab、也不 dismiss，绝不退回会覆盖草稿的 `setDraft`。
- 键盘守卫是全局的，通过 `activateBar` 桥接到当前可见的 ghost；只有可见的 ghost 才发布 handle，避免不可见的第二个 composer 抢走按键。
- 输入法：document 级监听 `compositionstart`/`compositionend`（目标在 composer 内）。`compositionend` 后保留 10 ms 宽限，因为 Safari 会在其后才发出 keydown。

### 5.5 文案

文案通过 `ctx.locale.register('followup-prompt', { en, zh })` 注册。`locale/*.json` 只包含插件管理器展示用的 `meta.title`/`meta.description`，必须和 `client.js` 里词典的 `meta.*` 保持一致。

### 5.6 插件配置页

Plugins 页的每个 bundle 行有一个可选的配置页插槽：`plugins.row.config`，key 是 `<包名>#<bundle patch 里的行 id>`，本插件注册为 `dsh-followup-prompt#followup-prompt`。行上因此出现 **配置** 控件，打开后页面收到 `view` 与 `form`：

- `view === 'summary'` 只返回一行说明（行的 package 描述缺失时作为兜底）。
- `view === 'page'` 时 `form.state` 是 Host 的 `ConfigFormSnapshot`：`value`（解析值）、`base`（继承层）、`user`（profile 覆盖层）、`revision`、`writable`；`form.mutate(ops, revision)` 一次性提交带路径的 `set`/`unset` 操作。页面在 `status !== 'ready'`、`form` 缺失或 profile 只读时给出对应提示。
- 编辑先落在本地草稿：文本字段保留原始文本，开关/枚举保留类型值；**覆盖** 标记取自 `user` 的 key 存在性（暂存的编辑按保存后结果预览），每行可 **重置**（`unset`，回到继承层）。
- 保存时把草稿解析成一次原子写：整数做范围校验、文本校验长度；模型选择器总是成对写入 `provider`/`model`，有错误时不发请求。保存成功清空草稿，Host 拒绝或网络失败保留草稿并提示。revision 用当前快照的 revision，Host 侧冲突检测与恢复由设置服务负责。
- 页面帧与确认控件复用 `ui-primitives`（baseline 模块，动态插件可直接 require，无需额外依赖）；行内控件用 `--dsw-alias-*` 主题 token 自绘，和官方配置页的观感一致。
- `provider` / `model` 不裸填：两行合并成一个模型选择器，选项来自 Host 的 `remote.session.modelCatalog()`（与输入框模型选择器同一份目录）。插件通过可选的 `ctx.inject(['remote', 'remote.session'])` 取得 loader，因此没有 Remote 组装的客户端仍能运行（页面显示列表不可用，而不是退化成文本框）。选择器按 provider 分组、排序与官方选择器一致（account / official 在前），**跟随当前会话** 对应 `provider`/`model` 皆空；当前配置不在目录里时保留为「当前配置」选项，避免静默改道。选中模型时，如果模型的 reasoning 元数据不包含当前 `reasoningEffort`，同一次保存里把它落回 `''`（模型默认），与 DSH 选择器的行为一致。读取失败时给出重试按钮。

## 6. 关键决策与否决方案

| 决策 | 选择 | 理由 |
|---|---|---|
| 交付形态 | 独立安装式 bundle | 只用公开 API，可以单独安装、卸载，不依赖 dsh 仓库的构建 |
| 触发 | Client 按需请求 + Host 缓存 | 只为用户正在看的会话付费；打开已结束的会话时自然能补上 |
| 回合判定 | `turn/end` 且 `reason.kind === 'completed'` | 在提交之后触发、不阻塞，此时历史已经完整。`agent/turn-stopping` 会被 loop await，拖慢回合关闭；`agent/status` 粒度不对 |
| 上下文 | 独立压缩对话 + 一次性 `ctx.llm.stream()` | 见 §4.1；不 fork 的原因见下 |
| 传输 | `/api` 下的 exact Fetch 路由 | 自动继承 `/api` 的鉴权、Origin 校验、body 限制和请求取消 |
| UI | `conversation.input.overlay` 内联 ghost | 最接近 Codex 的体验；`conversation.input.dock` 上方的建议条留作降级方案 |
| 配置页 | Plugins 页 `plugins.row.config` + `ui-primitives` 表单帧 | harness 的既定扩展点：bundle 行自己注册页面，Settings 只保留只读清单；Host 侧用 `settings.configure({ auto: false })` 声明自有页面 |
| 模型选择 | `remote.session.modelCatalog()` + 可选 `ctx.inject` | 与 DSH 自己的模型选择器同源，不需要插件维护 provider/model 表；Remote 不在时降级为不可用提示而不是裸填 |
| 存储 | 进程内 `Map<sessionId, Entry>` | 第三方插件不能新增会话事件类型 |

**为什么不 fork**：Codex 用继承式的临时 fork，让预测请求复用父会话前缀又不落盘。DSH 0.2.1 只有持久 fork：子会话会落盘、进会话列表、启动真正的 agent（工具会执行、compaction 会跑），用它做一次性预测会污染会话。

**否决的路线**

| 路线 | 否决原因 |
|---|---|
| `ctx.connection.rpc.handle` 通道 | 0.2.1-rc.2 上激活失败：`cannot get property "webServer" without inject`。注册器用 Connection 自己的 ctx（只 inject 了 `credentials`）去读 `webServer`，调用方的 inject 不起作用。in-repo 插件和第三方 `ds-bot` 都用 Fetch 路由，所以 Host 只 inject `['connection', 'llm', 'sessions']` |
| `@Remote` + Typert | Client 只挂载构建期生成的 descriptor，第三方 bundle 没有生成链 |
| 自定义 SessionEvent 推送结果 | 无法声明 `ignorable: true`，未知事件会让会话无法 reopen |
| session projection / `wire.view` | 预测在 `turn/end` 之后才完成，没有新事件触发重新发布 |
| 替换 `conversation.composer` | 要复刻整个 InputBar（Lexical、附件、快捷键、i18n） |
| 往 contenteditable 注入 DOM | Lexical reconciler 会覆盖它，并破坏选区、撤销和输入法 |
| 直接调用 `webServer.register` | 要自己实现一遍鉴权 |

## 7. 开发、验证与发布

### 7.1 打包与依赖

- `package.json`：`exports` 暴露 Host 入口、`./client`、locale 和 icon；`dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 声明浏览器半边（其中 `inject` 只是包级信息，不决定激活顺序）；`files` 限定发布内容（包含 `docs/protocol.md`，不包含 `design.md`）。
- `@deepseek-ai/dsh-llm` 和 `@deepseek-ai/schemastery` 只声明为可选 peer，不放进 `dependencies`。安装后由 DSH 的 profile 解析层指向正在运行的 dsh 安装闭包（`app.asar/dsh/node_modules`）。
- **必须用 `.tgz` 或 npm 安装**：目录安装会变成 pnpm 的 `link:`，Node 会按 realpath 从源码目录往上找 `node_modules`，`@deepseek-ai/*` 解析失败。

### 7.2 命令与离线测试

```bash
npm run links     # 在 ./node_modules/@deepseek-ai 建软链，指向本机 Harness 的共享依赖（开发用）
npm run deps:ci   # 或者：从 npm 安装 peer（CI 用）
npm test          # node:test 运行 verify/*.test.mjs
npm run pack:dry  # 查看打包内容
```

`npm run links` 找到的依赖可能来自较早的 Harness 版本，所以离线测试验证的是契约和装配，不等于与正在运行的版本行为一致。

| 测试文件 | 覆盖 |
|---|---|
| `verify/package.test.mjs` | manifest、exports、files 都存在（含中英文 README）；locale、icon；patch 按序重述全部字段且与 `DEFAULTS` 一致；client 的 `CONFIG_FIELDS` 与 Host `FIELDS` 逐项一致、配置页 key 与包名/行 id 一致；`pnpm pack --dry-run` 的内容（没有 pnpm 时跳过） |
| `verify/host.test.mjs` | 用桩 `ctx` 驱动真实 Host 模块：入口与 `Config` schema、配置解析；`settings.configure({ auto: false })` 的自有页面声明（可选注入）；压缩对话（每轮一对、丢弃 thinking 和工具内容、注入上下文不切轮、只追加）；请求策略；路由与错误信封；计费次数与缓存；dismiss；并发与 `busy`；中止；`timeoutMs` 和兜底超时；子代理排除；卸载清理 |
| `verify/client.test.mjs` | 用假 DOM 和假 hook 运行时驱动 `client.js`：模块注册、locale/slot、请求格式与静默失败、状态机、切换会话、Tab 接受（只走 `insertText`，从不 submit）、输入法、草稿与运行中隐藏、缓存复显、Esc 关闭、弹层让出 Tab、主题 token 白名单；配置页的 summary/不可用/只读视图、暂存与保存计划（布尔、文本、枚举、数字范围、provider/model 成对、重置、拒绝保留草稿） |

缺口：假 DOM 的 `querySelector` 返回 `null`，ghost 测量和 placeholder 隐藏没有覆盖，需要用 jsdom 补。另一处：消融实验发现把 `host/index.js` 的 `turn/start` 监听整段删掉后 85 个测试仍全绿——它保护的“新回合开始时中止在途生成、停止继续计费”没有回归测试；建议补一条（删除 listener 后 `harness.calls` 应在 turn/start 后不再增长）。

### 7.3 真机验收

2026-10-20，Desktop profile，dsh 0.2.1-rc.2：

| 检查 | 结果 |
|---|---|
| `.tgz` 安装 | `application: applied`，没有 warning |
| Host row 激活 | `fiberPhase: active`；`Config.listConfigs({name:'dsh-followup-prompt'})` 能拿到 schema |
| Client slot 注册 | `Slots.listSubTree` 中 `conversation.input.overlay` 下有 `followup-prompt`，order 100，状态 `active` |
| 鉴权传输 | 用浏览器 cookie 调用路由：坏请求、未知端点、未知会话都返回预期结果 |
| 真实预测 | 首轮冷启动 13,119 prompt tokens；第二轮 13,508 prompt tokens，命中缓存 13,056（96.65%），耗时 1.76 s，返回预测 |
| dismiss | dismiss 后再 wait 返回 `stale` |

2026-10-22，Desktop profile，dsh 0.2.1-rc.2（本地开发构建，未发布）：

| 检查 | 结果 |
|---|---|
| `.tgz` 安装（本地开发包） | `application: applied`，`warnings: []` |
| Client slot 注册 | `Slots.listSubTree` 中 `plugins.row.config` 下有 `dsh-followup-prompt#followup-prompt`，状态 `active`（HMR 直接生效，未刷新页面） |
| Host 配置 schema | `Config.listConfigs` 仍为 `schema`（9 个 volatile 字段，当次验收时） |
| 待人工确认 | 行上出现 **配置** 入口；页面能读到 `form`、保存写入 profile patch、重启后保留 |

2026-10-22，Desktop profile，dsh 0.2.1-rc.2（本地开发构建，未发布）：

| 检查 | 结果 |
|---|---|
| `.tgz` 安装（本地开发包） | `application: applied`，`warnings: []` |
| Client slot 注册 | `plugins.row.config` 仍有 active occupant（可选的 `remote.session` 注入没有阻止插件加载） |
| 待人工确认 | 配置页的模型下拉列出 DSH 已配置的 provider/model；切换模型保存后 profile patch 的 `provider`/`model` 同步更新 |

2026-10-22，Desktop profile，dsh 0.2.1-rc.2（本地开发构建，未升版本；依次删除 `maxTurns` / `prefetchOnTurnEnd` / `enabled` 后）：

| 检查 | 结果 |
|---|---|
| remove_bundle + 重装 0.2.3（同一版本） | 两步都 `application: applied`；profile 依赖仍指向同一 tgz |
| Host 配置 schema | `Config.listConfigs` 为 `schema`，属性只剩 6 个 volatile 字段（`provider`、`model`、`reasoningEffort`、`maxTokens`、`timeoutMs`、`prompt`），已无 `enabled` / `maxTurns` / `prefetchOnTurnEnd` |
| Client slot 注册 | `plugins.row.config` 下 `dsh-followup-prompt#followup-prompt` 仍为 `active` |
| 待人工确认 | 配置页只剩 5 行（模型、推理强度、maxTokens、timeoutMs、prompt） |

仍需在页面上人工确认：

1. Tab 与 Lexical、斜杠命令弹层的竞争，以及 `[data-composer-input]` 能否命中；
2. `captureInsertion`/`insertText` 的真实行为，一次撤销能否撤回；
3. ghost 在深色/浅色、有附件、多行输入、不同字号下的对齐；
4. 切换会话不串、输入法组字时隐藏、断网静默、多窗口不重复计费、卸载后不留监听器；
5. 非 DeepSeek provider 能否接受压缩对话（不带 tools）。

### 7.4 升级回归清单

DSH 升级后逐项核对：slot 名和标准 props；`data-composer-input`/`-placeholder`/`-card` 是否还在；ghost 对齐；`inputActions.captureInsertion`/`insertText` 是否还在；`connection.fetch.register` 的契约；`session.deriveMessages`/`requestHeader`/`snapshotEvents` 的签名。任何一项有变化，先按顺序降级：overlay ghost → `conversation.input.dock` 建议条 → 在插件页关掉插件。

### 7.5 发布

```bash
npm version patch          # 修改 version、提交并打 vX.Y.Z tag；预发布用 npm version prerelease --preid rc
npm publish                # 本地发布，prepublishOnly 会先跑 npm test；预发布加 --tag next
git push --follow-tags
```

先 publish 再 push：发布失败时 tag 不会推出去。npm 在本地发布，需要 `npm login` 和 2FA。推送 `v*` tag 会触发 `.github/workflows/release.yml`：校验 tag 与 `package.json` 版本一致 → `npm run deps:ci` + `npm test` → `gh release create`（附上 `npm pack` 产物，自动生成 release notes）；带 `-` 后缀的版本标为 prerelease。

CI 里没有 Harness，`deps:ci` 从 npm 安装 peer。`dsh-llm` 固定为与基线一致的 `0.2.1-rc.2`，因为它的 `latest` dist-tag 是更旧的 `0.0.1-rc.1`，测试会失败。升级基线时要同步修改。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 额外计费 | 插件行开关、按需触发、按回合缓存、并发上限、超时、可改用小模型；README 写明 |
| Client 依赖 0.2.1 私有 DOM 结构，升级后错位 | 常量集中、失败静默、升级回归清单 |
| `/api` exact Fetch 路由不是稳定的公开 API | `engines` 锁定 0.2.x；随时可以关闭 |
| 压缩对话信息量不足 | 保留双方完整可见文本 |
| 压缩对话随会话无限增长（不再有轮数上限） | 只保留可见文本，通常远小于原始历史；超出模型上下文时预测静默失败，不影响主对话，需要时再设计上限 |
| provider 前缀缓存 TTL 太短 | 退化为每次付全价，但压缩对话很小，成本仍然可控 |
| 键盘桥是全局单槽，不区分会话 | 只有可见的 ghost 发布 handle；彻底解决需要 slot 帧提供会话身份 |
| 本地密钥过滤是启发式 | 永不自动发送，用户可以编辑 |

## 9. 后续方向

- **用量可见**：每次预测的 token 和缓存命中目前只写进 debug 日志，用户实际上看不到。可行的做法是：Host 在内存里按会话和全局聚合 usage，新增 `usage/stats` 端点；Client 在 `conversation.composer.dock`（DSH 自带用量胶囊的位置）注册一个胶囊。预测不写会话事件，所以 DSH 自带的 token 统计永远看不到它。
- **打字后不再请求**：请求进行中用户开始打字，请求会被取消、Host 也会中止生成；之后清空草稿，这一回合不会再请求。要修就得允许取消后重新请求，代价是可能多计费一次。
- **上游化**：如果要默认内置，迁到 dsh 仓库：Host 改用 `@Remote` + Typert，预测请求记一条只写日志的会话事件以便审计；`ui-conversation` 提供官方的 composer suggestion 扩展点，在 Lexical 的文本原点渲染 ghost，取代插件侧的绝对定位；配置页可以变成 `packages/client/ui-settings-*` 之类的 companion 包，注册到 `plugins.item` 并列出在 web-app 的 bundle roster 里。Host 预测服务和 Client 呈现已经是两个薄层，迁移时只需替换通信和 UI 挂载。
