import {
  exportSettingsProfile,
  serializeSettingsProfile,
  importSettingsProfile,
  resetKeysForSection,
  buildResetPatch,
  SETTINGS_PROFILE_SCHEMA,
  SETTINGS_PROFILE_VERSION,
} from "./profile-transfer"
import { DEFAULTS } from "@/lib/db/settings"
import type { AppSettings } from "@/lib/claude/types"

const NOW = "2026-06-15T00:00:00.000Z"

function sampleSettings(): AppSettings {
  return {
    ...DEFAULTS,
    apiKey: "sk-ant-secret",
    apiBaseUrl: "https://proxy.example/key123",
    skillsShToken: "oidc-secret",
    installUuid: "install-123",
    updatedAt: 1234,
    theme: "dark",
    language: "zh-CN",
    providerSettings: {
      openai: { apiKey: "sk-openai", baseURL: "https://api.openai.com", enabled: true } as never,
    },
    customProviders: [
      { id: "x", customName: "X", baseURL: "https://x", apiKey: "secret", enabled: true } as never,
    ],
    webdavSync: {
      enabled: true,
      baseUrl: "https://dav",
      username: "u",
      rememberPassphrase: true,
    } as never,
    biometricRequiredFor: {
      deletePairing: false,
      exportBackup: true,
      revealSecrets: true,
      signOut: false,
    },
  }
}

describe("profile-transfer export", () => {
  it("strips top-level secret and identity keys", () => {
    const profile = exportSettingsProfile(sampleSettings(), NOW)
    expect(profile.schema).toBe(SETTINGS_PROFILE_SCHEMA)
    expect(profile.version).toBe(SETTINGS_PROFILE_VERSION)
    expect(profile.exportedAt).toBe(NOW)
    const s = profile.settings as Record<string, unknown>
    expect(s.apiKey).toBeUndefined()
    expect(s.apiBaseUrl).toBeUndefined()
    expect(s.skillsShToken).toBeUndefined()
    expect(s.id).toBeUndefined()
    expect(s.updatedAt).toBeUndefined()
    expect(s.installUuid).toBeUndefined()
  })

  it("keeps non-secret preferences", () => {
    const s = exportSettingsProfile(sampleSettings(), NOW).settings
    expect(s.theme).toBe("dark")
    expect(s.language).toBe("zh-CN")
    expect(s.biometricRequiredFor).toEqual({
      deletePairing: false,
      exportBackup: true,
      revealSecrets: true,
      signOut: false,
    })
  })

  it("recursively scrubs nested secrets (provider/custom/webdav)", () => {
    const s = exportSettingsProfile(sampleSettings(), NOW).settings as Record<string, never>
    const provider = (s.providerSettings as Record<string, Record<string, unknown>>).openai
    expect(provider.apiKey).toBeUndefined()
    expect(provider.baseURL).toBe("https://api.openai.com") // non-secret kept
    const custom = (s.customProviders as Record<string, unknown>[])[0]
    expect(custom.apiKey).toBeUndefined()
    expect(custom.customName).toBe("X")
    const webdav = s.webdavSync as Record<string, unknown>
    expect(webdav.rememberPassphrase).toBe(true) // boolean flag, not a secret → kept
    expect(webdav.baseUrl).toBe("https://dav")
  })

  it("serializes to valid JSON", () => {
    const json = serializeSettingsProfile(exportSettingsProfile(sampleSettings(), NOW))
    expect(() => JSON.parse(json)).not.toThrow()
    expect(JSON.parse(json).schema).toBe(SETTINGS_PROFILE_SCHEMA)
  })
})

describe("profile-transfer import", () => {
  function validJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schema: SETTINGS_PROFILE_SCHEMA,
      version: 1,
      exportedAt: NOW,
      settings: { theme: "dark", language: "en", ...overrides },
    })
  }

  it("rejects malformed JSON", () => {
    expect(importSettingsProfile("{not json")).toEqual({ ok: false, errorKey: "invalidJson" })
  })

  it("rejects the wrong schema", () => {
    const r = importSettingsProfile(JSON.stringify({ schema: "other", version: 1, settings: {} }))
    expect(r).toEqual({ ok: false, errorKey: "wrongSchema" })
  })

  it("rejects a missing version", () => {
    const r = importSettingsProfile(
      JSON.stringify({ schema: SETTINGS_PROFILE_SCHEMA, settings: {} })
    )
    expect(r).toEqual({ ok: false, errorKey: "missingVersion" })
  })

  it("rejects a version newer than supported", () => {
    const r = importSettingsProfile(
      JSON.stringify({ schema: SETTINGS_PROFILE_SCHEMA, version: 999, settings: { theme: "dark" } })
    )
    expect(r).toEqual({ ok: false, errorKey: "versionTooNew" })
  })

  it("accepts a valid profile and returns a patch", () => {
    const r = importSettingsProfile(validJson())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch.theme).toBe("dark")
      expect(r.patch.language).toBe("en")
    }
  })

  it("drops unknown and secret keys from the patch", () => {
    const r = importSettingsProfile(
      validJson({ apiKey: "smuggled", notARealKey: 1, skillsShToken: "x" })
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect("apiKey" in r.patch).toBe(false)
      expect("skillsShToken" in r.patch).toBe(false)
      expect("notARealKey" in r.patch).toBe(false)
    }
  })

  it("rejects an effectively empty profile", () => {
    const r = importSettingsProfile(validJson2())
    expect(r).toEqual({ ok: false, errorKey: "emptyProfile" })
  })

  function validJson2(): string {
    return JSON.stringify({
      schema: SETTINGS_PROFILE_SCHEMA,
      version: 1,
      settings: { apiKey: "only-a-secret" },
    })
  }

  it("round-trips export → import", () => {
    const profile = exportSettingsProfile(sampleSettings(), NOW)
    const r = importSettingsProfile(serializeSettingsProfile(profile))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patch.theme).toBe("dark")
  })
})

describe("profile-transfer reset", () => {
  it("maps known sections to their keys and unknown sections to undefined", () => {
    expect(resetKeysForSection("security")).toEqual(["biometricRequiredFor"])
    expect(resetKeysForSection("sandbox")).toContain("automationPolicy")
    expect(resetKeysForSection("general")).toBeUndefined()
  })

  it("buildResetPatch(keys) returns only those keys at default", () => {
    const patch = buildResetPatch(["biometricRequiredFor"])
    expect(Object.keys(patch)).toEqual(["biometricRequiredFor"])
    expect(patch.biometricRequiredFor).toEqual(DEFAULTS.biometricRequiredFor)
  })

  it("buildResetPatch() resets all preferences but keeps secrets/identity", () => {
    const patch = buildResetPatch() as Record<string, unknown>
    expect("apiKey" in patch).toBe(false)
    expect("apiBaseUrl" in patch).toBe(false)
    expect("id" in patch).toBe(false)
    expect("installUuid" in patch).toBe(false)
    expect(patch.theme).toBe(DEFAULTS.theme)
  })
})
