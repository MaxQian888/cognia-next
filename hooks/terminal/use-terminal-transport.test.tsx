/**
 * @jest-environment jsdom
 */

import * as React from "react"
import { renderToString } from "react-dom/server"
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

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: jest.fn(() => false),
}))

const tauri = jest.requireMock("@/lib/tauri") as {
  isTauri: jest.Mock
  isCapacitor: jest.Mock
}

const webCompanion = jest.requireMock("@/lib/platform/web-companion") as {
  hasWebCompanionTarget: jest.Mock
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
  webCompanion.hasWebCompanionTarget.mockReturnValue(false)
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

  it("treats a browser paired to a cognia-server as spawnable over ws", () => {
    webCompanion.hasWebCompanionTarget.mockReturnValue(true)
    render(<Probe />)
    const probe = screen.getByTestId("probe")
    expect(probe).toHaveAttribute("data-kind", "ws")
    expect(probe).toHaveAttribute("data-can-spawn", "true")
    expect(probe).toHaveAttribute("data-local-pty", "false")
  })

  it("re-renders when a cloud companion pairing completes mid-session", () => {
    // Pairing only writes localStorage, so without the config-changed
    // subscription the dock would keep rendering the unsupported empty state
    // until some unrelated re-render happened to move it.
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveAttribute("data-kind", "unsupported")

    webCompanion.hasWebCompanionTarget.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event("cognia:companion-config-changed"))
    })
    expect(screen.getByTestId("probe")).toHaveAttribute("data-kind", "ws")
    expect(screen.getByTestId("probe")).toHaveAttribute("data-can-spawn", "true")
  })

  it("stops listening for pairing changes once unmounted", () => {
    const { unmount } = render(<Probe />)
    unmount()
    webCompanion.hasWebCompanionTarget.mockReturnValue(true)
    // No React update may be scheduled for an unmounted tree.
    expect(() =>
      act(() => {
        window.dispatchEvent(new Event("cognia:companion-config-changed"))
      })
    ).not.toThrow()
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
    // `renderToString` takes the getServerSnapshot path — the only way to prove
    // the SSR answer is the frozen "unsupported" value and not a memoised guess
    // that hydration is about to contradict.
    tauri.isTauri.mockReturnValue(true)
    webCompanion.hasWebCompanionTarget.mockReturnValue(true)
    const html = renderToString(<Probe />)
    expect(html).toContain('data-kind="unsupported"')
    expect(html).toContain('data-can-spawn="false"')
    expect(html).toContain('data-local-pty="false"')
  })
})
