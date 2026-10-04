import {
  CLAUDE_FAMILY_PROFILES,
  claudeFamilyManifestPath,
  projectClaudeFamilyBundle,
  replaceRootTokens,
} from "./claude-family"
import { UnsupportedPluginConversionError, convertPluginBundle } from "./ecosystem"

const json = JSON.stringify
const files = (entries: Record<string, string>) => new Map(Object.entries(entries))
const skill = "---\nname: review\ndescription: Review changes\n---\nReview every line."
const agent = (extra = "") =>
  `---\nname: reviewer\ndescription: Review code\n${extra}---\nYou review code.`

function blockingOf(run: () => unknown): string[] {
  try {
    run()
  } catch (error) {
    if (error instanceof UnsupportedPluginConversionError)
      return error.report.blocking.map((issue) => `${issue.path}: ${issue.message}`)
    throw error
  }
  return []
}

describe("Claude-family profiles", () => {
  it("reads manifests in each host's own order", () => {
    expect(
      claudeFamilyManifestPath(
        files({ ".workbuddy-plugin/plugin.json": "{}", ".codebuddy-plugin/plugin.json": "{}" }),
        CLAUDE_FAMILY_PROFILES.codebuddy
      )
    ).toBe(".codebuddy-plugin/plugin.json")
    expect(
      claudeFamilyManifestPath(
        files({ ".goose-plugin/plugin.json": "{}" }),
        CLAUDE_FAMILY_PROFILES["open-plugins"]
      )
    ).toBe(".goose-plugin/plugin.json")
  })

  it("replaces braced tokens and bare environment references without touching longer names", () => {
    expect(
      replaceRootTokens(
        {
          command: "$DROID_PLUGIN_ROOT/x.sh",
          args: ["${DROID_PLUGIN_ROOT}/y", "$DROID_PLUGIN_ROOT_EXTRA"],
        },
        ["${DROID_PLUGIN_ROOT}"],
        ["DROID_PLUGIN_ROOT"],
        "${COGNIA_PLUGIN_ROOT}"
      )
    ).toEqual({
      command: "${COGNIA_PLUGIN_ROOT}/x.sh",
      args: ["${COGNIA_PLUGIN_ROOT}/y", "$DROID_PLUGIN_ROOT_EXTRA"],
    })
  })
})

describe("Factory Droid", () => {
  const droid = (extra: Record<string, string> = {}) =>
    files({
      ".factory-plugin/plugin.json": json({
        name: "review-kit",
        version: "1.0.0",
        skills: "./custom",
      }),
      "skills/review/SKILL.md": skill,
      "droids/reviewer.md": agent("model: inherit\n"),
      "commands/check.md": "---\ndescription: Check\n---\nCheck the diff.",
      "hooks/hooks.json": json({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "${DROID_PLUGIN_ROOT}/boot.sh", timeout: 5 }] },
          ],
        },
      }),
      "boot.sh": "#!/bin/sh",
      "mcp.json": json({
        mcpServers: { docs: { command: "node", args: ["$DROID_PLUGIN_ROOT/srv.js"] } },
      }),
      "srv.js": "process.exit(0)",
      ...extra,
    })

  it("imports droids, commands, hooks and mcp.json by convention", () => {
    const result = convertPluginBundle(droid(), "cognia")
    expect(result.source).toBe("factory-droid")
    expect(result.manifest.skills?.map((entry) => entry.id).sort()).toEqual(["check", "review"])
    expect(result.manifest.subagents).toEqual([
      expect.objectContaining({ id: "reviewer", description: "Review code" }),
    ])
    expect(result.manifest.subagents?.[0].model).toBeUndefined()
    expect(result.manifest.commandHooks?.SessionStart?.[0].hooks[0]).toMatchObject({
      command: "${COGNIA_PLUGIN_ROOT}/boot.sh",
      timeout: 5,
    })
    expect(result.manifest.mcpServerPresets?.[0].config.args).toEqual([
      "${COGNIA_PLUGIN_ROOT}/srv.js",
    ])
    // Droid does not read manifest component paths; the field is reported, not followed.
    expect(result.report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "skills",
          path: ".factory-plugin/plugin.json.skills",
        }),
      ])
    )
    expect(result.files.get(".factory-plugin/plugin.json")).toBe("{}\n")
  })

  it.each([
    [
      { "droids/reviewer.md": agent("model: sonnet\n") },
      /agent fields have no exact Cognia equivalent: model/,
    ],
    [{ "droids/reviewer.md": agent('tools: ["Read"]\n') }, /tools/],
    [{ "commands/deploy": "#!/bin/sh" }, /executable command files/],
    [{ "output-styles/terse.md": "Be terse" }, /output styles/i],
    [
      {
        "hooks/hooks.json": json({
          hooks: {
            PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "x.sh" }] }],
          },
        }),
      },
      /own tool or event vocabulary/,
    ],
    [
      {
        "hooks/hooks.json": json({
          hooks: { TaskCreated: [{ hooks: [{ type: "command", command: "x.sh" }] }] },
        }),
      },
      /TaskCreated/,
    ],
  ])("blocks Droid behavior without an exact mapping %#", (extra, message) => {
    expect(blockingOf(() => convertPluginBundle(droid(extra), "cognia")).join("\n")).toMatch(
      message
    )
  })

  it("exports to the native Droid layout and reimports", () => {
    const imported = convertPluginBundle(droid({ "droids/reviewer.md": agent() }), "cognia")
    const exported = convertPluginBundle(imported.files, "factory-droid")
    expect(exported.files.has(".factory-plugin/plugin.json")).toBe(true)
    expect(exported.files.has(".claude-plugin/plugin.json")).toBe(false)
    expect(exported.files.get("droids/reviewer.md")).toContain("description: Review code")
    expect(JSON.parse(exported.files.get("mcp.json")!).mcpServers.docs.args).toEqual([
      "${DROID_PLUGIN_ROOT}/srv.js",
    ])
    expect(exported.files.get("hooks/hooks.json")).toContain("${DROID_PLUGIN_ROOT}/boot.sh")
    expect(exported.report.warnings.map((issue) => issue.message).join("\n")).toMatch(
      /own tool names/
    )
    const again = convertPluginBundle(exported.files, "cognia")
    expect(again.source).toBe("factory-droid")
    expect(again.manifest.subagents).toHaveLength(1)
  })
})

describe("Qoder, CodeBuddy, Auggie and Open Plugins", () => {
  it("imports Qoder with its own root variable and blocks bin/ and unknown keys", () => {
    const qoder = files({
      ".qoder-plugin/plugin.json": json({ name: "kit", hooks: "./custom-hooks.json" }),
      "custom-hooks.json": json({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: '"${QODER_PLUGIN_ROOT}"/check.sh' }],
            },
          ],
        },
      }),
      "hooks/hooks.json": json({ hooks: { Unknown: [] } }),
      "check.sh": "#!/bin/sh",
      "skills/review/SKILL.md": skill,
    })
    const result = convertPluginBundle(qoder, "cognia")
    expect(result.source).toBe("qoder")
    // Declared hooks replace the conventional file.
    expect(result.manifest.commandHooks?.PreToolUse?.[0]).toMatchObject({
      matcher: "Bash",
      hooks: [{ command: '"${COGNIA_PLUGIN_ROOT}"/check.sh' }],
    })
    qoder.set("bin/tool", "")
    qoder.set(".qoder-plugin/plugin.json", json({ name: "kit", future: true }))
    expect(blockingOf(() => convertPluginBundle(qoder, "cognia")).join("\n")).toMatch(/bin\//)
    expect(blockingOf(() => convertPluginBundle(qoder, "cognia")).join("\n")).toMatch(/future/)
  })

  it("maps CodeBuddy agent effort and turn limits exactly and blocks model routing", () => {
    const codebuddy = files({
      ".codebuddy-plugin/plugin.json": json({ name: "kit", defaultEnabled: true }),
      "agents/reviewer.md": agent("effort: high\nmaxTurns: 4\n"),
    })
    const result = convertPluginBundle(codebuddy, "cognia")
    expect(result.manifest.subagents?.[0]).toMatchObject({ effort: "high", maxTurns: 4 })
    expect(result.report.warnings.map((issue) => issue.capability)).toContain("defaultEnabled")
    codebuddy.set("agents/reviewer.md", agent("model: sonnet\n"))
    expect(blockingOf(() => convertPluginBundle(codebuddy, "cognia")).join("\n")).toMatch(/model/)
    codebuddy.set(".codebuddy-plugin/plugin.json", json({ name: "Not Kebab" }))
    codebuddy.set("agents/reviewer.md", agent())
    expect(
      convertPluginBundle(codebuddy, "cognia").report.warnings.map((issue) => issue.capability)
    ).toContain("name")
  })

  it("refuses Auggie declarations whose merge semantics are undocumented", () => {
    const auggie = files({
      ".augment-plugin/plugin.json": json({ name: "kit", skills: "./extra" }),
      "extra/one/SKILL.md": skill,
      "skills/two/SKILL.md": skill.replace("name: review", "name: two"),
    })
    expect(blockingOf(() => convertPluginBundle(auggie, "cognia")).join("\n")).toMatch(
      /does not document whether/
    )
    auggie.set(".augment-plugin/plugin.json", json({ name: "kit" }))
    auggie.set("rules/style.md", "Use tabs")
    expect(blockingOf(() => convertPluginBundle(auggie, "cognia")).join("\n")).toMatch(/rules/)
  })

  it("exports Auggie hooks only as script files with millisecond timeouts", () => {
    const cognia = (command: string) =>
      files({
        "plugin.json": json({
          id: "kit",
          name: "Kit",
          version: "1.0.0",
          type: "frontend",
          capabilities: ["command-hooks"],
          commandHooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 2 }] }] },
        }),
        "stop.sh": "#!/bin/sh",
      })
    const ok = convertPluginBundle(cognia("${COGNIA_PLUGIN_ROOT}/stop.sh"), "auggie")
    expect(JSON.parse(ok.files.get("hooks/hooks.json")!)).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "${AUGMENT_PLUGIN_ROOT}/stop.sh", timeout: 2000 }],
          },
        ],
      },
    })
    expect(ok.files.has(".augment-plugin/plugin.json")).toBe(true)
    expect(blockingOf(() => convertPluginBundle(cognia("echo done"), "auggie")).join("\n")).toMatch(
      /script files only/
    )
  })

  it("imports the legacy OpenPlugin layout with .agent.md ids and blocks agent export", () => {
    const open = files({
      ".plugin/plugin.json": json({ name: "kit", version: "1.0.0" }),
      "agents/reviewer.agent.md": agent(),
      "hooks/hooks.json": json({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "${PLUGIN_ROOT}/done.sh" }] }] },
      }),
      "done.sh": "#!/bin/sh",
    })
    const imported = convertPluginBundle(open, "cognia")
    expect(imported.source).toBe("open-plugins")
    expect(imported.manifest.subagents?.[0].id).toBe("reviewer")
    expect(imported.manifest.commandHooks?.Stop?.[0].hooks[0]).toMatchObject({
      command: "${COGNIA_PLUGIN_ROOT}/done.sh",
    })
    expect(
      blockingOf(() => convertPluginBundle(imported.files, "open-plugins")).join("\n")
    ).toMatch(/disagree on agent files/)
    open.delete("agents/reviewer.agent.md")
    const exported = convertPluginBundle(convertPluginBundle(open, "cognia").files, "open-plugins")
    expect(exported.files.get("hooks/hooks.json")).toContain("${PLUGIN_ROOT}/done.sh")
    open.set(
      "skills/review/SKILL.md",
      "---\nname: review\ndescription: R\ntrigger:\n  type: keyword\n---\nBody"
    )
    expect(blockingOf(() => convertPluginBundle(open, "cognia")).join("\n")).toMatch(/trigger/)
  })
})

describe("projectClaudeFamilyBundle", () => {
  const claudeExport = (extra: Record<string, string> = {}) =>
    files({
      ".claude-plugin/plugin.json": json({
        name: "kit",
        version: "1.0.0",
        mcpServers: "./.mcp.json",
      }),
      ".mcp.json": json({
        mcpServers: {
          docs: { type: "stdio", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"] },
        },
      }),
      ...extra,
    })

  it("is the identity for Claude Code", () => {
    const input = claudeExport()
    expect(projectClaudeFamilyBundle(input, CLAUDE_FAMILY_PROFILES["claude-code"]).files).toEqual(
      input
    )
  })

  it("rewrites roots for hosts without a Claude alias and blocks stray Claude references", () => {
    const qoder = projectClaudeFamilyBundle(
      claudeExport({ "scripts/run.sh": "cd ${CLAUDE_PLUGIN_ROOT}" }),
      CLAUDE_FAMILY_PROFILES.qoder
    )
    expect(qoder.files.get(".mcp.json")).toContain("${QODER_PLUGIN_ROOT}/s.js")
    expect(qoder.blocking.map((issue) => issue.path)).toEqual(["scripts/run.sh"])
    const codebuddy = projectClaudeFamilyBundle(
      claudeExport({ "scripts/run.sh": "cd ${CLAUDE_PLUGIN_ROOT}" }),
      CLAUDE_FAMILY_PROFILES.codebuddy
    )
    expect(codebuddy.blocking).toEqual([])
    expect(codebuddy.files.get(".codebuddy-plugin/plugin.json")).toContain('"name": "kit"')
  })

  it("blocks invalid names, unmapped agent fields and plugin-root MCP for legacy OpenPlugin", () => {
    const result = projectClaudeFamilyBundle(
      files({
        ".claude-plugin/plugin.json": json({ name: "Not Kebab" }),
        "agents/a.md": agent("model: sonnet\n"),
      }),
      CLAUDE_FAMILY_PROFILES.codebuddy
    )
    expect(result.blocking.map((issue) => issue.capability).sort()).toEqual(["name", "subagent"])
    const open = projectClaudeFamilyBundle(claudeExport(), CLAUDE_FAMILY_PROFILES["open-plugins"])
    expect(open.blocking.map((issue) => issue.message).join("\n")).toMatch(/plugin-root expansion/)
    expect(
      projectClaudeFamilyBundle(files({}), CLAUDE_FAMILY_PROFILES.auggie).blocking
    ).toHaveLength(1)
  })
})
