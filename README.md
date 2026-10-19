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
| Client 半边（`conversation.composer.dock` 建议条、Tab/点击接受、IME、i18n、静默失败） | ✅ 骨架实现完成 |
| 离线验证（语法、清单、manifest、桩驱动冒烟、pack 文件清单） | ✅ `npm test` |
| 安装到真实 profile + 真机交互验证（§7.2 清单） | ⬜ 待做（需安装审批） |
| 内联 ghost 样式（`conversation.input.overlay`，P2） | ⬜ 未实现，v1 固定用下方建议条 |
| 自查设置页（`settings.section`，P2） | ⬜ 未实现，v1 用 Settings 自动表单 / patch |

> 本仓库当前是「可安装、可离线验证」的 v0.1 骨架：离线检查证明装配与契约，**不证明**真机行为。
> 真机验收按方案 §7.2 执行；未验证点见下文「验证状态」。

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
2. 刷新页面后 `Slots.listSubTree` 能看到本插件在 `conversation.composer.dock` 的注册；
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
2. 输入框下方出现一条「预测 / Prediction」建议条；没有建议也不报错（provider 失败会静默）。
3. 按 **Tab**：建议文本进入输入框成为草稿；**不发送**；可继续编辑；`Cmd/Ctrl+Z` 一次撤销（走 `insertText` 时）。
4. 继续打字 / 切换会话 / 中文输入法组合输入：建议隐藏或作废，输入不受影响。
5. 点 × 或 Esc：本次建议消失，且同一回合不再出现。

完整真机清单（14 项）见方案 §7.2。

## 配置

Host `Config`（schemastery，全部字段 `.volatile()`）会在 **Settings → Plugins → Followup Prompt** 生成表单，
写回 profile patch；也可以直接改 `cordis.patch.yml`。**patch 覆盖是整体替换 config，改一个字段也要重述全部字段。**

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后不再产生任何模型请求。 |
| `provider` / `model` | `''` / `''` | 空 = 沿用源会话当前路由；两者必须成对设置。 |
| `reasoningEffort` | `''` | `'' \| off \| low \| high \| max`；非 DeepSeek provider 可能不支持 `off`，失败会静默。 |
| `maxTokens` | `160` | 预测输出上限。 |
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
session/event → turn/end(completed)             conversation.composer.dock 建议条
  → 继承式一次性 ctx.llm.stream                  ← 长轮询 suggestions/wait ←
  → 归一化 + 内存缓存                              Tab/点击 → inputActions 写入草稿（不发送）
  → connection.rpc.handle('/followup-prompt')      → suggestions/dismiss
```

- **不 fork、不进 agent loop**：上下文 = `session.deriveMessages()` 全量 + `requestHeader().tools` + `toolHistory()`
  + 尾部一条预测指令，与父会话下一次请求前缀一致以复用 provider 上下文缓存。
- **tool 调用绝不执行**：保留 tools 定义；模型若发起 tool-call，统一回 `isError` tool-result 让它继续，
  最多 `maxToolRejectRounds` 轮后静默放弃。
- 通道走 DSH 自带鉴权 RPC（Host/Origin 校验 + 浏览器 cookie），无需自建后端。
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
├── cordis.patch.yml        # Host Loader row（config 全字段重述）
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

## 验证状态

**已完成的离线检查**（`npm test`）：

- 所有运行时 JS `node --check`；`package.json` manifest / exports / `files` 完整性；
- locale JSON、icon SVG、`cordis.patch.yml` 结构（字段齐全、无 unknown key）；
- Host 入口契约（name/inject/Config/apply）与 Client 契约（ModuleLoader id、dock slot、RPC endpoint、无 `submit()`）；
- Host/Client 桩驱动冒烟：通道注册、turn/end 触发、缓存命中、dismiss、坏请求、tool-call 拒绝、slot 注册等；
- `pnpm pack --dry-run` 打包文件清单。

**尚未完成（需要安装到活体后验证）**：

1. 真实 Harness 中 Host row 激活、Config schema 出现在 Settings；
2. `turn/end` 后一次真实预测请求与建议条渲染；
3. Tab 与 Lexical / slash 命令弹层的竞争、`[data-composer-input]` 命中（失败则退回「只点击接受」）；
4. `inputActions.captureInsertion/insertText` 的真实行为与一次撤销；焦点归还；
5. 建议条在深/浅色、附件栏、多行输入下的版式；
6. provider 前缀缓存命中（方案 §7.5 的 A/B）；
7. 非 DeepSeek provider 对合成 tool-call 历史的接受度（失败则降级为「tool-call 即放弃」）。

## 已知限制

- v1 只有 composer 下方建议条，没有 Codex 风格的内联 ghost；ghost 见方案 §5.3 P2。
- 预测请求会计费；无官方 moderation / 审计事件 / 正式遥测。
- `connection.rpc` 传输契约尚未标记 stable；Client 侧的 slot props / `data-composer-input` 属于 0.2.1 实现细节，
  升级后按方案 §7.4 回归；出问题可用 `enabled=false` 立即关闭。
- 第三方 bundle 不能新增 session 事件类型，因此预测请求不可从会话日志审计/重放。

## 卸载 / 回滚

1. `plugin_manager` → `remove_bundle`（`dsh-followup-prompt`）；
2. 需要时重启 Harness；建议刷新页面；
3. 确认 profile patch 未残留本插件的 row/config（安装器会移除自己写入的行）；
4. 应急：把 `config.enabled` 改为 `false` 即可停止一切模型请求。

## License

[MIT](LICENSE)
