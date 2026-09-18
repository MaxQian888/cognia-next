import type { Artifact, PluginFilesAPI } from "@cognia/plugin-sdk"
import { createVisualization, VISUALIZATION_ARTIFACT_KIND } from "./model"
import { createVisualizeRuntime } from "./runtime"

function createCtx(artifacts: Map<string, Artifact>) {
  const save = jest.fn(async (_options: Parameters<PluginFilesAPI["save"]>[0]) => ({
    saved: true,
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
    i18n: { t: (key: string) => key, getCurrentLocale: () => "en" },
  }
  return { ctx, save }
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
  })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/svg+xml" }))
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
