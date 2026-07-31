import { TRANSIENT_ERROR_CLASSES } from "@cognia/provider-types/error-class"
import type { ProviderErrorClass } from "@cognia/provider-types/error-class"

import { DIAGNOSTIC_CODES } from "../registry"
import { PROVIDER_CLASS_TO_CODE, diagnoseProviderError } from "./from-provider-error-class"

const ALL_CLASSES: ProviderErrorClass[] = [
  "rate-limit",
  "timeout",
  "network",
  "server-error",
  "context-window-exceeded",
  "content-policy",
  "auth",
  "invalid-request",
  "unknown",
]

describe("PROVIDER_CLASS_TO_CODE", () => {
  it("maps every provider class", () => {
    expect(Object.keys(PROVIDER_CLASS_TO_CODE).sort()).toEqual([...ALL_CLASSES].sort())
  })

  it("maps onto codes the registry knows", () => {
    for (const code of Object.values(PROVIDER_CLASS_TO_CODE)) {
      expect(DIAGNOSTIC_CODES[code]).toBeDefined()
    }
  })

  it("agrees with the provider layer about which classes are worth retrying", () => {
    // If the two disagreed, a class the router keeps retrying would render a
    // dead card, or vice versa.
    for (const cls of ALL_CLASSES) {
      const spec = DIAGNOSTIC_CODES[PROVIDER_CLASS_TO_CODE[cls]]
      if (TRANSIENT_ERROR_CLASSES.has(cls)) expect(spec.retryable).toBe(true)
    }
  })

  it("keeps the two special classes distinct from generic retryables", () => {
    // A same-sized model fails a context overflow identically, and replaying a
    // filtered prompt trips the same filter — neither may offer a plain retry.
    expect(DIAGNOSTIC_CODES[PROVIDER_CLASS_TO_CODE["context-window-exceeded"]].retryable).toBe(
      false
    )
    expect(DIAGNOSTIC_CODES[PROVIDER_CLASS_TO_CODE["content-policy"]].retryable).toBe(false)
  })
})

describe("diagnoseProviderError", () => {
  it("carries the Retry-After hint the classifier extracted", () => {
    expect(diagnoseProviderError({ errorClass: "rate-limit", retryAfterMs: 30_000 })).toEqual({
      code: "rateLimited",
      meta: { retryAfterMs: 30_000 },
    })
  })

  it("folds the real HTTP status and provider identity into meta", () => {
    expect(
      diagnoseProviderError(
        { errorClass: "auth" },
        { httpStatus: 401, providerId: "anthropic", modelId: "claude-opus-5" }
      )
    ).toEqual({
      code: "unauthorized",
      meta: { httpStatus: 401, providerId: "anthropic", modelId: "claude-opus-5" },
    })
  })

  it("emits an empty meta rather than undefined keys when nothing is known", () => {
    expect(diagnoseProviderError({ errorClass: "unknown" })).toEqual({
      code: "unknown",
      meta: {},
    })
  })
})
