import type { SendOptions } from "@cognia/agent-config-types"

import { OUTBOUND_TOOL_IDS } from "@/lib/policy/risk/outbound-tools"

import { alwaysExplicitToolNames, applyAlwaysExplicitTools } from "./always-explicit-tools"

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
      pluginPermissions: permissionsOf,
    })
    expect(shadow.alwaysExplicitToolsMode).toBe("observe")
    expect(shadow.alwaysExplicitTools).toContain("im_broadcast")

    const enforce = applyAlwaysExplicitTools({} as SendOptions, {
      mode: "enforce",
      pluginPermissions: permissionsOf,
    })
    expect(enforce.alwaysExplicitToolsMode).toBe("enforce")
  })
})
