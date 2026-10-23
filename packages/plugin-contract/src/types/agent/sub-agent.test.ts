import { assertSubagentContextPolicy } from "./sub-agent"

describe("assertSubagentContextPolicy", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid token count %s",
    (compactAtTokens) => {
      expect(() => assertSubagentContextPolicy({ contextPolicy: { compactAtTokens } })).toThrow(
        TypeError
      )
    }
  )

  it("accepts inherited or explicitly bounded context", () => {
    expect(() => assertSubagentContextPolicy({})).not.toThrow()
    expect(() =>
      assertSubagentContextPolicy({ contextPolicy: { compactAtTokens: 64000 } })
    ).not.toThrow()
  })

  it.each([{ provider: "openai" as const }, { externalPresetId: "codex" }])(
    "rejects unsupported runtime override %s",
    (override) => {
      expect(() =>
        assertSubagentContextPolicy({ ...override, contextPolicy: { compactAtTokens: 64000 } })
      ).toThrow(/context policy is unavailable/)
    }
  )
})
