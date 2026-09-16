import fs from "node:fs"
import path from "node:path"

import {
  API_COMMANDS,
  commandGroups,
  findByGroupAction,
  findCommand,
  flagToProperty,
  listCommands,
  suggestCommands,
} from "./catalog"

const REPO_ROOT = path.resolve(__dirname, "../../..")

function manifestCommands(): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "protocol/companion-commands.json"), "utf8")
  return (JSON.parse(raw) as { commands: Array<Record<string, unknown>> }).commands
}

describe("generated command index", () => {
  it("carries every command the protocol manifest exposes on a wire", () => {
    const reachable = manifestCommands().filter((command) =>
      (command.transports as string[]).some((transport) => transport !== "internal")
    )
    // The manifest's `internal` transport means "renderer-local IPC", which is
    // a different thing from the CLI's `internal` wire (`/internal/_rpc`).
    // Everything reachable over http must be in the index.
    for (const command of reachable) {
      expect(findCommand(command.name as string)).toBeDefined()
    }
  })

  it("agrees with the OpenAPI specs on how many commands each wire carries", () => {
    const internal = API_COMMANDS.filter((entry) => entry.wires.includes("internal"))
    const http = API_COMMANDS.filter((entry) => entry.wires.includes("http"))
    expect(internal).toHaveLength(700)
    expect(http).toHaveLength(555)
  })

  it("keeps the manifest's authority metadata verbatim", () => {
    const byName = new Map(manifestCommands().map((command) => [command.name as string, command]))
    for (const entry of API_COMMANDS) {
      const source = byName.get(entry.name)
      expect(source).toBeDefined()
      expect(entry.target).toBe(source!.target)
      expect(entry.capability).toBe(source!.capability)
      expect(entry.risk).toBe(source!.risk)
      expect(entry.approval).toBe(source!.approval)
    }
  })

  it("only puts execution and host-admin targets on the device wire", () => {
    // `authorize_transport` refuses anything else for a non-service principal,
    // so an index that claimed otherwise would send calls guaranteed to 403.
    for (const entry of API_COMMANDS) {
      if (!entry.wires.includes("http")) continue
      expect(["execution", "host-admin"]).toContain(entry.target)
    }
  })

  it("never derives two flags with the same name inside one command", () => {
    for (const entry of API_COMMANDS) {
      const flags = entry.flags.map((flag) => flag.flag).filter((flag) => flag.length > 0)
      expect(new Set(flags).size).toBe(flags.length)
    }
  })

  it("leaves a withheld flag reachable by its property name", () => {
    // `agent_close_session` carries both `session_id` and `sessionId`, and they
    // kebab-case identically, so only the first keeps the shorthand.
    const entry = findCommand("agent_close_session")
    expect(entry).toBeDefined()
    const alias = entry!.flags.find((flag) => flag.name === "sessionId")
    expect(alias).toBeDefined()
    expect(alias!.flag).toBe("")
    expect(entry!.flags.find((flag) => flag.name === "session_id")!.flag).toBe("session-id")
  })

  it("records alias requirement groups instead of marking both spellings required", () => {
    const entry = findCommand("agent_send")!
    expect(entry.requireOneOf).toEqual([["session_id", "sessionId"]])
    expect(entry.flags.find((flag) => flag.name === "session_id")!.required).toBeUndefined()
  })

  it("marks a top-level oneOf body as composed with no derived flags", () => {
    const entry = findCommand("twin_profile_update")!
    expect(entry.bodyKind).toBe("composed")
    expect(entry.flags).toEqual([])
  })

  it("drops the null member from a nullable enum", () => {
    const entry = findCommand("adapter_update_policy")!
    const autonomy = entry.flags.find((flag) => flag.name === "defaultAutonomy")!
    expect(autonomy.nullable).toBe(true)
    expect(autonomy.enum).not.toContain(null)
    expect(autonomy.enum).toContain("observe")
  })

  it("maps objects and arrays to the json flag type", () => {
    const entry = findCommand("adapter_update_policy")!
    expect(entry.flags.find((flag) => flag.name === "quietHours")!.type).toBe("json")
    expect(entry.flags.find((flag) => flag.name === "hostCapabilityCeiling")!.type).toBe("json")
    expect(entry.flags.find((flag) => flag.name === "muted")!.type).toBe("boolean")
    expect(entry.flags.find((flag) => flag.name === "activationTtlMs")!.type).toBe("integer")
  })
})

describe("lookup", () => {
  it("resolves a command by group and action", () => {
    expect(findByGroupAction("plugin", "list")?.name).toBe("plugin_list")
    expect(findByGroupAction("agent", "task-cancel")?.name).toBe("agent_task_cancel")
  })

  it("accepts a wire name in the group slot so both spellings share one path", () => {
    expect(findByGroupAction("plugin_list", "")?.name).toBe("plugin_list")
  })

  it("returns undefined rather than guessing at an unknown pair", () => {
    expect(findByGroupAction("plugin", "definitely-not-a-verb")).toBeUndefined()
  })

  it("filters by group, wire, risk and free text", () => {
    const plugins = listCommands({ group: "plugin" })
    expect(plugins.length).toBeGreaterThan(0)
    expect(plugins.every((entry) => entry.group === "plugin")).toBe(true)

    const httpOnly = listCommands({ wire: "http" })
    expect(httpOnly.every((entry) => entry.wires.includes("http"))).toBe(true)

    const critical = listCommands({ risk: "critical" })
    expect(critical.every((entry) => entry.risk === "critical")).toBe(true)

    expect(
      listCommands({ search: "SCHEDULER" }).every((entry) => /scheduler/i.test(entry.name))
    ).toBe(true)
  })

  it("counts groups and sorts them by name", () => {
    const groups = commandGroups()
    expect(groups.length).toBeGreaterThan(40)
    const names = groups.map((group) => group.group)
    expect([...names].sort()).toEqual(names)
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(API_COMMANDS.length)
  })

  it("scopes group counts to one wire", () => {
    const httpTotal = commandGroups("http").reduce((total, group) => total + group.count, 0)
    expect(httpTotal).toBe(listCommands({ wire: "http" }).length)
  })

  it("resolves a typed flag back to its request-body property", () => {
    const entry = findCommand("adapter_update_policy")!
    expect(flagToProperty(entry, "default-mode")?.name).toBe("defaultMode")
    expect(flagToProperty(entry, "not-a-flag")).toBeUndefined()
  })

  it("never resolves a withheld flag by its empty name", () => {
    const entry = findCommand("agent_close_session")!
    expect(flagToProperty(entry, "")).toBeUndefined()
  })

  it("suggests near misses for a mistyped command", () => {
    expect(suggestCommands("plugin_lst")).toContain("plugin_list")
    expect(suggestCommands("scheduled-task-creat")).toContain("scheduled_task_create")
  })

  it("suggests nothing for input that resembles no command", () => {
    expect(suggestCommands("zzzz")).toEqual([])
  })
})
