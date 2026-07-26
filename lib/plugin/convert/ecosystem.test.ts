import {
  UnsupportedPluginConversionError,
  convertPluginBundle,
  detectPluginEcosystem,
} from "./ecosystem"

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
              MODE: "release",
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
        name: "unsafe-hooks",
        version: "1.0.0",
        description: "Requires executable hooks",
        hooks: { PreToolUse: [] },
        outputStyles: "./output-styles",
      }),
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
        },
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
          expect.objectContaining({ capability: "hooks", path: "hooks" }),
          expect.objectContaining({ capability: "outputStyles", path: "outputStyles" }),
        ])
      )
    }
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
      env: { RETRIES: 2 },
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

  it("detects undeclared executable Claude plugin directories", () => {
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({ name: "hidden-runtime" }),
          "bin/run.sh": "#!/bin/sh",
        }),
        "cognia"
      )
    ).toThrow(/bin/)
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
    expect(() =>
      convertPluginBundle(
        snapshot({
          ".claude-plugin/plugin.json": JSON.stringify({ name: "cross-format" }),
        }),
        "codex"
      )
    ).toThrow(/not implemented/)
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
            allowedTools: ["Read", "Grep"],
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

    const claude = convertPluginBundle(files, "claude-code")
    expect(claude.files.get(".claude-plugin/plugin.json")).toContain('"name": "portable-review"')
    expect(claude.files.get("skills/review/SKILL.md")).toContain("Review the selected changes")
    expect(claude.files.get(".mcp.json")).toContain("https://docs.example.test/mcp")

    const codex = convertPluginBundle(files, "codex")
    expect(codex.files.get(".codex-plugin/plugin.json")).toContain('"name": "portable-review"')
    expect(codex.files.get("skills/review/SKILL.md")).toContain("Review the selected changes")

    const gemini = convertPluginBundle(files, "gemini-cli")
    expect(gemini.files.get("gemini-extension.json")).toContain('"name": "portable-review"')
    expect(gemini.files.get("commands/review.toml")).toContain(
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
      "resource-bearing",
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
      "compatible subagent",
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
      "cannot prompt users",
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
})
