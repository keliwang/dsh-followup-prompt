# Followup Prompt（后续提示）

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-followup-prompt)](https://www.npmjs.com/package/dsh-followup-prompt)
[![CI](https://github.com/keliwang/dsh-followup-prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/keliwang/dsh-followup-prompt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 预测你的下一条消息：按 Tab 采用，绝不自动发送。

每轮回答结束后，插件根据当前对话推测你接下来最可能说的话，以灰色文字显示在空输入框里。按 **Tab** 把它变成可编辑的草稿；不需要就直接打字，预测会自动消失。

- **不打扰**：只在输入框为空时出现；失败或超时时什么都不显示，也不弹出报错。
- **由你决定**：预测只是草稿，必须由你手动发送。
- **开箱即用**：默认使用当前会话的模型，不需要额外依赖或服务。

## 目录

- [安装](#安装)
- [使用](#使用)
- [工作方式](#工作方式)
- [配置](#配置)
- [常见问题](#常见问题)
- [升级与卸载](#升级与卸载)
- [开发](#开发)

## 安装

需要 DeepSeek Harness `>=0.2.0 <0.3.0`（已在 0.2.1-rc.2 上验证），并且至少配置好一个模型。

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

**验证安装**：发一个问题，等回答结束，保持输入框为空。输入框里出现灰色的预测文字；按 Tab，文字进入输入框并且**没有被发送**。看不到预测时参阅[常见问题](#常见问题)。

## 使用

回答结束且输入框为空时，预测显示在原 placeholder 的位置，右侧带有 `Tab 接受` 提示。

| 操作 | 效果 |
|---|---|
| **Tab** | 预测写入输入框成为草稿，光标在末尾，可以继续编辑 |
| **Esc** 或点击 × | 关闭本次预测，本回合内不再出现 |
| 开始打字或输入法组字 | 预测隐藏；清空输入框后，已生成的预测会重新出现 |
| 开始新回合或切换会话 | 预测隐藏 |

重新打开一个已结束的会话时，也会显示它最后一轮的预测。

## 工作方式

**什么时候请求模型**：只在你正看着一个已结束回合的会话、并且输入框为空时请求；结果在内存里保留到下一回合开始，重复查看不会再次计费。被中断或出错的回合、空会话、子代理会话都不会预测。开启 `prefetchOnTurnEnd` 后，回合一结束就预先生成，不管你是否在看。

**发给模型的是什么**：一份「压缩对话」：每一轮只有你的消息和模型回复中可见的文字，不含 thinking、工具调用、工具输出，也不含主对话的系统提示词。每轮只在末尾追加一对消息，所以 provider 的前缀缓存会逐轮累积，大部分输入 token 按缓存价计费。

**费用**：每次预测都是一次普通的模型请求，按所用 provider 正常计费。可以用 `enabled` 关闭，用 `provider` / `model` 换成更便宜的模型，或者用 `maxTurns` 限制对话长度。

**隐私**

- 数据只发给当前会话的模型；设置了 `provider` / `model` 时发给你指定的模型。不向任何第三方上报。
- 预测只保存在内存里，不写入会话记录或文件，重启后就没了。
- 日志只记录耗时、token 数和结果等元数据，不记录对话内容。
- 没有服务端内容审核。疑似密钥的预测会在本地直接丢弃；无论如何，预测都需要你手动发送。

## 配置

在 **插件** 页的 **已安装** 列表中，点 **后续提示** 这一行的配置按钮修改；也可以直接编辑 profile patch 里本插件的 `config`。

> [!IMPORTANT]
> 直接编辑 patch 时，`config` 会被整体替换，而不是合并。即使只改一个字段，也要写出全部字段，可以参考本包的 [`cordis.patch.yml`](cordis.patch.yml)。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭后不再发出任何模型请求。 |
| `provider` / `model` | `''` / `''` | 用于预测的模型，两项必须同时填写；留空则使用当前会话的模型。 |
| `reasoningEffort` | `'low'` | 可选 `''`、`off`、`low`、`high`、`max`。`''` 表示使用模型的默认值；不会跟随会话的设置。 |
| `maxTokens` | `8192` | 输出 token 上限，推理 token 也计入。实际输出通常很短，默认值是给 thinking 留的余量。 |
| `timeoutMs` | `30000` | 单次预测的超时，范围 2–30 秒。 |
| `maxTurns` | `0` | 压缩对话最多保留最近几轮，`0` 表示全部保留。 |
| `prefetchOnTurnEnd` | `false` | 回合一结束就预先生成，即使你没有在看这个会话。会为所有活跃会话产生费用。 |
| `prompt` | `''` | 高级：替换内置的预测指令。 |

## 常见问题

<details>
<summary><b>一直看不到预测</b></summary>

- 确认 `enabled` 为 `true`。
- 使用非 DeepSeek 模型时，`reasoningEffort: 'low'` 可能不受支持，改为 `''`。
- 模型响应超过 `timeoutMs` 时这次预测会放弃；可以换更快的模型，或者把 `reasoningEffort` 调低。
- 输入框里有文字或附件时预测不会显示。

</details>

<details>
<summary><b>按 Tab 没有反应</b></summary>

斜杠命令菜单或其他弹出菜单打开时，Tab 由菜单处理。关闭菜单后再按 Tab 即可。

</details>

<details>
<summary><b>预测位置错位</b></summary>

预测的显示位置依赖 Harness 输入框的内部结构，Harness 升级后可能错位。请提 issue；在修复之前可以把 `enabled` 设为 `false` 临时关闭。

</details>

<details>
<summary><b>装上的不是最新版本</b></summary>

Harness 用 pnpm 安装插件，pnpm 默认会暂缓安装刚发布不久的版本（`minimumReleaseAge`），这时会装上上一个版本，安装完成界面会写明实际装入的版本。过一段时间再按[升级](#升级与卸载)步骤重装即可。

</details>

## 升级与卸载

**Harness Desktop**：在 **插件** 页的 **已安装** 列表中找到 **后续提示**，点 **卸载**。升级时先卸载，再按[安装](#安装)步骤重新安装。

**Harness Web**：

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add dsh-followup-prompt@latest   # 升级
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web remove dsh-followup-prompt      # 卸载
```

完成后刷新页面，必要时重启 Harness。只想暂时停用时，在插件页关掉它的开关，或者把 `enabled` 设为 `false`。

## 开发

- [`docs/design.md`](docs/design.md)：架构、实现细节、开发、测试与发布流程。
- [`docs/protocol.md`](docs/protocol.md)：Host 与浏览器之间的接口契约。

## License

[MIT](LICENSE)
