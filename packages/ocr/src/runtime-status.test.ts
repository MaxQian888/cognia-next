import { staticRuntimeStatus } from "./runtime-status"
import type { OcrProvider } from "./types"

const provider: OcrProvider = {
  id: "native",
  label: "Native",
  category: "local",
  shells: { browser: false, tauri: true, capacitor: false },
  credentialKeys: [],
  async extract() {
    throw new Error("not used")
  },
}

describe("staticRuntimeStatus", () => {
  it("reports unsupported shells instead of claiming readiness", () => {
    expect(staticRuntimeStatus(provider, "web")).toEqual({
      providerId: "native",
      shellSupported: false,
      ready: false,
      reason: "unsupported-shell",
    })
  })

  it("reports shell-compatible providers ready when no host resolver exists", () => {
    expect(staticRuntimeStatus(provider, "tauri")).toMatchObject({ ready: true })
  })
})
