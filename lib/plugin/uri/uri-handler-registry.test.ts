import {
  registerUriHandler,
  getUriHandler,
  unregisterUriHandlersByPlugin,
  dispatchUri,
  __resetUriHandlersForTesting,
} from "./uri-handler-registry"
import type { ParsedDeepLink } from "./parse-deep-link"

function link(pluginId: string, path = "x"): ParsedDeepLink {
  return { pluginId, path, query: {}, raw: `cognia://plugin/${pluginId}/${path}` }
}

describe("uri-handler-registry", () => {
  afterEach(() => __resetUriHandlersForTesting())

  it("registers a handler and dispatches to it", () => {
    const seen: ParsedDeepLink[] = []
    registerUriHandler("acme", (uri) => void seen.push(uri))
    expect(dispatchUri(link("acme", "auth"))).toBe(true)
    expect(seen[0].path).toBe("auth")
  })

  it("returns false when no handler is registered for the plugin", () => {
    expect(dispatchUri(link("ghost"))).toBe(false)
  })

  it("only one handler per plugin (re-register replaces)", () => {
    const calls: string[] = []
    registerUriHandler("acme", () => void calls.push("a"))
    registerUriHandler("acme", () => void calls.push("b"))
    dispatchUri(link("acme"))
    expect(calls).toEqual(["b"])
  })

  it("disposer removes only that handler", () => {
    const dispose = registerUriHandler("acme", () => {})
    dispose()
    expect(getUriHandler("acme")).toBeUndefined()
  })

  it("unregisterUriHandlersByPlugin returns the removed count", () => {
    registerUriHandler("acme", () => {})
    expect(unregisterUriHandlersByPlugin("acme")).toBe(1)
    expect(unregisterUriHandlersByPlugin("acme")).toBe(0)
  })

  it("swallows a throwing handler (router survives)", () => {
    registerUriHandler("acme", () => {
      throw new Error("boom")
    })
    expect(() => dispatchUri(link("acme"))).not.toThrow()
    expect(dispatchUri(link("acme"))).toBe(true)
  })

  it("swallows a rejecting async handler", async () => {
    registerUriHandler("acme", async () => {
      throw new Error("async boom")
    })
    expect(dispatchUri(link("acme"))).toBe(true)
    await Promise.resolve()
  })
})
