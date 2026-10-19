# Followup Prompt（后续提示）

> 给 DeepSeek Harness 的「下一条消息预测」插件，对标 Codex Composer Predictions。
> 每轮回答结束后，在空输入框下方预测你接下来最可能输入的消息；按 **Tab** 接受成**可编辑草稿**，**绝不自动发送**。

- 包名 / 产品名：`dsh-followup-prompt`（Loader row id：`followup-prompt`）
- 形态：一个安装式 bundle（Host 半边 + 浏览器半边同包），纯 DSH 公共 API，**不需要任何服务端特殊接口**
- 版本基线：DSH Desktop **0.2.1-rc.2**（`engines.dsh: >=0.2.0 <0.3.0`）
- 方案与证据：[`dsh-followup-prompt-plan.md`](dsh-followup-prompt-plan.md)；协议：[`docs/protocol.md`](docs/protocol.md)

---

## 当前状态（项目初始化）

| 项 | 状态 |
|---|---|
| 包结构与清单（package.json / patch / locale / icon / files / exports） | ✅ 已完成 |
| Host 半边（触发、继承式一次性调用、tool-rejection、缓存、RPC 通道、Config） | ✅ 骨架实现完成 |
| Client 半边（`conversation.input.overlay` 内联 ghost（输入框内）、Tab 接受、IME、i18n、静默失败） | ✅ 实现完成 |
| 离线验证（语法、清单、manifest、桩驱动冒烟、pack 文件清单） | ✅ `npm test`（32 项检查；Host 冒烟 33 条、Client 冒烟 40 条断言） |
| 安装到真实 profile（Desktop，2026-10-19） | ✅ `application: applied`，无 warnings；Host row `active` |
| Host 真机生成（真实 LLM 建议 + dismiss） | ✅ 已通过（见下文「真机验收记录」） |
| Client 真机注册（input.overlay occupant） | ✅ `followup-prompt` order 100 `active`（输入框内 ghost） |
| 真机 UI 人工交互（Tab/IME/视觉版式/前缀缓存 A/B） | ⬜ 待人工验证（方案 §7.2 #3–#7、§7.5） |
| 内联 ghost 样式（`conversation.input.overlay`，P2） | ✅ 已实现：按真实编辑器矩形/字体对齐，显示期间隐藏原生 placeholder |
| 自查设置页（`settings.section`，P2） | ⬜ 未实现，v1 用 Settings 自动表单 / patch |

> 本仓库当前是**已安装、Host/Client 已真机打通**的 v0.1 骨架：离线检查证明装配与契约，真机验收证明
> 「安装 → Host 生成 → 鉴权路由 → 浏览器注册」主链路。Tab/IME/视觉与缓存 A/B 仍待人工确认。

---

## 功能

- 回合结束（`turn/end` 且 `reason.kind === 'completed'`）后，在空输入框下方展示一条预测建议。
- **Tab 接受**：建议写入草稿（一次可撤销插入，光标在末尾），不发送、不额外确认；点击接受同理。
- 继续打字、开始新回合、切换会话、IME 组合输入期间自动隐藏；失败/超时/未命中一律**静默**。
- 打开一个已经结束的会话（catch-up）也会请求一次；Host 按 `(sessionId, completedTurn)` 缓存去重，不重复计费。
- 单一总开关；可配置采样率、超时、输出上限、并发、模型覆盖等。

## 要求

- DeepSeek Harness `>=0.2.0 <0.3.0`（开发基线 0.2.1-rc.2）。
- 浏览器半边只依赖 DSH Web 自带的 React / slot / locale / connection 服务，不额外安装依赖。

## 安装

安装会写当前 profile 的 `package.json` / lock，并需要完整权限批准；建议先在可丢弃的测试 profile 验证。

### 1. 打包后安装（推荐）

```bash
cd dsh-followup-prompt
pnpm pack                 # 产出 dsh-followup-prompt-0.1.0.tgz
```

然后通过 Harness 的 `plugin_manager` → `install_bundle`，`target` 传 `.tgz` 的**绝对路径**。
安装后：

1. `cordis_inspect_query` 的 `Config.listConfigs({name:'dsh-followup-prompt'})` 出现 Host 行 = 已激活；
2. 刷新页面后 `Slots.listSubTree` 能看到本插件在 `conversation.input.overlay`（输入框内浮层）的注册；
3. 按「快速验证」走一遍。

> 用 `.tgz`（真实目录）而不是本地目录：本地目录安装是 pnpm `link:`，Host 代码会从 workspace 解析
> `@deepseek-ai/*`，容易失败；`.tgz` 安装后可从 profile 的共享 `node_modules` 闭包正常解析。

### 2. 从 npm 安装（发布后）

包名 `dsh-followup-prompt`（发布前用 `npm view dsh-followup-prompt` 复核占用）。安装方式同上。

### 3. 本地目录安装（仅调试，不推荐）

见方案 §6.2 的注意项。若必须：Host 半边需要保持**零 bare import**（本项目当前**不是**零 import，依赖
`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery`），或者先执行 `pnpm links` 在本仓库创建共享包软链，
再用目录安装。正式安装请仍用 `.tgz`。

## 快速验证（安装后）

1. 发一个问题，等回答结束（输入框为空、焦点在 composer）。
2. 空输入框内出现灰色 ghost 文本（原 placeholder 位置），右侧有 `Tab 接受` 提示；没有建议也不报错（provider 失败会静默）。
3. 按 **Tab**：ghost 文本进入输入框成为草稿；**不发送**；可继续编辑；`Cmd/Ctrl+Z` 一次撤销（走 `insertText` 时）。
4. 继续打字 / 切换会话 / 中文输入法组合输入：建议隐藏或作废，输入不受影响。
5. 点右侧 × 或 Esc：本次建议消失，且同一回合不再出现。

完整真机清单（14 项）见方案 §7.2。

## 配置

Host `Config`（schemastery，全部字段 `.volatile()`）会在 **Settings → Plugins → Followup Prompt** 生成表单，
写回 profile patch；也可以直接改 `cordis.patch.yml`。**patch 覆盖是整体替换 config，改一个字段也要重述全部字段。**

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后不再产生任何模型请求。 |
| `provider` / `model` | `''` / `''` | 空 = 沿用源会话当前路由；两者必须成对设置。 |
| `reasoningEffort` | `'off'` | `'' \| off \| low \| high \| max`；默认关闭推理以压低延迟/成本（真机发现沿用源会话 `max` 会吃光输出预算）。非 DeepSeek provider 可能不支持 `off`，失败会静默；可改 `''` 跟随 provider 默认。 |
| `maxTokens` | `400` | 预测输出上限（推理 token 也计入；默认值给推理型模型留余量）。 |
| `timeoutMs` | `15000` | 总 deadline（2s–30s），覆盖所有 tool-rejection 轮次。 |
| `maxTurns` | `0` | `0` = 不按轮裁剪（默认，保留父请求前缀缓存）；>0 仅降级模式。 |
| `maxInputChars` | `20000` | 超预算时从最旧安全切点裁剪（牺牲缓存命中）。 |
| `maxToolRejectRounds` | `1` | 保留 tools 时模型调工具的拒绝轮次上限；仍调用则静默放弃。 |
| `toolRejectionText` | `''` | 统一错误回执文案；空 = 内置文案。 |
| `maxSuggestionChars` | `400` | 建议最大长度，超出截断。 |
| `stripMedia` | `false` | 默认不 strip（strip 会破坏与父请求前缀一致），仅降级模式启用。 |
| `sampleRate` | `1.0` | 确定性采样（`hash(sessionId,turn)`），同一回合多次请求结果一致。 |
| `prefetchOnTurnEnd` | `false` | 回合结束即预生成（会为所有活跃会话付费，慎用）。 |
| `cacheTtlMs` | `600000` | 进程内缓存 TTL。 |
| `maxConcurrent` | `2` | 全局并发上限；超限返回 `busy`。 |
| `excludeSubagents` | `true` | 子代理会话不预测。 |
| `uiMode` | `'dock'` | v1 仅实现 `dock`（建议条）；`ghost` 为 P2。 |
| `prompt` | `''` | 高级：覆盖默认预测指令。 |

## 隐私与计费

- **会计费**：预测是普通 `GenerateOptions` 请求，按你配置的 provider 正常计费（Codex 的 prediction 免计费语义在
  DSH 侧不适用）。用 `enabled` / `sampleRate` / `maxInputChars` / `timeoutMs` 控制成本。
- **数据边界**：会把当前会话历史发给**该会话正在使用的 provider/model**（与正常聊天同一信任域）；
  若覆盖了 `provider/model`，数据会流向新的 provider，请自行确认。
- **无服务端 moderation**：第三方插件拿不到 Codex 等价的 moderation 元数据；用「不自动发送 + 可编辑 + 本地保守过滤」兜底。
- **不落盘**：预测只在 Host 进程内存与浏览器内存中，进程退出即消失；不写会话日志、不写文件。
- **日志**：只记非敏感元数据（session、turn、provider/model、耗时、token、轮次、结果码），不记 transcript。
- **无遥测上报**。

## 架构

```
Host（Node）                                    Client（Web）
session/event → turn/end(completed)             conversation.input.overlay 内联 ghost（输入框内）
  → 继承式一次性 ctx.llm.stream                  ← 长轮询 suggestions/wait ←
  → 归一化 + 内存缓存                              Tab/点击 → inputActions 写入草稿（不发送）
  → POST /api/followup-prompt/rpc                  → suggestions/dismiss
```

- **不 fork、不进 agent loop**：上下文 = `session.deriveMessages()` 全量 + `requestHeader().tools` + `toolHistory()`
  + 尾部一条预测指令，与父会话下一次请求前缀一致以复用 provider 上下文缓存。
- **tool 调用绝不执行**：保留 tools 定义；模型若发起 tool-call，统一回 `isError` tool-result 让它继续，
  最多 `maxToolRejectRounds` 轮后静默放弃。
- 传输走 DSH 自带的 `/api` exact Fetch 路由（Host/Origin 校验 + 浏览器 cookie 鉴权），无需自建后端。
  注意：不能用 `ctx.connection.rpc.handle`——0.2.1 上该路径会以 Connection 服务自身的 ctx 去读
  `webServer` 而激活失败（实测 `cannot get property "webServer" without inject`），Fetch 路由才是
  in-repo 插件与 ds-bot 使用的受支持机制。
- 详细协议见 [`docs/protocol.md`](docs/protocol.md)；设计与证据见方案 §3、§4、§5、§13。

## 开发

```bash
# 1) 让 Host 的 @deepseek-ai/* 在当前 checkout 可解析（开发/测试用；node_modules 已 gitignore）
npm run links

# 2) 静态检查（语法 / 清单 / locale / icon / patch / 入口契约）
npm run check

# 3) 完整离线验证（静态检查 + Host/Client 桩驱动冒烟 + pnpm pack --dry-run 文件清单）
npm test

# 4) 只看打包内容
npm run pack:dry
```

目录：

```
dsh-followup-prompt/
├── package.json            # dsh.bundle.patch + dsh.client + exports/files/engines
├── cordis.patch.yml        # Host Loader row（config 全字段重述，且与 Config 默认值逐项一致）
├── host/                   # Host 半边：index / config / prediction / cache / channel
├── client.js               # 浏览器半边：lazy-CJS + React.createElement，无构建步骤
├── locale/{en,zh}.json     # 插件管理器展示用 meta.title/description
├── icon.svg                # 原创图标
├── docs/protocol.md        # Host↔Client 线协议与状态机
├── verify/                 # 桩驱动冒烟与离线检查（不随包发布）
├── scripts/link-dev-deps.mjs
├── README.md
└── LICENSE
```

### 依赖解析（开发 vs 安装后）

- **安装后**：Host 代码里的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery` 由 DSH 的
  profile-resolution 拦截层解析到**正在运行的 dsh 安装闭包**（`app.asar/dsh/node_modules`），
  不使用本仓库或 `~/.dsh/profiles/node_modules` 里的物理副本。因此无需把 `@deepseek-ai/*`
  写进 `dependencies`；`peerDependenciesMeta.optional` 只用于声明兼容性，不触发安装。
- **开发/离线验证**：本仓库没有该拦截层，`npm run links` 会在 `./node_modules/@deepseek-ai`
  创建指向一个 DSH 共享依赖目录的软链供 Node 解析。该目录可能来自**更早的 Harness 版本**
  （本机实测为 `0.1.7-alpha.2`，而运行中的应用是 `0.2.1-rc.2`），所以离线冒烟验证的是
  「契约与装配」，不是与活体安装包逐字节一致的运行时。安装后的真机验证仍以方案 §7.2 为准。

## 验证状态

**已完成的离线检查**（`npm test`，共 32 项检查，全部通过）：

- 所有运行时 JS `node --check`；`package.json` manifest / exports / `files` 完整性；
- locale JSON、icon SVG、`cordis.patch.yml` 结构（19 个字段齐全、无 unknown key，且**逐项等于** `host/config.js` 的 `DEFAULTS`）；
- `Config` schema 实测：19 个默认值、volatile live refs 解包、越界值拒绝、provider/model 必须成对；
- Host 入口契约（name/inject 三项: connection/llm/sessions + `/api` Fetch route/Config/apply）与 Client 契约（classic script 无 import/export、ModuleLoader id、dock slot、`api/followup-prompt/rpc` + `credentials: same-origin`、`[data-composer-input]` 门、无 `submit()`）；
- Host 桩驱动冒烟 **33 条**（/api 路由注册一次且 shape 正确、turn/end 触发一次调用、缓存命中不重复计费、dismiss→stale、坏请求/未知 endpoint 信封、tool-call 拒绝的配对合法性/轮次上限/重复 callId、采样、并发 busy、abort 语义、prefetch、TTL、子代理排除、裁剪/turn cap/stripMedia、卸载清理）；
- Client 桩驱动冒烟 **40 条**（模块 id/inject/apply、locale+slot 注册、fetch 请求 shape/AbortSignal/静默失败、状态机渲染路径、Tab 接受 insertText/回退 setDraft、IME/草稿/running 隐藏、缓存复显、关闭/Esc、源码护栏）；
- `pnpm pack --dry-run` 打包文件清单（含 host/、client.js、patch、locale、icon、docs/protocol.md、README、LICENSE）。

### 真机验收记录（2026-10-19，Desktop profile，dsh 0.2.1-rc.2）

**已通过**

| # | 检查 | 结果 |
|---|---|---|
| 1 | `plugin_manager install_bundle`（`.tgz` 真实安装） | `application: applied`，`warnings: []` |
| 2 | Host Loader row 激活 | `include:followup-prompt` → `fiberPhase: active`；`Config.listConfigs` 有 schema |
| 3 | Client slot 注册 | `conversation.input.overlay`（输入框内 ghost）occupants: `followup-prompt` order 100 `active: true` |
| 4 | 鉴权传输 | 用浏览器 cookie 调 `POST /api/followup-prompt/rpc`：坏请求→`followup-prompt/bad-request`、未知 endpoint→`followup-prompt/bad-endpoint`、未知会话→`unknown-session` |
| 5 | **真实 LLM 预测** | 临时会话（已归档）第 2 回合：`{"suggestion":"先聊聊测试覆盖率和 CI 流程吧","turn":2}` |
| 6 | dismiss 语义 | `suggestions/dismiss` 后再次 wait → `{suggestion:null,reason:"stale"}` |

**真机验收中发现并已修复的两个问题**

1. `ctx.connection.rpc.handle()` 在 0.2.1 上激活失败：`cannot get property "webServer" without inject`
   （RPC 注册器用 Connection 服务自身的 ctx 读 `webServer`，调用方的 inject 不生效；in-repo 插件无一处使用该路径）。
   → 改为 `ctx.connection.fetch.register` 的 `/api/followup-prompt/rpc` exact Fetch 路由（ds-bot 同款）。
2. 预测请求继承了源会话 `reasoningEffort: max`，在 `maxTokens: 160` 下 finish=max-tokens、无文本建议。
   → 默认改为 `reasoningEffort: 'off'` + `maxTokens: 400`（见配置表），真机重测即返回建议。

**仍需人工在页面上确认**

1. Tab 与 Lexical / slash 命令弹层的竞争、`[data-composer-input]` 命中（失败则退回「只点击接受」）；
2. `inputActions.captureInsertion/insertText` 的真实行为与一次撤销；焦点归还；
3. 建议条在深/浅色、附件栏、多行输入下的版式；
4. provider 前缀缓存命中（方案 §7.5 的 A/B）；
5. 非 DeepSeek provider 对合成 tool-call 历史的接受度（失败则降级为「tool-call 即放弃」）。

## 已知限制

- 内联 ghost 依赖 0.2.1 的 `[data-composer-input]` / `[data-composer-placeholder]` 结构与版式，升级后需按方案 §7.4 回归；若版式对不齐，可降级为 `conversation.input.dock` 的上方建议条（保留在方案 §5.3）。
- 预测请求会计费；无官方 moderation / 审计事件 / 正式遥测。
- `/api` exact Fetch 路由属于 DSH 内部契约（非 stable 公开 API）；Client 侧的 slot props / `data-composer-input`
  属于 0.2.1 实现细节，升级后按方案 §7.4 回归；出问题可用 `enabled=false` 立即关闭。
- 第三方 bundle 不能新增 session 事件类型，因此预测请求不可从会话日志审计/重放。

## 卸载 / 回滚

1. `plugin_manager` → `remove_bundle`（`dsh-followup-prompt`）；
2. 需要时重启 Harness；建议刷新页面；
3. 确认 profile patch 未残留本插件的 row/config（安装器会移除自己写入的行）；
4. 应急：把 `config.enabled` 改为 `false` 即可停止一切模型请求。

## License

[MIT](LICENSE)
