import type { PersonAgentsManifest } from "@/lib/platform/host-feature-manifest"

import { personAgentSeed, personAllowance, personConversationAgent } from "./person-agent-choice"

const agents: PersonAgentsManifest = {
  allowedAgents: [
    { runtimeId: "claude-agent-acp", available: true, providers: ["deepseek", "anthropic"] },
    { runtimeId: "codex-acp", available: false, providers: [] },
  ],
  defaultAgent: "claude-agent-acp",
  execution: "sandboxed",
  models: { deepseek: ["ark-deepseek-v4.1-flash", "ark-deepseek-pro"], anthropic: [] },
  usage: { month: "2026-10", spentTokens: 300, reservedTokens: 100, monthlyTokens: 1000 },
}

const served = { providerOverride: "deepseek", model: "ark-deepseek-v4.1-flash" }

describe("personConversationAgent", () => {
  it("p6g takes the conversation's own agent, else the org default, else plain chat", () => {
    expect(
      personConversationAgent({ ...served, agentRuntimeId: "claude-agent-acp" }, agents)
    ).toEqual({ kind: "agent", runtimeId: "claude-agent-acp", explicit: true })
    expect(personConversationAgent(served, agents)).toEqual({
      kind: "agent",
      runtimeId: "claude-agent-acp",
      explicit: false,
    })
    expect(personConversationAgent(served, { ...agents, defaultAgent: null })).toEqual({
      kind: "chat",
    })
  })

  it("p6g names what the brain would refuse the turn for", () => {
    const problem = (session: Parameters<typeof personConversationAgent>[0], over = agents) => {
      const resolved = personConversationAgent(session, over)
      return resolved.kind === "agent" ? resolved.problem : "chat"
    }
    expect(problem({ ...served, agentRuntimeId: "pi" })).toBe("not-allowed")
    expect(problem(served, { ...agents, execution: "none" })).toBe("execution-unavailable")
    expect(problem({ ...served, agentRuntimeId: "codex-acp" })).toBe("no-key")
    expect(problem({ providerOverride: "openai", model: "gpt" })).toBe("model-not-served")
    expect(problem({ providerOverride: "deepseek", model: "not-served" })).toBe("model-not-served")
    expect(problem({ providerOverride: "deepseek" })).toBe("model-not-served")
    // An older Host sends no model list: only the provider is checked.
    expect(problem({ providerOverride: "deepseek", model: "x" }, { ...agents, models: {} })).toBe(
      undefined
    )
  })
})

describe("personAgentSeed", () => {
  it("p6g keeps a served provider and model, else takes the first one the org serves", () => {
    expect(personAgentSeed(agents, "claude-agent-acp", served)).toEqual({
      agentRuntimeId: "claude-agent-acp",
      ...served,
    })
    expect(
      personAgentSeed(agents, "claude-agent-acp", {
        providerOverride: "deepseek",
        model: "ark-deepseek-pro",
      })
    ).toMatchObject({ model: "ark-deepseek-pro" })
    expect(
      personAgentSeed(agents, "claude-agent-acp", { providerOverride: "openai", model: "gpt" })
    ).toEqual({ agentRuntimeId: "claude-agent-acp", ...served })
    expect(personAgentSeed(agents, "claude-agent-acp")).toEqual({
      agentRuntimeId: "claude-agent-acp",
      ...served,
    })
  })

  it("p6g offers no seed for an agent that cannot run", () => {
    expect(personAgentSeed(agents, "codex-acp")).toBeNull()
    expect(personAgentSeed(agents, "pi")).toBeNull()
    expect(personAgentSeed({ ...agents, execution: "none" }, "claude-agent-acp")).toBeNull()
    expect(personAgentSeed({ ...agents, models: {} }, "claude-agent-acp")).toBeNull()
  })
})

describe("personAllowance", () => {
  it("p6g counts running turns against what is left", () => {
    expect(personAllowance(agents)).toEqual({ kind: "left", tokens: 600, monthlyTokens: 1000 })
    expect(
      personAllowance({
        ...agents,
        usage: { month: "2026-10", spentTokens: 950, reservedTokens: 50, monthlyTokens: 1000 },
      })
    ).toEqual({ kind: "used-up", monthlyTokens: 1000 })
    expect(
      personAllowance({ ...agents, usage: { ...agents.usage!, monthlyTokens: null } })
    ).toEqual({ kind: "unlimited", spentTokens: 300 })
    expect(personAllowance({ ...agents, usage: null })).toEqual({ kind: "unknown" })
  })
})
