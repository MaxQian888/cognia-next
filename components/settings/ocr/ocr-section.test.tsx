import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  LocalModelManager,
  OcrSection,
  type DownloadProgressEvent,
  type ModelStatus,
  type OcrModelBridge,
} from "./ocr-section"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"

function renderSection(
  overrides: Partial<UserOcrSettings> = {},
  modelBridge: OcrModelBridge | null = null,
  extra: Partial<React.ComponentProps<typeof OcrSection>> = {}
) {
  // Default to wizard-dismissed in tests so the auto-open Dialog doesn't add
  // pointer-events: none to the body and break unrelated sidebar interactions.
  const settings: UserOcrSettings = {
    ...DEFAULT_OCR_SETTINGS,
    ocrWizardDismissed: true,
    ...overrides,
  }
  const onChange = jest.fn()
  const onClearCache = jest.fn()
  const onClearProviderCache = jest.fn()
  const onCredentialChange = jest.fn()
  const utils = render(
    <OcrSection
      settings={settings}
      onChange={onChange}
      onClearCache={onClearCache}
      onClearProviderCache={onClearProviderCache}
      onCredentialChange={onCredentialChange}
      modelBridge={modelBridge}
      platform="web"
      {...extra}
    />
  )
  return { ...utils, onChange, onClearCache, onClearProviderCache, onCredentialChange }
}

describe("OcrSection", () => {
  it("renders the section testid without an in-page heading (shell breadcrumb owns the title)", () => {
    renderSection()
    expect(screen.getByTestId("ocr-section")).toBeInTheDocument()
    // Mirrors the provider settings page: the settings shell breadcrumb (and
    // the mobile SubPageShell) render the section title, so no in-page <h1>.
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument()
  })

  it("defaults to the Auto-Router pseudo-entry", () => {
    renderSection()
    expect(screen.getByTestId("ocr-auto-router-panel")).toBeInTheDocument()
  })

  it("lists every shipped provider in the sidebar", () => {
    renderSection()
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
      /ocrs/i,
      /PaddleOCR/i,
      /Local HTTP/i,
    ]
    for (const label of knownLabels) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it("switches to the detail panel when a provider is clicked", async () => {
    const user = userEvent.setup()
    renderSection()
    const mistralBtn = screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!
    await user.click(mistralBtn)
    expect(screen.getByTestId("ocr-detail-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("ocr-auto-router-panel")).not.toBeInTheDocument()
  })

  it("renders the structured runtime unavailable reason in provider details", async () => {
    const user = userEvent.setup()
    renderSection({}, null, {
      platform: "tauri",
      runtimeStatuses: {
        "paddle-ocr": {
          providerId: "paddle-ocr",
          shellSupported: true,
          backendBound: true,
          ready: false,
          reason: "model-corrupt",
        },
      },
    })

    await user.click(screen.getAllByTestId("ocr-sidebar-item-paddle-ocr")[0]!)
    expect(screen.getByRole("status")).toHaveTextContent(
      /model files failed integrity verification/i
    )
  })

  it("fires onClearCache from the sidebar footer button", async () => {
    const user = userEvent.setup()
    const { onClearCache } = renderSection()
    await user.click(screen.getByRole("button", { name: /Clear OCR cache/i }))
    expect(onClearCache).toHaveBeenCalledTimes(1)
  })

  it("fires onChange when the Auto-Router languages input changes", () => {
    const { onChange } = renderSection()
    const input = screen.getByLabelText(/Default languages/i) as HTMLInputElement
    input.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "en,zh"
    )
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.defaultLanguages).toEqual(["en", "zh"])
  })

  it("toggles the cloud fallback switch from the Auto-Router panel", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ cloudFallbackEnabled: true })
    const switches = screen.getAllByRole("switch")
    const cloud = switches.find((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("cloud")
    )!
    await user.click(cloud)
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.cloudFallbackEnabled).toBe(false)
  })

  it("toggles a provider's enabled flag from the detail panel header", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection()
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    const detail = screen.getByTestId("ocr-detail-panel")
    const toggle = within(detail).getByRole("switch")
    await user.click(toggle)
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.providerEnabled["mistral-ocr"]).toBe(false)
  })

  it("calls onClearProviderCache from the Advanced tab clear-cache action", async () => {
    const user = userEvent.setup()
    const { onClearProviderCache } = renderSection()
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    await user.click(screen.getByRole("tab", { name: /Advanced/i }))
    await user.click(screen.getByTestId("ocr-adv-clear-cache"))
    expect(onClearProviderCache).toHaveBeenCalledWith("mistral-ocr")
  })

  it("threads credentials updates through onCredentialChange", async () => {
    const user = userEvent.setup()
    const { onCredentialChange } = renderSection()
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    const input = screen.getByLabelText(/API key/i)
    await user.type(input, "k")
    expect(onCredentialChange).toHaveBeenCalled()
    expect(onCredentialChange.mock.calls.at(-1)).toEqual(["mistral-ocr", "apiKey", "k"])
  })

  it("derives connected status once credentials are present", async () => {
    const user = userEvent.setup()
    renderSection({}, null, { credentials: { "mistral-ocr": { apiKey: "sk-z" } } })
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    expect(document.querySelector('[data-status="connected"]')).not.toBeNull()
  })

  it("derives unsupported status when shell doesn't allow the provider", async () => {
    const user = userEvent.setup()
    renderSection({}, null, { platform: "web" })
    // tesseract-native is tauri-only — should be 'unsupported' on web shell.
    await user.click(screen.getAllByTestId("ocr-sidebar-item-tesseract-native")[0]!)
    expect(document.querySelector('[data-status="unsupported"]')).not.toBeNull()
  })

  it("marks every OCR provider unsupported in the headless host profile", async () => {
    const user = userEvent.setup()
    renderSection({}, null, { platform: "headless" })
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    expect(document.querySelector('[data-status="unsupported"]')).not.toBeNull()
  })

  it("shows the LocalModelManager for managed-model backends when a bridge is provided", async () => {
    const user = userEvent.setup()
    const stubBridge = makeBridgeStub({
      installed: false,
      files: [{ file_name: "x", installed: false, expected_bytes: 100 }],
    })
    renderSection({}, stubBridge, { platform: "tauri" })
    // The auto-router panel is the default; switch to ocrs first.
    const ocrsBtn = screen.getAllByTestId("ocr-sidebar-item-ocrs")[0]!
    await user.click(ocrsBtn)
    await user.click(screen.getByRole("tab", { name: /Models/i }))
    expect(await screen.findByTestId("ocr-model-manager-ocrs")).toBeInTheDocument()
  })

  it("hides the LocalModelManager for non-managed backends", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    await user.click(screen.getByRole("tab", { name: /Models/i }))
    expect(screen.queryByTestId("ocr-model-manager-mistral-ocr")).not.toBeInTheDocument()
    expect(screen.getByTestId("ocr-models-empty")).toBeInTheDocument()
  })

  it("suppresses the LocalModelManager entirely when modelBridge is null on managed backends", async () => {
    const user = userEvent.setup()
    renderSection({}, null)
    const ocrsBtn = screen.getAllByTestId("ocr-sidebar-item-ocrs")[0]!
    await user.click(ocrsBtn)
    await user.click(screen.getByRole("tab", { name: /Models/i }))
    expect(screen.queryByTestId("ocr-model-manager-ocrs")).not.toBeInTheDocument()
    expect(screen.getByTestId("ocr-models-shell-unavailable")).toBeInTheDocument()
  })

  it("renders the probe button only when onProbeProvider is supplied", async () => {
    const user = userEvent.setup()
    const onProbeProvider = jest.fn(async () => ({ ok: true as const, durationMs: 42 }))
    renderSection({}, null, { onProbeProvider })
    await user.click(screen.getAllByTestId("ocr-sidebar-item-mistral-ocr")[0]!)
    expect(screen.getByTestId("ocr-probe-button")).toBeInTheDocument()
    await user.click(screen.getByTestId("ocr-probe-button"))
    await waitFor(() => expect(onProbeProvider).toHaveBeenCalledWith("mistral-ocr"))
    // After a successful probe the sidebar badge flips to "connected".
    await waitFor(() => {
      expect(document.querySelector('[data-status="connected"]')).not.toBeNull()
    })
  })

  it("renders the mobile sheet trigger", () => {
    renderSection()
    expect(screen.getByTestId("ocr-mobile-sheet-trigger")).toBeInTheDocument()
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

describe("LocalModelManager (backward-compat re-export)", () => {
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
