import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RUNTIME_OPTIONS, RUNTIME_LABEL_KEYS, runtimeLabelKey } from "./runtime-options"
import { BUILTIN_EXECUTABLE_PRESET_IDS } from "@/lib/ai/agent/external/presets"

describe("runtime-options", () => {
  it("lists claude first, then every executable preset (in lock-step with the catalog)", () => {
    expect(RUNTIME_OPTIONS[0]).toBe("claude")
    expect(RUNTIME_OPTIONS).toEqual(["claude", ...BUILTIN_EXECUTABLE_PRESET_IDS])
  })

  it("has a label key for every runtime option (exhaustive)", () => {
    for (const runtime of RUNTIME_OPTIONS) {
      expect(RUNTIME_LABEL_KEYS[runtime]).toBeTruthy()
      expect(runtimeLabelKey(runtime)).toBe(RUNTIME_LABEL_KEYS[runtime])
    }
  })

  it("maps codex-app-server to a distinct label key", () => {
    expect(runtimeLabelKey("codex-app-server")).toBe("codexAppServer")
    expect(runtimeLabelKey("claude")).toBe("claude")
  })

  // This module documents itself as the shared source "so the two surfaces can
  // never drift" — but its only importer used to be this test. members.tsx kept
  // a byte-for-byte copy and teammate-config-dialog.tsx hard-coded 5 of the 13
  // runtimes (omitting codex-app-server, so opening the dialog on such a
  // teammate showed a Select with no matching item). The module existed, was
  // tested, and prevented nothing. Assert the importers, not just the exports.
  describe("both member editors consume this module", () => {
    const read = (file: string) => readFileSync(join(__dirname, file), "utf8")

    it.each(["members.tsx", "teammate-config-dialog.tsx"])("%s imports it", (file) => {
      const src = read(file)
      expect(src).toMatch(/from "\.\/runtime-options"/)
      // A local re-declaration is the drift this module exists to prevent.
      expect(src).not.toMatch(/const RUNTIME_OPTIONS\s*[:=]/)
      expect(src).not.toMatch(/const RUNTIME_LABEL_KEYS\s*[:=]/)
    })
  })
})
