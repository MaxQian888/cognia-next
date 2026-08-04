/** @jest-environment node */
import { terminalLayout } from "./terminal-layout"

describe("terminalLayout", () => {
  it("uses the documented width breakpoints", () => {
    expect(terminalLayout(100, 24).tier).toBe("full")
    expect(terminalLayout(99, 24).tier).toBe("medium")
    expect(terminalLayout(60, 24).tier).toBe("medium")
    expect(terminalLayout(59, 24).tier).toBe("compact")
    expect(terminalLayout(40, 24).tier).toBe("compact")
    expect(terminalLayout(39, 24).tier).toBe("tiny")
  })

  it("enters the tiny emergency layout below 12 rows at any width", () => {
    expect(terminalLayout(160, 11)).toMatchObject({
      tier: "tiny",
      showBanner: false,
      showMascot: false,
      overlayFullscreen: true,
    })
  })

  it("assigns measured chrome budgets without starving the composer", () => {
    expect(terminalLayout(120, 50)).toMatchObject({ bannerDensity: "full", composerRows: 3 })
    expect(terminalLayout(80, 24)).toMatchObject({ bannerDensity: "medium", composerRows: 3 })
    expect(terminalLayout(50, 12)).toMatchObject({ bannerDensity: "compact", composerRows: 2 })
    expect(terminalLayout(20, 8).composerRows).toBeGreaterThanOrEqual(2)
  })
})
