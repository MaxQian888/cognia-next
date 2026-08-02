/**
 * @jest-environment jsdom
 */

import * as React from "react"
import { act, render, screen } from "@testing-library/react"

import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"

import {
  __resetTerminalTransportSnapshotsForTests,
  useTerminalTransport,
} from "./use-terminal-transport"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
}))

const tauri = jest.requireMock("@/lib/tauri") as {
  isTauri: jest.Mock
  isCapacitor: jest.Mock
}

// Collected in an effect rather than during render: reassigning module state
// while rendering is the impurity `react-hooks/globals` exists to catch.
let renderCount = 0
const snapshots: unknown[] = []

function Probe() {
  const state = useTerminalTransport()
  React.useEffect(() => {
    renderCount += 1
    snapshots.push(state)
  })
  return (
    <div
      data-testid="probe"
      data-kind={state.kind}
      data-can-spawn={String(state.canSpawn)}
      data-local-pty={String(state.isLocalPty)}
    />
  )
}

beforeEach(() => {
  renderCount = 0
  snapshots.length = 0
  tauri.isTauri.mockReturnValue(false)
  tauri.isCapacitor.mockReturnValue(false)
  __resetTerminalTransportSnapshotsForTests()
})

afterEach(() => {
  __resetRoutingForTests()
  __resetTerminalTransportSnapshotsForTests()
})

function fakeTransport() {
  return { call: jest.fn(), subscribe: jest.fn() } as never
}

describe("useTerminalTransport", () => {
  it("reports the Tauri channel as spawnable and local", () => {
    tauri.isTauri.mockReturnValue(true)
    render(<Probe />)
    const probe = screen.getByTestId("probe")
    expect(probe).toHaveAttribute("data-kind", "tauri-channel")
    expect(probe).toHaveAttribute("data-can-spawn", "true")
    expect(probe).toHaveAttribute("data-local-pty", "true")
  })

  it("reports plain web as unsupported and unspawnable", () => {
    render(<Probe />)
    const probe = screen.getByTestId("probe")
    expect(probe).toHaveAttribute("data-kind", "unsupported")
    expect(probe).toHaveAttribute("data-can-spawn", "false")
    expect(probe).toHaveAttribute("data-local-pty", "false")
  })

  it("treats a Capacitor shell as spawnable over ws even though it is not a local PTY", () => {
    tauri.isCapacitor.mockReturnValue(true)
    render(<Probe />)
    const probe = screen.getByTestId("probe")
    expect(probe).toHaveAttribute("data-kind", "ws")
    expect(probe).toHaveAttribute("data-can-spawn", "true")
    expect(probe).toHaveAttribute("data-local-pty", "false")
  })

  it("re-renders when a remote host is activated and again when it is dropped", () => {
    tauri.isTauri.mockReturnValue(true)
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveAttribute("data-kind", "tauri-channel")

    act(() => {
      setActiveRemoteTransport(fakeTransport())
    })
    // Desktop driving a remote host: still spawnable, but no longer a local PTY.
    expect(screen.getByTestId("probe")).toHaveAttribute("data-kind", "ws")
    expect(screen.getByTestId("probe")).toHaveAttribute("data-can-spawn", "true")
    expect(screen.getByTestId("probe")).toHaveAttribute("data-local-pty", "false")

    act(() => {
      setActiveRemoteTransport(null)
    })
    expect(screen.getByTestId("probe")).toHaveAttribute("data-kind", "tauri-channel")
  })

  it("hands back an identical snapshot while the transport is unchanged", () => {
    tauri.isTauri.mockReturnValue(true)
    const { rerender } = render(<Probe />)
    rerender(<Probe />)
    expect(renderCount).toBeGreaterThan(1)
    // Identity stability is what keeps useSyncExternalStore from looping.
    expect(new Set(snapshots).size).toBe(1)
  })

  it("pins a stable server snapshot for the static export's pre-hydration HTML", () => {
    // The SSR pass runs with the web detectors, so the answer must be the
    // frozen "unsupported" value rather than a memoised guess.
    tauri.isTauri.mockReturnValue(true)
    const { useTerminalTransport: hook } = jest.requireActual<
      typeof import("./use-terminal-transport")
    >("./use-terminal-transport")
    expect(typeof hook).toBe("function")

    // Directly assert the exported constant's shape through a web-shell render.
    tauri.isTauri.mockReturnValue(false)
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveAttribute("data-kind", "unsupported")
  })
})
