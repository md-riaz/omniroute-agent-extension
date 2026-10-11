# Changelog

## 3.2.0

### Added

- Prime Agent support through `prime.ts`, registered under the Pi-compatible manifest that Prime Agent reads today.
- Gateway telemetry for OmniRoute inference calls. The extension reports routed model, provider, cost, token counts, cache state, fallback count, and tok/s when OmniRoute emits them.
- Streaming telemetry capture for final SSE `usage.tokens_per_second`, while passing the response stream through unchanged.
- OmniRoute pricing sync from `/v1/models` into host model `cost` fields.
- Catalog autosync. Configured sessions run one quiet startup sync after health passes. Repeating background sync is off by default and can be enabled with `/omni autosync on`.
- `/omni autosync status/on/off/<minutes>` controls. `on` uses 60 minutes, non-zero values below 5 minutes clamp to 5, and `OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES` can override saved config.
- `scripts/sync-once.ts` for one-off catalog syncs outside the agent UI.
- E2E-first contributor docs for safer future PRs.

### Changed

- `/v1/models` health checks now treat HTTP 401, 403, and other client responses below 500 as reachable. Auth failures are setup problems, not gateway downtime.
- Synced model metadata now includes per-model pricing when OmniRoute provides it.
- Documentation now covers Pi Coding Agent, Oh My Pi, and Prime Agent together.
- Architecture docs now describe pricing, telemetry, autosync, and current package manifests.

### Fixed

- Legacy Pi catalog entries are normalized to the current `openai-completions` provider API on load.
- Telemetry no longer misses tok/s that OmniRoute sends only in the final streaming SSE usage block.
- Telemetry never derives tok/s from latency. Missing gateway values stay unavailable.

### Verification before release

Run these before publishing:

```bash
npm test
npm run typecheck
npm run smoke
npm pack --dry-run
```

Optional production-style checks when an OmniRoute API key is available:

```bash
# One-off catalog sync against a scratch agent home.
PI_CODING_AGENT_DIR=/path/to/scratch-agent-home \
  node --experimental-strip-types scripts/sync-once.ts PI_CODING_AGENT_DIR /path/to/scratch-agent-home

# Then inspect /path/to/scratch-agent-home/models.json for synced models and pricing.
```

Do not paste API keys into issue comments, PR bodies, shell history, logs, or docs.
