import { counterId, createMockTerminal, immediateSleep } from "./mock-shell"
import { parseStrixVersion, runPreflight } from "./preflight"

describe("parseStrixVersion", () => {
  it("extracts a version token", () => {
    expect(parseStrixVersion("strix, version 0.1.3")).toBe("0.1.3")
    expect(parseStrixVersion("0.2.0-beta.1")).toBe("0.2.0-beta.1")
    expect(parseStrixVersion("no version here")).toBeUndefined()
  })
})

describe("runPreflight", () => {
  const deps = () => ({ sleep: immediateSleep, now: () => 123, randomId: counterId(), pollMs: 0 })

  it("reports ready when docker + strix are present", async () => {
    const { terminal, killed } = createMockTerminal((inner) => {
      if (inner.includes("docker info")) return { exitCode: 0 }
      if (inner.includes("strix --version")) return { output: "strix, version 0.1.3", exitCode: 0 }
      return { exitCode: 0 }
    })
    const status = await runPreflight(terminal, deps())
    expect(status).toEqual({
      docker: true,
      strix: true,
      strixVersion: "0.1.3",
      checkedAt: 123,
    })
    expect(killed).toContain("sess-1")
  })

  it("reports docker down and strix missing", async () => {
    const { terminal } = createMockTerminal((inner) => {
      if (inner.includes("docker info")) return { exitCode: 1 }
      if (inner.includes("strix --version")) return { output: "command not found", exitCode: 127 }
      return { exitCode: 0 }
    })
    const status = await runPreflight(terminal, deps())
    expect(status.docker).toBe(false)
    expect(status.strix).toBe(false)
    expect(status.strixVersion).toBeUndefined()
  })
})
