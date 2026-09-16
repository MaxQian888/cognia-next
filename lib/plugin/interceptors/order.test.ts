/**
 * Ordering resolution — trust tier, then the before/after DAG, then priority,
 * then a stable id. The failure cases matter as much as the happy one: one
 * author's typo or cycle must never take a point offline for everybody else.
 */

import { resolveInterceptorOrder } from "./order"
import type { InterceptorRegistration, InterceptorTrustTier } from "./types"

function make(
  registrationId: string,
  overrides: Partial<InterceptorRegistration> = {}
): InterceptorRegistration {
  return {
    registrationId,
    pluginId: overrides.pluginId ?? registrationId,
    pluginInstanceId: `${registrationId}#1`,
    generation: 1,
    realmId: "global",
    pointId: "model.request.prepare",
    semantic: "transform",
    trustTier: "community" as InterceptorTrustTier,
    order: {},
    timeoutMs: 100,
    source: "interceptors",
    runtime: "frontend",
    ...overrides,
  }
}

const ids = (registrations: readonly InterceptorRegistration[]): string[] =>
  registrations.map((entry) => entry.registrationId)

describe("resolveInterceptorOrder", () => {
  it("returns a single registration untouched", () => {
    const only = make("a")
    const { ordered, diagnostics } = resolveInterceptorOrder("model.request.prepare", [only])
    expect(ordered).toEqual([only])
    expect(diagnostics).toEqual([])
  })

  it("puts more trusted tiers outermost regardless of priority", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("community", { order: { priority: 100 } }),
      make("builtin", { trustTier: "builtin", order: { priority: -100 } }),
      make("verified", { trustTier: "verified" }),
    ])
    expect(ids(ordered)).toEqual(["builtin", "verified", "community"])
  })

  it("orders by priority descending within a tier", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("low", { order: { priority: 1 } }),
      make("high", { order: { priority: 9 } }),
    ])
    expect(ids(ordered)).toEqual(["high", "low"])
  })

  it("breaks a full tie on registration id, so the chain is reproducible", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("zeta"),
      make("alpha"),
    ])
    expect(ids(ordered)).toEqual(["alpha", "zeta"])
  })

  it("honours `after` even against a higher priority", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("eager", { order: { priority: 100, after: ["redactor"] } }),
      make("redactor", { order: { priority: -100 } }),
    ])
    expect(ids(ordered)).toEqual(["redactor", "eager"])
  })

  it("honours `before`", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("b"),
      make("a", { order: { before: ["b"] } }),
    ])
    expect(ids(ordered)).toEqual(["a", "b"])
  })

  it("resolves a reference naming a PLUGIN to all of that plugin's entries", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("mine", { pluginId: "mine", order: { after: ["other"] } }),
      make("other-1", { pluginId: "other" }),
      make("other-2", { pluginId: "other" }),
    ])
    expect(ids(ordered).indexOf("mine")).toBe(2)
  })

  it("ignores a dangling reference and reports it, rather than dropping the entry", () => {
    const { ordered, diagnostics } = resolveInterceptorOrder("model.request.prepare", [
      make("a", { order: { after: ["a-plugin-that-is-not-installed"] } }),
      make("b"),
    ])
    expect(ids(ordered)).toEqual(["a", "b"])
    expect(diagnostics[0]?.code).toBe("interceptor.order.missing-dependency")
  })

  it("keeps every registration when the constraints form a cycle", () => {
    const { ordered, diagnostics } = resolveInterceptorOrder("model.request.prepare", [
      make("a", { order: { after: ["b"] } }),
      make("b", { order: { after: ["a"] } }),
    ])
    // One author's typo must not take the point offline for the other.
    expect(ids(ordered).sort()).toEqual(["a", "b"])
    expect(diagnostics[0]?.code).toBe("interceptor.order.cycle")
    expect(diagnostics[0]?.registrationIds.length).toBe(2)
  })

  it("refuses to let a constraint place a community entry outside a builtin one", () => {
    const { ordered, diagnostics } = resolveInterceptorOrder("model.request.prepare", [
      make("third-party", { order: { before: ["first-party"] } }),
      make("first-party", { trustTier: "builtin" }),
    ])
    expect(ids(ordered)).toEqual(["first-party", "third-party"])
    expect(diagnostics.some((entry) => entry.code === "interceptor.order.tier-conflict")).toBe(true)
  })

  it("ignores a self-reference instead of deadlocking on it", () => {
    const { ordered } = resolveInterceptorOrder("model.request.prepare", [
      make("a", { order: { after: ["a"] } }),
    ])
    expect(ids(ordered)).toEqual(["a"])
  })
})
