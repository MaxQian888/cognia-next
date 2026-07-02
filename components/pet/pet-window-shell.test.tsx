/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

let mockPathname: string | null = "/"
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}))

import { isPetWindowRoute, PetWindowShell } from "./pet-window-shell"

describe("isPetWindowRoute", () => {
  it("matches the pet overlay and popup routes exactly", () => {
    expect(isPetWindowRoute("/pet-overlay")).toBe(true)
    expect(isPetWindowRoute("/pet-popup")).toBe(true)
  })

  it("matches trailing-slash / nested forms (static export serves both)", () => {
    expect(isPetWindowRoute("/pet-overlay/")).toBe(true)
    expect(isPetWindowRoute("/pet-popup/")).toBe(true)
  })

  it("rejects every other route, including look-alike prefixes", () => {
    expect(isPetWindowRoute("/")).toBe(false)
    expect(isPetWindowRoute("/chat")).toBe(false)
    // A prefix must be a full path segment, not a string prefix.
    expect(isPetWindowRoute("/pet-overlay-settings")).toBe(false)
    expect(isPetWindowRoute("/pet")).toBe(false)
  })

  it("rejects null / undefined / empty pathnames", () => {
    expect(isPetWindowRoute(null)).toBe(false)
    expect(isPetWindowRoute(undefined)).toBe(false)
    expect(isPetWindowRoute("")).toBe(false)
  })
})

describe("PetWindowShell", () => {
  const tree = (
    <PetWindowShell petShell={<div data-testid="pet-shell" />}>
      <div data-testid="app-runtime" />
    </PetWindowShell>
  )

  it("renders only the minimal pet shell on the overlay route", () => {
    mockPathname = "/pet-overlay"
    render(tree)
    expect(screen.getByTestId("pet-shell")).toBeInTheDocument()
    expect(screen.queryByTestId("app-runtime")).not.toBeInTheDocument()
  })

  it("renders only the minimal pet shell on the popup route", () => {
    mockPathname = "/pet-popup"
    render(tree)
    expect(screen.getByTestId("pet-shell")).toBeInTheDocument()
    expect(screen.queryByTestId("app-runtime")).not.toBeInTheDocument()
  })

  it("renders the full app runtime everywhere else", () => {
    mockPathname = "/chat"
    render(tree)
    expect(screen.getByTestId("app-runtime")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-shell")).not.toBeInTheDocument()
  })

  it("falls back to the full app runtime when the pathname is unknown", () => {
    mockPathname = null
    render(tree)
    expect(screen.getByTestId("app-runtime")).toBeInTheDocument()
  })
})
