/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

import {
  LiveSmokeSettingsError,
  parseSettingsExport,
  prepareLiveSettings,
  withHarnessSwitches,
} from "./live-smoke-settings"

const EXPORT = {
  schema: "cognia-settings",
  version: 1,
  exportedAt: "2026-09-19T00:00:00.000Z",
  settings: {
    theme: "dark",
    // A hand-edited file cannot smuggle a key in: keys come from the environment only.
    apiKey: "top-level-secret",
    providerSettings: {
      openai: {
        providerId: "openai",
        enabled: true,
        defaultModel: "gpt-4o-mini",
        apiKey: "sk-in-file",
      },
      deepseek: { providerId: "deepseek", enabled: false, defaultModel: "deepseek-chat" },
    },
    modelMappings: [
      {
        id: "m",
        alias: "fast",
        providers: [{ providerId: "openai", modelId: "gpt-4o-mini" }],
        distribution: "priority",
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  },
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof LiveSmokeSettingsError ? error.code : "other"
  }
}

describe("parseSettingsExport", () => {
  it("keeps the provider configuration an export carries, over the app defaults", () => {
    const settings = parseSettingsExport(JSON.stringify(EXPORT))
    expect(settings.theme).toBe("dark")
    expect(settings.providerSettings?.openai).toMatchObject({
      enabled: true,
      defaultModel: "gpt-4o-mini",
    })
    expect(settings.modelMappings?.[0]?.alias).toBe("fast")
    // Defaults fill what the export does not name.
    expect(settings.routerFusion).toBeUndefined()
  })

  it("drops every secret-shaped value, including a key typed into the file", () => {
    const settings = parseSettingsExport(JSON.stringify(EXPORT))
    expect(settings.apiKey).toBeUndefined()
    expect(settings.providerSettings?.openai?.apiKey).toBeUndefined()
  })

  it("accepts a bare settings object", () => {
    const settings = parseSettingsExport(JSON.stringify(EXPORT.settings))
    expect(settings.providerSettings?.deepseek?.enabled).toBe(false)
  })

  it("refuses what is not a settings export", () => {
    expect(codeOf(() => parseSettingsExport("{nope"))).toBe("SETTINGS_NOT_JSON")
    expect(codeOf(() => parseSettingsExport("[]"))).toBe("SETTINGS_INVALID")
    expect(codeOf(() => parseSettingsExport(JSON.stringify({ ...EXPORT, schema: "other" })))).toBe(
      "SETTINGS_INVALID"
    )
    expect(codeOf(() => parseSettingsExport(JSON.stringify({ ...EXPORT, version: 99 })))).toBe(
      "SETTINGS_INVALID"
    )
    expect(codeOf(() => parseSettingsExport(JSON.stringify({ ...EXPORT, settings: "x" })))).toBe(
      "SETTINGS_INVALID"
    )
  })
})

describe("withHarnessSwitches", () => {
  it("switches Router + Fusion and the gateway-runs surface on in a copy", () => {
    const base = { routerFusion: { enabled: false, surfaces: { chat: true } } } as AppSettings
    const switched = withHarnessSwitches(base)
    expect(switched.routerFusion?.enabled).toBe(true)
    expect(switched.routerFusion?.surfaces).toMatchObject({ gatewayRuns: true, chat: true })
    expect(switched.routerFusion?.surfaces.companion).toBe(false)
    expect(base.routerFusion?.enabled).toBe(false)
  })
})

describe("prepareLiveSettings", () => {
  const base = parseSettingsExport(JSON.stringify(EXPORT))

  it("selects the enabled providers with a key, injects the key, and switches the rest off", () => {
    const prepared = prepareLiveSettings(base, {
      env: { COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-env" },
      requestedProviders: null,
    })
    expect(prepared.selected).toEqual(["openai"])
    expect(prepared.unknownRequested).toEqual([])
    const rows = prepared.appSettings.providerSettings ?? {}
    expect(rows.openai).toMatchObject({ enabled: true, apiKey: "sk-env" })
    expect(rows.anthropic?.enabled).toBe(false)
    expect(rows.deepseek?.enabled).toBe(false)
    // A catalog provider the export never mentioned is fenced off too.
    expect(Object.values(rows).filter((row) => row?.enabled === true)).toHaveLength(1)
    expect(prepared.appSettings.routerFusion?.enabled).toBe(true)
    // The parsed settings are untouched.
    expect(base.providerSettings?.openai?.apiKey).toBeUndefined()
  })

  it("selects exactly what --providers named, and reports what the settings do not configure", () => {
    const prepared = prepareLiveSettings(base, {
      env: {},
      requestedProviders: ["anthropic", "mistral-ai-unknown"],
    })
    expect(prepared.selected).toEqual(["anthropic"])
    expect(prepared.unknownRequested).toEqual(["mistral-ai-unknown"])
    expect(prepared.appSettings.providerSettings?.openai?.enabled).toBe(false)
  })
})
