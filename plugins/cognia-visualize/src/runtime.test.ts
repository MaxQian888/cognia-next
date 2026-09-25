import type { Artifact, ExportResult, PluginFilesAPI } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createVisualization, VISUALIZATION_ARTIFACT_KIND } from "./model"
import { createVisualizeRuntime } from "./runtime"

const EN = manifestJson.i18n.locales.en as Record<string, string>
const t = (key: string, params?: Record<string, string | number>) => {
  let text = EN[key] ?? key
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.replace(`{${name}}`, String(value))
  return text
}

function createCtx(artifacts: Map<string, Artifact>) {
  const save = jest.fn(
    async (
      _options: Parameters<PluginFilesAPI["save"]>[0]
    ): Promise<{ saved: boolean; platform?: "desktop" | "mobile" | "web"; location?: string }> => ({
      saved: true,
      platform: "desktop",
    })
  )
  const exportSession = jest.fn(async (): Promise<ExportResult> => ({
    success: true,
    blob: new Blob(["<!doctype html><html></html>"], { type: "text/html" }),
    filename: "Chat-2026-09-25.html",
  }))
  const ctx = {
    pluginId: "cognia-visualize",
    artifact: {
      createArtifact: jest.fn(async (input) => {
        artifacts.set("v1", {
          id: "v1",
          sessionId: input.sessionId ?? "",
          messageId: input.messageId ?? "",
          type: "chart",
          title: input.title,
          content: input.content,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            plugin: {
              kind: VISUALIZATION_ARTIFACT_KIND,
              schemaVersion: 1,
              ownerPluginId: "cognia-visualize",
            },
          },
        } as Artifact)
        return "v1"
      }),
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      updateArtifact: jest.fn((id: string, updates) => {
        const current = artifacts.get(id)!
        const next = {
          ...current,
          title: updates.title ?? current.title,
          content: updates.content ?? current.content,
          version: current.version + 1,
        } as Artifact
        artifacts.set(id, next)
        return next
      }),
      listArtifacts: jest.fn(() => [...artifacts.values()]),
      openArtifact: jest.fn(),
    },
    files: { save },
    export: { exportSession },
    i18n: { t, getCurrentLocale: () => "en" },
  }
  return { ctx, save, exportSession }
}

it("creates, validates, and exports an accessible visualization artifact", async () => {
  const artifacts = new Map<string, Artifact>()
  const { ctx, save } = createCtx(artifacts)
  const runtime = createVisualizeRuntime(ctx as never)
  await expect(
    runtime.create({
      title: "Revenue",
      profile: "bar",
      data: [{ label: "Q1", value: 10 }],
      sessionId: "s1",
    })
  ).resolves.toMatchObject({ artifactId: "v1", findings: [] })
  // sessionId/messageId must not leak into the persisted spec payload.
  expect(JSON.parse(artifacts.get("v1")!.content)).not.toHaveProperty("sessionId")
  expect(runtime.validate("v1")).toMatchObject({ ok: true })
  await expect(runtime.export({ artifactId: "v1", format: "svg" })).resolves.toMatchObject({
    ok: true,
    saved: true,
    filename: "Revenue.svg",
    message: expect.stringContaining("save dialog"),
  })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/svg+xml" }))
  const created = (ctx.artifact.createArtifact as jest.Mock).mock.calls[0][0]
  expect(created.metadata).toMatchObject({ userInitiated: false })
  expect(JSON.parse(created.content).accessibility.summary).toBe("Revenue: 1 data points.")
})

it("forces the export extension and reports mobile saves and cancellations", async () => {
  const artifacts = new Map<string, Artifact>()
  const { ctx, save } = createCtx(artifacts)
  const runtime = createVisualizeRuntime(ctx as never)
  await runtime.create({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] })
  save.mockResolvedValueOnce({
    saved: true,
    platform: "mobile",
    location: "file:///Documents/cognia/exports/q3-chart.json",
  })
  await expect(
    runtime.export({ artifactId: "v1", format: "json", suggestedName: "q3/chart.svg" })
  ).resolves.toMatchObject({
    ok: true,
    filename: "q3-chart.svg.json",
    platform: "mobile",
    message: expect.stringContaining("Documents/cognia/exports"),
  })
  save.mockResolvedValueOnce({ saved: false })
  await expect(runtime.export({ artifactId: "v1", format: "html" })).resolves.toMatchObject({
    ok: false,
    cancelled: true,
  })
})

it("exports a session report through ctx.export.exportSession and saves it", async () => {
  const artifacts = new Map<string, Artifact>()
  const { ctx, save, exportSession } = createCtx(artifacts)
  const runtime = createVisualizeRuntime(ctx as never)
  await expect(runtime.exportReport({ sessionId: "s1" })).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("no visualizations"),
  })
  expect(exportSession).not.toHaveBeenCalled()

  await runtime.create({
    title: "Revenue",
    profile: "bar",
    data: [{ label: "Q1", value: 10 }],
    sessionId: "s1",
  })
  await expect(runtime.exportReport({ sessionId: "s1" })).resolves.toMatchObject({
    ok: true,
    sessionId: "s1",
    filename: "Chat-2026-09-25.html",
  })
  expect(exportSession).toHaveBeenCalledWith("s1", { format: "visualization-report" })
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ suggestedName: "Chat-2026-09-25.html", mimeType: "text/html" })
  )

  exportSession.mockResolvedValueOnce({ success: false, error: "Session not found" })
  await expect(runtime.exportReport({ sessionId: "s1" })).resolves.toMatchObject({
    ok: false,
    error: "Session not found",
  })
})

it("update carries the spec title and honors optimistic version checking", async () => {
  const artifacts = new Map<string, Artifact>()
  const { ctx } = createCtx(artifacts)
  const runtime = createVisualizeRuntime(ctx as never)
  await runtime.create({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] })
  const spec = createVisualization({
    title: "Revenue v2",
    profile: "line",
    data: [{ label: "Q1", value: 12 }],
  })
  const result = runtime.update({ artifactId: "v1", expectedVersion: 1, spec })
  expect(result).toMatchObject({ ok: true, version: 2 })
  expect(ctx.artifact.updateArtifact).toHaveBeenCalledWith(
    "v1",
    expect.objectContaining({ title: "Revenue v2", expectedVersion: 1 })
  )
})

it("list returns only this plugin's visualization artifacts", async () => {
  const artifacts = new Map<string, Artifact>()
  const { ctx } = createCtx(artifacts)
  const runtime = createVisualizeRuntime(ctx as never)
  await runtime.create({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] })
  expect(runtime.list({})).toEqual({
    ok: true,
    artifacts: [expect.objectContaining({ artifactId: "v1", title: "Revenue" })],
  })
})

it("html export is localized through the plugin i18n surface", async () => {
  const artifacts = new Map<string, Artifact>()
  const { ctx, save } = createCtx(artifacts)
  const runtime = createVisualizeRuntime(ctx as never)
  await runtime.create({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] })
  await expect(runtime.export({ artifactId: "v1", format: "html" })).resolves.toMatchObject({
    ok: true,
  })
  const html = new TextDecoder().decode(save.mock.calls[0][0].bytes)
  expect(html).toContain('lang="en"')
  expect(html).toContain("<svg")
})
