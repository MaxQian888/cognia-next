import {
  ADD_EXTERNAL_AGENT_ROUTE,
  CONFIGURE_EXTERNAL_AGENT_ROUTE,
  EXTERNAL_AGENTS_ROUTE,
  EXTERNAL_AGENT_DETAIL_ROUTE,
  configureExternalAgentHref,
  externalAgentDetailHref,
} from "./routes"

describe("external-agent routes", () => {
  it("nests the add flow under the list so back walks one step at a time", () => {
    expect(ADD_EXTERNAL_AGENT_ROUTE.startsWith(`${EXTERNAL_AGENTS_ROUTE}/`)).toBe(true)
    expect(CONFIGURE_EXTERNAL_AGENT_ROUTE.startsWith(`${ADD_EXTERNAL_AGENT_ROUTE}/`)).toBe(true)
  })

  it("carries the preset as a query parameter (static export has no dynamic segments)", () => {
    expect(configureExternalAgentHref("claude-code")).toBe(
      "/me/external-agents/new/configure?preset=claude-code"
    )
    expect(configureExternalAgentHref("custom")).toBe(
      "/me/external-agents/new/configure?preset=custom"
    )
  })

  it("encodes an id that is not URL-safe", () => {
    const href = configureExternalAgentHref("a b&c")
    expect(href).toBe("/me/external-agents/new/configure?preset=a%20b%26c")
    expect(new URL(href, "https://x").searchParams.get("preset")).toBe("a b&c")
  })

  it("puts the detail screen under the list, with the config id as a query parameter", () => {
    expect(EXTERNAL_AGENT_DETAIL_ROUTE.startsWith(`${EXTERNAL_AGENTS_ROUTE}/`)).toBe(true)
    expect(externalAgentDetailHref("eac_1")).toBe("/me/external-agents/detail?id=eac_1")
    const href = externalAgentDetailHref("a/b c")
    expect(new URL(href, "https://x").searchParams.get("id")).toBe("a/b c")
  })
})
