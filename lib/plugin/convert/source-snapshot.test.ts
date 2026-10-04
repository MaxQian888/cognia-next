import { convertPluginBundle } from "./ecosystem"
import {
  GENERATED_FILE_PATHS,
  NEUTRALIZED_CONTENTS,
  generatedFilesFrom,
  isOverlayEntryAllowed,
  isSnapshotTextFile,
  isPluginEnvironmentFile,
  MAX_SNAPSHOT_ENTRIES,
  MAX_TEXT_FILE_BYTES,
  SNAPSHOT_SKIP_DIRS,
} from "./source-snapshot"

describe("isSnapshotTextFile", () => {
  it.each(["plugin.json", "a/b/SKILL.md", "src/index.ts", "hooks/run.sh", "config.toml"])(
    "reads %s as text",
    (path) => expect(isSnapshotTextFile(path)).toBe(true)
  )

  it.each(["logo.png", "bin/tool", "assets/font.woff2", "archive.zip"])("placeholds %s", (path) =>
    expect(isSnapshotTextFile(path)).toBe(false)
  )
})

describe("skip list", () => {
  it("skips the directories that would blow the entry budget", () => {
    // Pointing Load unpacked at a repo checkout is a plausible mistake, and
    // node_modules alone exceeds the entry cap before the walk reaches
    // anything a converter reads.
    expect(SNAPSHOT_SKIP_DIRS.has("node_modules")).toBe(true)
    expect(SNAPSHOT_SKIP_DIRS.has(".git")).toBe(true)
  })

  it("does not skip anything a plugin bundle legitimately ships", () => {
    for (const name of ["skills", "agents", "commands", "src", "hooks", ".claude-plugin"]) {
      expect(SNAPSHOT_SKIP_DIRS.has(name)).toBe(false)
    }
  })
})

describe("limits", () => {
  it("keeps the ceilings the existing converters already enforced", () => {
    expect(MAX_SNAPSHOT_ENTRIES).toBe(2_000)
    expect(MAX_TEXT_FILE_BYTES).toBe(1_000_000)
  })
})

describe("generatedFilesFrom", () => {
  it("overlays sanitized environment placeholders but not binary assets", () => {
    const snapshot = new Map([
      [".env", ""],
      ["assets/data.bin", ""],
    ])
    expect(
      generatedFilesFrom(
        snapshot,
        new Map([
          [".env", "\n"],
          ["assets/data.bin", ""],
        ])
      )
    ).toEqual({ ".env": "\n" })
  })
  it("returns only what conversion changed", () => {
    const snapshot = new Map([
      ["README.md", "same"],
      [".claude-plugin/plugin.json", "{}"],
    ])
    const converted = new Map([
      ["README.md", "same"],
      ["plugin.json", '{"id":"x"}'],
    ])
    expect(generatedFilesFrom(snapshot, converted)).toEqual({ "plugin.json": '{"id":"x"}' })
  })

  it("counts a rewritten file as generated", () => {
    expect(
      generatedFilesFrom(new Map([["plugin.json", "old"]]), new Map([["plugin.json", "new"]]))
    ).toEqual({ "plugin.json": "new" })
  })

  it("returns nothing when conversion changed nothing", () => {
    const same = new Map([["plugin.json", "{}"]])
    expect(generatedFilesFrom(same, same)).toEqual({})
  })

  it("treats a binary placeholder as unchanged", () => {
    // Both sides carry "" for a non-text file, so it must not be overlaid.
    const snapshot = new Map([["assets/icon.png", ""]])
    expect(generatedFilesFrom(snapshot, new Map([["assets/icon.png", ""]]))).toEqual({})
  })

  it("only emits what the Rust overlay contract accepts", () => {
    const snapshot = new Map([
      [".mcp.json", '{"mcpServers":{}}'],
      ["skills/a/SKILL.md", "body"],
    ])
    expect(
      generatedFilesFrom(
        snapshot,
        new Map([
          [".mcp.json", "{}\n"],
          ["dist/index.js", "x"],
        ])
      )
    ).toEqual({ ".mcp.json": "{}\n", "dist/index.js": "x" })
    // A new file, even with neutral content, or chosen content over a source file.
    expect(() => generatedFilesFrom(snapshot, new Map([["new.json", "{}\n"]]))).toThrow(
      /cannot overlay: new.json/
    )
    expect(() =>
      generatedFilesFrom(snapshot, new Map([["skills/a/SKILL.md", "rewritten"]]))
    ).toThrow(/skills\/a\/SKILL.md/)
    expect(isOverlayEntryAllowed(snapshot, ".mcp.json", "{ }\n")).toBe(false)
    expect(GENERATED_FILE_PATHS).toEqual(["plugin.json", "dist/index.js"])
    expect(NEUTRALIZED_CONTENTS).toEqual(["{}\n", "\n"])
  })
})

describe("converted bundles fit the installer overlay contract", () => {
  const json = JSON.stringify
  const skill = "---\nname: review\ndescription: Review\n---\nReview."
  it.each<[string, Record<string, string>]>([
    [
      "claude-code",
      {
        ".claude-plugin/plugin.json": json({
          name: "kit",
          mcpServers: { inline: { command: "npx", env: { TOKEN: "literal-secret" } } },
        }),
        ".mcp.json": json({ mcpServers: { docs: { command: "npx", env: { KEY: "secret-2" } } } }),
        ".env": "",
        "skills/review/SKILL.md": skill,
      },
    ],
    [
      "cursor",
      {
        ".cursor-plugin/plugin.json": json({ name: "kit" }),
        ".claude-plugin/plugin.json": json({ name: "kit" }),
        "mcp.json": json({ mcpServers: { docs: { command: "npx" } } }),
        "skills/review/SKILL.md": skill,
      },
    ],
    [
      "factory-droid",
      {
        ".factory-plugin/plugin.json": json({ name: "kit" }),
        "mcp.json": json({ mcpServers: { docs: { command: "npx" } } }),
        "skills/review/SKILL.md": skill,
      },
    ],
    [
      "kimi",
      {
        "plugin.json": json({ name: "kit", version: "1.0.0", tools: [] }),
        "SKILL.md": skill.replace("description:", "disableModelInvocation: true\ndescription:"),
      },
    ],
    [
      "devin",
      {
        ".devin-plugin/plugin.json": json({ name: "kit" }),
        ".mcp.json": json({ mcpServers: { docs: { command: "npx" } } }),
        "skills/review/SKILL.md": skill.replace("description:", "triggers: [user]\ndescription:"),
        "skills/review/notes.md": "resource",
      },
    ],
    [
      "gemini-cli",
      {
        "gemini-extension.json": json({
          name: "kit",
          version: "1.0.0",
          mcpServers: { s: { command: "npx", args: ["${extensionPath}${/}s.js"] } },
        }),
        "s.js": "",
      },
    ],
  ])("%s", (ecosystem, tree) => {
    const snapshot = new Map(Object.entries(tree))
    const converted = convertPluginBundle(snapshot, "cognia", {
      binaryPaths: new Set(snapshot.has(".env") ? [".env"] : []),
    })
    expect(converted.source).toBe(ecosystem)
    const overlay = generatedFilesFrom(snapshot, converted.files)
    for (const [path, contents] of Object.entries(overlay))
      expect(isOverlayEntryAllowed(snapshot, path, contents)).toBe(true)
    expect(Object.keys(overlay)).toEqual(expect.arrayContaining(["plugin.json", "dist/index.js"]))
    // No raw credential survives anywhere in the installed tree.
    const installed = new Map([...snapshot, ...Object.entries(overlay)])
    expect([...installed.values()].join("\n")).not.toMatch(/literal-secret|secret-2/)
    if (snapshot.has(".env")) expect(overlay[".env"]).toBe("\n")
  })
})

describe("isPluginEnvironmentFile", () => {
  it.each([".env", ".env.local", "skills/review/.env.production"])("recognizes %s", (path) => {
    expect(isPluginEnvironmentFile(path)).toBe(true)
  })
  it.each(["environment.json", "assets/.environment", "env", "x.env"])(
    "leaves %s intact",
    (path) => {
      expect(isPluginEnvironmentFile(path)).toBe(false)
    }
  )
})
