import { readFileSync } from "node:fs"
import { join } from "node:path"

import { NATIVE_TRAY_ACTIONS, isNativeTrayAction } from "./native-actions"

describe("NATIVE_TRAY_ACTIONS", () => {
  it("has no duplicates", () => {
    expect(new Set(NATIVE_TRAY_ACTIONS).size).toBe(NATIVE_TRAY_ACTIONS.length)
  })

  it("matches the Rust whitelist exactly", () => {
    // `src-tauri/src/tray/dto.rs:NATIVE_ACTIONS` is what the menu builder and
    // `tray_run_native_action` validate against. A TS entry missing there is
    // rejected at runtime with no compile-time signal — which is precisely the
    // failure this test exists to catch.
    const source = readFileSync(join(process.cwd(), "src-tauri/src/tray/dto.rs"), "utf8")
    const block = source.split("pub const NATIVE_ACTIONS: &[&str] = &[")[1]?.split("];")[0]
    expect(block).toBeDefined()
    const rust = Array.from(block!.matchAll(/"([a-z-]+)"/g)).map((m) => m[1])
    expect([...rust].sort()).toEqual([...NATIVE_TRAY_ACTIONS].sort())
  })

  it("includes the quick-panel toggle", () => {
    expect(NATIVE_TRAY_ACTIONS).toContain("tray-panel-toggle")
  })
})

describe("isNativeTrayAction", () => {
  it("accepts a known action and rejects anything else", () => {
    expect(isNativeTrayAction("show")).toBe(true)
    expect(isNativeTrayAction("tray-panel-toggle")).toBe(true)
    expect(isNativeTrayAction("self-destruct")).toBe(false)
    expect(isNativeTrayAction("")).toBe(false)
  })
})
