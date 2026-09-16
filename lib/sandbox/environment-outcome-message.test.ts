/**
 * `next-intl` ships ESM Jest does not transform, and `getRuntimeTranslator` is
 * covered by its own suite. What this module is responsible for is WHICH key
 * each code maps to and that both locales carry it, so the translator is
 * replaced by one that looks the key up in the real English bundle.
 */

import en from "@/i18n/messages/en/projectEnvironment.json"
import zh from "@/i18n/messages/zh-CN/projectEnvironment.json"

function messageAt(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node === null || typeof node !== "object") return undefined
    return (node as Record<string, unknown>)[part]
  }, bundle)
}

jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async (namespace?: string) => {
    expect(namespace).toBe("projectEnvironment.outcome")
    return (key: string, values?: Record<string, unknown>) => {
      const message = messageAt(en.outcome, key)
      if (typeof message !== "string") return `projectEnvironment.outcome.${key}`
      // Only `hostFallback.unknown` interpolates, and asserting the value
      // reached the message is the point of that case.
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        message
      )
    }
  },
}))

import {
  ENVIRONMENT_MESSAGE_NAMESPACE,
  FALLBACK_KEYS,
  HOST_FALLBACK_KEYS,
  hostFallbackMessage,
  NOTICE_KEYS,
  noticeMessages,
  outcomeMessage,
  outcomeMessageKey,
  outcomeMessageValues,
  REFUSAL_KEYS,
} from "./environment-outcome-message"

describe("the message table", () => {
  // Working Rule 4. The build enforces exhaustiveness over the code unions;
  // this enforces that every key the table names actually exists in BOTH
  // locales, which the type system cannot see.
  it.each([
    ["refusals", REFUSAL_KEYS],
    ["fallbacks", FALLBACK_KEYS],
    ["notices", NOTICE_KEYS],
    ["host fallbacks", HOST_FALLBACK_KEYS],
  ])("has an en and a zh-CN message for every %s key", (_label, table) => {
    for (const key of Object.values(table as Record<string, string>)) {
      expect(typeof messageAt(en.outcome, key)).toBe("string")
      expect(typeof messageAt(zh.outcome, key)).toBe("string")
    }
  })

  it("has a message for a host fallback code it does not recognize", () => {
    expect(typeof messageAt(en.outcome, "hostFallback.unknown")).toBe("string")
    expect(typeof messageAt(zh.outcome, "hostFallback.unknown")).toBe("string")
  })

  it("names the namespace the keys are relative to", () => {
    expect(ENVIRONMENT_MESSAGE_NAMESPACE).toBe("projectEnvironment.outcome")
  })
})

describe("outcomeMessageKey", () => {
  it("has nothing to say about a run that was placed or never asked", () => {
    expect(outcomeMessageKey({ kind: "off" })).toBeUndefined()
    expect(
      outcomeMessageKey({
        kind: "placed",
        placement: { kind: "container", spec: {} as never, isolationMandatory: false },
        notices: [],
      })
    ).toBeUndefined()
  })

  it("maps a refusal and a fallback to their own keys", () => {
    expect(outcomeMessageKey({ kind: "refused", code: "gpu_not_supported", notices: [] })).toBe(
      "refused.gpuNotSupported"
    )
    expect(
      outcomeMessageKey({
        kind: "fallback",
        code: "sandbox_fallback_catalog_unreadable",
        notices: [],
      })
    ).toBe("fallback.catalogUnreadable")
  })
})

describe("rendering", () => {
  it("renders a refusal in the resolved locale", async () => {
    await expect(
      outcomeMessage({ kind: "refused", code: "local_container_unavailable", notices: [] })
    ).resolves.toBe(en.outcome.refused.localContainerUnavailable)
  })

  it("renders nothing for an outcome with nothing to say", async () => {
    await expect(outcomeMessage({ kind: "off" })).resolves.toBeUndefined()
  })

  it("renders every notice in order", async () => {
    await expect(
      noticeMessages([
        { code: "environment_approval_pending" },
        { code: "environment_declaration_restricted" },
      ])
    ).resolves.toEqual([en.outcome.notice.approvalPending, en.outcome.notice.declarationRestricted])
  })

  it("renders no notices without loading a bundle", async () => {
    await expect(noticeMessages([])).resolves.toEqual([])
  })

  // A newer Host can report a fault this build has no sentence for. Silence
  // would leave a person with an unsandboxed run and no explanation, so the
  // generic sentence carries the raw code.
  it("names an unrecognized host fallback code rather than saying nothing", async () => {
    await expect(hostFallbackMessage("sandbox_fallback_driver_unavailable")).resolves.toBe(
      en.outcome.hostFallback.driverUnavailable
    )
    await expect(hostFallbackMessage("sandbox_fallback_from_the_future")).resolves.toContain(
      "sandbox_fallback_from_the_future"
    )
  })
})

describe("outcomeMessageValues", () => {
  // ICU has no boolean argument type; a detail flag still reaches the message
  // as something `select` can match.
  it("passes strings and numbers through and spells booleans out", () => {
    expect(
      outcomeMessageValues({ path: ".cognia/workspace.json", count: 2, mandatory: true })
    ).toEqual({
      path: ".cognia/workspace.json",
      count: 2,
      mandatory: "true",
    })
    expect(outcomeMessageValues({ pinned: false })).toEqual({ pinned: "false" })
  })

  it("is empty for an outcome with no detail", () => {
    expect(outcomeMessageValues(undefined)).toEqual({})
  })
})
