/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PairedDeviceRow } from "@/types/mobile/paired-device"

// Resolve the querier the way dexie-react-hooks does: undefined until the
// first read settles, then its value.
jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual("react") as typeof import("react")
  return {
    useLiveQuery: <T,>(querier: () => Promise<T>) => {
      const [value, setValue] = React.useState<T | undefined>(undefined)
      React.useEffect(() => {
        let alive = true
        void querier().then((next) => {
          if (alive) setValue(next)
        })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return value
    },
  }
})

let pairedRows: PairedDeviceRow[] = []
let pairedError: Error | null = null
jest.mock("@/lib/db/paired-devices", () => ({
  listPairedDevices: () =>
    pairedError ? Promise.reject(pairedError) : Promise.resolve(pairedRows),
}))

let planes: Record<string, string> = {}
jest.mock("@/lib/companion/device-presence-registry", () => ({
  eventPlaneState: (deviceId: string) => planes[deviceId] ?? "disconnected",
}))

jest.mock("@/lib/sync/companion-sync", () => ({
  SYNC_HANDLER_TABLES: ["sessions", "messages", "settings"],
}))

const publishMock = jest.fn((_table: string) => undefined)
const flushMock = jest.fn(() => undefined)
jest.mock("@/lib/sync/host-invalidate", () => ({
  publishSyncInvalidate: (table: string) => publishMock(table),
  flushPendingSyncInvalidates: () => flushMock(),
}))

let remoteActive = false
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => remoteActive,
  subscribeActiveRemoteTransport: () => () => undefined,
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

import {
  StatusBarSync,
  activePairedDevices,
  canHearInvalidations,
  requestDeviceSync,
} from "./status-bar-sync"

function device(over: Partial<PairedDeviceRow>): PairedDeviceRow {
  return {
    deviceId: "d1",
    label: "Phone",
    platform: "ios",
    pubkey: "pk",
    pairedAt: 1,
    lastSeenAt: 1_700_000_000_000,
    ...over,
  } as PairedDeviceRow
}

beforeEach(() => {
  pairedRows = []
  pairedError = null
  planes = {}
  remoteActive = false
  publishMock.mockReset()
  publishMock.mockImplementation(() => undefined)
  flushMock.mockClear()
  pushMock.mockClear()
})

async function openPopover() {
  const user = userEvent.setup()
  await user.click(screen.getByTestId("status-sync"))
  await screen.findByTestId("status-sync-popover")
  return user
}

describe("pure helpers", () => {
  it("only live event streams can hear an invalidation", () => {
    expect(canHearInvalidations("ready")).toBe(true)
    expect(canHearInvalidations("replaying")).toBe(true)
    expect(canHearInvalidations("connecting")).toBe(false)
    expect(canHearInvalidations("degraded")).toBe(false)
    expect(canHearInvalidations("disconnected")).toBe(false)
  })

  it("drops revoked and paused devices", () => {
    const rows = [
      device({ deviceId: "a" }),
      device({ deviceId: "b", revokedAt: 5 }),
      device({ deviceId: "c", pausedAt: 5 }),
    ]
    expect(activePairedDevices(rows).map((row) => row.deviceId)).toEqual(["a"])
  })

  it("publishes every table and then flushes the coalescing window", () => {
    const calls: string[] = []
    requestDeviceSync(
      ["sessions", "messages"],
      (table) => calls.push(`publish:${table}`),
      () => calls.push("flush")
    )
    expect(calls).toEqual(["publish:sessions", "publish:messages", "flush"])
  })
})

describe("<StatusBarSync />", () => {
  it("is a real menu, not a dead button: no paired device offers Set up sync", async () => {
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("data-sync-state", "unpaired")
    )
    expect(screen.getByTestId("status-sync")).toHaveAttribute("title", "Sync not set up")
    const user = await openPopover()
    expect(screen.getByText(/No phone or browser is paired with this desktop yet/)).toBeVisible()
    expect(screen.queryByTestId("status-sync-now")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("status-sync-setup"))
    expect(pushMock).toHaveBeenCalledWith(
      "/settings?section=connectivity&connectivityPanel=pairing"
    )
  })

  it("lists paired devices with their connection state and last contact", async () => {
    pairedRows = [
      device({ deviceId: "d1", label: "Max's iPhone", lastSeenAt: 1_700_000_100_000 }),
      device({ deviceId: "d2", label: "Office browser", platform: "web", lastSeenAt: 0 }),
      device({ deviceId: "d3", label: "Old phone", revokedAt: 10 }),
    ]
    planes = { d1: "ready" }
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("title", "1/2 devices online")
    )
    await openPopover()
    const list = screen.getByTestId("status-sync-devices")
    expect(list).toHaveTextContent("Max's iPhone")
    expect(list).toHaveTextContent("Connected")
    expect(list).toHaveTextContent("Office browser")
    expect(list).toHaveTextContent("Offline")
    expect(list).toHaveTextContent("Never seen")
    expect(list).not.toHaveTextContent("Old phone")
    expect(screen.getByTestId("status-sync-last-contact")).toHaveTextContent(
      `Last device contact ${new Date(1_700_000_100_000).toISOString()}`
    )
  })

  it("Sync now asks every connected device to pull every table and says so", async () => {
    pairedRows = [device({ deviceId: "d1" }), device({ deviceId: "d2", label: "Tablet" })]
    planes = { d1: "ready", d2: "replaying" }
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("data-sync-state", "paired")
    )
    const user = await openPopover()
    await user.click(screen.getByTestId("status-sync-now"))
    expect(publishMock.mock.calls.map(([table]) => table)).toEqual([
      "sessions",
      "messages",
      "settings",
    ])
    expect(flushMock).toHaveBeenCalledTimes(1)
    const feedback = screen.getByTestId("status-sync-feedback")
    expect(feedback).toHaveAttribute("role", "status")
    expect(feedback).toHaveTextContent(
      "Asked 2 connected devices to sync now. They pull in the background."
    )
  })

  it("does not pretend to sync when no paired device is connected", async () => {
    pairedRows = [device({ deviceId: "d1" })]
    planes = { d1: "degraded" }
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("title", "0/1 devices online")
    )
    const user = await openPopover()
    await user.click(screen.getByTestId("status-sync-now"))
    expect(publishMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("status-sync-feedback")).toHaveAttribute(
      "data-feedback",
      "none-connected"
    )
  })

  it("reports a failed request", async () => {
    pairedRows = [device({ deviceId: "d1" })]
    planes = { d1: "ready" }
    publishMock.mockImplementation(() => {
      throw new Error("event bus closed")
    })
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("data-sync-state", "paired")
    )
    const user = await openPopover()
    await user.click(screen.getByTestId("status-sync-now"))
    expect(screen.getByTestId("status-sync-feedback")).toHaveTextContent(
      "Couldn't request a sync: event bus closed"
    )
  })

  it("explains that a remote host owns sync while this desktop steers one", async () => {
    remoteActive = true
    pairedRows = [device({ deviceId: "d1" })]
    render(<StatusBarSync />)
    expect(screen.getByTestId("status-sync")).toHaveAttribute("title", "Synced by remote host")
    const user = await openPopover()
    expect(screen.getByText(/Your devices sync with that host/)).toBeVisible()
    expect(screen.queryByTestId("status-sync-now")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remote hosts" }))
    expect(pushMock).toHaveBeenCalledWith(
      "/settings?section=connectivity&connectivityPanel=remote-hosts"
    )
  })

  it("surfaces a failed device read instead of claiming nothing is paired", async () => {
    pairedError = new Error("DatabaseClosedError")
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("data-sync-state", "error")
    )
    expect(screen.getByTestId("status-sync")).toHaveAttribute("title", "Sync status unavailable")
    await openPopover()
    expect(screen.getByText("DatabaseClosedError")).toBeVisible()
  })

  it("clears the last result when the popover is reopened", async () => {
    pairedRows = [device({ deviceId: "d1" })]
    planes = { d1: "ready" }
    render(<StatusBarSync />)
    await waitFor(() =>
      expect(screen.getByTestId("status-sync")).toHaveAttribute("data-sync-state", "paired")
    )
    const user = await openPopover()
    await user.click(screen.getByTestId("status-sync-now"))
    expect(screen.getByTestId("status-sync-feedback")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByTestId("status-sync-popover")).not.toBeInTheDocument())
    await openPopover()
    expect(screen.queryByTestId("status-sync-feedback")).not.toBeInTheDocument()
  })
})
