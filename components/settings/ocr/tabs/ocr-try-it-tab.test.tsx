import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrTryItTab } from "./ocr-try-it-tab"

// Mock the hook so we can drive the test deterministically. The real hook is
// covered by hooks/use-ocr.test.ts.
let mockRun: jest.Mock
let mockAbort: jest.Mock
let mockReset: jest.Mock
let mockState: {
  status: "idle" | "running" | "success" | "error"
  result: unknown
  error: { code: string; message: string } | null
}

jest.mock("@/hooks/use-ocr", () => ({
  useOcr: () => ({
    status: mockState.status,
    result: mockState.result,
    error: mockState.error,
    abort: mockAbort,
    run: mockRun,
    reset: mockReset,
  }),
}))

beforeEach(() => {
  mockRun = jest.fn(async () => null)
  mockAbort = jest.fn()
  mockReset = jest.fn()
  mockState = { status: "idle", result: null, error: null }
})

const noopDeps = () => null

function makePngFile(name = "test.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" })
}

describe("OcrTryItTab", () => {
  it("renders the drop zone with a pick file CTA when no file is chosen", () => {
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    expect(screen.getByTestId("ocr-try-it-drop-zone")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-try-it-pick-file")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-try-it-run")).toBeDisabled()
  })

  it("shows the file name after a file is chosen and enables Run", async () => {
    const user = userEvent.setup()
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    const input = screen.getByTestId("ocr-try-it-file-input") as HTMLInputElement
    await user.upload(input, makePngFile())
    expect(screen.getByTestId("ocr-try-it-file-name")).toHaveTextContent("test.png")
    expect(screen.getByTestId("ocr-try-it-run")).toBeEnabled()
  })

  it("opens the confirm dialog before running and does not call run on cancel", async () => {
    const user = userEvent.setup()
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    await user.upload(
      screen.getByTestId("ocr-try-it-file-input") as HTMLInputElement,
      makePngFile()
    )
    await user.click(screen.getByTestId("ocr-try-it-run"))
    expect(await screen.findByTestId("ocr-try-it-confirm")).toBeInTheDocument()
    expect(mockRun).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("ocr-try-it-confirm-cancel"))
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("calls run with the chosen file after confirmation", async () => {
    const user = userEvent.setup()
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    const file = makePngFile()
    await user.upload(screen.getByTestId("ocr-try-it-file-input") as HTMLInputElement, file)
    await user.click(screen.getByTestId("ocr-try-it-run"))
    await user.click(screen.getByTestId("ocr-try-it-confirm-ok"))
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1))
    const callArg = mockRun.mock.calls[0][0]
    expect(callArg.providerId).toBe("mistral-ocr")
    expect(callArg.source.kind).toBe("blob")
    expect((callArg.source as { blob: File }).blob.name).toBe("test.png")
  })

  it("renders an abort button while running", () => {
    mockState = { status: "running", result: null, error: null }
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    expect(screen.getByTestId("ocr-try-it-abort")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("ocr-try-it-abort"))
    expect(mockAbort).toHaveBeenCalledTimes(1)
  })

  it("renders an error banner when status is error", () => {
    mockState = {
      status: "error",
      result: null,
      error: { code: "rate_limited", message: "Too many requests" },
    }
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    const banner = screen.getByTestId("ocr-try-it-error")
    expect(banner).toHaveTextContent("rate_limited")
    expect(banner).toHaveTextContent("Too many requests")
  })

  it("renders the inline result when status is success", () => {
    mockState = {
      status: "success",
      result: {
        providerId: "mistral-ocr",
        pages: [{ pageNumber: 1, markdown: "Hello", text: "Hello" }],
        combinedMarkdown: "Hello",
        combinedText: "Hello",
        languages: ["en"],
        durationMs: 432,
        cached: false,
      },
      error: null,
    }
    render(<OcrTryItTab providerId="mistral-ocr" depsFactory={noopDeps} />)
    expect(screen.getByTestId("ocr-result-inline")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-page-1")).toHaveTextContent("Hello")
  })
})
