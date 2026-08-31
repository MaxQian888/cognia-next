import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ projectChunks: {} }) }))
jest.mock("@/lib/project-knowledge/ingest/ingest-file", () => ({ hashContent: () => "hash" }))
const processDocumentAsync = jest.fn()
jest.mock("@cognia/document/document-processor", () => ({
  processDocumentAsync: (...args: unknown[]) => processDocumentAsync(...args),
}))
jest.mock("@cognia/document/support-matrix", () => ({
  getDocumentAcceptString: () => ".txt,.pdf,.docx",
  inferKnowledgeFileTypeFromFilename: (name: string) => (name.endsWith(".pdf") ? "pdf" : "text"),
  isBinaryFilename: (name: string) => name.endsWith(".pdf"),
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

  it("remove button removes the file from the store", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "removeFile" }))
    expect(removeKnowledgeFile).toHaveBeenCalledWith("ws1", "f1")
  })

  it("reindex-all triggers a project reindex", async () => {
    liveQueryMock.mockReturnValue(new Map())
    const user = userEvent.setup()
    render(<WorkspaceKnowledgeSection project={project()} />)
    await user.click(screen.getByRole("button", { name: "reindexAll" }))
    expect(reindexProject).toHaveBeenCalledTimes(1)
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

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("importFailed"))
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
