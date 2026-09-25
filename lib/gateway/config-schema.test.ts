import { DEFAULT_GATEWAY_CONFIG } from "@/types/gateway"

import {
  isValidAllowlistEntry,
  isValidFieldStripException,
  parseGatewayConfig,
} from "./config-schema"

describe("GatewayConfig schema", () => {
  it("accepts the complete renderer/Rust configuration contract", () => {
    expect(parseGatewayConfig(DEFAULT_GATEWAY_CONFIG)).toEqual(DEFAULT_GATEWAY_CONFIG)
  })

  it("rejects unknown fields and invalid primitive ranges", () => {
    expect(() =>
      parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, apiKey: "must-not-enter-config" })
    ).toThrow(/apiKey/)
    expect(() => parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, port: 70000 })).toThrow(/port/)
    expect(() =>
      parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, retryStatusCodes: [99, 429] })
    ).toThrow(/retryStatusCodes/)
  })

  it("enforces the Rust backoff and required-timeout invariants", () => {
    expect(() =>
      parseGatewayConfig({
        ...DEFAULT_GATEWAY_CONFIG,
        retryBackoffBaseMs: 5000,
        retryBackoffMaxMs: 1000,
      })
    ).toThrow(/retryBackoffBaseMs/)
    expect(() => parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, connectTimeoutSecs: 0 })).toThrow(
      /connectTimeoutSecs/
    )
    expect(() => parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimitPerMin: 0 })).toThrow(
      /rateLimitPerMin/
    )
  })

  it("refuses allowlist entries Rust's CIDR parser would reject", () => {
    expect(() =>
      parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, allowlist: ["10.0.0.0/33"] })
    ).toThrow(/allowlist/)
  })

  it("refuses field-strip exceptions that could never match a provider", () => {
    expect(() =>
      parseGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, fieldStripAllow: ["service_tier"] })
    ).toThrow(/fieldStripAllow/)
  })
})

describe("isValidAllowlistEntry", () => {
  // `/08` and `/+8` look odd, but Rust's `u8::from_str` takes them — refusing
  // them here would block Apply on a config the gateway itself accepts.
  it.each([
    "127.0.0.1",
    "127.0.0.1/32",
    "10.0.0.0/8",
    "0.0.0.0/0",
    " 192.168.1.0/24 ",
    "10.0.0.0/08",
    "10.0.0.0/+8",
  ])("accepts %s", (entry) => expect(isValidAllowlistEntry(entry)).toBe(true))

  it.each([
    "",
    "localhost",
    "256.0.0.1",
    "10.0.0/8",
    "10.0.0.0/33",
    "01.2.3.4",
    "::1",
    "10.0.0.0/",
    "10.0.0.0/-1",
    "10.0.0.0/8/8",
    "10.0.0.0 /8",
  ])("rejects %s", (entry) => expect(isValidAllowlistEntry(entry)).toBe(false))
})

describe("isValidFieldStripException", () => {
  it("accepts providerId:field, including dotted paths", () => {
    expect(isValidFieldStripException("openai:service_tier")).toBe(true)
    expect(isValidFieldStripException("anthropic:stream_options.include_obfuscation")).toBe(true)
  })

  it.each(["service_tier", ":store", "openai:", "open ai:store"])("rejects %s", (entry) =>
    expect(isValidFieldStripException(entry)).toBe(false)
  )
})
