/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

let mockPathname: string | null = "/"
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}))

import { isLightweightRoute, LightweightRouteShell } from "./lightweight-route-shell"

describe("isLightweightRoute", () => {
  it("matches public status and existing overlay routes", () => {
    expect(isLightweightRoute("/status")).toBe(true)
    expect(isLightweightRoute("/status.html")).toBe(true)
    expect(isLightweightRoute("/pet-overlay")).toBe(true)
    expect(isLightweightRoute("/pet-popup")).toBe(true)
    expect(isLightweightRoute("/island")).toBe(true)
    expect(isLightweightRoute("/selection-toolbar")).toBe(true)
  })

  it("keeps the tray panel out of the authenticated application runtime", () => {
    expect(isLightweightRoute("/tray-panel")).toBe(true)
  })

  it("accepts nested and trailing-slash forms without matching look-alike prefixes", () => {
    expect(isLightweightRoute("/status/")).toBe(true)
    expect(isLightweightRoute("/pet-overlay/avatar")).toBe(true)
    expect(isLightweightRoute("/status-page")).toBe(false)
    expect(isLightweightRoute("/pet-overlay-settings")).toBe(false)
  })

  it("rejects ordinary and unknown routes", () => {
    expect(isLightweightRoute("/servers")).toBe(false)
    expect(isLightweightRoute("/")).toBe(false)
    expect(isLightweightRoute(null)).toBe(false)
    expect(isLightweightRoute(undefined)).toBe(false)
  })

  it("treats the plugin surface harness as lightweight only in E2E builds", () => {
    const previous = process.env.NEXT_PUBLIC_E2E
    process.env.NEXT_PUBLIC_E2E = "1"
    expect(isLightweightRoute("/e2e/plugin-ui-surfaces")).toBe(true)
    expect(isLightweightRoute("/e2e/plugin-ui-surfaces.html")).toBe(true)
    process.env.NEXT_PUBLIC_E2E = "0"
    expect(isLightweightRoute("/e2e/plugin-ui-surfaces")).toBe(false)
    process.env.NEXT_PUBLIC_E2E = previous
  })
})

describe("LightweightRouteShell", () => {
  it("renders only the lightweight tree on the public status route", () => {
    mockPathname = "/status"
    render(
      <LightweightRouteShell lightweightShell={<div data-testid="lightweight" />}>
        <div data-testid="runtime" />
      </LightweightRouteShell>
    )

    expect(screen.getByTestId("lightweight")).toBeInTheDocument()
    expect(screen.queryByTestId("runtime")).toBeNull()
  })

  it("preserves the full runtime tree for ordinary routes", () => {
    mockPathname = "/servers"
    render(
      <LightweightRouteShell lightweightShell={<div data-testid="lightweight" />}>
        <div data-testid="runtime" />
      </LightweightRouteShell>
    )

    expect(screen.getByTestId("runtime")).toBeInTheDocument()
    expect(screen.queryByTestId("lightweight")).toBeNull()
  })
})
