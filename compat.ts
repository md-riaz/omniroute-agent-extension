import { createOmniExtension, type AgentHomeOptions, type OmniPI } from "./shared.ts";

const PI: AgentHomeOptions = {
  homeEnvVar: "PI_CODING_AGENT_DIR",
  defaultHome: "~/.pi/agent",
};

const PRIME: AgentHomeOptions = {
  homeEnvVar: "PRIME_AGENT_CODING_AGENT_DIR",
  defaultHome: "~/.prime/agent",
};

function resolveHost(): AgentHomeOptions {
  // Prime exports this variable, including when using its default agent home.
  return process.env.PRIME_AGENT_CODING_AGENT_DIR ? PRIME : PI;
}

export default async function (pi: OmniPI): Promise<void> {
  await createOmniExtension(pi, resolveHost());
}
