/** Web-standalone → cloud-companion detection (ADR-0059 C1). */
import {
  buildTimeServerUrl,
  hasStoredWebPairing,
  hasWebCompanionTarget,
  WEB_COMPANION_CONFIG_KEY,
} from "./web-companion"

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

afterEach(() => {
  delete process.env[ENV_KEY]
  window.localStorage.clear()
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

  it("true for a complete stored pairing", () => {
    window.localStorage.setItem(
      WEB_COMPANION_CONFIG_KEY,
      JSON.stringify({ baseUrl: "https://s:7890", deviceJwt: "jwt" })
    )
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
      WEB_COMPANION_CONFIG_KEY,
      JSON.stringify({ baseUrl: "https://s:7890", deviceJwt: "jwt" })
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
