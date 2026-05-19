import React from "react"
import {
  registerMessageRenderersForPlugin,
  unregisterMessageRenderersForPlugin,
} from "./message-renderer-bridge"
import {
  clearAllMessagePartRenderers,
  getMessagePartRenderer,
} from "@/lib/plugin/api/message-part-renderers"
import type { PluginManifest } from "@/types/plugin/plugin"

const manifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  ({
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.js",
    ...overrides,
  }) as PluginManifest

const FakeRenderer: React.FC<{ part: { type: string } }> = ({ part }) =>
  React.createElement("div", null, part.type)

describe("message-renderer-bridge", () => {
  beforeEach(() => {
    clearAllMessagePartRenderers()
  })

  it("registers a renderer keyed by partType", async () => {
    const m = manifest({
      messageRenderers: [{ partType: "x-custom-foo", entry: "renderer.js", export: "FooRenderer" }],
    })
    const importer = jest.fn(async () => ({ FooRenderer: FakeRenderer }))
    const result = await registerMessageRenderersForPlugin(m, "/plugins/p", { importer })
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(getMessagePartRenderer("x-custom-foo")?.pluginId).toBe("p")
  })

  it("rejects reserved partTypes", async () => {
    const m = manifest({
      messageRenderers: [
        { partType: "tool-call", entry: "r.js", export: "R" },
        { partType: "text", entry: "r.js", export: "R" },
      ],
    })
    const importer = jest.fn(async () => ({ R: FakeRenderer }))
    const result = await registerMessageRenderersForPlugin(m, "/plugins/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.every((e) => /reserved/i.test(e.message))).toBe(true)
  })

  it("unregister tears down every contributed renderer", async () => {
    const m = manifest({
      messageRenderers: [{ partType: "x-thing", entry: "r.js", export: "R" }],
    })
    const importer = jest.fn(async () => ({ R: FakeRenderer }))
    await registerMessageRenderersForPlugin(m, "/plugins/p", { importer })
    expect(getMessagePartRenderer("x-thing")).toBeDefined()
    unregisterMessageRenderersForPlugin("p")
    expect(getMessagePartRenderer("x-thing")).toBeUndefined()
  })
})
