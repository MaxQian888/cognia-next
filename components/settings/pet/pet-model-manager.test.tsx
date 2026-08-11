import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

// Drive the live model list / usage from mutable module state.
let modelList: Array<Record<string, unknown>> = []
let usageValue = { models: 0, totalBytes: 0 }
jest.mock("dexie-react-hooks", () => ({
  // listPetModels / getPetModelStorageUsage are mocked to return sync values,
  // so the querier result is returned directly.
  useLiveQuery: (fn: () => unknown, ..._rest: unknown[]) => fn(),
}))

const listPetModels = jest.fn(() => modelList)
const getPetModelStorageUsage = jest.fn(() => usageValue)
const deletePetModel = jest.fn((_id: string) => Promise.resolve())
jest.mock("@/lib/db/pet-models", () => ({
  listPetModels: () => listPetModels(),
  getPetModelStorageUsage: () => getPetModelStorageUsage(),
  deletePetModel: (id: string) => deletePetModel(id),
}))

const filesToEntries = jest.fn()
const importModelFromEntries = jest.fn()
const downloadSampleModel = jest.fn()
jest.mock("./pet-model-import", () => ({
  filesToEntries: (...a: unknown[]) => filesToEntries(...a),
  importModelFromEntries: (...a: unknown[]) => importModelFromEntries(...a),
  downloadSampleModel: (...a: unknown[]) => downloadSampleModel(...a),
}))

// Discovery has its own deep suite — control its result here.
const discoverLive2dModels = jest.fn()
jest.mock("@/lib/pet/live2d/discover-models", () => ({
  discoverLive2dModels: (...a: unknown[]) => discoverLive2dModels(...a),
}))

// The multi-model selection dialog has its own suite — record + stub it.
const importDialogProps = jest.fn()
jest.mock("./pet-model-import-dialog", () => ({
  PetModelImportDialog: (props: {
    models: unknown[]
    open: boolean
    onImported: (id?: string) => void
    onOpenChange: (open: boolean) => void
  }) => {
    importDialogProps(props)
    return props.open ? <div data-testid="pet-import-dialog">{props.models.length}</div> : null
  },
}))

const discovered = (key: string, valid = true) => ({
  key,
  name: key,
  settingsPath: `${key}.model3.json`,
  entries: [{ path: `${key}.model3.json`, blob: new Blob(["{}"]) }],
  totalBytes: 1,
  valid,
})

// The config dialog has its own deep suite — record which model it opens for.
const configDialogProps = jest.fn()
jest.mock("./pet-model-config-dialog", () => ({
  PetModelConfigDialog: (props: { model: { id: string }; open: boolean }) => {
    configDialogProps(props)
    return props.open ? <div data-testid="pet-config-dialog">{props.model.id}</div> : null
  },
}))

import { PetModelManager } from "./pet-model-manager"

function setup(settings: Partial<PetSettings> = {}, coreReady?: boolean) {
  const onPatch = jest.fn()
  render(
    <PetModelManager
      settings={{ ...DEFAULT_PET_SETTINGS, ...settings }}
      onPatch={onPatch}
      coreReady={coreReady}
    />
  )
  return { onPatch }
}

const model = (id: string, name: string) => ({
  id,
  name,
  source: "import",
  settingsPath: `${name}.model3.json`,
  motionGroups: [],
  expressionIds: [],
  totalBytes: 1000,
  createdAt: 0,
})

beforeEach(() => {
  jest.clearAllMocks()
  modelList = []
  usageValue = { models: 0, totalBytes: 0 }
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true })
  // Default: a bundle with exactly one model → the direct (single) import path.
  discoverLive2dModels.mockResolvedValue([discovered("single")])
})

describe("PetModelManager", () => {
  it("shows an empty-state message when there are no models", () => {
    setup()
    expect(screen.getByText(/No Live2D models yet/i)).toBeInTheDocument()
  })

  it("lists installed models and marks the active one", () => {
    modelList = [model("m1", "MyModelA"), model("m2", "MyModelB")]
    setup({ activeLive2dModelId: "m1" })
    expect(screen.getByText("MyModelA")).toBeInTheDocument()
    expect(screen.getByText("MyModelB")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
  })

  it("shows exact compatibility diagnostics and blocks invalid activation", () => {
    modelList = [
      {
        ...model("m1", "Hiyori"),
        compatibility: {
          version: 1,
          status: "invalid",
          diagnostics: [
            { code: "missingReferenced", severity: "error", path: "textures/main.png" },
          ],
          usableMotionGroups: [],
          usableExpressionIds: [],
          usableParameterIds: [],
          resourceCost: { totalBytes: 1000, fileCount: 2, textureBytes: 0 },
        },
      },
    ]
    setup({ activeLive2dModelId: "m1" }, true)

    expect(screen.getByText(/requested skin.*live2d/i)).toBeInTheDocument()
    expect(screen.getByText(/effective skin.*vector mascot/i)).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("textures/main.png")
    expect(screen.getByRole("radio")).toBeDisabled()
  })

  it("sets a model active through onPatch", () => {
    modelList = [model("m1", "MyModelA"), model("m2", "MyModelB")]
    const { onPatch } = setup({ activeLive2dModelId: "m1" })
    const radios = screen.getAllByRole("radio")
    fireEvent.click(radios[1])
    expect(onPatch).toHaveBeenCalledWith({ activeLive2dModelId: "m2" })
  })

  it("deletes a model and clears the active id when it was active", async () => {
    modelList = [model("m1", "Hiyori")]
    const { onPatch } = setup({ activeLive2dModelId: "m1" })
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(deletePetModel).toHaveBeenCalledWith("m1"))
    expect(onPatch).toHaveBeenCalledWith({ activeLive2dModelId: undefined })
  })

  it("imports a model and auto-activates it when none is active", async () => {
    filesToEntries.mockResolvedValue({ ok: true, entries: [{ path: "a", blob: new Blob() }] })
    importModelFromEntries.mockResolvedValue({ ok: true, id: "pm_new" })
    const { onPatch } = setup()
    const input = screen.getByLabelText("Import model") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "model.zip")] } })
    await waitFor(() => expect(importModelFromEntries).toHaveBeenCalled())
    expect(onPatch).toHaveBeenCalledWith({ activeLive2dModelId: "pm_new" })
  })

  it("imports via the folder input", async () => {
    filesToEntries.mockResolvedValue({ ok: true, entries: [{ path: "a", blob: new Blob() }] })
    importModelFromEntries.mockResolvedValue({ ok: true, id: "pm_folder" })
    const { onPatch } = setup()
    const input = screen.getByLabelText("Import folder") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "Hiyori.model3.json")] } })
    await waitFor(() => expect(importModelFromEntries).toHaveBeenCalled())
    expect(onPatch).toHaveBeenCalledWith({ activeLive2dModelId: "pm_folder" })
  })

  it("triggers the hidden inputs when the import buttons are clicked", () => {
    setup()
    const fileInput = screen.getByLabelText("Import model") as HTMLInputElement
    const folderInput = screen.getByLabelText("Import folder") as HTMLInputElement
    const fileClick = jest.spyOn(fileInput, "click")
    const folderClick = jest.spyOn(folderInput, "click")
    fireEvent.click(screen.getByRole("button", { name: /Import model/i }))
    fireEvent.click(screen.getByRole("button", { name: /Import folder/i }))
    expect(fileClick).toHaveBeenCalled()
    expect(folderClick).toHaveBeenCalled()
  })

  it("surfaces an import error in an alert", async () => {
    filesToEntries.mockResolvedValue({ ok: false, code: "zipFailed" })
    setup()
    const input = screen.getByLabelText("Import model") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "bad.zip")] } })
    expect(await screen.findByText(/couldn't be read/i)).toBeInTheDocument()
  })

  it("surfaces a validation error from importModelFromEntries", async () => {
    filesToEntries.mockResolvedValue({ ok: true, entries: [] })
    importModelFromEntries.mockResolvedValue({ ok: false, code: "missingReferenced" })
    setup()
    const input = screen.getByLabelText("Import model") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "model.zip")] } })
    expect(await screen.findByText(/missing files/i)).toBeInTheDocument()
  })

  it("ignores an empty file selection", async () => {
    setup()
    const input = screen.getByLabelText("Import model") as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    await waitFor(() => expect(filesToEntries).not.toHaveBeenCalled())
  })

  it("downloads a sample model", async () => {
    downloadSampleModel.mockResolvedValue({ ok: true, id: "pm_sample" })
    const { onPatch } = setup()
    fireEvent.click(screen.getAllByRole("button", { name: /Download sample/i })[0])
    await waitFor(() => expect(downloadSampleModel).toHaveBeenCalled())
    expect(onPatch).toHaveBeenCalledWith({ activeLive2dModelId: "pm_sample" })
  })

  it("blocks a sample download when offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true })
    setup()
    fireEvent.click(screen.getAllByRole("button", { name: /Download sample/i })[0])
    expect(await screen.findByText(/couldn't be downloaded/i)).toBeInTheDocument()
    expect(downloadSampleModel).not.toHaveBeenCalled()
  })

  it("shows a download error when the fetch fails", async () => {
    downloadSampleModel.mockResolvedValue({ ok: false, code: "downloadFailed" })
    setup()
    fireEvent.click(screen.getAllByRole("button", { name: /Download sample/i })[0])
    expect(await screen.findByText(/couldn't be downloaded/i)).toBeInTheDocument()
  })

  it("renders storage usage", () => {
    usageValue = { models: 2, totalBytes: 2048 }
    modelList = [model("m1", "Hiyori")]
    setup()
    expect(screen.getByText(/2 models/i)).toBeInTheDocument()
  })

  it("does not auto-activate when a model is already active on import", async () => {
    filesToEntries.mockResolvedValue({ ok: true, entries: [] })
    importModelFromEntries.mockResolvedValue({ ok: true, id: "pm_new" })
    const { onPatch } = setup({ activeLive2dModelId: "existing" })
    const input = screen.getByLabelText("Import model") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "model.zip")] } })
    await waitFor(() => expect(importModelFromEntries).toHaveBeenCalled())
    expect(onPatch).not.toHaveBeenCalled()
  })

  it("opens the selection dialog when the bundle holds multiple models", async () => {
    filesToEntries.mockResolvedValue({ ok: true, entries: [{ path: "a", blob: new Blob() }] })
    discoverLive2dModels.mockResolvedValue([discovered("A"), discovered("B"), discovered("C")])
    setup()
    const input = screen.getByLabelText("Import folder") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "A.model3.json")] } })
    await waitFor(() => expect(screen.getByTestId("pet-import-dialog")).toHaveTextContent("3"))
    // The direct single-import path must NOT run for a multi-model bundle.
    expect(importModelFromEntries).not.toHaveBeenCalled()
  })

  it("auto-activates the first model imported through the selection dialog", async () => {
    filesToEntries.mockResolvedValue({ ok: true, entries: [{ path: "a", blob: new Blob() }] })
    discoverLive2dModels.mockResolvedValue([discovered("A"), discovered("B")])
    const { onPatch } = setup()
    const input = screen.getByLabelText("Import folder") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "A.model3.json")] } })
    await waitFor(() => expect(importDialogProps).toHaveBeenCalled())
    const props = importDialogProps.mock.calls.at(-1)![0] as { onImported: (id?: string) => void }
    act(() => props.onImported("pm_first"))
    expect(onPatch).toHaveBeenCalledWith({ activeLive2dModelId: "pm_first" })
  })

  it("surfaces a noSettings error when the bundle has no models", async () => {
    filesToEntries.mockResolvedValue({
      ok: true,
      entries: [{ path: "readme.txt", blob: new Blob() }],
    })
    discoverLive2dModels.mockResolvedValue([])
    setup()
    const input = screen.getByLabelText("Import folder") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "readme.txt")] } })
    expect(await screen.findByText(/No .model3.json/i)).toBeInTheDocument()
    expect(importModelFromEntries).not.toHaveBeenCalled()
  })

  it("opens the per-model config dialog from the Configure button and closes it", () => {
    modelList = [model("m1", "Hiyori"), model("m2", "Haru")]
    setup()
    expect(screen.queryByTestId("pet-config-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("pet-model-configure-m2"))
    expect(screen.getByTestId("pet-config-dialog")).toHaveTextContent("m2")
    // Close through the dialog's onOpenChange.
    const props = configDialogProps.mock.calls.at(-1)![0] as {
      onOpenChange: (open: boolean) => void
    }
    act(() => props.onOpenChange(false))
    expect(screen.queryByTestId("pet-config-dialog")).toBeNull()
  })
})
