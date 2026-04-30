import {
  SUB_AGENT_STATUS_CONFIG,
  BACKGROUND_AGENT_STATUS_CONFIG,
  LOG_LEVEL_CONFIG,
  getSubAgentStatusConfig,
  getBackgroundAgentStatusConfig,
} from "./constants"

describe("agent status configs", () => {
  it("emits an i18n labelKey (not a hardcoded label) for every sub-agent status", () => {
    for (const config of Object.values(SUB_AGENT_STATUS_CONFIG)) {
      expect(typeof config.labelKey).toBe("string")
      expect(config.labelKey).not.toMatch(/\s/) // labelKeys are camelCase, no spaces
      expect(config.icon).toBeDefined()
      expect(config.color).toMatch(/^text-/)
      expect(config.bgColor).toMatch(/^bg-/)
    }
  })

  it("emits an i18n labelKey for every background-agent status", () => {
    for (const config of Object.values(BACKGROUND_AGENT_STATUS_CONFIG)) {
      expect(typeof config.labelKey).toBe("string")
      expect(config.labelKey).not.toMatch(/\s/)
      expect(config.icon).toBeDefined()
    }
  })

  it("LOG_LEVEL_CONFIG covers info/warn/error/debug/success", () => {
    for (const level of ["info", "warn", "error", "debug", "success"]) {
      expect(LOG_LEVEL_CONFIG[level]).toBeDefined()
      expect(LOG_LEVEL_CONFIG[level].icon).toBeDefined()
      expect(LOG_LEVEL_CONFIG[level].color).toMatch(/^text-/)
    }
  })
})

describe("getSubAgentStatusConfig", () => {
  it("returns the matching config for known statuses", () => {
    expect(getSubAgentStatusConfig("running")).toBe(SUB_AGENT_STATUS_CONFIG.running)
    expect(getSubAgentStatusConfig("completed")).toBe(SUB_AGENT_STATUS_CONFIG.completed)
  })

  it("falls back to `pending` for unknown statuses", () => {
    expect(getSubAgentStatusConfig("not-a-status")).toBe(SUB_AGENT_STATUS_CONFIG.pending)
    expect(getSubAgentStatusConfig("")).toBe(SUB_AGENT_STATUS_CONFIG.pending)
  })
})

describe("getBackgroundAgentStatusConfig", () => {
  it("returns the matching config for known statuses", () => {
    expect(getBackgroundAgentStatusConfig("running")).toBe(BACKGROUND_AGENT_STATUS_CONFIG.running)
    expect(getBackgroundAgentStatusConfig("idle")).toBe(BACKGROUND_AGENT_STATUS_CONFIG.idle)
  })

  it("falls back to `idle` for unknown statuses", () => {
    expect(getBackgroundAgentStatusConfig("not-a-status")).toBe(BACKGROUND_AGENT_STATUS_CONFIG.idle)
    expect(getBackgroundAgentStatusConfig("")).toBe(BACKGROUND_AGENT_STATUS_CONFIG.idle)
  })
})
