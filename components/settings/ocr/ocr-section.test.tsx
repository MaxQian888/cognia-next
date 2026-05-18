import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  LocalModelManager,
  OcrSection,
  type DownloadProgressEvent,
  type ModelStatus,
  type OcrModelBridge,
} from "./ocr-section"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/lib/ocr/types"

function renderSection(
  overrides: Partial<UserOcrSettings> = {},
  modelBridge: OcrModelBridge | null = null
) {
  const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, ...overrides }
  const onChange = jest.fn()
  const onClearCache = jest.fn()
  const onClearProviderCache = jest.fn()
  const utils = render(
    <OcrSection
      settings={settings}
      onChange={onChange}
      onClearCache={onClearCache}
      onClearProviderCache={onClearProviderCache}
      modelBridge={modelBridge}
    />
  )
  return { ...utils, onChange, onClearCache, onClearProviderCache }
}

describe("OcrSection", () => {
  it("renders the OCR settings heading and description", () => {
    renderSection()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/ocr/i)
    expect(screen.getByTestId("ocr-section")).toBeInTheDocument()
  })

  it("lists every provider grouped by category", () => {
    renderSection()
    // The sidebar list renders the translated label for every provider. The
    // default Jest i18n mock resolves keys against `en.json`, so each label
    // is the human-readable provider name (e.g. "Mistral OCR").
    const knownLabels = [
      /Mistral OCR/i,
      /Google Cloud Vision/i,
      /AWS Textract/i,
      /Azure AI Document Intelligence/i,
      /Claude \(vision\)/i,
      /OpenAI \(vision\)/i,
      /Gemini \(vision\)/i,
      /Mathpix/i,
      /OCR\.space/i,
      /ABBYY/i,
      /Nanonets/i,
      /Feishu \/ Lark/i,
      /Tesseract \(WASM\)/i,
      /Tesseract \(native\)/i,
      /Windows\.Media\.Ocr/i,
      /Apple Vision/i,
      /ML Kit Text Recognition/i,
    ]
    for (const label of knownLabels) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it("invokes onChange when the default languages input changes", async () => {
    const { onChange } = renderSection()
    const input = screen.getByLabelText(/languages/i) as HTMLInputElement
    // userEvent.type escapes commas; fire a change event directly so we keep
    // the assertion focused on the controlled-input wiring.
    input.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "en,zh"
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as UserOcrSettings
    expect(last.defaultLanguages).toEqual(["en", "zh"])
  })

  it("toggles the cloud-fallback switch", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ cloudFallbackEnabled: true })
    const switches = screen.getAllByRole("switch")
    const cloudFallback = switches.find((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("cloud")
    )!
    await user.click(cloudFallback)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as UserOcrSettings
    expect(last.cloudFallbackEnabled).toBe(false)
  })

  it("toggles a provider's enabled flag from the detail card", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection()
    const detailCard = screen.getByTestId("ocr-provider-detail")
    const toggle = within(detailCard).getByRole("switch")
    await user.click(toggle)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as UserOcrSettings
    expect(Object.values(last.providerEnabled)).toContain(false)
  })

  it("calls onClearCache when the global clear-cache button is pressed", async () => {
    const user = userEvent.setup()
    const { onClearCache } = renderSection()
    await user.click(screen.getByRole("button", { name: "Clear OCR cache" }))
    expect(onClearCache).toHaveBeenCalledTimes(1)
  })

  it("calls onClearProviderCache scoped to the selected provider", async () => {
    const user = userEvent.setup()
    const { onClearProviderCache } = renderSection()
    const detailCard = screen.getByTestId("ocr-provider-detail")
    const button = within(detailCard).getByRole("button", {
      name: /clear cache for this provider/i,
    })
    await user.click(button)
    expect(onClearProviderCache).toHaveBeenCalledTimes(1)
    // Default selection is the first provider in PROVIDER_LIST.
    expect(onClearProviderCache).toHaveBeenCalledWith("mistral-ocr")
  })

  it("includes the new local providers in the sidebar", () => {
    renderSection()
    expect(screen.getAllByText(/ocrs \(local\)/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/PaddleOCR \(local\)/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Local HTTP \(self-hosted\)/i).length).toBeGreaterThan(0)
  })

  it("shows the model manager only for backends with managed models", async () => {
    const user = userEvent.setup()
    const stubBridge = makeBridgeStub({
      installed: false,
      files: [{ file_name: "x", installed: false, expected_bytes: 100 }],
    })
    renderSection({}, stubBridge)
    // Mistral OCR is selected by default — no model manager.
    expect(screen.queryByTestId("ocr-model-manager-ocrs")).not.toBeInTheDocument()
    // Click the ocrs entry in the sidebar.
    const ocrsButton = screen.getAllByRole("button", { name: /ocrs \(local\)/i })[0]!
    await user.click(ocrsButton)
    expect(screen.getByTestId("ocr-model-manager-ocrs")).toBeInTheDocument()
    // local-http is not in the managed-models set.
    const localHttp = screen.getAllByRole("button", { name: /Local HTTP/i })[0]!
    await user.click(localHttp)
    expect(screen.queryByTestId("ocr-model-manager-ocrs")).not.toBeInTheDocument()
    expect(screen.queryByTestId("ocr-model-manager-local-http")).not.toBeInTheDocument()
  })

  it("suppresses the model row entirely when modelBridge is null", async () => {
    const user = userEvent.setup()
    renderSection({}, null)
    const ocrsButton = screen.getAllByRole("button", { name: /ocrs \(local\)/i })[0]!
    await user.click(ocrsButton)
    expect(screen.queryByTestId("ocr-model-manager-ocrs")).not.toBeInTheDocument()
  })
})

function makeBridgeStub(initial: Partial<ModelStatus> = {}): OcrModelBridge {
  let status: ModelStatus = {
    backend: "ocrs",
    installed: false,
    model_dir: "/tmp/ocrs",
    files: [],
    total_bytes: 0,
    ...initial,
  }
  const listeners: Array<(e: DownloadProgressEvent) => void> = []
  return {
    async status() {
      return status
    },
    async download(backend) {
      status = {
        ...status,
        backend,
        installed: true,
        files: status.files.map((f) => ({ ...f, installed: true, actual_bytes: f.expected_bytes })),
        total_bytes: status.files.reduce((acc, f) => acc + f.expected_bytes, 0),
      }
      return status
    },
    onProgress(handler) {
      listeners.push(handler)
      return () => {
        const idx = listeners.indexOf(handler)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }
}

describe("LocalModelManager", () => {
  it("shows missing-model count from the initial status", async () => {
    const bridge: OcrModelBridge = {
      async status() {
        return {
          backend: "ocrs",
          installed: false,
          model_dir: "/tmp/ocrs",
          files: [
            { file_name: "det.rten", installed: false, expected_bytes: 100 },
            { file_name: "rec.rten", installed: true, expected_bytes: 200, actual_bytes: 200 },
          ],
          total_bytes: 200,
        }
      },
      async download() {
        throw new Error("not reached")
      },
      onProgress: () => () => {},
    }
    render(<LocalModelManager backend="ocrs" bridge={bridge} />)
    await waitFor(() => {
      expect(screen.getByText(/1 model file/i)).toBeInTheDocument()
    })
  })

  it("invokes download and refreshes status on click", async () => {
    const user = userEvent.setup()
    const downloadMock = jest.fn(async () => ({
      backend: "ocrs",
      installed: true,
      model_dir: "/tmp/ocrs",
      files: [{ file_name: "det.rten", installed: true, expected_bytes: 100, actual_bytes: 100 }],
      total_bytes: 100,
    }))
    const bridge: OcrModelBridge = {
      async status() {
        return {
          backend: "ocrs",
          installed: false,
          model_dir: "/tmp/ocrs",
          files: [{ file_name: "det.rten", installed: false, expected_bytes: 100 }],
          total_bytes: 0,
        }
      },
      download: downloadMock,
      onProgress: () => () => {},
    }
    render(<LocalModelManager backend="ocrs" bridge={bridge} />)
    const button = await screen.findByRole("button", { name: /download/i })
    await user.click(button)
    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith("ocrs"))
    await waitFor(() => {
      expect(screen.getByText(/models ready/i)).toBeInTheDocument()
    })
  })

  it("displays progress events while downloading", async () => {
    let emit: ((e: DownloadProgressEvent) => void) | null = null
    let resolveDownload!: (s: ModelStatus) => void
    const bridge: OcrModelBridge = {
      async status() {
        return {
          backend: "ocrs",
          installed: false,
          model_dir: "/tmp/ocrs",
          files: [{ file_name: "det.rten", installed: false, expected_bytes: 100 }],
          total_bytes: 0,
        }
      },
      async download() {
        return new Promise<ModelStatus>((resolve) => {
          resolveDownload = resolve
        })
      },
      onProgress(handler) {
        emit = handler
        return () => {
          emit = null
        }
      },
    }
    const user = userEvent.setup()
    render(<LocalModelManager backend="ocrs" bridge={bridge} />)
    const button = await screen.findByRole("button", { name: /download/i })
    await user.click(button)
    act(() => {
      emit?.({
        backend: "ocrs",
        file_name: "det.rten",
        bytes_done: 50,
        bytes_total: 100,
        file_index: 1,
        file_count: 1,
      })
    })
    await waitFor(() => {
      expect(screen.getByText(/Downloading det.rten/i)).toBeInTheDocument()
    })
    act(() => {
      resolveDownload({
        backend: "ocrs",
        installed: true,
        model_dir: "/tmp/ocrs",
        files: [{ file_name: "det.rten", installed: true, expected_bytes: 100, actual_bytes: 100 }],
        total_bytes: 100,
      })
    })
    await waitFor(() => {
      expect(screen.getByText(/models ready/i)).toBeInTheDocument()
    })
  })

  it("surfaces an error when the download promise rejects", async () => {
    const user = userEvent.setup()
    const bridge: OcrModelBridge = {
      async status() {
        return {
          backend: "ocrs",
          installed: false,
          model_dir: "/tmp/ocrs",
          files: [{ file_name: "det.rten", installed: false, expected_bytes: 100 }],
          total_bytes: 0,
        }
      },
      async download() {
        throw new Error("network unreachable")
      },
      onProgress: () => () => {},
    }
    render(<LocalModelManager backend="ocrs" bridge={bridge} />)
    const button = await screen.findByRole("button", { name: /download/i })
    await user.click(button)
    await waitFor(() => {
      const alert = screen.getByRole("alert")
      expect(alert).toHaveTextContent(/network unreachable/i)
    })
  })
})
