import {
  registerArtifactRenderer,
  resolveRegisteredArtifactRenderer,
  getRegisteredArtifactRenderers,
  clearRegisteredArtifactRenderers,
  type PluginArtifactRenderer,
} from "./renderer-registry"
import { loggers } from "@cognia/logging"
import type { Artifact } from "@/types"

const dummyArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  sessionId: "s",
  messageId: "m",
  type: "code",
  title: "t",
  content: "c",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

afterEach(() => {
  clearRegisteredArtifactRenderers()
})

describe("renderer-registry", () => {
  it("returns null when no plugin renderer claims the artifact", () => {
    expect(resolveRegisteredArtifactRenderer(dummyArtifact())).toBeNull()
  })

  it("registers and resolves a renderer by namespaced artifact kind", () => {
    const claimed: PluginArtifactRenderer = {
      id: "p-html",
      kind: "test/html",
      mount: () => ({ dispose: jest.fn() }),
    }
    registerArtifactRenderer(claimed.id, claimed)
    const resolved = resolveRegisteredArtifactRenderer(
      dummyArtifact({
        metadata: {
          plugin: { kind: "test/html", schemaVersion: 1, ownerPluginId: "test" },
        },
      })
    )
    expect(resolved).toBe(claimed)
    expect(
      resolveRegisteredArtifactRenderer(
        dummyArtifact({
          metadata: {
            plugin: { kind: "test/code", schemaVersion: 1, ownerPluginId: "test" },
          },
        })
      )
    ).toBeNull()
  })

  it("getRegisteredArtifactRenderers returns the registered set", () => {
    const r: PluginArtifactRenderer = {
      id: "any",
      kind: "test/any",
      mount: () => ({ dispose: jest.fn() }),
    }
    registerArtifactRenderer("any", r)
    expect(getRegisteredArtifactRenderers()).toEqual([r])
  })

  it("returned dispose function removes the renderer", () => {
    const r: PluginArtifactRenderer = {
      id: "x",
      kind: "test/x",
      mount: () => ({ dispose: jest.fn() }),
    }
    const dispose = registerArtifactRenderer("x", r)
    dispose()
    expect(getRegisteredArtifactRenderers()).toHaveLength(0)
  })

  it("does not let an old disposer remove a replacement for the same kind", () => {
    const first: PluginArtifactRenderer = {
      id: "first",
      kind: "test/workbook",
      mount: () => ({ dispose: jest.fn() }),
    }
    const second: PluginArtifactRenderer = {
      id: "second",
      kind: "test/workbook",
      mount: () => ({ dispose: jest.fn() }),
    }
    const disposeFirst = registerArtifactRenderer(first.id, first)
    registerArtifactRenderer(second.id, second)

    disposeFirst()

    expect(getRegisteredArtifactRenderers()).toEqual([second])
  })

  it("logs a diagnostic when an artifact kind has no registered renderer", () => {
    const debugSpy = jest.spyOn(loggers.plugin, "debug").mockImplementation()
    const artifact = dummyArtifact({
      metadata: {
        plugin: { kind: "test/missing", schemaVersion: 1, ownerPluginId: "test" },
      },
    })

    expect(resolveRegisteredArtifactRenderer(artifact)).toBeNull()
    expect(debugSpy).toHaveBeenCalledWith(
      "artifacts.plugin.renderer-missing",
      expect.objectContaining({ artifactId: "a1", kind: "test/missing" })
    )
    debugSpy.mockRestore()
  })

  it("clearRegisteredArtifactRenderers wipes the set", () => {
    registerArtifactRenderer("a", {
      id: "a",
      kind: "test/a",
      mount: () => ({ dispose: jest.fn() }),
    })
    registerArtifactRenderer("b", {
      id: "b",
      kind: "test/b",
      mount: () => ({ dispose: jest.fn() }),
    })
    clearRegisteredArtifactRenderers()
    expect(getRegisteredArtifactRenderers()).toHaveLength(0)
  })
})
