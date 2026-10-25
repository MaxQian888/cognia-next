import { fetchPersonAgentPolicy, resolvePersonAgent, type PersonAgentPolicy } from "./policy"

const policy: PersonAgentPolicy = {
  allowedAgents: [
    { runtimeId: "claude-agent-acp", available: true, providers: ["anthropic"] },
    { runtimeId: "codex-acp", available: false, providers: [] },
  ],
  defaultAgent: "claude-agent-acp",
  execution: "sandboxed",
  models: { anthropic: ["claude-sonnet-4-5"] },
  usage: { month: "2026-10", spentTokens: 10, reservedTokens: 0, monthlyTokens: 100 },
}

const session = { providerOverride: "anthropic", model: "claude-sonnet-4-5" }

describe("person agent policy", () => {
  it("p6e runs the session's agent, else the org default", () => {
    expect(
      resolvePersonAgent({ ...session, agentRuntimeId: "claude-agent-acp" }, policy, true)
    ).toEqual({
      kind: "agent",
      runtimeId: "claude-agent-acp",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    })
    expect(resolvePersonAgent(session, policy, false)).toMatchObject({
      kind: "agent",
      runtimeId: "claude-agent-acp",
    })
  })

  it("p6e stays tool-less chat with no agent and no default", () => {
    const noDefault = { ...policy, defaultAgent: null }
    expect(resolvePersonAgent(session, noDefault, true)).toEqual({ kind: "tool-less" })
    expect(resolvePersonAgent(session, noDefault, false)).toEqual({
      kind: "refused",
      code: "execution_isolation_unavailable",
    })
  })

  it("p6e never falls back from an agent the org does not allow", () => {
    expect(resolvePersonAgent({ ...session, agentRuntimeId: "pi" }, policy, true)).toEqual({
      kind: "refused",
      code: "org_agent_not_allowed",
    })
  })

  it("p6e refuses without execution or model access", () => {
    expect(resolvePersonAgent(session, { ...policy, execution: "none" }, true)).toEqual({
      kind: "refused",
      code: "execution_isolation_unavailable",
    })
    expect(resolvePersonAgent({ ...session, agentRuntimeId: "codex-acp" }, policy, true)).toEqual({
      kind: "refused",
      code: "model_access_unavailable",
    })
    for (const picks of [
      { providerOverride: "openai", model: "gpt" },
      { providerOverride: "anthropic" },
      { model: "claude-sonnet-4-5" },
    ]) {
      expect(resolvePersonAgent(picks, policy, true)).toEqual({
        kind: "refused",
        code: "model_access_unavailable",
      })
    }
  })

  it("p6e reads the Host policy and refuses a malformed answer", async () => {
    const call = jest.fn().mockResolvedValueOnce(policy).mockResolvedValueOnce({ allowedAgents: 1 })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toEqual(policy)
    expect(call).toHaveBeenCalledWith("person_agent_policy_get", {})
    await expect(fetchPersonAgentPolicy({ call })).rejects.toMatchObject({
      code: "execution_isolation_unavailable",
    })
  })

  it("p6g degrades a missing or malformed models map and usage to unknown", async () => {
    const { models: _models, usage: _usage, ...older } = policy
    const call = jest
      .fn()
      .mockResolvedValueOnce(older)
      .mockResolvedValueOnce({
        ...older,
        models: { anthropic: ["ok"], openai: "gpt", broken: [1] },
        usage: { month: "2026-10", spentTokens: -1, reservedTokens: 0, monthlyTokens: null },
      })
      .mockResolvedValueOnce({ ...policy, usage: { ...policy.usage, monthlyTokens: null } })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toEqual({
      ...older,
      models: {},
      usage: null,
    })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toEqual({
      ...older,
      models: { anthropic: ["ok"] },
      usage: null,
    })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toMatchObject({
      usage: { monthlyTokens: null },
    })
  })

  it("keeps the deployment's model names for served models only, and omits an empty map", async () => {
    const { usage: _usage, ...rest } = policy
    const call = jest
      .fn()
      .mockResolvedValueOnce({
        ...rest,
        usage: null,
        models: { anthropic: ["ok", "other"], openai: ["gpt"] },
        modelNames: {
          anthropic: { ok: "Okay Model", other: "", unserved: "Ghost" },
          openai: { gpt: "x".repeat(201) },
          broken: "nope",
          missing: { m: "Not served" },
        },
      })
      .mockResolvedValueOnce({ ...rest, usage: null, models: { anthropic: ["ok"] } })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toMatchObject({
      models: { anthropic: ["ok", "other"], openai: ["gpt"] },
      modelNames: { anthropic: { ok: "Okay Model" } },
    })
    // A Host that sends none leaves the field out, as an older Host's manifest has it.
    const plain = await fetchPersonAgentPolicy({ call })
    expect("modelNames" in plain).toBe(false)
  })
})
