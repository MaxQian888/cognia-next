/**
 * Barrel surface. Call sites import from here, so a rename that silently drops
 * an export would leave a point undispatchable with no compile error at the
 * barrel itself.
 */

import * as interceptors from "./index"

describe("interceptors barrel", () => {
  it("exports the four dispatchers and the guard helper", () => {
    for (const name of [
      "dispatchObserve",
      "dispatchTransform",
      "dispatchGuard",
      "dispatchAround",
      "requireGuardPass",
    ]) {
      expect(typeof (interceptors as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("exports the registry surface the host lifecycle needs", () => {
    for (const name of [
      "registerInterceptor",
      "unregisterInterceptor",
      "unregisterInterceptorsForPlugin",
      "unregisterInterceptorsForPluginSource",
      "unregisterInterceptorGeneration",
      "resolveInterceptorChain",
      "hasInterceptors",
    ]) {
      expect(typeof (interceptors as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("exports the activation-contribution helpers the manager calls", () => {
    for (const name of ["splitActivationContributions", "registerDeclaredInterceptors"]) {
      expect(typeof (interceptors as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("exports the normalization helpers the legacy surfaces call", () => {
    for (const name of [
      "createInterceptorRegistration",
      "interceptorFromChatMiddleware",
      "interceptorsFromLegacyHooks",
      "setInterceptorIdentityResolver",
    ]) {
      expect(typeof (interceptors as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("re-exports the point catalog and the failure-policy rule", () => {
    expect(interceptors.CANONICAL_INTERCEPTOR_POINTS.length).toBeGreaterThan(0)
    expect(interceptors.resolveFailurePolicy("fail-closed", "fail-open")).toBe("fail-closed")
  })
})
