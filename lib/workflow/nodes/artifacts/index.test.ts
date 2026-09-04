import type { StepExecutionContext } from "@/types/workflow/visual"

const runArtifactBuiltinTool = jest.fn()
jest.mock("@/lib/claude/artifact-builtin-tools", () => ({
  ARTIFACT_CREATE_TOOL_NAME: "artifact_create",
  ARTIFACT_UPDATE_TOOL_NAME: "artifact_update",
  CANVAS_CREATE_TOOL_NAME: "canvas_create",
  resolveArtifactToolDeps: () => ({ store: {}, activeSessionId: null }),
  runArtifactBuiltinTool: (...args: unknown[]) => runArtifactBuiltinTool(...args),
}))

const renderArtifactExport = jest.fn()
jest.mock("@/lib/artifacts/export", () => ({
  renderArtifactExport: (...args: unknown[]) => renderArtifactExport(...args),
}))

let exportFormats: string[] = ["raw", "png", "pdf"]
jest.mock("@/components/artifacts/runtime-adapters", () => ({
  getArtifactExportFormats: () => exportFormats,
}))

interface StoreState {
  artifacts: Record<string, unknown>
  canvasDocuments: Record<string, unknown>
  getArtifact: (id: string) => unknown
  getArtifactsForWorkspace: () => unknown[]
  getCanvasDocumentsForWorkspace: (options?: { sessionId?: string | null }) => unknown[]
}
// Annotated: `getArtifact` reads `storeState` from inside its own initializer,
// which leaves TypeScript with no way to infer the shape (TS7022).
const storeState: StoreState = {
  artifacts: {},
  canvasDocuments: {},
  getArtifact: (id: string) => storeState.artifacts[id],
  getArtifactsForWorkspace: jest.fn(() => Object.values(storeState.artifacts)),
  // Mirrors the real selector: workspace scope first, then the session narrow.
  getCanvasDocumentsForWorkspace: jest.fn(({ sessionId = null } = {}) =>
    (Object.values(storeState.canvasDocuments) as Array<{ sessionId?: string }>).filter(
      (doc) => !sessionId || !doc.sessionId || doc.sessionId === sessionId
    )
  ),
}
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => storeState },
}))

import "./index"
import { getExecutor } from "../registry"

function run(kind: string, params: Record<string, unknown>) {
  const registered = getExecutor(kind as never, 1)
  if (!registered) throw new Error(`no executor for ${kind}`)
  return registered.execute({ params } as unknown as StepExecutionContext)
}

const ARTIFACT = {
  id: "art_1",
  sessionId: "s_1",
  messageId: "m_1",
  type: "chart",
  title: "Revenue",
  content: "x".repeat(20_000),
  language: "json",
  version: 2,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
}

const CANVAS_DOC = {
  id: "doc_1",
  sessionId: "s_1",
  title: "Notes",
  content: "y".repeat(20_000),
  language: "markdown",
  type: "text",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
}

beforeEach(() => {
  jest.clearAllMocks()
  storeState.artifacts = {}
  storeState.canvasDocuments = {}
  exportFormats = ["raw", "png", "pdf"]
  runArtifactBuiltinTool.mockResolvedValue({ ok: true, artifactId: "art_1", title: "Revenue" })
})

describe("action.artifact.create", () => {
  it("routes through the same runner the model's tool uses", async () => {
    const result = await run("action.artifact.create", {
      title: "Revenue",
      type: "chart",
      content: "{}",
      chartType: "bar",
      sessionId: "s_1",
    })

    expect(runArtifactBuiltinTool).toHaveBeenCalledWith(
      "artifact_create",
      expect.objectContaining({ title: "Revenue", type: "chart", chartType: "bar" }),
      expect.anything(),
      expect.objectContaining({ sessionId: "s_1" })
    )
    expect(result.output).toMatchObject({ artifactId: "art_1" })
  })

  it("binds to no conversation when the flow has none", async () => {
    // A schedule or webhook has no session. An empty id keeps the row out of
    // whichever conversation happened to be open.
    await run("action.artifact.create", { title: "T", type: "code", content: "x" })
    expect(runArtifactBuiltinTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ sessionId: "" })
    )
  })

  it("rejects a missing title before calling the runner", async () => {
    await expect(run("action.artifact.create", { type: "code", content: "x" })).rejects.toThrow(
      /title is required/
    )
    expect(runArtifactBuiltinTool).not.toHaveBeenCalled()
  })

  it("throws on a structured tool failure instead of reporting success", async () => {
    // The runner never throws — `{ok:false}` is something a MODEL can act on.
    // A step has the opposite contract: retry, error output and the failure
    // branch all key off a rejection.
    runArtifactBuiltinTool.mockResolvedValue({
      ok: false,
      code: "invalid_arguments",
      error: "type must be one of …",
    })
    await expect(
      run("action.artifact.create", { title: "T", type: "nope", content: "x" })
    ).rejects.toThrow(/type must be one of … \(invalid_arguments\)/)
  })

  it("is not retryable, because a retry mints a second artifact", () => {
    expect(getExecutor("action.artifact.create" as never, 1)?.retryable).toBe(false)
  })
})

describe("action.artifact.update", () => {
  it("passes the review verdict through so a flow can branch on it", async () => {
    // With "Review before apply" on, the artifact is UNCHANGED and a diff is
    // waiting for the user. A flow that treated this as applied would publish
    // the old content.
    runArtifactBuiltinTool.mockResolvedValue({ ok: true, artifactId: "art_1", staged: "review" })
    const result = await run("action.artifact.update", { artifactId: "art_1", content: "new" })
    expect(result.output).toMatchObject({ staged: "review" })
  })

  it("uses a stable review request id so a re-run does not open a second diff", async () => {
    await run("action.artifact.update", { artifactId: "art_1", content: "new" })
    await run("action.artifact.update", { artifactId: "art_1", content: "new" })
    const [first, second] = runArtifactBuiltinTool.mock.calls
    expect(first[3].messageId).toBe(second[3].messageId)
  })

  it("is retryable, unlike create", () => {
    expect(getExecutor("action.artifact.update" as never, 1)?.retryable).toBe(true)
  })
})

describe("action.artifact.get", () => {
  it("returns the whole artifact, not the model's 8 KB excerpt", async () => {
    // `artifact_read` truncates because its consumer is a context window. A
    // `get → write to file` step that silently lost everything past 8 KB would
    // be worse than no node at all.
    storeState.artifacts = { art_1: ARTIFACT }
    const result = await run("action.artifact.get", { artifactId: "art_1" })
    expect((result.output as { content: string }).content).toHaveLength(20_000)
    expect(runArtifactBuiltinTool).not.toHaveBeenCalled()
  })

  it("lists and filters by title when no id is given", async () => {
    storeState.artifacts = {
      art_1: ARTIFACT,
      art_2: { ...ARTIFACT, id: "art_2", title: "Costs" },
    }
    const result = await run("action.artifact.get", { query: "reven" })
    expect((result.output as { artifacts: Array<{ artifactId: string }> }).artifacts).toEqual([
      expect.objectContaining({ artifactId: "art_1" }),
    ])
  })

  it("fails loudly on an id that does not resolve", async () => {
    await expect(run("action.artifact.get", { artifactId: "ghost" })).rejects.toThrow(
      /no artifact with id ghost/
    )
  })
})

describe("action.artifact.export", () => {
  it("returns text formats inline", async () => {
    storeState.artifacts = { art_1: { ...ARTIFACT, content: "hello" } }
    renderArtifactExport.mockResolvedValue({
      data: "hello",
      mimeType: "text/plain;charset=utf-8",
      filename: "Revenue.json",
    })
    const result = await run("action.artifact.export", { artifactId: "art_1", format: "raw" })
    expect(result.output).toMatchObject({
      encoding: "utf-8",
      content: "hello",
      filename: "Revenue.json",
      byteLength: 5,
    })
  })

  it("base64-encodes a rendered blob for a later step to write or send", async () => {
    storeState.artifacts = { art_1: ARTIFACT }
    renderArtifactExport.mockResolvedValue({
      data: {
        arrayBuffer: async () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer,
      },
      mimeType: "image/png",
      filename: "Revenue.png",
    })
    const result = await run("action.artifact.export", { artifactId: "art_1", format: "png" })
    expect(result.output).toMatchObject({
      encoding: "base64",
      content: "3q2+7w==",
      mimeType: "image/png",
      byteLength: 4,
    })
  })

  it("names the formats this artifact actually offers when refusing", async () => {
    storeState.artifacts = { art_1: ARTIFACT }
    exportFormats = ["raw"]
    await expect(
      run("action.artifact.export", { artifactId: "art_1", format: "png" })
    ).rejects.toThrow(/cannot be exported as png \(offers raw\)/)
    expect(renderArtifactExport).not.toHaveBeenCalled()
  })

  it("defaults to the source text rather than a render", async () => {
    storeState.artifacts = { art_1: ARTIFACT }
    renderArtifactExport.mockResolvedValue({ data: "x", mimeType: "text/plain", filename: "a.txt" })
    await run("action.artifact.export", { artifactId: "art_1" })
    expect(renderArtifactExport).toHaveBeenCalledWith(expect.anything(), "raw")
  })
})

describe("action.canvas.create", () => {
  it("routes through the canvas tool", async () => {
    runArtifactBuiltinTool.mockResolvedValue({ ok: true, documentId: "doc_1" })
    const result = await run("action.canvas.create", {
      title: "Notes",
      language: "markdown",
      type: "text",
    })
    expect(runArtifactBuiltinTool).toHaveBeenCalledWith(
      "canvas_create",
      expect.objectContaining({ title: "Notes", language: "markdown", type: "text" }),
      expect.anything(),
      expect.anything()
    )
    expect(result.output).toMatchObject({ documentId: "doc_1" })
  })

  it("requires a language, which selects the editor's syntax mode", async () => {
    await expect(run("action.canvas.create", { title: "Notes" })).rejects.toThrow(
      /language is required/
    )
  })

  it("falls back to a code document for any unrecognised type", async () => {
    runArtifactBuiltinTool.mockResolvedValue({ ok: true, documentId: "doc_1" })
    await run("action.canvas.create", { title: "N", language: "ts", type: "spreadsheet" })
    expect(runArtifactBuiltinTool.mock.calls[0][1]).toMatchObject({ type: "code" })
  })
})

describe("action.canvas.get", () => {
  it("returns the whole document", async () => {
    storeState.canvasDocuments = { doc_1: CANVAS_DOC }
    const result = await run("action.canvas.get", { documentId: "doc_1" })
    expect((result.output as { content: string }).content).toHaveLength(20_000)
  })

  it("lists the conversation's documents when no id is given", async () => {
    storeState.canvasDocuments = {
      doc_1: CANVAS_DOC,
      doc_2: { ...CANVAS_DOC, id: "doc_2", sessionId: "other" },
    }
    const result = await run("action.canvas.get", { sessionId: "s_1" })
    expect((result.output as { documents: Array<{ documentId: string }> }).documents).toEqual([
      expect.objectContaining({ documentId: "doc_1" }),
    ])
  })

  it("fails loudly on an id that does not resolve", async () => {
    await expect(run("action.canvas.get", { documentId: "ghost" })).rejects.toThrow(
      /no canvas document with id ghost/
    )
  })
})

describe("the family's boundaries", () => {
  it("publishes exactly six kinds — no delete, no canvas update, no canvas open", () => {
    // Deleting a user's saved output unattended is a consent problem; writing
    // into an open Canvas buffer fights `editorRef.current.getValue()`; and
    // revealing a panel means nothing in a headless run.
    for (const kind of [
      "action.artifact.create",
      "action.artifact.update",
      "action.artifact.get",
      "action.artifact.export",
      "action.canvas.create",
      "action.canvas.get",
    ]) {
      expect(getExecutor(kind as never, 1)).toBeDefined()
    }
    for (const kind of ["action.artifact.delete", "action.canvas.update", "action.canvas.open"]) {
      expect(getExecutor(kind as never, 1)).toBeUndefined()
    }
  })
})
