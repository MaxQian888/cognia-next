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
})
