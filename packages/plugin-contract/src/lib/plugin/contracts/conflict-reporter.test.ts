import { reportRegistryConflict } from "./conflict-reporter"
import { getPluginPointDiagnostics, __resetDiagnosticsStoreForTesting } from "./diagnostics-store"

describe("reportRegistryConflict", () => {
  beforeEach(() => {
    __resetDiagnosticsStoreForTesting()
  })

  it("records one plugin.conflict.rejected diagnostic against the losing plugin", () => {
    reportRegistryConflict({
      pluginId: "loser",
      attemptedId: "format_code",
      registry: "tool",
      winnerPluginId: "winner",
    })

    const diagnostics = getPluginPointDiagnostics("loser")
    expect(diagnostics).toHaveLength(1)
    const [d] = diagnostics
    expect(d.code).toBe("plugin.conflict.rejected")
    expect(d.severity).toBe("warning")
    expect(d.pointKind).toBe("runtime")
    expect(d.pointId).toBe("format_code")
    expect(d.message).toContain("winner")
    expect(d.message).toContain("format_code")
  })

  it("names the winner generically when unknown", () => {
    reportRegistryConflict({ pluginId: "loser", attemptedId: "x", registry: "command" })
    const [d] = getPluginPointDiagnostics("loser")
    expect(d.message).toContain("another plugin")
  })

  it("does not attach a diagnostic to the winning plugin", () => {
    reportRegistryConflict({
      pluginId: "loser",
      attemptedId: "x",
      registry: "tool",
      winnerPluginId: "winner",
    })
    expect(getPluginPointDiagnostics("winner")).toEqual([])
  })
})
