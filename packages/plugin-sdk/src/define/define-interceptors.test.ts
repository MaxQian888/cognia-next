import { defineInterceptor, defineInterceptors } from "./define-interceptors"
import type { PluginInterceptorContribution } from "@/types/plugin/plugin-interceptors"

const contribution = (
  overrides: Partial<PluginInterceptorContribution> = {}
): PluginInterceptorContribution => ({
  point: "tool.result.project",
  handler: () => undefined,
  ...overrides,
})

describe("defineInterceptors", () => {
  it("returns the contributions verbatim without registering anything", () => {
    const entries = [contribution()]
    expect(defineInterceptors(entries)).toEqual({ interceptors: entries })
  })

  it("accepts an empty list", () => {
    expect(defineInterceptors([])).toEqual({ interceptors: [] })
  })

  it("rejects two contributions sharing an id on one point", () => {
    // Collapsing them would leave the author watching a handler never run, with
    // nothing naming the collision.
    expect(() =>
      defineInterceptors([contribution({ id: "dup" }), contribution({ id: "dup" })])
    ).toThrow(/duplicate interceptor id "dup"/)
  })

  it("allows the same id on two different points", () => {
    expect(() =>
      defineInterceptors([
        contribution({ id: "same", point: "tool.result.project" }),
        contribution({ id: "same", point: "tool.call.prepare" }),
      ])
    ).not.toThrow()
  })

  it("does not require an id", () => {
    expect(() => defineInterceptors([contribution(), contribution()])).not.toThrow()
  })
})

describe("defineInterceptor", () => {
  it("passes one contribution through with its point narrowed", () => {
    const entry = defineInterceptor({ point: "tool.execute", handler: () => undefined })
    expect(entry.point).toBe("tool.execute")
  })
})
