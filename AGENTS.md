# AGENTS.md

面向在本仓库（`dsh-followup-prompt`）工作的 Agent 的项目约定。

## 版本号：只在用户明确要求时升级

- 不要为了让一次改动“看起来完整”而修改 `package.json` 的 `version`。开发过程中的功能、修复、文档、测试改动一律**不升版本**。
- 只有用户明确要求“发版 / 升级版本”时，才修改 `version`。升版本是发布动作：推送 `v*` tag 会触发 `.github/workflows/release.yml` 校验 tag 与 `package.json` 版本一致，并走 npm 发布和 GitHub Release 流程。
- 本地验证需要重新打包、重装插件时，保持**当前版本号**，重新 `pnpm pack` 并安装。不要用“升版本”来绕过包管理器的缓存或重装问题；如果当前版本无法覆盖安装，先停下来问用户。
- 拿不准是否该升版本时，先问用户，不要自行决定。
