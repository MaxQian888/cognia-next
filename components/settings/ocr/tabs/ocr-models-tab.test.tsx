import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrModelsTab, type ModelStatus, type OcrModelBridge } from "./ocr-models-tab"

function makeBridge(initial: Partial<ModelStatus> = {}): OcrModelBridge {
  const status: ModelStatus = {
    backend: "ocrs",
    installed: false,
    model_dir: "/tmp/ocrs",
    files: [{ file_name: "det.rten", installed: false, expected_bytes: 100 }],
    total_bytes: 0,
    ...initial,
  }
  return {
    async status() {
      return status
    },
    async download() {
      return { ...status, installed: true, total_bytes: 100 }
    },
    onProgress: () => () => {},
  }
}

describe("OcrModelsTab", () => {
  it("renders LocalModelManager for ocrs when a bridge is provided", async () => {
    render(<OcrModelsTab providerId="ocrs" bridge={makeBridge()} />)
    expect(await screen.findByTestId("ocr-model-manager-ocrs")).toBeInTheDocument()
  })

  it("renders LocalModelManager for paddle-ocr when a bridge is provided", async () => {
    render(<OcrModelsTab providerId="paddle-ocr" bridge={makeBridge({ backend: "paddle-ocr" })} />)
    expect(await screen.findByTestId("ocr-model-manager-paddle-ocr")).toBeInTheDocument()
  })

  it("shows the no-managed-files empty state for non-local-model providers", () => {
    render(<OcrModelsTab providerId="mistral-ocr" bridge={null} />)
    expect(screen.getByTestId("ocr-models-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("ocr-model-manager-mistral-ocr")).not.toBeInTheDocument()
  })

  it("shows the shell-unavailable hint when bridge is explicitly null for a managed backend", () => {
    render(<OcrModelsTab providerId="ocrs" bridge={null} />)
    expect(screen.getByTestId("ocr-models-shell-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("ocr-model-manager-ocrs")).not.toBeInTheDocument()
  })

  it("invokes download via the bridge when the manager button is clicked", async () => {
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
    render(<OcrModelsTab providerId="ocrs" bridge={bridge} />)
    const button = await screen.findByRole("button", { name: /download models/i })
    await user.click(button)
    await waitFor(() =>
      expect(downloadMock).toHaveBeenCalledWith("ocrs", undefined, expect.any(String))
    )
  })

  it("turns the download action into Cancel while a request is active", async () => {
    const user = userEvent.setup()
    let resolveDownload: ((status: ModelStatus) => void) | undefined
    const download = jest.fn(
      () =>
        new Promise<ModelStatus>((resolve) => {
          resolveDownload = resolve
        })
    )
    const cancel = jest.fn(async () => true)
    const bridge = makeBridge()
    bridge.download = download
    bridge.cancel = cancel

    render(<OcrModelsTab providerId="ocrs" bridge={bridge} />)
    await user.click(await screen.findByRole("button", { name: /download models/i }))
    const cancelButton = await screen.findByRole("button", { name: /cancel download/i })
    await user.click(cancelButton)

    const requestId = (download.mock.calls as unknown as Array<[string, string?, string?]>)[0]?.[2]
    expect(requestId).toEqual(expect.any(String))
    expect(cancel).toHaveBeenCalledWith(requestId)
    await act(async () => {
      resolveDownload?.(await bridge.status("ocrs"))
    })
    await screen.findByRole("button", { name: /download models/i })
  })

  it("passes the selected PaddleOCR v6 variant to the native bridge", async () => {
    const bridge = makeBridge({ backend: "paddle-ocr" })
    const statusSpy = jest.spyOn(bridge, "status")
    render(<OcrModelsTab providerId="paddle-ocr" modelVariant="v6-tiny" bridge={bridge} />)
    await waitFor(() => expect(statusSpy).toHaveBeenCalledWith("paddle-ocr", "v6-tiny"))
  })

  it("reports preserved legacy Paddle files as non-active", async () => {
    render(
      <OcrModelsTab
        providerId="paddle-ocr"
        bridge={makeBridge({
          backend: "paddle-ocr",
          legacy_files: ["det.onnx", "rec.onnx", "dict.txt"],
          legacy_model_dir: "/tmp/paddle",
        })}
      />
    )

    expect(await screen.findByText(/legacy PP-OCRv5 files/i)).toHaveTextContent("/tmp/paddle")
  })
})
