import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { registerGatewayTelemetry } from "./telemetry.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Local CLI interface — no import from either CLI package ──────────────────
export interface OmniPI {
	registerProvider(name: string, config: any): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: any;
		execute(id: string, params: any, signal?: AbortSignal, onUpdate?: (p: any) => void, ctx?: any): Promise<any>;
	}): void;
	registerCommand(
		name: string,
		opts: {
			description: string;
			getArgumentCompletions?(prefix: string): { value: string; label: string }[];
			handler(args: string, ctx: any): Promise<void>;
		},
	): void;
	on(event: string, handler: (event: any, ctx: any) => any): void;
}

// ─── Public export ────────────────────────────────────────────────────────────
export interface AgentHomeOptions {
	homeEnvVar: string;
	defaultHome: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────
interface OmniConfig {
	serverUrl: string;
	apiKey: string;
	providerName: string;
	autoSyncIntervalMinutes?: number;
	includeModels?: string[];
	excludeModels?: string[];
}

interface OmniApiModel {
	id?: string;
	name?: string;
	owned_by?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
	reasoning?: boolean;
	capabilities?: { reasoning?: boolean; thinking?: boolean };
	input_modalities?: unknown;
	input?: unknown;
	output_modalities?: unknown;
	output?: unknown;
	// USD per million tokens, same units as Pi/Prime model cost.
	pricing?: { input?: number; output?: number; cached?: number; cache_creation?: number };
	type?: string;
	provider?: string;
}

type SyncedModel = {
	id: string;
	name: string;
	owned_by?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type ProviderModelConfig = {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────
const PROVIDER_API = "openai-completions";
const AUTO_MODELS = [
	"auto",
	"auto/coding",
	"auto/fast",
	"auto/cheap",
	"auto/offline",
	"auto/smart",
	"auto/lkgp",
	"auto/best-chat",
	"auto/best-coding",
	"auto/best-fast",
	"auto/best-vision",
	"auto/best-reasoning",
];
const PROVIDER_COMPAT = {
	sessionAffinityFormat: "openrouter",
	promptCacheSessionHeader: "x-session-id",
	supportsLongCacheRetention: true,
};
const EXTENSION_STATE_DIR = "omniroute-agent-extension";
const DEFAULT_CONFIG: OmniConfig = {
	serverUrl: "http://127.0.0.1:20128",
	apiKey: "",
	providerName: "omni",
	autoSyncIntervalMinutes: 0,
	includeModels: [],
	excludeModels: [],
};
const MIN_AUTO_SYNC_INTERVAL_MINUTES = 5;
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 60;
const MAX_TIMER_MINUTES = Math.floor(2_147_483_647 / 60_000);

// ─── Path helpers ─────────────────────────────────────────────────────────────
// Expands a leading `~/` (or bare `~`) the way Pi's own config resolver does,
// so an env value like `~/.pi-alt/agent` is not joined as a cwd-relative path.
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function resolveAgentHome(opts: AgentHomeOptions): string {
	const env = process.env[opts.homeEnvVar];
	if (env) return expandHome(env);
	const parts = opts.defaultHome.replace(/^~\//, "").split("/");
	return join(homedir(), ...parts);
}

function configPath(agentHome: string): string {
	return join(agentHome, EXTENSION_STATE_DIR, "config.json");
}

function modelsJsonPath(agentHome: string): string {
	return join(agentHome, "models.json");
}

// ─── Connection log (text file for infra debugging) ───────────────────────────
// Every health check and request that fails — and any health check that is
// abnormally slow — is appended as one JSON line per event, e.g.:
//   {"time":"...","event":"health","context":"interval","attempt":0,"ok":false,"ms":5194,"server":"https://...","error":"TimeoutError: The operation was aborted due to timeout"}
// Timings make server-side cold starts / edge latency visible; error fields
// (incl. fetch cause, e.g. ECONNRESET, ETIMEDOUT, TLS errors) distinguish
// server problems from local network issues. Capped to keep the file small.
const CONNECTION_LOG_MAX_BYTES = 256 * 1024;
const CONNECTION_LOG_MAX_LINES = 1000;
const CONNECTION_LOG_SLOW_MS = 1_000;

function connectionLogPath(agentHome: string): string {
	return join(agentHome, EXTENSION_STATE_DIR, "connection.log");
}

function errorBrief(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	const causeMsg = cause instanceof Error ? cause.message : undefined;
	return [err.name, err.message, causeMsg].filter(Boolean).join(": ");
}

function appendConnectionLog(agentHome: string, entry: Record<string, unknown>): void {
	try {
		const path = connectionLogPath(agentHome);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { flag: "a" });
		let size = 0;
		try {
			size = statSync(path).size;
		} catch {}
		if (size > CONNECTION_LOG_MAX_BYTES) {
			const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			writeFileSync(path, lines.slice(-CONNECTION_LOG_MAX_LINES).join("\n") + "\n");
		}
	} catch {
		// logging must never break normal operation
	}
}

// ─── Config I/O ───────────────────────────────────────────────────────────────
function normalizeServerUrl(value: string): string {
	let url = value.trim().replace(/\/+$/, "");
	if (url.endsWith("/v1")) url = url.slice(0, -3);
	return url || DEFAULT_CONFIG.serverUrl;
}

export function sanitizeAutoSyncIntervalMinutes(value: unknown): number {
	if (value === undefined || value === null || value === "") return 0;
	const n = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isFinite(n) || n < 0) return 0;
	if (n === 0) return 0;
	return Math.min(MAX_TIMER_MINUTES, Math.max(MIN_AUTO_SYNC_INTERVAL_MINUTES, Math.floor(n)));
}

function parseModelGlobs(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
	if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
	return [];
}

export function sanitizeConfig(input: Partial<OmniConfig>): OmniConfig {
	return {
		serverUrl: normalizeServerUrl(String(input.serverUrl || DEFAULT_CONFIG.serverUrl)),
		apiKey: String(input.apiKey ?? ""),
		providerName: String(input.providerName || DEFAULT_CONFIG.providerName).trim() || DEFAULT_CONFIG.providerName,
		autoSyncIntervalMinutes: sanitizeAutoSyncIntervalMinutes(
			process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES ?? input.autoSyncIntervalMinutes ?? DEFAULT_CONFIG.autoSyncIntervalMinutes,
		),
		includeModels: parseModelGlobs(process.env.OMNIROUTE_INCLUDE_MODELS ?? input.includeModels),
		excludeModels: parseModelGlobs(process.env.OMNIROUTE_EXCLUDE_MODELS ?? input.excludeModels),
	};
}

function loadConfig(agentHome: string): OmniConfig {
	const env: Partial<OmniConfig> = {};
	if (process.env.OMNIROUTE_URL) env.serverUrl = process.env.OMNIROUTE_URL;
	if (process.env.OMNIROUTE_API_KEY) env.apiKey = process.env.OMNIROUTE_API_KEY;
	if (process.env.OMNIROUTE_PROVIDER_NAME) env.providerName = process.env.OMNIROUTE_PROVIDER_NAME;
	if (process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES !== undefined) env.autoSyncIntervalMinutes = sanitizeAutoSyncIntervalMinutes(process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES);
	if (process.env.OMNIROUTE_INCLUDE_MODELS !== undefined) env.includeModels = parseModelGlobs(process.env.OMNIROUTE_INCLUDE_MODELS);
	if (process.env.OMNIROUTE_EXCLUDE_MODELS !== undefined) env.excludeModels = parseModelGlobs(process.env.OMNIROUTE_EXCLUDE_MODELS);
	try {
		return sanitizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath(agentHome), "utf8")), ...env });
	} catch {
		return sanitizeConfig({ ...DEFAULT_CONFIG, ...env });
	}
}

function saveConfig(agentHome: string, config: OmniConfig): void {
	const path = configPath(agentHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(sanitizeConfig(config), null, 2));
}

function readModelsJson(agentHome: string): any {
	try {
		return JSON.parse(readFileSync(modelsJsonPath(agentHome), "utf8"));
	} catch {
		return {};
	}
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function authHeaders(config: OmniConfig): Record<string, string> {
	return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

async function requestJson(config: OmniConfig, path: string, init: RequestInit = {}, timeoutMs = 10_000, agentHome?: string): Promise<any> {
	const started = Date.now();
	let res: Response;
	try {
		res = await fetch(`${config.serverUrl}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", ...authHeaders(config), ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		if (agentHome)
			appendConnectionLog(agentHome, {
				event: "request",
				path,
				ok: false,
				timeoutMs,
				ms: Date.now() - started,
				server: config.serverUrl,
				error: errorBrief(err),
			});
		throw err;
	}
	const text = await res.text();
	if (!res.ok) {
		if (agentHome)
			appendConnectionLog(agentHome, {
				event: "request",
				path,
				ok: false,
				ms: Date.now() - started,
				status: res.status,
				server: config.serverUrl,
				error: (text || res.statusText).slice(0, 200),
			});
		throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	}
	return text ? JSON.parse(text) : {};
}

// The origin can cold-start on the first request after idle (observed >5s
// via a proxy), so a tight timeout reports a false "unreachable" while real
// requests succeed. Match requestJson's 10s timeout and retry once: the first
// attempt warms the origin, the retry then succeeds in the common case.
export function isOmniRouteReachableHttpStatus(status: number): boolean {
	return Number.isFinite(status) && status > 0 && status < 500;
}

async function checkHealth(agentHome: string, config: OmniConfig, context = "health"): Promise<boolean> {
	const record = (ok: boolean, started: number, extra: Record<string, unknown>) =>
		appendConnectionLog(agentHome, { event: "health", context, ok, ms: Date.now() - started, server: config.serverUrl, ...extra });

	const pingStarted = Date.now();
	try {
		const ping = await fetch(`${config.serverUrl}/api/health/ping`, {
			headers: authHeaders(config),
			signal: AbortSignal.timeout(3_000),
		});
		try {
			await ping.body?.cancel();
		} catch {}
		if (ping.ok || ping.status === 401 || ping.status === 403) {
			if (Date.now() - pingStarted > CONNECTION_LOG_SLOW_MS || !ping.ok)
			record(true, pingStarted, {
				endpoint: "/api/health/ping",
				status: ping.status,
				error: ping.ok ? undefined : `HTTP ${ping.status} (reachable)`,
			});
			return true;
		}
		if (ping.status >= 500 || ping.status === 408) {
			record(false, pingStarted, {
				endpoint: "/api/health/ping",
				status: ping.status,
				error: (ping.statusText || `HTTP ${ping.status}`).slice(0, 200),
			});
			return false;
		}
	} catch {
		// Older OmniRoute servers may not have /api/health/ping. Fall back below.
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const started = Date.now();
		try {
			const res = await fetch(`${config.serverUrl}/v1/models`, {
				headers: authHeaders(config),
				signal: AbortSignal.timeout(10_000),
			});
			try {
				await res.body?.cancel();
			} catch {}
			if (isOmniRouteReachableHttpStatus(res.status)) {
				if (Date.now() - started > CONNECTION_LOG_SLOW_MS || !res.ok)
				record(true, started, {
					endpoint: "/v1/models",
					attempt,
					status: res.status,
					error: res.ok ? undefined : `HTTP ${res.status} (reachable)`,
				});
				return true;
			}
			record(false, started, {
				endpoint: "/v1/models",
				attempt,
				status: res.status,
				error: (res.statusText || `HTTP ${res.status}`).slice(0, 200),
			});
		} catch (err) {
			record(false, started, {
				endpoint: "/v1/models",
				attempt,
				error: errorBrief(err),
			});
		}
	}
	return false;
}

// ─── Model utilities ──────────────────────────────────────────────────────────
function normalizeModalities(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const normalized = String(item).trim().toLowerCase();
		if ((normalized === "text" || normalized === "image") && !out.includes(normalized)) out.push(normalized);
	}
	return out;
}

// OmniRoute reports per-model pricing in USD per million tokens, matching the
// host cost units. `cached` is a cache read; `cache_creation` is a cache write.
function normalizeCost(pricing: OmniApiModel["pricing"]): SyncedModel["cost"] | undefined {
	if (!pricing || typeof pricing !== "object") return undefined;
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
	return {
		input: num(pricing.input),
		output: num(pricing.output),
		cacheRead: num(pricing.cached),
		cacheWrite: num(pricing.cache_creation),
	};
}

function isPiChatModel(model: OmniApiModel): boolean {
	const output = normalizeModalities(model.output_modalities ?? model.output);
	if (String(model.type || "chat").toLowerCase() === "image") return false;
	return output.length === 0 || output.includes("text");
}

function upsertSyncedModel(models: SyncedModel[], next: SyncedModel): void {
	const index = models.findIndex((m) => m.id === next.id);
	if (index < 0) {
		models.push(next);
		return;
	}
	const existing = models[index];
	const input = Array.from(new Set([...(existing.input ?? []), ...(next.input ?? [])]));
	models[index] = {
		...existing,
		...next,
		input: input.length > 0 ? input : existing.input,
		contextWindow: next.contextWindow ?? existing.contextWindow,
		maxTokens: next.maxTokens ?? existing.maxTokens,
		reasoning: existing.reasoning || next.reasoning,
		cost: next.cost ?? existing.cost,
	};
}

function sortKey(id: string): string {
	const autoIdx = AUTO_MODELS.indexOf(id);
	if (autoIdx >= 0) return `0:${String(autoIdx).padStart(3, "0")}`;
	return `1:${id}`;
}

// ─── Sync + persistence ───────────────────────────────────────────────────────
async function fetchSyncedModels(config: OmniConfig, agentHome?: string): Promise<SyncedModel[]> {
	const data = await requestJson(config, "/v1/models", {}, 10_000, agentHome);
	const rawModels: any[] = Array.isArray(data?.data) ? data.data : [];
	const results: SyncedModel[] = [];

	for (const m of rawModels) {
		const id = typeof m === "string" ? m : m?.id;
		if (!id || !isPiChatModel(m)) continue;

		const synced: SyncedModel = { id, name: m.name ?? id, owned_by: m.owned_by };

		const input = normalizeModalities(m.input_modalities ?? m.input);
		synced.input = input.length > 0 ? input : ["text"];

		const contextWindow = m.context_length || m.max_input_tokens;
		if (contextWindow) synced.contextWindow = contextWindow;

		const maxTokens = m.max_output_tokens || m.max_tokens;
		if (maxTokens) synced.maxTokens = maxTokens;

		if (m.reasoning || m.capabilities?.reasoning || m.capabilities?.thinking) synced.reasoning = true;

		const cost = normalizeCost(m.pricing);
		if (cost) synced.cost = cost;

		upsertSyncedModel(results, synced);
	}

	return results
		.sort((a, b) => {
			const oa = a.owned_by || "zz";
			const ob = b.owned_by || "zz";
			if (oa !== ob) return oa.localeCompare(ob);
			return a.id.localeCompare(b.id);
		})
		.map(({ owned_by: _owned_by, ...rest }) => rest);
}

function buildProviderModelConfig(m: SyncedModel): ProviderModelConfig {
	return {
		id: m.id,
		name: m.name,
		api: PROVIDER_API,
		reasoning: m.reasoning ?? false,
		input: m.input ?? ["text"],
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 16_384,
	};
}

function buildAutoModel(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		api: PROVIDER_API,
		reasoning: id === "auto/coding" || id === "auto/smart",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function globMatches(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
	return new RegExp(`^${escaped}$`).test(value);
}

function shouldIncludeModel(id: string, config: OmniConfig): boolean {
	const includes = config.includeModels ?? [];
	const excludes = config.excludeModels ?? [];
	const isAuto = AUTO_MODELS.includes(id);
	if (!isAuto && includes.length > 0 && !includes.some((pattern) => globMatches(id, pattern))) return false;
	return !excludes.some((pattern) => globMatches(id, pattern));
}

async function discoverModels(config: OmniConfig, agentHome?: string): Promise<ProviderModelConfig[]> {
	const synced = (await fetchSyncedModels(config, agentHome)).filter((m) => shouldIncludeModel(m.id, config));
	const syncedIds = new Set(synced.map((m) => m.id));
	const autoModels = AUTO_MODELS.filter((id) => !syncedIds.has(id) && shouldIncludeModel(id, config)).map(buildAutoModel);
	return [...autoModels, ...synced.map(buildProviderModelConfig)];
}

function buildProviderEntry(config: OmniConfig, models: ProviderModelConfig[]): any {
	return {
		baseUrl: `${config.serverUrl}/v1`,
		apiKey: config.apiKey || "omniroute-public",
		api: PROVIDER_API,
		authHeader: true,
		compat: PROVIDER_COMPAT,
		models,
	};
}

function persistModelsJson(agentHome: string, config: OmniConfig, models: ProviderModelConfig[]): void {
	const path = modelsJsonPath(agentHome);
	let file: any = {};
	try {
		file = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	if (!file.providers) file.providers = {};
	file.providers[config.providerName] = buildProviderEntry(config, models);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(file, null, 2));
}

async function registerOmniProvider(pi: OmniPI, agentHome: string, config: OmniConfig): Promise<ProviderModelConfig[]> {
	const models = await discoverModels(config, agentHome);
	pi.registerProvider(config.providerName, buildProviderEntry(config, models));
	persistModelsJson(agentHome, config, models);
	return models;
}

export async function syncOmniModelsForAgentHome(pi: OmniPI, opts: AgentHomeOptions): Promise<number> {
	const agentHome = resolveAgentHome(opts);
	const config = loadConfig(agentHome);
	const models = await registerOmniProvider(pi, agentHome, config);
	return models.length;
}

function reloadProviderFromModelsJson(pi: OmniPI, agentHome: string, config: OmniConfig): void {
	try {
		const provider = readModelsJson(agentHome)?.providers?.[config.providerName];
		if (!provider) return;
		pi.registerProvider(config.providerName, {
			...provider,
			api: PROVIDER_API,
			models: Array.isArray(provider.models)
				? provider.models.map((model: any) => ({
						...model,
						api: PROVIDER_API,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...model.cost },
					}))
				: provider.models,
		});
	} catch {}
}

// ─── Display ──────────────────────────────────────────────────────────────────
function groupModels(models: ProviderModelConfig[]): Map<string, ProviderModelConfig[]> {
	const groups = new Map<string, ProviderModelConfig[]>();
	for (const m of models) {
		const group = AUTO_MODELS.includes(m.id) ? "auto" : m.id.includes("/") ? m.id.split("/")[0] : "direct";
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(m);
	}
	const entries = [...groups.entries()].sort(([a], [b]) => {
		if (a === "auto") return -1;
		if (b === "auto") return 1;
		return a.localeCompare(b);
	});
	return new Map(entries);
}

function modelLines(models: ProviderModelConfig[], query = "", limit = 80): string[] {
	const q = query.toLowerCase();
	const filtered = q ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : models;
	const sorted = [...filtered].sort((a, b) => sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id));
	const lines: string[] = [];
	for (const [group, gModels] of groupModels(sorted)) {
		lines.push(`-- ${group} (${gModels.length}) --`);
		for (const m of gModels) {
			const tags = [m.reasoning ? "reasoning" : "", m.input.includes("image") ? "vision" : ""].filter(Boolean).join(", ");
			lines.push(`  ${m.id} | ${m.contextWindow} ctx | ${m.maxTokens} out${tags ? ` | ${tags}` : ""}`);
			if (lines.length >= limit) break;
		}
		if (lines.length >= limit) break;
	}
	if (!filtered.length) lines.push("No models matched.");
	else if (filtered.length > limit) lines.push(`... ${filtered.length} total; refine with /omni models <search>`);
	return lines;
}

async function showStatus(ctx: any, agentHome: string, config: OmniConfig): Promise<void> {
	const ok = await checkHealth(agentHome, config, "status");
	const configured = existsSync(configPath(agentHome));
	ctx.ui.notify(
		[
			"OmniRoute Status",
			"",
			`Server:     ${config.serverUrl}`,
			`Provider:   ${config.providerName}`,
			`Health:     ${ok ? "reachable" : "unreachable"}`,
			`Configured: ${configured ? "yes" : "no — run /omni setup"}`,
		].join("\n"),
		ok ? "info" : "warning",
	);
}

function helpText(): string {
	return [
		"OmniRoute commands",
		"",
		"/omni                  Status",
		"/omni setup            Configure server URL and API key",
		"/omni sync             Sync models to Ctrl+P / /model picker",
		"/omni models [search]  Browse models",
		"/omni log [lines]      Show connection log (default 25)",
		"/omni test <model>     Smoke-test /v1/chat/completions",
		"/omni dashboard        Show OmniRoute dashboard URL",
		"/omni config           Show config paths and current settings",
		"/omni autosync [status|on|off|<minutes>]  Background model discovery while running",
		"/omni help             Show this help",
	].join("\n");
}

function parseAutoSyncIntervalMinutes(input: string): number | undefined {
	const value = input.trim().toLowerCase();
	if (!value) return undefined;
	const match = /^(\d+(?:\.\d+)?)(m|h)?$/.exec(value);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2] ?? "m";
	const minutes = unit === "h" ? amount * 60 : amount;
	return sanitizeAutoSyncIntervalMinutes(minutes);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function runSetup(ctx: any, pi: OmniPI, agentHome: string): Promise<OmniConfig | undefined> {
	const current = loadConfig(agentHome);
	const serverUrl = await ctx.ui.input("OmniRoute server URL", current.serverUrl);
	if (serverUrl === undefined) return undefined;
	const apiKey = await ctx.ui.input(
		"OmniRoute API key",
		current.apiKey ? "(press enter to keep current)" : "(optional — press enter to skip)",
	);
	if (apiKey === undefined) return undefined;

	const next = sanitizeConfig({ ...current, serverUrl, apiKey: apiKey || current.apiKey });

	if (!(await checkHealth(agentHome, next, "setup"))) {
		ctx.ui.notify(`Cannot reach ${next.serverUrl}/v1/models.`, "error");
		return undefined;
	}

	// 401/403 still counts as reachable. Persist only after registration
	// succeeds so a later auth failure does not leave a half-saved setup.
	const models = await registerOmniProvider(pi, agentHome, next);
	saveConfig(agentHome, next);
	;(ctx as any).modelRegistry?.refresh?.();
	ctx.ui.notify(`Saved. Synced ${models.length} model(s).`, "info");
	return next;
}

async function testChat(config: OmniConfig, model: string, agentHome?: string): Promise<string> {
	const data = await requestJson(
		config,
		"/v1/chat/completions",
		{
			method: "POST",
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "Reply with exactly: ok" }],
				stream: false,
				max_tokens: 8,
			}),
		},
		20_000,
		agentHome,
	);
	const content = data?.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : JSON.stringify(data).slice(0, 200);
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export async function createOmniExtension(pi: OmniPI, opts: AgentHomeOptions): Promise<void> {
	const agentHome = resolveAgentHome(opts);
	let config = loadConfig(agentHome);
	let healthTimer: ReturnType<typeof setInterval> | undefined;
	let autoSyncTimer: ReturnType<typeof setInterval> | undefined;
	let syncInFlight: Promise<number> | undefined;
	let sessionCtx: any | undefined;
	let lastSyncCount = 0;

	function formatAutoSync(intervalMinutes: number | undefined): string {
		const interval = sanitizeAutoSyncIntervalMinutes(intervalMinutes);
		return interval === 0 ? "off" : `every ${interval}m`;
	}

	async function sync(ctx?: any, options?: { quiet?: boolean }): Promise<number> {
		if (syncInFlight) return syncInFlight;
		syncInFlight = (async () => {
			try {
		config = loadConfig(agentHome);
		const models = await registerOmniProvider(pi, agentHome, config);
		const notifyCtx = ctx ?? sessionCtx;
		;(notifyCtx as any)?.modelRegistry?.refresh?.();
		if (options?.quiet !== true) notifyCtx?.ui.notify(`OmniRoute synced ${models.length} model(s).`, "info");
		else if (lastSyncCount > 0 && lastSyncCount !== models.length) {
			notifyCtx?.ui.notify(`OmniRoute auto-sync: catalog ${lastSyncCount} → ${models.length} model(s).`, "info");
		}
		lastSyncCount = models.length;
		return models.length;
			} finally {
				syncInFlight = undefined;
			}
		})();
		return syncInFlight;
	}

	function stopAutoSync(): void {
		if (autoSyncTimer) clearInterval(autoSyncTimer);
		autoSyncTimer = undefined;
	}

	function startAutoSync(ctx: any): void {
		stopAutoSync();
		sessionCtx = ctx;
		config = loadConfig(agentHome);
		const interval = sanitizeAutoSyncIntervalMinutes(config.autoSyncIntervalMinutes);
		if (interval === 0) return;
		autoSyncTimer = setInterval(() => {
			void sync(sessionCtx, { quiet: true }).catch((error) => {
				sessionCtx?.ui.setStatus("omni", "OmniRoute sync failed");
				sessionCtx?.ui.notify(`OmniRoute auto-sync failed: ${(error as Error).message}. Retry with /omni sync.`, "warning");
			});
		}, interval * 60_000);
	}

	// On load: re-register from existing models.json (no network call)
	reloadProviderFromModelsJson(pi, agentHome, config);
	registerGatewayTelemetry(pi, { getServerUrl: () => loadConfig(agentHome).serverUrl });

	pi.on("session_start", async (_event: any, ctx: any) => {
		sessionCtx = ctx;
		config = loadConfig(agentHome);
		if (!existsSync(configPath(agentHome)) && !process.env.OMNIROUTE_URL) {
			ctx.ui.setStatus("omni", "OmniRoute unconfigured");
			ctx.ui.notify("OmniRoute loaded. Run /omni setup to connect.", "warning");
			return;
		}
		const ok = await checkHealth(agentHome, config, "session_start");
		ctx.ui.setStatus("omni", ok ? undefined : "OmniRoute unreachable");
		if (!ok) ctx.ui.notify(`OmniRoute unreachable at ${config.serverUrl}. Run /omni sync after reconnecting.`, "warning");
		else void sync(ctx, { quiet: true }).catch(() => undefined);
		startAutoSync(ctx);
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = setInterval(async () => {
			ctx.ui.setStatus("omni", (await checkHealth(agentHome, loadConfig(agentHome), "interval")) ? undefined : "OmniRoute unreachable");
		}, 60_000);
	});

	pi.on("session_shutdown", () => {
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = undefined;
		stopAutoSync();
	});

	pi.on("model_select", async (event: any, ctx: any) => {
		const id = event.model?.id;
		if (id) ctx.ui.setStatus("omni", `→ ${id}`);
	});

	pi.registerTool({
		name: "omniroute_status",
		label: "OmniRoute Status",
		description: "Return OmniRoute health and provider registration status.",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const ok = await checkHealth(agentHome, cfg, "tool");
			const configured = existsSync(configPath(agentHome));
			return {
				content: [
					{
						type: "text" as const,
						text: `OmniRoute ${ok ? "reachable" : "unreachable"}; configured: ${configured}; provider: ${cfg.providerName}.`,
					},
				],
				details: { ok, configured, serverUrl: cfg.serverUrl, providerName: cfg.providerName },
			};
		},
	});

	pi.registerTool({
		name: "omniroute_sync",
		label: "OmniRoute Sync",
		description: "Fetch /v1/models from OmniRoute and register them as a provider.",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const models = await registerOmniProvider(pi, agentHome, cfg);
			return {
				content: [{ type: "text" as const, text: `OmniRoute synced ${models.length} model(s).` }],
				details: { count: models.length, provider: cfg.providerName },
			};
		},
	});

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [setup|sync|models|test|dashboard|config|log|autosync|help]",
		getArgumentCompletions(prefix: string) {
			return ["setup", "sync", "models", "test", "dashboard", "config", "log", "autosync", "help"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
		},
		async handler(args: string, ctx: any) {
			const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subRaw?.toLowerCase() ?? "";
			config = loadConfig(agentHome);

			try {
				if (!sub) return showStatus(ctx, agentHome, config);
				if (sub === "help") return ctx.ui.notify(helpText(), "info");

				if (sub === "setup") {
					const next = await runSetup(ctx, pi, agentHome);
					if (next) config = next;
					return;
				}

				if (sub === "sync") {
					await sync(ctx);
					startAutoSync(ctx);
					return;
				}

				if (sub === "autosync") {
					const action = rest.join(" ").trim().toLowerCase() || "status";
					if (process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES !== undefined && action !== "status") {
						return ctx.ui.notify(
							"OMNIROUTE_AUTO_SYNC_INTERVAL_MINUTES overrides /omni autosync. Unset it to change the interval.",
							"warning",
						);
					}
					if (action === "status") {
						return ctx.ui.notify(
							[`Auto-sync: ${formatAutoSync(config.autoSyncIntervalMinutes)}`, `Active:    ${autoSyncTimer ? "yes" : "no"}`].join("\n"),
							"info",
						);
					}
					let interval: number | undefined;
					if (action === "off" || action === "disable") interval = 0;
					else if (action === "on" || action === "enable") interval = DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
					else interval = parseAutoSyncIntervalMinutes(action);
					if (interval === undefined) return ctx.ui.notify("Usage: /omni autosync [status|on|off|<minutes>|<Nm|Nh>]", "warning");
					const next = sanitizeConfig({ ...config, autoSyncIntervalMinutes: interval });
					saveConfig(agentHome, next);
					config = next;
					startAutoSync(ctx);
					return ctx.ui.notify(`OmniRoute auto-sync set to ${formatAutoSync(next.autoSyncIntervalMinutes)}.`, "info");
				}

				if (sub === "models") {
					const models = await discoverModels(config, agentHome).catch(() => []);
					return ctx.ui.notify(
						[`OmniRoute models (${models.length})`, "", ...modelLines(models, rest.join(" "))].join("\n"),
						"info",
					);
				}

				if (sub === "log") {
					const n = Math.min(200, Math.max(1, parseInt(rest[0] ?? "25", 10) || 25));
					const path = connectionLogPath(agentHome);
					let lines: string[] = [];
					try {
						lines = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n);
					} catch {}
					if (!lines.length) return ctx.ui.notify(`No connection log entries at ${path} yet.`, "info");
					return ctx.ui.notify(
						[`OmniRoute connection log (${lines.length} shown, latest first):`, "", ...lines.reverse()].join("\n"),
						"info",
					);
				}

				if (sub === "test") {
					const model = rest.join(" ");
					if (!model) return ctx.ui.notify("Usage: /omni test <model>", "warning");
					const result = await testChat(config, model, agentHome);
					return ctx.ui.notify(`Test ${model}: ${result}`, "info");
				}

				if (sub === "dashboard" || sub === "dash") {
					return ctx.ui.notify(`OmniRoute dashboard: ${config.serverUrl}`, "info");
				}

				if (sub === "config") {
					return ctx.ui.notify(
						[
							`Config:   ${configPath(agentHome)}`,
							`Models:   ${modelsJsonPath(agentHome)}`,
							`Log:      ${connectionLogPath(agentHome)}`,
							`Configured: ${existsSync(configPath(agentHome)) ? "yes" : "no"}`,
							`Server:   ${config.serverUrl}`,
							`Provider: ${config.providerName}`,
							`Auto-sync: ${formatAutoSync(config.autoSyncIntervalMinutes)}`,
						].join("\n"),
						"info",
					);
				}

				ctx.ui.notify(`Unknown /omni command '${sub}'.\n\n${helpText()}`, "warning");
			} catch (error) {
				ctx.ui.notify(`OmniRoute error: ${(error as Error).message}`, "error");
			}
		},
	});
}
