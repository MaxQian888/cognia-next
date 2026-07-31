import { DEFAULT_UNIFIED_CONFIG } from "./types"
import {
  CRASH_LOG_KEY_HINTS,
  CRASH_LOG_TEXT_REDACTION_PATTERNS,
  DEFAULT_REDACTION_KEYS,
  DEFAULT_REDACTION_PATTERNS,
  DEFAULT_REDACTION_REPLACEMENT,
} from "./redaction-patterns"

describe("redaction-patterns", () => {
  it("backs the default logger redaction config from the shared constants", () => {
    expect(DEFAULT_UNIFIED_CONFIG.redaction.replacement).toBe(DEFAULT_REDACTION_REPLACEMENT)
    expect(DEFAULT_UNIFIED_CONFIG.redaction.redactKeys).toEqual([...DEFAULT_REDACTION_KEYS])
    expect(DEFAULT_UNIFIED_CONFIG.redaction.redactPatterns).toEqual([...DEFAULT_REDACTION_PATTERNS])
  })

  it("extends crash-log redaction without redefining default sensitive patterns", () => {
    expect(CRASH_LOG_TEXT_REDACTION_PATTERNS).toEqual(
      expect.arrayContaining([...DEFAULT_REDACTION_PATTERNS])
    )
    expect(CRASH_LOG_KEY_HINTS).toEqual(expect.arrayContaining([...DEFAULT_REDACTION_KEYS]))
  })
})
