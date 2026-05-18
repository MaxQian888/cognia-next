import { render, screen, waitFor } from "@testing-library/react"
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
    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith("ocrs"))
  })
})
