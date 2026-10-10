import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOmniExtension, isOmniRouteReachableHttpStatus } from "../shared.ts";

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
