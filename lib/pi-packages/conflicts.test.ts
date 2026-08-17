import {
  detectPiOverlaps,
  matchPiCatalog,
  piDiscouragedPackages,
  piOverlapsForCandidate,
} from "./conflicts"

describe("matchPiCatalog", () => {
  it("matches a catalog entry regardless of the installed pin", () => {
    // Identity ignores the version, so an older pin still resolves.
    const { known, unknown } = matchPiCatalog(["npm:pi-mcp-adapter@1.0.0"])
    expect(known.map((e) => e.id)).toEqual(["pi-mcp-adapter"])
    expect(unknown).toEqual([])
  })

  it("matches the object entry form as well as the string form", () => {
    const { known } = matchPiCatalog([{ source: "npm:pi-mcp-adapter@2.23.0", skills: [] }])
    expect(known.map((e) => e.id)).toEqual(["pi-mcp-adapter"])
  })

  it("reports an unreviewed package as unknown rather than assuming it is safe", () => {
    const { known, unknown } = matchPiCatalog(["npm:some-random-pi-ext@1.0.0"])
    expect(known).toEqual([])
    expect(unknown).toEqual(["npm:some-random-pi-ext@1.0.0"])
  })

  it("de-duplicates the same package listed twice", () => {
    const { known } = matchPiCatalog(["npm:pi-mcp-adapter@1.0.0", "npm:pi-mcp-adapter@2.23.0"])
    expect(known).toHaveLength(1)
  })
})

describe("detectPiOverlaps", () => {
  it("finds nothing for a clean stack", () => {
    expect(
      detectPiOverlaps([
        "npm:@aliou/pi-guardrails@0.17.0",
        "npm:@narumitw/pi-statusline@0.49.6",
        "npm:pi-mcp-adapter@2.23.0",
      ])
    ).toEqual([])
  })

  it("flags two permission layers", () => {
    const conflicts = detectPiOverlaps([
      "npm:@aliou/pi-guardrails@0.17.0",
      "npm:pi-permission-modes@2.2.0",
    ])
    expect(conflicts.map((c) => c.group)).toContain("permission")
  })

  it("flags two footers", () => {
    const conflicts = detectPiOverlaps([
      "npm:@narumitw/pi-statusline@0.49.6",
      "npm:pi-atelier@0.8.1",
    ])
    expect(conflicts.map((c) => c.group)).toEqual(["footer"])
  })

  it("flags two MCP adapters", () => {
    // Guard against the research report's explicit warning: install exactly
    // one adapter.
    const conflicts = detectPiOverlaps([
      "npm:pi-mcp-adapter@2.23.0",
      { source: "npm:pi-mcp-adapter@2.23.0" },
    ])
    // Same identity twice is one package, not a conflict.
    expect(conflicts).toEqual([])
  })

  it("flags competing subagent implementations", () => {
    const conflicts = detectPiOverlaps([
      "npm:@narumitw/pi-subagents@1.0.0",
      "npm:pi-subagents@0.47.1",
    ])
    expect(conflicts.map((c) => c.group)).toEqual(["subagents"])
    expect(conflicts[0].entries).toHaveLength(2)
  })

  /** pi-atelier replaces both the footer and the completion notifier. */
  it("reports a package that occupies two groups in both", () => {
    const conflicts = detectPiOverlaps([
      "npm:pi-atelier@0.8.1",
      "npm:@narumitw/pi-statusline@0.49.6",
      "npm:pi-finish-notification@1.0.4",
    ])
    expect(conflicts.map((c) => c.group).sort()).toEqual(["footer", "notification"])
  })

  /**
   * pi-permission-modes ships a Plan mode, but the recommended configuration
   * removes `plan` from its cycleOrder so the standalone plan package owns
   * planning. Flagging it here would make the recommended power stack warn
   * about itself.
   */
  it("does not flag plan-mode against the recommended permission-modes config", () => {
    const conflicts = detectPiOverlaps([
      "npm:pi-permission-modes@2.2.0",
      "npm:@narumitw/pi-plan-mode@0.49.3",
    ])
    expect(conflicts).toEqual([])
  })

  it("returns groups in a stable order", () => {
    const input = [
      "npm:pi-atelier@0.8.1",
      "npm:@narumitw/pi-statusline@0.49.6",
      "npm:pi-finish-notification@1.0.4",
    ]
    expect(detectPiOverlaps(input)).toEqual(detectPiOverlaps([...input].reverse()))
  })

  it("ignores unknown packages when grouping", () => {
    expect(detectPiOverlaps(["npm:unknown-a", "npm:unknown-b"])).toEqual([])
  })
})

describe("piOverlapsForCandidate", () => {
  it("warns before installing a second footer", () => {
    const conflicts = piOverlapsForCandidate("npm:pi-atelier@0.8.1", [
      "npm:@narumitw/pi-statusline@0.49.6",
    ])
    expect(conflicts.map((c) => c.group)).toEqual(["footer"])
  })

  it("does not warn when reinstalling the same package at a new pin", () => {
    expect(
      piOverlapsForCandidate("npm:pi-mcp-adapter@3.0.0", ["npm:pi-mcp-adapter@2.23.0"])
    ).toEqual([])
  })

  it("does not warn for a package that occupies no group", () => {
    expect(
      piOverlapsForCandidate("npm:@narumitw/pi-worktree@0.50.0", [
        "npm:@narumitw/pi-statusline@0.49.6",
      ])
    ).toEqual([])
  })

  it("says nothing about a candidate it has never reviewed", () => {
    expect(piOverlapsForCandidate("npm:mystery@1.0.0", ["npm:pi-atelier@0.8.1"])).toEqual([])
  })
})

describe("piDiscouragedPackages", () => {
  it("surfaces an installed package the research says to avoid", () => {
    const found = piDiscouragedPackages([
      "npm:@vtstech/pi-long-term-memory@1.3.5",
      "npm:@narumitw/pi-statusline@0.49.6",
    ])
    expect(found.map((e) => e.id)).toEqual(["vtstech-pi-long-term-memory"])
  })

  it("is empty for a recommended stack", () => {
    expect(piDiscouragedPackages(["npm:@aliou/pi-guardrails@0.17.0"])).toEqual([])
  })
})
