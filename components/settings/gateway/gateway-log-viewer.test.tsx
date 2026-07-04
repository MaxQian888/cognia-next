import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewayLogViewer } from "./gateway-log-viewer"
import type { GatewayRequestLogRow } from "@/types/gateway"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let liveRows: GatewayRequestLogRow[] = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveRows }))

const mockClear = jest.fn()
const mockSummary = jest.fn()
jest.mock("@/lib/db/gateway-request-log", () => ({
  listGatewayRequestLog: jest.fn(),
  clearGatewayRequestLog: () => mockClear(),
  summarizeGatewayUsage: (...a: unknown[]) => mockSummary(...a),
}))

const mockListKeys = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayListKeys: () => mockListKeys(),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const row = (over: Partial<GatewayRequestLogRow> = {}): GatewayRequestLogRow => ({
  id: "r1",
  at: "2026-07-03T00:00:00Z",
  route: "/v1/chat/completions",
  remoteIp: "127.0.0.1",
  keyId: "k1",
  model: "fast",
  providerId: "groq",
  status: 200,
  latencyMs: 12,
  inputTokens: 3,
  outputTokens: 5,
  error: null,
  stream: false,
  ...over,
})

beforeEach(() => {
  liveRows = []
  mockClear.mockReset().mockResolvedValue(undefined)
  mockListKeys.mockReset().mockResolvedValue([
    { id: "k1", name: "Laptop CLI" },
    { id: "k2", name: "Server" },
  ])
  mockSummary
    .mockReset()
    .mockReturnValue({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, avgLatencyMs: 0 })
})

describe("GatewayLogViewer", () => {
  it("shows the empty state and usage tiles when there are no rows", () => {
    render(<GatewayLogViewer />)
    expect(screen.getByText("logEmpty")).toBeInTheDocument()
    expect(screen.getByTestId("gateway-usage-summary")).toBeInTheDocument()
  })

  it("renders request rows with model, status and latency", () => {
    liveRows = [row(), row({ id: "r2", model: "gpt-4o", status: 429 })]
    mockSummary.mockReturnValue({
      requests: 2,
      errors: 1,
      inputTokens: 6,
      outputTokens: 10,
      avgLatencyMs: 12,
    })
    render(<GatewayLogViewer />)
    const log = screen.getByTestId("gateway-log")
    expect(log).toHaveTextContent("fast")
    expect(log).toHaveTextContent("gpt-4o")
    expect(log).toHaveTextContent("200")
    expect(log).toHaveTextContent("429")
  })

  it("clears the log", async () => {
    liveRows = [row()]
    const user = userEvent.setup()
    render(<GatewayLogViewer />)
    await user.click(screen.getByRole("button", { name: "clearLog" }))
    expect(mockClear).toHaveBeenCalled()
  })

  it("switches the outcome filter", async () => {
    const user = userEvent.setup()
    render(<GatewayLogViewer />)
    await user.click(screen.getByRole("button", { name: "logFilterErrors" }))
    expect(screen.getByRole("button", { name: "logFilterErrors" })).toBeInTheDocument()
    await user.type(screen.getByLabelText("colModel"), "fast")
  })

  it("renders the Key column with the resolved key name", async () => {
    liveRows = [row({ keyId: "k1" })]
    mockSummary.mockReturnValue({
      requests: 1,
      errors: 0,
      inputTokens: 3,
      outputTokens: 5,
      avgLatencyMs: 12,
    })
    render(<GatewayLogViewer />)
    // Key name is resolved from the fetched key list (async). Scope to the log
    // table — the same name also appears in the filter dropdown.
    const log = screen.getByTestId("gateway-log")
    expect(await within(log).findByText("Laptop CLI")).toBeInTheDocument()
  })

  it("exposes a per-key filter dropdown populated from the key list", async () => {
    render(<GatewayLogViewer />)
    const select = (await screen.findByLabelText("colKey")) as HTMLSelectElement
    // Wait for the async key list to populate the dropdown.
    expect(await within(select).findByRole("option", { name: "Laptop CLI" })).toBeInTheDocument()
    expect(within(select).getByRole("option", { name: "Server" })).toBeInTheDocument()
    await userEvent.selectOptions(select, "k2")
    expect(select.value).toBe("k2")
  })
})
