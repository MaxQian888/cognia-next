import { DEFAULT_GATEWAY_CONFIG } from "@/types/gateway"

import { parseGatewayConfig } from "./config-schema"

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
})
