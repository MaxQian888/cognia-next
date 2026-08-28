jest.mock("./pptx", () => ({
  exportPptx: jest.fn(async () => Uint8Array.from([1, 2, 3])),
  importPptx: jest.fn(),
  validatePptxRoundTrip: jest.fn(async () => ({ valid: true, slideCount: 1 })),
}))

import type { Artifact } from "@cognia/plugin-sdk"
import { PRESENTATION_ARTIFACT_KIND } from "./model"
import { createPresentationsRuntime } from "./runtime"

it("creates, validates, and exports a presentation artifact", async () => {
  const artifacts = new Map<string, Artifact>()
  const save = jest.fn(async () => ({ saved: true }))
  const ctx = {
    pluginId: "cognia-presentations",
    artifact: {
      createArtifact: jest.fn(async (input) => {
        artifacts.set("p1", {
          id: "p1",
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
              kind: PRESENTATION_ARTIFACT_KIND,
              schemaVersion: 1,
              ownerPluginId: "cognia-presentations",
            },
          },
        })
        return "p1"
      }),
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: jest.fn(),
    },
    files: { save },
  } as never
  const runtime = createPresentationsRuntime(ctx)
  await expect(
    runtime.create({
      title: "Launch",
      operations: [
        {
          op: "addSlide",
          title: "Overview",
          elements: [{ id: "t1", type: "text", x: 1, y: 1, width: 6, height: 1, text: "Launch" }],
        },
      ],
    })
  ).resolves.toMatchObject({ artifactId: "p1", findings: [] })
  await expect(runtime.validate("p1")).resolves.toMatchObject({ ok: true })
  await expect(runtime.exportPptx("p1")).resolves.toMatchObject({ ok: true })
  const imported = JSON.parse(artifacts.get("p1")!.content)
  imported.importedFeatures = ["native charts"]
  artifacts.get("p1")!.content = JSON.stringify(imported)
  await expect(runtime.exportPptx("p1")).rejects.toThrow("allowUnsupportedFeatureLoss")
  await expect(runtime.exportPptx("p1", undefined, true)).resolves.toMatchObject({ ok: true })
  expect(save).toHaveBeenCalled()
})
