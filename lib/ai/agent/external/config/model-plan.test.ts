import type {
  AgentModelRoleOverrides,
  AgentModelSlotSelection,
  ExternalAgentCogniaModelBinding,
} from "@cognia/agent-contracts/model-binding"
import { contentDigest } from "@cognia/agent"
import type { AgentModelSlotDescriptor } from "./model-slots"
import { compileTaskModelPlan, mergeModelRoleLayers, configModelRolesApply } from "./model-plan"

const primary: ExternalAgentCogniaModelBinding = {
  providerId: "provider",
  modelId: "primary",
  accountId: "account",
}
const slots: AgentModelSlotDescriptor[] = [
  {
    id: "subagent.default",
    kind: "child-default",
    reasoningEfforts: ["low", "high"],
    evidence: "test",
  },
  { id: "aux.small", kind: "auxiliary", evidence: "test" },
  { id: "tier.opus", kind: "tier", evidence: "test" },
]
const choose = (
  modelId: string,
  reasoningEffort?: string,
  binding: Partial<ExternalAgentCogniaModelBinding> = {}
): AgentModelSlotSelection => ({
  kind: "cognia",
  binding: { providerId: primary.providerId, modelId, ...binding },
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
})
const overrides = (selections: AgentModelRoleOverrides["slots"]): AgentModelRoleOverrides => ({
  version: 1,
  slots: selections,
})
const compile = (selections: AgentModelRoleOverrides["slots"], extra = {}) =>
  compileTaskModelPlan({
    primary,
    slots,
    layers: [{ source: "config", overrides: overrides(selections) }],
    ...extra,
  })
const planOf = (result: ReturnType<typeof compileTaskModelPlan>) => {
  if (!result.ok) throw new Error(result.reason)
  return result.plan
}

describe("compileTaskModelPlan", () => {
  it("leaves unnamed slots absent and keeps only the primary for legacy tasks", () => {
    expect(
      planOf(compileTaskModelPlan({ primary, slots, layers: [{ source: "call" }] }))
    ).toMatchObject({
      version: 2,
      primaryModelId: "primary",
      slots: {},
      models: ["primary"],
    })
  })

  it("merges each slot in precedence order and deduplicates models in slot-id order", () => {
    const plan = planOf(
      compileTaskModelPlan({
        primary,
        slots,
        layers: [
          { source: "call", overrides: overrides({ "tier.opus": choose("primary") }) },
          { source: "subagent", overrides: overrides({ "subagent.default": choose("child") }) },
          {
            source: "config",
            overrides: overrides({
              "subagent.default": choose("ignored"),
              "aux.small": choose("small"),
              "tier.opus": choose("ignored"),
            }),
          },
        ],
      })
    )
    expect(plan.slots).toEqual({
      "aux.small": { modelId: "small", source: "config" },
      "subagent.default": { modelId: "child", source: "subagent" },
      "tier.opus": { modelId: "primary", source: "call" },
    })
    expect(plan.models).toEqual(["primary", "small", "child"])
    expect(
      planOf(compile({ "subagent.default": choose("same"), "aux.small": choose("same") })).models
    ).toEqual(["primary", "same"])
  })

  it("inherit-primary stops lookup and discards a shadowed effort and invalid binding", () => {
    const result = compileTaskModelPlan({
      primary,
      slots,
      layers: [
        {
          source: "call",
          overrides: overrides({ "subagent.default": { kind: "inherit-primary" } }),
        },
        {
          source: "config",
          overrides: overrides({
            "subagent.default": choose("ignored", "invalid", {
              providerId: "other",
              accountId: null,
            }),
          }),
        },
      ],
    })
    expect(planOf(result).slots).toEqual({
      "subagent.default": { modelId: "primary", source: "call" },
    })
  })

  it("never inherits reasoning effort from a lower selection", () => {
    const layers = [
      { source: "call" as const, overrides: overrides({ "subagent.default": choose("child") }) },
      {
        source: "config" as const,
        overrides: overrides({ "subagent.default": choose("old", "high") }),
      },
    ]
    expect(
      planOf(compileTaskModelPlan({ primary, slots, layers })).slots["subagent.default"]
    ).toEqual({ modelId: "child", source: "call" })
    layers[0].overrides = overrides({ "subagent.default": choose("child", "low") })
    expect(
      planOf(compileTaskModelPlan({ primary, slots, layers })).slots["subagent.default"]
        .reasoningEffort
    ).toBe("low")
  })

  it("refuses unsupported slots even in a shadowed lower layer", () => {
    expect(
      compileTaskModelPlan({
        primary,
        slots,
        layers: [
          { source: "call", overrides: overrides({ stale: { kind: "inherit-primary" } }) },
          { source: "config", overrides: overrides({ stale: choose("old") }) },
        ],
      })
    ).toEqual({ ok: false, reason: "unsupported-slot", slot: "stale" })
    expect(
      compileTaskModelPlan({
        primary,
        slots,
        layers: [
          { source: "call", overrides: overrides({ "subagent.default": choose("child") }) },
          { source: "config", overrides: overrides({ stale: choose("old") }) },
        ],
      })
    ).toEqual({ ok: false, reason: "unsupported-slot", slot: "stale" })
  })

  it("checks provider only on winning selections", () => {
    expect(
      compile({ "subagent.default": choose("child", undefined, { providerId: "other" }) })
    ).toEqual({ ok: false, reason: "cross-provider-unsupported", slot: "subagent.default" })
  })

  it.each([
    [undefined, "account", true],
    ["account", "account", true],
    [null, "account", false],
    ["other", "account", false],
    [undefined, null, true],
    [null, null, true],
    ["account", null, false],
    [null, undefined, false],
    ["account", undefined, false],
    [undefined, undefined, true],
  ])("validates account %s against primary %s", (accountId, primaryAccountId, accepted) => {
    const result = compile(
      { "subagent.default": choose("child", undefined, { accountId }) },
      { primary: { ...primary, accountId: primaryAccountId } }
    )
    if (accepted) expect(result.ok).toBe(true)
    else
      expect(result).toEqual({
        ok: false,
        reason: "cross-account-unsupported",
        slot: "subagent.default",
      })
  })

  it.each([
    ["aux.small", "low", undefined],
    ["subagent.default", "max", undefined],
    ["subagent.default", "", undefined],
    ["subagent.default", "high", false],
  ])("refuses unsupported effort for %s / %s / reasoning=%s", (slot, effort, supports) => {
    expect(
      compile({ [slot]: choose("child", effort) }, { modelSupportsReasoning: () => supports })
    ).toEqual({ ok: false, reason: "effort-unsupported", slot })
  })

  it("refuses an effort the chosen model itself rejects, even inside the slot ladder", () => {
    const strict = { modelEffortValues: () => ["medium", "high"] }
    expect(compile({ "subagent.default": choose("child", "low") }, strict)).toEqual({
      ok: false,
      reason: "effort-unsupported",
      slot: "subagent.default",
    })
    expect(compile({ "subagent.default": choose("child", "high") }, strict).ok).toBe(true)
    // No model-level table keeps only the slot ladder.
    expect(
      compile(
        { "subagent.default": choose("child", "low") },
        { modelEffortValues: () => undefined }
      ).ok
    ).toBe(true)
  })

  it.each([true, undefined])("accepts declared effort with reasoning=%s", (supports) => {
    const modelSupportsReasoning = jest.fn(() => supports)
    expect(
      planOf(compile({ "subagent.default": choose("child", "high") }, { modelSupportsReasoning }))
        .slots["subagent.default"].reasoningEffort
    ).toBe("high")
    expect(modelSupportsReasoning).toHaveBeenCalledWith("child")
  })

  it("does not require reasoning capability without an effort", () => {
    expect(
      compile({ "subagent.default": choose("child") }, { modelSupportsReasoning: () => false }).ok
    ).toBe(true)
  })

  it("fingerprints canonical routing values rather than insertion order or source", () => {
    const first = planOf(
      compile({ "subagent.default": choose("child", "high"), "aux.small": choose("small") })
    )
    const reordered = planOf(
      compileTaskModelPlan({
        primary,
        slots: [...slots].reverse(),
        layers: [
          {
            source: "call",
            overrides: overrides({
              "aux.small": choose("small"),
              "subagent.default": choose("child", "high"),
            }),
          },
        ],
      })
    )
    expect(first.fingerprint).toBe(reordered.fingerprint)
    expect(first.fingerprint).toBe(
      contentDigest({
        version: 2,
        primaryModelId: "primary",
        providerId: "provider",
        accountId: "account",
        slots: {
          "aux.small": { modelId: "small" },
          "subagent.default": { modelId: "child", reasoningEffort: "high" },
        },
      })
    )
    const changes: AgentModelRoleOverrides["slots"][] = [
      { "subagent.default": choose("changed", "high"), "aux.small": choose("small") },
      { "subagent.default": choose("child", "low"), "aux.small": choose("small") },
      { "subagent.default": choose("child"), "aux.small": choose("small") },
      { "subagent.default": choose("child", "high") },
    ]
    for (const selections of changes)
      expect(planOf(compile(selections)).fingerprint).not.toBe(first.fingerprint)
    const base = planOf(compile({})).fingerprint
    for (const changed of [
      { ...primary, modelId: "changed" },
      { ...primary, providerId: "changed" },
      { ...primary, accountId: undefined },
      { ...primary, accountId: null },
    ]) {
      expect(planOf(compile({}, { primary: changed })).fingerprint).not.toBe(base)
    }
    expect(
      planOf(compile({}, { primary: { ...primary, accountId: undefined } })).fingerprint
    ).not.toBe(planOf(compile({}, { primary: { ...primary, accountId: null } })).fingerprint)
  })

  it("allows 32 distinct models including primary and refuses the 33rd", () => {
    // Exercise the compiler bound with future descriptors, beyond today's five slot IDs.
    const expandedSlots = Array.from({ length: 40 }, (_, i) => ({
      id: `aux.${String(i).padStart(2, "0")}`,
      kind: "auxiliary",
      evidence: "test",
    })) as AgentModelSlotDescriptor[]
    const selections = Object.fromEntries(
      expandedSlots.slice(0, 31).map(({ id }, i) => [id, choose(`model-${i}`)])
    )
    expect(planOf(compile(selections, { slots: expandedSlots })).models).toHaveLength(32)
    selections[expandedSlots[31].id] = choose("model-31")
    expect(compile(selections, { slots: expandedSlots })).toMatchObject({
      ok: false,
      reason: "too-many-models",
    })
    for (const { id } of expandedSlots) selections[id] = choose("same")
    expect(planOf(compile(selections, { slots: expandedSlots })).models).toEqual([
      "primary",
      "same",
    ])
  })
})

describe("mergeModelRoleLayers", () => {
  it("merges slot by slot, lets inherit-primary win, and does not alias inputs", () => {
    const lower = overrides({ "subagent.default": choose("child"), "aux.small": choose("small") })
    const upper = overrides({ "subagent.default": { kind: "inherit-primary" } })
    const merged = mergeModelRoleLayers(undefined, upper, lower)!
    expect(merged).toEqual(
      overrides({ "subagent.default": { kind: "inherit-primary" }, "aux.small": choose("small") })
    )
    expect(merged.slots["aux.small"]).not.toBe(lower.slots["aux.small"])
    expect(mergeModelRoleLayers(undefined)).toBeUndefined()
  })
})

describe("configModelRolesApply", () => {
  const config = { providerId: "provider", modelId: "primary", accountId: "account" }

  it("applies when the turn follows the configuration's own binding", () => {
    expect(configModelRolesApply(config, undefined)).toBe(true)
    expect(configModelRolesApply(config, null)).toBe(true)
    expect(configModelRolesApply(config, { ...config, modelId: "other" })).toBe(true)
  })

  it("does not apply without a configuration binding or once the turn moves account or provider", () => {
    expect(configModelRolesApply(undefined, config)).toBe(false)
    expect(configModelRolesApply(null, undefined)).toBe(false)
    expect(configModelRolesApply(config, { ...config, providerId: "elsewhere" })).toBe(false)
    expect(configModelRolesApply(config, { ...config, accountId: "other" })).toBe(false)
    expect(configModelRolesApply(config, { ...config, accountId: null })).toBe(false)
  })

  it("lets a configuration that names no account follow the account its primary resolves to", () => {
    const { accountId: _account, ...followsActive } = config
    expect(configModelRolesApply(followsActive, followsActive)).toBe(true)
    // A later turn passes back the binding the lease resolved.
    expect(configModelRolesApply(followsActive, config)).toBe(true)
    expect(configModelRolesApply(followsActive, { ...config, accountId: null })).toBe(true)
    expect(configModelRolesApply(followsActive, { ...config, providerId: "elsewhere" })).toBe(false)
    // A configuration that names an account keeps to it.
    expect(configModelRolesApply(config, followsActive)).toBe(false)
  })
})
