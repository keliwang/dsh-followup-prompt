# DSH fork 会话核心机制调研（session core 层）

> **调研对象**：`/Users/keli/Workspace/personal/works/deepseek-harness`，`@deepseek-ai/dsh-session` 版本 `0.2.1-rc.2`（`packages/core/session/package.json:4`，根 `package.json:3`）。
> **调研范围**：`packages/core/session` 的 fork/seed/repair/构造校验，以及它向上依赖的持久化、格式迁移、Host controller、session-query 观察路径。controller 之后（Web UI 动作、标题递增、workspace 挂载）只在与语义相关处提及。
> **证据约定**：第 8 节证据表使用相对 checkout 根目录的完整路径；正文中的短文件名（如 `index.ts`、`repair.ts`）指该段落所讨论包内的同名文件（例如 2.x 节的 `index.ts` = `packages/core/session/src/index.ts`），行号为 2026-10-19 checkout 的实际行号。笔记指 `.agents/notes/` 下的 Agent Note。凡没有直接代码/笔记支撑的推断，标注「未证实」。
> **一句话结论**：fork = 把源日志的一个**闭区间前缀（inclusive seq）**物理复制成子会话日志，在 cut 处插入子拥有的 `session/end-seed {inherited:true}` 标记，并用与崩溃修复**同一套工具配平算法**、但以 `forked` 为 cause 的合成事件闭合尾部的开放 turn/step；`inheritedEventCount` 单独记录 cut（不含 marker/closers），`isSeeded` 只表达谱系；core 只允许 fork **live** 会话，冷会话 fork 由 Host controller 基于 `sessionQuery.observeSession` + `buildForkSeed` + `agents.create` 实现。

---

## 0. 结论摘要

1. **`buildForkSeed` 只有 30 行，是唯一的 core 级 fork 纯函数**：`events.slice(0, boundary+1)`（inclusive）→ push `session/end-seed {inherited:true}`（seq = `boundary+1`，time = cut 事件时间）→ `concat(openTurnClosers(prefix, {kind:'forked'}))`（`packages/core/session/src/fork.ts:21-30`）。
2. **boundary 是 inclusive、必须是源日志中既有的连续 seq**；校验在 `SessionStore._forkBoundary`，不合法一律 `INVALID_BOUNDARY`（`packages/core/session/src/index.ts:1400-1433`）。core 的默认 boundary = **源当前最后一个事件**（可能是开放 turn 内部），空源 + 省略 boundary 得到空子会话（`index.ts:1403-1410, 1380-1398`）。
3. **core 只 fork live 会话**：source 可以是 live `Session` 对象或 live `SessionId`；冷会话（只在磁盘上）不满足 `ctx.sessions.get()`，会得到 `SESSION_NOT_FOUND`（`index.ts:1435-1448`；测试 `packages/core/session/tests/fork.spec.ts:212-234`）。冷 fork 是 Host 能力（`packages/api/session-controller/src/commands.ts:227-310`）。
4. **开放尾部的语义**：cut 落在开放 turn/step 内时，只关闭“仍开放”的尾部：未回答的工具调用先补错误 `tool/result`，再补 `step/end`（若 step 开放），最后 `turn/end {reason:{kind:'forked'}}`；**已闭合的 step/turn 原样保留，即使其中有历史失败调用缺 result**（`fork.ts:29`、`repair.ts:53-98`、`fork.spec.ts:381-404`）。
5. **合成事件全确定**：seq 连续接在 seed 后；time 复用前缀最后一个真实事件时间（buildForkSeed 路径 = cut 事件时间）；message id = `${cause.kind}-tool-result-${callId}-${seq}`；错误码只两个（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`）；wording 按 cause 固定（`repair.ts:32-41, 157-197`）。
6. **`session/end-seed` 有两种形态、两种语义**：带 `inherited:true` 的 tagged marker 是**fork cut**（子会话在 cut 处必有一个，嵌套 fork 保留祖先 marker）；不带 tagged 的普通 marker 是**resume 生命周期边界**，用于插件判断开放 bracket 是否属于已结束的生命周期（`types.ts:404-428`；`.agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.md:18-24, 44`）。
7. **`inheritedEventCount` 与 `header.isSeeded` 解耦**：`isSeeded` 是 header 里的布尔谱系位；精确 cut 是 `SessionLogOffset`，只随 body（Session 状态/持久化 handle/observation）传递，**不在逻辑 header 里**，V4 物理 header 行也不存数值 cut（`types.ts:95-132, 139-161`；`packages/session/session-persistence-jsonl/src/format.ts:78-83, 139-155`；`.agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md:15-17`）。
8. **seed 前缀是物理复制，不是引用**：子会话的持久化写入由 agent-loop 在发布点把从 seq 0 起的完整构造日志（含继承前缀 + marker + closers）写进子会话自己的 write handle（`packages/core/agent-loop/src/index.ts:715-744`；`docs/subsystems/persistence.md:226`）；“父引用”方案在笔记中被明确 deferred（`.agents/notes/archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md:72`）。
9. **reopen 通过“最后一个 tagged end-seed 的 seq”重建 cut**：V4 物理 header 行不含数字；JSONL 解码器扫描 body 得到 `inheritedEventCount`（`packages/session/session-format-v1-to-v2/src/codec.ts:82-127`；`session-persistence-jsonl/src/format.ts:456-475`），V4 校验要求 `lastInheritedMarker === cut` 且 `isSeeded` 与 marker 存在性一致（`packages/session/session-format-v3-to-v4/src/validation.ts:48-79`）。
10. **`turn/end.reason.kind='forked'` 只出现在 fork seed 中，loop 从不 live 发出**；与 `completed` 的差别是消费者可用它区分“子继承历史中被强行闭合的父 turn”，例如 workflow-run 视为不可用、subagent 投影 `lastTurnCompleted=false`（`types.ts:223-229`；`packages/client/ui-workflow-run/src/client/workflow-definition.ts:92`；`packages/subagent/subagent/src/projection.ts:100`；`packages/core/agent/src/consumed-work.ts:42-58`）。
11. **子会话的 header 由调用方决定**：core `SessionStore.fork` 只写 `cwd`（继承源）、`parentSession`、`isSeeded:true`（`index.ts:1389-1397`）；`origin/delegationDepth/agentPreset` 由上层补（Host controller 补 `agentPreset`，`commands.ts:283-287`；subagent 子代补全四项，`packages/subagent/subagent/src/child-agent.ts:135-156`）。
12. **V4 迁移保留 inherited cut**，并对 fork 的合成 not-started 结果做专门校验（`session-format-v3-to-v4/src/fork-result.ts:10-39`；`docs/persistence-changes/2026-09-16-session-format-v4.md:94`）。

---

## 1. 两个层次：core store fork 与 Host controller fork

| 维度 | core：`SessionStore.fork` | Host：`SessionCommandController.fork`（RPC `session.fork`） |
|---|---|---|
| 入口 | `ctx.sessions.fork(source, boundary?, childSessionId?)`（`index.ts:1380-1398`） | Remote `@Remote('fork')`（`packages/api/session-controller/src/index.ts:442-453`）→ `commands.fork`（`commands.ts:227-310`） |
| 源要求 | **必须 live**（`Session` 对象或 live id）；冷会话 `SESSION_NOT_FOUND`（`index.ts:1435-1448`） | live 优先；**冷会话可 fork**：`sessionQuery.observeSession` 走 live 或 prepared 读（`commands.ts:232-258`；`packages/session-query/session-query/src/observation.ts:98-180`） |
| 默认 boundary | 源**当前最后一个事件**（`index.ts:1403-1410`） | **最新完成回合前缀**（`latestCompletedPrefixBoundary`，`commands.ts:80-90, 251`） |
| cut 校验 | 安全整数/存在/`events[boundary].seq===boundary`（`index.ts:1411-1431`） | 同上语义 + `source.events[boundary]?.seq !== boundary` → `fork-unavailable`（`commands.ts:252-260`） |
| seed 构造 | `buildForkSeed`（`index.ts:1388`） | 同一 `buildForkSeed`（`commands.ts:261`） |
| 子会话创建 | `this.create(...)`，**只是 in-memory store 子会话**（`index.ts:1389`） | `ctx.agents.create(...)`：agent-loop 发布会把 seed 写进持久化（`commands.ts:276-297`；`agent-loop/src/index.ts:715-744`） |
| 子 header 额外字段 | 无（只有 cwd/parentSession/isSeeded） | 从源 composition 解析 `agentPreset` 并写入（`commands.ts:273-287`；测试 `commands-create-fork.host.spec.ts:277-295`） |
| 副作用 | 无持久化（“only agent-loop-published sessions persist”，`docs/architecture.md:161`、`docs/subsystems/persistence.md:226`） | workspace 挂载、迁移预检（`commands.ts:298-310`；`index.ts:444-451`） |
| 错误类型 | `SessionForkError` 四种 code（`index.ts:1028-1040`） | 映射成 `RemoteError`：`session/not-found`、`session/fork-unavailable`、`session/migration-required`、`session/workspace-attach-failed`、`gateway/*`（`commands.ts:240-310`；`index.ts:444-451`） |

> 注意：`SessionStore.fork` 本身**不接持久化**——它没有 persistence handle；被它创建的子会话要持久化，必须由消费方通过 agent 生命周期重新发布，或走 Host 路径。Host 路径因此不使用 `SessionStore.fork`，而是自己调 `buildForkSeed` + `agents.create`，以便支持冷源和持久化。

---

## 2. 精确语义与不变量

### 2.1 boundary 的精确含义

- **inclusive**：复制 `seq ∈ [0, boundary]` 的全部事件，即 `slice(0, boundary+1)`（`fork.ts:22`）。
- **必须是源日志中已存在的连续 seq**：`boundary` 是 `SessionSeq`（“一个已存在的事件身份”），不是 offset（`types.ts:32-45`；`types.ts:47-60` 是 offset 的独立 brand）。`_forkBoundary` 依次校验：非负安全整数（`index.ts:1411-1416`）→ `boundary < events.length`（`1417-1423`）→ `events[boundary].seq === boundary`（`1425-1431`）。
- **空源**：省略 boundary → 返回 `undefined` → `seed=[]`、`inheritedEventCount=0`，但 `isSeeded:true`（`index.ts:1387-1392`）；显式 boundary（含 0）→ `INVALID_BOUNDARY`（`index.ts:1417-1423`；测试 `fork.spec.ts:181-186`）。
- **canonical 语义提醒**：`SessionSeq` 名字是“某个已存在事件”，`SessionLogOffset` 名字是“前缀长度/读取 offset”，两者不可互换；`inheritedEventCount` 是后者（`.agents/notes/archived/architecture/2026-08-31-session-sequence-and-log-offset-brands.md:16-22`；`types.ts:32-60`）。

### 2.2 “最新完成回合”是 Host 层概念，不是 core

- core 默认 = 源当前最后事件（`index.ts:1364-1379` doc；`index.ts:1403-1410` code）。
- Host 默认 = `latestCompletedPrefixBoundary`：找**最后一个 `turn/end`**，再向后吞掉不属于下一个 turn 的独立事件；遇到下一个 `turn/start`、`surfaceOp==='append'` 的 `user/message`、或 `agent/inbox/spliced` 即停止（`commands.ts:80-90`）。无 `turn/end` 时返回 `undefined` → `session/fork-unavailable`（`commands.ts:251-259`；测试 `commands-create-fork.host.spec.ts:219-231`）。
  - 该规则保留“手动 compaction 产生的 replace 型 user/message”等 standalone 工作，同时排除排队输入（`commands.ts:80-90`；笔记 `2026-08-18-arbitrary-seq-session-fork.md:22`；测试 `session-fork.host.spec.ts:244-263`）。
- 显式 `atSeq` 是**精确 cut**，不会向前/向后扩展（`commands.ts:251-260`；测试 `session-fork.host.spec.ts:545-559`）。

### 2.3 开放 step / turn 的处理（forked closers）

`buildForkSeed` 在 marker 之后调用 `openTurnClosers(prefix, {kind:'forked'})`（`fork.ts:29`）。`openTurnClosers` 只扫描前缀（含 marker，marker 不改变 turn/step 游标）：

- 扫描规则：`turn/start` → 记录 openTurn 并清 openStep；`turn/end` → 清两者；`step/start` → 记录 openStep；`step/end` → 清 openStep；其他事件不动游标（`repair.ts:57-78`）。
- 若**没有开放 turn**（日志已平衡或空）→ 返回 `[]`（`repair.ts:80-83`；测试 `repair.spec.ts:104-114`）。
- 若开放 turn：
  1. 先补未回答调用（见 2.4），
  2. 若 openStep 非空，补 `step/end {turn, step}`，
  3. 最后补 `turn/end {turn, reason:{kind:'forked'}}`（`repair.ts:88-97`）。
- 合成事件 seq 从“前缀最后事件 seq + 1”开始连续递增；time 全部复用前缀最后事件的 time（`repair.ts:88-90, 159-160`；`fork.ts:26` 使前缀最后事件在 buildForkSeed 路径就是 marker，其 time = cut 事件 time）。
- **只关闭开放尾部**：`turn/end` 前的所有已闭合 turn 不受影响；如果 cut 落在“开放 turn 内但 step 已闭合”的位置，只补 `turn/end`（`fork.spec.ts:302-322`）。

### 2.4 工具调用配平（失败的 tool call 缺 result）

`ToolCallRecovery` 是 fork 与崩溃修复共享的算法核心（注意：`openTurnClosers` 对两种 cause 走同一状态机，只有 cause 影响 reason/wording/id 前缀、错误码共用）：

- 只跟踪**当前开放 step 内**、来自 `assistant/message` 的 `tool-call` block；`tool/call` 到达时记录其 seq（表示“已开始”）；`tool/result`（`surfaceOp==='append'` 且 turn/step 匹配）会从 pending 中移除（`repair.ts:116-149`）。
- pending 在 `turn/start`、`turn/end`、`step/end` 时**全部清空**（`repair.ts:118-123`）。因此：
  - 开放 step 内 assistant 声明了 tool call 但 cut 在 `tool/call` 之前 → 子会话补一条 **TOOL_NOT_STARTED** 错误 result（`repair.ts:14-15, 184-190`；测试 `fork.spec.ts:324-350`）。
  - cut 在 `tool/call` 之后、result 之前 → 补一条 **TOOL_OUTCOME_UNKNOWN** 错误 result，并带 `sourceEventSeqs: [callSeq]`、`surfaceOp:'append'`（`repair.ts:191-192`；测试 `fork.spec.ts:352-366`）。
  - 多个未回答调用按 assistant 内容顺序（Map 插入序）补，各自独立 seq（`repair.ts:164-166`；测试 `repair.spec.ts:286-319`）。
- **已闭合 step 中的 dangling call 不补**：这是与崩溃修复刻意共享的边界（`fork.spec.ts:381-404`；笔记 `2026-08-18-arbitrary-seq-session-fork.md:16, 30`）。原因：该失败属于父会话的历史事实，fork 不应变成“历史修复策略”。
- 模型可见文案按 cause 固定：`forked` 版明说“继承的历史缺少 result / 父会话可能在 fork 点之后执行过”，并给出“只读或幂等才可重试，可能有副作用先核实外部状态或问用户”的指引（`repair.ts:32-41`）。

### 2.5 已闭合 step/turn 原样保留

- `buildForkSeed` 注释明确：“Closed steps and turns are preserved unchanged.”（`fork.ts:11-15`）。
- 因此子会话 `deriveMessages()` 在无开放尾部时与源完全一致（`fork.spec.ts:403`；`session-fork.host.spec.ts:526-543` 断言 source 未被修改）。
- 已闭合 turn 的 `turn/end.reason` 也原样继承（completed/aborted/error/max-tokens/interrupted 都可作为显式 boundary 被复制，`fork.spec.ts:138-158`）。

### 2.6 嵌套继承 cut（父本身是 fork）

- `buildForkSeed` 复制的是**父会话完整日志前缀**；父日志本身已包含祖先继承前缀 + 父的 tagged marker + 父自有事件。因此子会话会保留祖先 marker（`fork.ts:22`；笔记 `2026-08-18-arbitrary-seq-session-fork.md:18`）。
- 子会话在 `boundary+1` 插入**自己的** tagged marker；`inheritedEventCount = boundary+1`（= 复制到的事件总数，**包含祖先所有事件**，不含子 marker/closers）（`index.ts:1391`）。
- `Session` 构造只要求 `log[inheritedEventCount]` 是 tagged marker，且其后不得再出现 tagged marker；更早的祖先 marker 合法（`index.ts:681-688`；测试 `sequence-types.spec.ts:110-125`）。
- V4 恢复只比较“最后一个 tagged marker 的位置 === cut”，天然允许祖先 marker（`session-format-v3-to-v4/src/validation.ts:64-79`；测试 `session-format-v3-to-v4/tests/fork.spec.ts:79-82` 的 grandchild）。
- 若在父会话的**继承前缀内部**下 cut（`boundary < 父的 cut`），子会话复制到的只是更早的祖先事件，子 marker 落在新 cut；语义上父只是“谱系父”，内容来自祖先——这是精确 cut 的自然结果（由 `fork.ts:22` + `index.ts:1400-1433` 推导，无专门测试/笔记，标「未证实是否有意」）。

### 2.7 `session/end-seed` 的两种形态与作用

| 形态 | 产生者 | 位置 | 作用 |
|---|---|---|---|
| `{ inherited: true }`（tagged） | `buildForkSeed`（在 closers 之前），或 `Session` 构造在“只给了继承前缀”时补 | 恰好位于 `inheritedEventCount`（= 复制的源事件数）处 | fork cut 的**持久载体**；V4 解码据此恢复 `inheritedEventCount` |
| `{}`（无 tagged） | `Session` 构造函数在 restore/replay seed 后补（若 seed 非空且末尾不是 end-seed） | resume 生命周期起点（`firstLiveSeq`） | “本生命周期写入从这里开始”的持久边界，供 bracket owner 判断开放 marker 是否属于已结束生命周期 |

证据：`types.ts:404-428`（语义完整注释：last tagged marker 是当前 Session 的 cut；未 tagged 是 restore/replay 的生命周期边界；只有构造函数和 buildForkSeed 可创建）；`fork.ts:23-28`；`index.ts:681-698`；`docs/subsystems/session.md:737-743`；笔记 `2026-07-30-session-end-seed-log-boundary.md:18-24`。

补充细节：
- tagged marker 的 `time` = cut 事件时间；`seq` = `boundary+1`（`fork.ts:23-27`）。
- 构造器补齐的 marker 走普通 `append()`，所以 `time = Date.now()`、`seq = 当前 log 长度`（`index.ts:694-698`；`index.ts:817-823`）——与 `buildForkSeed` 的确定性规则不同（见 6 与未解问题 7）。
- 重新打开一个已经以任意 end-seed 结尾的 seed 不会再补普通 marker（`index.ts:696`；性质测试 `properties.spec.ts:126-136`）。
- 核心**不读** end-seed 判定 bracket（unmatched `compaction/start` 的判定在 compaction 包；core 只写边界），`docs/subsystems/session.md:743`；`packages/compaction/compaction-basic/src/region.ts:576`。
- 文档明确“只有构造器和 buildForkSeed 可以创建”，但 `Session.append` 并不拒绝其他写入者——若插件误写 tagged marker，会把它之前的事件都归类为 seed 历史（`packages/core/session/src/types.ts:417-419` 自述此风险）。

### 2.8 `inheritedEventCount` 与 `header.isSeeded` 的关系

不变量（`index.ts:666-698` 是唯一执法点）：

| 条件 | 规则 | 证据 |
|---|---|---|
| `header.isSeeded === true` | 必须显式给 `seed` | `index.ts:668-670`；测试 `sequence-types.spec.ts:137-145` |
| `header.isSeeded === true` | 必须显式给 `inheritedEventCount` | `index.ts:671-673`；测试 `sequence-types.spec.ts:127-135` |
| `isSeeded === false` | `inheritedEventCount` 必须为 0 | `index.ts:674-677`；测试 `sequence-types.spec.ts:147-151` |
| 任意 | `inheritedEventCount <= log.length` | `index.ts:678-680`；测试 `sequence-types.spec.ts:153-156` |
| snapshot 构造 + `isSeeded` | seed 必须**恰好等于**继承前缀，或 `log[inheritedEventCount]` 是 tagged marker | `index.ts:681-685`；测试 `sequence-types.spec.ts:158-165` |
| 任意 | `inheritedEventCount` 之后不得再有 tagged marker（必须是“最后一个”） | `index.ts:686-688`；测试 `sequence-types.spec.ts:122-124` |
| `isSeeded === true` + cut 0 | 合法（空 fork 子会话） | 由 rules 推导；`fork.spec.ts:62-76` 的空 fork 场景 |

- `isSeeded` 只是 lineage 位（header 里）；`inheritedEventCount` 是 body 侧精确数（`types.ts:95-132`；`session-persistence/index.ts:75-85`）。
- “显式传 cut，绝不从 `seed.length` 推断”：resume 时 seed 是**整份存储日志**，`seed.length` 不是 fork 边界；因此 `RestoredSessionOptions` 把 cut 与 header 并列（`types.ts:163-182`；笔记 `2026-06-22-fork-child-replay-seed-boundary.md:24-26`）。
- 同一个数值有“两种视角”：对 Session 是“prefix length / marker index”；对格式解码器是“最后一个 tagged marker 的 seq”。二者相等（`session-format-v1-to-v2/src/codec.ts:116-127`；V4 测试 `decoder.finish(output)` 返回 3，`session-format-v3-to-v4/tests/fork.spec.ts:72`）。

### 2.9 子会话 header 的字段来源

| 字段 | core `SessionStore.fork` | Host controller fork | subagent fork |
|---|---|---|---|
| `id` | 调用方给，或 store mint `session-<n>`（`SessionStore.create/prepare`，`index.ts:1144-1150`） | `session-${randomUUID()}`（`commands.ts:270`） | manager 指定 childId（`manager.ts:405-421`） |
| `parentSession` | 源 id（`index.ts:1394`） | 源 id（`commands.ts:282`） | `parentHeader.id`（`child-agent.ts:146`） |
| `cwd` | 源 header 有则继承（`index.ts:1393`） | 同（`commands.ts:281`） | 同（`child-agent.ts:143`） |
| `isSeeded` | 恒 `true`（`index.ts:1395`） | 恒 `true`（`commands.ts:283`） | `prepared.seed !== undefined`（`manager.ts:445`） |
| `origin` | **不写** | **不写** | `'subagent'`（`child-agent.ts:150`） |
| `delegationDepth` | **不写** | **不写** | `childDepth`（`child-agent.ts:152`） |
| `agentPreset` | **不写** | 从源 composition 解析后写（`commands.ts:273-287`） | 独立选择或继承父（`child-agent.ts:144-148`） |
| `createdAt` | `Date.now()`（`prepare` 默认，`index.ts:1177`） | 同 | 同 |

> 含义：core fork 刻意不复制 `agentPreset`（它不是 SessionStore 的职责）；Host 才补。`origin`/`delegationDepth` 是 subagent 语义，普通用户 fork 不应带 `origin:'subagent'`（否则产品导航会把子会话当子代理隐藏/归类，参考 `packages/subagent/subagent/src/archive-admission.ts:44-56`）。

### 2.10 生命周期 offset 与 own 判定

- `inheritedEventCount`：从父继承的事件数，**永久**保留（resume 后仍是 fork cut）（`index.ts:542-543`；笔记 `2026-07-30-session-end-seed-log-boundary.md:44`）。
- `firstLiveSeq`：构造输入 seed 的长度（无 seed 则为 0），**在构造器补 marker 之前**确定；不持久化。对经 `buildForkSeed` 的 fork 子会话 = 完整 seed（prefix+marker+closers）长度；对“只给继承前缀、由构造器补 tagged marker”的路径（如 subagent completed-prefix fork）= 前缀长度，marker 恰好落在 `firstLiveSeq` 处但不计入；对空 fork 子会话 = 0，尽管 marker 占用了 seq 0（注释明说 marker “occupies this seq without publishing”）（`index.ts:550-563, 666, 694-698`；测试 `sequence-types.spec.ts:118-121`）。
- `firstLifecycleSeq`：本对象生命周期第一个事件；fork snapshot = `inheritedEventCount`（因此包含 child 自有的 marker 与合成 closers）；restore = `firstLiveSeq`（完整存储前缀之后的新普通 marker）（`index.ts:565-570, 690`；笔记 `2026-08-18-arbitrary-seq-session-fork.md:36`）。
- `ownEvents()` / `isOwnSeq(seq)`：`seq >= inheritedEventCount && seq < this.seq`（`index.ts:742-754`；测试 `sequence-types.spec.ts:60-108`）。
- 子会话 `snapshotEvents()` 返回**完整 canonical 日志**（从 seq 0，含继承前缀、marker、closers），`eventAt` 同理；需要只看子自有事件用 `ownEvents()`（`index.ts:704-754`）。
- `dispose`：`Session` 本身**没有** `dispose` 方法；生命周期由 store 的 `enter()/detach` + `session/disposed` 事件管理（`index.ts:44-63, 1210-1256`）；`SessionPreparation` 只有 `[Symbol.dispose]` 用于释放未发布状态（`preparation.ts:43-48`）。

### 2.11 派生视图如何对待继承历史

- `deriveMessages()`：遍历 surface nodes（继承前缀内的 surfaceOp 已生效），因此 fork 在 replacement 之前 cut 会看到原消息、之后 cut 会看到压缩后的 surface（`index.ts:984-1005`；`fork.spec.ts:420-472`）。合成 tool/result 是 `surfaceOp:'append'`，会进入模型可见历史（`fork.spec.ts:340-349`）。
- `requestHeader()`：fold 全部 `request/header`（含继承），所以子会话继承父最后 header；第一次真实请求会因 header 已存在而以 `resume` 追加（`request-header.ts:58-69`；`index.ts:904-922`；`packages/core/agent-loop/src/agent.ts:639`；端到端测试 `agent-loop/tests/contract-regressions.spec.ts:603-666` 断言 `headerReasons=['resume']`、首个 live turn=3）。
- `toolHistory()`：从 seq 0 起 fold 全部事件（含继承），因此工具定义历史也随 fork 复制（`index.ts:943-957`）。
- 跨包消费者用 `inheritedEventCount` 区分 own/inherited，例如 subagent catalog 投影忽略 cut 之前的 `subagent/catalog`（笔记 `2026-09-01-parent-owned-subagent-catalog.md:27`）。

### 2.12 不变量清单

| # | 不变量 | 证据 |
|---|---|---|
| I1 | seed = `源[0..boundary]` 原序连续 seq，从 0 开始 | `fork.ts:22`；`index.ts:644-665`（构造器 `snapshot.seq===index` 校验） |
| I2 | seed = 继承前缀 + 恰好一个 child tagged marker + 0..n 个合成 closers | `fork.ts:23-29` |
| I3 | `inheritedEventCount` = 复制的前缀事件数 = marker index；不含 marker/closers | `fork.ts:16-20`；`index.ts:1391`；笔记 `2026-08-18-arbitrary-seq-session-fork.md:18` |
| I4 | `log[inheritedEventCount]` 是 tagged marker（fresh fork）；其后无 tagged marker | `index.ts:681-688` |
| I5 | 开放 turn 才有 closer：工具 result → step/end → turn/end | `repair.ts:88-97` |
| I6 | 已闭合 step/turn 零改动，含缺 result 的历史失败 | `fork.ts:11-15`；`fork.spec.ts:381-404` |
| I7 | 合成事件 seq 连续、time 取前缀最后事件、id 确定性 | `repair.ts:88-90, 159-193` |
| I8 | 源会话在 fork 前后 byte-identical（fork 不写源） | `index.ts:1380-1398`（只读 `snapshotEvents`）；`session-fork.host.spec.ts:526-543` |
| I9 | 子 seed 事件与源对象不共享引用（snapshot 时深拷贝冻结） | `index.ts:644-665`；`fork.spec.ts:85-93` |
| I10 | `isSeeded && cut` 必须自洽；空 fork 子会话（cut 0）合法 | `index.ts:666-698`；`fork.spec.ts:62-76` |
| I11 | 嵌套 fork 保留祖先 tagged marker，新 marker 必须是最后一个 | `index.ts:686`；`sequence-types.spec.ts:110-125` |
| I12 | 持久化种子是物理复制（子日志从 seq 0 起包含父前缀），无父引用 | `agent-loop/src/index.ts:734-744`；笔记 `2026-08-18-sqlite-physical-chunk-row-compression.md:72` |
| I13 | `forked` reason 只来自 fork seed，loop 不 live 发出 | `types.ts:223-229`；`consumed-work.ts:42-58`；`subagent/src/lifecycle.ts:153-158` |

---

## 3. 端到端算法（伪代码）

### 3.1 `SessionStore.fork(source, boundary?, childSessionId?)`

```text
fork(source, boundary?, childSessionId?):
  // 1) 子 id 冲突最先检查
  if childSessionId != null and store.has(childSessionId):
      throw SessionForkError("already exists", SESSION_ALREADY_EXISTS)

  // 2) 解析 live 源
  liveSource = resolveForkSource(source)      // id→store.get；Session→必须是 store 的 live 实例
      // SESSION_NOT_FOUND / SESSION_NOT_LIVE

  // 3) 取一个不可变快照（完整日志）
  events = liveSource.snapshotEvents()        // deprecated reader，冻结数组

  // 4) 解析并校验 boundary
  resolved = forkBoundary(liveSource.id, events, boundary)
      // undefined 仅当 boundary 省略且 events 为空
      // 显式 boundary：非负安全整数 → boundary < events.length → events[boundary].seq == boundary
      // 任一失败 → INVALID_BOUNDARY

  // 5) 构造 seed
  seed = resolved == null ? [] : buildForkSeed(events, resolved)

  // 6) 建 live 子会话
  return this.create(childSessionId, {
    seed,
    inheritedEventCount: resolved == null ? 0 : resolved + 1,
    meta: {  // cwd 仅当源 header 有
      cwd?, parentSession: liveSource.id, isSeeded: true,
    },
  })
  // create = prepare + effect(enter + announce)；session/created 同步抛错会回滚（detach）
```

证据：`index.ts:1380-1398, 1400-1433, 1435-1448, 1111-1122, 1210-1293`；`prepare` 的 header 合成 `index.ts:1143-1186`。

### 3.2 `buildForkSeed(events, boundary)`

```text
buildForkSeed(events, boundary):
  assert caller validated boundary exists & contiguous
  prefix = events.slice(0, boundary + 1)          // inclusive copy（保留源对象引用）
  prefix.push({
      type: 'session/end-seed',
      seq: SessionSeq(boundary + 1),
      time: events[boundary].time,                // cut 事件时间，非 Date.now
      data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
```

证据：`fork.ts:21-30`。

### 3.3 `openTurnClosers(events, cause)` / `ToolCallRecovery`

```text
openTurnClosers(events, cause):
  openTurn = null; openStep = null; recovery = ToolCallRecovery(cause)
  for e in events:
      recovery.observe(e)                         // 先消费，保证 last/ pending 同步
      if e.type == 'turn/start': openTurn = e.data.turn; openStep = null
      if e.type == 'turn/end':   openTurn = null;        openStep = null
      if e.type == 'step/start': openStep = e.data.step
      if e.type == 'step/end':   openStep = null
  last = events.at(-1)
  if openTurn == null or last == null: return []

  closers = recovery.results()                    // 未回答调用的错误 tool/result
  seq = last.seq + closers.length + 1
  time = last.time
  if openStep != null:
      closers.push(step/end{turn:openTurn, step:openStep, seq:seq++, time})
  closers.push(turn/end{turn:openTurn, reason:{kind:cause.kind}, seq:seq++, time})
  return closers

ToolCallRecovery.observe(e):
  last = {seq:e.seq, time:e.time}
  turn/start | turn/end | step/end → pending.clear()
  assistant/message → 对每个 tool-call block 记 pending[id]={turn,step}
  tool/call → pending[id].callSeq = e.seq
  tool/result(append, 同 turn/step) → pending.delete(callId)
  default → 不动 pending

ToolCallRecovery.results():
  if last == null: return []
  text = CLOSER_TEXT[cause.kind]                  // started / notStarted 两段固定文案
  for (id,{turn,step,callSeq}) in pending（插入序）:
      started = callSeq != null
      seq = last.seq + 1 + index
      message = {
        id: `${cause.kind}-tool-result-${id}-${seq}`,
        role:'tool', toolCallId:id, isError:true, source:{kind:'tool', callId:id},
        content:[{type:'text', text: started ? text.started : text.notStarted}],
      }
      event = {
        type:'tool/result', seq, time:last.time,
        data:{ turn, step, message,
               error: started
                 ? {name:'ToolOutcomeUnknownError', code:TOOL_OUTCOME_UNKNOWN}
                 : {name:'ToolNotStartedError',    code:TOOL_NOT_STARTED} },
        surfaceOp:'append',
        ...(started ? {sourceEventSeqs:[callSeq]} : {}),
      }
  return results
```

证据：`repair.ts:53-98, 105-197`；错误码常量 `repair.ts:14-18`；wording `repair.ts:31-41`；测试 `fork.spec.ts:284-404`、`repair.spec.ts:101-447`。

### 3.4 `Session` 构造期的 seed 校验与 marker 补齐

```text
constructor(id, seed?, header?, mode='snapshot', inheritedEventCount?, projections):
  log = []
  surface0 = new SurfaceManager(log, 0, projections)
  if seed != null:
      for (index, source) in seed.entries():
          snapshot = (mode=='snapshot') ? snapshotJsonValue(source) : source  // 深拷贝+校验 JSON
          assert envelope + seq === index                                // 连续从 0
          surfaceManager.validateNext(snapshot)                          // surface 转移合法
          log.push(snapshot)                                             // snapshot 模式 deepFreeze
  firstLiveSeq = log.length
  header = restoredHeader ?? snapshotSessionHeader(id, header)
  if header.isSeeded and seed == null:             throw "requires explicit constructor seed"
  if header.isSeeded and inheritedEventCount == null: throw "requires an inherited event count"
  cut = inheritedEventCount ?? 0
  if !header.isSeeded and cut != 0:                throw "unseeded ... must be 0"
  if cut > log.length:                             throw "exceeds its event log"

  markedSeed = log[cut]?.type=='session/end-seed' && log[cut].data.inherited===true
  if mode=='snapshot' and isSeeded and cut != log.length and !markedSeed:
      throw "constructor seed must equal its inherited prefix or mark its inherited cut"
  if markedSeed and log.slice(cut+1) 还有 tagged marker:
      throw "inherited event count must identify the final inherited marker"

  this.inheritedEventCount = cut
  this.firstLifecycleSeq = (mode=='snapshot' and isSeeded) ? cut : firstLiveSeq

  if seed != null and mode=='snapshot' and isSeeded and !markedSeed:
      append('session/end-seed', {inherited:true})        // 只给前缀时构造器补 tagged marker
  else if seed != null and !(mode=='snapshot' and isSeeded) and log.last?.type != 'session/end-seed':
      append('session/end-seed', {})                      // resume/replay 补普通生命周期边界
```

证据：`index.ts:626-699`；`snapshotSessionHeader` `index.ts:148-156`；测试覆盖 `sequence-types.spec.ts:110-179`、`session.spec.ts:132-173, 670-713`。

### 3.5 合成事件的确定性规则

| 属性 | 规则 | 证据 |
|---|---|---|
| `seq` | 紧接 seed 最后一个事件连续递增；tool results 在前，step/end 次之，turn/end 最后 | `repair.ts:88-97, 157-160` |
| `time` | 复用“前缀最后一个真实事件”的时间；buildForkSeed 路径因此 = cut 事件时间；绝不 `Date.now()` | `repair.ts:84-90`；`fork.ts:26` |
| tool result `message.id` | `${cause.kind}-tool-result-${callId}-${seq}`（确定性、按分支/位置稳定） | `repair.ts:169` |
| tool result `error.code` | 未记 `tool/call` → `TOOL_NOT_STARTED`；已记 → `TOOL_OUTCOME_UNKNOWN` | `repair.ts:184-190` |
| tool result 文案 | `CLOSER_TEXT[cause]` 按 started/notStarted 固定两段；`forked` 与 `interrupted` 不同 | `repair.ts:31-41` |
| `surfaceOp` | 合成 result 恒 `'append'`；只有记录过 `tool/call` 才带 `sourceEventSeqs:[callSeq]` | `repair.ts:191-192` |
| turn/end reason | `{kind: cause.kind}`，fork 路径恒 `{kind:'forked'}` | `repair.ts:96` |
| marker | `seq=boundary+1`、`time=cut.time`、`data:{inherited:true}` | `fork.ts:23-28` |

### 3.6 Host controller fork（live + cold 一条路径）

```text
SessionCommandController.fork(request):
  atSeq = request.atSeq==null ? undefined : SessionSeq(request.atSeq)   // 非法 → gateway/bad-request
  observed = await ctx.sessionQuery.observeSession(request.sessionId)
      // live 优先；否则 persistence.stat + readColdSessionLog（读 handle，内存补 interrupted closers，不写回）
      // 失败：SESSION_QUERY_SESSION_NOT_FOUND → session/not-found；其他 → gateway/internal
  using source = observed
  boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
  if boundary == null or source.events[boundary]?.seq != boundary:
      throw RemoteError('session/fork-unavailable', ...)
  seed = buildForkSeed(source.events, boundary)
  workspace = await forkWorkspace(source.header)                 // 失败 → gateway/internal
  composition = await agents.composeAgent(agents.presetForObservation(source))
  childId = `session-${randomUUID()}`
  await agents.create({
      sessionId: childId, seed,
      inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { cwd?, parentSession: source.header.id, isSeeded: true,
              agentPreset?: composition.agentPreset },
      agentOptions: { provider, model },                        // 默认模型，非源快照
      setup: composition.setup,
  })                                                             // 失败 → gateway/internal
  if workspace != null: await workspace.attachSession(childId)   // 失败 → session/workspace-attach-failed
  return { sessionId: childId }
```

关键点：
- 冷源不 resume 源 agent：`sessionQuery.observeSession` 的 cold 分支用 read handle 读完整日志，再用 `interruptedTurnClosers` 在**内存中**补齐崩溃尾部（`cold-read.ts:20-57`；`observation.ts:112-180`），不写回源（测试 `session-fork.host.spec.ts:561-600`）。
- `allowMigration === false` 且源冷、`stat().formatStatus === 'migration-required'` → `session/migration-required`（`index.ts:442-453`；测试 `session-fork.host.spec.ts:137-163`）。
- 冷源 fork 的默认 boundary 可能把**内存里补的 `interrupted` closers** 也算进前缀并物理复制进子会话（`commands.ts:251-261` + `cold-read.ts:55`）；这对子会话是“继承的已闭合 turn”，但其 reason 是 `interrupted` 而非 `forked`。是否有意、是否影响消费者语义：**未证实**（见未解问题 3）。

---

## 4. 事件与持久化格式

### 4.1 seed 前缀是物理复制，不是引用

- 内存层：`Session` 构造在 snapshot 模式下对每个 seed 事件做 `snapshotJsonValue` + `deepFreeze`，子日志与源对象不共享引用（`index.ts:644-665`；测试 `fork.spec.ts:85-93` 断言 `child.snapshotEvents()[1] !== source.snapshotEvents()[1]`，且改子不污染源）。
- 持久层：agent-loop 在**发布点**用 persistence handle 把 `snapshotEvents(storedCount)`（fresh create 时 `storedCount=0`）整段 append 进子会话自己的日志（`agent-loop/src/index.ts:715-724, 726-744`）。因此子会话 JSONL 的第一条事件就是父前缀的第一条。
- 设计上明确没有采用“父引用”：`.agents/notes/archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md:72` 记录 “Store forked history as a parent reference. Deferred... Copying remains the bounded local choice until the session service owns those rules.”
- 旧 replay 测试把这一事实写进断言：fork child 的 `.jsonl` “begins with the parent's events”（`.agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.md:12-14`）。
- 恢复/重放读取时，子会话读取器拿到的就是“完整逻辑日志”，用 `inheritedEventCount` 区分 own/inherited；截断到 cut 之前不会丢数据。

### 4.2 持久化写入时序（fresh fork child）

```text
agents.create({seed, inheritedEventCount, meta})
  → sessions.prepare(...)                       // 构造 Session（seed 已含 marker/closers）
  → persistence.create(header, { inheritedEventCount })   // 先建空 handle，登记 cut
  → [setup / 预发布期间的事件]
  → publication commit:
        sessions.enter + announce
        appendUnstoredSuffix(session) = handle.append(snapshotEvents(storedCount=0))
                                     = 完整构造日志（继承前缀 + tagged marker + closers）
  → 之后 live append 经 session/event 路由到 handle
```

证据：`agent-loop/src/index.ts:650-660, 696-744`；`session-persistence/src/index.ts:63-73, 145-152`；`session-persistence/src/handle.ts:63-117`；笔记 `2026-08-27-handle-based-session-persistence.md:15`（“agent-loop ... acquires the handle before publication (create for fresh sessions, appending any constructor seed through it)”）。
注意：`persistence.create` 时 handle 的 cut 来自 header 旁边的 `inheritedEventCount`；JSONL 实现把它传给 `toHeaderLine` 仅用于**校验** seeded/unseeded 一致性，不写数值（`session-persistence-jsonl/src/index.ts:363-378`；`format.ts:116-133`）。

### 4.3 reopen 如何识别 inherited cut

1. 打开时只读第一行 header：`fromHeaderLine` 把 `inheritedEventCount` **硬编码为 0**（`session-persistence-jsonl/src/format.ts:139-155`）；header 行不含数字 cut（`format.ts:78-83`；V2+ 编码器 `session-format-v1-to-v2/src/codec.ts:155-176` 只校验不写入）。
2. 扫描 body：解码器遇到 `session/end-seed` 且 `data.inherited === true` 时记下 `event.seq`，EOF 时作为 cut 返回；并强制：`isSeeded` 为真必须有该 marker，为假必须没有（`session-format-v1-to-v2/src/codec.ts:82-127`）。
3. `SessionLogScanner.finish()` 把 `artifact.inheritedEventCount` 变成 `SessionLogScan.inheritedEventCount`（`session-persistence-jsonl/src/format.ts:456-475`），JSONL `open()` 用它构造 handle 的 cut（`session-persistence-jsonl/src/index.ts:822-840` 等）。
4. Session 层重新校验：`Session.create/fromRestore` 要求 `log[cut]` 是 tagged marker、其后无 tagged marker、`isSeeded`/cut 自洽（`index.ts:666-698`）。query/projection 层则显式接收 cut（`session-query/src/observation.ts:240-320`；`session-query-sqlite/src/index.ts:783-791` 把 `isSeeded ? cut : null` 存索引）。
5. 迁移链中每一级都跟踪 cut：源 cut → 目标 cut，并校验流式 decoder 不改变预声明 cut（`session-format/src/chain.ts:92-122, 253-266`；`session-format-v2-to-v3/src/migration.ts:57-64, 84-92`；`session-format-v3-to-v4/src/migration.ts:74-80`）。

### 4.4 V4 恢复/迁移的专门校验

- `restoreReleasedV4Artifact`（`session-format-v3-to-v4/src/validation.ts:48-79`）：
  - header 必含 `version,id,createdAt,isSeeded,delegationDepth`，可选 `cwd,parentSession,origin,agentPreset`（`validation.ts:20-46`）；
  - `cut <= events.length`；unseeded ⇒ cut=0；
  - 扫描 body 得到 `lastInheritedMarker`；**seeded ⇒ 必须 === cut；unseeded ⇒ 必须不存在**；
  - 之后跑 relationship 校验（tool/turn/step 生命周期、compaction、surface replacement 等）。
- fork 合成结果在 V4 有专项校验：`assertV4ForkResult` 只针对“`TOOL_NOT_STARTED` + id 以 `forked-tool-result-` 开头”的结果，校验 id 前缀/序号与 `seq` 一致（replacement 形式则保留原 seq/identity）、错误名 `ToolNotStartedError`、`surfaceOp:'append'` 且无 `sourceEventSeqs`、tool 角色与 callId 一致等（`session-format-v3-to-v4/src/fork-result.ts:10-39`）。
- relationship 校验把 fork 的 not-started result 作为未开始调用的合法收尾：`notStartedRepair` 识别 `forked-tool-result-${callId}-` 前缀（`packages/session/session-format-v3-to-v4/src/relationships.ts:148-182, 332-360`）。已 started（有 `tool/call`）的调用则正常被 result 关闭。
- V3→V4 迁移保留原有事件与 cut，并承认 `forked` reason（`docs/persistence-changes/2026-09-16-session-format-v4.md:94`；`session-format-v3-to-v4/src/migration.ts:74-80`）。V4 测试 pin 了“原始 id/文案保留、嵌套 cut 通过恢复、畸形结果拒绝”（`session-format-v3-to-v4/tests/fork.spec.ts:46-152`）。

### 4.5 `turn/end.reason: 'forked'` vs `'completed'`

- `forked`：**只由 fork seed 构造产生**，表示“父会话在 cut 处 turn 仍未闭合，子会话把它强制闭合”；父事件原样保留在子前缀中。loop 从不 live 发出（`types.ts:223-229`；`docs/subsystems/session.md:720-729`；`consumed-work.ts:52-58` 的 v8 ignore 注释明说“`forked` exists only in constructor seed history”）。
- `completed`：正常闭合，含义是“该 turn 正常结束”。
- 消费者差异举例：
  - workflow-run 把 `interrupted`/`forked` 都视为不可用（`packages/client/ui-workflow-run/src/client/workflow-definition.ts:91-92`）；
  - subagent 投影 `lastTurnCompleted = reason.kind === 'completed'`，所以 fork closure ⇒ false（`packages/subagent/subagent/src/projection.ts:100`）；
  - `foldConsumedWork` 把未知/`forked` 默认按“输入已被 accounted”处理（`consumed-work.ts:42-58`）；
  - session-query 检索文本不给 forked 产词（switch 落到 default），`packages/session-query/session-query/src/extraction.ts:43-59`；
  - `epochStopReason` 对 `forked` 走 default → `'error'`，但注释说明它只读 epoch-owned suffix，不会真的遇到（`packages/subagent/subagent/src/lifecycle.ts:153-158`）。
- 跨包效果：子会话的 turn 编号从 `turn/end` 之后继续，因此 mid-turn fork 后第一个 live turn 是 3（父 1、forked 2），第一个请求 header reason 是 `resume`（端到端测试 `agent-loop/tests/contract-regressions.spec.ts:603-666`）。

### 4.6 历史读取的校验链（读到 fork 历史时）

1. **格式读取**：拒绝未来版本；未知 required 事件类型 fail-closed；V4 行级 admission（`storage-contract.ts:74-117`；`session-format-v3-to-v4/src/codec.ts:52-82`；`docs/architecture.md:122`）。
2. **cut 校验**：见 4.3/4.4。
3. **Session 重建**：`Session.create/fromRestore` 校验连续 seq、surface 转移、消息形状、header 标量、marker 位置（`index.ts:626-698`；`session-query/src/index.ts:186-198` 的 `readSession()` 显式用 `Session.create` 做 replay 校验）。
4. **只读观察**：cold 读不写回，崩溃尾部用 `interruptedTurnClosers` 在内存补齐（`cold-read.ts:20-57`；`observation.ts:112-180`）。
5. **派生**：`deriveMessages/requestHeader/toolHistory` 都是“fold 全日志”，所以 fork 前缀与子自有事件被同等解释（`index.ts:904-1005`）。
6. **持久化端到端**：forked 结果经 encode→decode→restore 后原 id/文案不变（`session-format-v3-to-v4/tests/fork.spec.ts:60-83`）；真实 agent 的 fork 请求工具配对合法（`agent-loop/tests/contract-regressions.spec.ts:673-760`）。

---

## 5. 边界与失败模式

### 5.1 `SessionForkError` 四种 code

`SessionForkError` 定义在 `index.ts:1034-1040`；code 语义文档在 `index.ts:1021-1032`。

| code | 触发条件 | 证据 |
|---|---|---|
| `SESSION_ALREADY_EXISTS` | 显式 `childSessionId` 且该 id **当前 live**；该检查在 source 解析和 boundary 校验之前 | `index.ts:1381-1383`；测试 `fork.spec.ts:236-254`（第二个测试证明“重复子 id 先于 boundary 校验”） |
| `SESSION_NOT_FOUND` | (a) `source` 是 id 字符串且 store 无此 live 会话；(b) `source` 是 `Session` 对象但其 id 不在 store（例如 detached `Session.create(...)`） | `index.ts:1436-1445`；测试 `fork.spec.ts:212-225` |
| `SESSION_NOT_LIVE` | `source` 是 `Session` 对象，store 中同 id 存在但**不是同一个实例**（stale object） | `index.ts:1442-1446`；测试 `fork.spec.ts:227-234` |
| `INVALID_BOUNDARY` | 显式 boundary：非非负安全整数（负数/小数/>MAX_SAFE/`-0` 视构造方式）；`boundary >= events.length`（含空源显式 0）；`events[boundary].seq !== boundary`（数组索引与 seq 不一致的损坏日志） | `index.ts:1411-1431`；测试 `fork.spec.ts:181-210` |

> 错误消息会区分“越界（last seq: none/X）”和“seq 不一致（not contiguous）”，方便诊断（`index.ts:1417-1431`）。

### 5.2 非 `SessionForkError` 失败（会被上层统一映射）

- **seed 校验失败**：`buildForkSeed` 只切片，不做深校验；`Session.create` 会对复制前缀做 seq 连续性、envelope、surface 转移、消息形状校验（`index.ts:644-665`）。若源日志在 boundary 之前损坏（如中途某事件 seq 错位），这里抛普通 `Error`（`seed event at index N has seq ... / must be contiguous from 0`），**不会**转成 `SessionForkError`。core 的 `INVALID_BOUNDARY` 只覆盖 boundary 那一个位置（`_forkBoundary` 只比较 `events[boundary]`，`index.ts:1425-1431`）。
- **发布 veto / 建会话失败**：`SessionStore.fork` 内部 `create()` 会 `enter()` + `announce()`；若 `session/created` 监听器同步抛错，会回滚 detach 并向上抛普通错误（`index.ts:1111-1122, 1265-1293`）。
- **空源 + 省略 boundary**：不是失败，得到“isSeeded=true、inheritedEventCount=0、日志仅一条 child tagged marker”的子会话（`fork.ts:21-29` + `index.ts:694-698`；测试 `fork.spec.ts:62-76`）。
- **子 id 与“磁盘上已存在但非 live”的会话重名**：core 的检查只看 live store（`index.ts:1381`）；若该 id 已在磁盘但冷，core fork 仍会成功建一个 live 子会话（不持久化所以不冲突）；Host 路径因 childId 是随机 UUID 不受影响（`commands.ts:270`）。若后续用同一 id 发布持久化会话，重复由 persistence `SessionAlreadyExistsError` 处理（`session-persistence/src/index.ts:145-152`）。

### 5.3 Host/controller 错误码

| code | 触发 | 证据 |
|---|---|---|
| `gateway/bad-request` | `atSeq` 不是非负安全整数（`SessionSeq()` throw） | `commands.ts:228-233`；测试 `session-fork.host.spec.ts:497-508` |
| `session/not-found` | `observeSession` 抛 `SESSION_QUERY_SESSION_NOT_FOUND` | `commands.ts:237-244`；测试 `commands-create-fork.host.spec.ts:185-208` |
| `gateway/internal` | 观察失败/`forkWorkspace` 失败/`agents.create` 失败 | `commands.ts:245-249, 262-270, 288-295`；测试 `commands-create-fork.host.spec.ts:209-254` |
| `session/fork-unavailable` | 省略 `atSeq` 时没有 completed turn；或显式 seq 不存在/不连续 | `commands.ts:251-260`；测试 `commands-create-fork.host.spec.ts:219-231`、`session-fork.host.spec.ts:464-496` |
| `session/migration-required` | `allowMigration===false` + 冷源 + `formatStatus==='migration-required'` | `session-controller/src/index.ts:442-453`；测试 `session-fork.host.spec.ts:137-163` |
| `session/workspace-attach-failed` | 子会话已创建但 workspace 挂载失败（错误里带 childId，客户端可 reconcile） | `commands.ts:298-310`；测试 `commands-create-fork.host.spec.ts:255-276` |

### 5.4 并发/时序边界

- 源在 fork 期间可以继续 append：`snapshotEvents()` 返回的是调用时刻的冻结快照数组，boundary 针对该快照校验；子会话不会看到 boundary 之后的源事件（`index.ts:1386-1388`；`snapshotEvents` 缓存语义 `index.ts:725-734`）。
- `SessionStore.fork` 不是跨进程/并发事务：live store 单线程内同步完成“解析源→校验→建子”；`session/created` 监听器可 veto（见 5.2）。
- Host 侧用 `using source = observed` 持有 observation lease 到 create 完成（`commands.ts:250`），cold 源在 fork 期间不会被缓存淘汰/改写（observation lease pin 语义 `observation.ts:44-80, 240-280`）。

### 5.5 不能/不建议 fork 的情形（由当前实现决定）

1. **冷会话**：core 不能（`SESSION_NOT_FOUND`），Host 能（observeSession）。若既没有 sessionQuery 也没有 persistence，Host 返回 `session/not-found`（`commands-create-fork.host.spec.ts:185-208`）。
2. **尚无 completed turn 且未给 atSeq**：Host 拒绝（`session/fork-unavailable`）；core 则允许（默认最后一个事件，哪怕没有 turn/end；空源则空子会话）。
3. **源是 pending/queued input 状态**：core 不知道 inbox；默认 boundary=最后事件可能把 `agent/inbox/spliced` 等事件带进子会话。Host 的默认边界会避开 queued user input（`commands.ts:80-90`）；显式 atSeq 则完全按用户指定（可能切在输入中间，由 forked closers 使子历史合法）。
4. **迁移未完成的冷源 + 客户端禁止迁移**：Host 拒绝（`session/migration-required`）。

---

## 6. 测试覆盖

| 文件 | 覆盖点（与 fork 语义相关） |
|---|---|
| `packages/core/session/tests/fork.spec.ts:61-254` | 空源 fork（62-76）；默认 boundary=最后事件（78-101）；closed turn 后的 log-only 事件（103-116）；源有开放尾时从更早 boundary fork（118-136）；所有 `turn/end.reason` 都可作为 boundary（138-158）；继承开放 bracket 被 marker 标记（160-179）；四类错误码（181-254） |
| `packages/core/session/tests/fork.spec.ts:257-418` | 开放 turn 的空 closer（284-300）；闭合 step 只补 turn/end（302-322）；not-started 错误 result（324-350）；unknown-outcome + sourceEventSeqs（352-366）；assistant/attempt 不进历史（368-379）；**已闭合 step 的 dangling call 保留**（381-404）；插件 bracket 不闭合（406-417） |
| `packages/core/session/tests/fork.spec.ts:420-472` | surface replacement 之前/之后 cut 的派生历史正确 |
| `packages/core/session/tests/repair.spec.ts:101-447` | 两种 cause 参数化覆盖 closers 的所有分支（balanced/empty/open turn/open step/multiple calls/已闭合 step 不补/多调用顺序/surfaceOp+sourceEventSeqs）；`forked` 与 `interrupted` 文案差异；错误码共享；`interruptedTurnClosers` 只暴露 interrupted cause |
| `packages/core/session/tests/sequence-types.spec.ts:60-179` | `isSeeded` 与 cut 分离（无 `seedLength`）；`ownEvents/isOwnSeq`；构造器补 tagged marker；**child closers 位于 marker 之后 + 拒绝更晚的 tagged marker**（110-125）；seeded 必须有 seed/cut、unseeded cut=0、cut 必须与前缀一致（127-166）；cut 参数校验（168-179） |
| `packages/core/session/tests/session.spec.ts:132-173, 670-713` | replay 在 seed 后恰好补一个 marker；空 seed vs fresh；seed 连续性/JSON/surface 校验 |
| `packages/core/session/tests/properties.spec.ts:111-136` | replay 幂等：seed 逐字节复现 + 恰好一个边界；已以 end-seed 结尾不再补 |
| `packages/core/agent-loop/tests/contract-regressions.spec.ts:603-666` | 真实 agent 消费 mid-turn fork seed：首个 live turn=3、首个 header reason=`resume`、能继续产出 |
| `packages/core/agent-loop/tests/contract-regressions.spec.ts:673-760` | 在 assistant-message/tool-call/tool-result/step-end 各处 cut 的矩阵：补几条 result、哪些 step/end、子请求工具配对完整、不重复执行父工具、源不被修改 |
| `packages/api/session-controller/tests/session-fork.host.spec.ts:98-136` | 冷源 fork（allowMigration × formatStatus 组合），源保持非 live，child cut 正确 |
| `packages/api/session-controller/tests/session-fork.host.spec.ts:497-600` | 非法 atSeq；cut 在 aborted turn/end 之前；live open turn 内精确 cut（含 marker 位置断言）；显式 boundary 不吞 standalone tail；冷 open-step cut 的工具配平 |
| `packages/api/session-controller/tests/commands-create-fork.host.spec.ts:184-295` | Host 错误码映射；无 completed turn；preset 带入子 meta；缺省 cwd/preset 不写 |
| `packages/session/session-format-v3-to-v4/tests/fork.spec.ts:46-152` | V4 fork 结果持久化后原 id/文案保留；解码返回正确 cut=3；嵌套 grandchild 恢复通过；replacement/prune 后身份保留；6 类畸形结果被拒 |
| 其他 | `docs/persistence-changes/2026-09-16-session-format-v4.md:109` 记录 “V4 fork tests ... validate nested inherited cuts”；`docs/subsystems/agent-team.md:125` 证明 fork 继承事件不会污染新 root 的 team 投影 |

**覆盖缺口（观察）**：
- core `SessionStore.fork` 对“父本身是 fork 的子会话”没有直接测试（现有 `fork.spec.ts` 的源都是 `ctx.sessions.create` 的 fresh 会话）；嵌套语义由 `sequence-types.spec.ts:110-125`（marker 规则）和 V4 `fork.spec.ts:79-82`（手工 `buildForkSeed` grandchild）间接覆盖。
- `origin/delegationDepth` 在“普通用户 fork 子会话”上的缺省行为没有专门断言。
- 冷源 fork 时内存 `interrupted` closers 被复制进子会话的行为没有专门测试/设计说明。

---

## 7. 设计理由与权衡（从设计笔记提炼）

1. **fork 就是“用既有日志 seed 一个新 session”，不引入独立服务。** event-sourcing 笔记定义 “Replay/fork = seed a new session with an existing log”（`.agents/notes/implemented/architecture/2026-06-11-event-sourced-sessions.md:13`）。后续 fork API 笔记明确否决 `ctx.sessionFork` 服务与 `snapshot()+fork()` 两段式：没有独立 backend/事件词汇/生命周期/persistence 行为，只是 store 策略（`.agents/notes/archived/feature/2026-06-30-session-store-fork-api.md:16, 40-43`）。
2. **`session/end-seed` 的位置选择在 `Session` 构造函数**，因为它是所有 seeded 会话的唯一必经点（六条入口：resume、配置启动、`sessions.fork()`、subagent fork、`coordinator.adopt()` live-prefix、裸 `sessions.create({seed})`）；写在 persistence cold-load 会漏掉 fork 路径，写在 loop start 会漏掉 `fork()/adopt()` 且会把 `SessionStartSource:'startup'` 变成无区分度（`.agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.md:22, 40-42`）。
3. **为什么需要 end-seed 边界**：seed 历史与 live 工作在字节上不可区分，插件（如 compaction 的 `compaction/start…end`）无法区分“上次写者崩溃留下 unmatched start”与“现在正在 compaction”；core 不应把插件 bracket 语义塞进崩溃修复（`.agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.md:10-14, 18-20, 46`）。
4. **为什么不复用 `inheritedEventCount` 做生命周期边界**：它是 fork 谱系 cut，resume 后会保持原 fork 值，而 resume 的构造 seed 是整份存储日志；两个事实不同，混用会同时丢失两者（`.agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.md:44`）。
5. **精确 cut 而非“裁剪到最近完成回合”**：早期策略只允许 completed-turn 边界且 Host 有 anchor 语义；后来的决定是接受任意既有 seq、用共享的 crash-repair 工具配平算法闭合开放尾部，原因是要支持“tool result 到达之前的历史位置”，且裁剪会静默丢失用户请求的上下文（`.agents/notes/archived/feature/2026-08-18-arbitrary-seq-session-fork.md:10-22, 24-32`；旧策略见 `2026-06-30-session-store-fork-api.md:12, 34, 44`）。
6. **fork 与崩溃修复共享算法但有独立 cause**：复用 crash wording 会让子会话误以为父会话被中断；`forked` 文案明确“父会话可能在 fork 点之后执行过该调用”，重试建议区分只读/幂等与有副作用（`2026-08-18-arbitrary-seq-session-fork.md:10, 16`）。
7. **closed step/turn 不修复**：把 fork 变成“历史修复策略”会与 crash recovery 语义分叉；封闭 step 里的失败调用属于父会话历史事实（`2026-08-18-arbitrary-seq-session-fork.md:16, 30`）。
8. **`isSeeded` 留在 header、精确 cut 随 body**：header-only reader（列表/统计）只需要“是否有谱系”这个布尔位；数值 cut 是 body 坐标，header 不该混入 v0 存储坐标（`.agents/notes/archived/architecture/2026-08-31-session-sequence-and-log-offset-brands.md:12, 20, 36-37`；`packages/core/session/src/types.ts:109-113`）。从 marker 反推 cut 被否决过一次（作为 in-process 的派生方式），但**物理格式**仍把 marker 作为唯一持久载体（见 4.3；投影缓存笔记确认 `fromHeaderLine` 硬编码 0，header-only 读拿不到 cut：`.agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md:15-17`）。
9. **cut 必须显式传，绝不从 seed.length 推断**：resume 时 seed=整份日志，推断会错；显式 > 隐式在包边界上的应用（`.agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.md:24-26, 40`）。
10. **物理复制而非父引用**：父引用需要显式的 parent retention/deletion/repair/export 与跨 backend 语义，当前 session service 不拥有这些规则；复制是当前有界选择（`.agents/notes/archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md:72`）。
11. **持久化只由 agent-loop 发布点拥有**：handle 在发布前 acquire、seed 通过 handle 落盘、resume 的 crash repair 也走同一 handle；因此 fork 子会话只有在 agent-loop 发布时才持久化（`docs/architecture.md:161`；`.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md:15-17`）。
12. **Host 默认“最新完成回合”是产品策略**：Session 行菜单要“从最近完成回合分支”，消息按钮要“从包含该消息的回合分支”；两者统一走同一 Host 操作，显式传入精确 event seq（`.agents/notes/archived/feature/2026-07-27-web-session-fork-actions.md:16, 34`）。
13. **fork 继承的是“已发生的历史”，不是权限/预设快照**：`agentPreset` 由 Host 按当前 composition 重新写入（`packages/api/session-controller/src/commands.ts:273-287`；测试 `packages/api/session-controller/tests/commands-create-fork.host.spec.ts:277-295`），因为 preset 决定工具与 prompt，恢复错误的组合会让模型无法行动（`packages/core/session/src/types.ts:125-131` 的 header 字段理由）。
14. **fork 子是否可继续（one-shot/continuable）不是 core 语义**：subagent fork 的 one-shot 限制是工具 schema 差异导致的组合层决定，而不是 fork 前缀的性质（`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md:11, 17, 25`）。

---

## 8. file:line 证据表

> 路径根 = `deepseek-harness/`。表中省略该前缀。

### 8.1 core 实现

| # | 结论 | 证据 |
|---|---|---|
| 1 | seed 构造 = inclusive prefix + tagged marker + forked closers；marker seq/time 规则；marker 在 closers 之前 | `packages/core/session/src/fork.ts:11-30` |
| 2 | forked/interrupted 共用 `OpenTurnCloseCause`；`forked` 专属文案；两个错误码 | `packages/core/session/src/repair.ts:14-41` |
| 3 | `openTurnClosers` 扫描/只关闭开放尾部/seq+time 规则 | `packages/core/session/src/repair.ts:43-98` |
| 4 | `ToolCallRecovery.observe` pending 生命周期（turn/start、turn/end、step/end 清空） | `packages/core/session/src/repair.ts:100-149` |
| 5 | 合成 result 的 id/code/surfaceOp/sourceEventSeqs 规则 | `packages/core/session/src/repair.ts:151-197` |
| 6 | crash 修复的公开入口只暴露 interrupted cause | `packages/core/session/src/repair.ts:200-211` |
| 7 | `SessionSeq` vs `SessionLogOffset` 定义 | `packages/core/session/src/types.ts:32-66` |
| 8 | `SESSION_FORMAT_VERSION=4`；header 字段（isSeeded/parentSession/origin/delegationDepth/agentPreset） | `packages/core/session/src/types.ts:67-132` |
| 9 | `CreateSessionOptions`（seed / inheritedEventCount / meta）；fresh 创建要求；`RestoredSessionOptions` | `packages/core/session/src/types.ts:134-187` |
| 10 | `TurnEndReasonMap` 的 interrupted/forked 语义 | `packages/core/session/src/types.ts:196-233` |
| 11 | `session/end-seed` 的完整语义注释（marker 位置/嵌套/只有两处可创建/bracket 用途） | `packages/core/session/src/types.ts:404-428` |
| 12 | `Session.create/fromRestore` 入口；构造器 seed 校验、marker 规则、firstLiveSeq/firstLifecycleSeq | `packages/core/session/src/index.ts:522-699` |
| 13 | `snapshotEvents/ownEvents/isOwnSeq/seq` | `packages/core/session/src/index.ts:701-759` |
| 14 | `append` 的 seq/time/JSON 快照/深冻结 | `packages/core/session/src/index.ts:761-827` |
| 15 | `requestHeader/toolHistory/deriveMessages` 的 fold 语义 | `packages/core/session/src/index.ts:899-1005, 943-957` |
| 16 | `SessionForkSource` / `SessionForkErrorCode` / `SessionForkError` | `packages/core/session/src/index.ts:1018-1040` |
| 17 | `SessionStore.create` 生命周期（effect + enter + announce + rollback） | `packages/core/session/src/index.ts:1090-1122` |
| 18 | `prepare` 的 header 合成（version/id/createdAt/cwd/lineage/cut 旁置） | `packages/core/session/src/index.ts:1124-1186` |
| 19 | `enter/announce/detach/disposed/flush/liveEntryFor` | `packages/core/session/src/index.ts:1188-1362` |
| 20 | `SessionStore.fork` 全流程（子 id 检查 → live 源 → snapshot → boundary → seed → meta → create） | `packages/core/session/src/index.ts:1364-1398` |
| 21 | `_forkBoundary` 三类校验与错误消息 | `packages/core/session/src/index.ts:1400-1433` |
| 22 | `_resolveForkSource` 的 NOT_FOUND/NOT_LIVE | `packages/core/session/src/index.ts:1435-1448` |
| 23 | `SessionPreparation` 的 Symbol.dispose | `packages/core/session/src/preparation.ts:20-48` |
| 24 | `requestHeader` fold 实现 | `packages/core/session/src/request-header.ts:58-69` |
| 25 | event 词汇包含 `session/end-seed` | `packages/core/session/src/known-event-types.ts:22-82`（`session/end-seed` 在 57 行） |

### 8.2 持久化 / 格式

| # | 结论 | 证据 |
|---|---|---|
| 26 | persistence 服务 create/open/stat/list 与 cut 旁置契约 | `packages/session/session-persistence/src/index.ts:46-91, 117-204` |
| 27 | handle 的 cut 字段与 read/append/flush/close 契约 | `packages/session/session-persistence/src/handle.ts:59-117` |
| 28 | storage-contract 的版本/词汇/连续性校验 | `packages/session/session-persistence/src/storage-contract.ts:44-151` |
| 29 | agent-loop 发布前 create handle、发布时把构造 seed 全部落盘 | `packages/core/agent-loop/src/index.ts:705-744` |
| 30 | resume 读整份日志 + interrupted closers + cut 来自 handle | `packages/core/agent-loop/src/index.ts:852-900` |
| 31 | JSONL：物理 header 不含数值 cut；fromHeaderLine 硬编码 0 | `packages/session/session-persistence-jsonl/src/format.ts:78-83, 108-155` |
| 32 | JSONL：decoder 从最后一个 tagged marker 推导 cut，并校验 isSeeded 一致性 | `packages/session/session-format-v1-to-v2/src/codec.ts:78-127` |
| 33 | JSONL：scan finish 返回 artifact cut | `packages/session/session-persistence-jsonl/src/format.ts:458-475` |
| 34 | JSONL：create 时把 header+cut 交给 encoder；open 时回到 handle | `packages/session/session-persistence-jsonl/src/index.ts:360-380, 820-845` |
| 35 | V4 header 校验 + 最后 marker === cut 的一致性 | `packages/session/session-format-v3-to-v4/src/validation.ts:16-79` |
| 36 | V4 relationship：tool 生命周期、turn/end 前必须无 open step/tool；fork not-started 识别 | `packages/session/session-format-v3-to-v4/src/relationships.ts:148-182, 332-360` |
| 37 | V4 fork 结果专项校验 | `packages/session/session-format-v3-to-v4/src/fork-result.ts:1-39` |
| 38 | V3→V4 迁移保留 cut、识别 tagged marker | `packages/session/session-format-v3-to-v4/src/migration.ts:55-100` |
| 39 | V2→V3 迁移保留 source/target cut | `packages/session/session-format-v2-to-v3/src/migration.ts:48-92` |
| 40 | 格式链传递/校验 cut | `packages/session/session-format/src/chain.ts:92-122, 253-266` |
| 41 | 只读冷读在内存补齐 interrupted 尾部 | `packages/session-query/session-query/src/cold-read.ts:20-57` |
| 42 | observeSession live/prepared 两条路径与 lease | `packages/session-query/session-query/src/observation.ts:100-200, 240-320` |
| 43 | query sqlite 索引存 cut（isSeeded ? cut : null） | `packages/session-query/session-query-sqlite/src/index.ts:783-791` |

### 8.3 Host controller / 文档 / 笔记

| # | 结论 | 证据 |
|---|---|---|
| 44 | Remote fork + 迁移预检 | `packages/api/session-controller/src/index.ts:430-454` |
| 45 | Host “最新完成回合前缀”规则 | `packages/api/session-controller/src/commands.ts:78-90` |
| 46 | Host fork 全流程（observeSession → boundary → buildForkSeed → compose preset → agents.create → workspace attach） | `packages/api/session-controller/src/commands.ts:227-311` |
| 47 | fork 请求/响应 wire 类型（atSeq/allowMigration） | `packages/api/session-controller/src/types.ts:329-342` |
| 48 | only agent-loop-published sessions persist；fork 种子通过 handle 落盘 | `docs/architecture.md:161`；`docs/subsystems/persistence.md:226` |
| 49 | “Fork, resume, transcripts, telemetry, persistence 都从 durable settlements 派生” | `docs/architecture.md:120, 122` |
| 50 | fork API 文档（**注意：681/683 已与实现不一致**） | `docs/subsystems/session.md:677-683` |
| 51 | forked reason 文档；loop 不 live 发出 | `docs/subsystems/session.md:716-729` |
| 52 | end-seed 文档（buildForkSeed 位置、last tagged marker 即 cut、两种形态） | `docs/subsystems/session.md:737-743` |
| 53 | V4 文档：迁移保留 cut、fork 结果校验、嵌套 cut | `docs/persistence-changes/2026-09-16-session-format-v4.md:12, 90, 94, 109` |
| 54 | end-seed 决策/备选方案/代价 | `.agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.md:8-56` |
| 55 | fork child 日志以父事件开头；explicit cut；JSONL 载体；replay 截取 | `.agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.md:8-45` |
| 56 | SessionSeq/SessionLogOffset 分离；header 只留 isSeeded；不从 marker 推导 in-process cut | `.agents/notes/archived/architecture/2026-08-31-session-sequence-and-log-offset-brands.md:8-42` |
| 57 | handle 模式：agent 生命周期拥有 handle、seed 发布前落盘、crash repair 在 agent 层 | `.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md:11-19` |
| 58 | 任意 seq fork + 共享修复 + forked 文案 + 嵌套 marker + controller 默认策略 | `.agents/notes/archived/feature/2026-08-18-arbitrary-seq-session-fork.md:8-36` |
| 59 | fork API 决策（无独立服务、boundary 语义、Host 适配、备选方案） | `.agents/notes/archived/feature/2026-06-30-session-store-fork-api.md:8-50` |
| 60 | event-sourced 基础模型：log 即状态，replay/fork = seed | `.agents/notes/implemented/architecture/2026-06-11-event-sourced-sessions.md:11-27` |
| 61 | 物理 header 自 v2 起不存 seedLength；reader 从 tagged marker 推导 cut；header-only 读拿不到 cut | `.agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md:13-17` |
| 62 | 父引用方案 deferred，复制是当前选择 | `.agents/notes/archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md:72` |
| 63 | Web fork 动作：Session 行=最新完成回合、消息=精确 atSeq | `.agents/notes/archived/feature/2026-07-27-web-session-fork-actions.md:12-16, 34` |
| 64 | forked child one-shot 是组合层历史限制，非 fork 语义 | `.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md:9-25` |
| 65 | subagent fork 的 header（origin/depth/preset）与 completed-prefix 裁剪 | `packages/subagent/subagent/src/child-agent.ts:120-157`；`packages/subagent/subagent/src/manager.ts:417-448`；`packages/subagent/subagent-fork-in-process/src/index.ts:35-78` |

### 8.4 测试证据

| # | 覆盖 | 证据 |
|---|---|---|
| 66 | core fork 语义全集（含四类错误、开放尾、replacement） | `packages/core/session/tests/fork.spec.ts:61-472` |
| 67 | repair 分支全集（两种 cause） | `packages/core/session/tests/repair.spec.ts:101-447` |
| 68 | 构造器 cut/marker/嵌套规则 | `packages/core/session/tests/sequence-types.spec.ts:60-179` |
| 69 | replay marker / 空 seed | `packages/core/session/tests/session.spec.ts:132-173` |
| 70 | replay 幂等性质 | `packages/core/session/tests/properties.spec.ts:111-136` |
| 71 | 真实 agent 消费 mid-turn fork + 工具配对矩阵 | `packages/core/agent-loop/tests/contract-regressions.spec.ts:603-760` |
| 72 | Host 冷 fork、错误码、preset、workspace 失败 | `packages/api/session-controller/tests/session-fork.host.spec.ts:98-600`；`packages/api/session-controller/tests/commands-create-fork.host.spec.ts:184-295` |
| 73 | V4 fork 结果 round-trip/嵌套/畸形拒绝 | `packages/session/session-format-v3-to-v4/tests/fork.spec.ts:46-152` |

---

## 9. 未解问题与文档不一致

1. **文档漂移 A**：`docs/subsystems/session.md:681,683` 仍写 `fork` “requires the selected prefix to end outside an open turn … rejects a prefix that ends inside an open turn instead of clipping silently”。这与 0.2.1-rc.2 实现（任意 seq cut + `forked` closers）以及同一文件 737-743 的 end-seed 描述矛盾；实现与 `.agents/notes/archived/feature/2026-08-18-arbitrary-seq-session-fork.md` 笔记为准。写最终方案时应按实现描述，不要引用 681/683。
2. **文档漂移 B**：`docs/architecture.md:161` 仍用已删除的 `seedLength` 字段（`SessionHeader` 现在拒绝 `seedLength`，`packages/core/session/src/index.ts:97-100`；`types.ts:95-132`），且示例缺 `inheritedEventCount`。选型文档中应改为 `ctx.agents.create({sessionId, seed, inheritedEventCount, meta:{parentSession,isSeeded}})`。
3. **冷源 fork 的 interrupted closers 被复制进子会话**：`observeSession` 的 cold 路径在内存补 `interruptedTurnClosers`（`packages/session-query/session-query/src/cold-read.ts:55`），Host 随后把它们当作普通源事件复制进子 seed（`packages/api/session-controller/src/commands.ts:251-261`）。因此子会话可能继承一条 `turn/end {kind:'interrupted'}`，其语义归属是“父的崩溃修复”，而非“fork 闭合”。没有找到设计说明；是否有意、是否影响 UI/统计/投影：**未证实**。
4. **restore 模式对 marker 的强制弱于 snapshot 模式**：`packages/core/session/src/index.ts:683` 的 “seed 必须等于继承前缀或标记 cut” 只在 `mode === 'snapshot'` 生效；`Session.fromRestore` 依赖持久化解码器保证 tagged marker（解码器确实强制，`session-format-v1-to-v2/src/codec.ts:121-125`）。若绕过 storage 直接用 `fromRestore(isSeeded, cut)` 构造无 marker 的数据，构造器会补一个**普通** marker 而不是报错。是否有意（信任 storage 边界）：**未证实**。
5. **错误分类不完整**：`SessionForkError` 只覆盖 fork 的“选择/源/子 id/boundary”四类；seed 深层校验失败、子会话发布 veto 都是普通 `Error`（5.2）。Host 统一映射为 `gateway/internal`，丢掉了“源日志损坏”这一可诊断类别。是否需要新增 code：开放问题。
6. **core 默认 boundary 与“排队输入”**：core 默认最后一个事件，不知道 inbox/queued input；Host 的 completed-prefix 规则才避开 queued input（`packages/api/session-controller/src/commands.ts:80-90`）。直接用 core `fork()` 的调用方可能把 inbox 事件带进子会话。core API 是否应提供 `latestCompletedPrefixBoundary` 之类的 helper（目前它在 controller 私有函数里）：开放问题。
7. **marker `time` 的确定性分叉**：`buildForkSeed` 路径 marker time = cut 事件时间、closers time 同名（`packages/core/session/src/fork.ts:26`；`packages/core/session/src/repair.ts:90`）；而“只给继承前缀”的构造器补 marker 走 `append()`，`time = Date.now()`（`packages/core/session/src/index.ts:694-698, 817-823`）。主 fork 路径确定，subagent completed-prefix 路径不确定。是否需要在 seed helper 里统一：未证实是否有意。
8. **`firstLiveSeq` 对空 fork 子会话为 0 但 seq 0 已被 marker 占用**：`packages/core/session/src/index.ts:550-563, 666, 694-698`；`firstLiveSeq` 的定义是“构造输入 seed 长度”，不是“下一个可 append 的 seq”。需要下游消费者用 `session.seq` 而不是 `firstLiveSeq` 做 append 位置；文档已提醒，但容易误用。是否应改名/暴露 `nextAppendSeq`：开放问题。
9. **嵌套 fork 的 core 端到端覆盖缺口**：`SessionStore.fork` 没有被用来 fork 一个 fork 子会话的测试；嵌套 marker 规则由 `packages/core/session/tests/sequence-types.spec.ts:110-125` + V4 `session-format-v3-to-v4/tests/fork.spec.ts:79-82` 覆盖。建议最终方案补一个“fork child 再 fork”的 store 级测试。
10. **`session/end-seed` 写入者约束只是文档约定**：`packages/core/session/src/types.ts:417-419` 说“只有 Session 构造函数和 buildForkSeed 可以创建”，但 `Session.append` 没有类型/运行时拒绝（`session/end-seed` 是普通非 surface 事件，`packages/core/session/src/index.ts:798-827`）。插件误写 tagged marker 会把此前 live 事件误判为 seed 历史；现有测试未覆盖该防御。是否需要运行时守卫：开放问题。
11. **`origin/delegationDepth` 在用户 fork 上缺省**：core fork / Host fork 都不写；若未来要把“fork 子会话”纳入 subagent 导航/权限模型需谨慎（`packages/subagent/subagent/src/archive-admission.ts:44-56` 以 `origin==='subagent'` 识别子代理）。当前语义似乎是“用户 fork 不是 subagent”，但未见显式设计说明（**未证实**）。
12. **Web/客户端对 `forked` 的呈现**：当前只看到 workflow-run 与 subagent 投影消费；聊天 UI 的 turn tail 是否显示/隐藏 forked closer 未在本次范围内验证（`packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts:82` 仅列 error；其余分支未逐一核对）。若最终方案涉及 UI 呈现，需要另查。

---

## 附录 A：关键代码摘录

### A.1 `buildForkSeed`（全文）

```ts
// packages/core/session/src/fork.ts:21-30
export function buildForkSeed(events: readonly SessionEvent[], boundary: SessionSeqType): SessionEvent[] {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed', seq: SessionSeq(boundary + 1),
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the caller validated this exact source event.
    time: events[boundary]!.time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}
```

### A.2 开放 turn 的闭合（核心段）

```ts
// packages/core/session/src/repair.ts:80-97
const last = events.at(-1)
if (openTurn === null || last === undefined) return []
const closers: SessionEvent[] = recovery.results()
let seq = last.seq + closers.length + 1
const time = last.time
if (openStep !== null) {
  closers.push({ type: 'step/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, step: openStep } })
}
closers.push({ type: 'turn/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, reason: { kind: cause.kind } } })
return closers
```

### A.3 合成错误 result 的身份规则

```ts
// packages/core/session/src/repair.ts:166-193（节选）
for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
  const started = callSeq !== undefined
  const message: ToolResultMessage = deepFreeze({
    id: brandString<MessageId>(`${this.cause.kind}-tool-result-${callId}-${seq}`),
    role: 'tool', toolCallId: callId, isError: true,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text: started ? text.started : text.notStarted }],
  })
  results.push({
    type: 'tool/result', seq: SessionSeq(seq++), time,
    data: {
      turn, step, message,
      error: started
        ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
        : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
    },
    surfaceOp: 'append',
    ...started ? { sourceEventSeqs: [callSeq] } : {},
  })
}
```

### A.4 构造器的 marker/cut 规则

```ts
// packages/core/session/src/index.ts:681-698
const seedMarker = this.log[inheritedEventCount]
const markedSeed = seedMarker?.type === 'session/end-seed' && seedMarker.data.inherited === true
if (mode === 'snapshot' && this.header.isSeeded && inheritedEventCount !== this.log.length && !markedSeed) {
  throw new Error('seeded session constructor seed must equal its inherited prefix or mark its inherited cut')
}
if (markedSeed && this.log.slice(inheritedEventCount + 1).some(event => event.type === 'session/end-seed' && event.data.inherited === true)) {
  throw new Error('session inherited event count must identify the final inherited marker')
}
this.inheritedEventCount = inheritedEventCount
this.firstLifecycleSeq = mode === 'snapshot' && this.header.isSeeded ? inheritedEventCount : this.firstLiveSeq
// A fresh seeded child always owns one tagged marker at its inherited cut,
// even when the copied prefix already ends in an ancestor marker. Restore
// retains that durable marker and appends only the ordinary resume marker.
if (seed !== undefined && mode === 'snapshot' && this.header.isSeeded && !markedSeed) {
  this.append('session/end-seed', { inherited: true })
} else if (seed !== undefined && !(mode === 'snapshot' && this.header.isSeeded) && this.log.at(-1)?.type !== 'session/end-seed') {
  this.append('session/end-seed', {})
}
```

### A.5 `SessionStore.fork`

```ts
// packages/core/session/src/index.ts:1380-1398
fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session {
  if (childSessionId !== undefined && this.get(childSessionId) !== undefined) {
    throw new SessionForkError(`session "${childSessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
  }
  const liveSource = this._resolveForkSource(source)
  // oxlint-disable-next-line typescript/no-deprecated -- Existing fork snapshot read; migration deferred.
  const events = liveSource.snapshotEvents()
  const resolved = this._forkBoundary(liveSource.id, events, boundary)
  const seed = resolved === undefined ? [] : buildForkSeed(events, resolved)
  return this.create(childSessionId, {
    seed,
    inheritedEventCount: SessionLogOffset(resolved === undefined ? 0 : resolved + 1),
    meta: {
      ...liveSource.header.cwd !== undefined ? { cwd: liveSource.header.cwd } : {},
      parentSession: liveSource.id,
      isSeeded: true,
    },
  })
}
```
