import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ projectChunks: {} }) }))
jest.mock("@/lib/project-knowledge/ingest/ingest-file", () => ({ hashKnowledgeFile: () => "hash" }))
const processDocumentAsync = jest.fn()
jest.mock("@cognia/document/document-processor", () => ({
  processDocumentAsync: (...args: unknown[]) => processDocumentAsync(...args),
}))
jest.mock("@cognia/document/support-matrix", () => ({
  getDocumentAcceptString: () => ".txt,.pdf,.docx",
  inferKnowledgeFileTypeFromFilename: (name: string) => (name.endsWith(".pdf") ? "pdf" : "text"),
  isBinaryFilename: (name: string) => name.endsWith(".pdf"),
}))

const runTwinPdfOcrWithProvenance = jest.fn()
jest.mock("@/lib/twin/ingest/ocr-fallback", () => ({
  runTwinPdfOcrWithProvenance: (...args: unknown[]) => runTwinPdfOcrWithProvenance(...args),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const reindexFile = jest.fn()
const reindexProject = jest.fn()
jest.mock("@/lib/project-knowledge/wire-ingest", () => ({
  createProjectKnowledgeIngestController: () => ({
    reindexFile,
    reindexProject,
    reconcile: jest.fn(),
  }),
}))

const addKnowledgeFile = jest.fn()
const removeKnowledgeFile = jest.fn()
const updateProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ addKnowledgeFile, removeKnowledgeFile, updateProject }),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { WorkspaceKnowledgeSection } from "./workspace-knowledge-section"
import type { Project } from "@/types"

const liveQueryMock = useLiveQuery as jest.Mock

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "ws1",
    name: "WS",
    roots: [],
    knowledgeBase: [
      {
        id: "f1",
        name: "guide.md",
        type: "markdown",
        content: "content",
        size: 7,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
    ...overrides,
  } as Project
}

beforeEach(() => {
  addKnowledgeFile.mockClear()
  removeKnowledgeFile.mockClear()
  updateProject.mockClear()
  reindexFile.mockClear()
  reindexProject.mockClear()
  liveQueryMock.mockReset()
  processDocumentAsync.mockReset().mockImplementation(async (_id, _name, data) => ({
    content: typeof data === "string" ? data : "",
    embeddableContent: typeof data === "string" ? data : "extracted binary text",
  }))
  toastError.mockReset()
  runTwinPdfOcrWithProvenance.mockReset().mockResolvedValue(null)
})

describe("WorkspaceKnowledgeSection", () => {
  it("renders each file with an indexed status when the hash matches", () => {
    liveQueryMock.mockReturnValue(new Map([["f1", { count: 2, contentHash: "hash" }]]))
    render(<WorkspaceKnowledgeSection project={project()} />)
    expect(screen.getByText("guide.md")).toBeInTheDocument()
    expect(screen.getByText("indexed")).toBeInTheDocument()
  })

  it("shows outdated when the indexed hash differs from the current content", () => {
    liveQueryMock.mockReturnValue(new Map([["f1", { count: 1, contentHash: "stale" }]]))
    render(<WorkspaceKnowledgeSection project={project()} />)
    expect(screen.getByText("outdated")).toBeInTheDocument()
  })

  it("shows pending when a file has no chunks yet", () => {
    liveQueryMock.mockReturnValue(new Map())
    render(<WorkspaceKnowledgeSection project={project()} />)
    expect(screen.getByText("pending")).toBeInTheDocument()
  })

  it("reindex button triggers a per-file reindex", async () => {
    liveQueryMock.mockReturnValue(new Map([["f1", { count: 1, contentHash: "hash" }]]))
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "reindex" }))
    expect(reindexFile).toHaveBeenCalledWith("ws1", expect.objectContaining({ id: "f1" }))
  })

  /**
   * Removing drops the file's text and every chunk indexed from it, and a
   * pasted note has no copy anywhere else. One stray click must not be enough.
   */
  it("remove asks first, names the file, and removes only on confirm", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "removeFile" }))
    expect(removeKnowledgeFile).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("removeFileDescription:guide.md")
    await user.click(screen.getByRole("button", { name: "confirmRemoveFile" }))
    expect(removeKnowledgeFile).toHaveBeenCalledWith("ws1", "f1")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("cancelling the remove confirmation keeps the file", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "removeFile" }))
    await user.click(await screen.findByRole("button", { name: "cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(removeKnowledgeFile).not.toHaveBeenCalled()
  })

  it("reports a failed per-file reindex", async () => {
    liveQueryMock.mockReturnValue(new Map([["f1", { count: 1, contentHash: "hash" }]]))
    reindexFile.mockRejectedValueOnce(new Error("embedder offline"))
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "reindex" }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("reindexFileFailed:guide.md", {
        description: "embedder offline",
      })
    )
  })

  it("reports a failed reindex-all and stops spinning", async () => {
    liveQueryMock.mockReturnValue(new Map())
    reindexProject.mockRejectedValueOnce(new Error("quota"))
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    const button = screen.getByRole("button", { name: "reindexAll" })
    await user.click(button)
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("reindexAllFailed", { description: "quota" })
    )
    expect(button).toBeEnabled()
  })

  it("reindex-all triggers a project reindex", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "reindexAll" }))
    expect(reindexProject).toHaveBeenCalledTimes(1)
  })

  it("reindex-all spins and refuses a second click until the first run settles", async () => {
    liveQueryMock.mockReturnValue(new Map())
    let finish: () => void = () => {}
    reindexProject.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    const button = screen.getByRole("button", { name: "reindexAll" })
    await user.click(button)
    expect(button).toBeDisabled()
    expect(button.querySelector("svg")).toHaveClass("animate-spin")
    await user.click(button)
    expect(reindexProject).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    expect(button).toBeEnabled()
    expect(button.querySelector("svg")).not.toHaveClass("animate-spin")
  })

  it("adds a pasted note through the store", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.type(screen.getByLabelText("pastePlaceholder"), "some pasted knowledge")
    await user.click(screen.getByRole("button", { name: "pasteText" }))
    expect(addKnowledgeFile).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ type: "text", content: "some pasted knowledge" })
    )
  })

  it("uploads a text file through the store", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    const file = new File(["hello file"], "notes.txt", { type: "text/plain" })
    // jsdom's File does not implement Blob.text() — polyfill on the instance.
    Object.defineProperty(file, "text", { value: async () => "hello file" })
    await user.upload(screen.getByTestId("knowledge-file-input"), file)
    await waitFor(() =>
      expect(addKnowledgeFile).toHaveBeenCalledWith(
        "ws1",
        expect.objectContaining({ name: "notes.txt", type: "text" })
      )
    )
  })

  it("extracts binary document text instead of storing raw file bytes", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    const file = new File(["binary pdf"], "guide.pdf", { type: "application/pdf" })
    const buffer = new TextEncoder().encode("binary pdf").buffer
    Object.defineProperty(file, "arrayBuffer", { value: async () => buffer })

    await user.upload(screen.getByTestId("knowledge-file-input"), file)

    await waitFor(() =>
      expect(addKnowledgeFile).toHaveBeenCalledWith(
        "ws1",
        expect.objectContaining({
          name: "guide.pdf",
          type: "pdf",
          content: "extracted binary text",
          size: file.size,
        })
      )
    )
    expect(processDocumentAsync).toHaveBeenCalledWith(expect.any(String), "guide.pdf", buffer, {
      extractEmbeddable: true,
    })
  })

  it("reports failed file extraction without adding unusable knowledge", async () => {
    liveQueryMock.mockReturnValue(new Map())
    processDocumentAsync.mockRejectedValue(new Error("corrupt document"))
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    const file = new File(["broken"], "guide.pdf", { type: "application/pdf" })
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("broken").buffer,
    })

    await user.upload(screen.getByTestId("knowledge-file-input"), file)

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("importFailed:guide.pdf,corrupt document")
    )
    expect(addKnowledgeFile).not.toHaveBeenCalled()
  })

  it("toggling the enable switch persists the setting", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("switch"))
    expect(updateProject).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({
        knowledgeSettings: expect.objectContaining({ enableProjectRag: false }),
      })
    )
  })
})

it("preserves canonical source text, embedding projection, and structure on upload", async () => {
  liveQueryMock.mockReturnValue(new Map())
  const structure = { version: 1, contentHash: "v", textLength: 19, nodes: [], pages: [] }
  processDocumentAsync.mockResolvedValue({
    content: "# Source\nExact text\n",
    embeddableContent: "Exact text",
    structure,
    metadata: {},
  })
  render(<WorkspaceKnowledgeSection project={project()} />)
  const file = new File(["source"], "guide.txt", { type: "text/plain" })
  Object.defineProperty(file, "text", { value: async () => "source" })
  await userEvent.setup().upload(screen.getByTestId("knowledge-file-input"), file)
  await waitFor(() =>
    expect(addKnowledgeFile).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({
        content: "# Source\nExact text\n",
        embeddableContent: "Exact text",
        structure,
      })
    )
  )
})

it("updates retrieval strategy while preserving other project overrides", async () => {
  liveQueryMock.mockReturnValue(new Map())
  render(
    <WorkspaceKnowledgeSection
      project={project({ knowledgeSettings: { ragTopK: 7, enableProjectRag: false } })}
    />
  )
  await userEvent
    .setup()
    .selectOptions(screen.getByRole("combobox", { name: "retrievalStrategy" }), "hybrid")
  expect(updateProject).toHaveBeenCalledWith("ws1", {
    knowledgeSettings: { ragTopK: 7, enableProjectRag: false, retrievalStrategy: "hybrid" },
  })
})

it("uploads scanned PDFs through the shared OCR route and preserves page ranges", async () => {
  liveQueryMock.mockReturnValue(new Map())
  processDocumentAsync.mockResolvedValue({
    id: "scan",
    type: "pdf",
    content: "",
    embeddableContent: "",
    metadata: { pageCount: 2 },
  })
  const structure = {
    version: 1,
    contentHash: "ocr",
    textLength: 12,
    nodes: [],
    pages: [
      { pageNumber: 2, charStart: 0, charEnd: 12, lineStart: 1, lineEnd: 1, provenance: "ocr" },
    ],
  }
  runTwinPdfOcrWithProvenance.mockResolvedValue({
    originalText: "Exact source",
    embeddableText: "Exact source",
    structure,
  })
  render(<WorkspaceKnowledgeSection project={project()} />)
  const file = new File(["scan"], "scan.pdf", { type: "application/pdf" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) })
  await userEvent.setup().upload(screen.getByTestId("knowledge-file-input"), file)
  await waitFor(() =>
    expect(addKnowledgeFile).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({
        content: "Exact source",
        structure,
        pageCount: 2,
        mimeType: "application/pdf",
      })
    )
  )
  expect(runTwinPdfOcrWithProvenance).toHaveBeenCalledTimes(1)
})

it("threads native digital-page boxes into mixed PDF OCR without recomputing coordinates", async () => {
  liveQueryMock.mockReturnValue(new Map())
  const content = "Digital page body long enough to skip OCR.\n\n"
  const structure = {
    version: 1,
    contentHash: "hash",
    textLength: content.length,
    nodes: [],
    pages: [
      {
        pageNumber: 1,
        charStart: 0,
        charEnd: content.length - 2,
        lineStart: 1,
        lineEnd: 1,
        provenance: "text-layer",
      },
      {
        pageNumber: 2,
        charStart: content.length,
        charEnd: content.length,
        lineStart: 3,
        lineEnd: 3,
        provenance: "text-layer",
      },
    ],
  }
  processDocumentAsync.mockResolvedValue({
    id: "mixed",
    type: "pdf",
    content,
    embeddableContent: content,
    metadata: { pageCount: 2 },
    structure,
    parseResult: {
      text: content,
      pages: [
        {
          pageNumber: 1,
          text: content.slice(0, -2),
          width: 1,
          height: 1,
          items: [{ text: "Digital", x: 1, y: 2, width: 3, height: 4 }],
        },
        { pageNumber: 2, text: "", width: 1, height: 1 },
      ],
    },
  })
  render(<WorkspaceKnowledgeSection project={project()} />)
  const file = new File(["mixed"], "mixed.pdf", { type: "application/pdf" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) })
  await userEvent.setup().upload(screen.getByTestId("knowledge-file-input"), file)
  await waitFor(() => expect(runTwinPdfOcrWithProvenance).toHaveBeenCalled())
  expect(runTwinPdfOcrWithProvenance.mock.calls[0][1].pageMap[0].bboxUnion).toEqual({
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  })
})
