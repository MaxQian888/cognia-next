import { render, screen } from "@testing-library/react"

import { SurfaceAvailabilityBoundary } from "./surface-availability-boundary"

let pathname = "/browser"
let snapshot: Record<string, unknown>

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}))

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => snapshot,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { reason?: string }) =>
    key === "readOnly" ? `Read only: ${values?.reason}` : key,
}))

beforeEach(() => {
  pathname = "/browser"
  snapshot = {
    target: { id: "web-standalone", kind: "standalone", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
  }
})

it("returns an explanatory recovery page for a host-only standalone deep link", () => {
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.queryByText("browser implementation")).not.toBeInTheDocument()
  expect(screen.getByText("states.unsupported")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "pairHost" })).toHaveAttribute("href", "/pair")
})

it("lets the recovery page claim the whole content slot", () => {
  // The shell hands routes a flex-row slot. A `<main>` that neither grows nor
  // spans it shrinks to its own max-width and hugs the left edge, which is how
  // /performance ended up showing a narrow column against an empty page.
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )

  const main = screen.getByRole("main")
  expect(main).toHaveClass("flex-1", "w-full")
})

it("sends a blocked /me sub-page back to /me, not into chat", () => {
  // The boundary replaces the whole route, page chrome included, so /me/terminal
  // lost its back arrow. The only exit left was a button that dropped the reader
  // into chat, one level past where they came from.
  pathname = "/me/terminal"
  render(
    <SurfaceAvailabilityBoundary>
      <div>terminal implementation</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.queryByText("terminal implementation")).not.toBeInTheDocument()
  expect(screen.getByRole("link", { name: "back" })).toHaveAttribute("href", "/me")
  expect(screen.queryByRole("link", { name: "backToChat" })).not.toBeInTheDocument()
})

it("still offers chat as the exit from a top-level capability route", () => {
  render(
    <SurfaceAvailabilityBoundary>
      <div>browser implementation</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByRole("link", { name: "backToChat" })).toHaveAttribute("href", "/")
})

it("keeps the standalone plugin library fully available without a read-only banner", () => {
  pathname = "/plugins"

  render(
    <SurfaceAvailabilityBoundary>
      <div>plugin library</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.getByText("plugin library")).toBeInTheDocument()
})

it("keeps cached Companion content visible with an explicit read-only banner", () => {
  pathname = "/workflows/runs"
  snapshot = {
    target: {
      id: "companion-studio",
      kind: "companion",
      hostKind: "desktop",
      platform: "web",
    },
    vaultState: "unlocked",
    connectionState: "offline",
  }
  render(
    <SurfaceAvailabilityBoundary>
      <div>cached runs</div>
    </SurfaceAvailabilityBoundary>
  )

  expect(screen.getByRole("status")).toHaveTextContent("Read only: reasons.offline-cache")
  expect(screen.getByText("cached runs")).toBeInTheDocument()
})

it("does not intercept internal popup routes", () => {
  pathname = "/pet-popup"
  render(
    <SurfaceAvailabilityBoundary>
      <div>popup harness</div>
    </SurfaceAvailabilityBoundary>
  )
  expect(screen.getByText("popup harness")).toBeInTheDocument()
})
