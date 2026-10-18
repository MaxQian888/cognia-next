import {
  catalogModelCapabilities,
  isValidExternalAgentSandboxHost,
  validateExternalAgentSandboxPolicy,
  elicitationFormSchemaSafetyError,
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
