import type { SendOptions } from "@cognia/agent-config-types"

import { OUTBOUND_TOOL_IDS } from "@/lib/policy/risk/outbound-tools"

import {
  __resetIntegrationRegistryForTesting,
  integrationToolName,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"

import {
  alwaysExplicitGithubToolNames,
  alwaysExplicitToolNames,
  applyAlwaysExplicitTools,
} from "./always-explicit-tools"

type PluginTool = NonNullable<SendOptions["pluginTools"]>[number]

function tool(name: string, pluginId: string, access?: PluginTool["access"]): PluginTool {
  return { name, pluginId, description: name, jsonSchema: {}, ...(access ? { access } : {}) }
}

const PERMISSIONS: Record<string, string[]> = {
  slack: ["connectors:send"],
  notes: ["filesystem:write"],
}
const permissionsOf = (pluginId: string) => PERMISSIONS[pluginId] ?? []

describe("alwaysExplicitToolNames", () => {
  it("lists every outbound tool id even when the turn has no plugin tools", () => {
    expect(alwaysExplicitToolNames(undefined, permissionsOf)).toEqual([...OUTBOUND_TOOL_IDS].sort())
  })

  it("adds the plugin tools in the outbound class, by registered name", () => {
    const names = alwaysExplicitToolNames(
      [
        tool("Slack_Post", "slack"),
        tool("slack_history", "slack", "read"),
        tool("note_write", "notes"),
        tool("deploy_site", "sites"),
      ],
      permissionsOf
    )
    expect(names).toContain("slack_post")
    expect(names).not.toContain("slack_history")
    expect(names).not.toContain("note_write")
    expect(names.filter((n) => n === "deploy_site")).toHaveLength(1)
  })
})

describe("applyAlwaysExplicitTools", () => {
  it("observes in shadow mode and enforces only in enforce mode", () => {
    const shadow = applyAlwaysExplicitTools({} as SendOptions, {
      mode: "shadow",
      githubMode: "shadow",
      pluginPermissions: permissionsOf,
    })
    expect(shadow.alwaysExplicitToolsMode).toBe("observe")
    expect(shadow.alwaysExplicitTools).toContain("im_broadcast")

    const enforce = applyAlwaysExplicitTools({} as SendOptions, {
      mode: "enforce",
      githubMode: "shadow",
      pluginPermissions: permissionsOf,
    })
    expect(enforce.alwaysExplicitToolsMode).toBe("enforce")
    // Enforcing messaging does not enforce GitHub writes.
    expect(enforce.alwaysExplicitGithubWritesMode).toBe("observe")
  })
})

describe("GitHub writes (ADR-0239 phase 2)", () => {
  const github = (id: string, risk: "read" | "write" | "destructive") => ({
    id,
    label: id,
    handler: id,
    inputSchema: {},
    risk,
    idempotency: "required" as const,
  })

  beforeEach(() => {
    __resetIntegrationRegistryForTesting()
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: [],
          eventTypes: [],
          actions: [github("commentPr", "write"), github("getIssue", "read")],
        },
      ],
      handlers: { "github:commentPr": async () => ({}), "github:getIssue": async () => ({}) },
    })
  })
  afterEach(() => __resetIntegrationRegistryForTesting())

  const comment = integrationToolName("github-delivery", "github", "commentPr")
  const read = integrationToolName("github-delivery", "github", "getIssue")

  it("lists the turn's GitHub write actions by full name, never reads or other tools", () => {
    expect(
      alwaysExplicitGithubToolNames([
        tool(comment, "github-delivery"),
        tool(read, "github-delivery"),
        tool("commentpr", "other"),
      ])
    ).toEqual([comment])
    // They stay out of the messaging list, whose entries match by short name.
    expect(
      alwaysExplicitToolNames([tool(comment, "github-delivery")], permissionsOf)
    ).not.toContain("commentpr")
  })

  it("stamps the GitHub category's mode, observing until it is enforced", () => {
    const shadow = applyAlwaysExplicitTools(
      { pluginTools: [tool(comment, "github-delivery")] } as SendOptions,
      { mode: "enforce", githubMode: "shadow", pluginPermissions: permissionsOf }
    )
    expect(shadow.alwaysExplicitGithubWritesMode).toBe("observe")
    expect(shadow.alwaysExplicitGithubTools).toEqual([comment])

    const enforce = applyAlwaysExplicitTools({} as SendOptions, {
      mode: "shadow",
      githubMode: "enforce",
      pluginPermissions: permissionsOf,
    })
    // Shell gh writes are inspected even when the turn has no GitHub action.
    expect(enforce.alwaysExplicitGithubWritesMode).toBe("enforce")
    expect(enforce.alwaysExplicitGithubTools).toBeUndefined()
  })
})
