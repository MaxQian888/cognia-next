import {
  deriveModelName,
  filesToEntries,
  importModelFromEntries,
  downloadSampleModel,
} from "./pet-model-import"
import type { SampleModelEntry } from "@/lib/pet/live2d/constants"

const extractModelZip = jest.fn()
jest.mock("@/lib/pet/live2d/zip", () => ({
  extractModelZip: (...a: unknown[]) => extractModelZip(...a),
}))

const validateLive2dImport = jest.fn()
jest.mock("@/lib/pet/live2d/import-validate", () => ({
  validateLive2dImport: (...a: unknown[]) => validateLive2dImport(...a),
}))

const addPetModel = jest.fn()
jest.mock("@/lib/db/pet-models", () => ({
  addPetModel: (...a: unknown[]) => addPetModel(...a),
}))

function file(name: string, relPath?: string): File {
  const f = new File(["x"], name)
  if (relPath) Object.defineProperty(f, "webkitRelativePath", { value: relPath })
  return f
}

const validModel = {
  manifest: {
    kind: "modern" as const,
    settingsPath: "Hiyori.model3.json",
    mocPath: "Hiyori.moc3",
    texturePaths: [],
    motionGroups: ["Idle"],
    expressionIds: ["happy"],
  },
  entries: [{ path: "Hiyori.model3.json", blob: new Blob(["{}"]) }],
  totalBytes: 100,
}

beforeEach(() => {
  jest.clearAllMocks()
  addPetModel.mockResolvedValue({ id: "pm_1" })
})

describe("deriveModelName", () => {
  it("strips the model3.json suffix and any directory", () => {
    expect(deriveModelName("models/Hiyori.model3.json")).toBe("Hiyori")
    expect(deriveModelName("Haru.model.json")).toBe("Haru")
  })
})

describe("filesToEntries", () => {
  it("extracts a single .zip via jszip", async () => {
    extractModelZip.mockResolvedValue({ ok: true, entries: [{ path: "a.moc3", blob: new Blob() }] })
    const result = await filesToEntries([file("model.zip")])
    expect(result).toEqual({ ok: true, entries: [{ path: "a.moc3", blob: expect.any(Blob) }] })
  })

  it("returns zipFailed when extraction fails", async () => {
    extractModelZip.mockResolvedValue({ ok: false, code: "zipFailed" })
    const result = await filesToEntries([file("broken.zip")])
    expect(result).toEqual({ ok: false, code: "zipFailed" })
  })

  it("passes a size refusal through instead of calling it unreadable", async () => {
    // Collapsing every failure to zipFailed sent a user whose archive was
    // merely too big looking for a corrupt file.
    extractModelZip.mockResolvedValue({ ok: false, code: "tooLarge" })
    const result = await filesToEntries([file("huge.zip")])
    expect(result).toEqual({ ok: false, code: "tooLarge" })
  })

  it("maps folder files using webkitRelativePath", async () => {
    const result = await filesToEntries([file("Hiyori.model3.json", "Hiyori/Hiyori.model3.json")])
    expect(result).toEqual({
      ok: true,
      entries: [{ path: "Hiyori/Hiyori.model3.json", blob: expect.any(File) }],
    })
  })

  it("falls back to file name when no webkitRelativePath", async () => {
    const result = await filesToEntries([file("a.moc3"), file("b.png")])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entries.map((e) => e.path)).toEqual(["a.moc3", "b.png"])
  })
})

describe("importModelFromEntries", () => {
  it("persists a model on valid input", async () => {
    validateLive2dImport.mockResolvedValue({ ok: true, model: validModel })
    const result = await importModelFromEntries(validModel.entries, { source: "import" })
    expect(result).toEqual({ ok: true, id: "pm_1" })
    expect(addPetModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Hiyori", source: "import", motionGroups: ["Idle"] }),
      expect.any(Array)
    )
  })

  it("returns the validation error code on invalid input", async () => {
    validateLive2dImport.mockResolvedValue({ ok: false, code: "missingReferenced" })
    const result = await importModelFromEntries([], { source: "import" })
    expect(result).toEqual({ ok: false, code: "missingReferenced" })
    expect(addPetModel).not.toHaveBeenCalled()
  })
})

describe("downloadSampleModel", () => {
  const entry: SampleModelEntry = {
    id: "hiyori",
    name: "Hiyori",
    baseUrl: "https://example.com/Hiyori/",
    settingsFile: "Hiyori.model3.json",
    files: ["Hiyori.model3.json", "Hiyori.moc3"],
  }

  it("fetches every file, validates, and persists", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) })
    validateLive2dImport.mockResolvedValue({ ok: true, model: validModel })
    const result = await downloadSampleModel(entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ ok: true, id: "pm_1" })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(addPetModel).toHaveBeenCalledWith(
      expect.objectContaining({ source: "sample", sampleId: "hiyori" }),
      expect.any(Array)
    )
  })

  it("returns downloadFailed on a non-ok response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    const result = await downloadSampleModel(entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ ok: false, code: "downloadFailed" })
  })

  it("returns downloadFailed when fetch rejects", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("offline"))
    const result = await downloadSampleModel(entry, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ ok: false, code: "downloadFailed" })
  })

  it("uses the global fetch when no fetchImpl is injected", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) }) as jest.Mock
    validateLive2dImport.mockResolvedValue({ ok: true, model: validModel })
    const result = await downloadSampleModel(entry)
    expect(result).toEqual({ ok: true, id: "pm_1" })
    expect(global.fetch).toHaveBeenCalled()
  })
})
