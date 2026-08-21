import { isShellBypassRoute } from "./bypass-routes"

describe("isShellBypassRoute", () => {
  test("returns false for null/empty", () => {
    expect(isShellBypassRoute(null)).toBe(false)
    expect(isShellBypassRoute(undefined)).toBe(false)
    expect(isShellBypassRoute("")).toBe(false)
  })

  test("matches exact bypass prefix", () => {
    expect(isShellBypassRoute("/share-target")).toBe(true)
    expect(isShellBypassRoute("/pair")).toBe(true)
    expect(isShellBypassRoute("/oauth")).toBe(true)
    expect(isShellBypassRoute("/canvas/join")).toBe(true)
    // The transparent desktop-pet overlay + click popup routes must render
    // full-bleed with no desktop chrome so the frameless windows stay transparent.
    expect(isShellBypassRoute("/pet-overlay")).toBe(true)
    expect(isShellBypassRoute("/island")).toBe(true)
    expect(isShellBypassRoute("/pet-popup")).toBe(true)
    expect(isShellBypassRoute("/selection-toolbar")).toBe(true)
    expect(isShellBypassRoute("/selection-toolbar.html")).toBe(true)
    expect(isShellBypassRoute("/tray-panel")).toBe(true)
  })

  test("matches nested bypass route", () => {
    expect(isShellBypassRoute("/share-target/abc")).toBe(true)
    expect(isShellBypassRoute("/canvas/join/room-123")).toBe(true)
    expect(isShellBypassRoute("/pet-overlay/foo")).toBe(true)
  })

  test("does not match unrelated routes", () => {
    expect(isShellBypassRoute("/")).toBe(false)
    expect(isShellBypassRoute("/workflows")).toBe(false)
    expect(isShellBypassRoute("/canvas")).toBe(false)
    expect(isShellBypassRoute("/share-targeting")).toBe(false)
  })
})
