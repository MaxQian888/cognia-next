import { assessPluginDelivery } from "./delivery"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginConversionReport } from "./ecosystem"

const manifest = {
  id: "research",
  capabilities: ["tools", "configuration", "bot"],
} as PluginManifest
const blocked: PluginConversionReport = {
  fidelity: "unsupported",
  converted: [],
  warnings: [],
  blocking: [
    { capability: "tools", path: "tools", message: "Runtime code needs Cognia", blocking: true },
  ],
}

describe("plugin delivery assessment", () => {
  it("offers hosted tools without claiming the UI or bot lifecycle transfers", () => {
    const result = assessPluginDelivery({ manifest, report: blocked, target: "codex" })
    expect(result.native).toBe("blocked")
    expect(result.hosted).toEqual({
      status: "requires-cognia",
      capabilities: ["tools"],
      retained: ["configuration", "bot"],
    })
    expect(result.hostVerified).toBe(false)
    expect(result.capabilities).toContainEqual({ capability: "tools", status: "hosted" })
  })

  it("distinguishes required configuration, contextual changes and native contributions", () => {
    const report: PluginConversionReport = {
      fidelity: "contextual",
      converted: [],
      blocking: [{ capability: "agents", path: "agents", message: "Unsupported", blocking: true }],
      warnings: [
        { capability: "commands", path: "commands", message: "Context only", blocking: false },
      ],
    }
    const result = assessPluginDelivery({
      target: "cognia",
      report,
      manifest: {
        ...manifest,
        capabilities: ["skills", "mcp-server-preset"],
        mcpServerPresets: [
          {
            id: "api",
            name: "API",
            transport: "http",
            config: {},
            fields: [{ key: "token", label: "Token", secret: true, placement: "env" }],
          },
        ],
      },
    })
    expect(result.capabilities).toEqual(
      expect.arrayContaining([
        { capability: "skills", status: "unverified" },
        { capability: "mcp-server-preset", status: "configuration-required" },
        { capability: "commands", status: "contextual" },
        { capability: "subagent", status: "unsupported" },
      ])
    )
  })

  it("aggregates unsupported skill controls into the skill capability", () => {
    const result = assessPluginDelivery({
      target: "opencode",
      manifest: { ...manifest, capabilities: ["skills"] },
      report: {
        ...blocked,
        blocking: [
          {
            capability: "skill-invocation",
            path: "skills/manual/SKILL.md",
            message: "Invocation control requires adaptation",
            blocking: true,
          },
        ],
      },
    })
    expect(result.capabilities).toEqual([{ capability: "skills", status: "unsupported" }])
  })

  it("does not advertise a local tool host to a cloud agent", () => {
    expect(
      assessPluginDelivery({ manifest, report: blocked, target: "codex", surface: "cloud" }).hosted
        .status
    ).toBe("unverified")
  })

  it("keeps native success separate from installed-host verification", () => {
    const report: PluginConversionReport = {
      fidelity: "structured",
      converted: [],
      warnings: [],
      blocking: [],
    }
    expect(assessPluginDelivery({ report, target: "claude-code" })).toMatchObject({
      native: "ready",
      hostVerified: false,
      hosted: { status: "unavailable" },
    })
    expect(
      assessPluginDelivery({
        report: {
          ...report,
          warnings: [
            { capability: "config", path: "config", message: "Configure", blocking: false },
          ],
        },
        target: "codex",
      }).native
    ).toBe("review-required")
  })

  it("never claims a new platform has a verified Cognia tool-host route", () => {
    expect(
      assessPluginDelivery({ manifest, report: blocked, target: "cursor" }).hosted.status
    ).toBe("unverified")
    expect(
      assessPluginDelivery({ manifest, report: blocked, target: "cognia" }).hosted.status
    ).toBe("unavailable")
    expect(
      assessPluginDelivery({
        manifest: { ...manifest, capabilities: ["bot"] },
        report: blocked,
        target: "codex",
      }).hosted.status
    ).toBe("unavailable")
  })
})
