/**
 * @jest-environment node
 */

import { runtimeErrorParser } from "./runtime-error-parser"

describe("runtimeErrorParser", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["session e1a2b3c4 did not end within 30000ms", "sessionTimeout"],
    ["sidecar exited mid-run", "sidecarExited"],
    [
      'provider "openrouter" has no resolvable AI SDK protocol — set providerCredentials.protocol explicitly',
      "providerMisconfigured",
    ],
    ['model is required when provider is "anthropic"', "modelRequired"],
    ["plugin tool not found: my_custom_tool", "pluginToolMissing"],
    ["ai-sdk dispatch loop failed: provider key is missing", "dispatchFailed"],
    ["failed to dispatch the request", "dispatchFailed"],
  ]

  it.each(cases)("classifies %p as %p", (text, category) => {
    const result = runtimeErrorParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0]).toMatchObject({ kind: "category", category })
    expect(result!.nodes[1]).toMatchObject({ kind: "text", content: text })
  })

  it("returns null for unrelated errors", () => {
    expect(runtimeErrorParser.parse("ValueError: bad input")).toBeNull()
    expect(runtimeErrorParser.parse("ECONNREFUSED")).toBeNull()
  })
})
