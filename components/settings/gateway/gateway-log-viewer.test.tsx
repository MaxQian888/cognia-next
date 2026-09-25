import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GatewayLogViewer } from "./gateway-log-viewer"
import type { GatewayRequestLogRow } from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "logRowDetailAria" || !values ? key : `${key}:${Object.values(values).join(",")}`,
  useFormatter: () => ({
    number: (value: number, opts?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", opts).format(value),
    dateTime: (date: Date) => `time:${date.toISOString()}`,
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
  GATEWAY_REQUEST_LOG_CAP: 250,
  listGatewayRequestLog: (filter: unknown) => filter,
  clearGatewayRequestLog: () => mockClear(),
  summarizeGatewayUsage: (...a: unknown[]) => mockSummary(...a),
}))

const mockDownload = jest.fn()
jest.mock("@/lib/gateway/request-log-export", () => ({
  downloadGatewayRequestLog: (...a: unknown[]) => mockDownload(...a),
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
  mockDownload.mockReset()
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

  it("clears the log only after an explicit confirmation", async () => {
    const { toast } = jest.requireMock("sonner")
    liveRows = [row()]
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("button", { name: "clearLog" }))
    expect(mockClear).not.toHaveBeenCalled()
    expect(screen.getByTestId("gateway-log-clear-confirm")).toHaveTextContent("clearLogConfirm")

    await user.click(screen.getByRole("button", { name: "clearLogConfirmAction" }))
    await waitFor(() => expect(mockClear).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith("logCleared")
  })

  it("reports a failed clear instead of claiming success", async () => {
    const { toast } = jest.requireMock("sonner")
    toast.success.mockClear()
    mockClear.mockRejectedValue(new Error("database is locked"))
    liveRows = [row()]
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("button", { name: "clearLog" }))
    await user.click(screen.getByRole("button", { name: "clearLogConfirmAction" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("database is locked"))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByTestId("gateway-log-clear-confirm")).toBeInTheDocument()
  })

  it("exports the rows on screen as CSV or JSON", async () => {
    liveRows = [row(), row({ id: "r2" })]
    const user = userEvent.setup()
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("button", { name: "logExport" }))
    await user.click(await screen.findByRole("menuitem", { name: "logExportCsv" }))

    expect(mockDownload).toHaveBeenCalledWith(liveRows, "csv")
  })

  it("has nothing to export from an empty log", () => {
    render(<GatewayLogViewer />)
    expect(screen.getByRole("button", { name: "logExport" })).toBeDisabled()
  })

  it("loads the next page once the current window is full, up to the table cap", async () => {
    liveRows = Array.from({ length: 100 }, (_, i) => row({ id: `r${i}` }))
    const user = userEvent.setup()
    render(<GatewayLogViewer />)
    expect(screen.getByTestId("gateway-log-window")).toHaveTextContent("logShowing:100")

    await user.click(screen.getByRole("button", { name: "logLoadMore" }))
    await waitFor(() => expect(lastFilter).toEqual({ limit: 200 }))
  })

  it("offers no further page when the window is not full", () => {
    liveRows = [row()]
    render(<GatewayLogViewer />)
    expect(screen.queryByRole("button", { name: "logLoadMore" })).not.toBeInTheDocument()
  })

  it("totals the estimated cost of the priced rows", () => {
    mockEstimateCost.mockReturnValueOnce(0.5).mockReturnValueOnce(undefined)
    liveRows = [row(), row({ id: "r2" })]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-usage-cost")).toHaveTextContent("$0.5000")
  })

  it("says the cost is unknown when no row could be priced", () => {
    liveRows = [row()]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-usage-cost")).toHaveTextContent("costUnknown")
  })

  it("sheds secondary columns in a narrow pane and repeats them in the detail row", async () => {
    const user = userEvent.setup()
    liveRows = [row()]
    render(<GatewayLogViewer />)

    const costCell = screen.getByTestId("gateway-log-cost-r1")
    expect(costCell.className).toContain("hidden")
    expect(costCell.className).toContain("@2xl/gateway-pane:table-cell")

    await user.click(screen.getByRole("button", { name: "logRowDetailAria" }))
    const detail = await screen.findByTestId("gateway-log-detail-r1")
    expect(detail).toHaveTextContent("colProvider")
    expect(detail).toHaveTextContent("groq")
  })

  it("draws no rule under a collapsed detail row", () => {
    liveRows = [row()]
    render(<GatewayLogViewer />)

    const rows = within(screen.getByTestId("gateway-log")).getAllByRole("row")
    // header, request row, (collapsed) detail row
    expect(rows[2].className).toContain("border-0")
  })

  it("shows how a request was routed, including the whole failover walk", async () => {
    const user = userEvent.setup()
    liveRows = [
      row({
        strategy: "least-busy",
        distribution: "weighted",
        selectedDeployment: "dep-2",
        routingLatencyMs: 3,
        policyRevision: "rev-9",
        decisionId: "dec-1",
        fallbackReason: "primary rate limited",
        keyFingerprint: "…ab12",
        attempts: [
          { providerId: "openai", modelId: "gpt-4o", status: 429, latencyMs: 40, reason: "429" },
          { providerId: "groq", modelId: "llama", status: 200, latencyMs: 12 },
        ],
      }),
    ]
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("button", { name: "logRowDetailAria" }))
    const detail = await screen.findByTestId("gateway-log-detail-r1")
    for (const text of [
      "least-busy",
      "weighted",
      "dep-2",
      "rev-9",
      "dec-1",
      "primary rate limited",
      "…ab12",
    ]) {
      expect(detail).toHaveTextContent(text)
    }
    const attempts = screen.getByTestId("gateway-log-attempts-r1")
    expect(attempts).toHaveTextContent("logAttempts:2")
    expect(within(attempts).getAllByRole("listitem")).toHaveLength(2)
    expect(attempts).toHaveTextContent("openai · gpt-4o")
    expect(attempts).toHaveTextContent("429")
  })

  it("formats the row time through the app locale, not the OS one", () => {
    liveRows = [row()]
    render(<GatewayLogViewer />)

    expect(screen.getByTestId("gateway-log")).toHaveTextContent("time:2026-07-03T00:00:00.000Z")
  })

  it("marks a locally synthesized answer, which never reached an upstream", async () => {
    const user = userEvent.setup()
    liveRows = [row({ synthesized: true })]
    render(<GatewayLogViewer />)

    await user.click(screen.getByRole("button", { name: "logRowDetailAria" }))

    expect(await screen.findByTestId("gateway-log-detail-r1")).toHaveTextContent(
      "logSynthesizedValue"
    )
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
