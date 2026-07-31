import { createUriAPI } from "./uri-api"
import {
  dispatchUri,
  getUriHandler,
  __resetUriHandlersForTesting,
} from "@/lib/plugin/uri/uri-handler-registry"
import type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"

function link(pluginId: string): ParsedDeepLink {
  return { pluginId, path: "x", query: { a: "1" }, raw: `cognia://plugin/${pluginId}/x?a=1` }
}

describe("createUriAPI", () => {
  afterEach(() => __resetUriHandlersForTesting())

  it("registers a handler scoped to the plugin id", () => {
    const api = createUriAPI("acme")
    const seen: ParsedDeepLink[] = []
    api.registerHandler({ handle: (uri) => void seen.push(uri) })
    expect(getUriHandler("acme")).toBeDefined()
    dispatchUri(link("acme"))
    expect(seen[0].query).toEqual({ a: "1" })
  })

  it("a plugin only receives its own deep-links", () => {
    const acme = createUriAPI("acme")
    const other = createUriAPI("other")
    const acmeSeen: string[] = []
    const otherSeen: string[] = []
    acme.registerHandler({ handle: (u) => void acmeSeen.push(u.pluginId) })
    other.registerHandler({ handle: (u) => void otherSeen.push(u.pluginId) })
    dispatchUri(link("acme"))
    expect(acmeSeen).toEqual(["acme"])
    expect(otherSeen).toEqual([])
  })

  it("returns a disposer", () => {
    const api = createUriAPI("acme")
    const dispose = api.registerHandler({ handle: () => {} })
    dispose()
    expect(getUriHandler("acme")).toBeUndefined()
  })
})
