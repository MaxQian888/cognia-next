/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockIsTauri = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

const mockStart = jest.fn()
const mockStop = jest.fn()
const mockCurrent = jest.fn()
const mockConfig = jest.fn()
jest.mock("@/lib/connectivity/tunnel-resolver", () => ({
  startTunnel: (...args: unknown[]) => mockStart(...args),
  stopTunnel: () => mockStop(),
  getTunnelInfo: () => mockCurrent(),
  getTunnelConfig: () => mockConfig(),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
  },
}))

// `getDb()` is only ever called inside the component's `useLiveQuery` querier.
// Mock the Dexie hook so the adapter list is driven directly from the test —
// same seam the sibling connector-tab tests (overview / outbound / audit) use.
// This avoids the real-IndexedDB liveQuery subscription, whose teardown leaks a
// fake-indexeddb connection past unmount (the component also renders Radix
// tooltips on the install path) and makes the suite flaky/slow under jsdom.
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

/**
 * The Tunnel tab calls `useLiveQuery` exactly once, for the adapter instances.
 * Drive it from the test.
 */
function setAdapters(adapters: AdapterInstanceRow[] | undefined): void {
  mockUseLiveQuery.mockReturnValue(adapters as unknown as ReturnType<typeof useLiveQuery>)
}

const baseAdapter = (overrides: Partial<AdapterInstanceRow>): AdapterInstanceRow =>
  ({
    enabled: true,
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: {} as never,
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as AdapterInstanceRow

import { TunnelTab } from "./tunnel-tab"

beforeEach(() => {
  mockIsTauri.mockReset()
  mockStart.mockReset()
  mockStop.mockReset()
  mockCurrent.mockReset()
  mockCurrent.mockResolvedValue(null)
  mockConfig.mockReset()
  mockConfig.mockResolvedValue(null)
  mockUseLiveQuery.mockReset()
  // Default: no adapters registered.
  setAdapters([])
})

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <TooltipProvider>{ui}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("TunnelTab", () => {
  it("shows the start button when tunnel is off", async () => {
    mockIsTauri.mockReturnValue(true)
    wrap(<TunnelTab />)
    await waitFor(() => expect(screen.getByTestId("tunnel-start")).toBeInTheDocument())
  })

  it("starts the tunnel and surfaces the public URL", async () => {
    mockIsTauri.mockReturnValue(true)
    mockStart.mockResolvedValue({
      kind: "started",
      info: { publicUrl: "https://abc.trycloudflare.com", localUrl: "https://127.0.0.1:7842" },
    })
    wrap(<TunnelTab />)
    await waitFor(() => expect(screen.getByTestId("tunnel-start")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tunnel-start"))
    await waitFor(() =>
      expect(screen.getByTestId("tunnel-public-url")).toHaveTextContent(
        "https://abc.trycloudflare.com"
      )
    )
  })

  it("surfaces install instructions when cloudflared is missing", async () => {
    mockIsTauri.mockReturnValue(true)
    mockStart.mockResolvedValue({ kind: "not_installed" })
    Object.defineProperty(navigator, "userAgent", { value: "Mac OS", configurable: true })
    wrap(<TunnelTab />)
    await waitFor(() => expect(screen.getByTestId("tunnel-start")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tunnel-start"))
    await waitFor(() => expect(screen.getByTestId("tunnel-install-copy-0")).toBeInTheDocument())
  })

  it("falls back to a no-adapters hint when none are registered", async () => {
    mockIsTauri.mockReturnValue(true)
    setAdapters([])
    wrap(<TunnelTab />)
    await waitFor(() => expect(screen.getByTestId("tunnel-no-adapters")).toBeInTheDocument())
  })

  it("renders per-adapter webhook URLs once tunnel is running", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCurrent.mockResolvedValue({
      publicUrl: "https://abc.trycloudflare.com",
      localUrl: "https://127.0.0.1:7842",
    })
    setAdapters([
      baseAdapter({
        id: "lark-1",
        type: "lark",
        displayName: "Lark Prod",
        transportMode: "webhook",
      }),
      baseAdapter({
        id: "onebot-1",
        type: "onebot",
        displayName: "QQ Dev",
        transportMode: "reverse-ws",
      }),
    ])
    wrap(<TunnelTab />)
    await waitFor(() =>
      expect(screen.getByTestId("tunnel-adapter-url-lark-1")).toHaveTextContent(
        "https://abc.trycloudflare.com/webhook/lark/lark-1"
      )
    )
    // OneBot uses reverse-WS, so no public URL.
    expect(screen.queryByTestId("tunnel-adapter-url-onebot-1")).not.toBeInTheDocument()
  })

  it("disables the start button on web (not Tauri)", async () => {
    mockIsTauri.mockReturnValue(false)
    wrap(<TunnelTab />)
    await waitFor(() => expect(screen.getByTestId("tunnel-start")).toBeDisabled())
  })
})
