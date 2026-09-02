/**
 * The card's job is to be honest about what the platform can do. Most of these
 * tests are about the blocked path, because a switch that silently does
 * nothing is the specific failure this design refuses.
 */

const capabilitiesMock = jest.fn()
const listMonitorsMock = jest.fn(async () => [])
const setPlacementMock = jest.fn(async () => {})
const setMonitorMock = jest.fn(async () => {})
const setScaleMock = jest.fn(async () => 1)

jest.mock("@/lib/usage-dock/client", () => ({
  usageDockCapabilities: () => capabilitiesMock(),
  listUsageDockMonitors: () => listMonitorsMock(),
  setUsageDockPlacement: (...a: unknown[]) => setPlacementMock(...(a as [])),
  setUsageDockMonitor: (...a: unknown[]) => setMonitorMock(...(a as [])),
  setUsageDockScale: (...a: unknown[]) => setScaleMock(...(a as [])),
}))

jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { monitorOptions, UsageDockCard } from "./usage-dock-card"
import { __resetUsageDockStoreForTesting, useUsageDockStore } from "@/lib/usage-dock/store"
import type { UsageDockMonitor } from "@/lib/usage-dock/types"

const supported = {
  positioning: true,
  alwaysOnTop: true,
  globalHover: true,
  platform: "macos",
  blockedReason: null,
}

const blocked = {
  positioning: false,
  alwaysOnTop: false,
  globalHover: false,
  platform: "linux",
  blockedReason: "waylandPositioning",
}

beforeEach(() => {
  __resetUsageDockStoreForTesting()
  capabilitiesMock.mockReset().mockResolvedValue(supported)
  listMonitorsMock.mockReset().mockResolvedValue([])
  setPlacementMock.mockClear()
  setMonitorMock.mockClear()
  setScaleMock.mockClear()
})

const monitor = (over: Partial<UsageDockMonitor> = {}): UsageDockMonitor => ({
  name: "Built-in",
  width: 1920,
  height: 1080,
  scale: 2,
  isPrimary: false,
  isPreferred: false,
  ...over,
})

describe("monitorOptions", () => {
  it("puts the primary display first", () => {
    const list = monitorOptions([
      monitor({ name: "External" }),
      monitor({ name: "Built-in", isPrimary: true }),
    ])
    expect(list.map((m) => m.name)).toEqual(["Built-in", "External"])
  })

  it("is stable for an empty list", () => {
    expect(monitorOptions([])).toEqual([])
  })
})

describe("UsageDockCard", () => {
  it("enables its controls on a platform that supports the rail", async () => {
    render(<UsageDockCard />)
    await waitFor(() => expect(capabilitiesMock).toHaveBeenCalled())
    expect(screen.getByLabelText("Show the Capacity Dock")).toBeEnabled()
    expect(screen.getByLabelText("Screen edge")).toBeEnabled()
  })

  it("ships off, so no window opens without being asked for", async () => {
    render(<UsageDockCard />)
    await waitFor(() => expect(capabilitiesMock).toHaveBeenCalled())
    expect(screen.getByLabelText("Show the Capacity Dock")).not.toBeChecked()
  })

  it("explains a compositor that cannot host the rail, and names the fallback", async () => {
    capabilitiesMock.mockResolvedValue(blocked)
    render(<UsageDockCard />)
    expect(await screen.findByRole("note")).toHaveTextContent(/Wayland/)
    expect(screen.getByRole("note")).toHaveTextContent(/tray usage readout still works/)
  })

  it("disables rather than hides the controls when the rail cannot run", async () => {
    // Hiding them would leave no explanation attached to anything.
    capabilitiesMock.mockResolvedValue(blocked)
    render(<UsageDockCard />)
    await waitFor(() => expect(screen.getByLabelText("Show the Capacity Dock")).toBeDisabled())
    expect(screen.getByLabelText("Screen edge")).toBeDisabled()
  })

  it("persists the enabled flag through the store", async () => {
    render(<UsageDockCard />)
    await waitFor(() => expect(capabilitiesMock).toHaveBeenCalled())
    await userEvent.click(screen.getByLabelText("Show the Capacity Dock"))
    expect(useUsageDockStore.getState().preferences.enabled).toBe(true)
  })

  it("disables the display picker when no monitor was reported", async () => {
    render(<UsageDockCard />)
    await waitFor(() => expect(listMonitorsMock).toHaveBeenCalled())
    expect(screen.getByLabelText("Display")).toBeDisabled()
  })

  it("resets back to the shipped defaults", async () => {
    render(<UsageDockCard />)
    await waitFor(() => expect(capabilitiesMock).toHaveBeenCalled())
    act(() => useUsageDockStore.getState().setPreferences({ enabled: true, edge: "left" }))
    await userEvent.click(screen.getByRole("button", { name: "Reset dock settings" }))
    expect(useUsageDockStore.getState().preferences).toMatchObject({
      enabled: false,
      edge: "right",
    })
  })
})
