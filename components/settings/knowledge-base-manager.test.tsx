import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockSettingsSave = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
  },
}))
jest.mock("@/stores/settings", () => {
  const { create } = jest.requireActual("zustand")
  return {
    useSettingsStore: create(() => ({
      settings: null,
      save: (...args: unknown[]) => mockSettingsSave(...args),
    })),
  }
})

jest.mock("@/components/rag/retrieval-control-panel", () => ({
  RetrievalControlPanel: ({ corpusPrefixes }: { corpusPrefixes: string[] }) => (
    <div data-testid="retrieval-control-panel">{corpusPrefixes.join(",")}</div>
  ),
}))

const listSourcesMock = jest.fn()
const listJobsMock = jest.fn()
const createSourceMock = jest.fn()
jest.mock("@/lib/db/knowledge-bases", () => ({
  listKnowledgeBaseSources: (...args: unknown[]) => listSourcesMock(...args),
  listKnowledgeBaseIngestJobs: (...args: unknown[]) => listJobsMock(...args),
  createKnowledgeBaseSource: (...args: unknown[]) => createSourceMock(...args),
}))

const depsMock = jest.fn()
jest.mock("@/lib/project-knowledge/runtime/build-deps", () => ({
  tryBuildProjectKnowledgeDeps: (...args: unknown[]) => depsMock(...args),
}))
jest.mock("@/lib/project-knowledge/ingest/ingest-file", () => ({
  hashContent: (value: string) => `hash-${value.length}`,
}))
jest.mock("@/lib/twin/ingest/dispatch", () => ({
  ...jest.requireActual("@/lib/twin/ingest/dispatch"),
  dispatchSource: () => ({ kind: "document" }),
}))

const ingestMock = jest.fn()
const removeMock = jest.fn()
const rebuildMock = jest.fn()
jest.mock("@/lib/knowledge-base/ingest/ingest-source", () => ({
  ingestKnowledgeBaseSource: (...args: unknown[]) => ingestMock(...args),
  removeKnowledgeBaseSource: (...args: unknown[]) => removeMock(...args),
  rebuildKnowledgeBaseIndex: (...args: unknown[]) => rebuildMock(...args),
}))

import { KnowledgeBaseManager } from "./knowledge-base-manager"
import { useSettingsStore } from "@/stores/settings"

const knowledgeBases = [
  { id: "kb-1", name: "Product", createdAt: 1, updatedAt: 1 },
  { id: "kb-2", name: "Support", createdAt: 2, updatedAt: 2 },
]
const deps = { store: {}, embedding: {}, vectorBackend: "native" }

beforeEach(() => {
  mockToastError.mockReset()
  useSettingsStore.setState({
    settings: {
      id: "settings",
      locale: "en",
      knowledgeReading: { summaryProviderId: "existing-provider", totalReadChars: 456_789 },
    } as never,
  })
  mockSettingsSave.mockReset().mockImplementation(async (patch) => {
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } }))
  })
  listSourcesMock.mockReset().mockResolvedValue([])
  listJobsMock.mockReset().mockResolvedValue([])
  createSourceMock.mockReset().mockImplementation(async (draft) => ({
    id: "source-new",
    status: "pending",
    chunkCount: 0,
    createdAt: 3,
    updatedAt: 3,
    ...draft,
  }))
  depsMock.mockReset().mockResolvedValue(deps)
  ingestMock.mockReset().mockResolvedValue({
    jobId: "job-1",
    status: "completed",
    chunkCount: 1,
    tokensUsed: 2,
  })
  removeMock.mockReset().mockResolvedValue(undefined)
  rebuildMock
    .mockReset()
    .mockResolvedValue({ completedSourceIds: ["source-1"], failedSourceIds: [] })
})

it("saves global reading enablement and strategy while preserving other current settings", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByTestId("knowledge-reading-enabled")
  act(() => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        locale: "zh-CN",
        knowledgeReading: { ...state.settings?.knowledgeReading, maxCalls: 77 },
      } as never,
    }))
  })
  fireEvent.click(screen.getByTestId("knowledge-reading-enabled"))
  fireEvent.change(screen.getByTestId("knowledge-reading-strategy"), {
    target: { value: "hybrid" },
  })
  await waitFor(() => expect(mockSettingsSave).toHaveBeenCalledTimes(2))
  expect(useSettingsStore.getState().settings).toMatchObject({
    locale: "zh-CN",
    knowledgeReading: {
      enabled: true,
      retrievalStrategy: "hybrid",
      maxCalls: 77,
      totalReadChars: 456789,
      summaryProviderId: "existing-provider",
    },
  })
  expect(
    mockSettingsSave.mock.calls.every(([patch]) => Object.keys(patch).join() === "knowledgeReading")
  ).toBe(true)
})

it("commits and clamps every numeric reading budget using the shared controls", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  const values = {
    topKPerBase: 9,
    ragTokenBudget: 7000,
    maxCalls: 90,
    maxReadChars: 21000,
    totalReadChars: 120000,
    maxOutlineNodes: 300,
    summaryMaxChars: 900,
  }
  for (const [field, value] of Object.entries(values)) {
    const input = screen.getByTestId(`knowledge-reading-${field}`)
    fireEvent.change(input, { target: { value: String(value) } })
    fireEvent.blur(input)
  }
  await waitFor(() => expect(mockSettingsSave).toHaveBeenCalledTimes(7))
  expect(useSettingsStore.getState().settings?.knowledgeReading).toMatchObject(values)
  const input = screen.getByTestId("knowledge-reading-maxCalls")
  fireEvent.change(input, { target: { value: "99999" } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useSettingsStore.getState().settings?.knowledgeReading?.maxCalls).toBe(1000)
  )
})

it("queues rapid saves and commits an optional summary provider without dropping earlier changes", async () => {
  let release!: () => void
  mockSettingsSave.mockImplementationOnce(async (patch) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } }))
  })
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  fireEvent.click(screen.getByTestId("knowledge-reading-enabled"))
  await waitFor(() => expect(mockSettingsSave).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByTestId("knowledge-reading-strategy"), {
    target: { value: "keyword" },
  })
  const provider = screen.getByTestId("knowledge-reading-summary-provider")
  fireEvent.change(provider, { target: { value: " navigation-provider " } })
  fireEvent.blur(provider)
  expect(mockSettingsSave).toHaveBeenCalledTimes(1)
  await act(async () => release())
  await waitFor(() => expect(mockSettingsSave).toHaveBeenCalledTimes(3))
  expect(useSettingsStore.getState().settings?.knowledgeReading).toMatchObject({
    enabled: true,
    retrievalStrategy: "keyword",
    summaryProviderId: "navigation-provider",
  })
  fireEvent.change(provider, { target: { value: "" } })
  fireEvent.blur(provider)
  await waitFor(() =>
    expect(
      useSettingsStore.getState().settings?.knowledgeReading?.summaryProviderId
    ).toBeUndefined()
  )
})

it("reports a failed settings write and continues queued edits and retries", async () => {
  mockSettingsSave.mockRejectedValueOnce(new Error("storage unavailable"))
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  fireEvent.click(screen.getByTestId("knowledge-reading-enabled"))
  fireEvent.change(screen.getByTestId("knowledge-reading-strategy"), {
    target: { value: "hybrid" },
  })
  await waitFor(() => expect(mockSettingsSave).toHaveBeenCalledTimes(2))
  expect(mockToastError).toHaveBeenCalledWith(expect.any(String))
  expect(useSettingsStore.getState().settings?.knowledgeReading).toMatchObject({
    enabled: false,
    retrievalStrategy: "hybrid",
    totalReadChars: 456_789,
  })
  fireEvent.click(screen.getByTestId("knowledge-reading-enabled"))
  await waitFor(() =>
    expect(useSettingsStore.getState().settings?.knowledgeReading?.enabled).toBe(true)
  )
  expect(mockToastError).toHaveBeenCalledTimes(1)
})

it("wires the selected library into the shared retrieval control plane", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  expect(await screen.findByTestId("retrieval-control-panel")).toHaveTextContent(
    "knowledge_base:kb-1:"
  )
})

it("adds and immediately indexes a manual source in the selected reusable library", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")

  fireEvent.change(screen.getByLabelText("Source title"), {
    target: { value: "Release notes" },
  })
  fireEvent.change(screen.getByLabelText("Source content"), {
    target: { value: "Version 2 ships managed knowledge." },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add text source" }))

  await waitFor(() =>
    expect(createSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-1",
        title: "Release notes",
        content: "Version 2 ships managed knowledge.",
        format: "markdown",
      })
    )
  )
  expect(ingestMock).toHaveBeenCalledWith({ sourceId: "source-new", deps })
})

it("renders durable source/job state and supports retry and vector-aware removal", async () => {
  listSourcesMock.mockResolvedValue([
    {
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "private source",
      bytes: 14,
      fingerprint: "hash",
      status: "failed",
      chunkCount: 4,
      errorCode: "embedding_dimension_mismatch",
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  listJobsMock.mockResolvedValue([
    {
      id: "job-1",
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      status: "running",
      phase: "embedding",
      progress: 65,
      attempts: 1,
      queuedAt: 1,
      updatedAt: 2,
    },
  ])
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)

  expect(await screen.findByText("Guide")).toBeInTheDocument()
  expect(screen.getByText("Embedding · 65%")).toBeInTheDocument()
  expect(screen.getByText(/embedding dimension changed/i)).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "Rebuild index" }))
  await waitFor(() => expect(rebuildMock).toHaveBeenCalledWith("kb-1", deps))

  fireEvent.click(screen.getByRole("button", { name: "Remove source Guide" }))
  await waitFor(() => expect(removeMock).toHaveBeenCalledWith("source-1", deps))
})

it("imports a supported text file with automatic format detection", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")
  const file = new File(["# Setup"], "setup.md", { type: "text/markdown" })
  Object.defineProperty(file, "text", { value: jest.fn(async () => "# Setup") })

  fireEvent.change(screen.getByLabelText("Source file"), { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Import file" }))

  await waitFor(() =>
    expect(createSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-1",
        title: "setup.md",
        content: "# Setup",
        contentEncoding: "utf8",
        format: "markdown",
      })
    )
  )
  expect(ingestMock).toHaveBeenCalledWith({ sourceId: "source-new", deps })
})

it("uses the canonical file-format catalog for extensions and selectable formats", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")

  const fileInput = screen.getByLabelText("Source file")
  expect(fileInput).toHaveAttribute("accept", expect.stringContaining(".txt"))
  expect(fileInput).toHaveAttribute("accept", expect.stringContaining(".yaml"))

  fireEvent.click(screen.getByRole("combobox", { name: "Source format" }))
  expect(screen.queryByRole("option", { name: "Git repo" })).toBeNull()
  fireEvent.keyDown(document, { key: "Escape" })

  const file = new File(["plain note"], "note.txt", { type: "text/plain" })
  Object.defineProperty(file, "text", { value: jest.fn(async () => "plain note") })
  fireEvent.change(fileInput, { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Import file" }))

  await waitFor(() =>
    expect(createSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "note.txt", format: "markdown" })
    )
  )
})

it("keeps a newly added source pending when no indexing backend is configured", async () => {
  depsMock.mockResolvedValue(undefined)
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")
  fireEvent.change(screen.getByLabelText("Source title"), { target: { value: "Offline" } })
  fireEvent.change(screen.getByLabelText("Source content"), { target: { value: "Saved locally" } })
  fireEvent.click(screen.getByRole("button", { name: "Add text source" }))

  await waitFor(() => expect(createSourceMock).toHaveBeenCalled())
  expect(ingestMock).not.toHaveBeenCalled()
})

it("re-indexes a non-dimension failure without clearing the whole library", async () => {
  listSourcesMock.mockResolvedValue([
    {
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "source",
      bytes: 6,
      fingerprint: "hash",
      status: "failed",
      chunkCount: 0,
      errorCode: "embedding_failed",
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)

  fireEvent.click(await screen.findByRole("button", { name: "Re-index" }))

  await waitFor(() => expect(ingestMock).toHaveBeenCalledWith({ sourceId: "source-1", deps }))
  expect(rebuildMock).not.toHaveBeenCalled()
})

it("stores binary document uploads as portable base64", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")
  const file = new File(["pdf"], "guide.pdf", { type: "application/pdf" })
  Object.defineProperty(file, "arrayBuffer", {
    value: jest.fn(async () => new TextEncoder().encode("pdf").buffer),
  })

  fireEvent.change(screen.getByLabelText("Source file"), { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Import file" }))

  await waitFor(() =>
    expect(createSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "guide.pdf",
        content: globalThis.btoa("pdf"),
        contentEncoding: "base64",
        format: "pdf",
      })
    )
  )
})

it("rejects an unknown automatic file format without creating a source", async () => {
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")
  const file = new File(["data"], "archive.unknown")
  fireEvent.change(screen.getByLabelText("Source file"), { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Import file" }))

  await waitFor(() => expect(createSourceMock).not.toHaveBeenCalled())
})

it("renders nothing and avoids database reads when no reusable library exists", async () => {
  const { container } = render(<KnowledgeBaseManager knowledgeBases={[]} />)
  await waitFor(() => expect(container).toBeEmptyDOMElement())
  expect(listSourcesMock).not.toHaveBeenCalled()
  expect(listJobsMock).not.toHaveBeenCalled()
})

it("recovers to an empty source list when durable state cannot be loaded", async () => {
  listSourcesMock.mockRejectedValue(new Error("database unavailable"))
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  expect(
    await screen.findByText("No sources imported into this Knowledge Base.")
  ).toBeInTheDocument()
})

it("recovers from file-read, retry, rebuild, and removal failures", async () => {
  const source = {
    id: "source-1",
    knowledgeBaseId: "kb-1",
    kind: "document",
    format: "markdown",
    title: "Guide",
    content: "source",
    bytes: 6,
    fingerprint: "hash",
    status: "failed",
    chunkCount: 0,
    errorCode: "embedding_dimension_mismatch",
    createdAt: 1,
    updatedAt: 2,
  }
  listSourcesMock.mockResolvedValue([source])
  rebuildMock.mockResolvedValue({ completedSourceIds: [], failedSourceIds: ["source-1"] })
  removeMock.mockRejectedValue("remove failed")
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)

  fireEvent.click(await screen.findByRole("button", { name: "Rebuild index" }))
  await waitFor(() => expect(rebuildMock).toHaveBeenCalled())
  fireEvent.click(screen.getByRole("button", { name: "Remove source Guide" }))
  await waitFor(() => expect(removeMock).toHaveBeenCalled())

  const file = new File(["text"], "broken.md")
  Object.defineProperty(file, "text", {
    value: jest.fn(async () => {
      throw "read failed"
    }),
  })
  fireEvent.change(screen.getByLabelText("Source file"), { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Import file" }))
  await waitFor(() => expect(createSourceMock).not.toHaveBeenCalled())
})

it("recovers when a regular source retry fails", async () => {
  listSourcesMock.mockResolvedValue([
    {
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "source",
      bytes: 6,
      fingerprint: "hash",
      status: "failed",
      chunkCount: 0,
      errorCode: "embedding_failed",
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  ingestMock.mockRejectedValue("retry failed")
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)

  fireEvent.click(await screen.findByRole("button", { name: "Re-index" }))
  await waitFor(() => expect(ingestMock).toHaveBeenCalled())
})

it("supports an explicit importer format and clears a removed library selection", async () => {
  const { rerender } = render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")
  fireEvent.click(screen.getByRole("combobox", { name: "Source format" }))
  fireEvent.click(await screen.findByRole("option", { name: "ChatGPT export" }))
  const file = new File(["{}"], "export.json")
  Object.defineProperty(file, "text", { value: jest.fn(async () => "{}") })
  fireEvent.change(screen.getByLabelText("Source file"), { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Import file" }))
  await waitFor(() =>
    expect(createSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: "chatgpt-export" })
    )
  )

  rerender(<KnowledgeBaseManager knowledgeBases={[knowledgeBases[1]]} />)
  await waitFor(() => expect(listSourcesMock).toHaveBeenLastCalledWith("kb-2"))
})

it("handles cleared file inputs, non-Error create failures, and missing rebuild deps", async () => {
  createSourceMock.mockRejectedValueOnce("create failed")
  const { unmount } = render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  await screen.findByText("No sources imported into this Knowledge Base.")
  fireEvent.change(screen.getByLabelText("Source file"), { target: { files: null } })
  fireEvent.change(screen.getByLabelText("Source title"), { target: { value: "Draft" } })
  fireEvent.change(screen.getByLabelText("Source content"), { target: { value: "Content" } })
  fireEvent.click(screen.getByRole("button", { name: "Add text source" }))
  await waitFor(() => expect(createSourceMock).toHaveBeenCalled())

  listSourcesMock.mockResolvedValue([
    {
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "source",
      bytes: 6,
      fingerprint: "hash",
      status: "failed",
      chunkCount: 0,
      errorCode: "embedding_dimension_mismatch",
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  depsMock.mockResolvedValue(undefined)
  unmount()
  render(<KnowledgeBaseManager knowledgeBases={knowledgeBases} />)
  fireEvent.click(await screen.findByRole("button", { name: "Rebuild index" }))
  await waitFor(() => expect(depsMock).toHaveBeenCalled())
})
