/**
 * The dormancy reduction is only honest if the row says it. These tests pin the
 * three axes CLAUDE.md working rule 7 asks for on the UI side: the state is
 * named, the reason is written out, and the control is present but inert with
 * an explanation rather than missing.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow, DeviceWanState } from "@/lib/devices/types"
import {
  getWanWakeOverrides,
  resetWanWakeOverridesForTests,
  wakeDeviceForWan,
} from "@/lib/signaling/wan-wake-overrides"

import { WanSection } from "./wan-section"

function row(state: DeviceWanState, overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:d1",
    kind: "paired-device",
    label: "Max's iPhone",
    isSelf: false,
    deviceId: "d1",
    adminState: "active",
    reachability: "offline",
    liveness: { online: false, lastSeenAt: 1, source: "request" },
    lastSeenAt: 1,
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    wan: {
      state,
      lastEvidenceAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      canWake: state === "dormant",
    },
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

afterEach(() => {
  resetWanWakeOverridesForTests()
})

describe("WanSection — what it renders at all", () => {
  it("is absent for a machine that never costs a rendezvous socket", () => {
    const { container } = render(
      <WanSection row={row("automatic", { kind: "remote-host", wan: undefined })} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders for a paired device", () => {
    render(<WanSection row={row("automatic")} />)
    expect(screen.getByTestId("device-section-wan")).toBeInTheDocument()
  })
})

describe("WanSection — a dormant device", () => {
  it("says no connection is held rather than leaving the reader to guess", () => {
    render(<WanSection row={row("dormant")} />)
    expect(screen.getByTestId("wan-state-badge")).toHaveTextContent("Not held open")
    expect(screen.getByTestId("wan-reason")).toHaveTextContent(
      /has not checked in for over 30 days/
    )
  })

  it("promises that nothing about the pairing was touched", () => {
    // The whole point of the design: this drops a socket, not a device.
    render(<WanSection row={row("dormant")} />)
    expect(screen.getByTestId("wan-reason")).toHaveTextContent(
      /pairing, its keys and its permissions are untouched/
    )
  })

  it("offers a working wake button that records the override", async () => {
    render(<WanSection row={row("dormant")} />)
    const wake = screen.getByTestId("wan-wake")
    expect(wake).toBeEnabled()
    await userEvent.click(wake)
    expect([...getWanWakeOverrides()]).toEqual(["d1"])
  })
})

describe("WanSection — a held-open device", () => {
  it("tells an automatic connection apart from one the owner asked for", () => {
    render(<WanSection row={row("automatic")} />)
    expect(screen.getByTestId("wan-state-badge")).toHaveTextContent("Held open")
    expect(screen.queryByTestId("wan-sleep")).not.toBeInTheDocument()
  })

  it("lets the owner drop an override again, which is not the same as disconnecting", async () => {
    // The override has to be there before the click, or the assertion below
    // measures the starting state and passes for a `sleepDeviceForWan` that
    // does nothing at all.
    wakeDeviceForWan("d1")
    expect([...getWanWakeOverrides()]).toEqual(["d1"])

    render(<WanSection row={row("woken")} />)
    expect(screen.getByTestId("wan-state-badge")).toHaveTextContent("Held open on request")
    await userEvent.click(screen.getByTestId("wan-sleep"))
    expect(getWanWakeOverrides().size).toBe(0)
  })

  it("does not claim the socket is up this second", () => {
    render(<WanSection row={row("automatic")} />)
    expect(screen.getByText(/not whether the device is answering right now/)).toBeInTheDocument()
  })
})

describe("WanSection — the states that are not one click away", () => {
  const inert: Array<[DeviceWanState, RegExp]> = [
    ["blocked", /paused or revoked/],
    ["unprovisioned", /paired before relay connections existed/],
    ["disabled", /switched off for every device/],
    ["unmanaged", /Only the desktop app/],
  ]

  it.each(inert)("renders the button disabled for %s, with the reason beside it", (state, why) => {
    // Hiding it would merge "can never hold one", "the master switch is off",
    // and "one click away" into the same blank space.
    render(<WanSection row={row(state)} />)
    const wake = screen.getByTestId("wan-wake")
    expect(wake).toBeInTheDocument()
    expect(wake).toBeDisabled()
    expect(screen.getByTestId("wan-reason")).toHaveTextContent(why)
  })

  it.each(inert)("does not record an override when %s is clicked", async (state) => {
    render(<WanSection row={row(state)} />)
    await userEvent.click(screen.getByTestId("wan-wake"))
    expect(getWanWakeOverrides().size).toBe(0)
  })

  it("names each state distinctly, so none of them collapses into another", () => {
    const labels = new Set<string>()
    for (const state of [
      "automatic",
      "woken",
      "dormant",
      "blocked",
      "unprovisioned",
      "disabled",
      "unmanaged",
    ] as DeviceWanState[]) {
      const { unmount } = render(<WanSection row={row(state)} />)
      const text = screen.getByTestId("wan-state-badge").textContent ?? ""
      expect(text).not.toMatch(/^devices\.wan/)
      labels.add(text)
      unmount()
    }
    expect(labels.size).toBe(7)
  })
})

describe("WanSection — the way out", () => {
  it("links to the relay settings that show the live tier", () => {
    render(<WanSection row={row("dormant")} />)
    expect(screen.getByTestId("wan-settings")).toHaveAttribute(
      "href",
      "/settings?section=companion"
    )
  })

  it("reads 'never' rather than 1970 for a device with no recorded activity", () => {
    render(
      <WanSection
        row={row("dormant", {
          wan: { state: "dormant", canWake: true },
        })}
      />
    )
    expect(screen.getByTestId("device-section-wan")).toHaveTextContent("Never")
  })
})
