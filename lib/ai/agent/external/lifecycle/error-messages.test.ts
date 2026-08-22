/** @jest-environment node */

import EN from "@/i18n/messages/en/externalAgent.json"
import ZH from "@/i18n/messages/zh-CN/externalAgent.json"
import {
  EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES,
  ExternalAgentLifecycleError,
} from "@/types/agent/external-agent-lifecycle"

import {
  ALL_LIFECYCLE_ERROR_KEYS,
  LIFECYCLE_ERROR_FALLBACK_KEY,
  LIFECYCLE_ERROR_MESSAGE_KEYS,
  LIFECYCLE_ERROR_NAMESPACE,
  lifecycleErrorKey,
  lifecycleErrorMessage,
} from "./error-messages"

/** A translator that echoes the key, so assertions name the lookup. */
const echo = (key: string) => key

function catalogue(source: Record<string, unknown>): Record<string, string> {
  const scope = source.lifecycleErrors
  return (scope ?? {}) as Record<string, string>
}

describe("code coverage", () => {
  it("maps every stable lifecycle code to a key", () => {
    for (const code of EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES) {
      expect(LIFECYCLE_ERROR_MESSAGE_KEYS[code]).toBeTruthy()
    }
    expect(Object.keys(LIFECYCLE_ERROR_MESSAGE_KEYS).sort()).toEqual(
      [...EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES].sort()
    )
  })

  it("never maps two codes to the same key", () => {
    const keys = Object.values(LIFECYCLE_ERROR_MESSAGE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("points at the namespace the settings pane scopes to", () => {
    expect(LIFECYCLE_ERROR_NAMESPACE).toBe("externalAgent.lifecycleErrors")
  })
})

describe.each([
  ["en", EN],
  ["zh-CN", ZH],
])("%s catalogue", (locale, source) => {
  const messages = catalogue(source as Record<string, unknown>)

  it("carries a string for every key this module can request", () => {
    // `lint:i18n` cannot see through the dynamic lookup in
    // `lifecycleErrorMessage`, so this is the guard that a new code ships with
    // a translation instead of rendering its own key at the user.
    for (const key of ALL_LIFECYCLE_ERROR_KEYS) {
      expect(typeof messages[key]).toBe("string")
      expect(messages[key].length).toBeGreaterThan(0)
    }
  })

  it("adds no key the module would never ask for", () => {
    expect(Object.keys(messages).sort()).toEqual([...ALL_LIFECYCLE_ERROR_KEYS].sort())
  })

  it("never leaks the raw code into the message", () => {
    for (const code of EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES) {
      expect(messages[LIFECYCLE_ERROR_MESSAGE_KEYS[code]]).not.toContain(code)
    }
    expect(locale).toBeTruthy()
  })
})

describe("lifecycleErrorMessage", () => {
  it("resolves a lifecycle error to its own key", () => {
    const error = new ExternalAgentLifecycleError("credential_missing", "no keyring entry", {
      slot: "apiKey",
    })
    expect(lifecycleErrorMessage(error, echo)).toBe("credentialMissing")
  })

  it("falls back for anything that is not a lifecycle error", () => {
    for (const value of [new TypeError("boom"), "a string", null, undefined, { code: "x" }]) {
      expect(lifecycleErrorMessage(value, echo)).toBe(LIFECYCLE_ERROR_FALLBACK_KEY)
    }
  })

  it("never surfaces the raw log message or the detail payload", () => {
    const error = new ExternalAgentLifecycleError(
      "integrity_failed",
      "artifact hashes to deadbeef, catalog says cafebabe",
      { runtimeId: "example" }
    )
    const rendered = lifecycleErrorMessage(error, (key) => catalogue(EN)[key])
    expect(rendered).not.toContain("deadbeef")
    expect(rendered).not.toContain("example")
  })
})

describe("lifecycleErrorKey", () => {
  it("returns the same key the message resolver uses", () => {
    for (const code of EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES) {
      expect(lifecycleErrorKey(code)).toBe(
        lifecycleErrorMessage(new ExternalAgentLifecycleError(code, "x"), echo)
      )
    }
  })
})
