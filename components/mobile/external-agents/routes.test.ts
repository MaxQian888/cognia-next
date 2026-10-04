import {
  ADD_EXTERNAL_AGENT_ROUTE,
  CONFIGURE_EXTERNAL_AGENT_ROUTE,
  EXTERNAL_AGENTS_ROUTE,
  configureExternalAgentHref,
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
})
