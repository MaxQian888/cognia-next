import { APP_VERSION } from "@/lib/app-version"

import { formatDiagnostics, gatherDiagnostics, type DiagnosticsFacts } from "./app-facts"

function facts(overrides: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    name: "Cognia",
    version: "1.2.3",
    channel: "stable",
    commit: "abc1234",
    buildTime: "2026-06-11T00:00:00Z",
    tauri: "2.9.0",
    react: "19.0.0",
    engine: "Chromium 130",
    platform: "Win32",
    ...overrides,
  }
}

describe("formatDiagnostics", () => {
  it("renders a labelled block with the header line", () => {
    const text = formatDiagnostics(facts())
    expect(text.split("\n")[0]).toBe("Cognia 1.2.3 (stable)")
    expect(text).toContain("Commit:   abc1234")
    expect(text).toContain("Tauri:    2.9.0")
    expect(text).toContain("Engine:   Chromium 130")
  })

  it("substitutes an em-dash for empty / null fields", () => {
    const text = formatDiagnostics(facts({ commit: "", tauri: null, engine: null }))
    expect(text).toContain("Commit:   —")
    expect(text).toContain("Tauri:    —")
    expect(text).toContain("Engine:   —")
  })
})

describe("gatherDiagnostics (live)", () => {
  it("collects the running app facts from app-metadata", async () => {
    const live = await gatherDiagnostics()
    expect(live.name).toBe("Cognia")
    expect(live.version).toBe(APP_VERSION)
    // node test env: not Tauri, so the Tauri version resolves to null.
    expect(live.tauri).toBeNull()
    expect(typeof live.react).toBe("string")
    expect(typeof live.platform).toBe("string")
    expect(formatDiagnostics(live)).toContain(`Cognia ${APP_VERSION}`)
  })
})
