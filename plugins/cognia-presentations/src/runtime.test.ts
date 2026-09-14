jest.mock("./pptx", () => ({
  exportPptx: jest.fn(async () => Uint8Array.from([1, 2, 3])),
  importPptx: jest.fn(async () => {
    const { createPresentation, applyPresentationOperations } =
      jest.requireActual<typeof import("./model")>("./model")
    return applyPresentationOperations(createPresentation("Imported"), [
      { op: "addSlide", title: "One" },
    ])
  }),
  validatePptxRoundTrip: jest.fn(async () => ({ valid: true, slideCount: 1 })),
}))

import type { Artifact } from "@cognia/plugin-sdk"
import { PRESENTATION_ARTIFACT_KIND } from "./model"
import { createPresentationsRuntime } from "./runtime"
import { importPptx } from "./pptx"

function createCtx(overrides?: { ownerPluginId?: string }) {
  const artifacts = new Map<string, Artifact>()
  const save = jest.fn(async () => ({ saved: true }))
  const open = jest.fn(async () => [])
  const readAttachment = jest.fn(async () => ({ name: "deck.pptx", bytes: new Uint8Array([1]) }))
  const updateArtifact = jest.fn((id: string, input: { content: string }) => {
    const artifact = artifacts.get(id)!
    artifact.content = input.content
    artifact.version += 1
    return artifact
  })
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
              ownerPluginId: overrides?.ownerPluginId ?? "cognia-presentations",
            },
          },
        })
        return "p1"
      }),
      updateArtifact,
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: jest.fn(),
    },
    files: { save, open, readAttachment },
  } as never
  return { ctx, artifacts, save, open, readAttachment, updateArtifact }
}

async function seed(runtime: ReturnType<typeof createPresentationsRuntime>) {
  await runtime.create({
    title: "Launch",
    operations: [
      {
        op: "addSlide",
        title: "Overview",
        elements: [{ id: "t1", type: "text", x: 1, y: 1, width: 6, height: 1, text: "Launch" }],
      },
    ],
  })
}

it("creates, validates, and exports a presentation artifact", async () => {
  const { ctx, artifacts, save } = createCtx()
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

it("rejects artifacts owned by another plugin", async () => {
  const { ctx } = createCtx({ ownerPluginId: "someone-else" })
  const runtime = createPresentationsRuntime(ctx)
  await runtime.create({ title: "Deck" })
  expect(() => runtime.inspect("p1")).toThrow("not owned by this plugin")
  expect(() => runtime.preview("p1")).toThrow("not owned by this plugin")
})

it("imports via an authorized attachment handle without opening a picker", async () => {
  const { ctx, open, readAttachment } = createCtx()
  const runtime = createPresentationsRuntime(ctx)
  await expect(runtime.importPptx({ handle: "h1" })).resolves.toMatchObject({
    ok: true,
    artifactId: "p1",
  })
  expect(readAttachment).toHaveBeenCalledWith("h1")
  expect(open).not.toHaveBeenCalled()
  expect(importPptx).toHaveBeenCalledWith(expect.any(Uint8Array), "deck.pptx")
})

it("returns cancelled when the file picker is dismissed", async () => {
  const { ctx, open } = createCtx()
  const runtime = createPresentationsRuntime(ctx)
  await expect(runtime.importPptx({})).resolves.toEqual({ ok: false, cancelled: true })
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ multiple: false, accept: expect.arrayContaining([".pptx"]) })
  )
})

it("derives the export filename from sourceFilename", async () => {
  const { ctx, artifacts, save } = createCtx()
  const runtime = createPresentationsRuntime(ctx)
  await seed(runtime)
  const deck = JSON.parse(artifacts.get("p1")!.content)
  deck.sourceFilename = "quarterly review.pptx"
  artifacts.get("p1")!.content = JSON.stringify(deck)
  await runtime.exportPptx("p1")
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ suggestedName: "quarterly review.pptx" })
  )
})

it("applies operations with optimistic version checking", async () => {
  const { ctx, artifacts, updateArtifact } = createCtx()
  const runtime = createPresentationsRuntime(ctx)
  await seed(runtime)
  expect(
    runtime.apply({
      artifactId: "p1",
      expectedVersion: 1,
      operations: [{ op: "addSlide", title: "Second" }],
    })
  ).toMatchObject({ ok: true, version: 2 })
  const deck = JSON.parse(artifacts.get("p1")!.content)
  expect(deck.slides).toHaveLength(2)
  expect(updateArtifact).toHaveBeenCalledWith("p1", expect.objectContaining({ expectedVersion: 1 }))
})
