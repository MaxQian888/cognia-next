import {
  resolveWebAccess,
  anthropicNativeWebSearch,
  externalAgentNativeWebSearch,
  configuredSearchProviders,
} from "./web-access"
import type { AppSettings } from "@cognia/agent-config-types"

const tavily = {
  tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
} as unknown as AppSettings["searchProviders"]

const unconfigured = {
  tavily: { providerId: "tavily", enabled: true, apiKey: "" },
} as unknown as AppSettings["searchProviders"]

describe("resolveWebAccess", () => {
  it("prefers the runtime's own search over the provider-backed tools", () => {
    const r = resolveWebAccess({ nativeAvailable: true, searchProviders: tavily })
    expect(r.mode).toBe("native")
    expect(r.search).toBe("native")
    expect(r.fetch).toBe("native")
  })

  // The shipped default was the other way round, which handed a subscriber
  // with no search key a `web_search` that could only throw.
  it("uses the native path on a subscription with no search provider at all", () => {
    const r = resolveWebAccess({ nativeAvailable: true })
    expect(r.mode).toBe("native")
    expect(r.reason).toBeUndefined()
  })

  it("routes through Cognia when the runtime has no native", () => {
    const r = resolveWebAccess({ nativeAvailable: false, searchProviders: tavily })
    expect(r.mode).toBe("cognia")
    expect(r.searchProviderId).toBe("tavily")
    expect(r.search).toBe("cognia")
  })

  // The whole point of splitting the two routes: fetch needs no key.
  it("keeps fetch alive but marks search unavailable with neither native nor provider", () => {
    const r = resolveWebAccess({ nativeAvailable: false, searchProviders: unconfigured })
    expect(r.mode).toBe("search-unavailable")
    expect(r.search).toBe("none")
    expect(r.fetch).toBe("cognia")
    expect(r.reason).toBe("no-native-no-provider")
  })

  it("honours the capability switch over everything", () => {
    const r = resolveWebAccess({
      webTools: { enabled: false },
      nativeAvailable: true,
      searchProviders: tavily,
    })
    expect(r.mode).toBe("off")
    expect(r.reason).toBe("disabled")
  })

  it("honours a per-turn off without touching the setting", () => {
    const r = resolveWebAccess({ nativeAvailable: true, turnIntent: "off" })
    expect(r.mode).toBe("off")
    expect(r.reason).toBe("turn-off")
  })

  it("reports a forced turn without changing which route serves it", () => {
    const r = resolveWebAccess({ nativeAvailable: true, turnIntent: "force" })
    expect(r.forced).toBe(true)
    expect(r.mode).toBe("native")
  })

  it("lets preferCognia override a native, but only when it can be served", () => {
    const served = resolveWebAccess({
      webTools: { enabled: true, preferCognia: true },
      nativeAvailable: true,
      searchProviders: tavily,
    })
    expect(served.mode).toBe("cognia")

    // Preferring an unconfigured path would be a third way to end up with no
    // web at all — fall back to the native that works.
    const unserved = resolveWebAccess({
      webTools: { enabled: true, preferCognia: true },
      nativeAvailable: true,
    })
    expect(unserved.mode).toBe("native")
  })

  it("offers pre-search only with both the master switch and a provider", () => {
    expect(resolveWebAccess({ nativeAvailable: true, searchProviders: tavily }).preSearch).toBe(
      false
    )
    expect(
      resolveWebAccess({ nativeAvailable: true, searchProviders: tavily, searchEnabled: true })
        .preSearch
    ).toBe(true)
    // A native does not help it: pre-search runs the query itself.
    expect(resolveWebAccess({ nativeAvailable: true, searchEnabled: true }).preSearch).toBe(false)
  })
})

describe("anthropicNativeWebSearch", () => {
  it("is Anthropic on the Agent SDK path only", () => {
    expect(anthropicNativeWebSearch("anthropic", false)).toBe(true)
    expect(anthropicNativeWebSearch("openai", false)).toBe(false)
    // Standalone runs in the renderer through the AI SDK, which never reads
    // `allowedTools` — opting into natives there removes the web tools.
    expect(anthropicNativeWebSearch("anthropic", true)).toBe(false)
  })
})

describe("configuredSearchProviders", () => {
  it("puts the user's default first when it is usable", () => {
    const both = {
      tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
      brave: { providerId: "brave", enabled: true, apiKey: "brave-0123456789abcdef" },
    } as unknown as AppSettings["searchProviders"]
    expect(configuredSearchProviders(both, "brave")[0]).toBe("brave")
    expect(configuredSearchProviders(both, "exa")[0]).toBe("tavily")
  })

  it("drops disabled and key-less entries", () => {
    expect(configuredSearchProviders(unconfigured)).toEqual([])
  })
})

describe("externalAgentNativeWebSearch", () => {
  const profile = (level: string) =>
    ({ effective: { "web.search": { level, evidence: "user-declared" } } }) as never

  it("believes a usable declaration", () => {
    expect(externalAgentNativeWebSearch(profile("native"))).toBe(true)
    expect(externalAgentNativeWebSearch(profile("equivalent"))).toBe(true)
  })

  // Every protocol row ships `unknown`, and an undeclared agent must fall to
  // Cognia's tools rather than be assumed self-sufficient — being wrong the
  // other way leaves the turn with no web and no explanation.
  it("does not treat unknown or unsupported as its own search", () => {
    expect(externalAgentNativeWebSearch(profile("unknown"))).toBe(false)
    expect(externalAgentNativeWebSearch(profile("unsupported"))).toBe(false)
    expect(externalAgentNativeWebSearch(null)).toBe(false)
    expect(externalAgentNativeWebSearch({ effective: {} } as never)).toBe(false)
  })
})
