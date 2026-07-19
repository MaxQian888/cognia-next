import { EMPTY_DIAGNOSTICS, type DiagnosticCode } from "./types"

describe("diagnostics contract", () => {
  it("exposes the invalid-connection code and an empty aggregate", () => {
    const code: DiagnosticCode = "invalidConnection"

    expect(code).toBe("invalidConnection")
    expect(EMPTY_DIAGNOSTICS).toEqual({
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      byNodeId: {},
      byEdgeId: {},
    })
  })
})
