import {
  convertPluginBundle,
  detectPluginEcosystem,
  UnsupportedPluginConversionError,
} from "./ecosystem"
import { AGENT_PLUGINS_SCHEMA, type PlatformBundleTarget } from "./platform-bundles"

const source = () =>
  new Map([
    [
      "plugin.json",
      JSON.stringify({
        id: "portable-review",
        name: "Review",
        version: "1.0.0",
        type: "frontend",
        capabilities: ["skills"],
        skills: [
          {
            id: "review",
            name: "Review",
            description: "Review",
            source: { kind: "local-bundle", path: "skills/review" },
          },
        ],
      }),
    ],
    ["skills/review/SKILL.md", "---\nname: review\ndescription: Review\n---\nRead assets/ref.png."],
    ["skills/review/assets/ref.png", ""],
  ])

describe("native platform integration", () => {
  it("distinguishes portable and Cognia root manifests", () => {
    expect(
      detectPluginEcosystem(
        new Map([
          [
            "plugin.json",
            JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name: "review", version: "1.0.0" }),
          ],
        ])
      )
    ).toBe("agent-plugins")
    expect(detectPluginEcosystem(source())).toBe("cognia")
  })

  it.each<PlatformBundleTarget>([
    "agent-plugins",
    "cursor",
    "copilot",
    "kimi",
    "devin",
    "opencode",
    "pi",
  ])("exports and reimports a complete skill resource bundle for %s", (target) => {
    const result = convertPluginBundle(source(), target, {
      binaryPaths: new Set(["skills/review/assets/ref.png"]),
    })
    expect(result.target).toBe(target)
    expect(result.report.delivery).toMatchObject({ target, hostVerified: false })
    const path =
      target === "opencode"
        ? ".opencode/skills/review/assets/ref.png"
        : "skills/review/assets/ref.png"
    expect(result.copies).toContainEqual({ from: "skills/review/assets/ref.png", to: path })
    const exported = new Map(result.files)
    for (const copy of result.copies) exported.set(copy.to, "")
    const imported = convertPluginBundle(exported, "cognia", { binaryPaths: new Set([path]) })
    expect(imported.manifest.skills).toHaveLength(1)
    expect(imported.report.blocking).toEqual([])
  })

  it("converts foreign bundles through the canonical contract with source warnings preserved", () => {
    const files = new Map([
      [".claude-plugin/plugin.json", JSON.stringify({ name: "review", version: "1.0.0" })],
      ["skills/review/SKILL.md", "---\nname: review\ndescription: Review\n---\nReview."],
    ])
    expect(convertPluginBundle(files, "codex")).toMatchObject({
      source: "claude-code",
      target: "codex",
      report: { blocking: [] },
    })
  })

  it("reports unsupported platform behavior before generating a misleading Cognia manifest", () => {
    const files = new Map([
      [
        ".cursor-plugin/plugin.json",
        JSON.stringify({ name: "review", version: "1.0.0", hooks: "./hooks/hooks.json" }),
      ],
    ])
    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
  })

  it("rejects ambiguous native package markers and absolute snapshot paths", () => {
    expect(() =>
      detectPluginEcosystem(
        new Map([
          [".cursor-plugin/plugin.json", "{}"],
          [".claude-plugin/plugin.json", "{}"],
        ])
      )
    ).toThrow(/multiple|ambiguous/i)
    const files = source()
    files.set("/etc/example", "x")
    expect(() => convertPluginBundle(files, "codex")).toThrow(/path/i)
  })
})
