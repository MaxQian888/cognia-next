/** @jest-environment jsdom */

import {
  isInAppHref,
  onPluginNavigationRequest,
  requestPluginNavigation,
} from "./navigation-request"

describe("isInAppHref", () => {
  it.each(["/settings?section=mcp&preset=playwright", "/plugins", "/chat#anchor"])(
    "accepts the in-app path %s",
    (href) => expect(isInAppHref(href)).toBe(true)
  )

  it.each([
    "",
    "settings",
    "//evil.example/x",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    `/${"a".repeat(2050)}`,
  ])("refuses %s", (href) => expect(isInAppHref(href)).toBe(false))
})

describe("plugin navigation requests", () => {
  it("delivers an in-app request to the router bridge", () => {
    const handler = jest.fn()
    const unsubscribe = onPluginNavigationRequest(handler)
    expect(requestPluginNavigation("acme", "/settings?section=mcp")).toBe(true)
    expect(handler).toHaveBeenCalledWith({ pluginId: "acme", href: "/settings?section=mcp" })
    unsubscribe()
    requestPluginNavigation("acme", "/plugins")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("dispatches nothing for an off-app href", () => {
    const handler = jest.fn()
    const unsubscribe = onPluginNavigationRequest(handler)
    expect(requestPluginNavigation("acme", "https://evil.example")).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("re-validates a forged event on the receiving side", () => {
    const handler = jest.fn()
    const unsubscribe = onPluginNavigationRequest(handler)
    window.dispatchEvent(
      new CustomEvent("cognia:plugin:navigate", {
        detail: { pluginId: "acme", href: "//evil.example" },
      })
    )
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })
})
