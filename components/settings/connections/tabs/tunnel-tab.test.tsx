/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

const mockIsTauri = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

const mockStart = jest.fn()
const mockStop = jest.fn()
const mockCurrent = jest.fn()
jest.mock("@/lib/connectivity/tunnel-resolver", () => ({
  startTunnel: (...args: unknown[]) => mockStart(...args),
  stopTunnel: () => mockStop(),
  getTunnelInfo: () => mockCurrent(),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
  },
}))

import { TunnelTab } from "./tunnel-tab"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockIsTauri.mockReset()
  mockStart.mockReset()
  mockStop.mockReset()
  mockCurrent.mockReset()
  mockCurrent.mockResolvedValue(null)
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
    wrap(<TunnelTab />)
    await waitFor(() => expect(screen.getByTestId("tunnel-no-adapters")).toBeInTheDocument())
  })

  it("renders per-adapter webhook URLs once tunnel is running", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCurrent.mockResolvedValue({
      publicUrl: "https://abc.trycloudflare.com",
      localUrl: "https://127.0.0.1:7842",
    })
    await getDb().adapterInstances.bulkAdd([
      {
        id: "lark-1",
        type: "lark",
        displayName: "Lark Prod",
        enabled: true,
        transportMode: "webhook",
        settings: {},
        credentialsRef: { keyringService: "x", accounts: [] },
        trigger: {} as never,
        defaultMode: "auto",
        createdAt: 0,
        updatedAt: 0,
      } as never,
      {
        id: "onebot-1",
        type: "onebot",
        displayName: "QQ Dev",
        enabled: true,
        transportMode: "reverse-ws",
        settings: {},
        credentialsRef: { keyringService: "x", accounts: [] },
        trigger: {} as never,
        defaultMode: "auto",
        createdAt: 0,
        updatedAt: 0,
      } as never,
    ])
    wrap(<TunnelTab />)
    await waitFor(() =>
      expect(screen.getByTestId("tunnel-adapter-url-lark-1")).toHaveTextContent(
        "https://abc.trycloudflare.com/connectors/lark/lark-1"
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
