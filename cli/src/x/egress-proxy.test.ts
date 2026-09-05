/**
 * Unit tests for `cli/src/x/egress-proxy.ts`.
 */

import {
  EgressProxyError,
  LOOPBACK_BYPASS,
  NO_PROXY_ENV_NAMES,
  PROXY_ENV_NAMES,
  childProxyEnv,
  describeEgressProxy,
  resolveEgressProxy,
  routesThroughProxy,
} from "./egress-proxy"

const GATEWAY = "http://127.0.0.1:47823"

describe("resolveEgressProxy", () => {
  it("dials direct when nothing names a proxy", () => {
    const plan = resolveEgressProxy({ env: {} })
    expect(plan).toEqual({ kind: "direct", reason: "unset", bypass: [...LOOPBACK_BYPASS] })
  })

  it("prefers the flag over config over environment", () => {
    const env = { HTTPS_PROXY: "http://env-proxy:3128" }
    expect(
      resolveEgressProxy({ flag: "http://flag-proxy:1", configured: "http://cfg:2", env })
    ).toMatchObject({ kind: "proxy", source: "flag", url: "http://flag-proxy:1" })
    expect(resolveEgressProxy({ configured: "http://cfg:2", env })).toMatchObject({
      kind: "proxy",
      source: "config",
      url: "http://cfg:2",
    })
    expect(resolveEgressProxy({ env })).toMatchObject({
      kind: "proxy",
      source: "environment",
      url: "http://env-proxy:3128",
      endpoint: { protocol: "http", host: "env-proxy", port: 3128 },
    })
  })

  it("reads every environment casing and carries NO_PROXY into the bypass", () => {
    const plan = resolveEgressProxy({
      env: { all_proxy: "socks5://127.0.0.1:1080", no_proxy: ".corp.internal, 10.0.0.0/8" },
    })
    expect(plan).toMatchObject({
      kind: "proxy",
      source: "environment",
      endpoint: { protocol: "socks5", host: "127.0.0.1", port: 1080 },
    })
    expect(plan.bypass).toEqual([...LOOPBACK_BYPASS, ".corp.internal", "10.0.0.0/8"])
  })

  it("turns the proxy off with the literal `off`, even when the environment has one", () => {
    const env = { HTTPS_PROXY: "http://env-proxy:3128" }
    expect(resolveEgressProxy({ flag: "OFF", env })).toEqual({
      kind: "direct",
      reason: "flag-off",
      bypass: [...LOOPBACK_BYPASS],
    })
    expect(resolveEgressProxy({ configured: "off", env })).toEqual({
      kind: "direct",
      reason: "config-off",
      bypass: [...LOOPBACK_BYPASS],
    })
  })

  it("merges flag and config bypass lists without duplicates and keeps loopback first", () => {
    const plan = resolveEgressProxy({
      flag: "http://p:8080",
      bypassFlag: "localhost, api.internal ,API.INTERNAL",
      configuredBypass: ["192.168.0.0/16", "api.internal"],
      env: {},
    })
    expect(plan.bypass).toEqual([...LOOPBACK_BYPASS, "api.internal", "192.168.0.0/16"])
  })

  it("refuses a proxy value that cannot be dialled and names its source", () => {
    expect(() => resolveEgressProxy({ flag: "ftp://p:21", env: {} })).toThrow(EgressProxyError)
    expect(() => resolveEgressProxy({ flag: "ftp://p:21", env: {} })).toThrow(/^--proxy: /)
    expect(() => resolveEgressProxy({ configured: "not a url", env: {} })).toThrow(
      /^agentBackends\.<agent>\.proxy: /
    )
    expect(() => resolveEgressProxy({ env: { HTTP_PROXY: "::nope" } })).toThrow(/^HTTP_PROXY: /)
  })
})

describe("routesThroughProxy", () => {
  it("honours the bypass list and never proxies a direct plan", () => {
    const plan = resolveEgressProxy({ flag: "http://p:8080", bypassFlag: ".internal", env: {} })
    expect(routesThroughProxy(plan, "https://api.anthropic.com/v1/messages")).toBe(true)
    expect(routesThroughProxy(plan, "https://llm.internal/v1/messages")).toBe(false)
    expect(routesThroughProxy(plan, "http://127.0.0.1:47823/v1/models")).toBe(false)
    expect(routesThroughProxy(resolveEgressProxy({ env: {} }), "https://api.openai.com")).toBe(
      false
    )
  })
})

describe("childProxyEnv", () => {
  it("sets every casing and always exempts loopback plus the gateway host", () => {
    const plan = resolveEgressProxy({ flag: "http://user:pw@p:8080", env: {} })
    const env = childProxyEnv(plan, "http://gateway.lan:47823")
    for (const name of PROXY_ENV_NAMES) expect(env.set[name]).toBe("http://user:pw@p:8080")
    for (const name of NO_PROXY_ENV_NAMES) {
      expect(env.set[name]).toBe("localhost,127.0.0.1,::1,gateway.lan")
    }
    expect(env.unset).toEqual([])
  })

  it("does not repeat a loopback gateway host in the bypass", () => {
    const plan = resolveEgressProxy({ env: { HTTPS_PROXY: "http://p:8080" } })
    expect(childProxyEnv(plan, GATEWAY).set.NO_PROXY).toBe("localhost,127.0.0.1,::1")
  })

  it("strips the inherited proxy variables when the proxy is explicitly off", () => {
    const plan = resolveEgressProxy({ flag: "off", env: { HTTPS_PROXY: "http://p:8080" } })
    expect(childProxyEnv(plan, GATEWAY)).toEqual({ set: {}, unset: [...PROXY_ENV_NAMES] })
  })

  it("leaves the environment alone when nothing is configured", () => {
    expect(childProxyEnv(resolveEgressProxy({ env: {} }), GATEWAY)).toEqual({ set: {}, unset: [] })
  })
})

describe("describeEgressProxy", () => {
  it("redacts credentials and names the source", () => {
    const plan = resolveEgressProxy({ flag: "http://user:secret@p:8080", env: {} })
    const line = describeEgressProxy(plan)
    expect(line).not.toContain("secret")
    expect(line).toContain("http://p:8080")
    expect(line).toContain("via --proxy")
    expect(describeEgressProxy(resolveEgressProxy({ env: {} }))).toBe(
      "direct (no proxy configured)"
    )
    expect(describeEgressProxy(resolveEgressProxy({ flag: "off", env: {} }))).toBe(
      "direct (--proxy off)"
    )
  })
})
