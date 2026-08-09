import type { Artifact } from "@/types/artifact"
import { VISUALIZATION_ARTIFACT_KIND } from "./model"
import { createVisualizeRuntime } from "./runtime"

it("creates, validates, and exports an accessible visualization artifact", async () => {
  const artifacts = new Map<string, Artifact>()
  const save = jest.fn(async () => ({ saved: true }))
  const ctx = {
    pluginId: "cognia-visualize",
    artifact: {
      createArtifact: jest.fn(async (input) => {
        artifacts.set("v1", {
          id: "v1",
          sessionId: "",
          messageId: "",
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
        })
        return "v1"
      }),
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: jest.fn(),
    },
    files: { save },
  } as never
  const runtime = createVisualizeRuntime(ctx)
  await expect(
    runtime.create({
      title: "Revenue",
      profile: "bar",
      data: [{ label: "Q1", value: 10 }],
    })
  ).resolves.toMatchObject({ artifactId: "v1", findings: [] })
  expect(runtime.validate("v1")).toMatchObject({ ok: true })
  await expect(runtime.export({ artifactId: "v1", format: "svg" })).resolves.toMatchObject({
    ok: true,
  })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/svg+xml" }))
})
