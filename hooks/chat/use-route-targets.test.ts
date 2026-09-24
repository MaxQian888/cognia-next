/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import type { AgentRuntimeDescriptor, AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { useRouteTargets } from "./use-route-targets"

const teamState = {
  teams: {} as Record<string, unknown>,
  teammates: {} as Record<string, unknown>,
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: typeof teamState) => unknown) => selector(teamState),
}))
const projectState = { activeProjectId: null as string | null }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: typeof projectState) => unknown) => selector(projectState),
}))
const externalState = { enabled: true, agents: {} as Record<string, unknown> }
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: typeof externalState) => unknown) =>
    selector(externalState),
}))
const refs: Record<string, AgentRuntimeRef> = {}
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: (id?: string) => (id && refs[id]) || { kind: "builtin" },
}))
let runtimes: AgentRuntimeDescriptor[] = []
const catalogCalls: Array<[string | undefined, string | undefined]> = []
jest.mock("@/hooks/agent/use-agent-runtime-catalog", () => ({
  useAgentRuntimeCatalog: (providerId?: string, sessionId?: string) => {
    catalogCalls.push([providerId, sessionId])
    // A fresh array per render, exactly like the real (unmemoised) catalog.
    return { runtimes: runtimes.map((row) => ({ ...row })) }
  },
}))

const BUILTIN: AgentRuntimeDescriptor = {
  ref: { kind: "builtin" },
  key: "builtin",
  group: "builtin",
  nameKey: "cogniaAgent",
  descriptionKey: "engineClaudeAgentSdk",
}
const CODEX: AgentRuntimeDescriptor = {
  ref: { kind: "external", agentId: "cx" },
  key: "external:cx",
  group: "external",
  name: "Codex",
  presetId: "codex-app-server",
}

function squad(id: string, name: string, members: Array<{ id: string; name: string }>) {
  teamState.teams[id] = {
    id,
    name,
    status: "idle",
    config: {},
    teammateIds: members.map((m) => m.id),
  }
  for (const member of members) {
    teamState.teammates[member.id] = {
      id: member.id,
      teamId: id,
      name: member.name,
      description: "",
      config: {},
    }
  }
}

beforeEach(() => {
  teamState.teams = {}
  teamState.teammates = {}
  projectState.activeProjectId = null
  externalState.enabled = true
  externalState.agents = {}
  for (const key of Object.keys(refs)) delete refs[key]
  runtimes = [BUILTIN]
  catalogCalls.length = 0
})

const base = { enabled: true, session: { id: "chat-1" }, reservedHandles: [] as string[] }

describe("useRouteTargets", () => {
  it("offers the two runtimes with their live lanes", () => {
    runtimes = [BUILTIN, CODEX]
    const { result } = renderHook(() => useRouteTargets(base))
    expect(result.current.targets.map((t) => t.handle)).toEqual(["claude", "codex"])
    expect(result.current.options[0]).toMatchObject({
      lane: { ok: true, runtimeRef: { kind: "builtin" } },
      descriptor: { key: "builtin" },
    })
    expect(result.current.options[1]).toMatchObject({
      lane: { ok: true, runtimeRef: { kind: "external", agentId: "cx" } },
      descriptor: { name: "Codex" },
    })
  })

  it("reads the catalog for the pane's own session and provider", () => {
    renderHook(() => useRouteTargets({ ...base, providerId: "deepseek" }))
    expect(catalogCalls.at(-1)).toEqual(["deepseek", "chat-1"])
  })

  it("marks an unconfigured Codex, and a configured-but-hidden one, as unavailable", () => {
    const { result, rerender } = renderHook(() => useRouteTargets(base))
    expect(result.current.options[1].lane).toEqual({
      ok: false,
      reason: "not-configured",
      runtime: "codex",
    })
    expect(result.current.options[1].descriptor).toBeUndefined()

    externalState.enabled = false
    externalState.agents = { cx: { id: "cx", metadata: { preset: "codex" } } }
    rerender()
    expect(result.current.options[1].lane).toMatchObject({ ok: false, reason: "disabled" })
  })

  it("lists the bound Squad's members first and reserves the subagent handles", () => {
    squad("s1", "Alpha", [{ id: "m1", name: "Ann" }])
    squad("s2", "Beta", [{ id: "m2", name: "Reviewer" }])
    const { result } = renderHook(() =>
      useRouteTargets({
        ...base,
        session: { id: "chat-1", squadId: "s2" },
        reservedHandles: ["reviewer"],
      })
    )
    expect(result.current.targets.map((t) => t.handle)).toEqual([
      "claude",
      "codex",
      "beta-reviewer",
      "ann",
    ])
    expect(result.current.options[2].lane).toMatchObject({
      ok: true,
      member: { team: { id: "s2" } },
    })
  })

  it("keeps the option list stable across renders when nothing it reads changed", () => {
    runtimes = [BUILTIN, CODEX]
    const { result, rerender } = renderHook(() => useRouteTargets(base))
    const first = result.current.options
    rerender()
    expect(result.current.options).toBe(first)

    runtimes = [BUILTIN, { ...CODEX, blockedReason: "codex: not found" }]
    rerender()
    expect(result.current.options).not.toBe(first)
    expect(result.current.options[1].lane).toMatchObject({ ok: false, reason: "blocked" })
  })

  it("routes by the session's own lane", () => {
    runtimes = [
      BUILTIN,
      CODEX,
      { ...CODEX, ref: { kind: "external", agentId: "cx2" }, key: "external:cx2", name: "Codex 2" },
    ]
    refs["chat-1"] = { kind: "external", agentId: "cx2" }
    const { result } = renderHook(() => useRouteTargets(base))
    expect(result.current.options[1].lane).toMatchObject({ runtimeRef: { agentId: "cx2" } })
  })

  it("offers nothing where routing is off", () => {
    squad("s1", "Alpha", [{ id: "m1", name: "Ann" }])
    const { result } = renderHook(() => useRouteTargets({ ...base, enabled: false }))
    expect(result.current).toEqual({ targets: [], options: [] })
  })
})
