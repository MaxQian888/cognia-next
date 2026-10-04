import { detectPluginBundle, VENDOR_MANIFEST_PATHS } from "./bundle-detection"

const json = JSON.stringify
const files = (entries: Record<string, string>) => new Map(Object.entries(entries))
const AP = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json"

describe("plugin bundle detection", () => {
  it.each([
    [{ "plugin.json": json({ id: "x", type: "frontend" }) }, "cognia"],
    [{ "plugin.json": json({ id: "x", name: "Draft" }) }, "cognia"],
    [{ ".claude-plugin/plugin.json": json({ name: "x" }) }, "claude-code"],
    [{ ".codex-plugin/plugin.json": json({ name: "x" }) }, "codex"],
    [{ "gemini-extension.json": json({ name: "x" }) }, "gemini-cli"],
    [{ "plugin.json": json({ $schema: AP, name: "x" }) }, "agent-plugins"],
    [{ ".cursor-plugin/plugin.json": json({ name: "x" }) }, "cursor"],
    [{ ".github/plugin/plugin.json": json({ name: "x" }) }, "copilot"],
    [{ "plugin.json": json({ name: "x", skills: "./skills" }) }, "copilot"],
    [{ "plugin.json": json({ name: "x", version: "1.0.0", tools: [] }) }, "kimi"],
    [{ "plugin.json": json({ name: "x", config_file: "c.json" }) }, "kimi"],
    [{ ".devin-plugin/plugin.json": json({ name: "x" }) }, "devin"],
    [{ "opencode.jsonc": "{}" }, "opencode"],
    [{ "package.json": json({ name: "x", pi: {} }) }, "pi"],
    [{ "package.json": json({ name: "x", keywords: ["pi-package"] }) }, "pi"],
    [{ ".factory-plugin/plugin.json": json({ name: "x" }) }, "factory-droid"],
    [{ ".qoder-plugin/plugin.json": json({ name: "x" }) }, "qoder"],
    [{ ".codebuddy-plugin/plugin.json": json({ name: "x" }) }, "codebuddy"],
    [{ ".workbuddy-plugin/plugin.json": json({ name: "x" }) }, "codebuddy"],
    [{ ".augment-plugin/plugin.json": json({ name: "x" }) }, "auggie"],
    [{ ".plugin/plugin.json": json({ name: "x" }) }, "open-plugins"],
    [{ ".goose-plugin/plugin.json": json({ name: "x" }) }, "open-plugins"],
  ])("detects %j as %s", (entries, ecosystem) => {
    expect(detectPluginBundle(files(entries)).ecosystem).toBe(ecosystem)
  })

  it("prefers the most specific vendor manifest and reports the generic ones it shadows", () => {
    const detected = detectPluginBundle(
      files({
        ".claude-plugin/plugin.json": json({ name: "x" }),
        ".factory-plugin/plugin.json": json({ name: "x" }),
        ".plugin/plugin.json": json({ name: "x" }),
      })
    )
    expect(detected).toEqual({
      ecosystem: "factory-droid",
      manifestPath: ".factory-plugin/plugin.json",
      shadowed: [
        { path: ".plugin/plugin.json", ecosystem: "open-plugins" },
        { path: ".claude-plugin/plugin.json", ecosystem: "claude-code" },
      ],
    })
  })

  it("follows the Agent Plugins read order inside the generic tier", () => {
    expect(
      detectPluginBundle(
        files({
          "plugin.json": json({ $schema: AP, name: "x" }),
          ".claude-plugin/plugin.json": json({ name: "x" }),
        })
      )
    ).toMatchObject({
      ecosystem: "agent-plugins",
      shadowed: [{ path: ".claude-plugin/plugin.json", ecosystem: "claude-code" }],
    })
    expect(
      detectPluginBundle(
        files({
          ".plugin/plugin.json": json({ name: "x" }),
          ".claude-plugin/plugin.json": json({ name: "x" }),
        })
      ).ecosystem
    ).toBe("open-plugins")
  })

  it("refuses two different vendor-specific manifests", () => {
    expect(() =>
      detectPluginBundle(
        files({
          ".cursor-plugin/plugin.json": json({ name: "x" }),
          ".qoder-plugin/plugin.json": json({ name: "x" }),
        })
      )
    ).toThrow(/multiple plugin formats/)
  })

  it("lets a Cognia identity and active markers win over neutralized leftovers", () => {
    expect(
      detectPluginBundle(
        files({
          "plugin.json": json({ id: "x", type: "frontend" }),
          ".cursor-plugin/plugin.json": json({ name: "x" }),
        })
      ).ecosystem
    ).toBe("cognia")
    expect(
      detectPluginBundle(
        files({
          ".claude-plugin/plugin.json": "{}\n",
          ".cursor-plugin/plugin.json": json({ name: "x" }),
          ".qoder-plugin/plugin.json": "{}\n",
        })
      ).ecosystem
    ).toBe("cursor")
  })

  it.each([
    [{ "kimi.plugin.json": json({ name: "x", version: "1.0.0" }) }],
    [{ ".kimi-plugin/plugin.json": json({ name: "x" }) }],
    [{ ".github/plugin.json": json({ name: "x" }) }],
  ])("refuses undocumented legacy markers instead of misdetecting %j", (entries) => {
    // Kimi CLI reads a root plugin.json and Copilot never read .github/plugin.json.
    expect(() => detectPluginBundle(files(entries))).toThrow(/plugin format not recognized/)
  })

  it("rejects unknown schemas and unrecognized bundles", () => {
    expect(() =>
      detectPluginBundle(files({ "plugin.json": json({ $schema: "https://example.test/x" }) }))
    ).toThrow(/not a recognized/)
    expect(() => detectPluginBundle(files({ "README.md": "x" }))).toThrow(/not recognized/)
    expect(() => detectPluginBundle(files({ "plugin.json": "[]" }))).toThrow(/JSON object/)
    expect(() => detectPluginBundle(files({ "plugin.json": "not json{" }))).toThrow(/valid JSON/)
    expect(detectPluginBundle(files({ "plugin.json": "{}" })).ecosystem).toBe("cognia")
    expect(
      detectPluginBundle(files({ "package.json": json({ name: "ordinary" }), "plugin.json": "{}" }))
        .ecosystem
    ).toBe("cognia")
  })

  it("lists every vendor manifest the importer neutralizes", () => {
    expect(VENDOR_MANIFEST_PATHS).toEqual(
      expect.arrayContaining([
        ".factory-plugin/plugin.json",
        ".plugin/plugin.json",
        ".github/plugin/plugin.json",
        "gemini-extension.json",
      ])
    )
    expect(VENDOR_MANIFEST_PATHS).not.toContain("package.json")
  })
})
