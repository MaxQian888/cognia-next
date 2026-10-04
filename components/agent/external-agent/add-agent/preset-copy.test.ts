import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/config/presets"

import {
  SUPPORT_TIER_LABEL_KEYS,
  presetDescription,
  presetEnvVarHint,
  presetName,
  presetSetupHint,
  supportTierLabel,
} from "./preset-copy"

const t = (key: string) => `t:${key}`

function preset(overrides: Partial<ExternalAgentPresetConfig> = {}): ExternalAgentPresetConfig {
  return {
    name: "Preset prose name",
    description: "Preset prose description",
    protocol: "acp",
    transport: "stdio",
    defaultPermissionMode: "default",
    tags: [],
    setupHint: "Preset prose setup",
    envVarHint: "Preset prose env",
    ...overrides,
  }
}

describe("presetSetupHint", () => {
  it.each([
    ["devin", "devinSetupHint"],
    ["aider", "aiderSetupHint"],
    ["qoder", "qoderSetupHint"],
    ["kimi", "kimiSetupHint"],
    ["cline", "clineSetupHint"],
    ["goose", "gooseSetupHint"],
  ])("uses the catalogue key for %s", (id, key) => {
    expect(presetSetupHint(t, id, preset())).toBe(`t:${key}`)
  })

  it("falls back to the preset's own prose for other ids", () => {
    expect(presetSetupHint(t, "claude-code", preset())).toBe("Preset prose setup")
  })

  it("returns undefined when the preset has no setup hint, even for a catalogued id", () => {
    expect(presetSetupHint(t, "devin", preset({ setupHint: undefined }))).toBeUndefined()
    expect(presetSetupHint(t, "claude-code", preset({ setupHint: undefined }))).toBeUndefined()
  })
})

describe("presetEnvVarHint", () => {
  it.each([
    ["aider", "aiderEnvVarHint"],
    ["qoder", "qoderEnvVarHint"],
    ["kimi", "kimiEnvVarHint"],
    ["cline", "clineEnvVarHint"],
    ["goose", "gooseEnvVarHint"],
  ])("uses the catalogue key for %s", (id, key) => {
    expect(presetEnvVarHint(t, id, preset())).toBe(`t:${key}`)
  })

  it("falls back to the preset's own prose for other ids (devin has no env key)", () => {
    expect(presetEnvVarHint(t, "devin", preset())).toBe("Preset prose env")
    expect(presetEnvVarHint(t, "codex", preset())).toBe("Preset prose env")
  })

  it("returns undefined when the preset has no env var hint", () => {
    expect(presetEnvVarHint(t, "aider", preset({ envVarHint: undefined }))).toBeUndefined()
    expect(presetEnvVarHint(t, "codex", preset({ envVarHint: undefined }))).toBeUndefined()
  })
})

describe("presetDescription", () => {
  it.each([
    ["opencode-v2-service", "opencodeV2PresetDescription"],
    ["devin", "devinPresetDescription"],
    ["aider", "aiderPresetDescription"],
    ["qoder", "qoderPresetDescription"],
    ["kimi", "kimiPresetDescription"],
    ["cline", "clinePresetDescription"],
    ["goose", "goosePresetDescription"],
  ])("uses the catalogue key for %s", (id, key) => {
    expect(presetDescription(t, id, preset())).toBe(`t:${key}`)
  })

  it("falls back to the preset's own description for other ids", () => {
    expect(presetDescription(t, "codex", preset())).toBe("Preset prose description")
  })
})

describe("presetName", () => {
  it("uses the catalogue key for opencode-v2-service", () => {
    expect(presetName(t, "opencode-v2-service", preset())).toBe("t:opencodeV2PresetName")
  })

  it("falls back to the preset's own name for other ids", () => {
    expect(presetName(t, "devin", preset())).toBe("Preset prose name")
  })
})

describe("catalogue keys exist", () => {
  // The helpers resolve through a lookup table, so lint:i18n cannot see the
  // keys. Pin that each one resolves in both locales.
  type Bundle = {
    externalAgent: { manager: Record<string, unknown>; settings: Record<string, unknown> }
  }
  const en = enMessages as unknown as Bundle
  const zh = zhMessages as unknown as Bundle

  const ids = ["devin", "aider", "qoder", "kimi", "cline", "goose", "opencode-v2-service"]

  it.each([
    ["en", en],
    ["zh-CN", zh],
  ])("every key a helper can return resolves in %s", (_locale, bundle) => {
    const manager = (key: string) => {
      const value = bundle.externalAgent.manager[key]
      expect(typeof value === "string" && value.length > 0).toBe(true)
      return String(value)
    }
    const settings = (key: string) => {
      const value = bundle.externalAgent.settings[key]
      expect(typeof value === "string" && value.length > 0).toBe(true)
      return String(value)
    }
    for (const id of ids) {
      presetSetupHint(manager, id, preset())
      presetEnvVarHint(manager, id, preset())
      presetDescription(settings, id, preset())
      presetName(settings, id, preset())
    }
  })
})

describe("supportTierLabel", () => {
  it("maps every tier to a key both locales translate", () => {
    const en = enMessages.externalAgent.supportTier as Record<string, string>
    const zh = zhMessages.externalAgent.supportTier as Record<string, string>
    for (const [tier, key] of Object.entries(SUPPORT_TIER_LABEL_KEYS)) {
      expect(supportTierLabel(t, tier as keyof typeof SUPPORT_TIER_LABEL_KEYS)).toBe(`t:${key}`)
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
      expect(en[key]).not.toBe(tier)
    }
  })
})
