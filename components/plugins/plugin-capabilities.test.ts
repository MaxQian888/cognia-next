import { CANONICAL_PLUGIN_CAPABILITIES } from "@/packages/plugin-sdk/src/contracts/catalog"
import {
  CAPABILITY_META,
  CAPABILITY_IDS,
  capabilityLabel,
  capabilityLabelKey,
} from "./plugin-capabilities"

describe("CAPABILITY_META", () => {
  it("has unique capability ids", () => {
    const ids = CAPABILITY_META.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("exposes an icon and i18nKey for every entry", () => {
    for (const meta of CAPABILITY_META) {
      expect(typeof meta.id).toBe("string")
      expect(typeof meta.i18nKey).toBe("string")
      expect(meta.icon).toBeDefined()
    }
  })

  it("CAPABILITY_IDS mirrors the meta ids in order", () => {
    expect(CAPABILITY_IDS).toEqual(CAPABILITY_META.map((c) => c.id))
  })

  it("covers the capabilities both the rail and the filter sheet need", () => {
    // Union that the sidebar (14) and the filter sheet (18) used to hardcode
    // separately. A regression here means the two surfaces could drift again.
    const required = [
      "tools",
      "components",
      "modes",
      "themes",
      "commands",
      "hooks",
      "skills",
      "media",
      "canvas",
      "a2ui",
      "ai-provider",
      "providers",
      "processors",
      "scheduler",
      "exporters",
      "importers",
      "python",
      "external-agent-preset",
    ]
    for (const id of required) {
      expect(CAPABILITY_IDS).toContain(id)
    }
  })
})

describe("capability names", () => {
  // Read the split sources directly: the aggregates are generated and may lag
  // behind a branch that has not run `pnpm i18n:build` yet.
  const read = (locale: string) =>
    JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("fs").readFileSync(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("path").join(process.cwd(), `i18n/messages/${locale}/plugins/categorySidebar.json`),
        "utf8"
      )
    ) as Record<string, Record<string, string>>

  const lookup = (messages: Record<string, unknown>, key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages)

  it.each(["en", "zh-CN"])("names every capability the SDK catalog defines (%s)", (locale) => {
    const messages = read(locale)
    const missing = CANONICAL_PLUGIN_CAPABILITIES.filter((id) => {
      const key = capabilityLabelKey(id)
      return !key || typeof lookup(messages, key) !== "string"
    })
    expect(missing).toEqual([])
  })

  it("prefers the curated rail label and falls back to the raw id for unknown ids", () => {
    expect(capabilityLabelKey("tools")).toBe("capability.tools")
    expect(capabilityLabelKey("external-agent-preset")).toBe("capability.agentPresets")
    expect(capabilityLabelKey("agent-team-template")).toBe("capabilityName.agent-team-template")
    expect(capabilityLabelKey("from-a-newer-sdk")).toBeNull()
    const t = ((key: string) => `t:${key}`) as never
    expect(capabilityLabel(t, "glance")).toEqual({ label: "t:capabilityName.glance", known: true })
    expect(capabilityLabel(t, "from-a-newer-sdk")).toEqual({
      label: "from-a-newer-sdk",
      known: false,
    })
  })
})
