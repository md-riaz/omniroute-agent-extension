import assert from "node:assert/strict";
import test from "node:test";
import { formatTelemetryStatus, parseGatewayTelemetry, tokensPerSecondFromUsage, wrapFetchCaptureTelemetry } from "../telemetry.ts";

test("reads tok/s from usage and omits zero or latency-derived values", () => {
  assert.equal(tokensPerSecondFromUsage({ tokens_per_second: 42.5 }), 42.5);
  assert.equal(tokensPerSecondFromUsage({ tokens_per_second: 0 }), undefined);
  assert.equal(tokensPerSecondFromUsage({ output_tokens: 100, latency_ms: 2000 }), undefined);
});

test("parses present headers and leaves absent telemetry empty", () => {
  const present = parseGatewayTelemetry(new Headers({
    "x-omniroute-tokens-per-second": "18.2",
    "x-omniroute-model": "omni/claude-opus",
    "x-omniroute-provider": "anthropic",
    "x-omniroute-response-cost": "0.012",
  }), { model: "alias" });
  assert.equal(present.tokensPerSecond, 18.2);
  assert.equal(present.model, "omni/claude-opus");
  assert.equal(present.provider, "anthropic");
  assert.equal(present.cost, 0.012);
  const absent = parseGatewayTelemetry(new Headers(), {});
  assert.deepEqual(absent, {});
  assert.equal(formatTelemetryStatus(absent), "tok/s unavailable");
});

test("preserves zero response cost", () => {
  const zero = parseGatewayTelemetry(new Headers({ "x-omniroute-response-cost": "0" }), {});
  assert.equal(zero.cost, 0);
  assert.equal(formatTelemetryStatus(zero), "tok/s unavailable | cost 0");
});

test("uses body model when routed model header is absent", () => {
  const routed = parseGatewayTelemetry(new Headers(), { model: "omni/gpt-sol", usage: { tokens_per_second: 9 } });
  assert.equal(routed.model, "omni/gpt-sol");
  assert.equal(routed.tokensPerSecond, 9);
});

test("formatter includes tokensIn/tokensOut/cache/fallbackAttempts", () => {
  const line = formatTelemetryStatus({
    tokensPerSecond: 12.34,
    cost: 0,
    tokensIn: 100,
    tokensOut: 50,
    cache: "hit",
    fallbackAttempts: 2,
    model: "omni/x",
    provider: "p",
  });
  assert.equal(line, "tok/s 12.3 | cost 0 | in 100 | out 50 | cache hit | fallbacks 2 | omni/x | p");
});

test("fetch wrapper captures OmniRoute inference URLs only and parses body", async () => {
  const seen: Array<{ tokensPerSecond?: number; model?: string }> = [];
  const inner = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify({ model: "from-body", usage: { tokens_per_second: 7.5 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { headers: { "x-omniroute-tokens-per-second": "11" } });
  }) as typeof fetch;
  const serverUrl = "https://omniroute.example";
  const wrapped = wrapFetchCaptureTelemetry(inner, (t) => { seen.push(t); }, { serverUrl });
  await wrapped("https://omniroute.example/v1/models");
  await wrapped("https://other.example/v1/chat/completions");
  await wrapped("https://omniroute.example/v1/chat/completions");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tokensPerSecond, 7.5);
  assert.equal(seen[0].model, "from-body");
});

test("fetch wrapper skips capture when serverUrl is unset", async () => {
  const seen: unknown[] = [];
  const inner = (async () => new Response("{}", { headers: { "x-omniroute-tokens-per-second": "11" } })) as typeof fetch;
  const wrapped = wrapFetchCaptureTelemetry(inner, (t) => { seen.push(t); });
  await wrapped("https://omniroute.example/v1/chat/completions");
  assert.deepEqual(seen, []);
});
