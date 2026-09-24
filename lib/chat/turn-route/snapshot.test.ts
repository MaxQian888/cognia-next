import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import {
  ensureRouteStoresReady,
  loadHostRuntimeConfigs,
  requestRouteStores,
  routeSquadsFor,
  routeTargetsFromStores,
  snapshotRouteContext,
} from "./snapshot"

// The route stores boot with the `knowledge-agents` capability and hydrate
// through the Squad bridge. Each test decides when (and whether) either lands.
const boot = { capability: jest.fn((_capability: string) => Promise.resolve()) }
jest.mock("@/lib/boot/capabilities", () => ({
  ensureBootCapability: (capability: string) => boot.capability(capability),
}))
const bridge = { hydrated: jest.fn(() => Promise.resolve()) }
jest.mock("@/stores/agent/agent-team-store/dexie-bridge", () => ({
  whenAgentTeamDexieBridgeHydrated: () => bridge.hydrated(),
}))

const teamState: { teams: Record<string, AgentTeam>; teammates: Record<string, AgentTeammate> } = {
  teams: {},
  teammates: {},
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => teamState },
}))
const projectState = { activeProjectId: null as string | null }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => projectState },
}))
const externalState = {
  enabled: true,
  agents: {} as Record<string, unknown>,
  agentValidity: {},
}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: { getState: () => externalState },
}))
jest.mock("@/stores/agent/external-agent-store/selectors", () => ({
  hydrateAgentConfig: (stored: unknown) => stored,
}))
const refs: Record<string, unknown> = {}
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  runtimeRefForSession: (id?: string) => (id && refs[id]) || { kind: "builtin" },
  useRuntimeRefForSession: () => ({ kind: "builtin" }),
}))
jest.mock("@/lib/ai/agent/external/capability/process-plane", () => ({
  PROCESS_PLANE_COMMANDS: { spawn: "spawn" },
  externalAgentProcessPlane: () => ({ ok: true, via: "local" }),
}))
jest.mock("@/lib/ai/agent/external/config/config-normalizer", () => ({
  getExternalAgentExecutionBlock: () => null,
}))
const hostConfigs = { available: false, list: jest.fn() }
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-host-configs", () => ({
  HOST_CONFIG_COMMANDS: { list: "external_agent_config_list" },
  hostConfigsAvailability: () =>
    hostConfigs.available ? { ok: true } : { ok: false, reason: "no-host" },
  listRemoteHostConfigs: () => hostConfigs.list(),
}))
const subagentHandles: string[] = []
jest.mock("@/lib/claude/agents/chat-mention-targets", () => ({
  buildChatMentionTargets: () => subagentHandles.map((handle) => ({ handle })),
}))
const sessions: Record<string, unknown> = {}
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => Promise.resolve(sessions[id]),
}))

function team(id: string, name: string, teammateIds: string[], projectId?: string): AgentTeam {
  return {
    id,
    name,
    status: "idle",
    config: {},
    teammateIds,
    ...(projectId ? { projectId } : {}),
  } as unknown as AgentTeam
}
function mate(id: string, teamId: string, name: string, config = {}): AgentTeammate {
  return { id, teamId, name, description: "", config } as unknown as AgentTeammate
}

beforeEach(() => {
  boot.capability.mockReset()
  boot.capability.mockImplementation((_capability: string) => Promise.resolve())
  bridge.hydrated.mockReset()
  bridge.hydrated.mockImplementation(() => Promise.resolve())
  teamState.teams = {}
  teamState.teammates = {}
  projectState.activeProjectId = null
  externalState.enabled = true
  externalState.agents = {}
  hostConfigs.available = false
  hostConfigs.list.mockReset()
  subagentHandles.length = 0
  for (const key of Object.keys(sessions)) delete sessions[key]
  for (const key of Object.keys(refs)) delete refs[key]
})

describe("routeSquadsFor", () => {
  it("lists the bound Squad first, then the rest in presence order", () => {
    const teams = {
      a: team("a", "Alpha", ["m1"]),
      b: team("b", "Beta", ["m2"]),
    }
    const teammates = { m1: mate("m1", "a", "Ann"), m2: mate("m2", "b", "Ben") }
    expect(routeSquadsFor({ teams, teammates }).map((s) => s.team.id)).toEqual(["a", "b"])
    expect(routeSquadsFor({ teams, teammates, boundSquadId: "b" }).map((s) => s.team.id)).toEqual([
      "b",
      "a",
    ])
  })

  it("keeps roster order, drops members that moved and Squads with nobody left", () => {
    const teams = {
      a: team("a", "Alpha", ["m2", "m1", "ghost"]),
      e: team("e", "Empty", []),
    }
    const teammates = { m1: mate("m1", "a", "Ann"), m2: mate("m2", "a", "Ben") }
    const squads = routeSquadsFor({ teams, teammates })
    expect(squads.map((s) => s.team.id)).toEqual(["a"])
    expect(squads[0].teammates.map((m) => m.id)).toEqual(["m2", "m1"])
  })

  it("scopes to the workspace but shares Squads that belong to none", () => {
    const teams = {
      mine: team("mine", "Mine", ["m1"], "p1"),
      other: team("other", "Other", ["m2"], "p2"),
      shared: team("shared", "Shared", ["m3"]),
    }
    const teammates = {
      m1: mate("m1", "mine", "A"),
      m2: mate("m2", "other", "B"),
      m3: mate("m3", "shared", "C"),
    }
    expect(routeSquadsFor({ teams, teammates, workspaceId: "p1" }).map((s) => s.team.id)).toEqual([
      "mine",
      "shared",
    ])
  })

  it("ignores a binding to a Squad that no longer exists", () => {
    const teams = { a: team("a", "Alpha", ["m1"]) }
    const teammates = { m1: mate("m1", "a", "Ann") }
    expect(routeSquadsFor({ teams, teammates, boundSquadId: "gone" })).toHaveLength(1)
  })
})

describe("routeTargetsFromStores", () => {
  it("builds the targets from the stores, reserving the subagent handles", () => {
    teamState.teams = { a: team("a", "Ops", ["m1"]) }
    teamState.teammates = { m1: mate("m1", "a", "Reviewer") }
    subagentHandles.push("reviewer")
    const targets = routeTargetsFromStores(null)
    expect(targets.map((t) => t.handle)).toEqual(["claude", "codex", "ops-reviewer"])
  })

  it("falls back to the active workspace when the conversation names none", () => {
    projectState.activeProjectId = "p1"
    teamState.teams = { a: team("a", "A", ["m1"], "p2") }
    teamState.teammates = { m1: mate("m1", "a", "Ann") }
    expect(routeTargetsFromStores({ projectId: undefined }).map((t) => t.handle)).toEqual([
      "claude",
      "codex",
    ])
    expect(routeTargetsFromStores({ projectId: "p2" })).toHaveLength(3)
  })
})

describe("loadHostRuntimeConfigs", () => {
  it("reads nothing when no host serves configurations", async () => {
    await expect(loadHostRuntimeConfigs()).resolves.toEqual([])
    expect(hostConfigs.list).not.toHaveBeenCalled()
  })

  it("treats a failed read as no host rows", async () => {
    hostConfigs.available = true
    hostConfigs.list.mockRejectedValue(new Error("offline"))
    await expect(loadHostRuntimeConfigs()).resolves.toEqual([])
  })

  it("returns what the host lists", async () => {
    hostConfigs.available = true
    hostConfigs.list.mockResolvedValue([{ configId: "eac_1" }])
    await expect(loadHostRuntimeConfigs()).resolves.toEqual([{ configId: "eac_1" }])
  })
})

describe("snapshotRouteContext", () => {
  it("gathers the pane's own session, lane, catalog and Squads", async () => {
    sessions["chat-1"] = { id: "chat-1", squadId: "a", projectId: undefined }
    refs["chat-1"] = { kind: "external", agentId: "cx" }
    teamState.teams = { a: team("a", "Alpha", ["m1"]) }
    teamState.teammates = { m1: mate("m1", "a", "Ann") }
    externalState.agents = {
      cx: {
        id: "cx",
        name: "Codex",
        protocol: "codex-app-server",
        enabled: true,
        metadata: { preset: "codex-app-server" },
      },
      hand: { id: "hand", name: "Hand", protocol: "acp", enabled: true },
    }
    const snapshot = await snapshotRouteContext("chat-1")
    expect(snapshot.currentRef).toEqual({ kind: "external", agentId: "cx" })
    expect(snapshot.targets.map((t) => t.handle)).toEqual(["claude", "codex", "ann"])
    expect(snapshot.runtimes.map((r) => r.key)).toEqual(["builtin", "external:cx", "external:hand"])
    expect(snapshot.runtimes[1].presetId).toBe("codex-app-server")
    expect(snapshot.configuredPresetIds).toEqual(["codex-app-server"])
    expect(snapshot.externalEnabled).toBe(true)
    expect(snapshot.teams).toBe(teamState.teams)
  })

  it("resolves the new-chat composer against the app defaults", async () => {
    const snapshot = await snapshotRouteContext(null)
    expect(snapshot.currentRef).toEqual({ kind: "builtin" })
    expect(snapshot.runtimes.map((r) => r.key)).toEqual(["builtin"])
  })

  it("uses a session row the caller already holds instead of reading it", async () => {
    teamState.teams = { a: team("a", "Alpha", ["m1"]), b: team("b", "Beta", ["m2"]) }
    teamState.teammates = { m1: mate("m1", "a", "Ann"), m2: mate("m2", "b", "Ben") }
    const snapshot = await snapshotRouteContext("chat-2", {
      session: { id: "chat-2", squadId: "b" } as never,
    })
    expect(snapshot.targets.map((t) => t.handle)).toEqual(["claude", "codex", "ben", "ann"])
  })
})

describe("route store readiness", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("asks for the knowledge-agents capability without waiting on it", () => {
    boot.capability.mockImplementation(() => new Promise(() => undefined))
    requestRouteStores()
    expect(boot.capability).toHaveBeenCalledWith("knowledge-agents")
  })

  it("never lets a failed boot request surface as an unhandled rejection", async () => {
    boot.capability.mockImplementation(() => Promise.reject(new Error("boot failed")))
    expect(() => requestRouteStores()).not.toThrow()
    await Promise.resolve()
  })

  it("waits for the capability, then for the Squad mirror's first hydrate", async () => {
    // The bridge only exists once the capability's initializers mounted, so
    // its hydrate is read after — never before, when it would resolve at once.
    let bootDone!: () => void
    boot.capability.mockImplementation(() => new Promise<void>((resolve) => (bootDone = resolve)))
    let hydrated!: () => void
    bridge.hydrated.mockImplementation(() => new Promise<void>((resolve) => (hydrated = resolve)))
    let settled = false
    const ready = ensureRouteStoresReady(10_000).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(bridge.hydrated).not.toHaveBeenCalled()
    bootDone()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.hydrated).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    hydrated()
    await ready
    expect(settled).toBe(true)
  })

  it("gives up after its bound instead of holding the send forever", async () => {
    jest.useFakeTimers()
    boot.capability.mockImplementation(() => new Promise(() => undefined))
    let settled = false
    const ready = ensureRouteStoresReady(1_000).then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await ready
    expect(settled).toBe(true)
  })

  it("treats a failed boot as ready-as-is rather than failing the send", async () => {
    boot.capability.mockImplementation(() => Promise.reject(new Error("boot failed")))
    await expect(ensureRouteStoresReady(10_000)).resolves.toBeUndefined()
  })

  it("reads the Squads only after the mirror hydrated", async () => {
    // A member that lands with the hydrate must be in the snapshot.
    let hydrated!: () => void
    bridge.hydrated.mockImplementation(() => new Promise<void>((resolve) => (hydrated = resolve)))
    const pending = snapshotRouteContext(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    teamState.teams = { sq1: team("sq1", "Review", ["m1"]) }
    teamState.teammates = { m1: mate("m1", "sq1", "Reviewer") }
    hydrated()
    const snapshot = await pending
    expect(snapshot.targets.map((target) => target.handle)).toContain("reviewer")
  })
})
