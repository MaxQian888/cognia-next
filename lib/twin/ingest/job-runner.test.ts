/**
 * Tests for the ingest job runner's pageMap threading.
 *
 * Pipeline-shape coverage: redact + chunk run REAL so the
 * embeddable-space → redacted-space translation and the chunk stamping are
 * exercised end-to-end; parse / OCR / embed / persist / Dexie are mocked.
 */

jest.mock("@/lib/db/twin-sources", () => ({
  createTwinSource: jest.fn(),
  getTwinSource: jest.fn(),
  updateTwinSource: jest.fn(),
}))
jest.mock("@/lib/db/twin-profile", () => ({
  ensureTwinProfile: jest.fn(),
  setTwinProfile: jest.fn(),
}))
jest.mock("@/lib/db/twin-jobs", () => ({
  updateJobProgress: jest.fn(),
}))
jest.mock("./parse", () => ({
  parseSource: jest.fn(),
}))
jest.mock("./ocr-fallback", () => ({
  runTwinPdfOcr: jest.fn(),
}))
jest.mock("./embed", () => ({
  embedRedactedChunks: jest.fn(),
}))
jest.mock("./persist", () => ({
  persistChunks: jest.fn(),
  vectorCollectionName: (twinId: string) => `cognia_twin_${twinId}`,
}))
// Real AES round-trip is covered by redaction-key.test.ts; here we assert the
// job runner *wires* the encrypted map onto the source row (the shipped bug was
// that it never did), so a deterministic stub keeps this a pure unit.
jest.mock("./redaction-key", () => ({
  encryptRedactionMap: jest.fn(async (map: Record<string, unknown>) =>
    Object.keys(map).length > 0 ? `enc:${Object.keys(map).length}` : ""
  ),
}))

import { getTwinSource, updateTwinSource } from "@/lib/db/twin-sources"
import { ensureTwinProfile } from "@/lib/db/twin-profile"
import { updateJobProgress } from "@/lib/db/twin-jobs"
import type { IVectorStore } from "@cognia/vector/store"
import type { TwinJob, TwinSource } from "@/types/twin"
import { embedRedactedChunks, type EmbeddingConfig } from "./embed"
import { deriveNameHints, runIngestJob } from "./job-runner"
import { runTwinPdfOcr } from "./ocr-fallback"
import { parseSource, type ParsedSource, type RawSource } from "./parse"
import { persistChunks } from "./persist"
import { encryptRedactionMap } from "./redaction-key"

const mockEncryptRedactionMap = encryptRedactionMap as jest.MockedFunction<
  typeof encryptRedactionMap
>

const mockGetTwinSource = getTwinSource as jest.MockedFunction<typeof getTwinSource>
const mockUpdateTwinSource = updateTwinSource as jest.MockedFunction<typeof updateTwinSource>
const mockEnsureTwinProfile = ensureTwinProfile as jest.MockedFunction<typeof ensureTwinProfile>
const mockUpdateJobProgress = updateJobProgress as jest.MockedFunction<typeof updateJobProgress>
const mockParseSource = parseSource as jest.MockedFunction<typeof parseSource>
const mockRunTwinPdfOcr = runTwinPdfOcr as jest.MockedFunction<typeof runTwinPdfOcr>
const mockEmbed = embedRedactedChunks as jest.MockedFunction<typeof embedRedactedChunks>
const mockPersist = persistChunks as jest.MockedFunction<typeof persistChunks>

const PAGE_ONE = "First page paragraph body without any sensitive data."
const PAGE_TWO = "Second page paragraph carries the closing remarks."
const EMBEDDABLE = `${PAGE_ONE}\n\n${PAGE_TWO}`
const BOX = { x: 5, y: 6, width: 70, height: 80 }

function sourceRow(): TwinSource {
  return {
    id: "src1",
    twinId: "twin1",
    kind: "document",
    format: "pdf",
    source: "doc.pdf",
    title: "doc.pdf",
    bytes: 3,
    fingerprint: "fp",
    redacted: false,
    status: "parsing",
    createdAt: 0,
  } as unknown as TwinSource
}

function parsedSource(): ParsedSource {
  return {
    id: "src1",
    kind: "document",
    format: "pdf",
    title: "doc.pdf",
    originalText: EMBEDDABLE,
    embeddableText: EMBEDDABLE,
    baseMetadata: {},
    bytes: EMBEDDABLE.length,
    pageMap: [
      { pageNumber: 1, charStart: 0, charEnd: PAGE_ONE.length, bboxUnion: BOX },
      { pageNumber: 2, charStart: PAGE_ONE.length + 2, charEnd: EMBEDDABLE.length },
    ],
  }
}

function rawSource(): RawSource {
  return { id: "src1", filename: "doc.pdf", format: "pdf", binary: new Uint8Array([1, 2, 3]) }
}

function runInput() {
  return {
    job: { id: "job1", twinId: "twin1", sourceIds: ["src1"] } as unknown as TwinJob,
    rawSources: [rawSource()],
    embedding: {} as EmbeddingConfig,
    vectorBackend: "native" as const,
    store: {} as IVectorStore,
  }
}

describe("runIngestJob — pageMap threading", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetTwinSource.mockResolvedValue(sourceRow())
    mockUpdateTwinSource.mockResolvedValue(undefined as never)
    mockEnsureTwinProfile.mockResolvedValue({} as never)
    mockUpdateJobProgress.mockResolvedValue(undefined as never)
    mockParseSource.mockResolvedValue(parsedSource())
    mockRunTwinPdfOcr.mockResolvedValue(null)
    mockEmbed.mockImplementation(async (texts: string[]) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
      tokensUsed: texts.length,
    }))
    mockPersist.mockImplementation(async (input) => ({
      rows: input.chunks.map((_, i) => ({ id: `c${i}` })) as never,
      vectorDocIds: [],
    }))
  })

  it("threads the pageMap through redaction into chunk metadata", async () => {
    const result = await runIngestJob(runInput())

    expect(result.totalChunks).toBeGreaterThan(0)
    const persisted = mockPersist.mock.calls[0][0]
    const stamped = persisted.chunks.filter((c) => c.metadata.pageNumber !== undefined)
    expect(stamped.length).toBeGreaterThan(0)
    // The first chunk starts on page 1 and carries the page's bbox union.
    expect(persisted.chunks[0].metadata.pageNumber).toBe(1)
    expect(persisted.chunks[0].metadata.bboxUnion).toEqual(BOX)
    // Every stamped page number comes from the supplied map.
    for (const chunk of stamped) {
      expect([1, 2]).toContain(chunk.metadata.pageNumber)
    }
  })

  it("drops the pageMap when the OCR fallback replaced the text", async () => {
    mockRunTwinPdfOcr.mockResolvedValue("OCR REPLACEMENT TEXT FROM THE SCANNED DOCUMENT")

    const result = await runIngestJob(runInput())

    expect(result.totalChunks).toBeGreaterThan(0)
    const persisted = mockPersist.mock.calls[0][0]
    for (const chunk of persisted.chunks) {
      expect(chunk.metadata.pageNumber).toBeUndefined()
      expect(chunk.metadata.bboxUnion).toBeUndefined()
    }
  })

  it("leaves non-spatial sources untouched (no pageMap on the parse)", async () => {
    mockParseSource.mockResolvedValue({ ...parsedSource(), pageMap: undefined })

    await runIngestJob(runInput())

    const persisted = mockPersist.mock.calls[0][0]
    for (const chunk of persisted.chunks) {
      expect(chunk.metadata.pageNumber).toBeUndefined()
    }
  })
})

describe("deriveNameHints", () => {
  function raw(speakers?: string[]): RawSource {
    return {
      id: "s",
      filename: "chat.md",
      format: "markdown",
      ...(speakers ? { baseMetadata: { speakers } } : {}),
    }
  }

  it("surfaces human chat speakers as hints", () => {
    expect(deriveNameHints(raw(["张伟", "John Doe"]))).toEqual(["张伟", "John Doe"])
  })

  it("drops generic assistant/role labels (case-insensitive)", () => {
    expect(deriveNameHints(raw(["User", "ChatGPT", "system", "Tool", "Alice"]))).toEqual(["Alice"])
  })

  it("reduces email-style speakers to the display name", () => {
    expect(deriveNameHints(raw(['"Alice Smith" <alice@example.com>', "Bob <bob@x.com>"]))).toEqual([
      "Alice Smith",
      "Bob",
    ])
  })

  it("merges job-level hints, de-dupes, and ignores blank/1-char speakers", () => {
    expect(deriveNameHints(raw(["Alice", "  ", "X", "Alice"]), ["Carol", "Alice"])).toEqual([
      "Carol",
      "Alice",
    ])
  })

  it("returns job hints only when there is no metadata", () => {
    expect(deriveNameHints(raw(), ["Dave"])).toEqual(["Dave"])
    expect(deriveNameHints(raw())).toEqual([])
  })
})

describe("runIngestJob — name redaction (PII)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetTwinSource.mockResolvedValue(sourceRow())
    mockUpdateTwinSource.mockResolvedValue(undefined as never)
    mockEnsureTwinProfile.mockResolvedValue({} as never)
    mockUpdateJobProgress.mockResolvedValue(undefined as never)
    mockRunTwinPdfOcr.mockResolvedValue(null)
    mockEmbed.mockImplementation(async (texts: string[]) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
      tokensUsed: texts.length,
    }))
    mockPersist.mockImplementation(async (input) => ({
      rows: input.chunks.map((_, i) => ({ id: `c${i}` })) as never,
      vectorDocIds: [],
    }))
  })

  it("redacts a chat speaker's name before it reaches the embedder", async () => {
    // Regression for the shipped PII leak: the worker never passed nameHints, so
    // participant names flowed verbatim to the cloud embedder + distill LLM.
    const body = "### 张伟\nLet's ship the release on Friday, 张伟 said."
    mockParseSource.mockResolvedValue({
      ...parsedSource(),
      originalText: body,
      embeddableText: body,
      pageMap: undefined,
    })

    await runIngestJob({
      ...runInput(),
      rawSources: [{ ...rawSource(), baseMetadata: { speakers: ["张伟"] } }],
    })

    // The text handed to the embedder must not contain the raw name.
    const embedded = (mockEmbed.mock.calls[0][0] as string[]).join("\n")
    expect(embedded).not.toContain("张伟")
    expect(embedded).toContain("<NAME_")
  })
})

describe("runIngestJob — redaction map persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetTwinSource.mockResolvedValue(sourceRow())
    mockUpdateTwinSource.mockResolvedValue(undefined as never)
    mockEnsureTwinProfile.mockResolvedValue({} as never)
    mockUpdateJobProgress.mockResolvedValue(undefined as never)
    mockRunTwinPdfOcr.mockResolvedValue(null)
    mockEmbed.mockImplementation(async (texts: string[]) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
      tokensUsed: texts.length,
    }))
    mockPersist.mockImplementation(async (input) => ({
      rows: input.chunks.map((_, i) => ({ id: `c${i}` })) as never,
      vectorDocIds: [],
    }))
  })

  function redactionMapEncFromCalls(): string | undefined {
    for (const [, patch] of mockUpdateTwinSource.mock.calls) {
      const enc = (patch as { redactionMapEnc?: string }).redactionMapEnc
      if (typeof enc === "string") return enc
    }
    return undefined
  }

  it("encrypts the redaction map and stores it on the source when PII is present", async () => {
    // Regression: before the fix the map was computed-and-discarded, so the
    // workbench's unredact flow always read an empty blob. Email is redacted by
    // a built-in pattern (no nameHints needed) → a non-empty map.
    const withPii = "Email alice@example.com or bob@example.org about the report."
    mockParseSource.mockResolvedValue({
      ...parsedSource(),
      originalText: withPii,
      embeddableText: withPii,
      pageMap: undefined,
    })

    await runIngestJob(runInput())

    // Encrypt was called with the (non-empty) real redaction map.
    expect(mockEncryptRedactionMap).toHaveBeenCalledTimes(1)
    const passedMap = mockEncryptRedactionMap.mock.calls[0][0]
    expect(Object.keys(passedMap).length).toBeGreaterThan(0)
    // …and the result was persisted onto the source row.
    expect(redactionMapEncFromCalls()).toBe(`enc:${Object.keys(passedMap).length}`)
  })

  it("does not encrypt or persist a map when the source has no PII", async () => {
    mockParseSource.mockResolvedValue({ ...parsedSource(), pageMap: undefined })

    await runIngestJob(runInput())

    expect(mockEncryptRedactionMap).not.toHaveBeenCalled()
    expect(redactionMapEncFromCalls()).toBeUndefined()
  })
})
