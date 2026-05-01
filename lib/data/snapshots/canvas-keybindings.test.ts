import {
  CANVAS_KEYBINDINGS_LABEL_KEY,
  CANVAS_KEYBINDINGS_PERSIST_KEY,
  canvasKeybindingsSnapshot,
} from "./canvas-keybindings"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("canvasKeybindingsSnapshot", () => {
  it("declares the canvas keybindings persist + label keys", () => {
    expect(canvasKeybindingsSnapshot.key).toBe(CANVAS_KEYBINDINGS_PERSIST_KEY)
    expect(canvasKeybindingsSnapshot.labelKey).toBe(CANVAS_KEYBINDINGS_LABEL_KEY)
    expect(canvasKeybindingsSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures user overrides", () => {
    const payload = {
      state: { bindings: { save: "Ctrl+S", run: "Ctrl+Enter" } },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [CANVAS_KEYBINDINGS_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(canvasKeybindingsSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
