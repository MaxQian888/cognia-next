import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrCompareView } from "./ocr-compare-view"

const mockExtract = jest.fn()
jest.mock("@/lib/ocr/index", () => ({
  extract: (...args: unknown[]) => mockExtract(...args),
}))

const PROVIDERS = [
  { id: "mistral-ocr", label: "Mistral OCR" },
  { id: "paddle-ocr", label: "Paddle OCR" },
  { id: "tesseract-wasm", label: "Tesseract (WASM)" },
  { id: "google-vision", label: "Google Vision" },
]

const stubDeps = { fake: true } as unknown
const depsFactory = () => stubDeps as never

function pngFile(name = "test.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" })
}

beforeEach(() => {
  mockExtract.mockReset()
})

describe("OcrCompareView", () => {
  it("renders the empty state when no providers are picked", () => {
    render(<OcrCompareView providers={PROVIDERS} onBack={() => {}} depsFactory={depsFactory} />)
    expect(screen.getByTestId("ocr-compare-empty")).toBeInTheDocument()
  })

  it("caps provider selection at 3", async () => {
    const user = userEvent.setup()
    render(<OcrCompareView providers={PROVIDERS} onBack={() => {}} depsFactory={depsFactory} />)
    await user.click(screen.getByTestId("ocr-compare-add-provider"))
    await user.click(screen.getByTestId("ocr-compare-option-mistral-ocr"))
    await user.click(screen.getByTestId("ocr-compare-option-paddle-ocr"))
    await user.click(screen.getByTestId("ocr-compare-option-tesseract-wasm"))
    expect(screen.getByTestId("ocr-compare-chip-mistral-ocr")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-compare-chip-paddle-ocr")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-compare-chip-tesseract-wasm")).toBeInTheDocument()
    // Add button is now disabled.
    expect(screen.getByTestId("ocr-compare-add-provider")).toBeDisabled()
  })

  it("opens the confirm dialog before extracting and does nothing on cancel", async () => {
    const user = userEvent.setup()
    render(
      <OcrCompareView
        providers={PROVIDERS}
        initialSelectedIds={["mistral-ocr", "paddle-ocr"]}
        onBack={() => {}}
        depsFactory={depsFactory}
      />
    )
    await user.upload(screen.getByTestId("ocr-compare-file-input") as HTMLInputElement, pngFile())
    await user.click(screen.getByTestId("ocr-compare-run-all"))
    expect(await screen.findByTestId("ocr-compare-confirm")).toBeInTheDocument()
    await user.click(screen.getByTestId("ocr-compare-confirm-cancel"))
    expect(mockExtract).not.toHaveBeenCalled()
  })

  it("runs all selected providers in parallel after confirming and renders columns", async () => {
    mockExtract.mockImplementation(async (input: { providerId: string }) => ({
      providerId: input.providerId,
      pages: [
        { pageNumber: 1, markdown: `${input.providerId}-out`, text: `${input.providerId}-out` },
      ],
      combinedMarkdown: `${input.providerId}-out`,
      combinedText: `${input.providerId}-out`,
      languages: ["en"],
      durationMs: 100,
      cached: false,
    }))

    const user = userEvent.setup()
    render(
      <OcrCompareView
        providers={PROVIDERS}
        initialSelectedIds={["mistral-ocr", "paddle-ocr"]}
        onBack={() => {}}
        depsFactory={depsFactory}
      />
    )
    await user.upload(screen.getByTestId("ocr-compare-file-input") as HTMLInputElement, pngFile())
    await user.click(screen.getByTestId("ocr-compare-run-all"))
    await user.click(screen.getByTestId("ocr-compare-confirm-ok"))

    await waitFor(() => expect(mockExtract).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId("ocr-compare-column-mistral-ocr")).toHaveTextContent(
      "mistral-ocr-out"
    )
    expect(screen.getByTestId("ocr-compare-column-paddle-ocr")).toHaveTextContent("paddle-ocr-out")
  })

  it("renders an error column when one provider fails", async () => {
    mockExtract.mockImplementation(async (input: { providerId: string }) => {
      if (input.providerId === "paddle-ocr") {
        throw Object.assign(new Error("Boom"), { code: "provider_failed" })
      }
      return {
        providerId: input.providerId,
        pages: [{ pageNumber: 1, markdown: "x", text: "x" }],
        combinedMarkdown: "x",
        combinedText: "x",
        languages: [],
        durationMs: 1,
        cached: false,
      }
    })
    const user = userEvent.setup()
    render(
      <OcrCompareView
        providers={PROVIDERS}
        initialSelectedIds={["mistral-ocr", "paddle-ocr"]}
        onBack={() => {}}
        depsFactory={depsFactory}
      />
    )
    await user.upload(screen.getByTestId("ocr-compare-file-input") as HTMLInputElement, pngFile())
    await user.click(screen.getByTestId("ocr-compare-run-all"))
    await user.click(screen.getByTestId("ocr-compare-confirm-ok"))
    expect(await screen.findByTestId("ocr-compare-state-error-paddle-ocr")).toHaveTextContent(
      "Boom"
    )
  })

  it("calls onBack when the back button is pressed", () => {
    const onBack = jest.fn()
    render(<OcrCompareView providers={PROVIDERS} onBack={onBack} depsFactory={depsFactory} />)
    fireEvent.click(screen.getByRole("button", { name: /back/i }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
