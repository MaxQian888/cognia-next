/**
 * @jest-environment jsdom
 */

/**
 * Terminal share dialog (ADR-0133): renders the host roster live from the
 * session registry, lists paired devices with their remote-terminal grant,
 * drives the shared grant flow, and points at Settings for the two things it
 * must not flip itself (host remote access, pairing).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import { useSettingsStore } from "@/stores/settings"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

const registry: {
  info: Record<string, unknown> | null
  listeners: Set<() => void>
} = { info: null, listeners: new Set() }

jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: () => (registry.info ? { info: registry.info } : undefined),
  subscribeLiveSessions: (listener: () => void) => {
    registry.listeners.add(listener)
    return () => registry.listeners.delete(listener)
  },
}))

const grantsState: { map: Map<string, { deviceId: string; terminal: boolean }> | undefined } = {
  map: undefined,
}
const refreshMock = jest.fn(async () => undefined)
const toggleMock = jest.fn(async () => undefined)
jest.mock("@/hooks/companion/use-remote-terminal-grant", () => ({
  useDeviceGrants: () => ({ grants: grantsState.map, refresh: refreshMock }),
  useRemoteTerminalGrantToggle: () => toggleMock,
}))

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

// dexie-react-hooks' useLiveQuery needs Dexie internals; the dialog takes the
// device query as a prop, so resolve it through a plain state hook here.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[], initial: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react") as typeof import("react")
    const [value, setValue] = React.useState(initial)
    React.useEffect(() => {
      let live = true
      void querier().then((next) => {
        if (live) setValue(next)
      })
      return () => {
        live = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

import { TerminalShareDialog, sessionRosterSnapshot } from "./terminal-share-dialog"

function device(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "dev-1",
    label: "Max's iPhone",
    platform: "ios",
    pubkey: "pk-1",
    pairedAt: 1,
    allowRemoteControl: false,
    allowAgentControl: false,
    allowRemoteTerminal: false,
    allowLockedComputerUse: false,
    ...overrides,
  } as PairedDeviceRow
}

function seedRemoteAccess(enabled: boolean) {
  useSettingsStore.setState({
    settings: { terminal: { host: { allowRemoteAccess: enabled } } },
  } as never)
}

function renderDialog(devices: PairedDeviceRow[] = [device()]) {
  const onOpenChange = jest.fn()
  const utils = render(
    <TerminalShareDialog
      sessionId="s-1"
      open
      onOpenChange={onOpenChange}
      listDevices={async () => devices}
    />
  )
  return { ...utils, onOpenChange }
}

beforeEach(() => {
  registry.info = {
    id: "s-1",
    currentController: "desktop",
    attachedClients: 2,
    participants: [
      { clientId: "desktop", deviceId: null, local: true, role: "controller" },
      { clientId: "companion:dev-1", deviceId: "dev-1", local: false, role: "viewer" },
    ],
  }
  registry.listeners.clear()
  grantsState.map = new Map([["dev-1", { deviceId: "dev-1", terminal: true }]])
  setTauri(true)
  mockPush.mockReset()
  toggleMock.mockReset()
  seedRemoteAccess(true)
})

afterEach(() => {
  setTauri(false)
})

describe("sessionRosterSnapshot", () => {
  it("is identity-stable until the roster content changes and clears on unregister", () => {
    const first = sessionRosterSnapshot("s-1")
    expect(sessionRosterSnapshot("s-1")).toBe(first)
    registry.info = { ...registry.info, participants: [] }
    const second = sessionRosterSnapshot("s-1")
    expect(second).not.toBe(first)
    expect(second?.shared).toBe(false)
    registry.info = null
    expect(sessionRosterSnapshot("s-1")).toBeNull()
  })
})

describe("<TerminalShareDialog />", () => {
  it("renders the roster with device labels and lease roles, and the device grant switch", async () => {
    renderDialog()
    const roster = screen.getByTestId("terminal-share-participants")
    expect(roster.querySelectorAll("li")).toHaveLength(2)
    expect(roster.querySelector('[data-client-id="desktop"]')).toHaveTextContent("This device")
    expect(roster.querySelector('[data-client-id="desktop"]')).toHaveTextContent("Controller")
    await waitFor(() =>
      expect(roster.querySelector('[data-client-id="companion:dev-1"]')).toHaveTextContent(
        "Max's iPhone"
      )
    )
    const row = await screen.findByTestId("terminal-share-device-dev-1")
    expect(row).toHaveTextContent("Attached")
    expect(row).toHaveTextContent("Can attach to terminals on this host")
    const grantSwitch = screen.getByTestId("terminal-share-grant-dev-1")
    expect(grantSwitch).toHaveAttribute("aria-checked", "true")
    expect(screen.queryByTestId("terminal-share-remote-access-off")).toBeNull()
  })

  it("drives the shared grant flow with the device's key and label", async () => {
    grantsState.map = new Map([["dev-1", { deviceId: "dev-1", terminal: false }]])
    renderDialog()
    const grantSwitch = await screen.findByTestId("terminal-share-grant-dev-1")
    expect(grantSwitch).toHaveAttribute("aria-checked", "false")
    await act(async () => {
      fireEvent.click(grantSwitch)
    })
    expect(toggleMock).toHaveBeenCalledWith("dev-1", "pk-1", "Max's iPhone", true)
  })

  it("re-renders when the host pushes a new roster", async () => {
    renderDialog()
    registry.info = {
      ...registry.info,
      participants: [{ clientId: "desktop", deviceId: null, local: true, role: "controller" }],
    }
    act(() => {
      registry.listeners.forEach((listener) => listener())
    })
    expect(screen.getByTestId("terminal-share-participants").querySelectorAll("li")).toHaveLength(1)
    const row = await screen.findByTestId("terminal-share-device-dev-1")
    expect(row).not.toHaveTextContent("Attached")
  })

  it("explains an unknown roster and a session that is not live here", () => {
    registry.info = { id: "s-1", attachedClients: 3 }
    const { unmount } = renderDialog()
    expect(screen.getByTestId("terminal-share-roster-unknown")).toHaveTextContent(
      "3 attached clients"
    )
    unmount()
    registry.info = null
    renderDialog()
    expect(screen.getByText("This session is not attached in this window.")).toBeInTheDocument()
  })

  it("disables switches for revoked devices and off Tauri", async () => {
    setTauri(false)
    renderDialog([device(), device({ deviceId: "dev-2", label: "Old", revokedAt: 1 })])
    expect(await screen.findByTestId("terminal-share-grant-dev-1")).toBeDisabled()
    expect(screen.getByTestId("terminal-share-grant-dev-2")).toBeDisabled()
    expect(screen.getByTestId("terminal-share-device-dev-2")).toHaveTextContent("Revoked or paused")
  })

  it("points at terminal settings when host remote access is off, closing itself", () => {
    seedRemoteAccess(false)
    const { onOpenChange } = renderDialog()
    const notice = screen.getByTestId("terminal-share-remote-access-off")
    fireEvent.click(notice.querySelector("button")!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockPush).toHaveBeenCalledWith("/settings?section=terminal")
  })

  it("offers pairing when there are no devices", async () => {
    const { onOpenChange } = renderDialog([])
    fireEvent.click(await screen.findByText("Pair a device"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockPush).toHaveBeenCalledWith("/settings?section=companion")
  })
})
