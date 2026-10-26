import {
  freshInstallWebReader,
  legacyCompatibilityWebReader,
  normalizeWebReaderSettings,
  readerPolicyFromSettings,
  toReaderPolicy,
  WEB_READER_MIN_TIMEOUT_MS,
} from "./reader-settings"
import type { AppSettings } from "@cognia/agent-config-types"

describe("starting profiles", () => {
  it("fresh installs keep every remote recipient off", () => {
    const fresh = freshInstallWebReader()
    expect(fresh.externalFallback).toBe("off")
    expect(fresh.distillation).toBe("off")
    expect(fresh.readers.direct?.enabled).toBe(true)
    expect(fresh.readers.platform?.enabled).toBe(true)
    for (const id of ["fxtwitter", "jina", "tavily", "exa", "deepseek", "tinyfish"] as const) {
      expect(fresh.readers[id]?.enabled).toBe(false)
    }
  })

  it("upgrades preserve prior eligibility and enable no vendor reader", () => {
    const legacy = legacyCompatibilityWebReader({ enabled: true })
    expect(legacy.externalFallback).toBe("configured")
    expect(legacy.readers.jina?.enabled).toBe(true)
    expect(legacy.readers.fxtwitter?.enabled).toBe(true)
    for (const id of ["tavily", "exa", "deepseek", "tinyfish"] as const) {
      expect(legacy.readers[id]?.enabled).toBe(false)
    }
  })

  it("maps legacy alwaysDistill to required distillation", () => {
    expect(legacyCompatibilityWebReader({ enabled: true, alwaysDistill: true }).distillation).toBe(
      "required"
    )
  })
})

describe("normalizeWebReaderSettings", () => {
  it("decides fresh vs legacy from the row, not from merged defaults", () => {
    expect(normalizeWebReaderSettings(undefined, { rowExists: false }).source).toBe("fresh")
    const legacy = normalizeWebReaderSettings(undefined, {
      rowExists: true,
      webTools: { enabled: true, alwaysDistill: true },
    })
    expect(legacy.source).toBe("legacy")
    expect(legacy.effective.distillation).toBe("required")
  })

  it("treats an explicit record as authoritative and fills unlisted readers as off", () => {
    const r = normalizeWebReaderSettings(
      {
        version: 1,
        defaultReader: "tavily",
        readers: { tavily: { enabled: true, priority: 3 } },
        externalFallback: "configured",
        distillation: "best-effort",
        timeoutMs: 1,
        maxAttempts: 99,
      },
      { rowExists: true, webTools: { enabled: true, alwaysDistill: true } }
    )
    expect(r.source).toBe("explicit")
    expect(r.effective.defaultReader).toBe("tavily")
    expect(r.effective.distillation).toBe("best-effort")
    expect(r.effective.readers.tavily).toEqual({ enabled: true, priority: 3 })
    expect(r.effective.readers.jina?.enabled).toBe(false)
    expect(r.effective.readers.direct?.enabled).toBe(true)
    expect(r.effective.timeoutMs).toBe(WEB_READER_MIN_TIMEOUT_MS)
    expect(r.effective.maxAttempts).toBe(3)
  })

  it("rejects unknown enum values instead of activating them", () => {
    const r = normalizeWebReaderSettings(
      {
        version: 1,
        defaultReader: "carrier-pigeon",
        distillation: "always",
        externalFallback: "yes",
      },
      { rowExists: true }
    )
    expect(r.effective.defaultReader).toBe("auto")
    expect(r.effective.distillation).toBe("off")
    expect(r.effective.externalFallback).toBe("off")
  })

  it("preserves an unknown future version verbatim but never activates it", () => {
    const future = { version: 2, magic: true }
    const r = normalizeWebReaderSettings(future, { rowExists: true })
    expect(r.source).toBe("unsupported-version")
    expect(r.preserved).toBe(future)
    expect(r.effective).toEqual(legacyCompatibilityWebReader(undefined))
  })
})

describe("toReaderPolicy", () => {
  it("orders external readers by priority and excludes the platform-class FxTwitter", () => {
    const settings = freshInstallWebReader()
    settings.readers.exa = { enabled: true, priority: 1 }
    settings.readers.jina = { enabled: true, priority: 5 }
    settings.readers.fxtwitter = { enabled: true, priority: 0 }
    const policy = toReaderPolicy(settings)
    expect(policy.externalOrder).toEqual(["exa", "jina"])
    expect(policy.enabled.has("fxtwitter")).toBe(true)
  })

  it("changes its revision whenever routing could change", () => {
    const a = toReaderPolicy(freshInstallWebReader())
    const settings = freshInstallWebReader()
    settings.distillation = "required"
    expect(toReaderPolicy(settings).revision).not.toBe(a.revision)
  })

  it("reads a settings snapshot conservatively as an upgrade", () => {
    const policy = readerPolicyFromSettings({ webTools: { enabled: true } } as AppSettings)
    expect(policy.enabled.has("jina")).toBe(true)
    expect(policyFromExplicit().enabled.has("jina")).toBe(false)
  })
})

function policyFromExplicit() {
  return readerPolicyFromSettings({ webReader: freshInstallWebReader() } as AppSettings)
}
