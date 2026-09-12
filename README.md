# OmniRoute Agent Extension

[![npm version](https://img.shields.io/npm/v/omniroute-pi-ext-integration.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-pi-ext-integration)
[![npm downloads](https://img.shields.io/npm/dm/omniroute-pi-ext-integration.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-pi-ext-integration)

A shared OmniRoute integration for **Pi Coding Agent**, **Oh My Pi**, and
**Prime Agent**. The npm package remains named `omniroute-pi-ext-integration`
for compatibility; the GitHub repository is `omniroute-agent-extension`.

Connect to a local or remote OmniRoute server, browse models, manage combos,
check quotas, and route queries across 44+ LLM providers.

## Features

- 🔮 **Wizard-Based Setup**: Just run `/omni setup` inside Pi. No manual JSON editing needed.
- ⚡ **Pure HTTP Client**: Works securely and seamlessly whether your OmniRoute server is running locally on `localhost:20128` or hosted on a remote VPS.
- 🔄 **Combo & Model Sync**: Instantly push all OmniRoute combos and available models into Pi’s `Ctrl+P` model picker with full metadata (context windows, max tokens, reasoning support, and vision capabilities).
- 🛠️ **Prompt Tool Fallback for Chat-Only Models**: Models that do not support native `tool_calls` can still use Pi tools through prompt-emulated tool calling.
- 🔁 **Same `/model` Workflow**: Switch models normally; the extension chooses native tools or prompt tools automatically.
- 📊 **Selected Model Status**: Status bar shows the currently selected Pi/OmniRoute model ID. For OmniRoute combos, this shows the combo/model selected in Pi, not the underlying provider model that OmniRoute ultimately routed to.
- 🧬 **Smart Sorting**: Syncing organizes your model list by provider/group (`owned_by`) for a cleaner `Ctrl+P` experience.
- 🛠️ **Diagnostics & Health**: Spot expired tokens, connection failures, or disconnected providers right when Pi starts (management endpoints must be accessible).
- 📉 **Quota Management**: Live usage tracking mapped directly to OmniRoute's global quota endpoints.

## Installation

### Prime Agent

Prime Agent is supported through its Pi-compatible package system. Install the
Prime-compatible fork/branch from this repository at the reviewed commit:

```bash
prime-agent package install git:github.com/alfred-rootson/omniroute-agent-extension@d568da14bffa9281b7e6137e704a8a9812414c16
```

Restart Prime Agent, then run `/omni setup` followed by `/omni sync`.
Prime Agent stores its catalog under `~/.prime/agent`; the extension creates
that directory on first use.

### Pi Coding Agent

Install the published npm package:

```bash
pi install omniroute-pi-ext-integration
```

Or install from the upstream repository:

```bash
pi install git:github.com/md-riaz/omniroute-agent-extension
```

### Oh My Pi

Install the published package with Oh My Pi:

```bash
omp install omniroute-pi-ext-integration
```

Or install the upstream repository directly:

```bash
omp install git:github.com/md-riaz/omniroute-agent-extension
```


## Getting Started

The `/omni` commands are available in all three supported agents. Start the
agent you installed, run `/omni setup`, enter the OmniRoute URL and API key,
then run `/omni sync` to populate the model picker.


## Prompt Tool Fallback

Some OmniRoute-synced models are chat-only: they can answer text, but they do not return native OpenAI-style `message.tool_calls`. This is common for web-synced model IDs such as:

```text
cgpt-web/gpt-5.4-pro
chatgpt-web/gpt-5.5
bb-web/gpt-4-turbo
ds-web/deepseek-v4-pro
```

For these models, the extension keeps the same Pi provider (`omni`) and `/model` workflow, but internally switches to prompt-emulated tool calling.

### Native tool mode

Used for normal tool-capable models.

```text
Pi agent
  -> omni provider
  -> OmniRoute with native tools: [...]
  -> model returns native tool_calls
  -> Pi executes tools
```

### Prompt tool mode

Used when a model is chat-only or marked as not supporting native tool calls.

Prompt tool mode is intentionally buffered: the extension waits for the full model response before showing text, because it must parse complete `<tool_call>` blocks before emitting Pi-native tool events.

```text
Pi agent
  -> omni provider
  -> extension renders Pi tools as text instructions
  -> OmniRoute request is sent with tools: []
  -> model writes <tool_call>{...}</tool_call>
  -> extension converts that text back into Pi native toolCall events
  -> Pi executes tools normally
```

The model is taught this wire format:

```xml
<tool_call>
{"name":"read","arguments":{"path":"index.ts"}}
</tool_call>
```

Tool results are fed back in history as text:

```xml
<tool_result tool="read" id="call_123">
...tool output...
</tool_result>
```

## How Prompt Tool Mode Is Detected

Prompt tool mode is enabled when either condition is true:

1. The upstream model metadata contains `-web` during sync, such as OmniRoute model ID/name, `owned_by`, or model provider label. This does not change the Pi provider ID, which remains `omni`.
2. The synced `models.json` model entry contains:

```json
{
  "tool_calling": false
}
```

The second check reads raw `models.json` because Pi's runtime `Model` object does not preserve custom fields like `tool_calling`.

Example synced model entry:

```json
{
  "id": "cgpt-web/gpt-5.4-pro",
  "name": "Gpt 5.4 Pro",
  "api": "omni-prompt-tools",
  "tool_calling": false,
  "input": ["text", "image"],
  "contextWindow": 400000,
  "maxTokens": 65535,
  "reasoning": true
}
```

## Model Switching

Use Pi's normal model picker/command:

```text
/model cgpt-web/gpt-5.4-pro
/model codex/gpt-5.2
/model premium
```

The extension routes automatically:

| Model kind | Detection | Tool mode |
|---|---|---|
| Web-synced model | Upstream model ID/name, OmniRoute `owned_by`, or model provider label contains `-web` | Prompt-emulated tools |
| Explicit chat-only model | `tool_calling: false` in `models.json` | Prompt-emulated tools |
| Normal model | No fallback marker | Native tools |

## Commands Reference

| Command | Description |
|---|---|
| `/omni` | Dashboard showing server health, active connections, and combos |
| `/omni sync` | Sync your Pi model picker with all healthy OmniRoute instances |
| `/omni setup` | Launch interactive wizard to link Pi with your OmniRoute gateway |
| `/omni dashboard` | Get the direct link to your OmniRoute web interface |

## Development

This repo is intentionally small and AI-friendly:

| File | Purpose |
|---|---|
| `AGENTS.md` | Required instructions for AI agents editing this repo. |
| `AI.md` | Fast handoff guide for AI agents and future maintainers. |
| `ARCHITECTURE.md` | Data flows and prompt-tool architecture. |
| `CONTRIBUTING.md` | Local setup, test checklist, and contribution rules. |
| `index.ts` | Extension implementation. |

Run TypeScript check:

```bash
npm run typecheck
```

Smoke-test extension import:

```bash
npm run smoke
```

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) v0.60.0+
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) v2.9.0+

## License

MIT
