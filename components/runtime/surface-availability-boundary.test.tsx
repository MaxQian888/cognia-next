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
