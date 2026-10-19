# DSH「fork 会话」全链路调研：客户端 UI → Remote/Typert → Host Controller

- 调研对象：DSH（DeepSeek Harness）`0.2.1-rc.2`（`package.json` 版本号），源码 checkout 位于 `/Users/keli/Workspace/personal/works/deepseek-harness`，git HEAD `687f282e86`（2026-10-17），工作区干净。
- 约束：源码 checkout 只读（本文所有结论来自源码与测试源码阅读，**未执行测试**：该 checkout 没有 `lib/` 构建产物，见「未解问题」）；本文只写入 `research/fork-api-ui.md`。
- 目标：把「用户点分叉」到「Host 建出子会话、列表更新、导航到子会话」的每一层、每个错误码、每条产品行为梳理到 `file:line`。

## 0. 阅读约定（缩写 ↔ 路径）

| 缩写 | 仓库路径 |
|---|---|
| `CMD` | `packages/api/session-controller/src/commands.ts` |
| `CTRL` | `packages/api/session-controller/src/index.ts` |
| `TYPES` | `packages/api/session-controller/src/types.ts` |
| `AGENT` | `packages/api/session-controller/src/agent.ts` |
| `LIST` | `packages/api/session-controller/src/list.ts` |
| `SVC` | `packages/api/session-controller/src/client/sessions/service.ts` |
| `MGR` | `packages/api/session-controller/src/client/sessions/manager.ts` |
| `LINEAGE` | `packages/api/session-controller/src/client/sessions/lineage.ts` |
| `CONTRACT` | `packages/api/session-controller/src/client/contract/sessions.ts` |
| `CLIENTIDX` | `packages/api/session-controller/src/client/index.ts` |
| `WIDX` | `packages/client/ui-workspace/src/client/index.ts` |
| `NAVID` | `packages/client/ui-workspace/src/client/navigation.ts` |
| `SHORT` | `packages/client/ui-workspace/src/client/shortcuts.ts` |
| `FORKROW` | `packages/client/ui-workspace/src/client/session-actions/ForkSession.tsx` |
| `WSLOTS` | `packages/client/ui-workspace/src/client/contract/slots.ts` |
| `TREE` | `packages/client/ui-workspace/src/client/tree.ts` |
| `ROWS` | `packages/client/ui-workspace/src/client/rows/Rows.tsx` |
| `WBROWSER` | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` |
| `TOAST` | `packages/client/ui-workspace/src/client/toast/register.ts` |
| `WLOC` | `packages/client/ui-workspace/src/client/locales.ts` |
| `CHATAPPLY` | `packages/client/ui-chat/src/client/apply.ts` |
| `TURNTAIL` | `packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx` |
| `ICON` | `packages/client/ui-chat/src/client/chat/MessageIconActions.tsx` |
| `TTAILDATA` | `packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts` |
| `CSLOTS` | `packages/client/ui-chat/src/client/contract/slots.ts` |
| `CLOC` | `packages/client/ui-chat/src/client/locale.ts` |
| `SFORK` | `packages/core/session/src/fork.ts` |
| `SESSION` | `packages/core/session/src/index.ts` |
| `REPAIR` | `packages/core/session/src/repair.ts` |
| `AGENTREG` | `packages/core/agent/src/index.ts` |
| `WENTITY` | `packages/workspace/workspace/src/entity.ts` |
| `GW` | `packages/api/gateway/src/index.ts` |
| `GWC` | `packages/api/gateway/src/client/index.ts` |
| `RA` | `packages/api/remote-access/src/index.ts` |
| `RACLIENT` | `packages/api/remote-access/src/client/mount.ts` |
| `RASTATE` | `packages/api/remote-access/src/client/state.ts` |
| `TERR` | `packages/typert/protocol/src/types.ts` |
| `TPROTO` | `packages/typert/protocol/src/index.ts` |
| `SCREADME` | `packages/api/session-controller/README.md` |
| `WREADME` | `packages/client/ui-workspace/README.md` |
| `FORKSPEC` | `packages/api/session-controller/tests/session-fork.host.spec.ts` |
| `CFORKSPEC` | `packages/api/session-controller/tests/commands-create-fork.host.spec.ts` |
| `SVCFORKSPEC` | `packages/api/session-controller/tests/sessions-service.client.spec.ts` |
| `MGRSPEC` | `packages/api/session-controller/tests/manager.client.spec.ts` |
| `APPSPEC` | `packages/client/ui-workspace/tests/apply.client.spec.ts` |
| `SHORTSPEC` | `packages/client/ui-workspace/tests/shortcuts.client.spec.ts` |
| `ROWSPEC` | `packages/client/ui-workspace/tests/session-actions.client.spec.tsx` |
| `TREESPEC` | `packages/client/ui-workspace/tests/tree.client.spec.ts` |
| `CHATSPEC` | `packages/client/ui-chat/tests/chat-view.client.spec.tsx` |
| `INJECTSPEC` | `packages/client/ui-chat/tests/apply-inject.client.spec.tsx` |

正文用 `缩写:行号` 引用；证据总表（§8）展开每个缩写的完整路径。

---

## 1. 结论摘要（TL;DR）

1. **UI 上有两个入口，共用同一个 Host 能力 `session/fork`**：侧栏会话菜单行（以及快捷键 `session.fork`）走「Host 自选最近完成轮次前缀」；消息尾部 branch 按钮走「精确 `turn/end` seq」。`FORKROW:12-30`、`SHORT:96-110`、`TURNTAIL:64-78`、`CHATAPPLY:285-295`。
2. **Host 端 fork = 冷/热观测源会话 → 截取精确事件前缀 → 补合成收尾事件 → 用 `ctx.agents.create({ seed, inheritedEventCount, meta.isSeeded, parentSession })` 创建子 Agent →（可选）挂到 Workspace**；全程不 resume/不激活源会话的 Agent。`CMD:227-310`、`FORKSPEC:165-183`、`FORKSPEC:385-439`。
3. **`atSeq` 省略时的默认 boundary 不是「最后一条事件」**：取最近 `turn/end` 的 seq，然后**继续吸收**其后的「独立尾部事件」（如 `session/title`），直到下一个 `turn/start`、append 型 `user/message`、`agent/inbox/spliced` 为止。`CMD:76-90`、`CMD:251`、`FORKSPEC:441-462`、`FORKSPEC:476-495`。
4. **子会话 Header 语义**：`parentSession = 源会话 id`、`isSeeded = true`、`cwd` 从源 header 复制、`origin` **不设置**（普通 fork 子会话是独立普通会话，不是 subagent）；子 session 在 `inheritedEventCount = boundary + 1` 处带 `session/end-seed { inherited: true }` 标记。`CMD:276-290`、`SFORK:21-29`、`SESSION:665-702`、`FORKSPEC:327-340`、`FORKSPEC:342-383`。
5. **Host 完全不处理标题**：fork 方法体内无标题逻辑；子会话通过复制前缀继承源会话的 `session/title` 事件，随后**由客户端** `increaseTitle` 递增并调用 `session/rename`。`CMD:227-310`、`CMD:199-218`、`SVC:466-483`、`SVC:134-144`。
6. **两个入口的迁移门禁不同（有意设计）**：侧栏菜单显式传 `allowMigration: false`（需要迁移时 toast 让用户先打开源会话）；快捷键与消息尾部按钮**省略** `allowMigration`（Host 默认允许自动迁移）。`WIDX:224-235`、`SHORT:102`、`CHATAPPLY:288`、`CTRL:444-451`、`WREADME:56,62`。
7. **列表更新是本地占位 + Host summary 合并**：fork 响应成功（甚至 `workspace-attach-failed`）都会在客户端先落一个 `blank:true, parentSessionId:源, cwd:源` 的占位 summary，随后被 Host 的 `api-session/added`/list 更正；标题 rename 通过 projection store 立即上屏。`MGR:546-576`、`MGR:828-877`、`MGR:779-790`、`CTRL:191-203`。
8. **导航行为**：菜单/快捷键 **不导航、不选中、不 retain 子会话**；消息尾部 branch 成功后 `openSession(childId)` 把主视图切到子会话。`WREADME:74`、`APPSPEC:602-640,656-684`、`CHATAPPLY:291`、`NAVID:276-278,499-529`。
9. **权限点 = endpoint action `session/fork`，资源 = `session:<源 sessionId>`**：Host 通过 remote-access 对非 owner Peer 判定；客户端用 access snapshot 隐藏入口（菜单行/尾部按钮），但**快捷键没有客户端 access 检查**（Host 会拒，表现为通用失败 toast）。`CTRL:159,442-453`、`GW:785-812`、`RA:199-222`、`FORKROW:17-18`、`TURNTAIL:32,70`、`SHORT:96-110`。
10. **可复用性**：客户端第三方插件可复用 slot 注入的 `forkSession`/`forkAt`，或直接调公开服务 `ctx.sessions.fork` / `ctx.uiWorkspace.forkSession`；Host 插件可直接调 `ctx.sessionController.fork`；上游若要让非 owner 调用，需要注册 remote-access policy 授予 `session/fork`。`CONTRACT:124-142`、`SVC:282`、`WSLOTS:171-179`、`RA:153-166`。

> ⚠️ 词义澄清：本仓库里的 “fork” 至少有三义，**不要混用**：
> - **UI 会话分叉**（本文主题）：`SessionController.fork` / `session/fork` / UI branch。
> - **subagent fork 提供方**（另一套机制）：`packages/subagent/subagent-fork-in-process`，从父 Agent 已完成轮次构造 seed 直接 spawn 子 Agent，**不经过** `session/fork`。证据：`packages/subagent/subagent-fork-in-process/src/index.ts:5-7,41-77`。设计记录：`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md:1-40`。
> - **持久化格式迁移**（与 `allowMigration` 相关，但不是 fork 本身）：`migration-required` 表示存储格式落后于当前版本；`packages/session/session-persistence/README.md:65,108`。

---

## 2. 端到端时序（文字版）

### 2.1 入口 A：侧栏会话菜单 / 快捷键（不带 `atSeq`）

```
[用户点击行菜单「分叉会话」]
FORKROW:17-26   useSessionAccess(sessionId,'session/fork') 为 true 才渲染；点击 → setMenuOpen(false) → forkSession(sessionId)
  ↓
WIDX:224-235    forkInjected.forkSession:
                  uiWorkspace.forkSession(sessionId, onCreated=analytics, { allowMigration: false })
  ↓
NAVID:307-318   UiWorkspaceService.forkSession → sessions.fork({
                  sessionId, increaseTitle: true, onCreated, allowMigration:false })
  ↓
SVC:459-483     ClientSessions.fork:
                  1) 若 increaseTitle：从列表快照取源会话“durable title”(SVC:466-468)
                  2) manager.fork({sessionId, allowMigration})     (SVC:469-473)
  ↓
MGR:556-576     SessionManager.fork → remote.session.fork({sessionId, allowMigration})
                  （注意：atSeq 未传，Host 自选边界）
  ↓  —— Remote/Typert RPC：namespace=session, method=fork ——
GWC:444-480     generated client method → connection.rpc.call('/api','session/fork',{args})
  ↓
GW:474-520      Gateway dispatchRpc → prepareInvocation
GW:785-812      （非 owner）资源解析 + remoteAccess.decide → 失败抛 remote-access/denied
GW:820-860      解析 receiver / 参数 / signal → 调用 Service 方法
  ↓
CTRL:442-453    SessionController.fork:
                  若 allowMigration===false 且源未 attach：sessionPersistence.stat
                  若 formatStatus==='migration-required' → session/migration-required
  ↓
CMD:227-310     SessionCommandController.fork:
                  1) SessionSeq(atSeq) 校验（atSeq 省略则跳过）            CMD:228-233
                  2) sessionQuery.observeSession(源)  ← 冷/热观测          CMD:236
                  3) boundary = atSeq ?? latestCompletedPrefixBoundary()   CMD:251
                  4) buildForkSeed(events, boundary)                       CMD:261 → SFORK:21-29
                  5) forkWorkspace(源 header)（subagent 溯源用 traceSession） CMD:264,550-560
                  6) childId = `session-<uuid>`                            CMD:272
                  7) composeAgent(presetForObservation(源观测))            CMD:273 → AGENT:387-400,589-599
                  8) {provider,model} = agentDefaultModel.currentSelection() CMD:275
                  9) ctx.agents.create({sessionId, seed,
                       inheritedEventCount: boundary+1,
                       meta:{cwd?, parentSession, isSeeded:true, agentPreset?},
                       agentOptions:{provider,model}, setup})              CMD:276-290 → AGENTREG:398
                 10) workspace.attachSession(childId)（仅有 workspace 时）   CMD:298-308 → WENTITY:110-162
                 11) return { sessionId: childId }                         CMD:309
  ↓  Host 副作用（在 create 内发布时同步发生）
CTRL:191-203    session/created、agent/created → emit('api-session/added', summaryFor(child))
remotes/src/remote-events.ts:29-33  api-session/added 事件转发（resources.session=/读取 summary.sessionId）
CLIENTIDX:116-126  ctx.remote.$on('api-session/added') → ClientSessions.handleSessionAdded
  ↓  同时控制流/投影（rename 后 title 投影）走 remote.session.follow / control / projections
  ↓  —— RPC 返回 ——
MGR:565-574     ok → childId；若 error 是 workspace-attach-failed 也取 details.sessionId
                recordMutation({kind:'placeholder', summary:{blank:true,parentSessionId:源,cwd:源,...}})
SVC:475-477     projectList()（把占位子会话投影进 client list），随后 onCreated(childId)
SVC:478-481     若源有 durable title：manager.rename(childId, increasedForkTitle(title))
                → 失败抛普通 Error("fork child rename failed: ...")（子会话已存在）
  ↓
WIDX:229-232    菜单路径：错误只处理 SessionForkError 且 code==='session/migration-required'
                → notify({kind:'forkRequiresOpen'})；其它错误静默
导航：无（子会话只出现在列表里，当前选中不变）  WREADME:74 / APPSPEC:602-640
```

快捷键路径与菜单路径共享后半段，差异在**目标选择与失败提示**：

```
SHORT:66-67     current() = 列表里 retainedBy.mainView > 0 的会话（当前主视图会话）
SHORT:96-110    session.fork 快捷键（desktop: Mod+Alt+F；web: Mod+Shift+F；regions page/editable）
                  target undefined → blocked shortcut.noSession
                  target.blank    → blocked shortcut.noCompletedTurn
                  否则 navigation.forkSession(target.id)（未传 allowMigration → Host 默认允许迁移）
                  catch: SessionForkError.code==='session/fork-unavailable' → report('unavailable')
                         其它 → report('failed') + console.warn
TOAST:60-67     'unavailable' → 「当前会话没有已结束的轮次」；'failed' → 「无法分叉会话，请重试」
```

### 2.2 入口 B：消息尾部 branch 按钮（带精确 `turn/end` seq）

```
TTAILDATA:93-99     turn-tail 数据：{ seq: turn/end.seq, closing, branchUnavailable }
TURNTAIL:32         forkAllowed = useAccess('session/fork')
TURNTAIL:70-71      onBranch = forkAllowed ? () => forkAt(data.seq) : undefined
                    branchUnavailable = data.branchUnavailable || hasLaterChatNode
ICON:91-109         无 onBranch → 不渲染按钮；branchUnavailable → 渲染但 aria-disabled、点击无效
  ↓ 用户点击
CHATAPPLY:285-295   forkAt(seq):
                      1) 在 chat timeline 找 end.seq === seq 的 turn，取 turn-tail.closing.finalNode.messageId
                      2) ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true, onCreated })
                         （注意：未传 allowMigration → Host 默认允许迁移）
                      3) .then(childId => ctx.uiWorkspace.openSession(childId))
                      4) .catch(() => {})  ← 全静默
  ↓ 之后与入口 A 完全同一条 Host 链路（SVC→MGR→RPC→CTRL→CMD）
  ↓ 返回后
CHATAPPLY:291       openSession(childId) → UiWorkspaceService.openSession
NAVID:276-278       replaceMain(target,...,'reveal')
NAVID:499-529       sessions.retain(child,{source:'mainView'}) → 选中写入持久化 store → layout.selectPanel(null)
                    → Chat 视图对子会话打开 history follow（子 Agent 已在 Host live，可直接 follow）
```

### 2.3 谁能看到/点到入口（可见性总表）

| 入口 | 客户端权限门 | 其它禁用条件 | 证据 |
|---|---|---|---|
| 侧栏菜单行 | `useSessionAccess(sessionId,'session/fork')` 为 false → 不渲染 | 空白会话整行菜单都不渲染；归档行仍渲染（Fork 行本身不检查归档） | `FORKROW:17-18`；`ROWS:646-649,664-689` |
| 快捷键 `session.fork` | **无 access 检查** | 无主视图会话 → blocked `shortcut.noSession`；空白会话 → blocked `shortcut.noCompletedTurn`；Host 拒绝后可重试 | `SHORT:96-110`；`SHORTSPEC:185-207` |
| 消息尾部 branch | `useAccess('session/fork')` 为 false → 按钮不存在 | `branchUnavailable` → 可见但禁用（`closing===null`、closing 之后还有 tool/result、error turn/end、llm/retry、steering 等） | `TURNTAIL:32,70-71`；`TTAILDATA:93-99`；`ICON:91-109`；`CHATSPEC:3344-3410` |

---

## 3. 逐层 API 表

### 3.1 客户端公开 facade（第三方插件可直接用）

| 层 | 成员 | 签名（源码） | 输入 | 输出 | 失败 |
|---|---|---|---|---|---|
| Client 服务 | `ctx.sessions.fork` | `fork(opts: { sessionId; atSeq?; increaseTitle?; onCreated?; allowMigration? }): Promise<SessionId>` — `CONTRACT:124-142` | 源会话、可选精确边界 seq、是否递增标题、child 创建后回调、是否允许源迁移 | 子会话 id | `SessionForkError`（含 `rpcError`/`sourceSessionId`，`SVC:84-98`）；rename 失败抛普通 `Error`（`SVC:478-481`） |
| Client 服务 | `ctx.uiWorkspace.forkSession` | `forkSession(sessionId, onCreated?, options?: Pick<...,'allowMigration'>): Promise<SessionId>` — `NAVID:60-71` | 源会话；**总是** `increaseTitle: true`（`NAVID:312-317`） | 子会话 id | 原样向上抛（见上） |
| Client 内部 | `SessionManager.fork` | `fork(opts:{sessionId;atSeq?;allowMigration?}): Promise<RemoteResult<{sessionId}>>` — `MGR:546-558` | 同 RPC 入参 | RemoteResult + 立即写占位 summary | 不抛，返回 `ok:false` |
| 服务提供 | `ctx.sessions` 提供点 | `rootCtx.reflect.provide('sessions', this, undefined)` — `SVC:282`；客户端入口 module 声明 `inject` 含 `sessions` | — | — | — |
| 动态插件 API 目录 | `ISessions.fork` / `forkSession` 已登记给动态客户端插件 | `packages/extensions/cordis-client-runner/src/client/api-catalog.ts:216,351,664` | — | — | — |

### 3.2 Remote 契约（生成层，`ctx.remote.session`）

| 项 | 内容 | 证据 |
|---|---|---|
| Endpoint | `session/fork`（namespace `session` 由 `TypertRemoteService(ctx,'sessionController',{namespace:'session'})` 固定；方法名 `fork`） | `CTRL:158,442`；`TPROTO:278-313`（`@Remote` 语义）；`docs/api-gateway.md:9` |
| Host 方法 | `@Remote('fork') async fork(request: SessionForkRequest): Promise<SessionForkValue>` | `CTRL:435-453` |
| 请求 `SessionForkRequest` | `{ sessionId: SessionId; atSeq?: number; allowMigration?: boolean }` | `TYPES:329-336` |
| 响应 `SessionForkValue` | `{ sessionId: SessionId }`（**只有**子 id，无标题/父/边界回执） | `TYPES:338-341` |
| 代码生成 | `@Remote`/`@RemoteScope` 由 Typert generator 在 Host 构建期生成 `lib/typert.remote-client.{js,d.ts}`，Client 只消费生成的 strict 契约 | `docs/api-gateway.md:9,62,102-118,142-154`；`packages/typert/generator/src/artifact-files.ts:13-40` |
| 客户端调用形态 | `remote.session.fork(request)` 返回 `Promise<RemoteResult<SessionForkValue>>`；传输失败折叠进 `{ok:false,error}` 而不是 throw | `GWC:444-480`（`connection.rpc.call('/api', endpoint, {args})`）；`TERR:118-140`（`RemoteResult`/`RemoteFailure`） |
| 服务发现/装配 | Gateway `connection.rpc.intercept('/api', ...)`；客户端 `ctx.remote.$mount(contribution)` 并注册 `remote.session` 子服务 | `GW:240-260`；`GWC:214-219,327-399`；`docs/api-gateway.md:62,94` |

### 3.3 Host 内部调用链

| 层 | 成员 | 输入 | 输出 / 语义 | 证据 |
|---|---|---|---|---|
| Controller | `SessionController.fork` | `SessionForkRequest` | 迁移预检 → 委托 commands.fork；返回 `{sessionId}` | `CTRL:442-453` |
| 业务 | `SessionCommandController.fork` | 同上 | 观测源 → 边界 → seed → 子 Agent → workspace attach | `CMD:227-310` |
| 观测 | `ctx.sessionQuery.observeSession(id, {signal?, projectionMode?})` | 默认 `projectionMode='all'` | 返回 `SessionObservation`（`header`/`events`/`inheritedEventCount`/`projections`），live 优先、冷读 prepared 缓存；`using` 释放租约 | `packages/session-query/session-query/src/index.ts:136-142`；`.../observation.ts:98-158`；`CMD:234-251` |
| 谱系 | `ctx.sessionQuery.traceSession(id, signal?)` | 逻辑 session id | `{target, ancestors[], descendants[], complete, root|unresolvedParentId}` | `.../session-query/src/index.ts:327-331`；`.../types.ts:83-103` |
| Agent 组合 | `ApiSessionAgentController.composeAgent(presetId?)` | 源会话当前 preset（`presetForObservation`） | `{agentPreset?, setup}`；setup 安装 model selection 并按 preset 挂载 | `AGENT:382-400`；`AGENT:589-599` |
| 默认模型 | `ctx.agentDefaultModel.currentSelection()` | — | `{provider, model}` 作为子 Agent 的 `AgentOptions` | `CMD:275,288`；`AGENT:580-583` |
| 创建 | `ctx.agents.create(CreateAgentOptions)` | `sessionId, seed, inheritedEventCount, meta{cwd,parentSession,isSeeded,agentPreset}, agentOptions, setup` | 校验 seed 连续性/JSON 安全、seeded 不变量，先 setup 后发布（失败回滚） | `AGENTREG:57-112,392-412`；`SESSION:625-702` |
| Workspace | `workspace.attachSession(sessionId)` | 子会话 id | 校验 header.cwd 存在、realpath 等于 workspace.path，然后**前插**到 `sessionIds` | `WENTITY:110-162` |

### 3.4 错误码与语义（fork 相关全集）

| 错误码 | 触发条件 | message 语义 | details | 客户端表现 | 证据 |
|---|---|---|---|---|---|
| `gateway/bad-request` | `atSeq` 不是「非负安全整数」（含 `-0`），在观测/创建之前抛出 | `'atSeq must be a non-negative safe integer'` | `{}` | 菜单/尾部静默；快捷键走 'failed' toast | `CMD:228-233`；`SESSION` 的 `SessionSeq` 校验 `packages/core/session/src/types.ts:40-45`；`FORKSPEC:497-507` |
| `session/not-found` | 源会话既非 live 也无可读持久化（`SESSION_QUERY_SESSION_NOT_FOUND`） | `session "<id>" not found` | `{sessionId}` | 同上 | `CMD:236-243`；`CFORKSPEC:185-207` |
| `session/fork-unavailable` | ① `atSeq` 省略且源没有 `turn/end`；② `atSeq` 越界/不存在（含空会话 `atSeq:0`） | ① `has no completed turn to fork from`；② `event N does not exist in session "..." (last seq: ...)` | `{sessionId}`（**不含** boundary/lastSeq 结构化字段） | 快捷键识别该码 → 「当前会话没有已结束的轮次」；菜单路径**不识别**该码（静默）；尾部静默 | `CMD:252-260`；`FORKSPEC:441-462,464-474`；`SHORT:104-106`；`TYPES:228` |
| `session/migration-required` | 仅当 `allowMigration===false`、源**未 attach**、`stat.formatStatus==='migration-required'` | `Open the source Session to complete migration before forking` | `{sessionId}` | 仅菜单路径弹 `forkRequiresOpen` toast，动作=打开源会话（不重试 fork）；若源已归档则改弹「已归档不可打开」 | `CTRL:444-451`；`WIDX:228-232,248-257`；`TOAST:74-82`；`APPSPEC:686-744`；`FORKSPEC:137-163` |
| `session/workspace-attach-failed` | 子会话已创建、Agent 已发布，但 `attachSession` 失败（cwd 缺失/realpath 不一致/目录不存在等） | `session "<child>" was forked but could not attach to workspace "<ws>": ...` | `{sessionId: child, workspaceId}` | `SessionForkError`；但 `manager.fork` 用 `details.sessionId` 把子会话调和进列表（Ungrouped），UI 无提示 | `CMD:298-308`；`MGR:565-574`；`MGR:877-881`；`WENTITY:110-162`；`MGRSPEC:1266-1280` |
| `gateway/internal` | 观测源失败（非 not-found）、`forkWorkspace`/`traceSession` 失败、`agents.create` 失败、`presetForObservation`/`composeAgent` 抛错、迁移预检的 `stat` 抛错 | 各自包装后的诊断文案 | `{}` 或 `{cause}`（仅进程内） | 菜单/尾部静默；快捷键 'failed' | `CMD:244-248,263-271,273,291-297`；`GW:1499-1511`（未分类 throw 折叠为 `gateway/internal`）；`FORKSPEC:223-242`；`CFORKSPEC:209-217,233-253` |
| `remote-access/denied` | 非 owner Peer 且没有 policy 授予 `session/fork`（或缺 `global`/session 角色） | `remote access: session/fork: access denied (<reason>)` | `{action, reason}`（`no-allow`/`policy-failed`/`resource-invalid`/条件原因） | 菜单行/尾部按钮因 access=false 根本不显示；快捷键仍会发请求 → 'failed' toast + console.warn | `GW:785-812`；`RA:199-222`；`packages/api/remote-access/src/types.ts:106-122`；`SHORT:96-110` |
| `gateway/arguments-invalid` 等基础设施码 | 参数结构/签名不符等 | 见 `docs/api-gateway.md` | `{endpoint, field?}` | 同上 | `packages/api/gateway/src/remote-error-codes.ts:12-33` |
| `session/title-invalid`（**不是** fork 的错误） | fork 成功后的子会话 rename 规范化拒绝 | `title...` | `{sessionId}` | 客户端抛普通 `Error("fork child rename failed: ...")`；子会话已在列表 | `CMD:205-217`；`SVC:478-481`；`SVCFORKSPEC:1034-1055` |

补充：`session/writer-held` 只出现在 resume（`AGENT:248-250`），fork 不使用 resume，因此不会出现；`session/agent-busy`（subagent ownership fence）也不会出现在 fork 路径（见 §4.8）。

---

## 4. Host 侧关键细节

### 4.1 `atSeq` 省略时的默认 boundary 规则

实现（`CMD:76-90`，逐字语义）：

```ts
function latestCompletedPrefixBoundary(events): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(e => e.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined          // → session/fork-unavailable
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break        // 下一轮/下一条排队输入之前停
    boundary = next.seq                                    // 吸收独立尾部事件（title 等）
  }
  return boundary
}
```

- 返回的 `boundary` 随后被校验 `source.events[boundary]?.seq === boundary`（`CMD:252`）——即 seq 必须真实存在（事件日志 seq 连续从 0 开始）。
- **语义要点**：
  - 省略 `atSeq` = 「最近一个已完成轮次 + 它之后的独立尾部事件（`session/title`、`session/end-seed` 之外的零散事件等），停在下一轮开始或排队输入之前」；README 原文：`SCREADME:63`。
  - 尾部有**未完成**的轮次（open turn）时，默认切在它之前，不包含它：`FORKSPEC:441-454`（`tail='open'`，fork 后子会话只有两个完整轮次 + `session/end-seed`）。
  - 没有 `turn/end`（从未完成任何轮次）→ `session/fork-unavailable`：`FORKSPEC:464-474`。
  - 独立 `session/title` 会被吸收（保证子会话继承标题）：`FORKSPEC:476-495`（appended `session/title` 后省略 atSeq，`inheritedEventCount === inherited.length`）。
  - 排队但未开始的用户输入（`agent/inbox/spliced`）会截断扩展：`FORKSPEC:286-325`（fork 后再 prompt，子会话只有 `['A','C']`）。
- **显式 `atSeq`**：不扩展、精确切在给定事件（含开放轮次内部）：`FORKSPEC:526-543`（在 open turn 的 `user/message` 处切，子会话合成 `turn/end` reason=`forked`）、`FORKSPEC:545-559`（显式 boundary 不吸收其后 `session/title`）。
- 边界在 step 内部（如 tool/call 之后）：`buildForkSeed` 用 `REPAIR.openTurnClosers` 合成 `tool/result`（`TOOL_OUTCOME_UNKNOWN`）、`step/end`、`turn/end(reason:'forked')`：`FORKSPEC:561-632`。

### 4.2 冷/热源会话如何读取（`observeSession` / `traceSession` / `readSessionState`）

- fork 只调 `ctx.sessionQuery.observeSession(request.sessionId)`（`CMD:236`），不 `resolveAgent`：
  - live 优先：`ctx.sessions.get(id)` 存在则直接生成 live observation（`observation.ts:104-106`）；
  - 否则要求 `sessionPersistence`：`stat` → prepared 缓存（persistence identity + revision 命中即复用）→ 冷读日志、`sessions.prepare(...)` 恢复、`inheritedEventCount` 一并带来（`observation.ts:107-158`）；
  - 默认 `projectionMode='all'`（`observation.ts:102`），因为下一步 `presetForObservation` 需要 `observation.projections`（`AGENT:589-599` 调用处，`CMD:273`）；
  - `using source = observed`（`CMD:250`）保证 fork 全程持有租约，结束后释放（`SessionObservation extends Disposable`，`observation.ts:17-41`）。
- 冷源**不会**被激活成 Agent：`FORKSPEC:165-183`（live source 也不要求 Agent）、`FORKSPEC:385-439`（持久化 subagent 源 fork 后 `ctx.agents.get(sourceId) === undefined`，`resume` 未被调用）。
- `traceSession` 只在 `forkWorkspace` 里使用（subagent 源）：先列 corpus，再按 `parentSession` 链追祖先（`session-query/src/index.ts:327-331`，`tracing.ts:119+`）。
- `readSessionState`（`CMD:540-548`）**不属于 fork 路径**：它是 `attachment`（附件授权）用的「已 attach 或 inspect」点读辅助（`CMD:377-411`）；fork 不需要它。
- `allowMigration` 预检的 `stat` 失败**不会**被当成 not-found，而是直接冒泡为 `gateway/internal`（`FORKSPEC:223-242`）。

### 4.3 `forkWorkspace` 为什么存在（subagent 溯源）

```ts
private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
  const workspaces = this.ctx.workspaceRegistry.list()
  const direct = workspaces.find(w => w.sessionIds.includes(source.id))
  if (direct !== undefined || source.origin !== 'subagent') return direct
  const lineage = await this.ctx.sessionQuery.traceSession(source.id)
  for (const ancestor of lineage.ancestors) {
    const workspace = workspaces.find(w => w.sessionIds.includes(ancestor.header.id))
    if (workspace !== undefined) return workspace
  }
  return undefined
}
```
（`CMD:550-560`）

- 目的：**让「分叉一个 subagent 子会话」得到的普通子会话仍然出现在用户看得见的 Workspace 分组里**。subagent 子会话本身不以 workspace 成员行展示（`TREE:238-262` 过滤 `origin==='subagent'`；`WREADME:14`），其 header 的 cwd 与父会话工作区相同但通常不在 workspace.sessionIds 里；按 cwd 直接 attach 会依赖 cwd 校验，而按「归属工作区」语义应挂到最近祖先所在 workspace。
- 行为：源是 subagent 且不在任何 workspace → 沿 `parentSession` 祖先找第一个「workspace 认领其 sessionId」的祖先；找不到 → 返回 `undefined`（子会话留在 Ungrouped）。
- 子会话自身 **不带 `origin`**，所以是普通会话（`FORKSPEC:342-383` 断言 child.header.parentSession=源、origin undefined，且 `attachSession(childId)` 被调用）。
- 失败（`traceSession` 抛错等）→ `gateway/internal`（`CMD:263-271`；`CFORKSPEC:233-244`）。
- 普通源（`origin !== 'subagent'`）只做直接成员匹配，不做祖先回溯（同一行代码）。

### 4.4 `composeAgent` / `presetForObservation`：子会话继承源会话的 preset

- `presetForObservation(source)` 从观测的 projection 值读 `agentPreset`；若 `observation.projections === undefined` 直接抛 `Error('...requires a projected Session observation')`（`AGENT:589-599`）——这就是 fork 必须以 `projectionMode='all'` 观测的原因。
- `composeAgent(presetId)`：有 `agentPresets` 服务时 `presets.resolve(presetId)`（`undefined` → 部署默认 preset）得到 `resolvedId`，返回 `{ agentPreset: resolvedId, setup }`；setup 先 `installSelection(agent)`（模型选择投影/waterfall），再 `presets.mount(agentCtx, resolvedId)`；无 preset 服务时只安装 selection（`AGENT:387-400`）。
- 子 Agent 创建时 `meta.agentPreset` = composition.agentPreset（仅有值时），因此子会话 header 记录 preset（`CMD:284-286`；`CFORKSPEC:277-294` 断言 `meta.agentPreset==='minimal'`）。
- 这是**上游/插件可介入子会话组合**的主要扩展点（自建 preset 会随 fork 继承）；但 boundary/seed/meta 规则不可改。

### 4.5 默认 provider/model 的两层语义

1. **Agent 构造默认**：`agentDefaultModel.currentSelection()` 作为 `agents.create` 的 `agentOptions`（`CMD:275,288`；`AGENT:580-583`）。它是「部署默认/用户最后选择」。
2. **首次请求路由**：Agent 侧 `selectionFor(agent)` 的 `current` getter 顺序为：pending 的 `model/selection` 投影 → **会话日志最后一个 `request/header` 的 provider/model/reasoningEffort** → 部署默认（`AGENT:300-315`）；`installModelSelection` 在 `agent/request` waterfall 里把 selected 覆盖到请求配置（`packages/core/agent/src/model-selection.ts:79-110`）。fork 子会话继承了源前缀里的 `request/header`，因此**下一轮实际使用继承的路由**，`agentOptions` 只是兜底。
   - 测试：`FORKSPEC:634-679`——源在 boundary 前记录了 `inherited-provider/inherited-model/high`，fork 后子会话的 `system-prompt` 变量与 `agent/request` 结果都是继承路由，尽管测试默认是 `default-provider/default-model`。
3. `reasoningEffort`：仅当继承 header 的 effort 不是 adapter 默认时才恢复（`AGENT:308-315`）。

### 4.6 Title 是否 Host 处理？——否

- fork 方法体内**没有任何 title 逻辑**（`CMD:227-310` 通读）；Host 也不在 fork 后自动 rename。
- 子会话「继承标题」的机制是**事件前缀复制**：若源的 `session/title` 事件在 boundary 内（默认 boundary 会吸收它，显式 `atSeq` 不会），子日志前缀里就有该事件，`title` 投影 fold 后与源相同（`packages/session/session-title/src/index.ts:274,289`；`FORKSPEC:476-495`）。
- 自动 LLM 标题生成对 fork 子会话**被禁用**：`onUserMessage` 的调度条件包含 `session.header.parentSession === undefined`（`packages/session/session-title/src/index.ts:505-520`）。显式用户 rename 会 pin 标题（同文件 `407-425`，且 `510-511` 提前返回）。
- 客户端负责“标题递增”：`increaseTitle: true` 时读取源 durable title 并 `session/rename`（细节见 §5.5）。

### 4.7 `workspace.attachSession` 语义与失败后的一致性

- 语义（`WENTITY:110-162`）：
  - 已经是成员 → 跳过校验（直接 mutate，幂等）；
  - 否则读 header.cwd：缺失 → 抛；realpath 失败/不是目录 → 抛；realpath ≠ workspace.path → 抛；
  - 校验通过后 `rememberSessionPath`，并在写链中把 id **前插**到 `sessionIds`（`[sessionId, ...]`）。
- fork 的挂载点：创建成功后 `workspace.attachSession(childId)`；失败抛 `session/workspace-attach-failed`，message 明确写「was forked but could not attach」，details 带 `{sessionId: child, workspaceId}`（`CMD:298-308`）。
- **一致性**：这是「先创建、后挂载」的两步操作，没有事务/回滚：
  - Host 侧子会话与子 Agent 已发布（`session/created` + `agent/created` 已触发，`api-session/added` 可能已广播，`CTRL:191-203`）；
  - 客户端 `manager.fork` 会从错误 details 取出 `childId` 并写占位行（`MGR:565-574`），因此**用户仍能在 Ungrouped 看到子会话**；但 UI 无错误提示（菜单 catch 只认 migration-required；快捷键显示通用失败；尾部静默）；
  - 仓库内**没有**“重新挂载 session 到 workspace”的 Remote endpoint：`workspace-controller` 只有 `insertSessionBefore`（要求会话已被 accounted，否则 `WorkspaceMoveInvalidError`，`WENTITY:164-180`），没有 attach 补票 API（`packages/api/workspace-controller/src/index.ts:139-157`）。→ 见「未解问题」。
- 子会话若源 header 无 cwd（`CMD:281` 省略 cwd）则更可能 attach 失败；`CFORKSPEC:255-275` 断言失败时 `meta` 不含 `cwd`/`agentPreset` 键。

### 4.8 其它 Host 行为要点

- **子会话 id**：Host 自行铸 `session-${randomUUID()}`（`CMD:272`），客户端不能指定；请求里没有 child id 字段（`TYPES:329-336`）。
- **seed 结构**：`prefix(0..boundary)` + `session/end-seed{inherited:true}`（seq=boundary+1）+ `openTurnClosers(prefix,{kind:'forked'})`（`SFORK:21-29`；`REPAIR:53+`）。`inheritedEventCount = boundary+1`（`CMD:279`）。
- **Session 构造不变量**：`isSeeded` 必须带 seed 与 `inheritedEventCount`；marker 必须在 `inheritedEventCount` 处且是最后一个 inherited marker；`firstLifecycleSeq = inheritedEventCount`（`SESSION:665-702`）。子会话的后续 live seq 从完整 seed 长度继续（含合成 closers）。
- **subagent ownership fence 不适用于 fork**：fork 不解析源 Agent（`CMD:227-310` 无 `resolveAgent`），因此可以 fork「live 的 subagent 子会话」或「持久化 subagent 子会话」，且不 resume 源（`FORKSPEC:342-383,385-439`；UI 也有「分叉只读 subagent 历史」测试 `APPSPEC:745-769`）。
- **归档门禁不因 fork 传染**：`ArchivedSessionGate` 只在 `origin==='subagent'` 时沿 `parentSession` 上溯；注释明确「a fork of an archived Session is an independent conversation」（`packages/api/session-controller/src/archived-session-gate.ts:34-55`）。fork 方法本身也不检查源是否归档（`CMD` 全文无 `archived` 引用，除 create 的 reusable 判断 `CMD:131`）。
- **源会话不被修改**：测试断言 fork 后 `source.session.snapshotEvents()` 与 fork 前完全相同（`FORKSPEC:320`、`FORKSPEC:541`）。
- **Host 只把新事件写成 current format**；冷读历史时做内存 prepared 迁移，写 open 才发布 successor（`packages/session/session-persistence/README.md:65,108`）。

---

## 5. 客户端细节（UX / 状态机）

### 5.1 入口 A：会话菜单行

- 组件：`ForkSessionMenuItem`，注释即契约（`FORKROW:1-31`）：
  - 位置：`sidebar.workspaces.session.menu.item`，`order: 300`（`WIDX:319`；`WSLOTS:137-148` 列出 pin 100/rename 200/fork 300/archive 400/session-id 450）。
  - 图标：`IconBranchOutlineRegular`；文案 `t('menu.fork')`；末尾展示快捷键（`MenuItemButton shortcut={...}`，`FORKROW:16,21-22`）。
  - 可见性：`useSessionAccess(sessionId,'session/fork')` 为 false 返回 `null`（`FORKROW:17-18`）。
  - 点击：先 `setMenuOpen(false)` 再 `forkSession(sessionId)`——测试断言顺序（`ROWSPEC:231-240`；`ROWSPEC:241-249` 隐藏行）。
- 注入实现（`WIDX:224-235`）：
  - `uiWorkspace.forkSession(sessionId, childId => analytics('branch_session_click', {session_id:childId,parent_session_id:sessionId,click_position:'sidebar'}), { allowMigration:false })`；
  - `.catch`：**只**识别 `SessionForkError && code==='session/migration-required'` → `notify({kind:'forkRequiresOpen', sessionId})`；其它错误静默。
- 失败/成功表面：
  - 成功：无 toast、无导航（子行随后出现在列表；`APPSPEC:656-684` 断言 toast 为空、未 retain、未 selectPanel）。
  - 迁移拒绝：toast 文案「请先打开原会话完成迁移，再创建分支」+ 动作「打开原会话」（`TOAST:74-82`；`WLOC:95-96,221-222`）；动作只导航、不重试 fork，且源归档时改弹 `archivedNotOpenable`（`WIDX:248-257`；`APPSPEC:686-744`）。
  - 其它失败（含 `fork-unavailable`、`remote-access/denied`、网络错误）：**静默**（`APPSPEC:771-800` 三种错误均 toast 为空）。

### 5.2 入口 A'：快捷键 `session.fork`

- 注册：`SHORT:96-110`，`register()` 统一给 `page`/`editable` region、`modals: []`，默认键位：
  - desktop（mac/windows/linux）：`{ code:'KeyF', modifiers:['primary','alt'] }` → `Cmd/Ctrl+Alt+F`
  - web（mac/windows）：`{ code:'KeyF', modifiers:['primary','shift'] }` → `Cmd/Ctrl+Shift+F`
  - 参考 UI 快捷键列表声明 `'session.fork'`（`packages/client/ui-shortcuts/src/client/Reference.tsx:33`）。
- 目标会话：`current()` = 列表里 `retainedBy.mainView > 0` 的会话（`SHORT:66-67`）——即「当前主视图会话」，与行菜单点哪行不同（`WREADME:62`：「Clicking a menu item targets that row; pressing its shortcut targets the main Session」）。
- blocked 条件：无会话 → `shortcut.noSession`；`blank` → `shortcut.noCompletedTurn`（`SHORT:98-99`；`SHORTSPEC:185-207`）。**不检查 access、不检查归档**。
- 运行与失败：`navigation.forkSession(target.id)`（未传 `allowMigration` → Host 默认自动迁移；`SHORT:102`；`WREADME:62` 原文「keeps automatic migration」）；catch 分类：
  - `SessionForkError.code==='session/fork-unavailable'` → `reportForkFailure('unavailable')` → toast「当前会话没有已结束的轮次」；
  - 其它（含 denied/网络）→ `'failed'` → toast「无法分叉会话，请重试」+ `console.warn`；
  - 错误类身份按 `error.name === 'SessionForkError'` 判断（client bundle 不共享 class identity，`SHORT:103-105`；`SVC:85-98`）。
  - toast 呈现：`TOAST:60-67`（tone 'plain'）；见 `WLOC:18-19,144-145`。

### 5.3 入口 B：消息尾部 branch 按钮

- 渲染链：`ChatView` 渲染 flow → `ChatFlow`/`ChatNodeSeat` 把 `forkAt` 一路透传到节点（`ChatView.tsx:229`；`ChatFlow.tsx:25-35`；`ChatNodeSeat.tsx:120-140`）→ `TurnTailNodeView` 渲染 `MessageIconActions`（`TURNTAIL:64-78`）。
- `forkAllowed = useAccess('session/fork')`（`TURNTAIL:32`），false 时**不传 `onBranch`** → 按钮完全不渲染（`ICON:91`）。
- `branchUnavailable` 的计算：
  - `TTAILDATA:98`：`closing === null || latestTranscriptSeq !== closing.finalNode.seq`；`closing` 是「最后一个有文本的 finalized assistant」（`TTAILDATA:70-76`）；`latestTranscriptSeq` 还会吸收 closing 之后的 `tool/call`、append 型 `tool/result`、error 型 `turn/end`、`llm/retry`（`TTAILDATA:77-89`）。
  - `TURNTAIL:34-35`：`hasLaterChatNode` = 该轮内最后一个可见内容节点的 anchorSeq > closing（含 steering、interrupted think 等）。
  - 两者之一为真 → 按钮**可见但禁用**：`aria-disabled`、`data-unavailable`、点击无动作，tooltip 文案「仅可从已完成轮次的最后一条消息分支」，并给屏幕阅读器隐藏说明（`ICON:90-109`；`CLOC:159,357`）。
- `seq` 来源：`data.seq` 是 `turn/end` 事件的 seq（`TTAILDATA:93-95`），注释明确「branch action 拥有边界决策：它发送已经持有的真实 turn/end seq，Host 恰好在那里切」（`TURNTAIL:68-69`）。
- 测试证据：
  - 一个已完成轮次只出现 1 个可用 branch 按钮（user 气泡没有），点击 `forkAt` 收到 `turn/end` seq：`CHATSPEC:3344-3357`；
  - closing 之后有 steering / tool result / interrupted reasoning → 按钮 disabled 且点击不触发：`CHATSPEC:3358-3398`；
  - access 排除 `session/fork` → 按钮不存在：`CHATSPEC:3399-3410`。
- 点击后（`CHATAPPLY:285-295`）：
  - 先按 end seq 找 turn，再取 `turn-tail.closing.finalNode.messageId` 作为 analytics 的 `parent_message_id`（可能不可得，见 `INJECTSPEC:197-230` 两次断言）；
  - `ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true, onCreated })`；
  - `.then(childId => ctx.uiWorkspace.openSession(childId))`；
  - `.catch(() => {})`：**任何失败都静默**，源视图不变（`INJECTSPEC:197-247`）。
- analytics：`branch_session_click`，字段 `{session_id: childId, parent_session_id: sourceId, parent_message_id?, click_position:'footer'}`（`CHATAPPLY:289`；事件 schema `packages/client/product-analytics/src/events.ts:32-37`）。`click_position` 取值 `'footer' | 'sidebar'`；Desktop 才上报（`packages/client/product-analytics/README.md:10-12`）。

### 5.4 列表占位与最终 summary 合并

- RPC 成功后（或 `workspace-attach-failed` 时从 details 拿到 childId），`SessionManager.fork` 立即：
  - `childId = ok ? value.sessionId : workspaceAttachSessionId(error)`（`MGR:565-567`）；
  - `recordMutation({kind:'placeholder', summary:{agentAvailable:true, sessionId:childId, updatedAt:Date.now(), running:false, blank:true, parentSessionId: opts.sessionId, cwd: source?.cwd}})`（`MGR:568-574`）；
  - `source` 是调用前从本地 summaries 找到的源 summary，仅用于 cwd 兜底（`MGR:559,572`）。
- `recordMutation` 同时：立刻应用 `applyMutation`、markDirty、并把 mutation 记进 in-flight list 请求的 replay 日志（`MGR:601-607`；`MGR:417-441`），保证「列表响应晚到」也不会丢占位。
- `applyMutation` 的合并语义（`MGR:828-877`）：
  - 新 id → **前插**到 summaries 头部；
  - 已存在：`placeholder` 只做「填补缺失元数据」——`blank` 只能**降**（`existing.blank && incoming.blank`）、`cwd/parentSessionId/origin` 仅在 existing 缺失时填；`upsert` 才会覆盖 `agentAvailable/running/formatStatus`；
  - `blank` 起手 `true` 的注释解释了原因：Host 权威 summary 可以在「首轮 turn/start 之前的精确切点」上保留或降低它（`MGR:546-554`）。
- 权威 Host summary：
  - `CTRL:191-203`：`session/created` → `api-session/added`；`agent/created`（同一个 agent 对应 session）→ 也会再发一次 `api-session/added`；
  - 转发白名单：`packages/api/remotes/src/remote-events.ts:29-33`（`api-session/added` 带 `session` 资源 reader）；
  - 客户端订阅：`CLIENTIDX:116-126` → `handleSessionAdded`（`MGR:663-672`，`mergeSummary`/`upsert`，并处理 running/projections）。
- Host summary 的字段：`LIST.summaryFor`（attach/热）+ `LIST.listFields`（`parentSessionId/origin/cwd`），`sessionListMetadata` 投影决定 `blank/updatedAt`（`LIST:49-60,128-143,349-363`）。因此 seeded 子会话只要继承前缀里有 `turn/start`，`blank` 会被权威 summary 降为 false。
- 标题立即上屏路径：`rename` 成功后 `projectionStore(child).apply('title', accepted.title, seq)`（`MGR:584-590`），而列表快照每行读取 `title` projection（`MGR:779-790`）——不需要打开子会话历史。
- 子会话在 `SessionListState.byId` 里带 `parentId`（由 Host 的 `parentSessionId` 投影而来，`SVC:626-643`，尤其 `641`），`SessionListState.ids` 为 list 顺序（占位先插头部，随后 Host list 刷新重排）。

### 5.5 子会话标题：`increaseTitle` 规则

- 仅当 `increaseTitle === true` **且** 列表快照里有源的 durable title 时才会 rename（`SVC:466-468,478-481`；测试 `SVCFORKSPEC:1022-1032`：无 title 或未开策略 → `rename` 不被调用）。
- 递增算法（`SVC:134-144`）：
  - 末尾是半角 `(n)` → `(n+1)`（BigInt，避免溢出）；
  - 末尾是全角 `（n）` → `（n+1）`（保留全角/半角风格与前缀空白）；
  - 其它 → 追加 `" (1)"`。
  - 测试样例（`SVCFORKSPEC:983-1011`）：`Roadmap → Roadmap (1)`、`Roadmap (1) → Roadmap (2)`、`计划（1） → 计划（2）`、`计划 （9） → 计划 （10）`（前缀空格保留）。
- 顺序：先 `projectList()`（占位行入列表）→ `onCreated(childId)`（analytics）→ 再 rename（`SVC:475-481`）。契约注释明确「`onCreated` 在可选 rename 之前观察到已入目录的子会话」（`CONTRACT:130-133`）。
- rename 失败：抛出**普通 Error**（`fork child rename failed: <code>: <message>`，`SVC:478-481`），但子会话已创建、已入目录、`onCreated` 已调用；测试断言子行保留、未 retain、未开 FOLLOW（`SVCFORKSPEC:1034-1055`）。
- 为什么客户端要加标题：子会话继承了源 `session/title`，若不递增，列表里两行同名；且 fork 子会话不再参与自动 LLM 标题生成（见 §4.6）。
- 渲染：递增后的长标题在行内省略号裁切，hover 时标题滚动到远端（`ROWS:92-108`；`WREADME:60`）。

### 5.6 子会话在 sidebar/会话列表中的呈现与 lineage

- **不做树形缩进、不加分支图标**：fork 子会话就是普通 SessionSummary 行（`SessionNode` 无 lineage 字段，`TREE:44-62`；`WREADME:14`）。
- **subagent 行被隐藏，普通 fork 行保留**：`sessionVisible` 过滤 `origin==='subagent'` 与多余 blank（`TREE:238-262`；测试 `TREESPEC:534-541`）。fork 子会话 `origin` 未设置 → 可见。
- lineage 的呈现仅两处：
  1. `parentId` 进入 Client 列表模型（`SVC:641`），用于**手动排序**：新增普通 fork 插在其来源之前，且递归处理嵌套 fork；来源/祖先是 pinned 时 fork 不继承 pin（`TREE:161-207`；`WREADME:38`；测试 `TREESPEC:164-183,184-209`）。默认视图 `orderBy='updated'`（`stores.ts:86`）时按 recency 排序，不做 fork 前置（`WBROWSER:987-1000`）。
  2. `SessionManager` 内部 list 快照用 `flattenLineage` 计算 `depth` 并让子行紧跟父行（`LINEAGE:46-87`；`MGR:794`；测试 `MGRSPEC:1388-1399`）——但**当前 shipped sidebar 不消费 `depth`**（sidebar 的 `SessionListState` 无 depth 字段，`SVC:56-66`；`tree.ts` 无 depth 使用）。是否有外部消费者：未证实（见 §9）。
- 扁平列表顺序：由 `list.ids`（Host 顺序）+ 排序策略决定；测试明确「ordinary forks in the supplied order regardless of timestamps」（`TREESPEC:525-533`）。
- 归档筛选对 fork 子会话无特殊处理（`TREE:238-262` 的 archivedFilter 逻辑通用）。

### 5.7 打开视图与导航行为

| 入口 | 成功后的导航 | 证据 |
|---|---|---|
| 会话菜单行 | **不导航**；不 retain 子会话；当前选中不变；子行出现在列表 | `WREADME:74`；`APPSPEC:602-640,656-684`（`retain`/`selectPanel` 均未被调用） |
| 快捷键 | **不导航**；同菜单 | `WREADME:62,74`；`SHORTSPEC:176-207` |
| 消息尾部 branch | `ctx.uiWorkspace.openSession(childId)` → 主视图切到子会话 | `CHATAPPLY:291`；`INJECTSPEC:197-247`（断言 `openSession(ROOT)` 被调用） |

`openSession` 细节：`UiWorkspaceService.openSession` → `replaceMain(target, lifetime.signal, 'reveal')`（`NAVID:276-278`）；`replaceMain` 先 `sessions.retain(child,{source:'mainView'})`，再写 selection（持久化 key `dsh.sessions.current`，`NAVID:159-161`），最后 `ctx.layout.selectPanel(null)` 把主区域回到 Conversation（`NAVID:499-529`）。子 Agent 在 Host 已 live，子会话 follow 可直接打开。
`openSession` 可用的前提：`ClientSessions.retain` 的 `resolveTarget` 对「既不在实例、也不在 summaries、也不是 subagent address」的 id 会抛 `unknown session`（`MGR:137-147`）；fork 在 resolve 前已写入占位 summary（`MGR:568-574` + `SVC:475`），这也是「同步可寻址」保证。

### 5.8 i18n 文案

| key | 中文 | English | 证据 |
|---|---|---|---|
| `menu.fork` | 分叉会话 | Fork session | `WLOC:61,187` |
| `shortcut.noCompletedTurn` | 当前会话没有已结束的轮次 | This session has no completed turn | `WLOC:18,144` |
| `shortcut.forkFailed` | 无法分叉会话，请重试 | Could not fork the session. Try again. | `WLOC:19,145` |
| `toast.forkRequiresOpen` | 请先打开原会话完成迁移，再创建分支 | Open the original session to complete migration before creating a branch. | `WLOC:95,221` |
| `toast.openForkSource` | 打开原会话 | Open original session | `WLOC:96,222` |
| `message.branch`（ui-chat） | 在新对话中分支 | Branch into a new conversation | `CLOC:158,356` |
| `message.branchUnavailable`（ui-chat） | 仅可从已完成轮次的最后一条消息分支 | Available only on the last message of a completed turn | `CLOC:159,357` |

---

## 6. 权限 / 迁移 / 可扩展性

### 6.1 `session/fork` 访问控制定义在哪里

- **Host 定义点**：所有 `@Remote` 方法都受 API Gateway 的 method-level access control 约束；action 字符串由 Gateway 拼成 `${namespace}/${method}` = **`session/fork`**（`GW:785-800`；`RA:235-244` 的 `allows()` 同理）。
- **资源解析**：fork 的 `@Remote('fork')` 没有声明 `resources` readers（`CTRL:442`），但 `SessionController` 在构造时向 typert 注册了 `session` 资源种类的默认字段 `sessionId`：`ctx.typert.resources.register('session', { field:'sessionId' })`（`CTRL:159`）。于是 `session/fork` 调用的资源 = 第一个对象参数里的 `sessionId` → `{kind:'session', id: 源会话}`（`packages/api/gateway/src/access.ts:40-172` 的 `callResources`/`defaultFieldId` 逻辑；`SCREADME:36` 权威说明）。
- **判定**：`RemoteAccessService.decide`：owner 一律 allow；`remoteAccess/follow` 一律 allow；其它 principal 必须有 policy，binding 命中的资源上 role 列出该 action 且 condition 允许（`RA:199-222`）。Gateway 对 deny 抛 `remote-access/denied`（`GW:800-812`）。
- **客户端读同一份结果**：`ctx.remoteAccess.source('session', sessionId, action)`（`RACLIENT:27-40,66-68`），由 `mountAccess` 跟随 `remoteAccess/follow` 快照流（`RACLIENT:81-160`；`RASTATE:14-46,151-153`）；UI 侧封装为 `useSessionAccess` / `useAccess`（`packages/client/ui-session/src/client/index.ts:684-697`：`ctx.remoteAccess.source('session', sessionId, action)`；`GlobalStandardProps/SessionStandardProps` 声明见同文件 `152-187`）。owner baseline 为 `{owner:true}` → 全 true（`RA:49,254-258`；`RACLIENT` 注释：true for owner / false without baseline）。
- **仓内现状（重要）**：本 checkout 内**没有生产代码注册非 owner policy**（全仓 `registerPolicy` 仅出现在 `RA` 自身与生成的 API catalog；`PrincipalMap` 只在测试中扩展）；首个非 owner 调用方（liveshare 读者）不在本仓库（设计记录 `.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md:1-80`）。所以：**当前产品形态实际只有 owner 客户端，`session/fork` 的访问控制是给未来/外部 peer 形态预留的机制**；第三方/上游若要让非 owner 触发 fork，必须注册 policy 并让 role 列出 `session/fork`（见 §6.3）。

### 6.2 `allowMigration` 的迁移门禁语义

- 契约：`allowMigration?: boolean`，「false asks the Host to check for required migration before forking；默认 true」(`TYPES:329-336`)；README：`allowMigration:false` → 返回 `session/migration-required`，省略则自动迁移（`SCREADME:34`；`SCREADME:63` 只讲 boundary）。
- Host 预检（`CTRL:442-453`）：
  - 条件：`allowMigration === false` **且** `ctx.sessions.get(sourceId) === undefined`（源未 attach）；attach 的源直接跳过（`FORKSPEC:165-183` 断言 `stat` 未被调用）。
  - 动作：`ctx.get('sessionPersistence')?.stat(sourceId)`，若 `formatStatus === 'migration-required'` 且期间源仍未被 attach → 抛 `session/migration-required`（`CTRL:444-451`）。
  - 竞态：`stat` 进行中源被 attach，则二次 `get` 发现后继续 fork（不再拒绝）（`FORKSPEC:185-221`）。
  - `stat` 失败：不吞、不当作迁移，直接冒泡 `gateway/internal`（`FORKSPEC:223-242`）。
  - 无 persistence 的冷源：`stat` 返回 undefined → 继续走 `commands.fork` → `observeSession` → `session/not-found`（`CFORKSPEC:185-207`）。
- 「打开源会话完成迁移」是什么意思：`stat.formatStatus` 只是存储格式状态（`packages/session/session-persistence/README.md:65`）；冷读会做**内存中的 prepared 历史迁移**（`FORKSPEC:105-135` 中 `allowMigration` 省略/true 时 `open(sourceId,'read')` 被调用后成功 fork），而 write-open 才会在 provider 内发布 successor（`session-persistence/README.md:108`）。于是产品语义是：**允许 fork 时，冷读自动迁移（不改源文件）；不允许时，要求用户先打开源会话（=触发 write open 的持久迁移）再分叉**。
- 两个 UI 入口的差异（**有意**，README 明说）：
  - 菜单行：`allowMigration:false`（`WIDX:228`；`APPSPEC:610-620` 断言 payload）→ 触发 toast 引导打开源会话（`WREADME:56`）。
  - 快捷键：省略 → Host 默认自动迁移（`SHORT:102`；`WREADME:62`「keeps automatic migration」）。
  - 消息尾部：省略 → 自动迁移（`CHATAPPLY:288`；`INJECTSPEC:226-229` 断言 payload 无 allowMigration）。

### 6.3 第三方客户端插件如何触发 fork

**可以复用（不需要改 Host）**，三条路：

1. **直接调公开 Client 服务**：`ctx.sessions.fork(...)`（`CONTRACT:124-142`；`ctx.sessions` 在 client root 提供，`SVC:282`；动态客户端插件的 API 目录已登记 `ISessions`，`packages/extensions/cordis-client-runner/src/client/api-catalog.ts:216,351,664`）。需要插件自身处理 `SessionForkError`、rename 失败、access 快照。
2. **复用导航服务**：`ctx.uiWorkspace.forkSession(id, onCreated?, {allowMigration}?)`（`NAVID:60-71,307-318`）——自动 `increaseTitle:true`，其余同上。
3. **接入现有 slot**（推荐 UI 插件）：
   - 菜单：`sidebar.workspaces.session.menu.item`（`kind:'list'`，owner= `{sessionId,displayTitle}`，注入 hooks: menuOpenState + shortcuts；`WSLOTS:137-180,280-284`）；注册方式与 shipped 行完全一致，用 `order` 定位（`WIDX:313-322`；契约示例 `WSLOTS:149-169`）。复用 `ForkSessionInjected` 形状可参考 `WSLOTS:388-392`。
   - 消息尾部：`conversation.chat.turnTail`（owner `{turn, seq, openFile}`，`CSLOTS:57-63,435`；由 `TurnTailNodeView.renderSlot` 渲染，`TURNTAIL:49`；子声明在 `packages/client/ui-chat/src/client/chat/register-node-renderers.ts:76-87`）。
   - 单条 finalized assistant 的动作：`conversation.chat.assistant-actions`（owner `{messageId}`，`CSLOTS:63,441`；`TURNTAIL:53-56`）。
   - 这些 slot 的条目只拿 owner 数据，自己决定显隐（shipped fork 行就是用 `useSessionAccess(...)` 自己决定，说明第三方应同样做；`WREADME:106` 契约文档）。
4. **动态（热加载）客户端插件**：由 `dsh-cordis-client-runner` 执行 browser half，只允许 `inject` 声明的服务（`packages/extensions/cordis-client-runner/README.md:19-26`）；`sessions`/`uiWorkspace`/`slots`/`remoteAccess` 都可作为注入项，因此上述 API 对动态插件同样可用。

**限制**：
- 不能给 `session` namespace 增加新 endpoint（除非插件自己出一对 Typert Host+Client 贡献，见 `docs/api-gateway.md:116-118`）。
- 不能改变 Host 的边界/seed/meta 语义，也不能指定 child id/标题——只能 fork 后调 `rename`。
- 客户端 access 判断只是 UX；Host 仍会拒（`RA` 注释「the Host enforces every call regardless」在 `packages/api/remote-access/src/client/index.ts:1-8`）。

### 6.4 第三方 Host 插件 / 上游如何复用

1. **直接调用 Host Service 方法**：`ctx.sessionController.fork(request)` 是 public 的 `@Remote` 方法，Host 进程内插件可直接 await；此时**不经过** Gateway 的 access 决策（Gateway 只对非 owner Peer 的 `invoke` 做判定，`GW:785-812`；owner/进程内调用者被视为可信）。证据：`CTRL:442-453`；`packages/api/remote-access/README.md:16-24`（owner never checked）。
2. **自组 fork（不推荐）**：`buildForkSeed` 是公开导出（`SFORK:21-29`；`commands.ts:18` import 自 `@deepseek-ai/dsh-session/fork`），配合 `ctx.agents.create({ seed, inheritedEventCount, meta:{parentSession,isSeeded:true} })` 可复刻；但边界默认规则、合成 closers、workspace 溯源都在 Controller 内，自组会漂移。
3. **通过 preset 影响子会话组合**：fork 用源会话的 `agentPreset` 组合子 Agent（`CMD:273`；`AGENT:387-400`），上游/插件可提供自定义 preset（含 scoped 工具、prompt section、权限限制），只要源会话处于该 preset 下，fork 子会话自然继承。注意这受「字节级前缀复用」设计约束（`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md`）。
4. **给非 owner 开放 fork**：注册 `remoteAccess.registerPolicy(kind, policy)`（`RA:145-166`；角色/binding 契约 `packages/api/remote-access/src/types.ts:28-67`），让 role 的 `actions` 包含 `session/fork`（以及 UI 需要的 `session/list`/`follow`/`control` 等），binding resource 指向目标 session；变更时 `invalidate(principal?)` 推快照（`RA:168-181`）。这是“上游新建 peer 产品”唯一正确的授权入口。
5. **新增自己的 Remote 包装**：第三方 Host 包可以定义自己的 `@Remote('forkFromXxx')`（自己的 namespace），内部调用 `sessionController.fork` 或更底层 API，再按自己的契约暴露（需要按 Typert 流程生成 client 契约，`docs/api-gateway.md:9,116-154`）。
6. **不可复用点**：SDK/ACP 对外协议未暴露 fork（`packages/sdk/protocol/src/types.ts` 无 fork；`packages/sdk/server/src/server.ts` 无 fork case）——外部进程集成只能走 Web/Remote 或自己封装 Host 侧 API。

### 6.5 产品行为上的坑（复用时必须注意）

- **失败提示极不对称**：菜单只处理 migration-required；快捷键处理 unavailable/failed；尾部全静默（§2.1/§2.2）。第三方若自己接 fork，必须自己定义错误呈现。
- **rename 失败 = fork 成功 + 报错**：子会话已创建/可寻址，调用方收到 Error；若第三方 `.then` 里做导航，需要区分「fork 本身失败」与「rename 失败」。
- **attach 失败无补救 API**：子会话留在 Ungrouped（§4.7；见 §9）。
- **`atSeq` 只能传 seq，不能传 message id / turn id**：消息级 fork 必须由客户端自己从 timeline 取 `turn/end` seq（`TTAILDATA:93-95`；`CHATAPPLY:285-288`）。
- **fork 不带 prompt/draft**：没有「fork 并立即发送」参数；需要 fork 后再 prompt（服务端无组合接口）。
- **fork 子会话不再自动生成标题**（`§4.6`）；第三方若不做 rename，子会话标题与源相同（或 fallback 为源第一条 prompt 的截断）。
- **`origin` 恒为 undefined**：fork 子会话不被 subagent 相关过滤/门禁识别；反过来说，若想追踪「这是 fork 子会话」，只能读 `parentSession` + `isSeeded`（`FORKSPEC:327-340`），没有专门的 header 字段。

---

## 7. Host 关键代码摘录（便于写实现方案）

`CMD:227-310` 核心（省略 try/catch 细节）：

```ts
async fork(request: SessionForkRequest): Promise<SessionForkValue> {
  let atSeq: SessionSeq | undefined
  try { atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq) }
  catch { throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {}) }
  let observed: SessionObservation
  try { observed = await this.ctx.sessionQuery.observeSession(request.sessionId) }
  catch (error) { /* SESSION_QUERY_SESSION_NOT_FOUND → session/not-found；否则 gateway/internal */ }
  using source = observed
  const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
  if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
    throw new RemoteError('session/fork-unavailable', /* ... */, { sessionId: request.sessionId })
  }
  const seed = buildForkSeed(source.events, boundary)
  const workspace = await this.forkWorkspace(source.header)        // 失败 → gateway/internal
  const childId = brandString<SessionId>(`session-${randomUUID()}`)
  const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
  const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
  await this.ctx.agents.create({
    sessionId: childId, seed,
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: source.header.id,
      isSeeded: true,
      ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
    },
    agentOptions: { provider, model },
    setup: composition.setup,
  })
  if (workspace !== undefined) await workspace.attachSession(childId) // 失败 → session/workspace-attach-failed
  return { sessionId: childId }
}
```

`SFORK:21-29`：

```ts
export function buildForkSeed(events, boundary) {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({ type: 'session/end-seed', seq: SessionSeq(boundary + 1), time: events[boundary]!.time, data: { inherited: true } })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}
```

`SVC:459-483` 客户端（含标题递增与 rename 语义）：

```ts
async fork(opts: { sessionId; atSeq?; increaseTitle?; onCreated?; allowMigration? }): Promise<SessionId> {
  const sourceTitle = opts.increaseTitle ? this.list.getSnapshot().byId[opts.sessionId]?.title : undefined
  const result = await this.manager.fork({ sessionId, ...(atSeq), ...(allowMigration) })
  if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
  this.projectList()
  const childId = result.value.sessionId
  opts.onCreated?.(childId)
  if (sourceTitle !== undefined) {
    const renamed = await this.manager.rename(childId, increasedForkTitle(sourceTitle))
    if (!renamed.ok) throw new Error(`fork child rename failed: ...`)
  }
  return childId
}
```

---

## 8. 证据表（file:line）

> 缩写展开见 §0；行号为 checkout `687f282e86` 时点。

### 8.1 Host / Controller / Core

| # | 结论 | 证据 |
|---|---|---|
| H1 | `session/fork` Remote endpoint 与迁移预检 | `packages/api/session-controller/src/index.ts:159,435-453` |
| H2 | fork 主流程（校验→观测→边界→seed→workspace→compose→create→attach） | `packages/api/session-controller/src/commands.ts:227-310` |
| H3 | 默认 boundary 算法（吸收独立尾部事件、在下一轮/排队输入前停） | `packages/api/session-controller/src/commands.ts:76-90,251-260` |
| H4 | `forkWorkspace`（直接成员 / subagent 祖先溯源） | `packages/api/session-controller/src/commands.ts:550-560` |
| H5 | 冷/热观测接口与默认 `projectionMode='all'` | `packages/session-query/session-query/src/index.ts:136-142`；`packages/session-query/session-query/src/observation.ts:98-158`；`packages/api/session-controller/src/commands.ts:236` |
| H6 | `traceSession` 契约（ancestors/complete） | `packages/session-query/session-query/src/index.ts:327-331`；`packages/session-query/session-query/src/types.ts:83-103` |
| H7 | `readSessionState` 属 attachment 路径，非 fork | `packages/api/session-controller/src/commands.ts:377-411,540-548` |
| H8 | `composeAgent` / `presetForObservation` / `installSelection` | `packages/api/session-controller/src/agent.ts:289-340,382-400,589-599` |
| H9 | 默认 provider/model 双层语义（AgentOptions vs 继承 request/header） | `packages/api/session-controller/src/commands.ts:275,288`；`packages/api/session-controller/src/agent.ts:300-315,580-583`；`packages/core/agent/src/model-selection.ts:79-110`；`packages/api/session-controller/tests/session-fork.host.spec.ts:634-679` |
| H10 | seed 构造（前缀 + inherited marker + 合成 closers） | `packages/core/session/src/fork.ts:21-29`；`packages/core/session/src/repair.ts:53-93` |
| H11 | Session seeded 不变量（marker 位置、inheritedEventCount、firstLifecycleSeq） | `packages/core/session/src/index.ts:665-702` |
| H12 | `CreateAgentOptions` 契约（seed/meta/inheritedEventCount/setup、先 setup 后发布） | `packages/core/agent/src/index.ts:57-112,392-412` |
| H13 | `attachSession` 校验与前插语义 | `packages/workspace/workspace/src/entity.ts:110-162` |
| H14 | 无「重新 attach」Remote 入口；`insertSessionBefore` 要求已 accounted | `packages/api/workspace-controller/src/index.ts:139-157`；`packages/workspace/workspace/src/entity.ts:164-180` |
| H15 | Host 侧错误码 details 定义 | `packages/api/session-controller/src/types.ts:205-240`（`session/workspace-attach-failed`:219；`session/fork-unavailable`:228；`session/migration-required`:229） |
| H16 | fork 请求/响应类型 | `packages/api/session-controller/src/types.ts:329-341` |
| H17 | Host list summary 字段（parentSessionId/origin/cwd/blank/updatedAt） | `packages/api/session-controller/src/list.ts:49-60,128-143,349-363` |
| H18 | `api-session/added` 等事件发射与转发白名单 | `packages/api/session-controller/src/index.ts:191-203`；`packages/api/session-controller/src/remote-events.ts:1-14`；`packages/api/remotes/src/remote-events.ts:29-33` |
| H19 | ArchivedSessionGate 只沿 subagent origin 上溯（fork 独立） | `packages/api/session-controller/src/archived-session-gate.ts:34-55` |
| H20 | subagent fork provider 是另一套机制（不走 session/fork） | `packages/subagent/subagent-fork-in-process/src/index.ts:5-7,41-77` |

### 8.2 测试断言（行为证据）

| # | 结论 | 证据 |
|---|---|---|
| T1 | 省略 atSeq：最近完成轮次 + 独立尾部；已开轮次被截掉 | `packages/api/session-controller/tests/session-fork.host.spec.ts:441-462` |
| T2 | 无完成轮次 → `session/fork-unavailable`；越界 seq 同码，message `/does not exist/` | `.../session-fork.host.spec.ts:455-474` |
| T3 | 省略边界继承 `session/title` 等独立尾部事件；显式边界不扩展 | `.../session-fork.host.spec.ts:476-495,545-559` |
| T4 | 显式切在 open turn / step 内部 → 合成 `turn/end(forked)` 与 `tool/result(TOOL_OUTCOME_UNKNOWN)` | `.../session-fork.host.spec.ts:509-543,561-632` |
| T5 | 子 header：parentSession=源、cwd 复制、origin 未设置、inherited 数正确 | `.../session-fork.host.spec.ts:327-340,342-383,385-439` |
| T6 | 源 Agent 不被激活、不被 resume（live/cold/persisted subagent） | `.../session-fork.host.spec.ts:165-183,385-439` |
| T7 | `allowMigration=false` + 冷会话 + migration-required → 拒绝且不 open/observe/create；stat 失败→gateway/internal | `.../session-fork.host.spec.ts:137-163,223-242` |
| T8 | allowMigration 省略/true + migration-required 可 fork（open read） | `.../session-fork.host.spec.ts:99-135` |
| T9 | resident 源不读 stat；stat 期间 attach 则继续 | `.../session-fork.host.spec.ts:165-183,185-221` |
| T10 | 手工 compact 的 checkpoint 会保留（默认边界包含 compaction/end） | `.../session-fork.host.spec.ts:244-284` |
| T11 | 下一个用户输入/排队输入不进入子会话 | `.../session-fork.host.spec.ts:286-325` |
| T12 | fork 不改源日志 | `.../session-fork.host.spec.ts:320,541` |
| T13 | 子 preset 进入 meta（`minimal`）；失败时 meta 省略 cwd/preset 并报 attach 失败 | `packages/api/session-controller/tests/commands-create-fork.host.spec.ts:255-294` |
| T14 | 无持久化/缺会话 → `session/not-found`；观测失败→`gateway/internal`；lineage/create 失败→`gateway/internal` | `.../commands-create-fork.host.spec.ts:185-253` |
| T15 | 非法 atSeq 在读/建之前拒绝（`-1`、`0.5`） | `.../session-fork.host.spec.ts:497-507` |
| T16 | 客户端 fork 迁移权限三态原样转发；不打开源 | `packages/api/session-controller/tests/sessions-service.client.spec.ts:934-947` |
| T17 | migration-required 保留、无 child、无 FOLLOW | `.../sessions-service.client.spec.ts:948-966` |
| T18 | 标题递增样例（半角/全角/前缀空格） | `.../sessions-service.client.spec.ts:983-1011` |
| T19 | `onCreated` 在 rename 前；失败 rename 抛 Error 但 child 行保留 | `.../sessions-service.client.spec.ts:1034-1055` |
| T20 | 无 title 或未开策略则不 rename；atSeq 原样传递 | `.../sessions-service.client.spec.ts:1012-1032` |
| T21 | 列表占位：workspace-attach-failed 也发布 Ungrouped summary | `packages/api/session-controller/tests/manager.client.spec.ts:1241-1274` |
| T22 | manager lineage depth 行为 | `.../manager.client.spec.ts:1388-1399` |

### 8.3 客户端 UX / 状态

| # | 结论 | 证据 |
|---|---|---|
| C1 | 菜单行：access 隐藏、点击顺序、注入回调、allowMigration:false | `packages/client/ui-workspace/src/client/session-actions/ForkSession.tsx:12-30`；`packages/client/ui-workspace/src/client/index.ts:224-235`；`packages/client/ui-workspace/tests/session-actions.client.spec.tsx:231-249`；`packages/client/ui-workspace/tests/apply.client.spec.ts:602-640` |
| C2 | 菜单行 order=300；slot 声明/注册方式 | `packages/client/ui-workspace/src/client/index.ts:296-322`；`packages/client/ui-workspace/src/client/contract/slots.ts:137-180,280-284` |
| C3 | 菜单可用性受 access；空白行无菜单 | `packages/client/ui-workspace/src/client/rows/Rows.tsx:646-689` |
| C4 | 快捷键：目标=mainView、blocked 条件、默认键位、失败分类 toast | `packages/client/ui-workspace/src/client/shortcuts.ts:58-64,66-67,96-110`；`packages/client/ui-workspace/tests/shortcuts.client.spec.ts:176-207` |
| C5 | fork toast 呈现与 opener 动作 | `packages/client/ui-workspace/src/client/toast/register.ts:60-82`；`packages/client/ui-workspace/src/client/index.ts:248-258`；`packages/client/ui-workspace/tests/apply.client.spec.ts:686-744` |
| C6 | 菜单路径失败静默（非 migration-required） | `packages/client/ui-workspace/tests/apply.client.spec.ts:771-800` |
| C7 | 尾部按钮：forkAllowed→onBranch、branchUnavailable→disabled | `packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:32,64-78`；`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:90-109` |
| C8 | branchUnavailable 判定（closing/latestTranscriptSeq/后续节点） | `packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts:70-99`；`packages/client/ui-chat/tests/chat-view.client.spec.tsx:3344-3410` |
| C9 | forkAt：atSeq=seq、increaseTitle、onCreated analytics、成功后 openSession、失败静默 | `packages/client/ui-chat/src/client/apply.ts:285-295`；`packages/client/ui-chat/tests/apply-inject.client.spec.tsx:197-247` |
| C10 | 尾部 owner 契约与 slot 声明 | `packages/client/ui-chat/src/client/contract/slots.ts:57-63,435,441`；`packages/client/ui-chat/src/client/chat/register-node-renderers.ts:76-87` |
| C11 | 客户端 fork facade 契约（allowMigration/increaseTitle/onCreated） | `packages/api/session-controller/src/client/contract/sessions.ts:124-142` |
| C12 | `SessionForkError` 结构与 rename 失败语义 | `packages/api/session-controller/src/client/sessions/service.ts:84-98,459-483` |
| C13 | 占位 summary 与 workspace-attach-failed 调和 | `packages/api/session-controller/src/client/sessions/manager.ts:546-576,828-881` |
| C14 | placeholder/upsert 合并规则（blank 只降、只补缺失元数据） | `packages/api/session-controller/src/client/sessions/manager.ts:828-877` |
| C15 | rename 后 title 投影立即上屏 | `packages/api/session-controller/src/client/sessions/manager.ts:584-590,775-800` |
| C16 | 客户端 list 的 parentId 投影 | `packages/api/session-controller/src/client/sessions/service.ts:618-692` |
| C17 | 导航：forkSession 不导航；openSession 替换主视图/持久选中 | `packages/client/ui-workspace/src/client/navigation.ts:60-71,276-278,307-318,499-529` |
| C18 | sidebar 不显示 subagent 行、fork 行正常；仅排序用 lineage | `packages/client/ui-workspace/src/client/tree.ts:44-62,161-207,238-258`；`packages/client/ui-workspace/tests/tree.client.spec.ts:164-209,525-541` |
| C19 | 默认排序 updated / 分组模式与 member 排序 | `packages/client/ui-workspace/src/client/stores.ts:82-92`；`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:987-1000` |
| C20 | i18n 文案 | `packages/client/ui-workspace/src/client/locales.ts:18-19,61,95-96,144-145,187,221-222`；`packages/client/ui-chat/src/client/locale.ts:158-159,356-357` |
| C21 | analytics 事件 schema 与 Desktop-only 策略 | `packages/client/product-analytics/src/events.ts:32-37`；`packages/client/product-analytics/README.md:10-12` |
| C22 | 客户端 sessions 服务提供点与 remote 事件订阅 | `packages/api/session-controller/src/client/sessions/service.ts:282`；`packages/api/session-controller/src/client/index.ts:97-126` |

### 8.4 权限 / 传输 / 可扩展性

| # | 结论 | 证据 |
|---|---|---|
| P1 | 非 owner 的 method-level 判定（action=ns/method，资源解析，deny 抛错） | `packages/api/gateway/src/index.ts:785-812`；`packages/api/gateway/src/access.ts:40-172` |
| P2 | fork 的 session 资源默认字段注册 | `packages/api/session-controller/src/index.ts:159` |
| P3 | `decide`/`allows`/`snapshotFor`/`follow` 语义 | `packages/api/remote-access/src/index.ts:199-222,235-244,254-258,270-300` |
| P4 | 角色/binding/policy/快照类型 | `packages/api/remote-access/src/types.ts:22-142` |
| P5 | 客户端 access 服务与快照流 | `packages/api/remote-access/src/client/mount.ts:27-40,81-160`；`packages/api/remote-access/src/client/state.ts:14-46,84-153`；`packages/client/ui-session/src/client/index.ts:684-697` |
| P6 | 权限/迁移的产品语义（README 权威） | `packages/api/session-controller/README.md:34,36,46,63` |
| P7 | allowMigration 的 README 语义 | `packages/api/session-controller/README.md:34` |
| P8 | Remote/Client 传输与 Typert 生成契约 | `docs/api-gateway.md:9,62,94,102-118,142-154`；`packages/api/gateway/src/client/index.ts:444-480`；`packages/api/gateway/src/index.ts:240-260,474-520`；`packages/typert/protocol/src/index.ts:278-313`；`packages/typert/protocol/src/types.ts:99-140` |
| P9 | 远端事件 allowlist（api-session/added 资源 reader） | `packages/api/remotes/src/remote-events.ts:1-33` |
| P10 | repo 内无生产 registerPolicy（仅测试扩展 PrincipalMap） | `grep -rn "registerPolicy" packages`：仅 `packages/api/remote-access/src/index.ts:153` 与生成 catalog；`PrincipalMap` 生产定义 `packages/typert/protocol/src/types.ts:455-461`；测试扩展见 `packages/api/session-controller/tests/remote-access.host.spec.ts:26` 等 |
| P11 | 非 owner 首个使用方（liveshare）不在本 checkout | `.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md:1-80` |
| P12 | 槽位 → 第三方插件的正式合同（menu item 示例） | `packages/client/ui-workspace/src/client/contract/slots.ts:116-180,292-309,388-392`；`packages/client/ui-workspace/README.md:104-106` |
| P13 | 动态客户端插件服务白名单 | `packages/extensions/cordis-client-runner/README.md:19-26`；`packages/extensions/cordis-client-runner/src/client/api-catalog.ts:216,351,664` |
| P14 | SDK/ACP 未暴露 fork | `packages/sdk/protocol/src/types.ts`（无 fork）；`packages/sdk/server/src/server.ts:347`（只有 session/prompt 分支） |
| P15 | ui-workspace README 对 Fork 行为的权威描述 | `packages/client/ui-workspace/README.md:38,56,60,62,74` |
| P16 | fork 的两入口迁移策略差异（README） | `packages/client/ui-workspace/README.md:56`（菜单 allowMigration:false）与 `:62`（快捷键 keeps automatic migration） |

---

## 9. 未解问题 / 未证实 / 已知限制

1. **非 owner 的 `session/fork` 授权是否是产品形态的一部分**：本 checkout 没有生产 policy；设计记录称首个非 owner 调用方是 liveshare 读者，但 liveshare 实现不在本仓库。→ 非 owner 能否真正 fork（需要上游授予哪些 role/action 组合）**未证实**。
2. **`SessionListEntry.depth` / `flattenLineage` 的消费方**：manager 内部 list 快照会算 lineage depth（`MGR:794`；`LINEAGE:46-87`；测试 `MGRSPEC:1388-1399`），但 shipped sidebar 用自己的 `SessionListState`（无 depth）重算 rows。是否有外部/实验性 UI 消费 depth **未证实**。
3. **attach 失败后无法补救**：`session/workspace-attach-failed` 后子会话留在 Ungrouped；workspace-controller 没有“重新挂载”端点，`insertSessionBefore` 拒绝未 accounted 的会话（`WENTITY:164-180`）。产品上如何让用户把该会话挂回 workspace **未证实**（可能只能通过重开会话/手动目录关联，未在代码中找到路径）。
4. **源 preset 已被删除/无法解析时 fork 的行为**：`composeAgent`/`presets.resolve` 抛错未被 `CMD.fork` 捕获，会折叠成 `gateway/internal`。**未证实**是否有 fallback（测试无覆盖）。
5. **源无 durable title、fork 后不 rename 的精确标题**：`ensureFallback` 在无 title 时会用 `titleInput` 的 `first`（含继承的源首条 user message）生成 fallback（`packages/session/session-title/src/index.ts:732-734,809-843`），但 fork 子会话的自动 provider 调度被 `parentSession === undefined` 条件排除（`.../index.ts:505-520`）。实际端到端标题（尤其源标题在 boundary 之后生成时）**未证实**。
6. **归档源 + 迁移门禁的组合行为**：Host 允许 fork 归档源（fork 无 archive 检查）；但菜单的迁移 toast 的“打开原会话”动作对归档源会改弹 `archivedNotOpenable`（`WIDX:248-257`；`APPSPEC:715-744`），意味着「归档且需迁移」的源在菜单入口无法完成 fork、也无提示如何解决。**是否有意**未证实。
7. **`session/fork-unavailable` 的 details 信息量不足**：只有 `{sessionId}`，边界/最后 seq 只在 message 文本里（`CMD:252-260`；`TYPES:228`），客户端无法结构化区分“无完成轮次”与“seq 不存在”，只能靠错误码 + 文案。属于契约设计限制。
8. **`allowMigration` 对“live 但格式落后”的源**：live 会话直接跳过 stat（`CTRL:444`），不存在迁移门禁；但 live 会话是否可能是 `migration-required` 格式（例如被恢复为 live 前已迁移）没有测试覆盖。**未证实**。
9. **`ctx.sessionController.fork` 被 Host 插件直接调用时是否应走 access**：Gateway 只对非 owner Peer 判定（`GW:785-812`），进程内调用者视为信任；但若插件代表某个 peer 行动，需要自行复用 Gateway/Peer 机制。**约定未证实**（无文档说明插件必须如何做）。
10. **测试未执行**：checkout 无 `packages/*/lib` 构建产物（`ls packages/api/session-controller/lib` 不存在），且该 checkout 只读，因此本文行为结论全部来自源码与 spec 源码断言，而非本地运行结果。若需运行：先按仓库流程构建（`docs/api-gateway.md:102-154` 描述 host/client 两阶段构建），再 `pnpm vitest run packages/api/session-controller/tests/session-fork.host.spec.ts` 等。
11. **UI 层的一个不对称点**：快捷键不做客户端 access 判断（`SHORT:96-110`），菜单/尾部按钮做；非 owner 场景下用户会看到可用的快捷键但得到通用失败提示。是否有意 **未证实**。
12. **`increaseTitle` 的 rename 是独立 RPC**：fork 与 rename 不是原子的；rename 失败时子会话保留原名并已入列表（`SVCFORKSPEC:1034-1055`）。如果实现方案要求“fork 后标题保证唯一”，需要额外补偿或 Host 侧组合接口（当前不存在）。

---

## 10. 给后续实现方案的要点（基于以上证据）

1. 想新增一个 fork 入口（UI）：优先注册 `sidebar.workspaces.session.menu.item`（`order` 定位）或 `conversation.chat.turnTail`/`assistant-actions` slot，复用注入的 `forkSession`/`forkAt`；否则直接 `ctx.sessions.fork`（记得自己处理 `SessionForkError`、rename 失败、access）。
2. 想改变 Host fork 语义（例如按 message id fork、原子标题、attach 重试）：必须改 Host 侧 `SessionCommandController.fork` 或新增自己的 `@Remote` 方法（Typert 契约 + 生成流程，`docs/api-gateway.md:116-154`）；客户端插件无法绕过。
3. 想给非 owner（liveshare/远程）开放 fork：唯一正确入口是 `remoteAccess.registerPolicy` + role 列出 `session/fork`，并考虑 UI 需要的 `session/list|follow|control|page|projections` 等 action；客户端会自动通过 access 快照隐藏/显示入口（`RA`/`RACLIENT`）。
4. 想复用“fork 子会话继承源 preset”这一事实来做子会话差异化：在 preset 上做文章（fork 自动 compose 源 preset，`CMD:273`），但注意 prefix-cache 设计约束（`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md`）。
5. 需要 fork 后自动命名/自动打开：当前都不是 Host 行为；客户端需自行 `rename`/`openSession`，并注意「rename 失败但 fork 成功」的语义（`SVC:478-481`）。
