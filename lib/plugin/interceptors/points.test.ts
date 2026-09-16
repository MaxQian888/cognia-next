/**
 * The point catalog accessor. Every assertion here is about the contract being
 * HONEST — a point that claims to be implemented has a fire site, and one that
 * has no fire site says so.
 */

import {
  CANONICAL_INTERCEPTOR_POINTS,
  getInterceptorPoint,
  isInterceptorPoint,
  isInterceptorPointLive,
  listInterceptorPoints,
  requireInterceptorPoint,
} from "./points"
import { getInterceptorPointContract } from "@/lib/plugin/contracts/plugin-points"
import { PLUGIN_INTERCEPTOR_POINTS } from "@/types/plugin/plugin-interceptors"

describe("interceptor point catalog", () => {
  it("recognizes a declared point and rejects anything else", () => {
    expect(isInterceptorPoint("tool.execute")).toBe(true)
    expect(isInterceptorPoint("tool.exec")).toBe(false)
  })

  it("throws on an unknown point rather than inventing a default policy", () => {
    // Dispatching an unknown point is a HOST bug — the id is a literal in host
    // code — so guessing a failure policy nobody declared would hide it.
    expect(() => requireInterceptorPoint("nope")).toThrow(/unknown interceptor point/)
  })

  it("names exactly the points the SDK exposes to authors", () => {
    // The host derives its list from the declaration table; the SDK ships a
    // tuple. They are the same eleven ids, and this is the runtime half of the
    // `Record<CanonicalInterceptorPoint, …>` type check that keeps them so.
    expect([...CANONICAL_INTERCEPTOR_POINTS].sort()).toEqual([...PLUGIN_INTERCEPTOR_POINTS].sort())
  })

  it("lists every point exactly once", () => {
    const listed = listInterceptorPoints()
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed).toEqual(CANONICAL_INTERCEPTOR_POINTS)
  })

  it("gives every point a semantic, a failure policy and a timeout ceiling", () => {
    for (const id of CANONICAL_INTERCEPTOR_POINTS) {
      const point = getInterceptorPoint(id)!
      expect(point.semantic).toMatch(/^(observe|transform|guard|around)$/)
      expect(point.failurePolicy).toMatch(/^(fail-open|fail-closed|require-approval)$/)
      expect(point.timeoutCeilingMs).toBeGreaterThan(0)
    }
  })

  it("only calls a point live when its contract names a real fire site", () => {
    for (const id of CANONICAL_INTERCEPTOR_POINTS) {
      const contract = getInterceptorPointContract(id)
      const live = isInterceptorPointLive(id)
      expect(live).toBe(contract.status === "implemented")
      if (live) {
        expect(contract.binding).not.toContain("declared only")
        expect(contract.binding).toMatch(/\.ts:/)
      } else {
        expect(contract.binding).toContain("declared only")
      }
    }
  })

  it("keeps `tool.execute` fail-closed and non-short-circuitable", () => {
    // The two properties that make wrapping a tool meaningful: an interceptor
    // that dies must not leave the tool running unwrapped, and a handler must
    // not be able to fabricate a receipt for an execution that never happened.
    const point = requireInterceptorPoint("tool.execute")
    expect(point.failurePolicy).toBe("fail-closed")
    expect(point.allowShortCircuit).toBe(false)
  })

  it("lets a chat middleware short-circuit, because a cache hit is legitimate", () => {
    expect(requireInterceptorPoint("model.request.invoke").allowShortCircuit).toBe(true)
  })

  it("keeps transforms serial everywhere, so ordering means something", () => {
    for (const id of CANONICAL_INTERCEPTOR_POINTS) {
      expect(requireInterceptorPoint(id).parallelTransforms).toBe(false)
    }
  })
})
