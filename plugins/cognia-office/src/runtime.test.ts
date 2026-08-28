import type { Artifact } from "@cognia/plugin-sdk"
import type { PluginArtifactAPI } from "@cognia/plugin-sdk"
import type { BuiltInSkillResult } from "@cognia/plugin-sdk"
import { createOfficeRuntime, type OfficePluginContext } from "./runtime"
import { createWorkbook, WORKBOOK_ARTIFACT_KIND } from "./model"
import { exportWorkbookXlsx, XLSX_MIME } from "./xlsx"

function context() {
  const artifacts = new Map<string, Artifact>()
  const createArtifact = jest.fn(
    async (input: Parameters<PluginArtifactAPI["createArtifact"]>[0]) => {
      const id = `artifact-${artifacts.size + 1}`
      artifacts.set(id, {
        id,
        sessionId: input.sessionId ?? "",
        messageId: input.messageId ?? "",
        type: "code",
        title: input.title,
        content: input.content,
        language: input.language,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          ...input.metadata,
          plugin: {
            kind: input.kind!,
            schemaVersion: input.schemaVersion!,
            ownerPluginId: "cognia-office",
          },
        },
      })
      return id
    }
  )
  const updateArtifact = jest.fn(
    (id: string, update: Parameters<PluginArtifactAPI["updateArtifact"]>[1]) => {
      const source = artifacts.get(id)!
      const next = {
        ...source,
        title: update.title ?? source.title,
        content: update.content ?? source.content,
        version: source.version + 1,
      }
      artifacts.set(id, next)
      return next
    }
  )
  const save = jest.fn(async () => ({ saved: true }))
  const invokeBuiltIn = jest.fn(
    async (
      _skillId: string,
      _args: Record<string, unknown>,
      _options: { sessionId: string; signal?: AbortSignal }
    ): Promise<BuiltInSkillResult> => ({
      status: "ok",
      data: { spreadsheetToken: "sht-1" },
    })
  )
  const ctx = {
    pluginId: "cognia-office",
    artifact: {
      createArtifact,
      updateArtifact,
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: jest.fn(),
    },
    files: { save, open: jest.fn(), readAttachment: jest.fn() },
    skills: { invokeBuiltIn, listBuiltIns: jest.fn() },
  } as unknown as OfficePluginContext
  return { artifacts, createArtifact, ctx, invokeBuiltIn, save, updateArtifact }
}

it("creates, inspects, atomically edits, validates, and exports a native workbook", async () => {
  const { ctx, save, updateArtifact } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({
    title: "Reconciliation",
    operations: [
      { op: "setCell", sheet: "Sheet1", cell: "A1", value: { type: "string", value: "Trade" } },
    ],
    sessionId: "s1",
  })
  expect(created.artifactId).toBe("artifact-1")
  expect(ctx.artifact.getArtifact(created.artifactId)?.metadata?.plugin?.kind).toBe(
    WORKBOOK_ARTIFACT_KIND
  )
  expect(runtime.inspect(created.artifactId)).toMatchObject({
    version: 1,
    sheets: [{ cellCount: 1 }],
  })

  const edited = runtime.applyOperations({
    artifactId: created.artifactId,
    expectedVersion: 1,
    operations: [
      { op: "setCell", sheet: "Sheet1", cell: "B1", value: { type: "number", value: 10 } },
    ],
  })
  expect(edited.version).toBe(2)
  expect(updateArtifact).toHaveBeenCalledWith(
    created.artifactId,
    expect.objectContaining({ expectedVersion: 1 })
  )
  expect(runtime.validate(created.artifactId).ok).toBe(true)
  await expect(runtime.exportXlsx(created.artifactId, "recon.xlsx")).resolves.toMatchObject({
    ok: true,
    byteLength: expect.any(Number),
  })
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ suggestedName: "recon.xlsx", bytes: expect.any(Uint8Array) })
  )
})

it("syncs all workbook sheets through the allowlisted Lark built-in seam", async () => {
  const { ctx, invokeBuiltIn } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "Inventory" })
  await expect(runtime.syncLark(created.artifactId, "s1")).resolves.toMatchObject({ ok: true })
  expect(invokeBuiltIn).toHaveBeenCalledWith(
    "lark.sheets.create",
    expect.objectContaining({ title: "Inventory", sheets: [{ title: "Sheet1", values: [] }] }),
    expect.objectContaining({ sessionId: "s1" })
  )
})

it("requires explicit acknowledgement before exporting unsupported imported features", async () => {
  const { artifacts, ctx, save } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "Legacy workbook" })
  const artifact = artifacts.get(created.artifactId)!
  const workbook = JSON.parse(artifact.content)
  workbook.unsupportedFeatures = ["Pivot tables cannot be preserved losslessly."]
  artifacts.set(created.artifactId, { ...artifact, content: JSON.stringify(workbook) })

  await expect(runtime.exportXlsx(created.artifactId)).rejects.toThrow(
    "allowUnsupportedFeatureLoss"
  )
  expect(save).not.toHaveBeenCalled()
  await expect(runtime.exportXlsx(created.artifactId, undefined, true)).resolves.toMatchObject({
    ok: true,
  })
})

it("creates a workbook from delimited content and chooses a safe default filename", async () => {
  const { ctx, save } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({
    title: "Quarter:One/Two",
    content: "SKU,Qty\nA-1,4",
  })
  expect(created.workbook.sheets[0].cells).toMatchObject({
    A1: { value: "SKU" },
    B2: { value: 4 },
  })
  await runtime.exportXlsx(created.artifactId)
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      suggestedName: "Quarter-One-Two.xlsx",
      mimeType: XLSX_MIME,
    })
  )
})

it("imports from authorized attachments and from the picker, including cancellation", async () => {
  const first = context()
  const bytes = await exportWorkbookXlsx(createWorkbook("Imported", "Data"))
  const file = {
    id: "file-1",
    name: "imported.xlsx",
    mimeType: XLSX_MIME,
    size: bytes.byteLength,
    bytes,
  }
  ;(first.ctx.files.readAttachment as jest.Mock).mockResolvedValue(file)
  await expect(
    createOfficeRuntime(first.ctx).importXlsx({ handle: "attachment-1", title: "Named" })
  ).resolves.toMatchObject({ ok: true, workbook: { title: "Named" } })
  expect(first.ctx.files.readAttachment).toHaveBeenCalledWith("attachment-1")

  const second = context()
  ;(second.ctx.files.open as jest.Mock).mockResolvedValue([file])
  await expect(createOfficeRuntime(second.ctx).importXlsx({})).resolves.toMatchObject({ ok: true })
  expect(second.ctx.files.open).toHaveBeenCalledWith({
    accept: [".xlsx", XLSX_MIME],
    maxBytes: 50 * 1024 * 1024,
  })

  const cancelled = context()
  ;(cancelled.ctx.files.open as jest.Mock).mockResolvedValue([])
  await expect(createOfficeRuntime(cancelled.ctx).importXlsx({})).resolves.toEqual({
    ok: false,
    cancelled: true,
  })
})

it("rejects missing, foreign, and invalid workbook artifacts", async () => {
  const { artifacts, ctx, save } = context()
  const runtime = createOfficeRuntime(ctx)
  expect(() => runtime.inspect("missing")).toThrow("not found")

  artifacts.set("foreign", {
    id: "foreign",
    sessionId: "",
    messageId: "",
    type: "code",
    title: "foreign",
    content: "{}",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  expect(() => runtime.inspect("foreign")).toThrow("not a Cognia Office workbook")

  const created = await runtime.create({ title: "Invalid" })
  const artifact = artifacts.get(created.artifactId)!
  artifacts.set(created.artifactId, {
    ...artifact,
    content: JSON.stringify({ ...JSON.parse(artifact.content), title: "" }),
  })
  expect(() => runtime.validate(created.artifactId)).toThrow("title.empty")
  await expect(runtime.exportXlsx(created.artifactId)).rejects.toThrow("title.empty")
  expect(save).not.toHaveBeenCalled()
})

it("returns a fail-closed Lark result and serializes formulas and sparse columns", async () => {
  const { ctx, invokeBuiltIn } = context()
  invokeBuiltIn.mockResolvedValueOnce({
    status: "error",
    message: "missing command",
  })
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({
    title: "Lark sync",
    operations: [
      { op: "setCell", sheet: "Sheet1", cell: "A1", value: { type: "number", formula: "1+1" } },
      { op: "setCell", sheet: "Sheet1", cell: "AA2", value: { type: "string", value: "far" } },
    ],
  })
  await expect(runtime.syncLark(created.artifactId, "s1")).resolves.toMatchObject({
    ok: false,
    result: { status: "error" },
  })
  const [, args, options] = invokeBuiltIn.mock.calls[0]
  const sheets = (args as { sheets: Array<{ values: unknown[][] }> }).sheets
  expect(sheets[0].values[0][0]).toBe("=1+1")
  expect(sheets[0].values[1][26]).toBe("far")
  expect(options).toEqual({ sessionId: "s1", signal: undefined })
})
