/**
 * The vocabulary's one piece of behaviour: a registration may make itself
 * stricter than its point, never looser.
 */

import {
  INTERCEPTOR_TRUST_ORDER,
  InterceptorFailClosedError,
  InterceptorGuardDeniedError,
  InterceptorNextReentryError,
  InterceptorReentrancyError,
  InterceptorRevokedError,
  resolveFailurePolicy,
} from "./types"

describe("resolveFailurePolicy", () => {
  it("keeps the point's policy when the registration asks for nothing", () => {
    expect(resolveFailurePolicy("fail-open", undefined)).toBe("fail-open")
    expect(resolveFailurePolicy("fail-closed", undefined)).toBe("fail-closed")
  })

  it("accepts a stricter request", () => {
    expect(resolveFailurePolicy("fail-open", "require-approval")).toBe("require-approval")
    expect(resolveFailurePolicy("fail-open", "fail-closed")).toBe("fail-closed")
    expect(resolveFailurePolicy("require-approval", "fail-closed")).toBe("fail-closed")
  })

  it("refuses a looser request — a plugin cannot opt out of a safety gate", () => {
    expect(resolveFailurePolicy("fail-closed", "fail-open")).toBe("fail-closed")
    expect(resolveFailurePolicy("fail-closed", "require-approval")).toBe("fail-closed")
    expect(resolveFailurePolicy("require-approval", "fail-open")).toBe("require-approval")
  })
})

describe("INTERCEPTOR_TRUST_ORDER", () => {
  it("ranks builtin outermost and community innermost", () => {
    expect(INTERCEPTOR_TRUST_ORDER.builtin).toBeLessThan(INTERCEPTOR_TRUST_ORDER.verified)
    expect(INTERCEPTOR_TRUST_ORDER.verified).toBeLessThan(INTERCEPTOR_TRUST_ORDER.community)
  })
})

describe("structured errors", () => {
  it("each carries its own name so a catch can tell them apart", () => {
    expect(new InterceptorNextReentryError("p", "r").name).toBe("InterceptorNextReentryError")
    expect(new InterceptorRevokedError("p", "r").name).toBe("InterceptorRevokedError")
    expect(new InterceptorFailClosedError("p", "r", "why").name).toBe("InterceptorFailClosedError")
    expect(new InterceptorReentrancyError("p", "r", 2).name).toBe("InterceptorReentrancyError")
    expect(
      new InterceptorGuardDeniedError("p", "r", { decision: "deny", reason: "nope" }).name
    ).toBe("InterceptorGuardDeniedError")
  })

  it("the reentry error says the downstream operation was not re-run", () => {
    expect(new InterceptorNextReentryError("model.request.invoke", "r").message).toContain(
      "not re-run"
    )
  })
})
