// DOM-less guards for the autostart control, split out of
// `autostart-control.test.ts`: that file is jsdom-docblocked, and from Node 26
// on jsdom's `window` is non-configurable, so `delete global.window` throws.
// This file runs in the `node` project, where there is genuinely no window.
import { broadcastAutostartChanged, onAutostartChanged } from "./autostart-control"

jest.mock("@/lib/tauri/autostart", () => ({
  isAutostartEnabled: jest.fn(),
  setAutostart: jest.fn(),
}))

describe("autostart-control DOM-less (SSR) guards", () => {
  it("has no window to begin with", () => {
    expect(typeof window).toBe("undefined")
  })

  it("broadcast + subscribe are inert with no window", () => {
    expect(() => broadcastAutostartChanged(true)).not.toThrow()
    const off = onAutostartChanged(() => {})
    expect(typeof off).toBe("function")
    expect(() => off()).not.toThrow()
  })
})
