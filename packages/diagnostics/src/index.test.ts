import * as diagnostics from "./index"

describe("@cognia/diagnostics public surface", () => {
  it("exports the constructor, the registry and its lookups", () => {
    expect(Object.keys(diagnostics).sort()).toEqual([
      "DIAGNOSTIC_ACTION_KINDS",
      "DIAGNOSTIC_CODES",
      "DIAGNOSTIC_CODE_IDS",
      "DIAGNOSTIC_SEVERITIES",
      "DIAGNOSTIC_SOURCES",
      "__resetDiagnosticSequenceForTesting",
      "actionI18nKey",
      "createDiagnostic",
      "isDiagnosticCode",
      "sourceI18nKey",
      "specForCode",
    ])
  })

  it("is importable without a DOM, React or an icon set", () => {
    // The package is consumed by lib/, by other packages and by the CLI. Icons
    // stay tokens (`spec.icon`) precisely so none of those pull lucide in.
    expect(typeof diagnostics.DIAGNOSTIC_CODES.timeout.icon).toBe("string")
    expect(
      diagnostics.createDiagnostic("timeout", { source: "chat", now: () => 0, id: "d1" }).code
    ).toBe("timeout")
  })
})
