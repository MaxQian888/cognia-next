import type {
  AgentConfigEdit,
  AgentConfigFacts,
  AgentConfigHookFact,
  AgentConfigReferenceCheck,
  AgentConfigSurface,
} from "./types"

/**
 * `types.ts` is declarations only. These fixtures pin the contract plugins
 * compile against: a field renamed or narrowed here fails `tsc` on this file
 * before it breaks a plugin.
 */
describe("agent-config types", () => {
  it("describes a surface by key, owner and edit path", () => {
    const surface: AgentConfigSurface = {
      key: "agent-file:%2Fr%2F.claude%2Fagents|reviewer.md",
      source: "agent-file",
      kind: "agent-definition",
      name: "reviewer.md",
      builtIn: false,
      modified: false,
      edit: "source",
      loadOrder: 0,
      layer: "agent-dir",
      path: "/r/.claude/agents/reviewer.md",
    }
    expect(surface.source).toBe("agent-file")
  })

  it("keeps secret-bearing settings structural", () => {
    const hook: AgentConfigHookFact = {
      scope: "project",
      event: "PreToolUse",
      type: "command",
      label: "guard.sh",
    }
    const facts: AgentConfigFacts = {
      instructions: {
        enabled: true,
        mode: "layered",
        fileNames: ["CLAUDE.md"],
        includeGlobal: true,
        maxFileBytes: 1,
        loadProjectAgents: true,
      },
      hooksAvailable: true,
      hooks: [hook],
      permissionRules: [
        { origin: "claude-project", tool: "Bash", pattern: "rm *", verdict: "deny" },
      ],
      mcpServers: [{ id: "m", name: "M", transport: "stdio", enabled: true, pluginOwned: false }],
      skills: { total: 1, enabled: 1, builtIn: 0 },
    }
    // A hook fact names the executable only: no command line, arguments or environment.
    expect(Object.keys(facts.hooks[0]!).sort()).toEqual(["event", "label", "scope", "type"])
  })

  it("carries reference statuses and edit preconditions", () => {
    const check: AgentConfigReferenceCheck = {
      paths: [{ path: "lib/x.ts", status: "symlink" }],
      scripts: [{ name: "test", status: "unchecked" }],
    }
    const edit: AgentConfigEdit = {
      key: "skill:a",
      text: "t",
      version: "v",
      workspaceId: null,
      summary: "s",
    }
    expect(check.paths[0]!.status).toBe("symlink")
    expect(edit.version).toBe("v")
  })
})
