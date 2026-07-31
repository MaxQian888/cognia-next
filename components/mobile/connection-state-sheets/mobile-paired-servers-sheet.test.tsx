/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { RecentServer } from "@/lib/connectivity/recent-servers"

import { mergeKnownServers, MobilePairedServersSheet } from "./mobile-paired-servers-sheet"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn() }),
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
      forget: `Forget ${vars?.name ?? ""}`,
      forgot: `Removed ${vars?.name ?? ""}`,
    }
    return map[key] ?? key
  },
}))

jest.mock("sonner", () => ({ toast: { message: jest.fn() } }))
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => {}) }))

let devices: PairedDeviceRow[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => devices,
}))
jest.mock("@/lib/db/paired-devices", () => ({
  listPairedDevices: jest.fn(async () => devices),
}))

let recents: RecentServer[] = []
const removeRecentServerMock = jest.fn()
jest.mock("@/lib/connectivity/recent-servers", () => ({
  loadRecentServers: () => recents,
  removeRecentServer: (baseUrl: string) => removeRecentServerMock(baseUrl),
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
    allowRemoteTerminal: over.allowRemoteTerminal ?? false,
  }
}

function makeRecent(over: Partial<RecentServer> = {}): RecentServer {
  return {
    baseUrl: "https://192.168.1.42:7891",
    fingerprint: "abcd1234",
    label: "dev-1234",
    deviceId: "device-12345678",
    lastSeenAt: 1_700_000_000_000,
    ...over,
  }
}

beforeEach(() => {
  devices = []
  recents = []
  pushMock.mockClear()
  removeRecentServerMock.mockClear()
})

describe("mergeKnownServers", () => {
  it("prefers recent-server entries and dedupes Dexie rows by deviceId", () => {
    const merged = mergeKnownServers(
      [makeRecent({ deviceId: "dev-1" })],
      [makeDevice({ deviceId: "dev-1", label: "Dexie copy" })]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].baseUrl).toBe("https://192.168.1.42:7891")
  })

  it("dedupes legacy recents (no deviceId) via the 8-char label", () => {
    const merged = mergeKnownServers(
      [makeRecent({ deviceId: undefined, label: "device-a" })],
      [makeDevice({ deviceId: "device-abcdef123456" })]
    )
    expect(merged).toHaveLength(1)
  })

  it("appends non-revoked Dexie-only rows and drops revoked ones", () => {
    const merged = mergeKnownServers(
      [],
      [
        makeDevice({ deviceId: "dev-live", label: "Live" }),
        makeDevice({ deviceId: "dev-dead", label: "Revoked", revokedAt: Date.now() }),
      ]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].deviceId).toBe("dev-live")
  })

  it("sorts newest-first by lastSeenAt", () => {
    const merged = mergeKnownServers(
      [
        makeRecent({ baseUrl: "https://old:1", deviceId: "d-old", lastSeenAt: 1 }),
        makeRecent({ baseUrl: "https://new:1", deviceId: "d-new", lastSeenAt: 2 }),
      ],
      []
    )
    expect(merged[0].baseUrl).toBe("https://new:1")
  })
})

describe("<MobilePairedServersSheet />", () => {
  it("renders recent servers as rows when open", () => {
    recents = [makeRecent()]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    expect(
      screen.getByTestId("mobile-paired-row-recent:https://192.168.1.42:7891")
    ).toBeInTheDocument()
  })

  it("navigates with baseUrl + fingerprint when switching to a recent server", () => {
    recents = [makeRecent()]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("mobile-paired-row-recent:https://192.168.1.42:7891"))
    expect(pushMock).toHaveBeenCalledWith(
      `/pair?${new URLSearchParams({ baseUrl: "https://192.168.1.42:7891", fingerprint: "abcd1234" }).toString()}`
    )
  })

  it("falls back to the legacy switchTo route for Dexie-only rows", () => {
    devices = [makeDevice({ deviceId: "dev-1", label: "Studio" })]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("mobile-paired-row-device:dev-1"))
    expect(pushMock).toHaveBeenCalledWith("/pair?switchTo=dev-1")
  })

  it("forgets a recent server and refreshes the list", () => {
    recents = [makeRecent()]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    recents = []
    fireEvent.click(
      screen.getByTestId("mobile-paired-forget-recent:https://192.168.1.42:7891")
    )
    expect(removeRecentServerMock).toHaveBeenCalledWith("https://192.168.1.42:7891")
    expect(
      screen.queryByTestId("mobile-paired-row-recent:https://192.168.1.42:7891")
    ).not.toBeInTheDocument()
  })

  it("shows no forget affordance for Dexie-only rows", () => {
    devices = [makeDevice({ deviceId: "dev-1" })]
    render(<MobilePairedServersSheet open onOpenChange={() => {}} />)
    expect(screen.queryByTestId("mobile-paired-forget-device:dev-1")).not.toBeInTheDocument()
  })

  it("shows the empty state when there are no known servers", () => {
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
