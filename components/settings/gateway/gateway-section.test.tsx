import { render, screen, act, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewaySection } from "./gateway-section"
import type { GatewayStatus } from "@/types/gateway"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let tauri = true
let subscribeHandler: ((p: unknown) => void) | null = null
const unsubscribe = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: {
    subscribe: (_e: string, h: (p: unknown) => void) => {
      subscribeHandler = h
      return unsubscribe
    },
  },
}))

const mockStatus = jest.fn()
const mockGetToken = jest.fn()
const mockRotate = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockUpdate = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetStatus: () => mockStatus(),
  gatewayGetToken: () => mockGetToken(),
  gatewayRotateToken: () => mockRotate(),
  gatewayStart: () => mockStart(),
  gatewayStop: () => mockStop(),
  gatewayUpdateConfig: (...a: unknown[]) => mockUpdate(...a),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const status = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  running: false,
  boundPort: null,
  hasToken: true,
  callsTotal: 0,
  lastCallAt: null,
  snapshotGeneratedAtMs: null,
  snapshotProviderCount: 0,
  snapshotAliasCount: 0,
  ...over,
})

beforeEach(() => {
  tauri = true
  subscribeHandler = null
  unsubscribe.mockReset()
  mockStatus.mockReset().mockResolvedValue(status())
  mockGetToken.mockReset().mockResolvedValue("tok-123")
  mockRotate.mockReset().mockResolvedValue("tok-new")
  mockStart.mockReset().mockResolvedValue(undefined)
  mockStop.mockReset().mockResolvedValue(undefined)
  mockUpdate.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("GatewaySection", () => {
  it("shows the desktop-only notice outside Tauri", () => {
    tauri = false
    render(<GatewaySection />)
    expect(screen.getByText("desktopOnlyNotice")).toBeInTheDocument()
  })

  it("hydrates status and renders the base-URL snippets", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())
    expect(screen.getByText(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:47823/)).toBeInTheDocument()
    expect(screen.getByText(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:47823\/v1/)).toBeInTheDocument()
  })

  it("starts the gateway when the enable switch is toggled on", async () => {
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())
    await user.click(screen.getByRole("switch", { name: "enabled" }))
    expect(mockStart).toHaveBeenCalled()
  })

  it("blocks enabling without a token", async () => {
    mockStatus.mockResolvedValue(status({ hasToken: false }))
    const user = userEvent.setup()
    render(<GatewaySection />)
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())
    // switch is disabled; the generate-token button is offered instead
    expect(screen.getByText("generateToken")).toBeInTheDocument()
    await user.click(screen.getByText("generateToken"))
    expect(mockRotate).toHaveBeenCalled()
  })

  it("appends inbound-call events to the request log", async () => {
    render(<GatewaySection />)
    await waitFor(() => expect(subscribeHandler).toBeTruthy())
    act(() => {
      subscribeHandler?.({
        id: "1",
        at: "now",
        route: "/v1/messages",
        status: 200,
        remoteIp: "127.0.0.1",
      })
    })
    const log = await screen.findByTestId("gateway-log")
    expect(log).toHaveTextContent("/v1/messages")
    expect(log).toHaveTextContent("200")
  })

  it("detaches the inbound-call subscription on unmount", async () => {
    const { unmount } = render(<GatewaySection />)
    await waitFor(() => expect(subscribeHandler).toBeTruthy())
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
