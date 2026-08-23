import { evaluateFetchTarget } from "./fetch-target"

describe("evaluateFetchTarget", () => {
  it("clears a public http(s) target", () => {
    expect(evaluateFetchTarget("https://example.com/a")).toEqual({
      allowed: true,
      reason: "ok",
      host: "example.com",
    })
    expect(evaluateFetchTarget("http://8.8.8.8/a").allowed).toBe(true)
  })

  it("refuses a URL it cannot parse, with no host to report", () => {
    expect(evaluateFetchTarget("not a url")).toEqual({ allowed: false, reason: "bad-url" })
    expect(evaluateFetchTarget("")).toEqual({ allowed: false, reason: "bad-url" })
  })

  it("refuses every non-http(s) scheme", () => {
    for (const url of ["file:///etc/passwd", "gopher://x/1", "data:text/plain,hi", "tg://file/A"]) {
      expect(evaluateFetchTarget(url).reason).toBe("bad-scheme")
    }
  })

  it("refuses private and loopback targets", () => {
    for (const url of [
      "http://127.0.0.1:8080/admin",
      "http://localhost/x",
      "http://router.local/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/x",
      "http://10.0.0.5/x",
      "http://172.16.0.1/x",
      "http://100.64.0.1/x",
      "http://224.0.0.1/x",
      "http://0.0.0.0/x",
    ]) {
      expect(evaluateFetchTarget(url)).toMatchObject({ allowed: false, reason: "private-host" })
    }
  })

  it("refuses IPv6 private literals despite the brackets the parser keeps", () => {
    // Every one of these was ALLOWED by the app-side gate this package replaced.
    for (const url of [
      "http://[::1]/x",
      "http://[0:0:0:0:0:0:0:1]/x",
      "http://[::]/x",
      "http://[fc00::1]/x",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      "http://[fec0::1]/x",
      "http://[ff02::1]/x",
    ]) {
      expect(evaluateFetchTarget(url)).toMatchObject({ allowed: false, reason: "private-host" })
    }
  })

  it("refuses IPv4-mapped and -compatible literals after WHATWG re-serialisation", () => {
    // `[::ffff:169.254.169.254]` reaches `hostname` as `[::ffff:a9fe:a9fe]`.
    for (const url of [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:192.168.1.1]/x",
      "http://[::ffff:a9fe:a9fe]/x",
    ]) {
      expect(evaluateFetchTarget(url)).toMatchObject({ allowed: false, reason: "private-host" })
    }
    expect(evaluateFetchTarget("http://[::ffff:1.2.3.4]/x").allowed).toBe(true)
  })

  it("refuses the legacy numeric IPv4 forms the parser normalises", () => {
    for (const url of [
      "http://2130706433/x",
      "http://0x7f.0.0.1/x",
      "http://0177.0.0.1/x",
      "http://127.1/x",
    ]) {
      expect(evaluateFetchTarget(url)).toMatchObject({ allowed: false, reason: "private-host" })
    }
  })

  it("refuses a trailing-dot evasion of the suffix rules", () => {
    expect(evaluateFetchTarget("http://localhost./x").reason).toBe("private-host")
    expect(evaluateFetchTarget("http://router.local./x").reason).toBe("private-host")
  })

  it("reports a normalized, bracketless host on every branch", () => {
    expect(evaluateFetchTarget("http://[::1]/x").host).toBe("::1")
    expect(evaluateFetchTarget("HTTPS://ExAmPle.COM./a").host).toBe("example.com")
    expect(evaluateFetchTarget("file://[::1]/x").host).toBe("::1")
  })

  describe("allowPrivateHosts", () => {
    const opts = { allowPrivateHosts: true }

    it("lifts the private-host rejection only", () => {
      expect(evaluateFetchTarget("http://127.0.0.1:8080/x", opts).allowed).toBe(true)
      expect(evaluateFetchTarget("http://[::1]/x", opts).allowed).toBe(true)
      expect(evaluateFetchTarget("http://192.168.1.1/x", opts).allowed).toBe(true)
    })

    it("still refuses a malformed URL and a non-http(s) scheme", () => {
      expect(evaluateFetchTarget("not a url", opts).reason).toBe("bad-url")
      expect(evaluateFetchTarget("file:///etc/passwd", opts).reason).toBe("bad-scheme")
    })
  })
})
