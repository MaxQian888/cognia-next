import { evaluateMcpAppSandbox, injectMcpAppCsp, MCP_APP_SANDBOX_PROXY_HTML } from "./apps-sandbox"

describe("MCP Apps sandbox policy", () => {
  it("requires exact approval for every origin and browser permission", () => {
    const requested = {
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    }
    expect(
      evaluateMcpAppSandbox(
        requested,
        { camera: {}, microphone: {} },
        {
          origins: { connectDomains: ["https://api.example.com"] },
          permissions: { camera: true },
        }
      )
    ).toMatchObject({
      allowed: false,
      denied: ["resourceDomains:https://cdn.example.com", "permission:microphone"],
    })

    expect(
      evaluateMcpAppSandbox(
        requested,
        { camera: {} },
        {
          origins: {
            connectDomains: ["https://api.example.com"],
            resourceDomains: ["https://cdn.example.com"],
          },
          permissions: { camera: true },
        }
      )
    ).toMatchObject({ allowed: true, sandbox: "allow-scripts" })
  })

  it("rejects unsafe, credential-bearing and non-origin CSP entries", () => {
    for (const origin of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/script.js",
    ]) {
      expect(() =>
        evaluateMcpAppSandbox(
          { resourceDomains: [origin] },
          {},
          { origins: { resourceDomains: [origin] } }
        )
      ).toThrow()
    }
  })

  it("injects a restrictive CSP and keeps form navigation disabled", () => {
    const html = injectMcpAppCsp("<html><head></head><body>App</body></html>", {
      connectDomains: ["https://api.example.com"],
    })
    expect(html).toContain("connect-src https://api.example.com")
    expect(html).toContain("form-action 'none'")
    expect(html).toContain("frame-src 'none'")
  })

  it("uses an opaque double-iframe proxy with no same-origin or download grant", () => {
    expect(MCP_APP_SANDBOX_PROXY_HTML).toContain("sandbox-resource-ready")
    expect(MCP_APP_SANDBOX_PROXY_HTML).toContain('"allow-scripts"')
    expect(MCP_APP_SANDBOX_PROXY_HTML).not.toContain("allow-same-origin")
    expect(MCP_APP_SANDBOX_PROXY_HTML).not.toContain("allow-downloads")
  })
})
