import {
  AGENT_PLUGINS_SCHEMA,
  AGENT_PLUGINS_SCHEMA_VERSIONS,
  detectPlatformBundle,
  normalizePlatformBundle,
  PLATFORM_BUNDLE_PROFILES,
  projectPlatformBundle,
  type PlatformBundleTarget,
} from "./platform-bundles"

const json = JSON.stringify
const files = (entries: Record<string, string>) => new Map(Object.entries(entries))
const skill = "---\nname: review\ndescription: Review changes\n---\nRead references/rules.md."
const bundle = (manifest: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
  files({
    ".claude-plugin/plugin.json": json({
      name: "review",
      version: "1.0.0",
      skills: "./skills",
      ...manifest,
    }),
    "skills/review/SKILL.md": skill,
    "skills/review/references/rules.md": "Review all changes.",
    ...extra,
  })

describe("platform bundle adapters", () => {
  it("distinguishes portable schema from Cognia and rejects future schemas at normalization", () => {
    expect(
      detectPlatformBundle(files({ "plugin.json": json({ id: "cognia", type: "frontend" }) }))
    ).toBeNull()
    expect(detectPlatformBundle(files({ "plugin.json": "broken" }))).toBeNull()
    expect(detectPlatformBundle(new Map())).toBeNull()
    const future = files({
      "plugin.json": json({
        name: "review",
        $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      }),
    })
    expect(detectPlatformBundle(future)).toBe("agent-plugins")
    expect(normalizePlatformBundle(future, "agent-plugins").blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "schema" })])
    )
  })

  it.each([
    [".cursor-plugin/plugin.json", "{}", "cursor"],
    ["plugin.json", json({ name: "review", version: "1.0.0", tools: [] }), "kimi"],
    ["plugin.json", json({ name: "review", inject: {} }), "kimi"],
    [".devin-plugin/plugin.json", "{}", "devin"],
    [".github/plugin/plugin.json", "{}", "copilot"],
    ["plugin.json", json({ name: "review", agents: "./agents" }), "copilot"],
    ["opencode.json", "{}", "opencode"],
    ["opencode.jsonc", "{}", "opencode"],
  ] as const)("detects %s %s", (path, text, target) => {
    expect(detectPlatformBundle(files({ [path]: text }))).toBe(target)
  })

  it("leaves Pi packages and Claude-family layouts to their own converters", () => {
    expect(detectPlatformBundle(files({ "package.json": json({ pi: {} }) }))).toBeNull()
    expect(detectPlatformBundle(files({ ".factory-plugin/plugin.json": "{}" }))).toBeNull()
    expect(PLATFORM_BUNDLE_PROFILES.devin.hooks).toBe("local-fail-open")
  })

  it.each(["agent-plugins", "cursor", "copilot", "kimi", "devin", "opencode"] as const)(
    "exports and imports resource skills for %s without dropping assets",
    (target) => {
      const original = bundle(
        {},
        {
          "skills/review/agents/openai.yaml": "interface:\n  display_name: Review",
          "skills/review/assets/icon.png": "BINARY_PLACEHOLDER",
        }
      )
      const exported = projectPlatformBundle(original, target)
      expect(exported.blocking).toEqual([])
      const detected = detectPlatformBundle(exported.files)
      expect(detected).not.toBeNull()
      const imported = normalizePlatformBundle(exported.files, detected!)
      expect(imported.blocking).toEqual([])
      expect(imported.files.get(".claude-plugin/plugin.json")).toContain(
        target === "opencode" ? "opencode-resource-bundle" : "review"
      )
      expect(imported.skills).toHaveLength(1)
      // Kimi keeps its single skill at the plugin root.
      const prefix =
        target === "opencode"
          ? ".opencode/skills/review/"
          : target === "kimi"
            ? ""
            : "skills/review/"
      expect(imported.files.get(`${prefix}agents/openai.yaml`)).toContain("display_name")
      expect(imported.files.get(`${prefix}assets/icon.png`)).toBe("BINARY_PLACEHOLDER")
      if (target === "kimi") expect(imported.rootSkillResources).toContain("agents/openai.yaml")
      expect(original.has(".claude-plugin/plugin.json")).toBe(true)
    }
  )

  it("converts explicit portable transports and plugin-root cwd without losing MCP scripts", () => {
    const input = files({
      "plugin.json": json({ $schema: AGENT_PLUGINS_SCHEMA, name: "review" }),
      "mcp.json": json({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: {
            type: "stdio",
            command: "./server",
            args: ["${PLUGIN_ROOT}/data.json"],
            env: { MODE: "test" },
          },
          remote: {
            type: "streamable-http",
            url: "https://example.test/mcp",
            headers: { Authorization: "${TOKEN}" },
          },
          legacy: { type: "sse", url: "https://example.test/sse" },
        },
      }),
      server: "executable",
    })
    const result = normalizePlatformBundle(input, "agent-plugins")
    expect(result.blocking).toEqual([])
    expect(JSON.parse(result.files.get(".mcp.json")!).mcpServers).toMatchObject({
      local: {
        command: "${CLAUDE_PLUGIN_ROOT}/server",
        cwd: "${CLAUDE_PLUGIN_ROOT}",
        args: ["${CLAUDE_PLUGIN_ROOT}/data.json"],
      },
      remote: { type: "http" },
      legacy: { type: "sse" },
    })
    expect(result.files.get("server")).toBe("executable")
  })

  it.each(["agent-plugins", "copilot", "cursor", "devin"] as const)(
    "exports remote MCP for %s",
    (target) => {
      const result = projectPlatformBundle(
        bundle(
          { mcpServers: "./.mcp.json" },
          {
            ".mcp.json": json({
              mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
            }),
          }
        ),
        target
      )
      expect(result.blocking).toEqual([])
      expect(Array.from(result.files.values()).join("\n")).toContain("https://example.test/mcp")
    }
  )

  it("exports portable MCP schema and transforms Cursor root variables", () => {
    const source = bundle(
      {
        mcpServers: {
          local: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
            cwd: "${CLAUDE_PLUGIN_ROOT}",
          },
        },
      },
      { "server.js": "process.exit(0)" }
    )
    const portable = projectPlatformBundle(source, "agent-plugins")
    expect(portable.files.get("mcp.json")).toContain('"type": "stdio"')
    expect(portable.files.get("mcp.json")).toContain("${PLUGIN_ROOT}/server.js")
    const cursor = projectPlatformBundle(source, "cursor")
    expect(cursor.files.get("mcp.json")).toContain("${CURSOR_PLUGIN_ROOT}/server.js")
    expect(cursor.files.get("server.js")).toBe("process.exit(0)")
    expect(projectPlatformBundle(source, "kimi").blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "mcp" })])
    )
  })

  it("maps PATH-based OpenCode local MCP commands in both directions", () => {
    const source = bundle({
      mcpServers: { docs: { command: "npx", args: ["docs-server"], env: { MODE: "test" } } },
    })
    const output = projectPlatformBundle(source, "opencode")
    expect(output.blocking).toEqual([])
    expect(JSON.parse(output.files.get("opencode.json")!).mcp.docs).toEqual({
      type: "local",
      command: ["npx", "docs-server"],
      environment: { MODE: "test" },
    })
    const imported = normalizePlatformBundle(output.files, "opencode")
    expect(imported.blocking).toEqual([])
    expect(imported.files.get(".mcp.json")).toContain('"command": "npx"')
  })

  it.each([
    "hooks/hooks.json",
    "agents/reviewer.md",
    "commands/run.md",
    "policies/restrict.toml",
    "AGENTS.md",
    "com.github.copilot/agents/reviewer.md",
    "extensions/index.ts",
    ".opencode/plugins/index.ts",
    "lsp.json",
    "../escape.txt",
    "/absolute.txt",
    "bad\\path.txt",
  ])("reports unmapped or unsafe surface %s", (path) => {
    const result = projectPlatformBundle(bundle({}, { [path]: "behavior" }), "devin")
    expect(result.blocking.some((issue) => issue.path === path)).toBe(true)
  })

  it.each([
    [
      "agent-plugins",
      { $schema: AGENT_PLUGINS_SCHEMA, extensions: { "com.openai": { hooks: "./hooks.json" } } },
    ],
    ["cursor", { variables: { TOKEN: "secret" } }],
    [
      "kimi",
      {
        version: "1.0.0",
        tools: [{ name: "greet", description: "Greet", command: ["python3", "greet.py"] }],
      },
    ],
    [
      "kimi",
      { version: "1.0.0", config_file: "config.json", inject: { "llm.api_key": "api_key" } },
    ],
    ["devin", { requiredPlugins: ["base"] }],
  ] as Array<[PlatformBundleTarget, Record<string, unknown>]>)(
    "blocks unknown controls for %s",
    (target, extra) => {
      const result = normalizePlatformBundle(
        files({ [PLATFORM_BUNDLE_PROFILES[target].manifest]: json({ name: "review", ...extra }) }),
        target
      )
      expect(result.blocking.length).toBeGreaterThan(0)
    }
  )

  it.each([
    { command: "node", args: [1] },
    { command: "" },
    { type: "ws", url: "wss://example.test" },
    { type: "http", url: "" },
    { command: "node", env: { TOKEN: 1 } },
    { type: "http", url: "https://example.test", headers: [] },
    { command: "node", args: ["${PLUGIN_DATA}/cache"] },
    { command: "node", trust: true },
  ])("blocks invalid or unmapped MCP config %j", (server) => {
    const result = projectPlatformBundle(bundle({ mcpServers: { server } }), "cursor")
    expect(result.blocking.length).toBeGreaterThan(0)
  })

  it("does not silently discard MCP schemas, disabled servers, or unresolved remote transport", () => {
    const portable = normalizePlatformBundle(
      files({
        "plugin.json": json({ name: "review", $schema: AGENT_PLUGINS_SCHEMA }),
        "mcp.json": json({ mcpServers: { local: { command: "node" } } }),
      }),
      "agent-plugins"
    )
    expect(portable.blocking.map((issue) => issue.capability)).toEqual(
      expect.arrayContaining(["schema", "mcp"])
    )
    for (const server of [
      { type: "remote", url: "https://example.test" },
      { type: "local", command: ["node"], enabled: false },
      { type: "local", command: [] },
    ]) {
      expect(
        normalizePlatformBundle(files({ "opencode.json": json({ mcp: { server } }) }), "opencode")
          .blocking.length
      ).toBeGreaterThan(0)
    }
  })

  it("reports malformed input and unresolved component paths as blockers", () => {
    expect(projectPlatformBundle(new Map(), "kimi").blocking).not.toHaveLength(0)
    expect(
      projectPlatformBundle(bundle({ mcpServers: "./missing.json" }), "cursor").blocking
    ).not.toHaveLength(0)
    expect(projectPlatformBundle(bundle({ mcpServers: [] }), "cursor").blocking).not.toHaveLength(0)
    expect(
      projectPlatformBundle(bundle({ mcpServers: { mcpServers: [] } }), "cursor").blocking
    ).not.toHaveLength(0)
    expect(
      projectPlatformBundle(bundle({ mcpServers: { invalid: false } }), "cursor").blocking
    ).not.toHaveLength(0)
    expect(normalizePlatformBundle(new Map(), "cursor").blocking).not.toHaveLength(0)
    expect(
      normalizePlatformBundle(files({ "plugin.json": "[]" }), "kimi").blocking
    ).not.toHaveLength(0)
    expect(
      normalizePlatformBundle(files({ "plugin.json": "{}" }), "kimi").blocking
    ).not.toHaveLength(0)
    expect(
      normalizePlatformBundle(files({ "opencode.jsonc": "// comment\n{ broken" }), "opencode")
        .blocking
    ).not.toHaveLength(0)
    // JSONC comments are valid OpenCode configuration.
    expect(
      normalizePlatformBundle(files({ "opencode.jsonc": '// comment\n{ "mcp": {}, }' }), "opencode")
        .blocking
    ).toEqual([])
  })

  it("blocks OpenCode plugin-root assumptions but carries an absolute cwd", () => {
    const source = bundle({
      mcpServers: { server: { command: "node", cwd: "${CLAUDE_PLUGIN_ROOT}" } },
    })
    expect(projectPlatformBundle(source, "opencode").blocking).not.toHaveLength(0)
    const absolute = projectPlatformBundle(
      bundle({ mcpServers: { server: { command: "node", cwd: "/srv/tools" } } }),
      "opencode"
    )
    expect(absolute.blocking).toEqual([])
    expect(JSON.parse(absolute.files.get("opencode.json")!).mcp.server.cwd).toBe("/srv/tools")
  })

  it("preserves portable cwd and reserved environment semantics", () => {
    for (const server of [
      { command: "node" },
      { command: "node", cwd: "/project" },
      { command: "node", cwd: "./", env: { PLUGIN_ROOT: "override" } },
    ]) {
      expect(
        projectPlatformBundle(bundle({ mcpServers: { server } }), "agent-plugins").blocking.length
      ).toBeGreaterThan(0)
    }
    const portable = files({
      "plugin.json": json({ name: "review", $schema: AGENT_PLUGINS_SCHEMA }),
      "mcp.json": json({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: { type: "stdio", command: "node", cwd: "./data", env: { PLUGIN_ROOT: "invalid" } },
        },
      }),
    })
    const result = normalizePlatformBundle(portable, "agent-plugins")
    expect(result.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "mcpServers.local.env" })])
    )
    expect(result.files.get(".mcp.json")).toContain("${CLAUDE_PLUGIN_ROOT}/data")
    expect(
      normalizePlatformBundle(projectPlatformBundle(bundle(), "copilot").files, "copilot").blocking
    ).toEqual([])
  })

  it("neutralizes original native configs for overlay installers after capturing canonical MCP", () => {
    const input = files({
      ".devin-plugin/plugin.json": json({ name: "review", mcpServers: "./config/servers.json" }),
      "config/servers.json": json({
        mcpServers: {
          docs: { url: "https://example.test", headers: { Authorization: "secret-literal" } },
        },
      }),
    })
    const result = normalizePlatformBundle(input, "devin")
    expect(result.blocking).toEqual([])
    expect(result.files.get(".devin-plugin/plugin.json")).toBe("{}\n")
    expect(result.files.get("config/servers.json")).toBe("{}\n")
    // The canonical sanitizer consumes this config next; raw source files
    // cannot bypass it by remaining in the installer's original tree.
    expect(result.files.get(".mcp.json")).toContain("secret-literal")
    expect(input.get("config/servers.json")).toContain("secret-literal")
  })

  it.each(["cursor", "kimi", "copilot"] as const)(
    "preserves documented manual skill invocation for %s",
    (target) => {
      const source = bundle(
        {},
        {
          "skills/review/SKILL.md": skill.replace(
            "description:",
            "disable-model-invocation: true\ndescription:"
          ),
        }
      )
      const result = projectPlatformBundle(source, target)
      expect(result.blocking).toEqual([])
      expect(result.files.get(target === "kimi" ? "SKILL.md" : "skills/review/SKILL.md")).toContain(
        "disable-model-invocation: true"
      )
    }
  )

  it("maps Devin manual triggers in both directions", () => {
    const source = bundle(
      {},
      {
        "skills/review/SKILL.md": skill.replace(
          "description:",
          "disable-model-invocation: true\ndescription:"
        ),
      }
    )
    const result = projectPlatformBundle(source, "devin")
    expect(result.blocking).toEqual([])
    expect(result.files.get("skills/review/SKILL.md")).toContain("triggers:")
    expect(result.files.get("skills/review/SKILL.md")).not.toContain("disable-model-invocation")
    const imported = normalizePlatformBundle(result.files, "devin")
    expect(imported.blocking).toEqual([])
    expect(imported.files.get("skills/review/SKILL.md")).toContain("disable-model-invocation: true")
  })

  it.each(["opencode", "agent-plugins"] as const)(
    "blocks manual policy on %s where it is ignored or host-dependent",
    (target) => {
      const result = projectPlatformBundle(
        bundle(
          {},
          {
            "skills/review/SKILL.md": skill.replace(
              "description:",
              "disable-model-invocation: true\ndescription:"
            ),
          }
        ),
        target
      )
      expect(result.blocking).toEqual(
        expect.arrayContaining([expect.objectContaining({ capability: "skill-invocation" })])
      )
    }
  )

  it.each(["cursor", "copilot", "kimi", "devin", "opencode", "agent-plugins"] as const)(
    "blocks unmapped skill tool pre-approval on %s",
    (target) => {
      const result = projectPlatformBundle(
        bundle(
          {},
          {
            "skills/review/SKILL.md": skill.replace(
              "description:",
              "allowed-tools: Read Bash\ndescription:"
            ),
          }
        ),
        target
      )
      expect(result.blocking).toEqual(
        expect.arrayContaining([expect.objectContaining({ capability: "skill-tools" })])
      )
    }
  )

  it("maps Kimi aliases but blocks named arguments and flow skill execution", () => {
    const input = files({
      "plugin.json": '{"name":"review","version":"1.0.0","tools":[]}',
      "SKILL.md": skill.replace(
        "description:",
        "disableModelInvocation: true\ntype: inline\ndescription:"
      ),
    })
    const result = normalizePlatformBundle(input, "kimi")
    expect(result.blocking).toEqual([])
    expect(result.files.get("SKILL.md")).toContain("disable-model-invocation: true")
    for (const extra of [
      "type: flow",
      "arguments: target",
      "whenToUse: deploy",
      "disableModelInvocation: true\ndisable-model-invocation: false",
    ]) {
      input.set("SKILL.md", skill.replace("description:", `${extra}\ndescription:`))
      expect(normalizePlatformBundle(input, "kimi").blocking.length).toBeGreaterThan(0)
    }
  })

  it("rejects ignored controls, invalid schemas and resource runtime bindings", () => {
    for (const content of [
      skill.replace("name: review", "name: Review"),
      skill.replace("name: review", "name: different"),
      skill.replace("description: Review changes", "description: ''"),
      skill.replace("description:", "disable-model-invocation: sometimes\ndescription:"),
      "---\nname: [\n---\nBroken",
    ])
      expect(
        projectPlatformBundle(bundle({}, { "skills/review/SKILL.md": content }), "cursor").blocking
          .length
      ).toBeGreaterThan(0)
    const runtime = bundle(
      {},
      { "skills/review/scripts/run.sh": 'cat "${CLAUDE_PLUGIN_ROOT}/data.json"' }
    )
    const output = projectPlatformBundle(runtime, "opencode")
    expect(output.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "skill-runtime" })])
    )
    expect(output.files.get(".opencode/skills/review/scripts/run.sh")).toContain(
      "${CLAUDE_PLUGIN_ROOT}"
    )
    const devin = files({
      ".devin-plugin/plugin.json": '{"name":"review"}',
      "skills/review/SKILL.md": skill.replace("description:", "triggers: [model]\ndescription:"),
    })
    expect(normalizePlatformBundle(devin, "devin").blocking.length).toBeGreaterThan(0)
  })

  it("does not activate undeclared Kimi skills or discard fixed-location skill roots", () => {
    const input = files({
      "plugin.json": '{"name":"review","version":"1.0.0","tools":[]}',
      "skills/review/SKILL.md": skill,
    })
    expect(normalizePlatformBundle(input, "kimi").blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "skills" })])
    )
    input.delete("skills/review/SKILL.md")
    input.set("SKILL.md", skill)
    expect(normalizePlatformBundle(input, "kimi").skills).toEqual(["SKILL.md"])
    input.set("plugin.json", '{"name":"review","version":"1.0.0","tools":[],"mcpServers":{}}')
    expect(normalizePlatformBundle(input, "kimi").warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "mcpServers" })])
    )
    expect(
      projectPlatformBundle(bundle({ skills: "./custom" }), "kimi").blocking.length
    ).toBeGreaterThan(0)
  })

  it("validates target manifest ids and portable metadata instead of dropping invalid fields", () => {
    expect(
      projectPlatformBundle(bundle({ name: "demo.plugin" }), "kimi").blocking.length
    ).toBeGreaterThan(0)
    for (const extra of [
      { name: "bad--id" },
      { version: 1 },
      { keywords: "tag" },
      { author: "Alice" },
      { author: { name: 2 } },
      { author: { name: "Alice", custom: "value" } },
      { extensions: { "com.example": "invalid" } },
    ]) {
      const result = normalizePlatformBundle(
        files({ "plugin.json": json({ $schema: AGENT_PLUGINS_SCHEMA, name: "review", ...extra }) }),
        "agent-plugins"
      )
      expect(result.blocking.length).toBeGreaterThan(0)
    }
  })

  it("does not break relative references outside the moved OpenCode skills tree", () => {
    const source = bundle(
      {},
      {
        "skills/review/SKILL.md": `${skill}\nRead ../../shared/rules.md`,
        "shared/rules.md": "Rules",
      }
    )
    expect(projectPlatformBundle(source, "opencode").blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "skill-resources" })])
    )
    source.set("skills/review/SKILL.md", `${skill}\nRead ../shared/rules.md`)
    expect(projectPlatformBundle(source, "opencode").blocking).toEqual([])
  })

  describe("Agent Plugins 1.1.0 and client namespaces", () => {
    const ap = (
      version: string,
      extra: Record<string, unknown> = {},
      tree: Record<string, string> = {}
    ) =>
      files({
        "plugin.json": json({
          $schema: `https://agent-plugins.org/schemas/${version}/plugin.schema.json`,
          name: "review",
          ...extra,
        }),
        "skills/review/SKILL.md": skill,
        ...tree,
      })

    it("accepts 1.0.0 and 1.1.0, ignores unknown top-level fields with a warning", () => {
      for (const version of AGENT_PLUGINS_SCHEMA_VERSIONS) {
        const result = normalizePlatformBundle(ap(version, { agents: "./agents" }), "agent-plugins")
        expect(result.blocking).toEqual([])
        expect(result.warnings.map((issue) => issue.path)).toContain("plugin.json.agents")
      }
    })

    it("requires mcp.json to declare the same schema version and never expands command", () => {
      const mismatch = normalizePlatformBundle(
        ap(
          "1.1.0",
          {},
          {
            "mcp.json": json({
              $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
              mcpServers: { s: { type: "stdio", command: "node" } },
            }),
          }
        ),
        "agent-plugins"
      )
      expect(mismatch.blocking.map((issue) => issue.capability)).toContain("schema")
      const command = normalizePlatformBundle(
        ap(
          "1.1.0",
          {},
          {
            "mcp.json": json({
              $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
              mcpServers: {
                s: { type: "stdio", command: "${PLUGIN_ROOT}/bin/s" },
                r: { type: "sse", url: "https://x.test/${PLUGIN_ROOT}" },
                d: { type: "stdio", command: "node", cwd: "/abs" },
              },
            }),
          }
        ),
        "agent-plugins"
      )
      expect(command.blocking.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["mcpServers.s.command", "mcpServers.r", "mcpServers.d.cwd"])
      )
    })

    it("imports OpenHands and Copilot namespace agents, commands and hooks", () => {
      const result = normalizePlatformBundle(
        ap(
          "1.0.0",
          {},
          {
            "dev.openhands/agents/reviewer.md":
              "---\nname: reviewer\ndescription: Review\n---\nReview.",
            "dev.openhands/commands/check.md": "---\ndescription: Check\n---\nCheck.",
            "dev.openhands/hooks/hooks.json": json({
              hooks: {
                Stop: [
                  { hooks: [{ type: "command", command: "${PLUGIN_ROOT}/dev.openhands/stop.sh" }] },
                ],
              },
            }),
            "dev.openhands/stop.sh": "#!/bin/sh",
            "com.github.copilot/agents/linter.agent.md":
              "---\nname: Linter\ndescription: Lint\n---\nLint.",
          }
        ),
        "agent-plugins"
      )
      expect(result.blocking).toEqual([])
      const manifest = JSON.parse(result.files.get(".claude-plugin/plugin.json")!)
      expect(manifest.agents).toEqual([
        "./.cognia-normalized/agents/reviewer.md",
        "./.cognia-normalized/agents/linter.md",
      ])
      expect(manifest.commands).toEqual(["./.cognia-normalized/commands/check.md"])
      expect(result.files.get(manifest.hooks[0].slice(2))).toContain(
        "${CLAUDE_PLUGIN_ROOT}/dev.openhands/stop.sh"
      )
      expect([...result.transient]).toEqual(expect.arrayContaining([".claude-plugin/plugin.json"]))
      expect(result.warnings.map((issue) => issue.message).join("\n")).toMatch(
        /display name "Linter"/
      )
    })

    it.each([
      ["com.github.copilot/hooks/hooks.json", json({ version: 1, hooks: {} }), "hooks"],
      ["com.github.copilot/rules/style.md", "Use tabs", "rules"],
      ["com.github.copilot/lsp.json", "{}", "lspServers"],
      ["com.example/agents/x.md", "x", "platform-control"],
      ["dev.openhands/agents/bad.md", "---\ndescription: B\ntools: [x]\n---\nB", "agents"],
    ])("blocks namespace content without an exact mapping: %s", (path, text, capability) => {
      const result = normalizePlatformBundle(ap("1.0.0", {}, { [path]: text }), "agent-plugins")
      expect(result.blocking.map((issue) => issue.capability)).toContain(capability)
    })

    it("exports agents and hooks to the right client namespace per target", () => {
      const claude = bundle(
        {},
        {
          "agents/reviewer.md": "---\nname: reviewer\ndescription: Review\n---\nReview.\n",
          "hooks/hooks.json": json({
            hooks: {
              Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/s.sh" }] }],
            },
          }),
        }
      )
      const portable = projectPlatformBundle(claude, "agent-plugins")
      expect(portable.blocking).toEqual([])
      expect(portable.files.has("dev.openhands/agents/reviewer.md")).toBe(true)
      expect(portable.files.get("dev.openhands/hooks/hooks.json")).toContain("${PLUGIN_ROOT}/s.sh")
      expect(portable.warnings.map((issue) => issue.capability)).toContain("client-namespace")
      const copilot = projectPlatformBundle(claude, "copilot")
      expect(copilot.blocking.map((issue) => issue.capability)).toEqual(["command-hooks"])
      claude.delete("hooks/hooks.json")
      const agentsOnly = projectPlatformBundle(claude, "copilot")
      expect(agentsOnly.blocking).toEqual([])
      expect(agentsOnly.files.has("com.github.copilot/agents/reviewer.agent.md")).toBe(true)
      expect(agentsOnly.files.has("agents/reviewer.md")).toBe(false)
    })
  })

  describe("Copilot legacy manifest", () => {
    it("reads the root legacy manifest, *.agent.md agents and .github/mcp.json", () => {
      const result = normalizePlatformBundle(
        files({
          "plugin.json": json({ name: "review", category: "dev", tags: ["x"], commands: "./cmds" }),
          "agents/linter.agent.md": "---\nname: linter\ndescription: Lint\n---\nLint.",
          "agents/notes.md": "ignored: not an agent file",
          "cmds/check.md": "Check.",
          "skills/review/SKILL.md": skill,
          ".github/mcp.json": json({ mcpServers: { docs: { command: "npx", args: ["docs"] } } }),
        }),
        "copilot"
      )
      expect(result.blocking).toEqual([])
      expect(result.skills).toEqual(["skills/review/SKILL.md"])
      expect(JSON.parse(result.files.get(".claude-plugin/plugin.json")!)).toMatchObject({
        agents: ["./.cognia-normalized/agents/linter.md"],
        commands: ["./.cognia-normalized/commands/check.md"],
        mcpServers: "./.mcp.json",
      })
      expect(result.warnings.map((issue) => issue.capability)).toEqual(
        expect.arrayContaining(["category", "tags"])
      )
    })

    it("treats an Agent Plugins root manifest as portable and rejects unknown versions", () => {
      expect(
        normalizePlatformBundle(
          files({
            "plugin.json": json({ $schema: AGENT_PLUGINS_SCHEMA, name: "review" }),
            "skills/review/SKILL.md": skill,
          }),
          "copilot"
        ).blocking
      ).toEqual([])
      expect(
        normalizePlatformBundle(
          files({
            "plugin.json": json({
              $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
              name: "review",
            }),
          }),
          "copilot"
        ).blocking.map((issue) => issue.message)
      ).toEqual([expect.stringContaining("rejects plugins that declare an unsupported")])
    })

    it.each([
      [{ hooks: "./hooks.json" }, "hooks"],
      [{ lspServers: {} }, "lspServers"],
      [{ extensions: ["./ext"] }, "extensions"],
    ])("blocks legacy behavior without a mapping %j", (extra, capability) => {
      const result = normalizePlatformBundle(
        files({ ".github/plugin/plugin.json": json({ name: "review", ...extra }) }),
        "copilot"
      )
      expect(result.blocking.map((issue) => issue.capability)).toContain(capability)
    })
  })

  describe("Cursor components", () => {
    it("imports agents, commands and hooks and blocks rules and unmapped tokens", () => {
      const result = normalizePlatformBundle(
        files({
          ".cursor-plugin/plugin.json": json({
            name: "review",
            logo: "assets/logo.svg",
            mcpServers: [{ a: { command: "${CURSOR_PLUGIN_ROOT}/a" } }, "./more.json"],
          }),
          "more.json": json({ mcpServers: { b: { url: "https://x.test" } } }),
          "agents/reviewer.mdc": "---\ndescription: Review\n---\nReview.",
          "commands/deploy.txt": "Deploy now.",
          "hooks/hooks.json": json({
            hooks: { sessionStart: [{ command: "${CURSOR_PLUGIN_ROOT}/boot.sh" }] },
          }),
        }),
        "cursor"
      )
      expect(result.blocking).toEqual([])
      const manifest = JSON.parse(result.files.get(".claude-plugin/plugin.json")!)
      expect(manifest).toMatchObject({
        icon: "assets/logo.svg",
        agents: ["./.cognia-normalized/agents/reviewer.md"],
        commands: ["./.cognia-normalized/commands/deploy.md"],
      })
      expect(JSON.parse(result.files.get(".mcp.json")!).mcpServers).toMatchObject({
        a: { command: "${CLAUDE_PLUGIN_ROOT}/a" },
        b: { url: "https://x.test" },
      })
      expect(result.files.get(manifest.hooks[0].slice(2))).toContain("SessionStart")
      const blocked = normalizePlatformBundle(
        files({
          ".cursor-plugin/plugin.json": json({ name: "review" }),
          "rules/style.mdc": "---\nalwaysApply: true\n---\nTabs.",
          "mcp.json": json({ mcpServers: { a: { command: "node", args: ["${PLUGIN_ROOT}/a"] } } }),
        }),
        "cursor"
      )
      expect(blocked.blocking.map((issue) => issue.capability)).toEqual(
        expect.arrayContaining(["rules", "mcp"])
      )
    })

    it("reads variables as install settings and rejects schemas it cannot map", () => {
      const result = normalizePlatformBundle(
        files({
          ".cursor-plugin/plugin.json": json({
            name: "review",
            variables: {
              type: "object",
              properties: {
                API_TOKEN: { type: "string", title: "API token", description: "Token" },
              },
              required: ["API_TOKEN"],
            },
          }),
          "mcp.json": json({
            mcpServers: {
              api: { url: "https://x.test", headers: { Authorization: "${API_TOKEN}" } },
            },
          }),
        }),
        "cursor"
      )
      expect(result.blocking).toEqual([])
      expect(result.settings?.declarations).toEqual([
        { envVar: "API_TOKEN", name: "API token", description: "Token", sensitive: true },
      ])
      expect(result.settings?.servers).toHaveProperty("api")
      const invalid = normalizePlatformBundle(
        files({
          ".cursor-plugin/plugin.json": json({
            name: "review",
            variables: { type: "object", properties: { PORT: { type: "number" } }, oneOf: [] },
          }),
        }),
        "cursor"
      )
      expect(invalid.blocking.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          ".cursor-plugin/plugin.json.variables.oneOf",
          ".cursor-plugin/plugin.json.variables.properties.PORT",
        ])
      )
    })

    it("exports agents, flat hooks and variables", () => {
      const result = projectPlatformBundle(
        bundle(
          {
            mcpServers: {
              api: {
                type: "http",
                url: "https://x.test",
                headers: { Authorization: "${COGNIA_API_TOKEN}" },
              },
            },
          },
          {
            "agents/reviewer.md": "---\nname: reviewer\ndescription: Review\n---\nReview.\n",
            "hooks/hooks.json": json({
              hooks: {
                Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/s.sh" }] }],
              },
            }),
          }
        ),
        "cursor",
        { variables: [{ envVar: "COGNIA_API_TOKEN", name: "Token", sensitive: true }] }
      )
      expect(result.blocking).toEqual([])
      expect(JSON.parse(result.files.get("hooks/hooks.json")!)).toEqual({
        version: 1,
        hooks: { stop: [{ command: "${CURSOR_PLUGIN_ROOT}/s.sh" }] },
      })
      expect(JSON.parse(result.files.get(".cursor-plugin/plugin.json")!).variables).toEqual({
        type: "object",
        properties: { COGNIA_API_TOKEN: { type: "string", title: "Token" } },
        required: ["COGNIA_API_TOKEN"],
      })
      expect(result.files.has("agents/reviewer.md")).toBe(true)
    })
  })

  describe("Kimi, Devin and OpenCode specifics", () => {
    it("blocks a multi-skill Kimi export and keeps Kimi tool declarations explicit", () => {
      const two = bundle(
        {},
        { "skills/other/SKILL.md": skill.replace("name: review", "name: other") }
      )
      expect(
        projectPlatformBundle(two, "kimi").blocking.map((issue) => issue.capability)
      ).toContain("skills")
      const exported = projectPlatformBundle(bundle(), "kimi")
      expect(JSON.parse(exported.files.get("plugin.json")!)).toEqual({
        name: "review",
        version: "1.0.0",
        tools: [],
      })
      expect(exported.files.get("references/rules.md")).toBe("Review all changes.")
    })

    it("honors Devin skill selections, exclusive MCP paths and blocks governance lists", () => {
      const disabled = normalizePlatformBundle(
        files({
          ".devin-plugin/plugin.json": json({ name: "review", skills: [] }),
          "skills/review/SKILL.md": skill,
        }),
        "devin"
      )
      expect(disabled.blocking).toEqual([])
      expect(disabled.skills).toEqual([])
      const exclusive = normalizePlatformBundle(
        files({
          ".devin-plugin/plugin.json": json({
            name: "review",
            mcpServers: { paths: ["./servers.json"], exclusive: true },
          }),
          "servers.json": json({ mcpServers: { a: { command: "a" } } }),
          ".mcp.json": json({ mcpServers: { b: { command: "b" } } }),
        }),
        "devin"
      )
      const mcpPath = JSON.parse(exclusive.files.get(".claude-plugin/plugin.json")!).mcpServers
      expect(Object.keys(JSON.parse(exclusive.files.get(mcpPath.slice(2))!).mcpServers)).toEqual([
        "a",
      ])
      expect(exclusive.files.get(".mcp.json")).toBe("{}\n")
      for (const tree of [
        { ".devin-plugin/plugin.json": json({ name: "review", forbiddenPlugins: ["*"] }) },
        { ".devin-plugin/plugin.json": json({ name: "review" }), "AGENTS.md": "Always" },
        { ".devin-plugin/plugin.json": json({ name: "review", skills: ["../x"] }) },
      ] as Array<Record<string, string>>)
        expect(normalizePlatformBundle(files(tree), "devin").blocking.length).toBeGreaterThan(0)
      const hint = normalizePlatformBundle(
        files({
          ".devin-plugin/plugin.json": json({ name: "review" }),
          "skills/review/SKILL.md": skill.replace(
            "description:",
            "argument-hint: <x>\ndescription:"
          ),
        }),
        "devin"
      )
      expect(hint.blocking).toEqual([])
      expect(hint.warnings.map((issue) => issue.path)).toContain(
        "skills/review/SKILL.md.argument-hint"
      )
    })

    it("maps OpenCode cwd, env substitutions, commands and subagent-mode agents", () => {
      const result = normalizePlatformBundle(
        files({
          "opencode.json": json({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              docs: {
                type: "local",
                command: ["npx", "docs", "{env:DOCS_HOME}"],
                environment: { TOKEN: "{env:DOCS_TOKEN}" },
                cwd: "/srv",
                timeout: 9000,
              },
            },
          }),
          ".opencode/commands/review/full.md":
            "---\ndescription: Full review\n---\nReview @src/app.ts fully.",
          ".opencode/agents/helper.md":
            "---\ndescription: Help\nmode: subagent\nhidden: true\n---\nHelp.",
          ".opencode/skills/review/SKILL.md": skill,
        }),
        "opencode"
      )
      expect(result.blocking).toEqual([])
      expect(JSON.parse(result.files.get(".mcp.json")!).mcpServers.docs).toEqual({
        command: "npx",
        args: ["docs", "${DOCS_HOME}"],
        env: { TOKEN: "${DOCS_TOKEN}" },
        cwd: "/srv",
        type: "stdio",
      })
      expect(result.warnings.map((issue) => issue.message).join("\n")).toMatch(/@file references/)
      expect(result.warnings.map((issue) => issue.path)).toContain("mcp.docs.timeout")
      expect(result.files.get(".cognia-normalized/agents/helper.md")).toContain("hidden: true")
      expect(result.files.has(".cognia-normalized/commands/review-full.md")).toBe(true)
      for (const tree of [
        { ".opencode/agents/main.md": "---\ndescription: Main\nmode: primary\n---\nMain." },
        {
          ".opencode/agents/temp.md":
            "---\ndescription: T\nmode: subagent\ntemperature: 0.2\n---\nT.",
        },
        { ".opencode/commands/x.md": "---\ndescription: X\nagent: plan\n---\nX." },
        { ".opencode/plugins/index.ts": "export default {}" },
        { ".opencode/skills/review/SKILL.md": skill.replace("name: review", "name: other") },
      ] as Array<Record<string, string>>)
        expect(
          normalizePlatformBundle(
            files({ "opencode.json": json({ mcp: {} }), ...tree }),
            "opencode"
          ).blocking.length
        ).toBeGreaterThan(0)
      expect(
        normalizePlatformBundle(
          files({
            "opencode.json": json({
              mcp: { x: { type: "local", command: ["a"], environment: { K: "{file:./k}" } } },
            }),
          }),
          "opencode"
        ).blocking.length
      ).toBeGreaterThan(0)
    })

    it("exports OpenCode subagents with mode: subagent", () => {
      const result = projectPlatformBundle(
        bundle({}, { "agents/helper.md": "---\nname: helper\ndescription: Help\n---\nHelp.\n" }),
        "opencode"
      )
      expect(result.blocking).toEqual([])
      expect(result.files.get(".opencode/agents/helper.md")).toContain("mode: subagent")
      expect(
        projectPlatformBundle(
          bundle(
            {},
            { "agents/helper.md": "---\nname: helper\ndescription: Help\nmodel: x\n---\nHelp.\n" }
          ),
          "opencode"
        ).blocking.length
      ).toBeGreaterThan(0)
    })
  })
})
