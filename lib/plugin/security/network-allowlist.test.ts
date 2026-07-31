import {
  assertEgressAllowed,
  evaluateEgress,
  hostFromUrl,
  matchHost,
  PluginEgressError,
} from "./network-allowlist"

describe("matchHost (mirrors Rust network_host_allowed)", () => {
  it("matches an exact host", () => {
    expect(matchHost("api.example.com", ["api.example.com"])).toBe(true)
  })

  it("matches a subdomain of a declared apex", () => {
    expect(matchHost("api.example.com", ["example.com"])).toBe(true)
    expect(matchHost("a.b.example.com", ["example.com"])).toBe(true)
  })

  it("does NOT match a sibling/unrelated host", () => {
    expect(matchHost("evil.com", ["example.com"])).toBe(false)
    // suffix-string but not a domain boundary: notexample.com must NOT match
    expect(matchHost("notexample.com", ["example.com"])).toBe(false)
  })

  it("treats '*' as any-host", () => {
    expect(matchHost("anything.dev", ["*"])).toBe(true)
  })

  it("ignores blank and 'none' entries", () => {
    expect(matchHost("example.com", ["none"])).toBe(false)
    expect(matchHost("example.com", ["", "  "])).toBe(false)
    expect(matchHost("example.com", [])).toBe(false)
  })

  it("normalizes case, trailing dots on host and leading dots on entries", () => {
    expect(matchHost("API.Example.COM.", [".example.com"])).toBe(true)
  })

  it("denies an empty host (fail-closed)", () => {
    expect(matchHost("", ["*"])).toBe(false)
    expect(matchHost("   ", ["example.com"])).toBe(false)
  })
})

describe("hostFromUrl", () => {
  it("extracts the hostname", () => {
    expect(hostFromUrl("https://api.example.com/v1?x=1")).toBe("api.example.com")
  })

  it("returns null for an unparseable URL", () => {
    expect(hostFromUrl("not a url")).toBeNull()
    expect(hostFromUrl("http://")).toBeNull()
  })
})

describe("evaluateEgress", () => {
  it("flags an unparseable URL as bad-url", () => {
    expect(evaluateEgress("http://", { allowedDomains: ["*"] })).toEqual({
      allowed: false,
      reason: "bad-url",
    })
  })

  describe("no declaration", () => {
    it("is denied under balanced posture (fail-closed)", () => {
      expect(evaluateEgress("https://x.com", undefined, "balanced")).toEqual({
        allowed: false,
        reason: "no-declaration",
      })
      expect(evaluateEgress("https://x.com", {}, "balanced")).toEqual({
        allowed: false,
        reason: "no-declaration",
      })
    })

    it("is denied under strict posture", () => {
      expect(evaluateEgress("https://x.com", undefined, "strict")).toEqual({
        allowed: false,
        reason: "strict-no-declaration",
      })
    })

    it("is denied when posture omitted (defaults to balanced, fail-closed)", () => {
      expect(evaluateEgress("https://x.com", undefined).allowed).toBe(false)
    })
  })

  it("allows any host with a wildcard declaration", () => {
    expect(evaluateEgress("https://random.io", { allowedDomains: ["*"] })).toEqual({
      allowed: true,
      reason: "wildcard",
    })
  })

  it("allows a declared host / subdomain", () => {
    expect(evaluateEgress("https://api.github.com/x", { allowedDomains: ["github.com"] })).toEqual({
      allowed: true,
      reason: "host-match",
    })
  })

  it("denies an undeclared host even with an allowlist present", () => {
    expect(evaluateEgress("https://evil.com", { allowedDomains: ["github.com"] })).toEqual({
      allowed: false,
      reason: "host-denied",
    })
  })

  it("denies all when the allowlist is empty or ['none']", () => {
    expect(evaluateEgress("https://x.com", { allowedDomains: [] }).allowed).toBe(false)
    expect(evaluateEgress("https://x.com", { allowedDomains: [] }, "balanced").allowed).toBe(false)
    expect(evaluateEgress("https://x.com", { allowedDomains: ["none"] }).allowed).toBe(false)
  })
})

describe("assertEgressAllowed", () => {
  it("does not throw for an allowed target", () => {
    expect(() =>
      assertEgressAllowed("p", "https://api.example.com", { allowedDomains: ["example.com"] })
    ).not.toThrow()
  })

  it("throws PluginEgressError for a denied target", () => {
    try {
      assertEgressAllowed("my-plugin", "https://evil.com/x", {
        allowedDomains: ["example.com"],
      })
      throw new Error("expected to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PluginEgressError)
      const err = e as PluginEgressError
      expect(err.pluginId).toBe("my-plugin")
      expect(err.host).toBe("evil.com")
      expect(err.reason).toBe("host-denied")
      expect(err.message).toContain("evil.com")
      expect(err.message).toContain("my-plugin")
    }
  })

  it("throws for an undeclared allowlist under balanced (fail-closed)", () => {
    try {
      assertEgressAllowed("p", "https://anything.dev/x", undefined, "balanced")
      throw new Error("expected to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PluginEgressError)
      expect((e as PluginEgressError).reason).toBe("no-declaration")
    }
  })

  it("uses the raw url as host when unparseable", () => {
    try {
      assertEgressAllowed("p", "http://", { allowedDomains: ["x.com"] })
      throw new Error("expected to throw")
    } catch (e) {
      expect((e as PluginEgressError).host).toBe("http://")
      expect((e as PluginEgressError).reason).toBe("bad-url")
    }
  })
})
