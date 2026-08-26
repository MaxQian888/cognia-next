import { isCredentiallessOtlpEndpoint, resolveOtlpEgressPolicy } from "./otlp-egress-policy"

describe("OTLP egress policy", () => {
  it("keeps credentialed Grafana export inside the Tauri host", () => {
    expect(resolveOtlpEgressPolicy({ isTauri: true, preset: "grafana-cloud" })).toBe("host")
  })

  it("allows a credentialless collector from browser and mobile runtimes", () => {
    expect(resolveOtlpEgressPolicy({ isTauri: false, preset: "self-hosted" })).toBe("collector")
    expect(resolveOtlpEgressPolicy({ isTauri: false, preset: "custom" })).toBe("collector")
  })

  it("blocks direct credentialed export from a WebView", () => {
    expect(resolveOtlpEgressPolicy({ isTauri: false, preset: "grafana-cloud" })).toBe("blocked")
    expect(resolveOtlpEgressPolicy({ isTauri: false, preset: "off" })).toBe("blocked")
  })

  it("accepts only credentialless HTTP collector URLs in a WebView", () => {
    expect(isCredentiallessOtlpEndpoint("http://localhost:4318/v1/traces")).toBe(true)
    expect(isCredentiallessOtlpEndpoint("https://collector.example/v1/traces")).toBe(true)
    expect(isCredentiallessOtlpEndpoint("https://user:secret@collector.example/v1/traces")).toBe(
      false
    )
    expect(isCredentiallessOtlpEndpoint("https://collector.example/v1/traces?api_key=secret")).toBe(
      false
    )
    expect(isCredentiallessOtlpEndpoint("https://collector.example/v1/traces#secret")).toBe(false)
    expect(isCredentiallessOtlpEndpoint("file:///tmp/collector")).toBe(false)
    expect(isCredentiallessOtlpEndpoint("not a URL")).toBe(false)
  })
})
