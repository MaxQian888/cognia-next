import {
  AGENT_PLUGINS_SCHEMA,
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
    [".cursor-plugin/plugin.json", "cursor"],
    ["kimi.plugin.json", "kimi"],
    [".kimi-plugin/plugin.json", "kimi"],
    [".devin-plugin/plugin.json", "devin"],
    [".github/plugin/plugin.json", "copilot"],
    [".github/plugin.json", "copilot"],
    ["opencode.json", "opencode"],
    ["opencode.jsonc", "opencode"],
  ] as const)("detects %s", (path, target) => {
    expect(detectPlatformBundle(files({ [path]: "{}" }))).toBe(target)
  })

  it("detects Pi packages by resource manifest or keyword", () => {
    expect(detectPlatformBundle(files({ "package.json": json({ pi: {} }) }))).toBe("pi")
    expect(
      detectPlatformBundle(files({ "package.json": json({ keywords: ["pi-package"] }) }))
    ).toBe("pi")
    expect(PLATFORM_BUNDLE_PROFILES.devin.hooks).toBe("local-fail-open")
  })

  it.each(["agent-plugins", "cursor", "copilot", "kimi", "devin", "opencode", "pi"] as const)(
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
      const prefix = target === "opencode" ? ".opencode/" : ""
      expect(imported.files.get(`${prefix}skills/review/agents/openai.yaml`)).toContain(
        "display_name"
      )
      expect(imported.files.get(`${prefix}skills/review/assets/icon.png`)).toBe(
        "BINARY_PLACEHOLDER"
      )
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

  it.each(["agent-plugins", "copilot", "cursor", "devin", "kimi"] as const)(
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
    ["kimi", { sessionStart: { skill: "setup" } }],
    ["devin", { requiredPlugins: ["base"] }],
    ["pi", { pi: { extensions: ["./runtime.ts"] }, scripts: { postinstall: "node setup.js" } }],
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
    expect(projectPlatformBundle(new Map(), "pi").blocking).not.toHaveLength(0)
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
      normalizePlatformBundle(files({ "kimi.plugin.json": "[]" }), "kimi").blocking
    ).not.toHaveLength(0)
    expect(
      normalizePlatformBundle(files({ ".kimi-plugin/plugin.json": "{}" }), "kimi").blocking
    ).not.toHaveLength(0)
    expect(
      normalizePlatformBundle(files({ "opencode.jsonc": "// comment\n{}" }), "opencode").blocking
    ).not.toHaveLength(0)
  })

  it("blocks Pi MCP and OpenCode plugin-root or remote assumptions", () => {
    const source = bundle({
      mcpServers: { server: { command: "node", cwd: "${CLAUDE_PLUGIN_ROOT}" } },
    })
    expect(projectPlatformBundle(source, "pi").blocking).not.toHaveLength(0)
    expect(projectPlatformBundle(source, "opencode").blocking).not.toHaveLength(0)
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
      "kimi.plugin.json": json({ name: "review", mcpServers: "./config/servers.json" }),
      "config/servers.json": json({
        mcpServers: {
          docs: { url: "https://example.test", headers: { Authorization: "secret-literal" } },
        },
      }),
      "mcp.json": json({ unused: "secret-literal" }),
    })
    const result = normalizePlatformBundle(input, "kimi")
    expect(result.blocking).toEqual([])
    expect(result.files.get("kimi.plugin.json")).toBe("{}\n")
    expect(result.files.get("config/servers.json")).toBe("{}\n")
    expect(result.files.get("mcp.json")).toBe("{}\n")
    // The canonical sanitizer consumes this config next; raw source files
    // cannot bypass it by remaining in the installer's original tree.
    expect(result.files.get(".mcp.json")).toContain("secret-literal")
    expect(input.get("config/servers.json")).toContain("secret-literal")
  })

  it.each(["cursor", "kimi", "pi", "copilot"] as const)(
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
      expect(result.files.get("skills/review/SKILL.md")).toContain("disable-model-invocation: true")
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

  it.each(["cursor", "copilot", "kimi", "devin", "pi", "opencode", "agent-plugins"] as const)(
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
      "kimi.plugin.json": '{"name":"review","skills":"./skills"}',
      "skills/review/SKILL.md": skill.replace(
        "description:",
        "disableModelInvocation: true\ntype: inline\ndescription:"
      ),
    })
    const result = normalizePlatformBundle(input, "kimi")
    expect(result.blocking).toEqual([])
    expect(result.files.get("skills/review/SKILL.md")).toContain("disable-model-invocation: true")
    for (const extra of [
      "type: flow",
      "arguments: target",
      "whenToUse: deploy",
      "disableModelInvocation: true\ndisable-model-invocation: false",
    ]) {
      input.set("skills/review/SKILL.md", skill.replace("description:", `${extra}\ndescription:`))
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
    const pi = files({ "package.json": '{"name":"review","pi":{}}', "skills/loose.md": skill })
    expect(normalizePlatformBundle(pi, "pi").blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "skills/loose.md" })])
    )
  })

  it("does not activate undeclared Kimi skills or discard fixed-location skill roots", () => {
    const input = files({
      "kimi.plugin.json": '{"name":"review"}',
      "skills/review/SKILL.md": skill,
    })
    expect(normalizePlatformBundle(input, "kimi").blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "skills" })])
    )
    input.set("SKILL.md", skill)
    expect(
      JSON.parse(normalizePlatformBundle(input, "kimi").files.get(".claude-plugin/plugin.json")!)
        .skills
    ).toBe("./SKILL.md")
    input.set("kimi.plugin.json", '{"name":"review","skills":[]}')
    expect(normalizePlatformBundle(input, "kimi").blocking.length).toBeGreaterThan(0)
    expect(
      projectPlatformBundle(bundle({ skills: "./custom" }), "pi").blocking.length
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
})
