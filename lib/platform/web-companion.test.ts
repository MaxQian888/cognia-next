/** @jest-environment jsdom */
/** Web-standalone → cloud-companion detection (ADR-0059 C1). */
import {
  buildTimeServerUrl,
  hasStoredWebPairing,
  hasWebCompanionTarget,
  WEB_COMPANION_CONFIG_KEY,
  WEB_COMPANION_HOST_BOOK_KEY,
  WEB_COMPANION_TARGET_BOOK_KEY,
} from "./web-companion"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

/** Shape `LocalStorageHostRecordStore.write()` persists after a web pairing. */
function writeHostBook(
  entries: Array<{ accountNamespace: string; hostId: string; deviceKeyThumbprint?: string }>
): void {
  const hosts: Record<string, unknown> = {}
  for (const entry of entries) {
    const key = `${encodeURIComponent(entry.accountNamespace)}:${encodeURIComponent(entry.hostId)}`
    hosts[key] = {
      hostId: entry.hostId,
      accountNamespace: entry.accountNamespace,
      endpoints: { baseUrl: "https://brain.example:27890" },
      deviceId: "device-1",
      deviceKeyThumbprint: entry.deviceKeyThumbprint ?? "thumb-1",
      serverVersion: "1.0.0",
    }
  }
  window.localStorage.setItem(
    WEB_COMPANION_HOST_BOOK_KEY,
    JSON.stringify({ version: 2, hosts, active: {} })
  )
}

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

  // The regression this module existed to miss: `MigratingCompanionStorage`
  // writes the credential book and clears the legacy target book, so a pairing
  // made by the current code is ONLY visible in the host book. Reading the
  // legacy key alone made every web pairing vanish on the next page load.
  it("detects a pairing persisted by the credential book", () => {
    writeHostBook([{ accountNamespace: "acct_web", hostId: "companion-abc" }])
    expect(hasStoredWebPairing()).toBe(true)
    expect(hasWebCompanionTarget()).toBe(true)
  })

  it("scopes the host book to the active runtime target", () => {
    writeHostBook([{ accountNamespace: "acct_web", hostId: "companion-abc" }])
    setActiveRuntimeTargetContext("acct_web", "web-standalone")
    expect(hasStoredWebPairing()).toBe(false)

    setActiveRuntimeTargetContext("acct_web", "companion-abc")
    expect(hasStoredWebPairing()).toBe(true)
  })

  it("matches a host record filed under a different account namespace", () => {
    // The mobile pre-account path files pairings under `__local__`; the host id
    // is what the runtime target is keyed by, so the lookup must not depend on
    // the namespace half agreeing.
    writeHostBook([{ accountNamespace: "__local__", hostId: "companion-abc" }])
    setActiveRuntimeTargetContext("acct_web", "companion-abc")
    expect(hasStoredWebPairing()).toBe(true)
  })

  it("ignores a record with no registered device identity", () => {
    window.localStorage.setItem(
      WEB_COMPANION_HOST_BOOK_KEY,
      JSON.stringify({
        version: 2,
        hosts: { "acct_web:companion-abc": { hostId: "companion-abc" } },
        active: {},
      })
    )
    expect(hasStoredWebPairing()).toBe(false)
  })

  it("ignores an unsupported or malformed host book", () => {
    window.localStorage.setItem(WEB_COMPANION_HOST_BOOK_KEY, "{not json")
    expect(hasStoredWebPairing()).toBe(false)
    window.localStorage.setItem(
      WEB_COMPANION_HOST_BOOK_KEY,
      JSON.stringify({ version: 1, hosts: { a: { hostId: "a", deviceKeyThumbprint: "t" } } })
    )
    expect(hasStoredWebPairing()).toBe(false)
  })

  it("still honours the legacy v2 target book until it migrates away", () => {
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
    writeHostBook([{ accountNamespace: "acct_web", hostId: "companion-abc" }])
    expect(hasWebCompanionTarget()).toBe(true)
  })
})

describe("key parity", () => {
  it("matches the storage module's CONFIG_KEY and CONFIG_BOOK_KEY", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.join(__dirname, "..", "tauri", "companion-storage.ts"),
      "utf8"
    )
    expect(source).toContain(`CONFIG_KEY = "${WEB_COMPANION_CONFIG_KEY}"`)
    expect(source).toContain(`CONFIG_BOOK_KEY = "${WEB_COMPANION_TARGET_BOOK_KEY}"`)
  })

  it("matches the credential book's HOST_BOOK_KEY", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.join(__dirname, "..", "companion", "credential-book", "stores.ts"),
      "utf8"
    )
    expect(source).toContain(`HOST_BOOK_KEY = "${WEB_COMPANION_HOST_BOOK_KEY}"`)
  })
})
