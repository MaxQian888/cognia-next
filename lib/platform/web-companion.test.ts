/** @jest-environment jsdom */
/** Web-standalone → cloud-companion detection (ADR-0059 C1). */
import {
  buildTimeServerUrl,
  hasStoredWebPairing,
  hasWebCompanionTarget,
  WEB_COMPANION_CONFIG_KEY,
  WEB_COMPANION_TARGET_BOOK_KEY,
} from "./web-companion"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

afterEach(() => {
  delete process.env[ENV_KEY]
  window.localStorage.clear()
  clearActiveRuntimeTargetContext()
})

describe("buildTimeServerUrl", () => {
  it("null when unset or blank", () => {
    expect(buildTimeServerUrl()).toBeNull()
    process.env[ENV_KEY] = "   "
    expect(buildTimeServerUrl()).toBeNull()
  })

  it("normalizes trailing slashes", () => {
    process.env[ENV_KEY] = "https://cognia.example.com/"
    expect(buildTimeServerUrl()).toBe("https://cognia.example.com")
  })
})

describe("hasStoredWebPairing", () => {
  it("false with no row / malformed json / missing fields", () => {
    expect(hasStoredWebPairing()).toBe(false)
    window.localStorage.setItem(WEB_COMPANION_CONFIG_KEY, "{not json")
    expect(hasStoredWebPairing()).toBe(false)
    window.localStorage.setItem(WEB_COMPANION_CONFIG_KEY, JSON.stringify({ baseUrl: "x" }))
    expect(hasStoredWebPairing()).toBe(false)
  })

  it("invalidates a complete legacy bearer pairing", () => {
    window.localStorage.setItem(
      WEB_COMPANION_CONFIG_KEY,
      JSON.stringify({ baseUrl: "https://s:7890", deviceJwt: "jwt" })
    )
    expect(hasStoredWebPairing()).toBe(false)
    expect(window.localStorage.getItem(WEB_COMPANION_CONFIG_KEY)).toBeNull()
  })

  it("uses the active account target when a v2 multi-target book exists", () => {
    window.localStorage.setItem(
      WEB_COMPANION_TARGET_BOOK_KEY,
      JSON.stringify({
        version: 2,
        targets: {
          "acct_web:companion-one": {
            targetId: "companion-one",
            baseUrl: "https://one.example.com",
          },
        },
      })
    )
    setActiveRuntimeTargetContext("acct_web", "web-standalone")
    expect(hasStoredWebPairing()).toBe(false)

    setActiveRuntimeTargetContext("acct_web", "companion-one")
    expect(hasStoredWebPairing()).toBe(true)
  })
})

describe("hasWebCompanionTarget", () => {
  it("env OR stored pairing enables the target", () => {
    expect(hasWebCompanionTarget()).toBe(false)
    process.env[ENV_KEY] = "https://s:7890"
    expect(hasWebCompanionTarget()).toBe(true)
    delete process.env[ENV_KEY]
    window.localStorage.setItem(
      WEB_COMPANION_TARGET_BOOK_KEY,
      JSON.stringify({
        version: 2,
        targets: {
          "acct_web:companion-one": {
            targetId: "companion-one",
            baseUrl: "https://s:7890",
          },
        },
      })
    )
    expect(hasWebCompanionTarget()).toBe(true)
  })
})

describe("key parity", () => {
  it("matches the storage module's CONFIG_KEY", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.join(__dirname, "..", "tauri", "companion-storage.ts"),
      "utf8"
    )
    expect(source).toContain(`CONFIG_KEY = "${WEB_COMPANION_CONFIG_KEY}"`)
  })
})
