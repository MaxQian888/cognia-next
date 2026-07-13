import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QuoteCardDialog } from "./quote-card-dialog"
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

jest.mock("@/lib/export/html/wallpapers.generated", () => ({
  THEME_WALLPAPERS: { arknights: "data:image/webp;base64,FAKEWALL" },
}))

function fakeCanvas(blob: Blob | null = new Blob(["png"], { type: "image/png" })) {
  return { toBlob: (cb: (b: Blob | null) => void) => cb(blob) }
}

beforeEach(() => {
  jest.clearAllMocks()
  capturedBuildPayload = null
})

function open(props = {}) {
  return render(
    <QuoteCardDialog
      role="assistant"
      authorName="Amiya"
      text="Hello world"
      model="opus"
      timestamp={new Date("2026-01-10T12:00:00Z")}
      sessionTitle="My chat"
      open
      onOpenChange={() => {}}
      {...props}
    />
  )
}

describe("QuoteCardDialog", () => {
  it("previews the quote card in a no-script sandbox", () => {
    open()
    const frame = screen.getByTestId("quote-card-preview") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("")
    const doc = frame.getAttribute("srcdoc") ?? ""
    expect(doc).toContain('class="qcard"')
    expect(doc).toContain("Hello world")
    expect(doc).toContain("Amiya")
  })

  it("renders the theme gallery", () => {
    open()
    expect(screen.getByTestId("theme-gallery")).toBeInTheDocument()
  })

  it("downloads a PNG and cleans up the capture host", async () => {
    mockHtml2canvas.mockResolvedValue(fakeCanvas())
    open()
    fireEvent.click(screen.getByTestId("quote-card-download"))
    await waitFor(() => expect(mockDownloadBlob).toHaveBeenCalledTimes(1))
    const [, filename] = mockDownloadBlob.mock.calls[0]
    expect(String(filename)).toMatch(/^cognia-message-card-\d{4}-\d{2}-\d{2}\.png$/)
    expect(document.querySelector(".qcard")).toBeNull()
  })

  it("shows an error when rasterisation fails", async () => {
    mockHtml2canvas.mockRejectedValue(new Error("boom"))
    open()
    fireEvent.click(screen.getByTestId("quote-card-download"))
    await waitFor(() =>
      expect(screen.getByText("Failed to render the image. Try again.")).toBeInTheDocument()
    )
  })

  it("surfaces the error when toBlob yields null", async () => {
    mockHtml2canvas.mockResolvedValue(fakeCanvas(null))
    open()
    fireEvent.click(screen.getByTestId("quote-card-download"))
    await waitFor(() =>
      expect(screen.getByText("Failed to render the image. Try again.")).toBeInTheDocument()
    )
    expect(mockDownloadBlob).not.toHaveBeenCalled()
  })

  it("injects the wallpaper into the preview when enabled", async () => {
    open()
    fireEvent.click(screen.getByTestId("quote-card-wallpaper"))
    await waitFor(() => {
      const frame = screen.getByTestId("quote-card-preview") as HTMLIFrameElement
      expect(frame.getAttribute("srcdoc") ?? "").toContain("data:image/webp;base64,FAKEWALL")
    })
  })

  it("hands the share dialog a chat-quote payload", async () => {
    open()
    expect(capturedBuildPayload).not.toBeNull()
    const payload = await capturedBuildPayload!()
    expect(payload.kind).toBe("chat-quote")
    expect(payload.mime).toBe("text/html")
    expect(payload.data).toContain('class="qcard"')
    expect(payload.title).toBe("My chat")
  })

  it("falls back to the default card title when no session title is given", async () => {
    open({ sessionTitle: undefined })
    const payload = await capturedBuildPayload!()
    expect(payload.title).toBe("Cognia message card")
  })
})
