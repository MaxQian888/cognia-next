import {
  DIAGNOSTIC_ACTION_KINDS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  actionI18nKey,
  sourceI18nKey,
} from "./i18n-keys"
import { DIAGNOSTIC_CODES, DIAGNOSTIC_CODE_IDS } from "./registry"

describe("DIAGNOSTIC_ACTION_KINDS", () => {
  it("lists each kind exactly once", () => {
    expect(new Set(DIAGNOSTIC_ACTION_KINDS).size).toBe(DIAGNOSTIC_ACTION_KINDS.length)
  })

  it("covers every kind the registry actually emits", () => {
    // A registry action with no listed kind would render an unlabelled button.
    const emitted = new Set(
      DIAGNOSTIC_CODE_IDS.flatMap((code) => DIAGNOSTIC_CODES[code].actions.map((a) => a.kind))
    )
    const listed = new Set(DIAGNOSTIC_ACTION_KINDS)
    expect([...emitted].filter((kind) => !listed.has(kind))).toEqual([])
  })
})

describe("DIAGNOSTIC_SOURCES / DIAGNOSTIC_SEVERITIES", () => {
  it("list each member exactly once", () => {
    expect(new Set(DIAGNOSTIC_SOURCES).size).toBe(DIAGNOSTIC_SOURCES.length)
    expect(new Set(DIAGNOSTIC_SEVERITIES).size).toBe(DIAGNOSTIC_SEVERITIES.length)
  })
})

describe("actionI18nKey", () => {
  it("camelizes kebab-case discriminants", () => {
    expect(actionI18nKey("wait-and-retry")).toBe("waitAndRetry")
    expect(actionI18nKey("reconnect-external-agent")).toBe("reconnectExternalAgent")
  })

  it("leaves single-word kinds alone", () => {
    expect(actionI18nKey("retry")).toBe("retry")
    expect(actionI18nKey("dismiss")).toBe("dismiss")
  })

  it("produces a distinct key per kind", () => {
    const keys = DIAGNOSTIC_ACTION_KINDS.map(actionI18nKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("sourceI18nKey", () => {
  it("camelizes kebab-case sources", () => {
    expect(sourceI18nKey("agent-team")).toBe("agentTeam")
    expect(sourceI18nKey("external-agent")).toBe("externalAgent")
  })

  it("leaves single-word sources alone", () => {
    expect(sourceI18nKey("chat")).toBe("chat")
  })

  it("produces a distinct key per source", () => {
    const keys = DIAGNOSTIC_SOURCES.map(sourceI18nKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
