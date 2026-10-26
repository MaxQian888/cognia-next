import {
  catalogModelCapabilities,
  isValidExternalAgentSandboxHost,
  validateExternalAgentSandboxPolicy,
  elicitationFormSchemaSafetyError,
  AGENT_MODEL_ROLE_SLOT_LIMIT,
  normalizeAgentModelRoleOverrides,
} from "./external-agent"

describe("shared elicitation form safety", () => {
  it("rejects sensitive fields and malformed required lists before rendering or prompting", () => {
    expect(
      elicitationFormSchemaSafetyError({
        type: "object",
        properties: { password: { type: "string" } },
      })
    ).toMatch(/sensitive field/)
    expect(
      elicitationFormSchemaSafetyError({
        type: "object",
        properties: { name: { type: "string" } },
        required: "name",
      })
    ).toMatch(/required/)
    expect(
      elicitationFormSchemaSafetyError({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      })
    ).toBeNull()
  })
})

describe("catalogModelCapabilities", () => {
  it("projects a Pi/OMP model record", () => {
    expect(
      catalogModelCapabilities({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
      })
    ).toEqual({ contextWindow: 200_000, reasoning: true, vision: true })
  })

  it("reports a text-only, non-reasoning model as such", () => {
    expect(
      catalogModelCapabilities({ reasoning: false, input: ["text"], contextWindow: 64_000 })
    ).toEqual({ contextWindow: 64_000, reasoning: false, vision: false })
  })

  it("drops malformed fields instead of coercing them", () => {
    expect(
      catalogModelCapabilities({ reasoning: "yes", input: "image", contextWindow: null })
    ).toBeUndefined()
    expect(catalogModelCapabilities({ contextWindow: 0 })).toBeUndefined()
    expect(catalogModelCapabilities({ contextWindow: Number.NaN })).toBeUndefined()
  })

  it("returns undefined for a record that says nothing", () => {
    expect(catalogModelCapabilities({})).toBeUndefined()
  })
})

describe("external agent sandbox policy", () => {
  it.each([
    "api.example.com",
    "*.example.com",
    "localhost",
    " EXAMPLE.com ",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("accepts matcher-supported host %s", (host) => {
    expect(isValidExternalAgentSandboxHost(host)).toBe(true)
  })
  it.each([
    "",
    "*",
    "*example.com",
    "*.8.8.8.8",
    "https://example.com",
    "example.com/path",
    "example.com:443",
    "user@example.com",
    "a..b",
    "-a.com",
    "a_.com",
    "a\u0000.com",
    "[::1]",
    "::1%lo0",
    "example.com.",
  ])("rejects malformed host %s", (host) => {
    expect(isValidExternalAgentSandboxHost(host)).toBe(false)
  })
  it.each([
    undefined,
    {},
    { network: "full" },
    { network: "off" },
    { network: "allowlist", allowedHosts: [] },
    { network: "allowlist", allowedHosts: ["*.example.com"], readableScope: "workspace" },
  ])("accepts supported policy %j", (policy) => {
    expect(() => validateExternalAgentSandboxPolicy(policy)).not.toThrow()
  })
  it.each([
    null,
    [],
    { unsupported: true },
    { network: "invalid" },
    { readableScope: "all" },
    { allowedHosts: "example.com" },
    { allowedHosts: [2] },
    { allowedHosts: ["https://example.com"] },
  ])("rejects policy without widening %j", (policy) => {
    expect(() => validateExternalAgentSandboxPolicy(policy)).toThrow()
  })
})

describe("normalizeAgentModelRoleOverrides", () => {
  const binding = { providerId: "openai", modelId: "gpt-5-mini" }
  it("preserves v2 candidates and refuses malformed or legacy candidate policies", () => {
    const value = { version: 2, slots: {}, allowedSpawnModels: [binding] }
    expect(normalizeAgentModelRoleOverrides(value)).toEqual(value)
    for (const allowedSpawnModels of [
      null,
      {},
      [null],
      [{ modelId: "x" }],
      Array(33).fill(binding),
    ])
      expect(() => normalizeAgentModelRoleOverrides({ ...value, allowedSpawnModels })).toThrow()
    expect(() => normalizeAgentModelRoleOverrides({ ...value, version: 1 })).toThrow()
  })

  it("passes omitted and cleared values through", () => {
    expect(normalizeAgentModelRoleOverrides(undefined)).toBeUndefined()
    expect(normalizeAgentModelRoleOverrides(null)).toBeNull()
  })

  it("keeps an empty layer, explicit inheritance, and trimmed bindings with effort", () => {
    expect(normalizeAgentModelRoleOverrides({ version: 1, slots: {} })).toEqual({
      version: 1,
      slots: {},
    })
    expect(
      normalizeAgentModelRoleOverrides({
        version: 1,
        slots: {
          "subagent.default": {
            kind: "cognia",
            binding: { providerId: " openai ", modelId: "gpt-5-mini", accountId: null },
            reasoningEffort: "low",
          },
          "tier.haiku": { kind: "inherit-primary" },
          "aux.small": { kind: "cognia", binding },
        },
      })
    ).toEqual({
      version: 1,
      slots: {
        "subagent.default": {
          kind: "cognia",
          binding: { providerId: "openai", modelId: "gpt-5-mini", accountId: null },
          reasoningEffort: "low",
        },
        "tier.haiku": { kind: "inherit-primary" },
        "aux.small": { kind: "cognia", binding },
      },
    })
  })

  it.each([
    ["a non-object", "subagent.default"],
    ["an unknown version", { version: 3, slots: {} }],
    ["an extra top-level key", { version: 1, slots: {}, allowedModels: [] }],
    ["array slots", { version: 1, slots: [] }],
    [
      "an unknown slot shape",
      { version: 1, slots: { "agent.reviewer": { kind: "inherit-primary" } } },
    ],
    ["a path-like slot", { version: 1, slots: { "aux.../x": { kind: "inherit-primary" } } }],
    ["an unknown selection kind", { version: 1, slots: { "tier.opus": { kind: "native" } } }],
    [
      "extra keys on inherit-primary",
      { version: 1, slots: { "tier.opus": { kind: "inherit-primary", binding } } },
    ],
    [
      "a malformed binding",
      { version: 1, slots: { "tier.opus": { kind: "cognia", binding: { providerId: "x" } } } },
    ],
    [
      "a malformed effort",
      {
        version: 1,
        slots: { "tier.opus": { kind: "cognia", binding, reasoningEffort: "HIGH; rm" } },
      },
    ],
  ])("rejects %s instead of dropping it", (_label, value) => {
    expect(() => normalizeAgentModelRoleOverrides(value)).toThrow()
  })

  it("bounds the number of slots in one layer", () => {
    const slots = Object.fromEntries(
      Array.from({ length: AGENT_MODEL_ROLE_SLOT_LIMIT + 1 }, (_, i) => [
        `aux.slot-${i}`,
        { kind: "inherit-primary" },
      ])
    )
    expect(() => normalizeAgentModelRoleOverrides({ version: 1, slots })).toThrow(/Too many/)
  })
})
