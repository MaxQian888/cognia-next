import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The lazy pixi canvas can't run in jsdom — record props instead. When
// `canvasErrorCode` is set it reports that code through `onError` (the async
// load-failure path) so the dialog's error fallback can be exercised.
let canvasErrorCode: string | null = null
const canvasProps = jest.fn()
jest.mock("@/components/pet/skins/live2d/live2d-canvas", () => {
  const ReactActual = jest.requireActual("react") as typeof import("react")
  function MockPreviewCanvas(props: { onError?: (code: string) => void }) {
    canvasProps(props)
    ReactActual.useEffect(() => {
      if (!canvasErrorCode) return
      const id = setTimeout(() => props.onError?.(canvasErrorCode!), 0)
      return () => clearTimeout(id)
    }, [props])
    return <div data-testid="preview-canvas" />
  }
  return { __esModule: true, default: MockPreviewCanvas }
})

let coreAvailable: boolean | undefined = true
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useCubismCoreAvailable: () => coreAvailable,
}))

const updatePetModelCustomization = jest.fn().mockResolvedValue(undefined)
const getPetModelEntries = jest.fn()
jest.mock("@/lib/db/pet-models", () => ({
  updatePetModelCustomization: (...a: unknown[]) => updatePetModelCustomization(...a),
  getPetModelEntries: (...a: unknown[]) => getPetModelEntries(...a),
}))

import type { PetModelRow } from "@/lib/db/pet-models"
import { PetModelConfigDialog } from "./pet-model-config-dialog"

const MODEL: PetModelRow = {
  id: "m1",
  name: "Hiyori",
  source: "import",
  settingsPath: "Hiyori.model3.json",
  motionGroups: ["Idle", "Tap"],
  expressionIds: ["happy"],
  totalBytes: 1000,
  createdAt: 0,
  transform: { scale: 1.4, offsetX: 0.1, offsetY: 0 },
  motionOverrides: { happy: { motionGroup: "Tap" } },
}

const SETTINGS_JSON = JSON.stringify({
  FileReferences: { Moc: "a.moc3", Motions: { Idle: [{ File: "a" }, { File: "b" }] } },
})

beforeEach(() => {
  canvasErrorCode = null
  canvasProps.mockClear()
  updatePetModelCustomization.mockClear()
  getPetModelEntries.mockReset()
  getPetModelEntries.mockResolvedValue([
    { path: "Hiyori.model3.json", blob: new Blob([SETTINGS_JSON]) },
  ])
  coreAvailable = true
})

async function renderDialog(onOpenChange = jest.fn(), model: PetModelRow = MODEL) {
  const view = render(<PetModelConfigDialog model={model} open onOpenChange={onOpenChange} />)
  await act(async () => {}) // flush the counts fetch
  return { view, onOpenChange }
}

describe("PetModelConfigDialog", () => {
  it("seeds the draft from the model row and feeds the preview canvas", async () => {
    await renderDialog()
    expect(screen.getByTestId("preview-canvas")).toBeInTheDocument()
    expect(canvasProps).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "m1",
        transform: { scale: 1.4, offsetX: 0.1, offsetY: 0 },
        motionOverrides: { happy: { motionGroup: "Tap" } },
        state: "idle",
        oneShot: null,
      })
    )
  })

  it("shows a localized error instead of an empty preview when the model fails to load", async () => {
    canvasErrorCode = "modelFailed"
    await renderDialog()
    await waitFor(() => {
      expect(screen.queryByTestId("preview-canvas")).toBeNull()
      expect(screen.getByRole("alert")).toHaveTextContent("modelFailed")
    })
  })

  it("hides the preview with a hint when the Cubism core is unavailable", async () => {
    coreAvailable = false
    await renderDialog()
    expect(screen.queryByTestId("preview-canvas")).toBeNull()
    expect(screen.getByText("previewUnavailable")).toBeInTheDocument()
  })

  it("saves the normalized draft and closes", async () => {
    const { onOpenChange } = await renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() =>
      expect(updatePetModelCustomization).toHaveBeenCalledWith("m1", {
        transform: { scale: 1.4, offsetX: 0.1, offsetY: 0 },
        motionOverrides: { happy: { motionGroup: "Tap" } },
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("cancel closes without persisting", async () => {
    const { onOpenChange } = await renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(updatePetModelCustomization).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("reset-all clears the draft (visible on the next save)", async () => {
    await renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "resetAll" }))
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() =>
      expect(updatePetModelCustomization).toHaveBeenCalledWith("m1", {
        transform: { scale: 1, offsetX: 0, offsetY: 0 },
        motionOverrides: {},
      })
    )
  })

  it("the preview state selector switches the resting state", async () => {
    await renderDialog()
    fireEvent.change(document.getElementById("pet-preview-state") as HTMLSelectElement, {
      target: { value: "sleeping" },
    })
    expect(canvasProps).toHaveBeenLastCalledWith(expect.objectContaining({ state: "sleeping" }))
  })

  it("testing a one-shot row pulses the preview oneShot and clears it", async () => {
    jest.useFakeTimers()
    try {
      const user = userEvent.setup({ advanceTimers: (ms) => jest.advanceTimersByTime(ms) })
      render(<PetModelConfigDialog model={MODEL} open onOpenChange={jest.fn()} />)
      await act(async () => {}) // counts fetch
      // Switch to the motion tab to reach the Test buttons (Radix tabs need
      // real pointer events — fireEvent.click does not activate them).
      await user.click(screen.getByRole("tab", { name: "tabMotion" }))
      await user.click(screen.getByTestId("pet-mapping-test-shot:wave"))
      // Pulse: null → shot on the next macrotask…
      await act(async () => {
        jest.advanceTimersByTime(1)
      })
      expect(canvasProps).toHaveBeenLastCalledWith(expect.objectContaining({ oneShot: "wave" }))
      // …then back to null after the test window.
      await act(async () => {
        jest.advanceTimersByTime(2000)
      })
      expect(canvasProps).toHaveBeenLastCalledWith(expect.objectContaining({ oneShot: null }))
    } finally {
      jest.useRealTimers()
    }
  })

  it("testing a state row switches the preview state directly", async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole("tab", { name: "tabMotion" }))
    await user.click(screen.getByTestId("pet-mapping-test-error"))
    expect(canvasProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "error", oneShot: null })
    )
  })

  it("motion-count fetch failure leaves the editor usable (random only)", async () => {
    getPetModelEntries.mockRejectedValue(new Error("boom"))
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole("tab", { name: "tabMotion" }))
    expect(screen.getAllByTestId(/pet-mapping-row-/)).toHaveLength(22)
  })
})
