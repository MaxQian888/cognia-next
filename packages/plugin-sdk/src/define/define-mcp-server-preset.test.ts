/**
 * `defineMcpServerPreset` is a pass-through identity function for compile-time
 * type narrowing. These tests pin the runtime invariant.
 */

import { defineMcpServerPreset } from "./define-mcp-server-preset"
import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"

describe("defineMcpServerPreset", () => {
  it("returns the same object reference passed in", () => {
    const def: PluginMcpServerPresetDef = {
      id: "playwright",
      name: "Playwright",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    }

    const result = defineMcpServerPreset(def)

    expect(result).toBe(def)
  })

  it("preserves all optional fields including runtime / docsUrl / tags", () => {
    const def: PluginMcpServerPresetDef = {
      id: "fetch",
      name: "Fetch",
      description: "HTTP fetch",
      icon: "🌐",
      transport: "http",
      config: { url: "https://mcp.example.com" },
      runtime: "ai-sdk",
      docsUrl: "https://example.com/docs",
      tags: ["web", "http"],
    }
    const out = defineMcpServerPreset(def)
    expect(out).toMatchObject({
      runtime: "ai-sdk",
      docsUrl: "https://example.com/docs",
      tags: ["web", "http"],
      icon: "🌐",
    })
  })
})
