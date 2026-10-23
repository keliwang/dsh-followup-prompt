# Followup Prompt

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-followup-prompt)](https://www.npmjs.com/package/dsh-followup-prompt)
[![CI](https://github.com/keliwang/dsh-followup-prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/keliwang/dsh-followup-prompt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Predicts your next message in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Press Tab to use it; it never sends by itself.

After each reply, the plugin guesses what you are most likely to say next and shows it as gray text inside the empty composer. Press **Tab** to turn it into an editable draft, or just start typing and it disappears.

- **Unobtrusive**: appears only when the composer is empty; failures and timeouts show nothing and never raise an error.
- **You stay in control**: a prediction is only a draft. You always send it yourself.
- **Works out of the box**: uses the current session's model by default, with no extra dependencies or services.

## Contents

- [Installation](#installation)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Upgrade and uninstall](#upgrade-and-uninstall)
- [Development](#development)

## Installation

Requires DeepSeek Harness `>=0.2.1-rc.2 <0.3.0` (verified on 0.2.1-rc.2) with at least one model configured.

**Harness Desktop (Windows, macOS)**

1. In the sidebar, open **Plugins** → **Add plugin**.
2. Enter `dsh-followup-prompt` as the **Package name or address**. In mainland China, set **Registry** to **Mainland China mirror**.
3. Click **Install**, then **Enable now**, and reload the page. If you are told to restart DSH, quit Harness completely and open it again.

If npm is unreachable, step 2 also accepts the full path of a `dsh-followup-prompt-<version>.tgz` downloaded from [Releases](https://github.com/keliwang/dsh-followup-prompt/releases).

**Harness Web (Windows, macOS, Linux)**

Requires Node.js `22.19` or later and pnpm.

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add dsh-followup-prompt
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

> [!NOTE]
> Do not install from the source directory (entering this repository's path as the package address). A directory install cannot find the dependencies that ship with Harness, so the plugin fails to load. To build locally, run `pnpm pack` in this repository and install the resulting `.tgz`.

**Verify the installation**: ask a question, wait for the reply to finish, and leave the composer empty. Gray prediction text appears in the composer; press Tab and the text moves into the composer **without being sent**. If no prediction appears, see the [FAQ](#faq).

## Usage

When a reply finishes and the composer is empty, the prediction appears where the placeholder would be.

| Action | Effect |
|---|---|
| **Tab** | The prediction becomes a draft in the composer with the cursor at the end, ready to edit |
| **Esc** | Closes this prediction; it does not come back for this turn |
| Start typing or composing with an input method | The prediction hides; once the composer is cleared, a prediction that was already generated reappears |
| Start a new turn or switch sessions | The prediction hides |

Reopening a finished session also shows the prediction for its last turn.

## How it works

**When the model is called**: only while you are looking at a session whose turn has finished and the composer is empty. The result stays in memory until the next turn starts, so viewing it again is not billed again. Interrupted or failed turns, empty sessions, and subagent sessions are never predicted for.

**What the model receives**: a "condensed transcript". Each turn keeps only your message and the visible text of the model's reply; thinking, tool calls, tool output, and the main conversation's system prompt are left out. Each turn appends just one pair of messages at the end, so the provider's prefix cache builds up turn after turn and most input tokens are billed at the cached rate.

**Sticks to what's in the conversation**: predictions are instructed to use only names, values, and facts that appear in the condensed transcript, so they shouldn't make up hostnames, IDs, commands, or results. If the model just asked you to do something, or you said you would, a prediction may assume it's done (like "Logged in, go ahead"). It won't claim you did anything else, or add results nobody mentioned (like "…and it's still failing"). When the natural next message depends on something the model can't see, you get a more general suggestion, or none at all. This is best effort, not a guarantee, so read a prediction before you send it.

**Stays on the current step**: a prediction responds to the model's latest reply and tries not to jump ahead to later steps or switch topics. It also has to give the model something to act on right away: an answer, a decision, a question, or a request. Messages that would only leave the model waiting, like "OK", "thanks", or "I'll test it and get back to you", don't get a prediction. Like the rule above, this is best effort.

**Cost**: every prediction is an ordinary model request billed by your provider. If you don't want it, switch the plugin off on the Plugins page; to spend less, give predictions their own cheaper model (`provider` / `model`).

**Privacy**

- Data goes only to the current session's model, or to the model you set with `provider` / `model`. Nothing is reported to any third party.
- Predictions live in memory only. They are never written to the session log or to disk, and are gone after a restart.
- Logs record metadata only (latency, token counts, outcome), never conversation content.
- There is no server-side content moderation. Predictions that look like secrets are dropped locally, and you always send a prediction yourself.

## Configuration

On the **Plugins** page, find **Followup Prompt** in the **Installed** list and click its configure button to open the settings. Click **Save** when you're done; changes take effect right away, no restart needed.

The **Model** list shows the models you have already set up in DSH, the same ones you see when switching models in the composer. Pick **Session default** to use whatever model your current session is running.

To turn the plugin off, use the switch on its row in the Plugins list.

If you are comfortable with profile patches, you can also edit this plugin's `config` directly.

> [!IMPORTANT]
> `config` in a patch is replaced as a whole, not merged. When editing by hand, write out every field even to change one; use this package's [`cordis.patch.yml`](cordis.patch.yml) as a reference. Saving from the settings page also rewrites the whole `config`.

| Field | Default | Description |
|---|---|---|
| `provider` / `model` | `''` / `''` | The model used for predictions; both must be set together. Leave empty to follow the current session's model. Same as the **Model** option on the settings page. |
| `reasoningEffort` | `'low'` | One of `''`, `off`, `low`, `high`, `max`. `''` uses the model's default; the session's own setting is never inherited. |
| `maxTokens` | `8192` | Output token limit, reasoning tokens included. Actual output is usually short; the default leaves room for thinking. |
| `timeoutMs` | `30000` | Timeout for one prediction, 2–30 seconds. |
| `prompt` | `''` | Advanced: replaces the built-in prediction instruction. |

## FAQ

<details>
<summary><b>No prediction ever appears</b></summary>

- On the **Plugins** page, check that the plugin's switch is on.
- With non-DeepSeek models, `reasoningEffort: 'low'` may not be supported; change it to `''`.
- A prediction is given up when the model takes longer than `timeoutMs`; try a faster model or a lower `reasoningEffort`.
- Predictions are not shown while the composer contains text or attachments.

</details>

<details>
<summary><b>Tab does nothing</b></summary>

While the slash-command menu or another popup menu is open, Tab belongs to the menu. Close the menu and press Tab again.

</details>

<details>
<summary><b>The prediction is misaligned</b></summary>

Where the prediction is drawn depends on the internal structure of the Harness composer, which can shift after a Harness upgrade. Please open an issue; until it is fixed, switch the plugin off on the Plugins page.

</details>

<details>
<summary><b>An older version was installed</b></summary>

Harness installs plugins with pnpm, which by default holds back versions published very recently (`minimumReleaseAge`) and installs the previous version instead; the install result shows the version actually installed. Wait a while, then reinstall following the [upgrade](#upgrade-and-uninstall) steps.

</details>

## Upgrade and uninstall

**Harness Desktop**: on the **Plugins** page, find **Followup Prompt** in the **Installed** list and click **Uninstall**. To upgrade, uninstall first, then install again following [Installation](#installation).

**Harness Web**:

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add dsh-followup-prompt@latest   # upgrade
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web remove dsh-followup-prompt      # uninstall
```

Reload the page afterwards, and restart Harness if needed. To pause the plugin temporarily, switch it off on the Plugins page.

## Development

- [`docs/design.md`](docs/design.md) (Chinese): architecture, implementation details, development, testing, and release.
- [`docs/protocol.md`](docs/protocol.md): the interface contract between the Host and the browser.

## License

[MIT](LICENSE)
