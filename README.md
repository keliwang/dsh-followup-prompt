# Followup Prompt（后续提示）

DeepSeek Harness 插件：每轮回答结束后，在空输入框里用灰色文字预测你接下来最可能输入的消息。
按 **Tab** 把它变成可编辑的草稿，**绝不会自动发送**。

## 使用方式

- 回答结束、输入框为空时，原 placeholder 的位置会出现一条灰色预测，右侧有 `Tab 接受` 提示。
- **Tab** 或点击：预测写入输入框成为草稿，光标在末尾，可以继续编辑。
- **Esc** 或点击 ×：关闭本次预测，同一回合不再出现。
- 开始打字、开始新回合、切换会话、输入法组合输入期间，预测自动隐藏。
- 没有预测、请求失败或超时时，什么都不显示，不会弹出任何报错。
- 重新打开一个已经结束的会话，也会显示该会话最后一轮的预测（同一回合只会请求一次模型）。

## 要求

- DeepSeek Harness `>=0.2.0 <0.3.0`（在 0.2.1-rc.2 上验证）。
- 不需要额外安装依赖，也不需要任何服务端接口。

## 安装

安装会修改当前 profile 的 `package.json` / lock，需要完整权限批准。建议先在一个可丢弃的测试 profile 里试用。

1. 获取安装包：
   - 从 npm 安装（发布后）：包名 `dsh-followup-prompt`；
   - 或从源码打包：在本仓库执行 `pnpm pack`，得到 `dsh-followup-prompt-<version>.tgz`。
2. 在 Harness 中让 agent 调用 `plugin_manager` → `install_bundle`，`target` 填 `.tgz` 的**绝对路径**（或 npm 包名）。
3. 刷新页面。

> 请使用 `.tgz` 或 npm 包安装，不要直接安装源码目录：目录安装会让插件找不到 Harness 自带的依赖而加载失败。

### 确认安装成功

1. 发一个问题，等回答结束（输入框保持为空）。
2. 输入框内出现灰色预测文字。
3. 按 Tab，文字进入输入框，且**没有被发送**。

如果一直没有出现预测，见下方「常见问题」。

## 配置

在 **Settings → Plugins → Followup Prompt** 中修改，也可以直接编辑 profile patch 中本插件的 `config`。

> 直接编辑 patch 时，`config` 会被整体替换而不是合并：改一个字段也要把全部字段写全（可参考本包的 `cordis.patch.yml`）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭后不再产生任何模型请求。 |
| `provider` / `model` | `''` / `''` | 留空 = 使用当前会话的模型。可改成更便宜的小模型；两者必须同时填写，否则忽略。 |
| `reasoningEffort` | `'off'` | `'' \| off \| low \| high \| max`。默认关闭推理以降低延迟和成本；`''` 表示使用模型默认值。 |
| `maxTokens` | `400` | 预测的输出上限（推理 token 也计入）。 |
| `timeoutMs` | `15000` | 单次预测的总超时（2–30 秒）。 |
| `maxTurns` | `0` | 只带最近 N 轮对话；`0` = 带完整历史（推荐，缓存命中更好）。 |
| `maxInputChars` | `20000` | 输入字符预算，超出时从最早的对话开始裁剪；`0` = 不限制。 |
| `maxToolRejectRounds` | `1` | 模型试图调用工具时最多再追问几次；工具永远不会被执行。 |
| `toolRejectionText` | `''` | 拒绝工具调用时回给模型的文案；留空使用内置文案。 |
| `maxSuggestionChars` | `400` | 预测文本最大长度，超出截断。 |
| `stripMedia` | `false` | 裁剪历史时把图片/文件替换成文字占位。 |
| `sampleRate` | `1.0` | 采样率（0–1）。例如 `0.3` 表示约 30% 的回合会生成预测。 |
| `prefetchOnTurnEnd` | `false` | 回合一结束就预先生成，即使你没在看这个会话（会为所有活跃会话付费）。 |
| `cacheTtlMs` | `600000` | 预测在内存中的保留时间。 |
| `maxConcurrent` | `2` | 同时进行的预测数量上限。 |
| `excludeSubagents` | `true` | 不为子代理会话生成预测。 |
| `prompt` | `''` | 高级：替换内置的预测指令。 |

## 计费与隐私

- **会产生费用**：每次预测都是一次普通的模型请求，按你配置的 provider 正常计费。可以用 `enabled`、`sampleRate`、`provider`/`model`、`maxInputChars` 控制成本。
- **数据去向**：预测会把当前会话历史发给**该会话正在使用的模型**，和正常聊天是同一个信任范围；如果你设置了 `provider`/`model`，数据会发给你指定的模型。
- **不落盘**：预测只保存在内存中，不写入会话记录或文件，重启后消失。
- **日志**：只记录耗时、token 数、结果等元数据，不记录对话内容。
- **无遥测**：不向任何第三方上报数据。
- **内容过滤**：没有服务端内容审核。插件会在本地过滤看起来像密钥的文本，且预测永远需要你手动确认后才会发送。

## 常见问题

**一直不出现预测**

- 确认 `enabled` 为 `true`、`sampleRate` 不为 `0`。
- 使用非 DeepSeek 模型时，`reasoningEffort: 'off'` 可能不被支持，请改为 `''`。
- 回答被中断或出错的回合不会生成预测；新建的空会话也不会。
- 输入框里有文字或附件时，预测不会显示。

**Tab 没有反应**

斜杠命令或其他弹出菜单打开时，Tab 交给菜单处理。关闭菜单后再按 Tab，或直接点击预测文字。

## 已知限制

- 预测的显示位置依赖 Harness 输入框的内部结构，Harness 升级后可能出现错位；出现问题时可以把 `enabled` 设为 `false` 临时关闭。
- 预测请求不会出现在会话记录里，无法事后查看或重放。

## 卸载

1. 让 agent 调用 `plugin_manager` → `remove_bundle`（`dsh-followup-prompt`）。
2. 刷新页面；必要时重启 Harness。

只想临时停用时，把 `enabled` 设为 `false` 即可。

## 开发

技术方案、架构和开发验证流程见 [`docs/design.md`](docs/design.md)；Host 与浏览器之间的接口协议见 [`docs/protocol.md`](docs/protocol.md)。

## License

[MIT](LICENSE)
