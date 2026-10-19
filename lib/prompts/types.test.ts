import { DEFAULT_PROMPT_MAX_CHARS, PROMPT_SCOPE_SPECIFICITY, definePrompt } from "./types"

const def = {
  id: "test.types",
  contractVersion: 1,
  kind: "feature-template" as const,
  group: "generation" as const,
  operation: "replace-template" as const,
  scopes: ["account" as const],
  activation: "next-operation" as const,
  risk: "ordinary" as const,
  hosts: ["app" as const],
  defaultBody: "Body",
  consumers: [],
}

describe("definePrompt", () => {
  it("fills the schema version and contract defaults", () => {
    expect(definePrompt(def)).toMatchObject({
      schemaVersion: 1,
      variables: [],
      requiredFragments: [],
      maxChars: DEFAULT_PROMPT_MAX_CHARS,
    })
  })

  it("refuses inconsistent scope declarations", () => {
    expect(() => definePrompt({ ...def, operation: "inspect-only" })).toThrow(/inspect-only/)
    expect(() => definePrompt({ ...def, scopes: [] })).toThrow(/at least one scope/)
  })
})

it("orders scopes from least to most specific", () => {
  expect(PROMPT_SCOPE_SPECIFICITY).toEqual(["account", "workspace", "agent", "session"])
})
