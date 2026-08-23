import {
  assertFetchTargetAllowed,
  evaluateFetchTarget,
  FetchTargetBlockedError,
  isPrivateOrLocalHost,
} from "./fetch-guard"
import * as shared from "@cognia/network-guard"

// The classification matrix — every IPv4 boundary, IPv6 range, legacy numeric
// form and scheme — is owned by `@cognia/network-guard` and exhaustively
// covered in its own suite. What is tested here is only what this adapter
// adds: that it re-exports the shared policy rather than forking it, and that
// the app-specific error guidance survives.

describe("adapter wiring", () => {
  it("re-exports the shared classifier rather than a local copy", () => {
    expect(evaluateFetchTarget).toBe(shared.evaluateFetchTarget)
    expect(isPrivateOrLocalHost).toBe(shared.isPrivateOrLocalHost)
  })
})

describe("FetchTargetBlockedError", () => {
  it("points a blocked private host at the app's own Settings surface", () => {
    const error = new FetchTargetBlockedError("http://127.0.0.1/x", "127.0.0.1", "private-host")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("FetchTargetBlockedError")
    expect(error.message).toContain("127.0.0.1")
    expect(error.message).toContain("Settings → Search")
    expect(error.url).toBe("http://127.0.0.1/x")
    expect(error.host).toBe("127.0.0.1")
    expect(error.reason).toBe("private-host")
  })

  it("describes a bad scheme and a bad URL without the Settings hint", () => {
    expect(new FetchTargetBlockedError("file:///etc/passwd", "", "bad-scheme").message).toBe(
      "Refusing to fetch non-http(s) URL: file:///etc/passwd"
    )
    expect(new FetchTargetBlockedError("nope", "", "bad-url").message).toBe(
      "Refusing to fetch an unparseable URL: nope"
    )
  })
})

describe("assertFetchTargetAllowed", () => {
  it("passes a public URL through", () => {
    expect(() => assertFetchTargetAllowed("https://example.com/a")).not.toThrow()
  })

  it.each([
    ["http://127.0.0.1:8080/admin", "private-host"],
    ["http://169.254.169.254/latest/meta-data/", "private-host"],
    ["http://localhost/x", "private-host"],
    ["file:///etc/passwd", "bad-scheme"],
    ["not a url", "bad-url"],
  ])("throws for %s (%s)", (url, reason) => {
    expect(() => assertFetchTargetAllowed(url)).toThrow(FetchTargetBlockedError)
    try {
      assertFetchTargetAllowed(url)
    } catch (error) {
      expect((error as FetchTargetBlockedError).reason).toBe(reason)
    }
  })

  it("blocks the IPv6 literals this gate used to clear", () => {
    // Regression: `URL.hostname` keeps the brackets (`"[::1]"`), so the
    // pre-extraction textual check matched nothing and allowed every IPv6
    // private target reachable from `web_fetch`.
    for (const url of [
      "http://[::1]/x",
      "http://[::]/x",
      "http://[fe80::1]/x",
      "http://[fc00::1]/x",
      "http://[fec0::1]/x",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
    ]) {
      expect(() => assertFetchTargetAllowed(url)).toThrow(FetchTargetBlockedError)
    }
  })

  describe("allowPrivateHosts opt-in", () => {
    it("permits private hosts when the user opted in", () => {
      expect(() =>
        assertFetchTargetAllowed("http://127.0.0.1:8080/x", { allowPrivateHosts: true })
      ).not.toThrow()
      expect(() =>
        assertFetchTargetAllowed("http://[::1]/x", { allowPrivateHosts: true })
      ).not.toThrow()
    })

    it("still refuses a bad scheme and a bad URL", () => {
      expect(() =>
        assertFetchTargetAllowed("file:///etc/passwd", { allowPrivateHosts: true })
      ).toThrow(FetchTargetBlockedError)
      expect(() => assertFetchTargetAllowed("not a url", { allowPrivateHosts: true })).toThrow(
        FetchTargetBlockedError
      )
    })
  })
})
