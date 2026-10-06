import { buildTextDocumentStructure } from "@cognia/document/document-structure"
import {
  clearKnowledgeReaderForSession,
  registerKnowledgeReaderForSession,
} from "@/lib/knowledge-base/runtime/session-reader"
import {
  buildKnowledgeManifestEntries,
  isKnowledgeBuiltinTool,
  runKnowledgeBuiltinTool,
} from "./knowledge-builtin-tools"

afterEach(() => clearKnowledgeReaderForSession("session"))
it("declares read-only bounded tools and refuses unbound or invalid requests", async () => {
  expect(buildKnowledgeManifestEntries()).toHaveLength(4)
  expect(isKnowledgeBuiltinTool("knowledge_read_original")).toBe(true)
  expect(
    await runKnowledgeBuiltinTool(
      "knowledge_read_original",
      { knowledgeBaseId: "kb", sourceId: "s" },
      { sessionId: "session" }
    )
  ).toMatchObject({ code: "knowledge_scope_unavailable" })
  expect(
    await runKnowledgeBuiltinTool(
      "knowledge_list_documents",
      { knowledgeBaseIds: ["other"] },
      { sessionId: "session" }
    )
  ).toMatchObject({ code: "invalid_arguments" })
})
it("routes actual host original reads, preserves source locators and cumulative budgets", async () => {
  const text = "# Test\nOriginal code"
  const source = { id: "s", knowledgeBaseId: "kb", title: "Test", format: "markdown" } as never
  registerKnowledgeReaderForSession("session", {
    knowledgeBaseIds: ["kb"],
    settings: { enabled: true, totalReadChars: 8 },
    deps: {
      listSources: async () => [source],
      getSources: async () => [source],
      getSnapshot: async () => ({
        generationId: "g",
        contentHash: "hash",
        originalText: text,
        title: "Test",
        format: "markdown",
        createdAt: 1,
        structure: buildTextDocumentStructure(text),
      }),
    },
  })
  expect(
    await runKnowledgeBuiltinTool(
      "knowledge_read_original",
      { knowledgeBaseId: "kb", sourceId: "s" },
      { sessionId: "session" }
    )
  ).toMatchObject({ ok: true, text: text.slice(0, 8), charStart: 0, charEnd: 8, generationId: "g" })
  expect(
    await runKnowledgeBuiltinTool(
      "knowledge_read_original",
      { knowledgeBaseId: "kb", sourceId: "s" },
      { sessionId: "session" }
    )
  ).toMatchObject({ ok: false, code: "read_budget_exhausted" })
})
