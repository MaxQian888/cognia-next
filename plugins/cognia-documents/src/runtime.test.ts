jest.mock("./docx", () => ({
  exportDocx: jest.fn(async () => Uint8Array.from([1, 2, 3])),
  importDocx: jest.fn(),
  validateDocxRoundTrip: jest.fn(async () => ({ valid: true, text: "Hello" })),
}))

import type { Artifact } from "@cognia/plugin-sdk"
import { DOCUMENT_ARTIFACT_KIND } from "./model"
import { createDocumentsRuntime } from "./runtime"

it("creates, edits, validates, and exports a document artifact", async () => {
  const artifacts = new Map<string, Artifact>()
  const save = jest.fn(async () => ({ saved: true }))
  const ctx = {
    pluginId: "cognia-documents",
    artifact: {
      createArtifact: jest.fn(async (input) => {
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
      updateArtifact: (_id: string, update: { content?: string }) => {
        const current = artifacts.get("d1")!
        const next = { ...current, content: update.content ?? current.content, version: 2 }
        artifacts.set("d1", next)
        return next
      },
      openArtifact: jest.fn(),
    },
    files: { save },
  } as never
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
  await expect(runtime.exportDocx("d1")).resolves.toMatchObject({ ok: true })
  const imported = JSON.parse(artifacts.get("d1")!.content)
  imported.importedFeatures = ["tracked changes"]
  artifacts.get("d1")!.content = JSON.stringify(imported)
  await expect(runtime.exportDocx("d1")).rejects.toThrow("allowUnsupportedFeatureLoss")
  await expect(runtime.exportDocx("d1", undefined, true)).resolves.toMatchObject({ ok: true })
  expect(save).toHaveBeenCalled()
})
