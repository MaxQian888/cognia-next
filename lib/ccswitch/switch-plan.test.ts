import { planSwitch } from "./switch-plan"
import type { CcswitchProvider, SwitchScope } from "@/types/ccswitch"

function provider(overrides: Partial<CcswitchProvider>): CcswitchProvider {
  return {
    id: "p1",
    kind: "claude",
    name: "Anthropic Official",
    apiKey: "sk-ant-x",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  }
}

describe("planSwitch", () => {
  it("targets cognia-next and a supported agent", () => {
    const p = provider({})
    const scope: SwitchScope = { cognia: true, agents: ["claude-code"] }
    const plan = planSwitch(p, scope, {
      apiKey: "old-key",
      apiBaseUrl: "https://old",
      activeProviderId: "ccswitch:other",
    })

    expect(plan.cogniaChanges.apiKeyAfter).toBe("sk-ant-x")
    expect(plan.cogniaChanges.baseUrlAfter).toBe("https://api.anthropic.com")
    expect(plan.cogniaChanges.activeProviderIdAfter).toBe("ccswitch:claude:p1")
    expect(plan.cogniaChanges.restartSidecar).toBe(true)

    expect(plan.agentChanges).toHaveLength(1)
    const ac = plan.agentChanges[0]
    expect(ac.agentId).toBe("claude-code")
    expect(ac.unsupported).toBe(false)
    expect(ac.envUpdates).toEqual([
      { key: "ANTHROPIC_AUTH_TOKEN", value: null },
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-x" },
      { key: "ANTHROPIC_BASE_URL", value: "https://api.anthropic.com" },
    ])
  })

  it("marks unsupported agents (claude-desktop)", () => {
    const plan = planSwitch(provider({}), { cognia: true, agents: ["claude-desktop"] }, {})
    expect(plan.agentChanges[0].unsupported).toBe(true)
    expect(plan.agentChanges[0].envUpdates).toEqual([])
  })

  it("marks Gemini unsupported for an Anthropic source", () => {
    const patch = planSwitch(provider({}), { cognia: true, agents: ["gemini"] }, {}).agentChanges[0]
    expect(patch).toMatchObject({ unsupported: true, targetPath: null, envUpdates: [] })
  })

  it("emits opencode env updates with a derived __provider for the opencode agent", () => {
    const p = provider({ apiKey: "sk-ant-x", kind: "claude" })
    const plan = planSwitch(p, { cognia: true, agents: ["opencode"] }, {})
    const ac = plan.agentChanges[0]
    expect(ac.agentId).toBe("opencode")
    expect(ac.unsupported).toBe(false)
    expect(ac.targetPath).toBe("~/.local/share/opencode/auth.json")
    expect(ac.envUpdates).toEqual([
      { key: "OPENCODE_API_KEY", value: "sk-ant-x" },
      { key: "__provider", value: "anthropic" },
    ])
  })

  it("does not plan propagation for a source the SDK cannot switch", () => {
    const patch = planSwitch(
      provider({ kind: "codex" }),
      { cognia: true, agents: ["opencode"] },
      {}
    ).agentChanges[0]
    expect(patch).toMatchObject({ unsupported: true, targetPath: null, envUpdates: [] })
  })

  it("marks Codex unsupported for an Anthropic source", () => {
    const patch = planSwitch(provider({}), { cognia: true, agents: ["codex"] }, {}).agentChanges[0]
    expect(patch).toMatchObject({ unsupported: true, targetPath: null, envUpdates: [] })
  })

  it("does not clear unrelated Codex credentials for a keyless source", () => {
    const patch = planSwitch(
      provider({ apiKey: undefined }),
      { cognia: true, agents: ["codex"] },
      {}
    ).agentChanges[0]
    expect(patch).toMatchObject({ unsupported: true, envUpdates: [] })
  })

  it("emits null env values when the provider has no key/url", () => {
    const plan = planSwitch(
      provider({ apiKey: undefined, baseUrl: undefined }),
      { cognia: true, agents: ["claude-code"] },
      {}
    )
    expect(plan.agentChanges[0].envUpdates).toEqual([
      { key: "ANTHROPIC_AUTH_TOKEN", value: null },
      { key: "ANTHROPIC_API_KEY", value: null },
      { key: "ANTHROPIC_BASE_URL", value: null },
    ])
  })

  it("flags restartSidecar=false when nothing changes", () => {
    const p = provider({})
    const plan = planSwitch(
      p,
      { cognia: true, agents: [] },
      {
        apiKey: p.apiKey,
        apiBaseUrl: p.baseUrl,
      }
    )
    expect(plan.cogniaChanges.restartSidecar).toBe(false)
  })

  it("flags an official claude provider (no key) as a subscription switch", () => {
    const p = provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" })
    const plan = planSwitch(p, { cognia: true, agents: [] }, {})
    expect(plan.cogniaChanges.useSubscription).toBe(true)
    // The bearer is read at spawn — a subscription switch always restarts.
    expect(plan.cogniaChanges.restartSidecar).toBe(true)
  })

  it("keyed claude providers and keyless non-claude kinds are not subscription switches", () => {
    expect(
      planSwitch(provider({}), { cognia: true, agents: [] }, {}).cogniaChanges.useSubscription
    ).toBe(false)
    expect(
      planSwitch(provider({ apiKey: undefined, kind: "gemini" }), { cognia: true, agents: [] }, {})
        .cogniaChanges.useSubscription
    ).toBe(false)
  })
})

function updatesFor(agent: import("@/types/ccswitch").CcswitchAgentId, record: CcswitchProvider) {
  return planSwitch(record, { cognia: true, agents: [agent] }, {}).agentChanges[0].envUpdates
}
describe("agent patch formats", () => {
  it("envUpdatesForProvider strips whitespace-only fields to null (claude-code)", () => {
    const updates = updatesFor("claude-code", provider({ apiKey: "  ", baseUrl: "" }))
    expect(updates).toEqual([
      { key: "ANTHROPIC_AUTH_TOKEN", value: null },
      { key: "ANTHROPIC_API_KEY", value: null },
      { key: "ANTHROPIC_BASE_URL", value: null },
    ])
  })

  it("never remaps an Anthropic key to OPENAI_API_KEY", () => {
    expect(updatesFor("codex", provider({}))).toEqual([])
  })

  it("writes only the Anthropic credential entry for OpenCode", () => {
    expect(updatesFor("opencode", provider({ apiKey: "sk-x" }))).toEqual([
      { key: "OPENCODE_API_KEY", value: "sk-x" },
      { key: "__provider", value: "anthropic" },
    ])
  })

  it("marks only known writer targets supported", () => {
    const plan = planSwitch(
      provider({}),
      { cognia: true, agents: ["claude-code", "codex", "gemini", "opencode", "claude-desktop"] },
      {}
    )
    expect(plan.agentChanges.map((patch) => patch.unsupported)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ])
  })
})

it("does not propagate an Anthropic key into incompatible agent protocols", () => {
  const plan = planSwitch(provider({}), { cognia: true, agents: ["codex", "gemini"] }, {})
  expect(plan.agentChanges).toEqual([
    expect.objectContaining({ agentId: "codex", unsupported: true, envUpdates: [] }),
    expect.objectContaining({ agentId: "gemini", unsupported: true, envUpdates: [] }),
  ])
})
it("restarts when removing relay headers with unchanged credentials", () => {
  const p = provider({})
  const current = {
    apiKey: p.apiKey,
    apiBaseUrl: p.baseUrl,
    customHeaders: { "anthropic-beta": "context-1m-test" },
  }
  expect(planSwitch(p, { cognia: true, agents: [] }, current).cogniaChanges.restartSidecar).toBe(
    true
  )
})

it("does not restart for the same headers in a different insertion order", () => {
  const p = provider({ customHeaders: { "x-second": "two", "x-first": "one" } })
  expect(
    planSwitch(
      p,
      { cognia: true, agents: [] },
      {
        apiKey: p.apiKey,
        apiBaseUrl: p.baseUrl,
        customHeaders: { "x-first": "one", "x-second": "two" },
      }
    ).cogniaChanges.restartSidecar
  ).toBe(false)
})
