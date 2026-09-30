import { render, screen } from "@testing-library/react"

import { PerfHudMount } from "./perf-hud-mount"

const pointer = { hasHover: true, coarse: false }

jest.mock("@/hooks/ui/use-pointer", () => ({
  useHasHover: () => pointer.hasHover,
  useCoarsePointer: () => pointer.coarse,
}))

// The HUD's own enable logic (dev auto-mount, localStorage opt-in, Capacitor
// exclusion) is covered in lib/perf/perf-hud.test.tsx. This suite pins only the
// gate in front of it.
jest.mock("@/lib/perf", () => ({
  PerfHud: () => <div data-testid="perf-hud-stub" />,
}))

beforeEach(() => {
  pointer.hasHover = true
  pointer.coarse = false
})

describe("<PerfHudMount />", () => {
  it("mounts the HUD on a hover-capable, fine-pointer device", () => {
    render(<PerfHudMount />)
    expect(screen.getByTestId("perf-hud-stub")).toBeInTheDocument()
  })

  // A phone: the HUD's fixed bottom-right box would sit on the tab bar's
  // Discover / Me targets and swallow taps.
  it("never mounts on a touch-only device", () => {
    pointer.hasHover = false
    pointer.coarse = true
    render(<PerfHudMount />)
    expect(screen.queryByTestId("perf-hud-stub")).not.toBeInTheDocument()
  })

  it("stays out when the primary pointer is coarse even if it reports hover", () => {
    pointer.coarse = true
    render(<PerfHudMount />)
    expect(screen.queryByTestId("perf-hud-stub")).not.toBeInTheDocument()
  })

  it("stays out when the primary pointer cannot hover", () => {
    pointer.hasHover = false
    render(<PerfHudMount />)
    expect(screen.queryByTestId("perf-hud-stub")).not.toBeInTheDocument()
  })
})
