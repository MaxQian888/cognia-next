const upsertMock = jest.fn(async (_record: unknown) => undefined)
const deleteByPluginMock = jest.fn(async (_pluginId: string) => 0)
jest.mock("@/lib/db/tool-routes", () => ({
  upsertToolRoute: (record: unknown) => upsertMock(record),
  deleteToolRoutesByPlugin: (pluginId: string) => deleteByPluginMock(pluginId),
  makeToolRouteId: (source: string, kind: string, refId: string) => `${source}:${kind}:${refId}`,
}))

import { registerToolRoutesForPlugin, unregisterToolRoutesForPlugin } from "./tool-routes-bridge"
import type { PluginManifest } from "@/types/plugin"

const MANIFEST = {
  id: "ripgrep-tools",
  name: "Ripgrep Tools",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: [],
  toolRoutes: [
    {
      toolName: "ripgrep_search",
      utterances: ["search the codebase", "find text in files"],
      threshold: 0.4,
    },
  ],
} as unknown as PluginManifest

beforeEach(() => {
  upsertMock.mockClear()
  deleteByPluginMock.mockClear()
})

describe("tool-routes-bridge", () => {
  it("upserts manifest routes tagged with the plugin id (replacing prior rows)", async () => {
    const result = await registerToolRoutesForPlugin(MANIFEST, "/p")
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(deleteByPluginMock).toHaveBeenCalledWith("ripgrep-tools")
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "manifest:tool:ripgrep-tools:ripgrep_search",
        kind: "tool",
        refId: "ripgrep_search",
        pluginId: "ripgrep-tools",
        utterances: ["search the codebase", "find text in files"],
        threshold: 0.4,
        enabled: true,
        source: "manifest",
      })
    )
  })

  it("collects per-entry errors (missing toolName / empty utterances) without blocking", async () => {
    const manifest = {
      ...MANIFEST,
      toolRoutes: [
        { toolName: "", utterances: ["x"] },
        { toolName: "no_utterances", utterances: ["  "] },
        { toolName: "good", utterances: ["works"] },
      ],
    } as unknown as PluginManifest
    const result = await registerToolRoutesForPlugin(manifest, "/p")
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(2)
  })

  it("no-ops without toolRoutes and cleans up on unregister", async () => {
    const result = await registerToolRoutesForPlugin(
      { ...MANIFEST, toolRoutes: undefined } as PluginManifest,
      "/p"
    )
    expect(result).toEqual({ registered: 0, errors: [] })
    expect(deleteByPluginMock).not.toHaveBeenCalled()

    await unregisterToolRoutesForPlugin("ripgrep-tools")
    expect(deleteByPluginMock).toHaveBeenCalledWith("ripgrep-tools")
  })
})
