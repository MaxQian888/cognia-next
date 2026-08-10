import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewayLogViewer } from "./gateway-log-viewer"
import type { GatewayRequestLogRow } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    number: (value: number, opts?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", opts).format(value),
  }),
}))

let liveRows: GatewayRequestLogRow[] = []
let lastFilter: unknown
jest.mock("dexie-react-hooks", () => ({
  // Actually run the query callback so the filter it builds is observable —
  // returning `liveRows` blindly left every filter branch untested.
  useLiveQuery: (fn: () => unknown) => {
    lastFilter = fn()
    return liveRows
  },
}))

const mockClear = jest.fn()
const mockSummary = jest.fn()
jest.mock("@/lib/db/gateway-request-log", () => ({
  listGatewayRequestLog: (filter: unknown) => filter,
  clearGatewayRequestLog: () => mockClear(),
  summarizeGatewayUsage: (...a: unknown[]) => mockSummary(...a),
}))

const mockListKeys = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayListKeys: () => mockListKeys(),
}))

const mockEstimateCost = jest.fn()
jest.mock("@cognia/provider-core/providers/model-pricing", () => ({
  estimateCallCostUsd: (...a: unknown[]) => mockEstimateCost(...a),
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
  lastFilter = undefined
  mockEstimateCost.mockReset().mockReturnValue(undefined)
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

  it("queries the newest 100 with no filters by default", () => {
    render(<GatewayLogViewer />)
    expect(lastFilter).toEqual({ limit: 100 })
  })

  it("passes the outcome filter through", async () => {
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("radio", { name: "logFilterErrors" }))

    await waitFor(() => expect(lastFilter).toEqual({ limit: 100, outcome: "errors" }))
  })

  it("does not clear the selected outcome filter", async () => {
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("radio", { name: "logFilterAll" }))

    expect(lastFilter).toEqual({ limit: 100 })
  })

  it("passes the model filter through and ignores whitespace", async () => {
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.type(screen.getByLabelText("colModel"), "   ")
    expect(lastFilter).toEqual({ limit: 100 })

    await user.clear(screen.getByLabelText("colModel"))
    await user.type(screen.getByLabelText("colModel"), "fast")
    await waitFor(() => expect(lastFilter).toEqual({ limit: 100, model: "fast" }))
  })

  it("passes the key filter through once a specific key is chosen", async () => {
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.click(await screen.findByRole("combobox", { name: "colKey" }))
    await user.click(await screen.findByRole("option", { name: "Server" }))

    await waitFor(() => expect(lastFilter).toEqual({ limit: 100, keyId: "k2" }))
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
    // A shadcn Select now, not a bare <select>: this was the only native one
    // left in the repo and it ignored the app theme.
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    const trigger = await screen.findByRole("combobox", { name: "colKey" })
    await user.click(trigger)

    expect(await screen.findByRole("option", { name: "Laptop CLI" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Server" })).toBeInTheDocument()

    await user.click(screen.getByRole("option", { name: "Server" }))
    expect(trigger).toHaveTextContent("Server")
  })

  it("dashes the Key column for a request that carried no gateway key", () => {
    // Middleware rejections (bad key, rate limit) log with `keyId: null`.
    // Priced so the cost cell is not also a dash and this stays unambiguous.
    mockEstimateCost.mockReturnValue(0.01)
    liveRows = [row({ keyId: null })]
    render(<GatewayLogViewer />)

    expect(within(screen.getByTestId("gateway-log")).getByText("—")).toBeInTheDocument()
  })

  it("falls back to a truncated id when the key was deleted after the call", () => {
    liveRows = [row({ keyId: "k-deleted-1234567890" })]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-log")).toHaveTextContent("k-delete")
  })

  it("treats absent token counts as zero rather than rendering 'null / null'", () => {
    liveRows = [row({ inputTokens: null, outputTokens: null })]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-log")).toHaveTextContent("0 / 0")
    expect(mockEstimateCost).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 })
    )
  })

  it("collapses an expanded row when its toggle is pressed again", async () => {
    const user = userEvent.setup()
    liveRows = [row()]
    render(<GatewayLogViewer />)

    const toggle = screen.getByRole("button", { name: "logRowDetailAria" })
    await user.click(toggle)
    expect(await screen.findByTestId("gateway-log-detail-r1")).toHaveTextContent("127.0.0.1")

    await user.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"))
  })

  it("renders a cost estimate per row", () => {
    mockEstimateCost.mockReturnValue(0.001234)
    liveRows = [row()]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-log-cost-r1")).toHaveTextContent("$0.0012")
    expect(mockEstimateCost).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "groq",
        modelId: "fast",
        inputTokens: 3,
        outputTokens: 5,
      })
    )
  })

  it("shows a dash rather than $0.0000 when the model has no known pricing", () => {
    // The dash is a translated key now: the cost cell used to hard-code
    // `$${cost.toFixed(4)}`, which baked en-US currency formatting into every
    // locale, so both branches go through i18n.
    mockEstimateCost.mockReturnValue(undefined)
    liveRows = [row()]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-log-cost-r1")).toHaveTextContent("costUnknown")
  })

  it("does not price a row whose provider or model is unknown", () => {
    liveRows = [row({ providerId: null, model: null })]
    render(<GatewayLogViewer />)

    expect(mockEstimateCost).not.toHaveBeenCalled()
    expect(screen.getByTestId("gateway-log-cost-r1")).toHaveTextContent("costUnknown")
  })

  it("keeps route, client IP and stream flag collapsed until asked for", async () => {
    // All four of these were persisted on every row and rendered nowhere, so a
    // failing request showed a red status badge and nothing to act on.
    const user = userEvent.setup()
    liveRows = [row({ error: "upstream refused the connection", stream: true })]
    render(<GatewayLogViewer />)

    expect(screen.queryByText("/v1/chat/completions")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "logRowDetailAria" }))

    const detail = await screen.findByTestId("gateway-log-detail-r1")
    expect(detail).toHaveTextContent("/v1/chat/completions")
    expect(detail).toHaveTextContent("127.0.0.1")
    expect(detail).toHaveTextContent("streamYes")
    expect(detail).toHaveTextContent("upstream refused the connection")
  })

  it("omits the error term entirely on a successful row", async () => {
    const user = userEvent.setup()
    liveRows = [row({ error: null })]
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("button", { name: "logRowDetailAria" }))

    const detail = await screen.findByTestId("gateway-log-detail-r1")
    expect(detail).not.toHaveTextContent("colError")
    expect(detail).toHaveTextContent("streamNo")
  })
})
