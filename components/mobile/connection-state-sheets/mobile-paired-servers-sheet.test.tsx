/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import { MobilePairedServersSheet } from "./mobile-paired-servers-sheet"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Switch server",
      empty: "No paired servers",
      lastSeen: "Last seen",
      never: "never",
      justNow: "just now",
      minutesAgo: `${vars?.n ?? 0}m`,
      hoursAgo: `${vars?.n ?? 0}h`,
      daysAgo: `${vars?.n ?? 0}d`,
      switchingTo: `Switching to ${vars?.name ?? ""}`,
    }
    return map[key] ?? key
  },
}))

jest.mock("sonner", () => ({ toast: { message: jest.fn() } }))

let devices: PairedDeviceRow[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => devices,
}))
jest.mock("@/lib/db/paired-devices", () => ({
  listPairedDevices: jest.fn(async () => devices),
}))

function makeDevice(over: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "device-abcdef123456",
    label: "My Desktop",
    platform: "android",
    pubkey: "",
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 0,
    appVersion: "1.0.0",
    ...over,
  }
}

beforeEach(() => {
  devices = []
})

describe("<MobilePairedServersSheet />", () => {
  it("renders one row per non-revoked paired device when open", () => {
    devices = [
      makeDevice({ deviceId: "dev-1", label: "Studio" }),
      makeDevice({ deviceId: "dev-2", label: "Laptop" }),
    ]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    expect(screen.getByTestId("mobile-paired-row-dev-1")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-paired-row-dev-2")).toBeInTheDocument()
  })

  it("filters out revoked devices", () => {
    devices = [
      makeDevice({ deviceId: "dev-live", label: "Live" }),
      makeDevice({ deviceId: "dev-dead", label: "Revoked", revokedAt: Date.now() }),
    ]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    expect(screen.getByTestId("mobile-paired-row-dev-live")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-paired-row-dev-dead")).not.toBeInTheDocument()
  })

  it("shows the empty state when there are no devices", () => {
    devices = []
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    expect(screen.getByText("No paired servers")).toBeInTheDocument()
  })

  it("only runs the relative-time clock while the sheet is open", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval")
    const has30sTimer = () => setIntervalSpy.mock.calls.some(([, delay]) => delay === 30_000)

    const { rerender } = render(
      <MobilePairedServersSheet open={false} onOpenChange={() => {}} />
    )
    expect(has30sTimer()).toBe(false)

    rerender(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    expect(has30sTimer()).toBe(true)

    setIntervalSpy.mockRestore()
  })
})
