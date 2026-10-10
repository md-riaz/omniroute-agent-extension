import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOmniExtension, isOmniRouteReachableHttpStatus, sanitizeConfig } from "../shared.ts";

test("normalizes legacy Pi catalog API identifiers when reloading models.json", async () => {
  const agentHome = mkdtempSync(join(tmpdir(), "omniroute-agent-extension-test-"));
  const envName = "OMNIROUTE_TEST_HOME";
  const previousHome = process.env[envName];
  process.env[envName] = agentHome;

  writeFileSync(
    join(agentHome, "models.json"),
    JSON.stringify({
      providers: {
        omni: {
          baseUrl: "http://127.0.0.1:20128/v1",
          apiKey: "test-key",
          api: "omni-prompt-tools",
          models: [
            { id: "gpt-test", name: "GPT Test", api: "omni-prompt-tools" },
            {
              id: "gpt-partial-cost",
              name: "GPT Partial Cost",
              api: "omni-prompt-tools",
              cost: { input: 1.25 },
            },
          ],
        },
      },
    }),
  );

  const registrations: Array<{ name: string; config: any }> = [];
  const pi = {
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerTool() {},
    registerCommand() {},
    on() {},
  };

  try {
    await createOmniExtension(pi, { homeEnvVar: envName, defaultHome: "~/.unused" });

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].name, "omni");
    assert.equal(registrations[0].config.api, "openai-completions");
    assert.equal(registrations[0].config.models[0].api, "openai-completions");
    assert.deepEqual(registrations[0].config.models[0].cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(registrations[0].config.models[1].cost, {
      input: 1.25,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  } finally {
    if (previousHome === undefined) delete process.env[envName];
    else process.env[envName] = previousHome;
    rmSync(agentHome, { recursive: true, force: true });
  }
});

// Regression guard for the CodeRabbit review on PR #22: a `~`-prefixed env
// value must resolve against the home dir, not be joined as a cwd-relative path.
test("expands a leading ~ in the agent-home env var", async () => {
  const home = mkdtempSync(join(tmpdir(), "omniroute-home-test-"));
  const agentDir = join(home, ".pi-alt");
  const envName = "OMNIROUTE_TEST_TILDE_HOME";
  const previousHome = process.env[envName];
  const previousUserHome = process.env.HOME;
  process.env.HOME = home;
  process.env[envName] = "~/.pi-alt";

  const registrations: Array<{ name: string; config: any }> = [];
  const pi = {
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerTool() {},
    registerCommand() {},
    on() {},
  };

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          omni: {
            baseUrl: "http://127.0.0.1:20128/v1",
            apiKey: "test-key",
            models: [{ id: "gpt-test", name: "GPT Test" }],
          },
        },
      }),
    );

    await createOmniExtension(pi, { homeEnvVar: envName, defaultHome: "~/.unused" });

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].config.models[0].id, "gpt-test");
  } finally {
    if (previousHome === undefined) delete process.env[envName];
    else process.env[envName] = previousHome;
    if (previousUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousUserHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("prime agent entrypoint uses PRIME_AGENT_CODING_AGENT_DIR", async () => {
  const agentHome = mkdtempSync(join(tmpdir(), "omniroute-prime-home-"));
  const previousHome = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentHome;

  const registrations: Array<{ name: string; config: any }> = [];
  const pi = {
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerTool() {},
    registerCommand() {},
    on() {},
  };

  try {
    writeFileSync(
      join(agentHome, "models.json"),
      JSON.stringify({
        providers: {
          omni: {
            baseUrl: "http://127.0.0.1:20128/v1",
            apiKey: "",
            models: [{ id: "prime-test", name: "Prime Test" }],
          },
        },
      }),
    );

    const mod = await import(`../prime.ts?case=${Date.now()}`);
    await mod.default(pi);

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].config.models[0].id, "prime-test");
  } finally {
    if (previousHome === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousHome;
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("treats auth and client HTTP responses as reachable", () => {
  assert.equal(isOmniRouteReachableHttpStatus(200), true);
  assert.equal(isOmniRouteReachableHttpStatus(401), true);
  assert.equal(isOmniRouteReachableHttpStatus(403), true);
  assert.equal(isOmniRouteReachableHttpStatus(404), true);
  assert.equal(isOmniRouteReachableHttpStatus(500), false);
  assert.equal(isOmniRouteReachableHttpStatus(0), false);
});

test("maps OmniRoute per-model pricing into Pi model cost during sync", async () => {
  const agentHome = mkdtempSync(join(tmpdir(), "omniroute-agent-extension-cost-test-"));
  const envName = "OMNIROUTE_TEST_HOME";
  const previousHome = process.env[envName];
  process.env[envName] = agentHome;

  const registrations: Array<{ name: string; config: any }> = [];
  const tools = new Map<string, any>();
  const pi = {
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "prov/full",
              name: "Full",
              owned_by: "prov",
              context_length: 1000,
              max_output_tokens: 100,
              input_modalities: ["text"],
              pricing: { input: 3, output: 15, cached: 0.3, cache_creation: 3.75 },
            },
            { id: "prov/partial", name: "Partial", owned_by: "prov", pricing: { input: 1 } },
            { id: "prov/free", name: "Free", owned_by: "prov", input_modalities: ["text"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await createOmniExtension(pi, { homeEnvVar: envName, defaultHome: "~/.unused" });
    const sync = tools.get("omniroute_sync");
    assert.ok(sync, "omniroute_sync tool registered");
    await sync.execute("1", {});

    const models = registrations.at(-1)!.config.models;
    const byId = Object.fromEntries(models.map((m: any) => [m.id, m]));
    assert.deepEqual(byId["prov/full"].cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    assert.deepEqual(byId["prov/partial"].cost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(byId["prov/free"].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(registrations.at(-1)!.config.api, "openai-completions");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env[envName];
    else process.env[envName] = previousHome;
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("sanitizeConfig accepts autosync interval config and env override", () => {
  const previous = process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES;
  try {
    delete process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES;
    assert.equal(sanitizeConfig({}).autoSyncIntervalMinutes, 0);
    assert.equal(sanitizeConfig({ autoSyncIntervalMinutes: 0 }).autoSyncIntervalMinutes, 0);
    assert.equal(sanitizeConfig({ autoSyncIntervalMinutes: 1 }).autoSyncIntervalMinutes, 5);
    assert.equal(sanitizeConfig({ autoSyncIntervalMinutes: 100_000 }).autoSyncIntervalMinutes, 35791);

    process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES = "60";
    assert.equal(sanitizeConfig({ autoSyncIntervalMinutes: 0 }).autoSyncIntervalMinutes, 60);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES;
    else process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES = previous;
  }
});

test("autosync command uses minutes and defaults repeat sync off", async () => {
  const agentHome = mkdtempSync(join(tmpdir(), "omniroute-agent-extension-autosync-"));
  const envName = "OMNIROUTE_TEST_AUTOSYNC_HOME";
  const previousHome = process.env[envName];
  const previousInterval = process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES;
  const previousUrl = process.env.OMNIROUTE_URL;
  const previousKey = process.env.OMNIROUTE_API_KEY;
  process.env[envName] = agentHome;
  process.env.OMNIROUTE_URL = "http://127.0.0.1:20128";
  process.env.OMNIROUTE_API_KEY = "test";
  delete process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES;

  mkdirSync(join(agentHome, "omniroute-agent-extension"), { recursive: true });
  writeFileSync(
    join(agentHome, "omniroute-agent-extension", "config.json"),
    JSON.stringify({ serverUrl: "http://127.0.0.1:20128", apiKey: "test", providerName: "omni" }),
  );

  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const notifications: string[] = [];
  const registrations: Array<{ name: string; config: any }> = [];
  const refreshes: number[] = [];
  const originalFetch = globalThis.fetch;
  let modelsCalls = 0;
  const pi = {
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerTool() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(name: string, handler: any) {
      events.set(name, handler);
    },
  };

  globalThis.fetch = (async (input: any) => {
    if (String(input).endsWith("/v1/models")) {
      modelsCalls++;
      return new Response(
        JSON.stringify({
          data: [{ id: `prov/model-${modelsCalls}`, name: `Model ${modelsCalls}`, owned_by: "prov", input_modalities: ["text"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  let ctx: any;
  try {
    await createOmniExtension(pi, { homeEnvVar: envName, defaultHome: "~/.unused" });
    const omni = commands.get("omni");
    assert.ok(omni, "omni command registered");
    ctx = {
      ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
      modelRegistry: { refresh() { refreshes.push(Date.now()); } },
    };

    await events.get("session_start")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(modelsCalls, 2, "health probe plus one quiet startup sync");
    assert.equal(registrations.length, 1);
    assert.equal(refreshes.length, 1);

    await omni.handler("autosync status", ctx);
    assert.match(notifications.at(-1)!, /Auto-sync: off/);

    await omni.handler("autosync on", ctx);
    assert.match(notifications.at(-1)!, /every 60m/);

    await omni.handler("autosync 1", ctx);
    assert.match(notifications.at(-1)!, /every 5m/);

    await omni.handler("autosync 2h", ctx);
    assert.match(notifications.at(-1)!, /every 120m/);

    await omni.handler("autosync off", ctx);
    assert.match(notifications.at(-1)!, /off/);
  } finally {
    events.get("session_shutdown")?.({}, ctx);
    if (previousHome === undefined) delete process.env[envName];
    else process.env[envName] = previousHome;
    if (previousInterval === undefined) delete process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES;
    else process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES = previousInterval;
    if (previousUrl === undefined) delete process.env.OMNIROUTE_URL;
    else process.env.OMNIROUTE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousKey;
    globalThis.fetch = originalFetch;
    rmSync(agentHome, { recursive: true, force: true });
  }
});
