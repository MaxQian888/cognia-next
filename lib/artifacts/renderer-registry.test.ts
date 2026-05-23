import {
  registerArtifactRenderer,
  resolveRegisteredArtifactRenderer,
  getRegisteredArtifactRenderers,
  clearRegisteredArtifactRenderers,
  type PluginArtifactRenderer,
} from "./renderer-registry"
import { loggers } from "@/lib/logging"
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

  it("registers and resolves a renderer by canRender result", () => {
    const claimed: PluginArtifactRenderer = {
      id: "p-html",
      canRender: (a) => a.type === "html",
      render: () => null,
    }
    registerArtifactRenderer(claimed.id, claimed)
    const resolved = resolveRegisteredArtifactRenderer(dummyArtifact({ type: "html" }))
    expect(resolved).toBe(claimed)
    expect(resolveRegisteredArtifactRenderer(dummyArtifact({ type: "code" }))).toBeNull()
  })

  it("getRegisteredArtifactRenderers returns the registered set", () => {
    const r: PluginArtifactRenderer = {
      id: "any",
      canRender: () => true,
      render: () => null,
    }
    registerArtifactRenderer("any", r)
    expect(getRegisteredArtifactRenderers()).toEqual([r])
  })

  it("returned dispose function removes the renderer", () => {
    const r: PluginArtifactRenderer = {
      id: "x",
      canRender: () => true,
      render: () => null,
    }
    const dispose = registerArtifactRenderer("x", r)
    dispose()
    expect(getRegisteredArtifactRenderers()).toHaveLength(0)
  })

  it("treats canRender exceptions as a non-claim and logs a warning", () => {
    const warnSpy = jest.spyOn(loggers.plugin, "warn").mockImplementation()
    const r: PluginArtifactRenderer = {
      id: "boom",
      canRender: () => {
        throw new Error("nope")
      },
      render: () => null,
    }
    registerArtifactRenderer("boom", r)
    expect(resolveRegisteredArtifactRenderer(dummyArtifact())).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      "artifacts.plugin.canRender-failed",
      expect.objectContaining({ rendererId: "boom" })
    )
    warnSpy.mockRestore()
  })

  it("clearRegisteredArtifactRenderers wipes the set", () => {
    registerArtifactRenderer("a", {
      id: "a",
      canRender: () => true,
      render: () => null,
    })
    registerArtifactRenderer("b", {
      id: "b",
      canRender: () => true,
      render: () => null,
    })
    clearRegisteredArtifactRenderers()
    expect(getRegisteredArtifactRenderers()).toHaveLength(0)
  })
})
