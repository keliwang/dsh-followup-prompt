# Followup Prompt（后续提示）

> 为 DeepSeek Harness 预测你的下一条消息：按 Tab 采用，绝不自动发送。

每轮回答结束后，插件会根据当前对话推测你接下来最可能说的话，并以灰色文字显示在空输入框中。按 **Tab** 把它变成可编辑的草稿；不需要时直接打字即可，预测会自动消失。

- **不打扰**：只在输入框为空时出现；失败或超时时什么都不显示，也不会弹出报错。
- **由你决定**：预测只是草稿，必须由你手动发送。
- **开箱即用**：默认使用当前会话的模型，无需额外依赖或服务端。

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [费用与隐私](#费用与隐私)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [升级与卸载](#升级与卸载)
- [开发](#开发)
- [License](#license)

## 环境要求

- DeepSeek Harness `>=0.2.0 <0.3.0`（已在 0.2.1-rc.2 上验证），并且已经配置好至少一个模型。插件默认使用当前会话的模型。

## 安装

**Harness Desktop（Windows、macOS）**

1. 侧栏点 **插件** → **添加插件**。
2. **包名或地址** 填 `dsh-followup-prompt`。在中国大陆，**安装源** 选 **中国大陆镜像源**。
3. 点 **安装**，再点 **立即启用**，然后刷新页面。如果提示“请重启 DSH”，完全退出 Harness 再打开。

连不上 npm 时，第 2 步也可以填 [Releases](https://github.com/keliwang/dsh-followup-prompt/releases) 里下载的 `dsh-followup-prompt-<版本>.tgz` 的完整路径。

**Harness Web（Windows、macOS、Linux）**

需要 Node.js `22.19` 以上和 pnpm。

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add dsh-followup-prompt
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

> [!NOTE]
> 不要用源码目录安装（**包名或地址** 填本仓库路径）。目录安装时插件找不到 Harness 自带的依赖，会加载失败。需要本地构建时，在本仓库执行 `pnpm pack`，安装生成的 `.tgz`。

### 验证安装

1. 发送一个问题，等待回答结束，保持输入框为空。
2. 输入框中出现灰色的预测文字。
3. 按 Tab，文字进入输入框，并且**没有被发送**。

如果始终看不到预测，请参阅[常见问题](#常见问题)。

## 使用

回答结束且输入框为空时，预测会显示在原 placeholder 的位置，右侧带有 `Tab 接受` 提示。

| 操作 | 效果 |
|---|---|
| **Tab** | 预测写入输入框成为草稿，光标位于末尾，可继续编辑 |
| **Esc** 或点击 × | 关闭本次预测，本回合内不再出现 |
| 开始打字或输入法组字 | 预测隐藏 |
| 开始新回合或切换会话 | 预测隐藏 |

重新打开一个已结束的会话时，也会显示该会话最后一轮的预测；同一回合只会请求一次模型。

## 配置

可以在 **Settings → Plugins → Followup Prompt** 中修改，也可以直接编辑 profile patch 中本插件的 `config`。

> [!IMPORTANT]
> 直接编辑 patch 时，`config` 会被整体替换而非合并。即使只改一个字段，也要写出全部字段，可参考本包的 [`cordis.patch.yml`](cordis.patch.yml)。

**常用**

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭后不再发出任何模型请求。 |
| `provider` / `model` | `''` / `''` | 用于预测的模型。留空则使用当前会话的模型；可改用更便宜的小模型。两项须同时填写，否则忽略。 |
| `reasoningEffort` | `'low'` | 可选 `''`、`off`、`low`、`high`、`max`。默认 `low`（thinking 开启）；`''` 表示沿用模型默认值。 |

**请求与上下文**

| 字段 | 默认值 | 说明 |
|---|---|---|
| `maxTokens` | `8192` | 预测的输出 token 上限，推理 token 也计入。默认给 thinking 留足余量；实际输出通常很短。 |
| `timeoutMs` | `30000` | 单次预测的总超时，范围 2–30 秒。 |
| `maxTurns` | `0` | 压缩对话最多保留最近 N 轮；默认 0 = 累积全部轮次（每轮 = 用户消息 + 模型可见回复全文，不含 thinking/tool call/tool 输出），每轮只追加一对，缓存命中随轮次叠加。 |

**行为**

| 字段 | 默认值 | 说明 |
|---|---|---|
| `prefetchOnTurnEnd` | `false` | 回合一结束就预先生成，即使你没有在看该会话。会为所有活跃会话产生费用。 |
| `prompt` | `''` | 高级选项：替换内置的预测指令。 |

## 费用与隐私

- **费用**：每次预测都是一次普通的模型请求，按所用 provider 正常计费。可以通过 `enabled`、`provider` / `model` 和 `maxTokens` 控制成本；预测使用一条很小的「压缩对话」（每轮 = 用户消息 + 模型可见回复全文），每轮只在末尾追加一对，provider 前缀缓存会逐轮累积，输入 token 大部分按缓存价计费。
- **数据去向**：预测只把「压缩对话」（用户消息 + 每轮模型可见回复全文）发送给该会话正在使用的模型，不发送 thinking、tool call、工具输出或完整会话历史；如果设置了 `provider` / `model`，则发送给你指定的模型。
- **不落盘**：预测只保存在内存中，不写入会话记录或文件，重启后即消失。
- **日志**：只记录耗时、token 数和结果等元数据，不记录对话内容。
- **无遥测**：不向任何第三方上报数据。
- **敏感内容**：没有服务端内容审核。如果预测中出现疑似密钥的文本，插件会在本地直接丢弃这条预测；无论如何，预测都需要你手动发送。

## 常见问题

<details>
<summary><b>一直看不到预测</b></summary>

- 确认 `enabled` 为 `true`。
- 使用非 DeepSeek 模型时，`reasoningEffort: 'low'` 可能不受支持，请改为 `''`。
- 被中断或出错的回合不会生成预测，新建的空会话也不会。
- 输入框中有文字或附件时，预测不会显示。

</details>

<details>
<summary><b>按 Tab 没有反应</b></summary>

斜杠命令菜单或其他弹出菜单打开时，Tab 由菜单处理。关闭菜单后再按 Tab 即可。

</details>

<details>
<summary><b>装上的不是最新版本</b></summary>

Harness 用 pnpm 安装插件，pnpm 默认会暂缓安装刚发布不久的版本（`minimumReleaseAge`），这时会装上上一个版本，安装完成界面会写明实际装入的版本。过一段时间再按[升级](#升级与卸载)步骤重装即可。

</details>

## 已知限制

- 预测的显示位置依赖 Harness 输入框的内部结构，Harness 升级后可能错位。遇到问题时，可以先把 `enabled` 设为 `false` 临时关闭。
- 预测请求不会出现在会话记录中，无法事后查看或重放。
- 预测只基于「用户消息 + 每轮模型可见回复全文」的压缩对话，不包含 thinking、tool call 和工具输出，因此对需要细节的预测可能不如完整上下文准确；可用 `maxTurns` 控制累积轮数。

## 升级与卸载

**Harness Desktop**：在 **插件** → **已安装插件** 中打开 **后续提示**（英文界面为 Followup Prompt），点 **卸载**。升级时先卸载，再按[安装](#安装)步骤重新安装。

**Harness Web**：

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add dsh-followup-prompt@latest   # 升级
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web remove dsh-followup-prompt      # 卸载
```

完成后刷新页面，必要时重启 Harness。如果只是想暂时停用，在插件页关掉它的开关，或把 `enabled` 设为 `false`。

## 开发

- [`docs/design.md`](docs/design.md)：技术方案、架构，以及开发与验证流程。
- [`docs/protocol.md`](docs/protocol.md)：Host 与浏览器之间的接口协议。

## License

[MIT](LICENSE)
