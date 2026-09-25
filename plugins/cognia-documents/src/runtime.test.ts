jest.mock("./docx", () => ({
  exportDocx: jest.fn(async () => Uint8Array.from([1, 2, 3])),
  importDocx: jest.fn(),
  validateDocxRoundTrip: jest.fn(async () => ({ valid: true, text: "Hello" })),
}))

import type { Artifact, ExportResult } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { importDocx } from "./docx"
import { createDocument, DOCUMENT_ARTIFACT_KIND } from "./model"
import { createDocumentsRuntime, normalizeDocxName } from "./runtime"

const EN = manifestJson.i18n.locales.en as Record<string, string>
const translate = (key: string) => EN[key] ?? key

interface VersionRow {
  id: string
  artifactId: string
  title: string
  content: string
  version: number
  createdAt: Date
}

function makeCtx() {
  const artifacts = new Map<string, Artifact>()
  const versions = new Map<string, VersionRow[]>()
  const save = jest.fn(
    async (): Promise<{
      saved: boolean
      platform?: "desktop" | "mobile" | "web"
      location?: string
    }> => ({
      saved: true,
      platform: "desktop",
    })
  )
  const exportSession = jest.fn(async (): Promise<ExportResult> => ({
    success: true,
    blob: new Blob([Uint8Array.from([9, 8, 7])]),
    filename: "chat.docx",
  }))
  const ctx = {
    pluginId: "cognia-documents",
    artifact: {
      createArtifact: jest.fn(async (input: { title: string; content: string }) => {
        artifacts.set("d1", {
          id: "d1",
          sessionId: "",
          messageId: "",
          type: "document",
          title: input.title,
          content: input.content,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            plugin: {
              kind: DOCUMENT_ARTIFACT_KIND,
              schemaVersion: 1,
              ownerPluginId: "cognia-documents",
            },
          },
        })
        return "d1"
      }),
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      updateArtifact: (_id: string, update: { content?: string; title?: string }) => {
        const current = artifacts.get("d1")!
        versions.set("d1", [
          ...(versions.get("d1") ?? []),
          {
            id: `v${current.version}`,
            artifactId: "d1",
            title: current.title,
            content: current.content,
            version: current.version,
            createdAt: current.updatedAt,
          },
        ])
        const next = {
          ...current,
          content: update.content ?? current.content,
          title: update.title ?? current.title,
          version: current.version + 1,
        }
        artifacts.set("d1", next)
        return next
      },
      openArtifact: jest.fn(),
      listVersions: (id: string) => versions.get(id) ?? [],
      restoreVersion: (id: string, versionId: string) => {
        const snapshot = (versions.get(id) ?? []).find((v) => v.id === versionId)
        if (!snapshot) throw new Error("Version not found")
        const current = artifacts.get(id)!
        const next = { ...current, content: snapshot.content, version: current.version + 1 }
        artifacts.set(id, next)
        return next
      },
    },
    files: {
      save,
      readAttachment: jest.fn(async () => ({
        id: "h1",
        name: "in.docx",
        mimeType: "application/octet-stream",
        size: 3,
        bytes: Uint8Array.from([1, 2, 3]),
      })),
    },
    export: { exportSession },
    i18n: { t: translate },
  } as never
  return { ctx, artifacts, versions, save, exportSession }
}

it("creates, edits, validates, and exports a document artifact", async () => {
  const { ctx, artifacts, save } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  await expect(runtime.create({ title: "Brief", text: "Hello" })).resolves.toMatchObject({
    artifactId: "d1",
  })
  await expect(
    runtime.apply({
      artifactId: "d1",
      expectedVersion: 1,
      operations: [{ op: "appendParagraph", text: "World" }],
    })
  ).resolves.toMatchObject({ version: 2 })
  await expect(runtime.validate("d1")).resolves.toMatchObject({ ok: true })
  await expect(runtime.exportDocx("d1")).resolves.toMatchObject({
    ok: true,
    saved: true,
    platform: "desktop",
    filename: "Brief.docx",
    message: expect.stringContaining("save dialog"),
  })
  const imported = JSON.parse(artifacts.get("d1")!.content)
  imported.importedFeatures = ["tracked-changes"]
  artifacts.get("d1")!.content = JSON.stringify(imported)
  save.mockClear()
  await expect(runtime.exportDocx("d1")).resolves.toMatchObject({
    ok: false,
    requiresConfirmation: true,
    unsupportedFeatures: ["tracked-changes"],
    error: expect.stringContaining("allowUnsupportedFeatureLoss"),
  })
  expect(save).not.toHaveBeenCalled()
  await expect(runtime.exportDocx("d1", undefined, true)).resolves.toMatchObject({ ok: true })
  expect(save).toHaveBeenCalled()
})

it("marks tool-created artifacts as not user-initiated", async () => {
  const { ctx } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  await runtime.create({ title: "Brief" })
  const createArtifact = (ctx as unknown as { artifact: { createArtifact: jest.Mock } }).artifact
    .createArtifact
  expect(createArtifact.mock.calls[0][0].metadata).toMatchObject({
    sourceOrigin: "tool",
    userInitiated: false,
  })
})

it("imports DOCX with localized progress and importer labels", async () => {
  const { ctx } = makeCtx()
  jest.mocked(importDocx).mockResolvedValueOnce(createDocument("Imported"))
  const runtime = createDocumentsRuntime(ctx)
  const reportProgress = jest.fn()
  await expect(runtime.importDocx({ handle: "h1" }, { reportProgress })).resolves.toMatchObject({
    ok: true,
    artifactId: "d1",
  })
  expect(reportProgress).toHaveBeenCalledWith(10, "Reading DOCX file")
  expect(reportProgress).toHaveBeenCalledWith(40, "Parsing DOCX structure")
  expect(importDocx).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    "in.docx",
    { emptyComment: "(empty comment)", unknownAuthor: "Unknown", untitled: "Document" },
    undefined
  )
})

it("hands a caller-chosen title to the importer, which keeps the file's own Title as content", async () => {
  const { ctx } = makeCtx()
  jest.mocked(importDocx).mockResolvedValueOnce(createDocument("Q3 review"))
  const runtime = createDocumentsRuntime(ctx)
  await runtime.importDocx({ handle: "h1", title: "Q3 review" })
  expect(importDocx).toHaveBeenLastCalledWith(
    expect.any(Uint8Array),
    "in.docx",
    expect.any(Object),
    "Q3 review"
  )
})

it("tells the model where a mobile export landed and when the user cancelled", async () => {
  const { ctx, save } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  await runtime.create({ title: "Plan", text: "x" })
  save.mockResolvedValueOnce({
    saved: true,
    platform: "mobile",
    location: "file:///Documents/cognia/exports/plan.docx",
  })
  await expect(runtime.exportDocx("d1", "plan")).resolves.toMatchObject({
    ok: true,
    platform: "mobile",
    location: "file:///Documents/cognia/exports/plan.docx",
    message: expect.stringContaining("Documents/cognia/exports"),
  })
  save.mockResolvedValueOnce({ saved: false })
  await expect(runtime.exportDocx("d1", "plan")).resolves.toMatchObject({
    ok: false,
    cancelled: true,
    saved: false,
  })
})

it("propagates setTitle to the artifact title", async () => {
  const { ctx, artifacts } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  await runtime.create({ title: "Old", text: "x" })
  await runtime.apply({
    artifactId: "d1",
    expectedVersion: 1,
    operations: [{ op: "setTitle", title: "Renamed" }],
  })
  expect(artifacts.get("d1")!.title).toBe("Renamed")
})

it("lists and restores artifact versions", async () => {
  const { ctx } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  await runtime.create({ title: "Doc", text: "v1 text" })
  await runtime.apply({
    artifactId: "d1",
    expectedVersion: 1,
    operations: [{ op: "replaceText", blockId: "b1", text: "v2 text" }],
  })
  const list = runtime.listVersions("d1")
  expect(list).toMatchObject({ ok: true, currentVersion: 2 })
  expect(list.versions).toHaveLength(1)
  expect(list.versions[0]).toMatchObject({ versionId: "v1", version: 1 })
  const restored = runtime.restoreVersion({
    artifactId: "d1",
    versionId: "v1",
    expectedVersion: 2,
  })
  expect(restored.model.blocks[0]).toMatchObject({ text: "v1 text" })
  expect(restored.version).toBe(3)
})

it("exports a session transcript through the export API and save dialog", async () => {
  const { ctx, save, exportSession } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  const result = await runtime.exportTranscript({ sessionId: "s1" })
  expect(exportSession).toHaveBeenCalledWith("s1", { format: "docx" })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "chat.docx" }))
  expect(result).toMatchObject({ ok: true, filename: "chat.docx", byteLength: 3 })
})

it("surfaces transcript export failures", async () => {
  const { ctx, exportSession } = makeCtx()
  exportSession.mockResolvedValueOnce({ success: false, error: "denied" })
  const runtime = createDocumentsRuntime(ctx)
  await expect(runtime.exportTranscript({ sessionId: "s1" })).resolves.toMatchObject({
    ok: false,
    error: "denied",
  })
})

it("aborts long-running operations when the signal fires", async () => {
  const { ctx } = makeCtx()
  const runtime = createDocumentsRuntime(ctx)
  await runtime.create({ title: "Doc", text: "x" })
  const controller = new AbortController()
  controller.abort()
  await expect(runtime.validate("d1", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  await expect(
    runtime.exportDocx("d1", undefined, false, { signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" })
})

it("normalizes suggested filenames without duplicating .docx", () => {
  expect(normalizeDocxName("report.docx")).toBe("report.docx")
  expect(normalizeDocxName("report")).toBe("report.docx")
  expect(normalizeDocxName("a/b:c")).toBe("a-b-c.docx")
  expect(normalizeDocxName("")).toBe("document.docx")
})
