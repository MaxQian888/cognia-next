jest.mock("./download", () => ({ downloadPayloadFor: jest.fn() }))
jest.mock("./upload", () => ({ uploadFileToLibrary: jest.fn() }))
jest.mock("@/stores/artifact/artifact-store", () => {
  const state = {
    canvasDocuments: {} as Record<string, unknown>,
    artifacts: {} as Record<string, unknown>,
    createCanvasDocument: jest.fn(() => "canvas-new"),
  }
  return { useArtifactStore: { getState: () => state } }
})

import { useArtifactStore } from "@/stores/artifact/artifact-store"

import { downloadPayloadFor } from "./download"
import { copyName, duplicateFilesEntry, FilesDuplicateError } from "./duplicate"
import type { FilesEntry } from "./types"
import { uploadFileToLibrary } from "./upload"

const payloadMock = downloadPayloadFor as jest.Mock
const uploadMock = uploadFileToLibrary as jest.Mock
const store = useArtifactStore.getState() as unknown as {
  canvasDocuments: Record<string, unknown>
  artifacts: Record<string, unknown>
  createCanvasDocument: jest.Mock
}

const options = { suffix: " (copy)", fallbackName: "Image" }

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "kind" | "sourceId">): FilesEntry {
  return {
    key: `${overrides.kind}:${overrides.sourceId}`,
    title: "Original",
    sourceTitle: "Original",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  store.canvasDocuments = {}
  store.artifacts = {}
  store.createCanvasDocument.mockReturnValue("canvas-new")
})

describe("copyName", () => {
  it("puts the suffix before a short extension when asked to keep it", () => {
    expect(copyName("notes.md", " (copy)", true)).toBe("notes (copy).md")
    expect(copyName("archive.tar.gz", " (copy)", true)).toBe("archive.tar (copy).gz")
  })

  it("appends the suffix when there is no usable extension", () => {
    expect(copyName("README", " (copy)", true)).toBe("README (copy)")
    expect(copyName(".env", " (copy)", true)).toBe(".env (copy)")
    expect(copyName("file.verylongextension", " (copy)", true)).toBe(
      "file.verylongextension (copy)"
    )
  })

  it("treats an extension of up to seven characters as one", () => {
    expect(copyName("a.1234567", "+", true)).toBe("a+.1234567")
    expect(copyName("a.12345678", "+", true)).toBe("a.12345678+")
  })

  it("always appends for a title", () => {
    expect(copyName("notes.md", " (copy)", false)).toBe("notes.md (copy)")
    expect(copyName("Plan", " (副本)", false)).toBe("Plan (副本)")
  })
})

describe("duplicateFilesEntry", () => {
  it("copies a canvas document into a new user-made canvas document", async () => {
    store.canvasDocuments = {
      c1: { id: "c1", content: "# Plan", language: "markdown", type: "text", title: "Plan" },
    }
    await expect(
      duplicateFilesEntry(entry({ kind: "canvas", sourceId: "c1", title: "Plan" }), options)
    ).resolves.toEqual({ kind: "canvas", id: "canvas-new" })
    expect(store.createCanvasDocument).toHaveBeenCalledWith({
      title: "Plan (copy)",
      content: "# Plan",
      language: "markdown",
      type: "text",
      createdBy: "user",
    })
    expect(payloadMock).not.toHaveBeenCalled()
  })

  it("names the copy after what Files shows", async () => {
    store.canvasDocuments = { c1: { content: "x", language: "python", type: "code" } }
    await duplicateFilesEntry(
      entry({ kind: "canvas", sourceId: "c1", title: "Renamed.py", sourceTitle: "orig.py" }),
      options
    )
    expect(store.createCanvasDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renamed.py (copy)" })
    )
  })

  it("copies a document artifact into a text canvas document", async () => {
    store.artifacts = { a1: { id: "a1", type: "document", content: "Body" } }
    await expect(
      duplicateFilesEntry(entry({ kind: "artifact", sourceId: "a1", title: "Brief" }), options)
    ).resolves.toEqual({ kind: "canvas", id: "canvas-new" })
    expect(store.createCanvasDocument).toHaveBeenCalledWith({
      title: "Brief (copy)",
      content: "Body",
      language: "markdown",
      type: "text",
      createdBy: "user",
    })
  })

  it("copies a code artifact into a code canvas document, keeping its language", async () => {
    store.artifacts = {
      a1: { type: "code", content: "fn main() {}", language: "rust" },
      a2: { type: "html", content: "<p/>" },
    }
    await duplicateFilesEntry(entry({ kind: "artifact", sourceId: "a1", title: "main" }), options)
    expect(store.createCanvasDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "fn main() {}", language: "rust", type: "code" })
    )
    await duplicateFilesEntry(entry({ kind: "artifact", sourceId: "a2", title: "page" }), options)
    expect(store.createCanvasDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "<p/>", language: "plaintext", type: "code" })
    )
  })

  it("reports a missing canvas document or artifact", async () => {
    for (const kind of ["canvas", "artifact"] as const) {
      const error = await duplicateFilesEntry(entry({ kind, sourceId: "gone" }), options).catch(
        (e: unknown) => e
      )
      expect(error).toBeInstanceOf(FilesDuplicateError)
      expect((error as FilesDuplicateError).code).toBe("files_source_missing")
    }
    expect(store.createCanvasDocument).not.toHaveBeenCalled()
  })

  it("copies an image's bytes into a Files-owned file", async () => {
    payloadMock.mockResolvedValue({
      blob: new Blob(["png"], { type: "image/png" }),
      filename: "shot.png",
    })
    uploadMock.mockResolvedValue({ key: "upload:asset-9", kind: "upload", extracted: false })
    const image = entry({ kind: "image", sourceId: "h1", title: "", mediaType: "image/webp" })
    await expect(duplicateFilesEntry(image, { ...options, projectId: "p1" })).resolves.toEqual({
      kind: "upload",
      key: "upload:asset-9",
    })
    expect(payloadMock).toHaveBeenCalledWith(image)
    const [file, uploadOptions] = uploadMock.mock.calls[0] as [File, unknown]
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe("shot (copy).png")
    expect(file.type).toBe("image/png")
    expect(await file.text()).toBe("png")
    expect(uploadOptions).toEqual({ asFile: true, projectId: "p1" })
  })

  it("copies an upload, falling back to the entry's media type, then octet-stream", async () => {
    uploadMock.mockResolvedValue({ key: "upload:asset-2", kind: "upload", extracted: true })
    payloadMock.mockResolvedValueOnce({ blob: new Blob(["%PDF"]), filename: "deck.pdf" })
    await expect(
      duplicateFilesEntry(
        entry({ kind: "session-upload", sourceId: "c1", mediaType: "application/pdf" }),
        options
      )
    ).resolves.toEqual({ kind: "upload", key: "upload:asset-2" })
    const [pdf, uploadOptions] = uploadMock.mock.calls[0] as [File, unknown]
    expect(pdf.name).toBe("deck (copy).pdf")
    expect(pdf.type).toBe("application/pdf")
    expect(uploadOptions).toEqual({ asFile: true })

    payloadMock.mockResolvedValueOnce({ blob: new Blob(["?"]), filename: "LICENSE" })
    await duplicateFilesEntry(entry({ kind: "upload", sourceId: "asset-1" }), options)
    const [license] = uploadMock.mock.calls[1] as [File, unknown]
    expect(license.name).toBe("LICENSE (copy)")
    expect(license.type).toBe("application/octet-stream")
  })

  it("copies a workspace file off the disk into a Files-owned file, leaving the disk alone", async () => {
    payloadMock.mockResolvedValue({
      blob: new Blob(["# Plan"], { type: "text/markdown" }),
      filename: "plan.md",
    })
    uploadMock.mockResolvedValue({ key: "upload:asset-3", kind: "upload", extracted: true })
    const file = entry({
      kind: "workspace-file",
      sourceId: "0123456789abcdef",
      title: "plan.md",
      creator: "ai",
      workspace: {
        sessionId: "s1",
        workspaceRoot: "/repo",
        executionRoot: "/repo",
        relPath: "docs/plan.md",
        change: "created",
      },
    })
    await expect(duplicateFilesEntry(file, options)).resolves.toEqual({
      kind: "upload",
      key: "upload:asset-3",
    })
    expect(payloadMock).toHaveBeenCalledWith(file)
    const [copy] = uploadMock.mock.calls[0] as [File, unknown]
    expect(copy.name).toBe("plan (copy).md")
    expect(copy.type).toBe("text/markdown")

    // Gone from disk: nothing to copy.
    payloadMock.mockResolvedValueOnce(null)
    await expect(duplicateFilesEntry(file, options)).rejects.toMatchObject({
      code: "files_source_missing",
    })
  })

  it("reports a file whose bytes are gone", async () => {
    payloadMock.mockResolvedValue(null)
    const error = await duplicateFilesEntry(
      entry({ kind: "upload", sourceId: "asset-1" }),
      options
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FilesDuplicateError)
    expect((error as FilesDuplicateError).code).toBe("files_source_missing")
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it("propagates an upload failure", async () => {
    payloadMock.mockResolvedValue({ blob: new Blob(["x"]), filename: "a.txt" })
    uploadMock.mockRejectedValue(new Error("quota"))
    await expect(
      duplicateFilesEntry(entry({ kind: "upload", sourceId: "asset-1" }), options)
    ).rejects.toThrow("quota")
  })
})
