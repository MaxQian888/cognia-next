import {
  UnsupportedPluginConversionError,
  convertPluginBundle,
  detectPluginEcosystem,
} from "./ecosystem"
import { renderDist } from "./scaffold"

function snapshot(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files))
}

describe("plugin ecosystem conversion", () => {
  it("detects and converts a complete Claude Code plugin into the Cognia canonical form", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "delivery-assistant",
        version: "1.2.3",
        description: "Release planning helpers",
        author: {
          name: "Cognia Team",
          email: "plugins@example.com",
          url: "https://example.test/team",
        },
        license: "MIT",
        keywords: ["release", "planning"],
        skills: ["./skills/release"],
        agents: ["./agents/reviewer.md"],
        mcpServers: "./.mcp.json",
      }),
      "skills/release/SKILL.md": `---
name: Release Planner
description: Build a release plan
allowed-tools: Read, Grep
---
Create a complete release plan from the current repository.
`,
      "skills/release/references/checklist.md": "# Release checklist\n",
      "agents/reviewer.md": `---
name: release-reviewer
description: Review a release plan
model: sonnet
effort: high
maxTurns: 7
tools: Read, Grep
disallowedTools: Bash
---
Review the plan for missing validation and rollback steps.
`,
      ".mcp.json": JSON.stringify({
        mcpServers: {
          releaseData: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/servers/release.js"],
            env: {
              MODE: "release",
              PLUGIN_HOME: "${CLAUDE_PLUGIN_ROOT}",
            },
          },
        },
      }),
      "servers/release.js": "process.exit(0)\n",
    })

    expect(detectPluginEcosystem(files)).toBe("claude-code")

    const result = convertPluginBundle(files, "cognia", {
      hostVersion: "0.1.0",
    })

    expect(result.source).toBe("claude-code")
    expect(result.target).toBe("cognia")
    expect(result.report.blocking).toEqual([])
    expect(result.report.fidelity).toBe("structured")
    expect(result.manifest).toMatchObject({
      id: "delivery-assistant",
      name: "delivery-assistant",
      version: "1.2.3",
      description: "Release planning helpers",
      author: { name: "Cognia Team", email: "plugins@example.com" },
      license: "MIT",
      keywords: ["release", "planning"],
      capabilities: ["skills", "subagent", "mcp-server-preset"],
      skills: [
        {
          id: "release-planner",
          name: "Release Planner",
          description: "Build a release plan",
          source: { kind: "local-bundle", path: "skills/release" },
          allowedTools: ["Read", "Grep"],
        },
      ],
      subagents: [
        {
          id: "release-reviewer",
          name: "release-reviewer",
          description: "Review a release plan",
          prompt: "Review the plan for missing validation and rollback steps.",
          model: "sonnet",
          effort: "high",
          maxTurns: 7,
          tools: ["Read", "Grep"],
          disallowedTools: ["Bash"],
        },
      ],
      mcpServerPresets: [
        {
          id: "releaseData",
          name: "releaseData",
          transport: "stdio",
          config: {
            command: "node",
            args: ["${COGNIA_PLUGIN_ROOT}/servers/release.js"],
            env: {
              MODE: "",
              PLUGIN_HOME: "${COGNIA_PLUGIN_ROOT}",
            },
          },
        },
      ],
    })
    expect(result.manifest.author?.url).toBe("https://example.test/team")
    expect(result.files.get("plugin.json")).toContain('"id": "delivery-assistant"')
    expect(result.files.get("dist/index.js")).toContain("delivery-assistant")
    expect(result.files.get("skills/release/SKILL.md")).toContain("Create a complete release plan")
    expect(result.files.get("servers/release.js")).toBe("process.exit(0)\n")
  })

  it("fails closed and reports unsupported executable Claude Code surfaces", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "unsafe-output-styles",
        version: "1.0.0",
        description: "Requires executable output styles",
        outputStyles: "./output-styles",
      }),
      "output-styles/strict.md": "# Strict output\n",
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)

    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedPluginConversionError)
      const conversionError = error as UnsupportedPluginConversionError
      expect(conversionError.report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capability: "outputStyles", path: "outputStyles" }),
        ])
      )
    }
  })

  it("converts Claude Code hooks.json into manifest.commandHooks with the command-hooks capability", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "guarded-plugin",
        version: "1.0.0",
        description: "Ships a PreToolUse guard",
      }),
      "hooks/hooks.json": JSON.stringify({
        description: "guards",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs",
                  timeout: 5,
                  async: true,
                },
              ],
            },
          ],
          SessionStart: [
            { hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/boot.mjs" }] },
          ],
        },
      }),
      "hooks/guard.mjs": "process.exit(0)\n",
      "hooks/boot.mjs": "process.exit(0)\n",
    })

    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest.capabilities).toContain("command-hooks")
    const commandHooks = result.manifest.commandHooks
    expect(commandHooks?.PreToolUse).toHaveLength(1)
    expect(commandHooks?.PreToolUse?.[0]?.matcher).toBe("Bash")
    expect(commandHooks?.PreToolUse?.[0]?.hooks?.[0]).toMatchObject({
      type: "command",
      command: "node ${COGNIA_PLUGIN_ROOT}/hooks/guard.mjs",
      timeout: 5,
      async: true,
    })
    expect(commandHooks?.SessionStart?.[0]?.hooks?.[0]).toMatchObject({
      type: "command",
      command: "node ${COGNIA_PLUGIN_ROOT}/hooks/boot.mjs",
    })
    // Hook scripts stay in the bundle as files so the commands can resolve them.
    expect(result.files.get("hooks/guard.mjs")).toContain("process.exit(0)")
    expect(result.report.converted).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "commandHooks" })])
    )
  })

  it("converts a manifest-declared hooks path and an inline hooks map", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "declared-hooks",
        hooks: "./my-hooks/config.json",
      }),
      "my-hooks/config.json": JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
        },
      }),
    })
    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest.commandHooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({
      type: "command",
      command: "echo done",
    })
  })

  it("blocks hook events with no Cognia runtime equivalent instead of silently dropping them", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "post-marketplace" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          PostMarketplace: [
            { hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/setup.mjs" }] },
          ],
        },
      }),
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      const report = (error as UnsupportedPluginConversionError).report
      expect(report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "commandHooks",
            path: "hooks/hooks.json",
            message: expect.stringContaining("PostMarketplace"),
          }),
        ])
      )
    }
  })

  it("blocks plugin-typed hook handlers that reference source-runtime code", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "in-process-hook" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "plugin", pluginId: "self", hookId: "onPreToolUse" }],
            },
          ],
        },
      }),
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      const report = (error as UnsupportedPluginConversionError).report
      expect(report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "commandHooks",
            message: expect.stringContaining('"plugin"'),
          }),
        ])
      )
    }
  })

  it("converts .codex-plugin hooks documents into commandHooks", () => {
    const files = snapshot({
      ".codex-plugin/plugin.json": JSON.stringify({ name: "codex-hooks" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: "node ${CODEX_PLUGIN_ROOT}/hooks/end.mjs" }] },
          ],
        },
      }),
      "hooks/end.mjs": "process.exit(0)\n",
    })

    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest.capabilities).toContain("command-hooks")
    expect(result.manifest.commandHooks?.SessionEnd?.[0]?.hooks?.[0]).toMatchObject({
      type: "command",
      command: "node ${COGNIA_PLUGIN_ROOT}/hooks/end.mjs",
    })
  })

  it("does not silently drop Claude Code subagent fields Cognia cannot execute", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "isolated-review",
        agents: "./agents",
      }),
      "agents/reviewer.md": `---
name: reviewer
description: Reviews in a worktree
isolation: worktree
memory: project
---
Review the current changes.
`,
    })
    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      const conversionError = error as UnsupportedPluginConversionError
      expect(conversionError.report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "agents",
            path: "agents/reviewer.md",
            message: expect.stringContaining("isolation"),
          }),
        ])
      )
    }
  })

  it("fails closed for source-runtime directories Cognia cannot reproduce", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "stateful-skill",
        skills: "./skills",
      }),
      "skills/stateful/SKILL.md": "Persist the result in ${CLAUDE_PLUGIN_DATA}/state.json.",
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      expect((error as UnsupportedPluginConversionError).report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "skills",
            path: "skills/stateful/SKILL.md",
            message: expect.stringContaining("${CLAUDE_PLUGIN_DATA}"),
          }),
        ])
      )
    }
  })

  it("does not mistake skill reference Markdown for another skill", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "skill-references",
      }),
      "skills/research/SKILL.md": "---\nname: Research\n---\nUse the checklist.",
      "skills/research/references/checklist.md": "# Checklist\n",
    })

    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest.skills).toEqual([
      expect.objectContaining({
        id: "research",
        source: { kind: "local-bundle", path: "skills/research" },
      }),
    ])
  })

  it("supports direct Markdown declarations and inline MCP objects", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "direct-declarations",
        skills: "skills/review/SKILL.md",
        commands: "commands/check.md",
        agents: "agents/reviewer.md",
        mcpServers: {
          local: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
            env: { RETRIES: 2 },
          },
        },
      }),
      "skills/review/SKILL.md": "---\nname: Review\n---\nReview.",
      "commands/check.md": "---\nname: Check\n---\nCheck.",
      "agents/reviewer.md": "---\ndescription: Review the result\n---\nReview the result.",
    })

    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest.skills).toHaveLength(2)
    expect(result.manifest.subagents).toHaveLength(1)
    expect(result.manifest.mcpServerPresets?.[0]?.config).toMatchObject({
      args: ["${COGNIA_PLUGIN_ROOT}/server.js"],
      env: { RETRIES: "" },
    })
  })

  it("discovers a root skill and fails for an explicitly missing skill", () => {
    const rootSkill = convertPluginBundle(
      snapshot({
        ".codex-plugin/plugin.json": JSON.stringify({ name: "root-skill" }),
        "skills/SKILL.md": "---\nname: Root Skill\n---\nRoot instructions.",
      }),
      "cognia"
    )
    expect(rootSkill.manifest.skills).toHaveLength(1)

    expect(() =>
      convertPluginBundle(
        snapshot({
          ".codex-plugin/plugin.json": JSON.stringify({
            name: "missing-skill",
            skills: "./skills/missing",
          }),
        }),
        "cognia"
      )
    ).toThrow(/did not contain a SKILL\.md/)
  })

  it("preserves bundled binaries without misclassifying their directory as an activation surface", () => {
    expect(
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({ name: "hidden-runtime" }),
          "bin/run.sh": "#!/bin/sh",
        }),
        "cognia"
      )
    ).toMatchObject({ report: { blocking: [] } })
  })

  it("converts Codex skills and MCP servers through the same canonical model", () => {
    const files = snapshot({
      ".codex-plugin/plugin.json": JSON.stringify({
        name: "codex-review",
        version: "2.0.0",
        description: "Codex review helpers",
        skills: ["./skills/review"],
        mcpServers: "./.mcp.json",
      }),
      "skills/review/SKILL.md": `---
name: Codex Review
description: Review code with Codex conventions
---
Review the selected changes and report only actionable findings.
`,
      ".mcp.json": JSON.stringify({
        mcpServers: {
          reviewIndex: {
            type: "http",
            url: "https://review.example.test/mcp",
          },
        },
      }),
    })

    expect(detectPluginEcosystem(files)).toBe("codex")
    const result = convertPluginBundle(files, "cognia")

    expect(result.manifest).toMatchObject({
      id: "codex-review",
      version: "2.0.0",
      capabilities: ["skills", "mcp-server-preset"],
      skills: [
        {
          id: "codex-review",
          source: {
            kind: "inline",
            markdown: "Review the selected changes and report only actionable findings.",
          },
        },
      ],
      mcpServerPresets: [
        {
          id: "reviewIndex",
          transport: "http",
          config: { url: "https://review.example.test/mcp" },
        },
      ],
    })
  })

  it("maps Codex interface metadata and reports presentation-only fields", () => {
    const files = snapshot({
      ".codex-plugin/plugin.json": JSON.stringify({
        name: "codex-interface",
        version: "1.0.0",
        interface: {
          displayName: "Codex Interface",
          longDescription: "A complete description from the Codex interface.",
          developerName: "OpenAI",
          websiteURL: "https://example.test/plugin",
          logo: "./assets/logo.png",
          screenshots: ["./assets/screenshot.png"],
          defaultPrompt: ["Review this repository."],
          brandColor: "#123456",
        },
      }),
      "assets/logo.png": "",
      "assets/screenshot.png": "",
    })

    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest).toMatchObject({
      name: "Codex Interface",
      description: "A complete description from the Codex interface.",
      author: { name: "OpenAI" },
      homepage: "https://example.test/plugin",
      icon: "./assets/logo.png",
      screenshots: ["./assets/screenshot.png"],
    })
    expect(result.report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "interface.defaultPrompt" }),
        expect.objectContaining({ path: "interface.brandColor" }),
      ])
    )
  })

  it("maps a Codex composer icon when no logo is declared", () => {
    const result = convertPluginBundle(
      snapshot({
        ".codex-plugin/plugin.json": JSON.stringify({
          name: "composer-icon",
          author: "Codex Team",
          keywords: ["icon", 42],
          interface: { composerIcon: "./assets/icon.png" },
        }),
        "assets/icon.png": "",
      }),
      "cognia"
    )
    expect(result.manifest.author?.name).toBe("Codex Team")
    expect(result.manifest.keywords).toEqual(["icon"])
    expect(result.manifest.icon).toBe("./assets/icon.png")
  })

  it("fails closed for unknown foreign manifest fields", () => {
    const files = snapshot({
      "gemini-extension.json": JSON.stringify({
        name: "future-extension",
        futureRuntime: { entrypoint: "./runtime.js" },
      }),
      "runtime.js": "process.exit(0)",
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      expect((error as UnsupportedPluginConversionError).report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "gemini-extension.json.futureRuntime",
            message: expect.stringContaining("unknown manifest field"),
          }),
        ])
      )
    }
  })

  it("converts Gemini context, prompt commands, and MCP servers without dropping text", () => {
    const files = snapshot({
      "gemini-extension.json": JSON.stringify({
        name: "gemini-release",
        version: "3.1.0",
        description: "Gemini release helpers",
        contextFileName: "GEMINI.md",
        mcpServers: {
          releaseIndex: {
            command: "node",
            args: ["${extensionPath}/servers/index.js"],
          },
        },
      }),
      "GEMINI.md": "Always validate the changelog and rollback plan.\n",
      "commands/release.toml": `description = "Prepare a release"
prompt = """
Prepare a release from the current changes.
User input: {{args}}
"""
`,
      "servers/index.js": "process.exit(0)\n",
    })

    expect(detectPluginEcosystem(files)).toBe("gemini-cli")
    const result = convertPluginBundle(files, "cognia")

    expect(result.report.fidelity).toBe("contextual")
    expect(result.manifest).toMatchObject({
      id: "gemini-release",
      version: "3.1.0",
      capabilities: ["skills", "mcp-server-preset"],
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: "gemini-context",
          source: expect.objectContaining({
            kind: "inline",
            markdown: "Always validate the changelog and rollback plan.",
          }),
        }),
        expect.objectContaining({
          id: "release",
          description: "Prepare a release",
          source: expect.objectContaining({
            kind: "inline",
            markdown: expect.stringContaining("User input: {{args}}"),
          }),
        }),
      ]),
      mcpServerPresets: [
        expect.objectContaining({
          id: "releaseIndex",
          config: {
            command: "node",
            args: ["${COGNIA_PLUGIN_ROOT}/servers/index.js"],
          },
        }),
      ],
    })
    expect(result.report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "commands", path: "commands/release.toml" }),
      ])
    )
  })

  it.each([
    ["invalid TOML", "prompt = [", "invalid TOML"],
    ["missing prompt", 'description = "No prompt"', "missing the required prompt"],
    ["shell interpolation", 'prompt = "Run !{git status}"', "shell interpolation"],
  ])("fails closed for Gemini commands with %s", (_label, command, message) => {
    const files = snapshot({
      "gemini-extension.json": JSON.stringify({ name: "bad-command" }),
      "commands/bad.toml": command,
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      expect((error as UnsupportedPluginConversionError).message).toContain(message)
    }
  })

  it("fails closed when a declared Gemini context file is absent", () => {
    const files = snapshot({
      "gemini-extension.json": JSON.stringify({
        name: "missing-context",
        contextFileName: "CONTEXT.md",
      }),
    })
    expect(() => convertPluginBundle(files, "cognia")).toThrow(/CONTEXT\.md/)
  })

  it("reports invalid paths, manifests, and unsupported direct foreign conversions", () => {
    expect(() => detectPluginEcosystem(snapshot({ "README.md": "# None" }))).toThrow(
      /not recognized/
    )
    expect(() =>
      convertPluginBundle(snapshot({ ".claude-plugin/plugin.json": "[]" }), "cognia")
    ).toThrow(/JSON object/)
    expect(() =>
      convertPluginBundle(snapshot({ ".claude-plugin/plugin.json": "{" }), "cognia")
    ).toThrow(/could not parse/)
    expect(() =>
      convertPluginBundle(snapshot({ ".codex-plugin/plugin.json": "{}" }), "cognia")
    ).toThrow(/name.*non-empty string/)
    const normalized = convertPluginBundle(
      snapshot({
        ".codex-plugin/plugin.json": JSON.stringify({
          name: "normalized-path",
          skills: "skills/tmp/../review/SKILL.md",
        }),
        "skills/review/SKILL.md": "---\nname: Review\n---\nReview.",
      }),
      "cognia"
    )
    expect(normalized.manifest.skills).toHaveLength(1)
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "escaping",
            skills: "../outside",
          }),
        }),
        "cognia"
      )
    ).toThrow(/escapes plugin root/)
    expect(
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({ name: "cross-format" }),
        }),
        "codex"
      )
    ).toMatchObject({ source: "claude-code", target: "codex", report: { blocking: [] } })
  })

  it("fails closed for missing Claude commands and malformed subagents", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "invalid-declarations",
        commands: "./missing-commands",
        agents: "./agents",
      }),
      "agents/broken.md": "---\nname: broken\n---\nNo description.",
    })

    expect(() => convertPluginBundle(files, "cognia")).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, "cognia")
    } catch (error) {
      expect((error as UnsupportedPluginConversionError).report.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capability: "commands" }),
          expect.objectContaining({ capability: "agents" }),
        ])
      )
    }
  })

  it("exports a compatible Cognia plugin to Claude Code, Codex, and Gemini CLI", () => {
    const files = snapshot({
      "plugin.json": JSON.stringify({
        id: "portable-review",
        name: "Portable Review",
        version: "1.0.0",
        description: "Portable review helpers",
        type: "frontend",
        capabilities: ["skills", "mcp-server-preset"],
        main: "dist/index.js",
        author: { name: "Cognia Team" },
        license: "MIT",
        skills: [
          {
            id: "review",
            name: "Review",
            description: "Review changes",
            source: {
              kind: "inline",
              markdown: "Review the selected changes and explain every finding.",
            },
          },
        ],
        mcpServerPresets: [
          {
            id: "docs",
            name: "Docs",
            transport: "http",
            config: { url: "https://docs.example.test/mcp", retries: 3 },
          },
        ],
      }),
      "dist/index.js":
        "// Built output of src/index.ts, pre-generated by `cognia plugin import`.\nmodule.exports = {}\n",
    })

    files.set("dist/index.js", renderDist(JSON.parse(files.get("plugin.json")!)))
    const claude = convertPluginBundle(files, "claude-code")
    expect(claude.files.get(".claude-plugin/plugin.json")).toContain('"name": "portable-review"')
    expect(claude.files.get("skills/review/SKILL.md")).toContain("Review the selected changes")
    expect(claude.files.get(".mcp.json")).toContain("https://docs.example.test/mcp")

    const codex = convertPluginBundle(files, "codex")
    expect(codex.files.get(".codex-plugin/plugin.json")).toContain('"name": "portable-review"')
    expect(codex.files.get("skills/review/SKILL.md")).toContain("Review the selected changes")

    const gemini = convertPluginBundle(files, "gemini-cli")
    expect(gemini.files.get("gemini-extension.json")).toContain('"name": "portable-review"')
    expect(gemini.files.get("skills/review/SKILL.md")).toContain(
      "Review the selected changes and explain every finding."
    )
  })

  it("exports resource-bearing skills and preserves binary copies", () => {
    const files = snapshot({
      "plugin.json": JSON.stringify({
        id: "bundle-skill",
        name: "Bundle Skill",
        version: "1.0.0",
        description: "Resource-bearing skill",
        type: "frontend",
        capabilities: ["skills"],
        skills: [
          {
            id: "review",
            name: "Review",
            description: "Review with references",
            source: { kind: "local-bundle", path: "skills/review" },
          },
        ],
      }),
      "skills/review/SKILL.md": "---\nname: Review\n---\nUse the image.",
      "skills/review/assets/reference.png": "",
    })

    const result = convertPluginBundle(files, "claude-code", {
      binaryPaths: new Set(["skills/review/assets/reference.png"]),
    })
    expect(result.files.get("skills/review/SKILL.md")).toContain("Use the image")
    expect(result.copies).toContainEqual({
      from: "skills/review/assets/reference.png",
      to: "skills/review/assets/reference.png",
    })
  })

  it("exports a portable subagent to Claude Code", () => {
    const files = snapshot({
      "plugin.json": JSON.stringify({
        id: "portable-agent",
        name: "Portable Agent",
        version: "1.0.0",
        description: "Portable subagent",
        type: "frontend",
        capabilities: ["subagent"],
        subagents: [
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Review changes",
            prompt: "Review every changed line.",
            tools: ["Read"],
          },
        ],
      }),
    })

    const result = convertPluginBundle(files, "claude-code")
    expect(result.files.get("agents/reviewer.md")).toContain("Review every changed line.")
  })

  it("blocks Cognia permissions even when all contributions are portable", () => {
    const files = snapshot({
      "plugin.json": JSON.stringify({
        id: "permissioned",
        name: "Permissioned",
        version: "1.0.0",
        description: "Needs permission",
        type: "frontend",
        capabilities: [],
        permissions: ["filesystem:read"],
      }),
    })
    expect(() => convertPluginBundle(files, "claude-code")).toThrow(/permissions/)
  })

  it("blocks non-JavaScript Cognia runtime entries", () => {
    const files = snapshot({
      "plugin.json": JSON.stringify({
        id: "python-runtime",
        name: "Python Runtime",
        version: "1.0.0",
        description: "Python runtime",
        type: "python",
        capabilities: [],
        pythonMain: "main.py",
      }),
      "main.py": "print('hello')",
    })
    expect(() => convertPluginBundle(files, "claude-code")).toThrow(/runtime/)
  })

  it.each([
    [
      "resource skill to Gemini",
      {
        capabilities: ["skills"],
        skills: [
          {
            id: "bundle",
            name: "Bundle",
            description: "Bundle",
            source: { kind: "local-bundle", path: "skills/missing" },
          },
        ],
      },
      "gemini-cli",
      "was not found",
    ],
    [
      "missing resource skill",
      {
        capabilities: ["skills"],
        skills: [
          {
            id: "bundle",
            name: "Bundle",
            description: "Bundle",
            source: { kind: "local-bundle", path: "skills/missing" },
          },
        ],
      },
      "claude-code",
      "was not found",
    ],
    [
      "managed skill",
      {
        capabilities: ["skills"],
        skills: [
          {
            id: "managed",
            name: "Managed",
            description: "Managed",
            source: { kind: "anthropic-managed", containerSkillId: "managed" },
          },
        ],
      },
      "claude-code",
      "cannot be represented",
    ],
    [
      "subagent to Codex",
      {
        capabilities: ["subagent"],
        subagents: [
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Review",
            prompt: "Review.",
          },
        ],
      },
      "codex",
      "no subagent contribution",
    ],
    [
      "Cognia-only subagent routing",
      {
        capabilities: ["subagent"],
        subagents: [
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Review",
            prompt: "Review.",
            maxDepth: 2,
          },
        ],
      },
      "claude-code",
      "routing",
    ],
    [
      "MCP fields",
      {
        capabilities: ["mcp-server-preset"],
        mcpServerPresets: [
          {
            id: "configured",
            name: "Configured",
            transport: "http",
            config: { url: "https://example.test/mcp" },
            fields: [{ key: "TOKEN", label: "Token", type: "password" }],
          },
        ],
      },
      "claude-code",
      "configuration projection",
    ],
    [
      "Codex SSE",
      {
        capabilities: ["mcp-server-preset"],
        mcpServerPresets: [
          {
            id: "events",
            name: "Events",
            transport: "sse",
            config: { url: "https://example.test/sse" },
          },
        ],
      },
      "codex",
      "do not support SSE",
    ],
    [
      "imperative runtime",
      {
        capabilities: [],
        main: "dist/custom.js",
      },
      "claude-code",
      "imperative Cognia activation code",
    ],
  ] as const)("fails closed when exporting %s", (_label, contribution, target, message) => {
    const files = snapshot({
      "plugin.json": JSON.stringify({
        id: "unsupported-export",
        name: "Unsupported Export",
        version: "1.0.0",
        description: "Unsupported export",
        type: "frontend",
        ...contribution,
      }),
      "dist/custom.js": "module.exports = { activate() {} }",
    })

    expect(() => convertPluginBundle(files, target)).toThrow(UnsupportedPluginConversionError)
    try {
      convertPluginBundle(files, target)
    } catch (error) {
      expect((error as UnsupportedPluginConversionError).message).toContain(message)
    }
  })

  function cognia(contributions: Record<string, unknown>, payload: Record<string, string> = {}) {
    return snapshot({
      "plugin.json": JSON.stringify({
        id: "portable",
        name: "Portable",
        version: "1.0.0",
        description: "Portable",
        type: "frontend",
        capabilities: [],
        ...contributions,
      }),
      ...payload,
    })
  }

  it("imports and exports native Gemini skill resources without lowering them to commands", () => {
    const imported = convertPluginBundle(
      snapshot({
        "gemini-extension.json": JSON.stringify({ name: "gemini-skills" }),
        "skills/review/SKILL.md":
          "---\nname: review\ndescription: Review\n---\nRead references/a.md.",
        "skills/review/references/a.md": "# Reference",
        "skills/review/assets/a.png": "binary-placeholder",
      }),
      "cognia",
      { binaryPaths: new Set(["skills/review/assets/a.png"]) }
    )
    expect(imported.manifest.capabilities).toContain("skills")
    expect(imported.manifest.runtimeCompatibility?.browser?.availability).toBe("blocked")
    expect(imported.copies).toContainEqual({
      from: "skills/review/assets/a.png",
      to: "skills/review/assets/a.png",
    })
    const exported = convertPluginBundle(imported.files, "gemini-cli", {
      binaryPaths: new Set(["skills/review/assets/a.png"]),
    })
    expect(exported.files.get("skills/review/SKILL.md")).toContain("Read references/a.md")
    expect(exported.files.get("skills/review/references/a.md")).toBe("# Reference")
    expect(exported.files.has("commands/review.toml")).toBe(false)
    expect(exported.copies).toContainEqual({
      from: "skills/review/assets/a.png",
      to: "skills/review/assets/a.png",
    })
    expect(exported.report.fidelity).toBe("structured")
  })

  it.each([
    ["hooks/hooks.json", /could not parse hooks\/hooks.json/],
    ["agents/reviewer.md", /missing `description`/],
    ["policies/security.toml", /policy engine/],
  ])("does not silently ignore Gemini native %s", (path, message) => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          "gemini-extension.json": JSON.stringify({ name: "native" }),
          [path]: "native content",
        }),
        "cognia"
      )
    ).toThrow(message)
  })

  it("sanitizes complete MCP bundles and removes raw configuration and dotenv copies", () => {
    const files = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "private",
        mcpServers: {
          api: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "fixture-secret" },
          },
        },
      }),
      ".env.local": "TOKEN=fixture-secret",
    })
    const result = convertPluginBundle(files, "cognia")
    expect(result.manifest.mcpServerPresets?.[0]?.fields).toEqual([
      expect.objectContaining({ key: "Authorization", secret: true, placement: "header" }),
    ])
    expect([...result.files.values()].join("\n")).not.toContain("fixture-secret")
    expect(result.files.get(".claude-plugin/plugin.json")).toBe("{}\n")
    expect(result.files.get(".env.local")).toBe("\n")
  })

  it("blocks a known MCP credential duplicated in an executable instead of exporting it", () => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "private",
            mcpServers: { api: { command: "node", env: { API_KEY: "fixture-secret" } } },
          }),
          "server.js": "const token = 'fixture-secret'",
        }),
        "cognia"
      )
    ).toThrow(/credential removed/)
  })

  it("preserves the complete bundled MCP executable layout including binary dependencies", () => {
    const files = cognia(
      {
        capabilities: ["mcp-server-preset"],
        mcpServerPresets: [
          {
            id: "local",
            name: "Local",
            transport: "stdio",
            config: { command: "node", args: ["${COGNIA_PLUGIN_ROOT}/server/index.js"] },
          },
        ],
      },
      {
        "server/index.js": "require('../shared/a.js')",
        "shared/a.js": "module.exports = 1",
        "server/native.node": "binary",
        "package.json": '{"dependencies":{"example":"1.0.0"}}',
      }
    )
    const result = convertPluginBundle(files, "claude-code", {
      binaryPaths: new Set(["server/native.node"]),
    })
    expect(result.files.get("server/index.js")).toContain("shared/a.js")
    expect(result.files.has("shared/a.js")).toBe(true)
    expect(result.files.has("package.json")).toBe(true)
    expect(result.copies).toContainEqual({ from: "server/native.node", to: "server/native.node" })
    expect(result.files.get(".mcp.json")).toContain("${CLAUDE_PLUGIN_ROOT}/server/index.js")
    files.delete("server/index.js")
    expect(() => convertPluginBundle(files, "claude-code")).toThrow(/reference is missing/)
  })

  it("exports supported Claude hooks and blocks selectors and dormant hook behavior", () => {
    const imported = convertPluginBundle(
      snapshot({
        ".claude-plugin/plugin.json": JSON.stringify({ name: "hooked" }),
        "hooks/hooks.json": JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/end.js" }],
              },
            ],
          },
        }),
        "scripts/end.js": "process.exit(0)",
      }),
      "cognia"
    )
    expect(imported.manifest.runtimeCompatibility?.browser?.availability).toBe("blocked")
    const result = convertPluginBundle(imported.files, "claude-code")
    expect(result.files.get("hooks/hooks.json")).toContain("${CLAUDE_PLUGIN_ROOT}/scripts/end.js")
    expect(result.files.get("scripts/end.js")).toContain("process.exit")
    expect(() =>
      convertPluginBundle(
        cognia({
          capabilities: ["command-hooks"],
          commandHooks: {
            Stop: [{ agents: "teammate", hooks: [{ type: "command", command: "echo x" }] }],
          },
        }),
        "claude-code"
      )
    ).toThrow(/agent selectors/)
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "dormant",
            hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x", once: true }] }] },
          }),
        }),
        "cognia"
      )
    ).toThrow(/do not execute hook fields/)
  })

  it("projects all supported preset field placements to Gemini installation settings", () => {
    const result = convertPluginBundle(
      cognia({
        capabilities: ["mcp-server-preset"],
        mcpServerPresets: [
          {
            id: "local",
            name: "Local",
            transport: "stdio",
            config: { command: "node", args: ["<PATH>"] },
            fields: [
              { key: "TOKEN", label: "Token", placement: "env", secret: true },
              { key: "PATH", label: "Path", placement: "arg-replace", token: "<PATH>" },
            ],
          },
          {
            id: "remote",
            name: "Remote",
            transport: "http",
            config: {},
            fields: [
              { key: "URL", label: "URL", placement: "url" },
              { key: "Authorization", label: "Authorization", placement: "header", secret: true },
            ],
          },
        ],
      }),
      "gemini-cli"
    )
    const output = JSON.parse(result.files.get("gemini-extension.json")!)
    expect(output.settings).toHaveLength(4)
    expect(output.settings[0]).toMatchObject({ envVar: "COGNIA_LOCAL_TOKEN", sensitive: true })
    expect(output.mcpServers.local.env.TOKEN).toBe("${COGNIA_LOCAL_TOKEN}")
    expect(output.mcpServers.local.args).toEqual(["${COGNIA_LOCAL_PATH}"])
    expect(output.mcpServers.remote.httpUrl).toBe("${COGNIA_REMOTE_URL}")
    expect(output.mcpServers.remote.headers.Authorization).toBe("${COGNIA_REMOTE_AUTHORIZATION}")
  })

  it("exports hooks only through each host's exact event map", () => {
    const hooked = cognia({
      capabilities: ["command-hooks"],
      commandHooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
    })
    expect(() => convertPluginBundle(hooked, "gemini-cli")).toThrow(
      /Gemini CLI has no hook event equivalent to Stop/
    )
    const codex = convertPluginBundle(hooked, "codex")
    expect(JSON.parse(codex.files.get("hooks/hooks.json")!)).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
    })
    expect(JSON.parse(codex.files.get(".codex-plugin/plugin.json")!).hooks).toBe(
      "./hooks/hooks.json"
    )
    const gemini = convertPluginBundle(
      cognia(
        {
          capabilities: ["command-hooks"],
          commandHooks: {
            PreToolUse: [
              {
                hooks: [
                  { type: "command", command: "node ${COGNIA_PLUGIN_ROOT}/g.js", timeout: 3 },
                ],
              },
            ],
          },
        },
        { "g.js": "process.exit(0)" }
      ),
      "gemini-cli"
    )
    expect(JSON.parse(gemini.files.get("hooks/hooks.json")!)).toEqual({
      hooks: {
        BeforeTool: [
          { hooks: [{ type: "command", command: "node ${extensionPath}/g.js", timeout: 3000 }] },
        ],
      },
    })
    expect(gemini.report.warnings.map((issue) => issue.message).join("\n")).toMatch(
      /differ from Claude/
    )
  })

  it("rejects a Gemini export that would lose explicit invocation policy", () => {
    expect(() =>
      convertPluginBundle(
        cognia({
          capabilities: ["skills"],
          skills: [
            {
              id: "review",
              name: "Review",
              description: "Review",
              invocationPolicy: "explicit",
              source: { kind: "inline", markdown: "Review." },
            },
          ],
        }),
        "gemini-cli"
      )
    ).toThrow(/cannot silently loosen/)
  })

  it("imports Gemini install fields without losing labels, placement, or sensitivity", () => {
    const result = convertPluginBundle(
      snapshot({
        "gemini-extension.json": JSON.stringify({
          name: "configured",
          settings: [
            { name: "Service key", envVar: "API_KEY", sensitive: true },
            { name: "Data path", envVar: "DATA_PATH", sensitive: false },
          ],
          mcpServers: {
            local: { command: "node", args: ["${DATA_PATH}"], env: { TOKEN: "${API_KEY}" } },
          },
        }),
      }),
      "cognia"
    )
    expect(result.manifest.mcpServerPresets?.[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "TOKEN",
          label: "Service key",
          placement: "env",
          secret: true,
        }),
        expect.objectContaining({
          key: "API_KEY",
          label: "Service key",
          placement: "env",
          secret: true,
        }),
        expect.objectContaining({
          key: "DATA_PATH",
          label: "Data path",
          placement: "arg-replace",
          token: "${DATA_PATH}",
        }),
      ])
    )
  })

  it("rejects composed Gemini configuration bindings rather than discarding their template", () => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          "gemini-extension.json": JSON.stringify({
            name: "configured",
            settings: [{ name: "Host", envVar: "API_HOST" }],
            mcpServers: { remote: { httpUrl: "https://${API_HOST}/mcp" } },
          }),
        }),
        "cognia"
      )
    ).toThrow(/Composed URL bindings/)
  })

  it("applies canonical invocation policy to an exported resource skill", () => {
    const result = convertPluginBundle(
      cognia(
        {
          capabilities: ["skills"],
          skills: [
            {
              id: "review",
              name: "Review",
              description: "Review",
              invocationPolicy: "explicit",
              source: { kind: "local-bundle", path: "bundle" },
            },
          ],
        },
        {
          "bundle/SKILL.md": "---\nname: old-name\ndescription: Old\n---\nReview.",
          "bundle/reference.md": "# Reference",
        }
      ),
      "claude-code"
    )
    expect(result.files.get("skills/review/SKILL.md")).toContain("disable-model-invocation: true")
    expect(result.files.get("skills/review/reference.md")).toBe("# Reference")
  })

  it("blocks missing executable handler fields and excluded runtime references", () => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "broken",
            hooks: { Stop: [{ hooks: [{ type: "command" }] }] },
          }),
        }),
        "cognia"
      )
    ).toThrow(/non-empty command/)
    expect(() =>
      convertPluginBundle(
        cognia(
          {
            capabilities: ["mcp-server-preset"],
            mcpServerPresets: [
              {
                id: "local",
                name: "Local",
                transport: "stdio",
                config: { command: "node", args: ["${COGNIA_PLUGIN_ROOT}/.env.local"] },
              },
            ],
          },
          { ".env.local": "SECRET=x" }
        ),
        "claude-code"
      )
    ).toThrow(/excluded or relocated/)
  })

  it.each([
    ["missing file", "./missing.json", {}, "declared hooks file"],
    ["invalid declaration", 42, {}, "manifest hooks field"],
    ["invalid group list", { Stop: {} }, {}, "array of groups"],
    ["null group", { Stop: [null] }, {}, "must be an object"],
    ["missing handler list", { Stop: [{}] }, {}, "handler array"],
    [
      "unknown handler field",
      { Stop: [{ hooks: [{ type: "command", command: "echo x", futureFlag: true }] }] },
      {},
      "Unsupported hook handler fields",
    ],
    [
      "negative timeout",
      { Stop: [{ hooks: [{ type: "command", command: "echo x", timeout: -1 }] }] },
      {},
      "positive number",
    ],
    [
      "invalid async",
      { Stop: [{ hooks: [{ type: "command", command: "echo x", async: "yes" }] }] },
      {},
      "async must be boolean",
    ],
    ["missing HTTP endpoint", { Stop: [{ hooks: [{ type: "http" }] }] }, {}, "non-empty url"],
    ["missing prompt", { Stop: [{ hooks: [{ type: "prompt" }] }] }, {}, "non-empty prompt"],
  ] as const)("diagnoses malformed hook behavior: %s", (_label, hooks, resources, message) => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({ name: "malformed", hooks }),
          ...resources,
        }),
        "cognia"
      )
    ).toThrow(String(message))
  })

  it("uses Codex explicit hook arrays instead of merging conventional defaults", () => {
    const result = convertPluginBundle(
      snapshot({
        ".codex-plugin/plugin.json": JSON.stringify({
          name: "overridden",
          hooks: [
            "./custom/a.json",
            { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
          ],
        }),
        "custom/a.json": JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }] },
        }),
        "hooks/hooks.json": JSON.stringify({ hooks: { UnsupportedDefault: [] } }),
      }),
      "cognia"
    )
    expect(Object.keys(result.manifest.commandHooks ?? {})).toEqual(["SessionStart", "Stop"])
  })

  it.each([
    ["non-array", {}, "must be an array"],
    ["non-object", [null], "must be an object"],
    ["invalid env", [{ name: "Key", envVar: "not-valid" }], "invalid/duplicate"],
    ["unknown field", [{ name: "Key", envVar: "KEY", future: true }], "unsupported configuration"],
    [
      "duplicate",
      [
        { name: "A", envVar: "KEY" },
        { name: "B", envVar: "KEY" },
      ],
      "invalid/duplicate",
    ],
  ] as const)("rejects malformed Gemini settings: %s", (_label, settings, message) => {
    expect(() =>
      convertPluginBundle(
        snapshot({ "gemini-extension.json": JSON.stringify({ name: "malformed", settings }) }),
        "cognia"
      )
    ).toThrow(String(message))
  })

  it("imports direct remote settings and diagnoses unused settings", () => {
    const result = convertPluginBundle(
      snapshot({
        "gemini-extension.json": JSON.stringify({
          name: "remote",
          settings: [
            { name: "Endpoint", envVar: "ENDPOINT" },
            { name: "Auth", envVar: "AUTH", sensitive: true },
            { name: "Unused", envVar: "UNUSED" },
          ],
          mcpServers: { remote: { httpUrl: "${ENDPOINT}", headers: { Authorization: "${AUTH}" } } },
        }),
      }),
      "cognia"
    )
    expect(result.manifest.mcpServerPresets?.[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placement: "url", label: "Endpoint" }),
        expect.objectContaining({ placement: "header", label: "Auth", secret: true }),
      ])
    )
    expect(result.report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "settings",
          message: expect.stringContaining("not referenced"),
        }),
      ])
    )
  })

  it.each([
    { command: "node", env: { PREFIX: "prefix-${KEY}" } },
    { httpUrl: "https://example.test", headers: { Authorization: "Bearer ${KEY}" } },
  ])("rejects composed environment/header settings", (server) => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          "gemini-extension.json": JSON.stringify({
            name: "composed",
            settings: [{ name: "Key", envVar: "KEY", sensitive: true }],
            mcpServers: { server },
          }),
        }),
        "cognia"
      )
    ).toThrow(/Composed (environment|header) binding/)
  })

  it.each([
    {
      fields: [
        { key: "A-B", label: "First", placement: "env" },
        { key: "A_B", label: "Second", placement: "env" },
      ],
    },
    { fields: [{ key: "PATH", label: "Path", placement: "arg-replace", token: "<MISSING>" }] },
    { defaultDisallowedTools: ["delete"] },
    { toolRiskRules: [{ pattern: "*", risk: "destructive" }] },
    { provisioning: { mode: "managed" } },
  ])("rejects unsupported preset behavior before Gemini projection", (definition) => {
    expect(() =>
      convertPluginBundle(
        cognia({
          capabilities: ["mcp-server-preset"],
          mcpServerPresets: [
            {
              id: "local",
              name: "Local",
              transport: "stdio",
              config: { command: "node", args: ["script.js"] },
              ...definition,
            },
          ],
        }),
        "gemini-cli"
      )
    ).toThrow(UnsupportedPluginConversionError)
  })

  it("rejects execution frontmatter in imported skills and commands", () => {
    const skill = "---\nname: Execution\ndescription: Execution\ncontext: fork\n---\nExecute."
    for (const path of ["skills/execute/SKILL.md", "commands/execute.md"])
      expect(() =>
        convertPluginBundle(
          snapshot({
            ".claude-plugin/plugin.json": JSON.stringify({ name: "execution" }),
            [path]: skill,
          }),
          "cognia"
        )
      ).toThrow(/context/)
  })

  it("rejects invalid resource-skill execution metadata on export", () => {
    expect(() =>
      convertPluginBundle(
        cognia(
          {
            capabilities: ["skills"],
            skills: [
              {
                id: "execution",
                name: "Execution",
                description: "Execution",
                source: { kind: "local-bundle", path: "bundle" },
              },
            ],
          },
          {
            "bundle/SKILL.md":
              "---\nname: execution\ndescription: Execution\ncontext: fork\n---\nExecute.",
          }
        ),
        "claude-code"
      )
    ).toThrow(/context/)
  })
  it.each([
    { server: "mcp" },
    { tool: "run" },
    { server: " ", tool: "run" },
    { server: "mcp", tool: 42 },
  ])("rejects incomplete MCP hook identifiers", (handler) => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "incomplete",
            hooks: { Stop: [{ hooks: [{ type: "mcp_tool", ...handler }] }] },
          }),
        }),
        "cognia"
      )
    ).toThrow(/non-empty server and tool/)
  })
})

describe("root skill resources and environment placeholders", () => {
  it("preserves root skill resources across Kimi import and native export", () => {
    const source = snapshot({
      "plugin.json": JSON.stringify({ name: "example", version: "1.0.0", tools: [] }),
      "SKILL.md":
        "---\nname: example\ndescription: Example skill\n---\nRead references/data.md and run scripts/run.py.\n",
      "references/data.md": "Important reference content",
      "scripts/run.py": "print(42)",
      "assets/data.bin": "",
    })
    const binaryPaths = new Set(["assets/data.bin"])
    const imported = convertPluginBundle(source, "cognia", { binaryPaths })
    expect(imported.manifest.skills?.[0].source).toEqual({ kind: "local-bundle", path: "." })
    expect(imported.files.get("references/data.md")).toBe("Important reference content")
    const exported = convertPluginBundle(source, "claude-code", { binaryPaths })
    expect(exported.files.get("skills/example/references/data.md")).toBe(
      "Important reference content"
    )
    expect(exported.files.get("skills/example/scripts/run.py")).toBe("print(42)")
    expect(exported.copies).toContainEqual({
      from: "assets/data.bin",
      to: "skills/example/assets/data.bin",
    })
    expect(exported.files.has("skills/example/plugin.json")).toBe(false)
    expect(exported.files.has("skills/example/dist/index.js")).toBe(false)
  })

  it("overwrites environment binary placeholders without copying their original bytes", () => {
    const source = snapshot({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "example" }),
      ".env": "",
      "skills/example/.env.local": "",
      "skills/example/SKILL.md": "---\nname: example\ndescription: Example\n---\nBody",
    })
    const binaryPaths = new Set([".env", "skills/example/.env.local"])
    const imported = convertPluginBundle(source, "cognia", { binaryPaths })
    expect(imported.files.get(".env")).toBe("\n")
    expect(imported.files.get("skills/example/.env.local")).toBe("\n")
    expect(imported.copies).toEqual([])
    const exported = convertPluginBundle(source, "claude-code", { binaryPaths })
    expect(exported.copies).toEqual([])
    expect([...exported.files.keys()].some((path) => path.includes(".env"))).toBe(false)
  })
})

describe("latest host formats (2026-10-02 refresh)", () => {
  const json = JSON.stringify
  const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nDo ${name}.`
  const blockingOf = (run: () => unknown): string => {
    try {
      run()
    } catch (error) {
      if (error instanceof UnsupportedPluginConversionError)
        return error.report.blocking.map((issue) => `${issue.path}: ${issue.message}`).join("\n")
      throw error
    }
    return ""
  }

  it("treats Claude presentation keys and unknown keys as warnings and maps the icon", () => {
    const result = convertPluginBundle(
      snapshot({
        ".claude-plugin/plugin.json": json({
          $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
          name: "kit",
          displayName: "Kit",
          icon: "assets/icon.png",
          metadata: { category: "dev" },
          defaultEnabled: true,
          futureFlag: true,
          skills: "./extra",
          mcpServers: { inline: { command: "npx", args: ["inline"] } },
        }),
        "skills/a/SKILL.md": skill("a"),
        "extra/b/SKILL.md": skill("b"),
        ".mcp.json": json({ mcpServers: { file: { command: "npx", args: ["file"] } } }),
        "bin/tool": "",
      }),
      "cognia"
    )
    expect(result.manifest.name).toBe("Kit")
    expect(result.manifest.icon).toBe("assets/icon.png")
    // skills adds to skills/; mcpServers merges with .mcp.json.
    expect(result.manifest.skills?.map((entry) => entry.id).sort()).toEqual(["a", "b"])
    expect(result.manifest.mcpServerPresets?.map((preset) => preset.id).sort()).toEqual([
      "file",
      "inline",
    ])
    expect(result.report.blocking).toEqual([])
    expect(result.report.warnings.map((issue) => issue.capability)).toEqual(
      expect.arrayContaining(["$schema", "metadata", "defaultEnabled", "futureFlag", "bin"])
    )
  })

  it("converts Claude inline command maps and blocks packaged MCP and command models", () => {
    const result = convertPluginBundle(
      snapshot({
        ".claude-plugin/plugin.json": json({
          name: "kit",
          commands: {
            check: { content: "Check the diff.", description: "Check", argumentHint: "<file>" },
            run: { source: "./prompts/run.md" },
          },
        }),
        "prompts/run.md": "Run the suite.",
      }),
      "cognia"
    )
    expect(result.manifest.skills?.map((entry) => entry.id).sort()).toEqual(["check", "run"])
    expect(result.report.warnings.map((issue) => issue.path)).toContain("commands.check")
    expect(
      blockingOf(() =>
        convertPluginBundle(
          snapshot({
            ".claude-plugin/plugin.json": json({
              name: "kit",
              commands: { check: { content: "Check.", model: "opus" } },
              mcpServers: "./server.mcpb",
            }),
          }),
          "cognia"
        )
      )
    ).toMatch(/model[\s\S]*\.mcpb|\.mcpb[\s\S]*model/)
  })

  it("blocks reserved Claude Code names on export only", () => {
    const files = snapshot({
      "plugin.json": json({
        id: "claude-helper",
        name: "Helper",
        version: "1.0.0",
        type: "frontend",
        capabilities: [],
      }),
    })
    expect(blockingOf(() => convertPluginBundle(files, "claude-code"))).toMatch(/reserves/)
    expect(convertPluginBundle(files, "codex").files.has(".codex-plugin/plugin.json")).toBe(true)
  })

  it("imports Codex commands as skills and blocks OpenAI-only surfaces", () => {
    const result = convertPluginBundle(
      snapshot({
        ".codex-plugin/plugin.json": json({
          name: "kit",
          commands: "./commands",
          interface: { websiteUrl: "https://kit.test" },
        }),
        "commands/fix.md": "---\ndescription: Fix\n---\nFix it.",
      }),
      "cognia"
    )
    expect(result.manifest.skills?.map((entry) => entry.id)).toEqual(["fix"])
    expect(result.manifest.homepage).toBe("https://kit.test")
    expect(
      blockingOf(() =>
        convertPluginBundle(
          snapshot({
            ".codex-plugin/plugin.json": json({
              name: "kit",
              extensions: { "com.openai": { x: 1 } },
            }),
            ".app.json": "{}",
          }),
          "cognia"
        )
      )
    ).toMatch(/extensions[\s\S]*apps|apps[\s\S]*extensions/)
  })

  it("imports Gemini hooks, agents, context arrays and path separators", () => {
    const result = convertPluginBundle(
      snapshot({
        "gemini-extension.json": json({
          name: "kit",
          version: "1.0.0",
          contextFileName: ["GEMINI.md", "docs/more.md"],
          migratedTo: "https://github.com/acme/new",
          mcpServers: { s: { command: "node", args: ["${extensionPath}${/}s.js"] } },
        }),
        "GEMINI.md": "Context one.",
        "docs/more.md": "Context two.",
        "s.js": "process.exit(0)",
        "hooks/hooks.json": json({
          hooks: {
            BeforeTool: [
              { hooks: [{ type: "command", command: "${extensionPath}${/}g.sh", timeout: 500 }] },
            ],
          },
        }),
        "g.sh": "#!/bin/sh",
        "agents/helper.md": "---\nname: helper\ndescription: Help\nmax_turns: 3\n---\nHelp.",
        ".mcp.json": json({ mcpServers: { ignored: { command: "x" } } }),
      }),
      "cognia"
    )
    expect(result.manifest.skills?.map((entry) => entry.id)).toEqual([
      "gemini-context",
      "gemini-context-2",
    ])
    expect(result.manifest.commandHooks?.PreToolUse?.[0].hooks[0]).toMatchObject({
      command: "${COGNIA_PLUGIN_ROOT}/g.sh",
      timeout: 0.5,
    })
    expect(result.manifest.subagents?.[0]).toMatchObject({ id: "helper", maxTurns: 3 })
    expect(result.manifest.mcpServerPresets?.map((preset) => preset.id)).toEqual(["s"])
    expect(result.manifest.mcpServerPresets?.[0].config.args).toEqual([
      "${COGNIA_PLUGIN_ROOT}/s.js",
    ])
    expect(result.report.warnings.map((issue) => issue.capability)).toEqual(
      expect.arrayContaining(["migratedTo", "variables", "agents", "commandHooks"])
    )
    expect(
      blockingOf(() =>
        convertPluginBundle(
          snapshot({ "gemini-extension.json": json({ name: "kit", themes: [{ name: "x" }] }) }),
          "cognia"
        )
      )
    ).toMatch(/themes/)
  })

  it("exports subagents to Gemini extension agents", () => {
    const files = snapshot({
      "plugin.json": json({
        id: "kit",
        name: "Kit",
        version: "1.0.0",
        type: "frontend",
        capabilities: ["subagent"],
        subagents: [
          { id: "helper", name: "helper", description: "Help", prompt: "Help.", maxTurns: 3 },
        ],
      }),
    })
    const result = convertPluginBundle(files, "gemini-cli")
    expect(result.files.get("agents/helper.md")).toContain("max_turns: 3")
    files.set(
      "plugin.json",
      json({
        id: "kit",
        name: "Kit",
        version: "1.0.0",
        type: "frontend",
        capabilities: ["subagent"],
        subagents: [
          { id: "helper", name: "helper", description: "Help", prompt: "Help.", model: "x" },
        ],
      })
    )
    expect(blockingOf(() => convertPluginBundle(files, "gemini-cli"))).toMatch(/model/)
  })

  it("binds Cursor variables to preset fields and projects preset fields back to variables", () => {
    const cursor = snapshot({
      ".cursor-plugin/plugin.json": json({
        name: "kit",
        variables: {
          type: "object",
          properties: { API_TOKEN: { type: "string", title: "API token" } },
        },
      }),
      "mcp.json": json({
        mcpServers: { api: { url: "https://x.test/mcp", headers: { "X-Token": "${API_TOKEN}" } } },
      }),
    })
    const imported = convertPluginBundle(cursor, "cognia")
    expect(imported.manifest.mcpServerPresets?.[0].fields).toEqual([
      expect.objectContaining({
        key: "X-Token",
        label: "API token",
        placement: "header",
        secret: true,
      }),
    ])
    const exported = convertPluginBundle(imported.files, "cursor")
    const manifest = JSON.parse(exported.files.get(".cursor-plugin/plugin.json")!)
    const variable = Object.keys(manifest.variables.properties)[0]
    expect(JSON.parse(exported.files.get("mcp.json")!).mcpServers.api.headers["X-Token"]).toBe(
      `\${${variable}}`
    )
    cursor.set(
      "mcp.json",
      json({
        mcpServers: {
          api: { url: "https://x.test", headers: { Authorization: "Bearer ${API_TOKEN}" } },
        },
      })
    )
    expect(blockingOf(() => convertPluginBundle(cursor, "cognia"))).toMatch(
      /Composed header binding/
    )
  })

  it("imports Agent Plugins client namespaces without leaking normalization files", () => {
    const result = convertPluginBundle(
      snapshot({
        "plugin.json": json({
          $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
          name: "kit",
        }),
        "dev.openhands/agents/helper.md": "---\ndescription: Help\n---\nHelp.",
        "dev.openhands/commands/check.md": "---\ndescription: Check\n---\nCheck.",
        "dev.openhands/hooks/hooks.json": json({
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "${PLUGIN_ROOT}/boot.sh" }] }],
          },
        }),
        "boot.sh": "#!/bin/sh",
      }),
      "cognia"
    )
    expect(result.source).toBe("agent-plugins")
    expect(result.manifest.subagents?.map((agent) => agent.id)).toEqual(["helper"])
    expect(result.manifest.skills?.map((entry) => entry.id)).toEqual(["check"])
    expect(result.manifest.commandHooks?.SessionStart?.[0].hooks[0]).toMatchObject({
      command: "${COGNIA_PLUGIN_ROOT}/boot.sh",
    })
    expect([...result.files.keys()].some((path) => path.startsWith(".cognia-normalized/"))).toBe(
      false
    )
    expect(result.files.has(".claude-plugin/plugin.json")).toBe(false)
  })

  it("reports shadowed manifests when a vendor layout wins", () => {
    const result = convertPluginBundle(
      snapshot({
        ".factory-plugin/plugin.json": json({ name: "kit" }),
        ".claude-plugin/plugin.json": json({ name: "kit", mcpServers: { s: { command: "x" } } }),
        "skills/a/SKILL.md": skill("a"),
      }),
      "cognia"
    )
    expect(result.source).toBe("factory-droid")
    expect(result.manifest.mcpServerPresets).toBeUndefined()
    expect(result.report.warnings[0]).toMatchObject({
      capability: "format",
      path: ".claude-plugin/plugin.json",
    })
    expect(result.files.get(".claude-plugin/plugin.json")).toBe("{}\n")
  })

  describe("Pi packages", () => {
    const pi = () =>
      snapshot({
        "package.json": json({
          name: "@acme/pi-tools",
          version: "1.0.0",
          keywords: ["pi-package"],
          dependencies: { zod: "^3.0.0" },
          peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
        }),
        "package-lock.json": "{}",
        "skills/review/SKILL.md": skill("review"),
        "skills/review/assets/logo.png": "",
        "prompts/fix.md": "---\ndescription: Fix\n---\nFix $@.",
        "extensions/index.ts": "export default (pi) => pi.registerTool({ name: 'x' })",
        "themes/dark.json": "{}",
      })

    it("retains the whole package and converts skills and prompts", () => {
      const source = pi()
      const result = convertPluginBundle(source, "cognia", {
        binaryPaths: new Set(["skills/review/assets/logo.png"]),
      })
      expect(result.source).toBe("pi")
      expect(result.manifest.capabilities).toEqual(expect.arrayContaining(["skills", "pi-package"]))
      expect(result.manifest.piPackages).toEqual([
        expect.objectContaining({ id: "acme-pi-tools", path: ".", prepare: expect.any(Object) }),
      ])
      expect(result.manifest.skills?.map((entry) => entry.id).sort()).toEqual(["fix", "review"])
      expect(result.manifest.skills?.find((entry) => entry.id === "fix")?.invocationPolicy).toBe(
        "explicit"
      )
      expect(result.report.fidelity).toBe("contextual")
      for (const path of [
        "package.json",
        "package-lock.json",
        "extensions/index.ts",
        "themes/dark.json",
      ])
        expect(result.files.get(path)).toBe(source.get(path))
      expect(result.report.delivery?.hosted.retained).toContain("pi-package")
    })

    it("round-trips the package back to Pi byte-for-byte", () => {
      const source = pi()
      const imported = convertPluginBundle(source, "cognia", {
        binaryPaths: new Set(["skills/review/assets/logo.png"]),
      })
      const exported = convertPluginBundle(imported.files, "pi", {
        binaryPaths: new Set(["skills/review/assets/logo.png"]),
      })
      expect(exported.files.get("extensions/index.ts")).toBe(source.get("extensions/index.ts"))
      expect(exported.files.get("skills/review/SKILL.md")).toBe(
        source.get("skills/review/SKILL.md")
      )
      expect(JSON.parse(exported.files.get("package.json")!)).toEqual(
        JSON.parse(source.get("package.json")!)
      )
      expect(exported.files.has("plugin.json")).toBe(false)
      expect(exported.files.has("dist/index.js")).toBe(false)
      expect(exported.copies).toEqual([
        { from: "skills/review/assets/logo.png", to: "skills/review/assets/logo.png" },
      ])
      expect(exported.report.delivery?.hosted.retained).not.toContain("pi-package")
      const again = convertPluginBundle(
        new Map([...exported.files, ["skills/review/assets/logo.png", ""]]),
        "cognia"
      )
      expect(again.manifest.piPackages).toHaveLength(1)
    })

    it("keeps Pi packages in Cognia for every other target and blocks Pi-incompatible exports", () => {
      const imported = convertPluginBundle(pi(), "cognia")
      expect(blockingOf(() => convertPluginBundle(imported.files, "claude-code"))).toMatch(
        /Pi packages install only into Pi/
      )
      expect(
        blockingOf(() =>
          convertPluginBundle(
            snapshot({
              "plugin.json": json({
                id: "kit",
                name: "Kit",
                version: "1.0.0",
                type: "frontend",
                capabilities: ["mcp-server-preset"],
                mcpServerPresets: [
                  { id: "s", name: "s", transport: "stdio", config: { command: "x" } },
                ],
              }),
            }),
            "pi"
          )
        )
      ).toMatch(/registerMcpServer/)
    })
  })
})
