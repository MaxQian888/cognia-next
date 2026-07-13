import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { UsageShareDialog } from "./usage-share-dialog"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { SharePayload } from "@/lib/share/types"

const mockHtml2canvas = jest.fn()
jest.mock("html2canvas", () => ({
  __esModule: true,
  default: (...a: unknown[]) => mockHtml2canvas(...a),
}))

const mockDownloadBlob = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...a: unknown[]) => mockDownloadBlob(...a),
}))

// The nested ShareLinkDialog is covered by its own suite; capture the payload
// builder so we can assert the wiring without the share client stack.
let capturedBuildPayload: (() => SharePayload | Promise<SharePayload>) | null = null
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({
    buildPayload,
    trigger,
  }: {
    buildPayload: () => SharePayload | Promise<SharePayload>
    trigger?: React.ReactNode
  }) => {
    capturedBuildPayload = buildPayload
    return <div data-testid="share-link-dialog">{trigger}</div>
  },
}))

jest.mock("@cognia/logging", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

// Keep the heavy generated wallpaper map out of the test; the resolver reads it.
jest.mock("@/lib/export/html/wallpapers.generated", () => ({
  THEME_WALLPAPERS: { arknights: "data:image/webp;base64,FAKEWALL" },
}))

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0)

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    at: T0,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.01,
    durationMs: 1000,
    model: "opus",
    ...overrides,
  }
}

function fakeCanvas(blob: Blob | null = new Blob(["png"], { type: "image/png" })) {
  return { toBlob: (cb: (b: Blob | null) => void) => cb(blob) }
}

beforeEach(() => {
  jest.clearAllMocks()
  capturedBuildPayload = null
})

function open(rows: SessionUsageRow[] = [row()], props = {}) {
  return render(
    <UsageShareDialog
      rows={rows}
      rangeLabel="Last 7 days"
      open
      onOpenChange={() => {}}
      {...props}
    />
  )
}

describe("UsageShareDialog", () => {
  it("previews the arknights-style card by default with the range tag", () => {
    open()
    const frame = screen.getByTestId("usage-card-preview") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("")
    const doc = frame.getAttribute("srcdoc") ?? ""
    expect(doc).toContain('data-theme="arknights"')
    expect(doc).toContain("ORIGINIUM COMPUTE")
    expect(doc).toContain("Last 7 days")
  })

  it("downloads a PNG through html2canvas and cleans up the capture host", async () => {
    mockHtml2canvas.mockResolvedValue(fakeCanvas())
    open()
    fireEvent.click(screen.getByTestId("usage-card-download"))
    await waitFor(() => expect(mockDownloadBlob).toHaveBeenCalledTimes(1))
    const [blob, filename] = mockDownloadBlob.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(String(filename)).toMatch(/^cognia-usage-card-\d{4}-\d{2}-\d{2}\.png$/)
    // Off-screen capture host must not leak into the document.
    expect(document.querySelector(".ucard")).toBeNull()
  })

  it("shows an error when rasterisation fails", async () => {
    mockHtml2canvas.mockRejectedValue(new Error("no canvas"))
    open()
    fireEvent.click(screen.getByTestId("usage-card-download"))
    await waitFor(() =>
      expect(screen.getByText("Failed to render the image. Try again.")).toBeInTheDocument()
    )
    expect(mockDownloadBlob).not.toHaveBeenCalled()
  })

  it("surfaces the error when toBlob yields null", async () => {
    mockHtml2canvas.mockResolvedValue(fakeCanvas(null))
    open()
    fireEvent.click(screen.getByTestId("usage-card-download"))
    await waitFor(() =>
      expect(screen.getByText("Failed to render the image. Try again.")).toBeInTheDocument()
    )
  })

  it("disables both share paths when there are no rows", () => {
    open([])
    expect(screen.getByTestId("usage-card-download")).toBeDisabled()
    expect(screen.getByTestId("usage-card-share-link")).toBeDisabled()
  })

  it("renders the visual theme gallery", () => {
    open()
    expect(screen.getByTestId("theme-gallery")).toBeInTheDocument()
    expect(screen.getByTestId("theme-swatch-arknights")).toBeInTheDocument()
    expect(screen.getByTestId("theme-swatch-genshin")).toBeInTheDocument()
  })

  it("injects the theme wallpaper into the preview when enabled", async () => {
    open()
    const toggle = screen.getByTestId("usage-card-wallpaper")
    expect(toggle).toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() => {
      const frame = screen.getByTestId("usage-card-preview") as HTMLIFrameElement
      expect(frame.getAttribute("srcdoc") ?? "").toContain("data:image/webp;base64,FAKEWALL")
    })
  })

  it("hands the share dialog a usage-card payload", async () => {
    open()
    expect(capturedBuildPayload).not.toBeNull()
    const payload = await capturedBuildPayload!()
    expect(payload.kind).toBe("usage-card")
    expect(payload.mime).toBe("text/html")
    expect(payload.data).toContain('class="ucard"')
    expect(payload.title).toBe("Cognia Usage Archive")
  })
})
