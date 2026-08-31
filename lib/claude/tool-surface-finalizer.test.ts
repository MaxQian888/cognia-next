import { finalizeToolSurface } from "./tool-surface-finalizer"

describe("finalizeToolSurface", () => {
  it("re-applies an allow filter after late contributors add candidates", () => {
    expect(
      finalizeToolSurface(
        { allowedTools: ["Read", "surface_tool_x"] },
        { mode: "allow", tools: ["Read"] }
      )
    ).toEqual({ allowedTools: ["Read"] })
  })

  it("keeps deny entries authoritative over the allow list", () => {
    expect(
      finalizeToolSurface(
        { allowedTools: ["Bash", "Read"], disallowedTools: ["Bash"] },
        { mode: "all" }
      )
    ).toEqual({ allowedTools: ["Read"], disallowedTools: ["Bash"] })
  })

  it("uses the runtime deny-all contract when a restrictive intersection is empty", () => {
    expect(
      finalizeToolSurface({ allowedTools: ["Bash"] }, { mode: "allow", tools: ["Read"] })
    ).toEqual({ allowedTools: [], toolSurface: "none" })
  })
})
