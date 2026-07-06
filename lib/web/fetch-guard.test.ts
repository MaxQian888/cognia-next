import {
  assertFetchTargetAllowed,
  evaluateFetchTarget,
  FetchTargetBlockedError,
  isPrivateOrLocalHost,
} from "./fetch-guard"

describe("isPrivateOrLocalHost", () => {
  it.each([
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "2130706433", // decimal form of 127.0.0.1
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ])("flags private/local host %s", (host) => {
    expect(isPrivateOrLocalHost(host)).toBe(true)
  })

  it.each([
    "example.com",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1", // just below the private /12
    "172.32.0.1", // just above the private /12
    "192.167.0.1",
    "9.255.255.255",
    "2606:4700:4700::1111", // public Cloudflare IPv6
  ])("allows public host %s", (host) => {
    expect(isPrivateOrLocalHost(host)).toBe(false)
  })

  it("treats an empty host as unsafe", () => {
    expect(isPrivateOrLocalHost("")).toBe(true)
    expect(isPrivateOrLocalHost("   ")).toBe(true)
  })

  it("ignores a trailing dot (FQDN root)", () => {
    expect(isPrivateOrLocalHost("127.0.0.1.")).toBe(true)
    expect(isPrivateOrLocalHost("example.com.")).toBe(false)
  })
})

describe("evaluateFetchTarget", () => {
  it("allows a public https URL", () => {
    expect(evaluateFetchTarget("https://example.com/path")).toEqual({
      allowed: true,
      reason: "ok",
      host: "example.com",
    })
  })

  it("rejects an unparseable URL", () => {
    expect(evaluateFetchTarget("not a url")).toEqual({ allowed: false, reason: "bad-url" })
  })

  it("rejects a non-http(s) scheme", () => {
    const out = evaluateFetchTarget("file:///etc/passwd")
    expect(out.allowed).toBe(false)
    expect(out.reason).toBe("bad-scheme")
  })

  it("rejects a loopback URL by default", () => {
    const out = evaluateFetchTarget("http://127.0.0.1:8080/admin")
    expect(out).toEqual({ allowed: false, reason: "private-host", host: "127.0.0.1" })
  })

  it("rejects the cloud metadata endpoint", () => {
    expect(evaluateFetchTarget("http://169.254.169.254/latest/meta-data/").allowed).toBe(false)
  })

  it("permits a private host when allowPrivateHosts is set", () => {
    const out = evaluateFetchTarget("http://localhost:3000/", { allowPrivateHosts: true })
    expect(out.allowed).toBe(true)
    expect(out.reason).toBe("ok")
  })

  it("still rejects a bad scheme even when allowPrivateHosts is set", () => {
    expect(evaluateFetchTarget("ftp://localhost/x", { allowPrivateHosts: true }).allowed).toBe(
      false
    )
  })
})

describe("assertFetchTargetAllowed", () => {
  it("does not throw for a public URL", () => {
    expect(() => assertFetchTargetAllowed("https://example.com")).not.toThrow()
  })

  it("throws FetchTargetBlockedError for a private host", () => {
    expect(() => assertFetchTargetAllowed("http://192.168.0.1")).toThrow(FetchTargetBlockedError)
    try {
      assertFetchTargetAllowed("http://192.168.0.1")
    } catch (err) {
      expect(err).toBeInstanceOf(FetchTargetBlockedError)
      expect((err as FetchTargetBlockedError).reason).toBe("private-host")
      expect((err as FetchTargetBlockedError).host).toBe("192.168.0.1")
    }
  })

  it("throws for a non-http(s) scheme with a descriptive message", () => {
    expect(() => assertFetchTargetAllowed("gopher://evil/")).toThrow(/non-http/i)
  })
})
