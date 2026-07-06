import { defineCliTool } from "./define-cli-tool"

describe("defineCliTool", () => {
  it("returns the CLI tool definition unchanged (pure pass-through)", () => {
    const def = defineCliTool({
      name: "ripgrep_search",
      description: "Search files with ripgrep",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      binary: { kind: "requires", name: "rg" },
      argv: [{ literal: "--json" }, { param: "query" }],
      outputParse: "lines",
      successExitCodes: [0, 1],
    })
    expect(def).toMatchObject({ name: "ripgrep_search", binary: { kind: "requires", name: "rg" } })
    expect(def.argv).toHaveLength(2)
  })

  it("preserves object identity (no copy, no validation)", () => {
    const input = {
      name: "echo_tool",
      description: "echo",
      parameters: {},
      binary: { kind: "plugin-dir", relPath: "bin/echo" } as const,
      argv: [{ literal: "hi" }],
    }
    expect(defineCliTool(input)).toBe(input)
  })
})
