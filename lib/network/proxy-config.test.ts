import { DEFAULT_NETWORK_PROXY_SETTINGS, type NetworkProxySettings } from "@/types/network/proxy"
import {
  buildProxyUrl,
  isProxyActive,
  proxyAuthHeader,
  proxyEnvVars,
  shouldBypass,
} from "./proxy-config"

const make = (overrides: Partial<NetworkProxySettings> = {}): NetworkProxySettings => ({
  ...DEFAULT_NETWORK_PROXY_SETTINGS,
  ...overrides,
})

describe("isProxyActive", () => {
  it("returns false for undefined / null config", () => {
    expect(isProxyActive(undefined)).toBe(false)
    expect(isProxyActive(null)).toBe(false)
  })

  it("returns false when mode is off even with host/port", () => {
    expect(isProxyActive(make({ mode: "off", host: "127.0.0.1", port: 7890 }))).toBe(false)
  })

  it("returns false when host is empty or whitespace-only", () => {
    expect(isProxyActive(make({ mode: "manual", host: "", port: 7890 }))).toBe(false)
    expect(isProxyActive(make({ mode: "manual", host: "   ", port: 7890 }))).toBe(false)
  })

  it("returns false when port is 0 or negative", () => {
    expect(isProxyActive(make({ mode: "manual", host: "127.0.0.1", port: 0 }))).toBe(false)
    expect(isProxyActive(make({ mode: "manual", host: "127.0.0.1", port: -1 }))).toBe(false)
  })

  it("returns true for a fully populated manual config", () => {
    expect(isProxyActive(make({ mode: "manual", host: "127.0.0.1", port: 7890 }))).toBe(true)
  })

  it("returns true for an auto-detected config", () => {
    expect(isProxyActive(make({ mode: "auto", host: "127.0.0.1", port: 7890 }))).toBe(true)
  })
})

describe("buildProxyUrl", () => {
  it("returns null when no proxy is active", () => {
    expect(buildProxyUrl(undefined)).toBeNull()
    expect(buildProxyUrl(make({ mode: "off" }))).toBeNull()
  })

  it("emits a bare http:// URL without auth", () => {
    expect(
      buildProxyUrl(make({ mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 }))
    ).toBe("http://127.0.0.1:7890")
  })

  it("emits a https:// URL when protocol is https", () => {
    expect(
      buildProxyUrl(make({ mode: "manual", protocol: "https", host: "proxy.corp", port: 8443 }))
    ).toBe("https://proxy.corp:8443")
  })

  it("emits a socks5:// URL", () => {
    expect(
      buildProxyUrl(make({ mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 7891 }))
    ).toBe("socks5://127.0.0.1:7891")
  })

  it("URL-encodes username and password", () => {
    expect(
      buildProxyUrl(
        make({
          mode: "manual",
          protocol: "http",
          host: "proxy.corp",
          port: 8080,
          username: "alice@corp",
          password: "p:w@rd!",
        })
      )
    ).toBe("http://alice%40corp:p%3Aw%40rd!@proxy.corp:8080")
  })

  it("omits auth when only one credential is present", () => {
    expect(
      buildProxyUrl(
        make({
          mode: "manual",
          protocol: "http",
          host: "127.0.0.1",
          port: 7890,
          username: "alice",
          password: undefined,
        })
      )
    ).toBe("http://127.0.0.1:7890")
  })
})

describe("shouldBypass", () => {
  const bypass = ["localhost", "127.0.0.1", "::1", ".internal"]

  it("returns false when bypass list is empty", () => {
    expect(shouldBypass("https://api.example.com", [])).toBe(false)
  })

  it("returns false for non-URL strings", () => {
    expect(shouldBypass("not-a-url", bypass)).toBe(false)
  })

  it("matches loopback hosts", () => {
    expect(shouldBypass("http://localhost/foo", bypass)).toBe(true)
    expect(shouldBypass("http://127.0.0.1:3000/x", bypass)).toBe(true)
  })

  it("matches an exact-host entry case-insensitively", () => {
    expect(shouldBypass("http://Localhost/foo", bypass)).toBe(true)
  })

  it("matches a domain suffix entry", () => {
    expect(shouldBypass("https://api.internal/foo", bypass)).toBe(true)
    expect(shouldBypass("https://internal/foo", bypass)).toBe(true)
  })

  it("does not match unrelated hosts", () => {
    expect(shouldBypass("https://api.anthropic.com", bypass)).toBe(false)
  })

  it("ignores empty/whitespace bypass entries", () => {
    expect(shouldBypass("https://api.anthropic.com", ["", "   "])).toBe(false)
  })
})

describe("proxyEnvVars", () => {
  it("returns empty object when proxy inactive", () => {
    expect(proxyEnvVars(undefined)).toEqual({})
    expect(proxyEnvVars(make({ mode: "off" }))).toEqual({})
  })

  it("emits HTTP_PROXY/HTTPS_PROXY in both casings", () => {
    const env = proxyEnvVars(
      make({ mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 })
    )
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890")
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
    expect(env.http_proxy).toBe("http://127.0.0.1:7890")
    expect(env.https_proxy).toBe("http://127.0.0.1:7890")
  })

  it("emits NO_PROXY when bypass list is non-empty", () => {
    const env = proxyEnvVars(
      make({
        mode: "manual",
        protocol: "http",
        host: "127.0.0.1",
        port: 7890,
        bypass: ["localhost", ".internal"],
      })
    )
    expect(env.NO_PROXY).toBe("localhost,.internal")
    expect(env.no_proxy).toBe("localhost,.internal")
  })

  it("omits NO_PROXY when bypass is empty", () => {
    const env = proxyEnvVars(
      make({ mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890, bypass: [] })
    )
    expect(env.NO_PROXY).toBeUndefined()
  })
})

describe("proxyAuthHeader", () => {
  it("returns null when no auth", () => {
    expect(proxyAuthHeader(undefined)).toBeNull()
    expect(
      proxyAuthHeader(make({ mode: "manual", host: "x", port: 1, username: undefined }))
    ).toBeNull()
  })

  it("returns null when only one of username/password is set", () => {
    expect(
      proxyAuthHeader(make({ mode: "manual", host: "x", port: 1, username: "alice" }))
    ).toBeNull()
  })

  it("returns Basic auth header when both creds are set", () => {
    const header = proxyAuthHeader(
      make({ mode: "manual", host: "x", port: 1, username: "alice", password: "secret" })
    )
    // base64("alice:secret") = "YWxpY2U6c2VjcmV0"
    expect(header).toBe("Basic YWxpY2U6c2VjcmV0")
  })
})
