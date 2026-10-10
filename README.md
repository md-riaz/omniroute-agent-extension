# omniroute-agent-extension

[![npm version](https://img.shields.io/npm/v/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)
[![npm downloads](https://img.shields.io/npm/dm/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)

OmniRoute extension for [Pi Coding Agent](https://pi.dev) (`pi`), [Oh My Pi](https://omp.sh) (`omp`), and Prime Agent.

Connect to your local or remote OmniRoute server and route queries across 44+ LLM providers directly from your agent CLI.

## Features

- **Wizard-based setup** — `/omni setup` inside `pi`, `omp`, or Prime Agent. No manual JSON editing.
- **Multi-CLI support** — one package, identical feature set for `pi`, `omp`, and Prime Agent.
- **Model sync** — push all OmniRoute models into the `Ctrl+P` / `/model` picker with full metadata: context windows, max tokens, reasoning, vision capabilities, and per-model cost.
- **Catalog autosync** — one quiet sync runs when a configured session starts. Repeating background sync is off by default and can be enabled with `/omni autosync on` for a 60-minute interval, with a 5-minute minimum.
- **Cost tracking** — OmniRoute `pricing` values from `/v1/models` are written into host model `cost`, so priced models no longer show as `$0`.
- **Native tool calls** — the host's built-in `openai-completions` handler runs every request, so you get real SSE streaming and native `tool_calls` for all models.
- **Smart sorting** — models grouped by provider prefix, auto-routing models (`auto`, `auto/coding`, etc.) always first.
- **Gateway telemetry** — after each turn, surface OmniRoute-resolved tok/s, cost, and routed model/provider when the gateway sends them. tok/s is never computed as tokens/latency. Missing values stay unavailable until OmniRoute emits them.
- **Health monitoring** — periodic reachability checks with status bar indicators.
- **Connection log** — every failed or abnormally slow connection attempt is appended as a JSON line to `<agent-home>/<state>/connection.log` for infra debugging; `ms` timings expose server cold starts, error fields include the fetch `cause` (e.g. `ECONNRESET`, `ETIMEDOUT`, TLS errors).
- **Env overrides** — `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_PROVIDER_NAME` skip the setup wizard entirely.

## Installation

**Oh My Pi:**

```bash
omp install omniroute-agent-extension
```

```bash
omp install git:github.com/md-riaz/omniroute-agent-extension
```

**Pi Coding Agent:**

```bash
pi install omniroute-agent-extension
```

```bash
pi install git:github.com/md-riaz/omniroute-agent-extension
```

**Prime Agent:**

```bash
prime-agent package install git:github.com/md-riaz/omniroute-agent-extension
```

Prime Agent uses `PRIME_AGENT_CODING_AGENT_DIR` when set, otherwise `~/.prime/agent`.

When replacing the earlier Pi-only `omniroute-pi-ext-integration`, existing `omni` catalog entries are normalized automatically on first load. Run `/omni sync` afterward to refresh the catalog from the server.

## Getting Started

1. Start your CLI (`pi`, `omp`, or Prime Agent)
2. Run `/omni setup` — enter your OmniRoute server URL and API key
3. Run `/omni sync` — populates the `Ctrl+P` / `/model` picker
4. Optional: run `/omni autosync on` to refresh the catalog every 60 minutes while the agent is running
5. Select any model with `/model` and start chatting

Config is saved to:

| CLI | Config path |
|---|---|
| `omp` | `~/.omp/agent/omniroute-agent-extension/config.json` |
| `pi` | `~/.pi/agent/omniroute-agent-extension/config.json` |
| Prime Agent | `~/.prime/agent/omniroute-agent-extension/config.json` |

Synced models are written to `~/.omp/agent/models.json`, `~/.pi/agent/models.json`, or `~/.prime/agent/models.json` and reloaded on startup without a network call.

## Commands

| Command | Description |
|---|---|
| `/omni` | Server health and provider status |
| `/omni setup` | Configure server URL and API key interactively |
| `/omni sync` | Fetch `/v1/models` and register models in the picker |
| `/omni models [search]` | Browse synced models with optional keyword filter |
| `/omni log [lines]` | Show recent connection log entries from `connection.log` |
| `/omni test <model>` | Smoke-test `/v1/chat/completions` with a specific model |
| `/omni dashboard` | Show the OmniRoute dashboard URL |
| `/omni config` | Show config, models.json, and connection log paths with current settings |
| `/omni autosync [status\|on\|off\|<minutes>]` | View or change background catalog autosync. `on` means every 60 minutes; minimum accepted interval is 5 minutes. |
| `/omni help` | Show command list |

## Catalog autosync

After setup, every configured session does one quiet startup sync after OmniRoute health passes. This refreshes the model picker once without showing a success toast.

Repeating background autosync is off by default because OmniRoute catalogs do not change often. Use these commands when you want it:

```text
/omni autosync status   # show current setting and whether the timer is active
/omni autosync on       # enable every 60 minutes
/omni autosync off      # disable repeating autosync
/omni autosync 30       # set every 30 minutes
/omni autosync 2h       # set every 120 minutes
```

Rules:

- Values are minutes unless suffixed with `h`.
- Minimum repeating interval is 5 minutes; lower non-zero values clamp to 5.
- `0` or `off` disables the repeating timer.
- Manual `/omni sync` always works, even when repeating autosync is off.
- `OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES` overrides the saved setting.

## Agent Tools

Two tools the LLM can call directly:

- **`omniroute_status`** — returns server reachability, config path, and provider name
- **`omniroute_sync`** — fetches `/v1/models` and re-registers the provider (same as `/omni sync`)

## How It Works

The extension registers OmniRoute as an `openai-completions` provider. After `/omni sync`, all models appear in the picker. Every request is handled natively by the host's built-in `openai-completions` handler — real SSE streaming, native `tool_calls`, no middleware.

```text
agent
  -> /model codex/gpt-5.2
  -> OmniRoute /v1/chat/completions (SSE stream)
  -> token-by-token output, native tool_calls
  -> agent executes tools
```

## Auto Models

These virtual model IDs are always prepended to the synced list. OmniRoute resolves them server-side to the best available model for each intent:

```
auto         auto/coding    auto/fast
auto/cheap   auto/offline   auto/smart   auto/lkgp
```

## Environment Variables

| Variable | Description |
|---|---|
| `OMNIROUTE_URL` | OmniRoute server base URL |
| `OMNIROUTE_API_KEY` | API key |
| `OMNIROUTE_PROVIDER_NAME` | Provider name shown in the picker (default: `omni`) |
| `OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES` | Optional background catalog sync interval in minutes. `0` disables repeating autosync; values from `1` to `4` clamp to `5`. |

When any of these are set, `/omni setup` is not required.

## Development

```bash
npm run typecheck   # tsc — zero errors expected
npm run smoke       # import check for omp.ts and pi.ts
```

| File | Purpose |
|---|---|
| `shared.ts` | All business logic — no host package imports; works in `pi`, `omp`, and Prime Agent |
| `omp.ts` | Oh My Pi entry point — `OMP_HOME` / `~/.omp/agent` |
| `pi.ts` | Pi Coding Agent entry point — `PI_CODING_AGENT_DIR` / `~/.pi/agent` |
| `prime.ts` | Prime Agent entry point — `PRIME_AGENT_CODING_AGENT_DIR` / `~/.prime/agent` |

## Requirements

- `omp` ([`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)) v15.9.0+, `pi` ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) v0.60.0+, or Prime Agent
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — any version exposing `/v1/models` and `/v1/chat/completions`

## License

MIT

## Health probe

`/omni` and the status bar treat the gateway as reachable when `/v1/models` returns any HTTP status below 500, including 401/403. Missing or unresolved API keys are auth problems, not downtime. A 5xx or a failed TCP/TLS/timeout after retry still reports unreachable.
