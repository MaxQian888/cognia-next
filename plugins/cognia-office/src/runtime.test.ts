import type { Artifact } from "@cognia/plugin-sdk"
import type { PluginArtifactAPI } from "@cognia/plugin-sdk"
import type { BuiltInSkillResult } from "@cognia/plugin-sdk"

type ArtifactVersion = ReturnType<PluginArtifactAPI["listVersions"]>[number]
import manifestJson from "../plugin.json"

jest.mock("./xlsx", () => {
  const actual = jest.requireActual("./xlsx")
  return { ...actual, validateXlsxPackage: jest.fn(actual.validateXlsxPackage) }
})

import { createOfficeRuntime, normalizeXlsxName, type OfficePluginContext } from "./runtime"
import { createWorkbook, WORKBOOK_ARTIFACT_KIND } from "./model"
import { exportWorkbookXlsx, validateXlsxPackage, XLSX_MIME } from "./xlsx"

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
  const versions = new Map<string, ArtifactVersion[]>()
  const updateArtifact = jest.fn(
    (id: string, update: Parameters<PluginArtifactAPI["updateArtifact"]>[1]) => {
      const source = artifacts.get(id)!
      if (update.expectedVersion !== source.version)
        throw new Error(`artifact version conflict for ${id}`)
      versions.set(id, [
        ...(versions.get(id) ?? []),
        {
          id: `${id}-v${source.version}`,
          artifactId: id,
          title: source.title,
          content: source.content,
          version: source.version,
          createdAt: new Date(),
        },
      ])
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
  const listVersions = jest.fn((id: string) => versions.get(id) ?? [])
  const restoreVersion = jest.fn((id: string, versionId: string, expectedVersion: number) => {
    const snapshot = (versions.get(id) ?? []).find((version) => version.id === versionId)!
    return updateArtifact(id, { content: snapshot.content, expectedVersion })
  })
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
  const en = manifestJson.i18n.locales.en as Record<string, string>
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
      listVersions,
      restoreVersion,
    },
    files: { save, open: jest.fn(), readAttachment: jest.fn() },
    skills: { invokeBuiltIn, listBuiltIns: jest.fn() },
    i18n: { t: (key: string) => en[key] ?? key },
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
    saved: true,
    filename: "recon.xlsx",
    message: expect.stringContaining("save dialog"),
    byteLength: expect.any(Number),
  })
  expect((ctx.artifact.createArtifact as jest.Mock).mock.calls[0][0].metadata).toMatchObject({
    sourceOrigin: "tool",
    userInitiated: false,
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
  expect(invokeBuiltIn.mock.calls[0][1]).not.toHaveProperty("folderToken")

  await runtime.syncLark(created.artifactId, "s1", { folderToken: "fld-2" })
  expect(invokeBuiltIn).toHaveBeenLastCalledWith(
    "lark.sheets.create",
    expect.objectContaining({ title: "Inventory", folderToken: "fld-2" }),
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

  await expect(runtime.exportXlsx(created.artifactId)).resolves.toMatchObject({
    ok: false,
    requiresConfirmation: true,
    unsupportedFeatures: ["Pivot tables cannot be preserved losslessly."],
    error: expect.stringContaining("allowUnsupportedFeatureLoss"),
  })
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
  expect(created).not.toHaveProperty("workbook")
  expect(created.summary.sheets[0]).toMatchObject({ usedRange: "A1:B2", cellCount: 4 })
  expect(runtime.readRange(created.artifactId).sheets[0]).toMatchObject({
    rows: [
      ["SKU", "Qty"],
      ["A-1", 4],
    ],
  })
  await runtime.exportXlsx(created.artifactId)
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      suggestedName: "Quarter-One-Two.xlsx",
      mimeType: XLSX_MIME,
    })
  )
})

it("reports where a mobile export landed, and a cancelled save as not written", async () => {
  const { ctx, save } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "Mobile" })
  save.mockResolvedValueOnce({
    saved: true,
    platform: "mobile",
    location: "file:///Documents/cognia/exports/Mobile.xlsx",
  })
  await expect(runtime.exportXlsx(created.artifactId)).resolves.toMatchObject({
    ok: true,
    platform: "mobile",
    location: "file:///Documents/cognia/exports/Mobile.xlsx",
    message: expect.stringContaining("Documents/cognia/exports"),
  })
  save.mockResolvedValueOnce({ saved: false })
  await expect(runtime.exportXlsx(created.artifactId)).resolves.toMatchObject({
    ok: false,
    saved: false,
    cancelled: true,
  })
})

it("normalizes model-supplied export names", () => {
  expect(normalizeXlsxName("q3/report")).toBe("q3-report.xlsx")
  expect(normalizeXlsxName("report.XLSX")).toBe("report.xlsx")
  expect(normalizeXlsxName("")).toBe("workbook.xlsx")
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
  ).resolves.toMatchObject({ ok: true, summary: { title: "Named" }, findings: [] })
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

it("reads cells as a grid or as text for prompts", async () => {
  const { ctx } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({
    title: "Read",
    operations: [
      {
        op: "setRange",
        sheet: "Sheet1",
        range: "A1:B2",
        values: [
          [
            { type: "string", value: "Qty" },
            { type: "string", value: "Double" },
          ],
          [
            { type: "number", value: 2 },
            { type: "number", value: 4, formula: "A2*2" },
          ],
        ],
      },
    ],
  })
  expect(runtime.readRange(created.artifactId, { sheet: "Sheet1", range: "B2" })).toMatchObject({
    ok: true,
    version: 1,
    truncated: false,
    sheets: [{ range: "B2", rows: [[4]], formulas: { B2: "=A2*2" } }],
  })
  const text = runtime.readRange(created.artifactId, { format: "text" })
  expect(text).toMatchObject({
    text: "## Sheet1 (A1:B2)\nQty\tDouble\n2\t4\n\nFormulas:\nB2: =A2*2",
  })
  expect(text.sheets[0]).not.toHaveProperty("rows")
  expect(() =>
    runtime.readRange(created.artifactId, { format: "csv" as unknown as "text" })
  ).toThrow("invalid format")
})

it("lists and restores workbook versions, refusing unknown snapshots", async () => {
  const { ctx } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "History" })
  runtime.applyOperations({
    artifactId: created.artifactId,
    expectedVersion: 1,
    operations: [
      { op: "setCell", sheet: "Sheet1", cell: "A1", value: { type: "string", value: "v2" } },
    ],
    changeDescription: "Fill A1",
  })
  const listed = runtime.listVersions(created.artifactId)
  expect(listed).toMatchObject({
    ok: true,
    currentVersion: 2,
    versions: [{ versionId: "artifact-1-v1", version: 1, title: "History" }],
  })
  const restored = runtime.restoreVersion({
    artifactId: created.artifactId,
    versionId: "artifact-1-v1",
    expectedVersion: 2,
  })
  expect(restored).toMatchObject({ ok: true, version: 3, summary: { sheets: [{ cellCount: 0 }] } })
  expect(ctx.artifact.openArtifact).toHaveBeenLastCalledWith(created.artifactId)
  expect(() =>
    runtime.restoreVersion({
      artifactId: created.artifactId,
      versionId: "nope",
      expectedVersion: 3,
    })
  ).toThrow("version not found")
})

it("returns summaries and findings from edits instead of the workbook payload", async () => {
  const { ctx } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "Edits" })
  expect(created).toMatchObject({ version: 1, findings: [] })
  const edited = runtime.applyOperations({
    artifactId: created.artifactId,
    expectedVersion: 1,
    operations: [{ op: "merge", sheet: "Sheet1", range: "A1:B1" }],
  })
  expect(edited).not.toHaveProperty("workbook")
  expect(edited.summary.sheets[0]).toMatchObject({ usedRange: "A1:B1", merges: 1 })
})

it("refuses a workbook artifact that another plugin owns", async () => {
  const { artifacts, ctx } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "Owned" })
  const artifact = artifacts.get(created.artifactId)!
  artifacts.set(created.artifactId, {
    ...artifact,
    metadata: {
      ...artifact.metadata,
      plugin: { kind: WORKBOOK_ARTIFACT_KIND, schemaVersion: 1, ownerPluginId: "other" },
    },
  })
  expect(() => runtime.inspect(created.artifactId)).toThrow("not owned by cognia-office")
})

it("refuses to save a generated package that does not reopen", async () => {
  const { ctx, save } = context()
  const runtime = createOfficeRuntime(ctx)
  const created = await runtime.create({ title: "Broken writer" })
  ;(validateXlsxPackage as jest.Mock).mockResolvedValueOnce(false)
  await expect(runtime.exportXlsx(created.artifactId)).resolves.toMatchObject({
    ok: false,
    reason: "invalid-package",
    error: expect.stringContaining("did not reopen"),
  })
  expect(save).not.toHaveBeenCalled()
})
