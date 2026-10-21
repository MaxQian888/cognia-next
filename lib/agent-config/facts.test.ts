/** @jest-environment jsdom */

import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import {
  claudePermissionFacts,
  cogniaPermissionFacts,
  commandLabel,
  sanitizeFactText,
  hookFacts,
  parseClaudePermission,
  readAgentConfigFacts,
} from "./facts"

const SECRET = "sk-ant-api03-SECRETSECRETSECRETSECRET"

beforeEach(() => {
  useProjectStore.setState({
    activeProjectId: "ws-1",
    projects: [{ id: "ws-1", name: "Repo", roots: [{ id: "r", path: "/repo", isPrimary: true }] }],
  } as never)
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      defaultModel: "claude-opus-5-5",
      activeProviderId: "anthropic",
      instructions: { mode: "nearest", fileNames: ["AGENTS.md"] },
      agentPermissions: {
        toolRules: { bash: { "git push --force*": "deny" }, edit: "ask" },
        commandRules: { "rm -rf*": "deny" },
      },
    },
  } as never)
})

describe("commandLabel", () => {
  it("names the executable, never its arguments or environment", () => {
    expect(commandLabel(`API_KEY=${SECRET} /usr/local/bin/node hook.js --token ${SECRET}`)).toBe(
      "node"
    )
    expect(commandLabel('"C:\\Tools\\guard.exe" --x')).toBe("guard.exe")
    expect(commandLabel("")).toBe("command")
  })

  it("never shows a URL query or an odd-looking name", () => {
    expect(commandLabel(`https://h.example.com/run?token=${SECRET}`)).toBe("run")
    expect(commandLabel("$(cat secret)")).toBe("command")
  })
})

describe("sanitizeFactText", () => {
  // A credential no PII detector recognizes: only the shapes catch it.
  const PLAIN = "hunter2plain"

  it("masks credentials a remembered command can carry", () => {
    const out = [
      `PGPASSWORD=${PLAIN} psql -h db`,
      `mysql -u root -p${PLAIN} app`,
      `curl -u admin:${PLAIN} https://x.example.com`,
      `deploy --token ${PLAIN}`,
      `deploy --api-key=${PLAIN}`,
      `git clone https://bot:${PLAIN}@git.example.com/r.git`,
      `curl https://x.example.com/a?sig=${PLAIN}&b=1`,
    ].map(sanitizeFactText)
    for (const row of out) {
      expect(row).toBeDefined()
      expect(row).not.toContain(PLAIN)
    }
    expect(out[0]).toBe("PGPASSWORD=[REDACTED] psql -h db")
  })

  it("keeps ordinary patterns untouched", () => {
    expect(sanitizeFactText("npm run test:*")).toBe("npm run test:*")
    expect(sanitizeFactText("git push*")).toBe("git push*")
  })
})

describe("hookFacts", () => {
  it("reduces every handler kind to a label without secrets", () => {
    const facts = hookFacts("user", {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: `TOKEN=${SECRET} ./guard.sh ${SECRET}` },
            {
              type: "http",
              url: `https://hooks.example.com/x?sig=${SECRET}`,
              headers: { Authorization: SECRET },
            },
            { type: "mcp_tool", server: "gh", tool: "comment", input: { body: SECRET } },
            { type: "prompt", prompt: `Check ${SECRET}` },
          ],
        },
      ],
      Stop: "not a list",
    } as never)
    expect(facts).toEqual([
      { scope: "user", event: "PreToolUse", matcher: "Bash", type: "command", label: "guard.sh" },
      {
        scope: "user",
        event: "PreToolUse",
        matcher: "Bash",
        type: "http",
        label: "hooks.example.com",
      },
      {
        scope: "user",
        event: "PreToolUse",
        matcher: "Bash",
        type: "mcp_tool",
        label: "gh/comment",
      },
      { scope: "user", event: "PreToolUse", matcher: "Bash", type: "prompt", label: "prompt" },
    ])
    expect(JSON.stringify(facts)).not.toContain("SECRET")
  })
})

describe("permission facts", () => {
  it("parses Claude Code rule strings", () => {
    expect(parseClaudePermission("Bash(npm run test:*)")).toEqual({
      tool: "Bash",
      pattern: "npm run test:*",
    })
    expect(parseClaudePermission("Read")).toEqual({ tool: "Read", pattern: "*" })
    expect(
      claudePermissionFacts("claude-project", { allow: ["Read"], deny: ["Bash(curl:*)", 3] })
    ).toEqual([
      { origin: "claude-project", tool: "Read", pattern: "*", verdict: "allow" },
      { origin: "claude-project", tool: "Bash", pattern: "curl:*", verdict: "deny" },
    ])
  })

  it("never passes a credential in a remembered rule", () => {
    const facts = claudePermissionFacts("claude-local", {
      allow: [`Bash(PGPASSWORD=${SECRET} psql:*)`],
    })
    expect(facts).toHaveLength(1)
    expect(JSON.stringify(facts)).not.toContain(SECRET)
    const cognia = cogniaPermissionFacts(undefined, { [`deploy --token ${SECRET}`]: "allow" })
    expect(JSON.stringify(cognia)).not.toContain(SECRET)
  })

  it("lists Cognia's tool and command rules", () => {
    expect(cogniaPermissionFacts({ bash: { "git push*": "ask" } }, { "rm*": "deny" })).toEqual([
      { origin: "cognia-tools", tool: "bash", pattern: "git push*", verdict: "ask" },
      { origin: "cognia-commands", tool: "bash", pattern: "rm*", verdict: "deny" },
    ])
  })
})

describe("readAgentConfigFacts", () => {
  it("summarizes settings, hooks, rules, servers and skills without configuration values", async () => {
    const readClaudeSettings = jest.fn(async () => ({
      user: { hooks: { Stop: [{ hooks: [{ type: "command", command: `notify ${SECRET}` }] }] } },
      project: { permissions: { deny: ["Bash(git push:*)"] } },
      local: null,
      merged: {},
    }))
    const facts = await readAgentConfigFacts(undefined, {
      isDesktop: () => true,
      readClaudeSettings: readClaudeSettings as never,
      listServers: async () =>
        [
          {
            id: "m1",
            name: "GitHub",
            transport: "http",
            enabled: true,
            config: { headers: { Authorization: SECRET } },
          },
          {
            id: "m2",
            name: "Plugin",
            transport: "stdio",
            enabled: false,
            pluginId: "p",
            config: {},
          },
        ] as never,
      listAllSkills: async () =>
        [{ status: "enabled", isBuiltIn: true }, { status: "disabled" }, {}] as never,
    })
    expect(readClaudeSettings).toHaveBeenCalledWith("/repo")
    expect(facts).toMatchObject({
      defaultModel: "claude-opus-5-5",
      defaultProviderId: "anthropic",
      instructions: { mode: "nearest", fileNames: ["AGENTS.md"], enabled: true },
      hooksAvailable: true,
      hooks: [{ scope: "user", event: "Stop", type: "command", label: "notify" }],
      mcpServers: [
        { id: "m1", name: "GitHub", transport: "http", enabled: true, pluginOwned: false },
        { id: "m2", name: "Plugin", transport: "stdio", enabled: false, pluginOwned: true },
      ],
      skills: { total: 3, enabled: 2, builtIn: 1 },
    })
    expect(facts.permissionRules).toEqual([
      { origin: "cognia-tools", tool: "bash", pattern: "git push --force*", verdict: "deny" },
      { origin: "cognia-tools", tool: "edit", pattern: "*", verdict: "ask" },
      { origin: "cognia-commands", tool: "bash", pattern: "rm -rf*", verdict: "deny" },
      { origin: "claude-project", tool: "Bash", pattern: "git push:*", verdict: "deny" },
    ])
    expect(JSON.stringify(facts)).not.toContain("SECRET")
  })

  it("says hooks are unavailable off the desktop instead of reporting none", async () => {
    const readClaudeSettings = jest.fn()
    const facts = await readAgentConfigFacts(undefined, {
      isDesktop: () => false,
      readClaudeSettings,
      listServers: async () => [],
      listAllSkills: async () => [],
    })
    expect(readClaudeSettings).not.toHaveBeenCalled()
    expect(facts.hooksAvailable).toBe(false)
    expect(facts.hooks).toEqual([])
  })
})
