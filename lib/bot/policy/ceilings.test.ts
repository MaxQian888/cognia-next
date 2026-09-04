import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

import { BOT_POLICY_LAYERS, allowsSelfTriggering, resolveBotPolicy } from "./ceilings"

function layers(...entries: Array<[(typeof BOT_POLICY_LAYERS)[number], PluginBotPolicyV1]>) {
  return entries.map(([name, policy]) => ({ name, policy }))
}

describe("resolveBotPolicy", () => {
  it("is empty when no layer has an opinion", () => {
    const resolved = resolveBotPolicy([{ name: "definition" }, { name: "installation" }])
    expect(resolved.policy).toEqual({})
    expect(resolved.provenance).toEqual({})
    expect(resolved.refusals).toEqual([])
  })

  it("takes the strictest authority and records which layer set it", () => {
    const resolved = resolveBotPolicy(
      layers(
        ["organization", { maxAuthority: "acceptEdits" }],
        ["installation", { maxAuthority: "plan" }]
      )
    )
    expect(resolved.policy.maxAuthority).toBe("plan")
    expect(resolved.provenance.maxAuthority).toBe("installation")
  })

  it("refuses an inner layer that tries to widen authority", () => {
    const resolved = resolveBotPolicy(
      layers(
        ["organization", { maxAuthority: "plan" }],
        ["request", { maxAuthority: "bypassPermissions" }]
      )
    )
    // The escalation is refused, never recorded as a value.
    expect(resolved.policy.maxAuthority).toBe("plan")
    expect(resolved.refusals).toContainEqual({ layer: "request", field: "maxAuthority" })
  })

  it("takes the strictest autonomy", () => {
    const resolved = resolveBotPolicy(
      layers(["definition", { maxAutonomy: "act" }], ["installation", { maxAutonomy: "confirm" }])
    )
    expect(resolved.policy.maxAutonomy).toBe("confirm")
  })

  it("lets autonomy cap authority in the same fold", () => {
    const resolved = resolveBotPolicy(
      layers(["definition", { maxAuthority: "bypassPermissions", maxAutonomy: "suggest" }])
    )
    // `suggest` cannot resolve past `plan`, so asking for both is not a way in.
    expect(resolved.policy.maxAuthority).toBe("plan")
  })

  it("leaves authority alone when autonomy is uncapped", () => {
    const resolved = resolveBotPolicy(
      layers(["definition", { maxAuthority: "acceptEdits", maxAutonomy: "autopilot" }])
    )
    expect(resolved.policy.maxAuthority).toBe("acceptEdits")
  })

  it("lets any layer require approval, and no layer take it back", () => {
    const resolved = resolveBotPolicy(
      layers(
        ["organization", { requireApprovalForWrites: true }],
        ["request", { requireApprovalForWrites: false }]
      )
    )
    expect(resolved.policy.requireApprovalForWrites).toBe(true)
    expect(resolved.refusals).toContainEqual({
      layer: "request",
      field: "requireApprovalForWrites",
    })
  })

  it("takes the smallest of every numeric ceiling", () => {
    const resolved = resolveBotPolicy(
      layers(
        ["organization", { maxRunDurationMs: 600_000, maxRunCostUsd: 5, maxConcurrentRuns: 4 }],
        ["installation", { maxRunDurationMs: 60_000, maxConcurrentRuns: 8 }]
      )
    )
    expect(resolved.policy.maxRunDurationMs).toBe(60_000)
    expect(resolved.policy.maxRunCostUsd).toBe(5)
    expect(resolved.policy.maxConcurrentRuns).toBe(4)
    expect(resolved.refusals).toContainEqual({ layer: "installation", field: "maxConcurrentRuns" })
  })

  it("keeps a ceiling nobody else mentioned", () => {
    const resolved = resolveBotPolicy(layers(["plugin", { maxRunCostUsd: 2 }]))
    expect(resolved.policy.maxRunCostUsd).toBe(2)
    expect(resolved.provenance.maxRunCostUsd).toBe("plugin")
  })

  it("needs every opinionated layer to allow self-triggering", () => {
    const allowed = resolveBotPolicy(
      layers(["definition", { allowSelfTriggering: true }], ["installation", {}])
    )
    expect(allowsSelfTriggering(allowed.policy)).toBe(true)

    const refused = resolveBotPolicy(
      layers(
        ["organization", { allowSelfTriggering: false }],
        ["installation", { allowSelfTriggering: true }]
      )
    )
    // A Bot answering its own comments is a loop, so a single objection wins.
    expect(allowsSelfTriggering(refused.policy)).toBe(false)
    expect(refused.refusals).toContainEqual({
      layer: "installation",
      field: "allowSelfTriggering",
    })
  })

  it("defaults self-triggering to off when nobody says anything", () => {
    const resolved = resolveBotPolicy(layers(["definition", { maxAutonomy: "act" }]))
    expect(allowsSelfTriggering(resolved.policy)).toBe(false)
  })

  it("is order-independent for the resulting ceiling", () => {
    const forward = resolveBotPolicy(
      layers(
        ["organization", { maxAuthority: "acceptEdits", maxRunCostUsd: 5 }],
        ["request", { maxAuthority: "plan", maxRunCostUsd: 1 }]
      )
    )
    const reversed = resolveBotPolicy(
      layers(
        ["request", { maxAuthority: "plan", maxRunCostUsd: 1 }],
        ["organization", { maxAuthority: "acceptEdits", maxRunCostUsd: 5 }]
      )
    )
    expect(forward.policy).toEqual(reversed.policy)
  })
})
