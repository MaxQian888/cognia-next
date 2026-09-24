import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import {
  buildRouteStamp,
  CODEX_PRESET_FAMILY,
  descriptorForRef,
  memberPresetId,
  presetFamilyOf,
  resolveRouteLane,
  routeCharacter,
  type RouteResolutionContext,
} from "./resolve"
import type { TurnRoute } from "./types"

const BUILTIN: AgentRuntimeDescriptor = {
  ref: { kind: "builtin" },
  key: "builtin",
  group: "builtin",
}

function external(
  agentId: string,
  presetId: string | undefined,
  extra: Partial<AgentRuntimeDescriptor> = {}
): AgentRuntimeDescriptor {
  return {
    ref: { kind: "external", agentId },
    key: `external:${agentId}`,
    group: "external",
    name: agentId,
    ...(presetId ? { presetId, brandId: presetId } : {}),
    ...extra,
  }
}

function host(configId: string, presetId: string): AgentRuntimeDescriptor {
  return {
    ref: { kind: "host", configId, revision: "r1", lifecycleGeneration: 1, name: configId },
    key: `host:${configId}`,
    group: "host",
    placement: "host",
    name: configId,
    presetId,
  }
}

function team(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "s1",
    name: "Platform",
    config: {},
    teammateIds: ["tm-1"],
    ...overrides,
  } as AgentTeam
}

function teammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm-1",
    teamId: "s1",
    name: "Critic",
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

function ctx(overrides: Partial<RouteResolutionContext> = {}): RouteResolutionContext {
  return {
    runtimes: [BUILTIN],
    currentRef: { kind: "builtin" },
    teams: {},
    teammates: {},
    externalEnabled: true,
    configuredPresetIds: [],
    ...overrides,
  }
}

const CODEX = { kind: "runtime", runtime: "codex" } as const
const CLAUDE = { kind: "runtime", runtime: "claude" } as const

describe("presetFamilyOf", () => {
  it("groups the three Codex surfaces and leaves everything else alone", () => {
    expect(presetFamilyOf("codex-acp")).toBe(CODEX_PRESET_FAMILY)
    expect(presetFamilyOf("codex")).toEqual(["codex-app-server", "codex", "codex-acp"])
    expect(presetFamilyOf("claude-code")).toEqual(["claude-code"])
  })
})

describe("resolveRouteLane — @claude", () => {
  it("always answers on the builtin lane, even from an external session", () => {
    const lane = resolveRouteLane(
      CLAUDE,
      ctx({ currentRef: { kind: "external", agentId: "cx" }, runtimes: [BUILTIN] })
    )
    expect(lane).toEqual({ ok: true, runtimeRef: { kind: "builtin" } })
  })
})

describe("resolveRouteLane — @codex", () => {
  it("picks the first runnable Codex in catalog order", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({
        runtimes: [
          BUILTIN,
          external("gemini", "gemini-cli"),
          external("a-codex", "codex-acp"),
          external("b-codex", "codex-app-server"),
        ],
      })
    )
    expect(lane).toEqual({ ok: true, runtimeRef: { kind: "external", agentId: "a-codex" } })
  })

  it("prefers the session's own lane when it is already a Codex", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({
        runtimes: [BUILTIN, external("a-codex", "codex"), external("b-codex", "codex-app-server")],
        currentRef: { kind: "external", agentId: "b-codex" },
      })
    )
    expect(lane).toEqual({ ok: true, runtimeRef: { kind: "external", agentId: "b-codex" } })
  })

  it("does not keep a blocked current lane over a runnable one", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({
        runtimes: [
          BUILTIN,
          external("a-codex", "codex", { blockedReason: "codex: not found" }),
          external("b-codex", "codex-acp"),
        ],
        currentRef: { kind: "external", agentId: "a-codex" },
      })
    )
    expect(lane).toMatchObject({ ok: true, runtimeRef: { agentId: "b-codex" } })
  })

  it("reaches a paired host's lane, as the catalog lists it", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({ runtimes: [BUILTIN, host("eac_codex", "codex-app-server")] })
    )
    expect(lane).toMatchObject({ ok: true, runtimeRef: { kind: "host", configId: "eac_codex" } })
  })

  it("matches the session's lane through a merged row's alternate ref", () => {
    const merged: AgentRuntimeDescriptor = {
      ...host("eac_codex", "codex"),
      placement: "both",
      alternateRef: { kind: "external", agentId: "local_codex" },
    }
    const lane = resolveRouteLane(
      CODEX,
      ctx({
        runtimes: [BUILTIN, external("a-other", "codex-acp"), merged],
        currentRef: { kind: "external", agentId: "local_codex" },
      })
    )
    expect(lane).toMatchObject({ ok: true, runtimeRef: { kind: "host", configId: "eac_codex" } })
  })

  it("reports a permanent block with the runtime's own wording", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({ runtimes: [BUILTIN, external("cx", "codex", { blockedReason: "Agent is disabled." })] })
    )
    expect(lane).toEqual({
      ok: false,
      reason: "blocked",
      detail: "Agent is disabled.",
      runtime: "codex",
    })
  })

  it("reports a block that may clear itself as transient", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({
        runtimes: [
          BUILTIN,
          external("a", "codex", { blockedReason: "missing binary" }),
          external("b", "codex-acp", { blockedReason: "host starting", blockTransient: true }),
        ],
      })
    )
    expect(lane).toEqual({
      ok: false,
      reason: "transient",
      detail: "host starting",
      runtime: "codex",
    })
  })

  it("says the switch is off when a Codex is configured but hidden", () => {
    const lane = resolveRouteLane(
      CODEX,
      ctx({ externalEnabled: false, configuredPresetIds: ["codex-app-server"] })
    )
    expect(lane).toEqual({ ok: false, reason: "disabled", runtime: "codex" })
  })

  it("says nothing is configured when no Codex exists anywhere", () => {
    expect(
      resolveRouteLane(CODEX, ctx({ runtimes: [BUILTIN, external("g", "gemini-cli")] }))
    ).toEqual({ ok: false, reason: "not-configured", runtime: "codex" })
    // An agent configured by hand, with no preset, is not guessed at.
    expect(resolveRouteLane(CODEX, ctx({ runtimes: [BUILTIN, external("x", undefined)] }))).toEqual(
      { ok: false, reason: "not-configured", runtime: "codex" }
    )
  })
})

describe("resolveRouteLane — Squad member", () => {
  const target = { kind: "squadMember", squadId: "s1", teammateId: "tm-1" } as const

  it("runs a claude member on the builtin lane, as that member", () => {
    const t = team()
    const m = teammate()
    const lane = resolveRouteLane(target, ctx({ teams: { s1: t }, teammates: { "tm-1": m } }))
    expect(lane).toEqual({
      ok: true,
      runtimeRef: { kind: "builtin" },
      member: { team: t, teammate: m },
    })
  })

  it("runs an external member on its preset family", () => {
    const m = teammate({ config: { runtime: "codex" } })
    const lane = resolveRouteLane(
      target,
      ctx({
        teams: { s1: team() },
        teammates: { "tm-1": m },
        runtimes: [BUILTIN, external("cx", "codex-app-server")],
      })
    )
    expect(lane).toMatchObject({
      ok: true,
      runtimeRef: { kind: "external", agentId: "cx" },
      member: { teammate: m },
    })
  })

  it("honours a capability-bundle preset on a claude member, like a Squad dispatch", () => {
    const t = team({
      config: { capabilities: { externalAgentPresetIds: ["claude-code"] } },
    } as never)
    const lane = resolveRouteLane(
      target,
      ctx({ teams: { s1: t }, teammates: { "tm-1": teammate() }, runtimes: [BUILTIN] })
    )
    expect(lane).toEqual({ ok: false, reason: "member-runtime", runtime: "claude-code" })
  })

  it("names the member's runtime and the block when it cannot run", () => {
    const lane = resolveRouteLane(
      target,
      ctx({
        teams: { s1: team() },
        teammates: { "tm-1": teammate({ config: { runtime: "gemini-cli" } }) },
        runtimes: [BUILTIN, external("g", "gemini-cli", { blockedReason: "no binary" })],
      })
    )
    expect(lane).toEqual({
      ok: false,
      reason: "member-runtime",
      runtime: "gemini-cli",
      detail: "no binary",
    })
  })

  it("reports a missing Squad, a missing member, or a member that moved", () => {
    expect(resolveRouteLane(target, ctx({ teammates: { "tm-1": teammate() } }))).toEqual({
      ok: false,
      reason: "member-missing",
    })
    expect(resolveRouteLane(target, ctx({ teams: { s1: team() } }))).toEqual({
      ok: false,
      reason: "member-missing",
    })
    expect(
      resolveRouteLane(
        target,
        ctx({ teams: { s1: team() }, teammates: { "tm-1": teammate({ teamId: "s2" }) } })
      )
    ).toEqual({ ok: false, reason: "member-missing" })
  })
})

describe("memberPresetId", () => {
  it("is null for a plain claude member", () => {
    expect(memberPresetId(team(), teammate())).toBeNull()
  })
})

describe("descriptorForRef", () => {
  it("finds a row by its ref or its alternate", () => {
    const merged: AgentRuntimeDescriptor = {
      ...host("eac", "codex"),
      alternateRef: { kind: "external", agentId: "local" },
    }
    expect(descriptorForRef([BUILTIN, merged], { kind: "external", agentId: "local" })).toBe(merged)
    expect(descriptorForRef([BUILTIN], { kind: "external", agentId: "gone" })).toBeUndefined()
  })
})

describe("buildRouteStamp", () => {
  const codexRoute: TurnRoute = {
    target: { kind: "runtime", runtime: "codex" },
    handle: "codex",
    label: "codex",
  }

  it("names the configured agent and its brand for an external answer", () => {
    const runtimes = [BUILTIN, external("My Codex", "codex-app-server")]
    expect(
      buildRouteStamp(
        codexRoute,
        { ok: true, runtimeRef: { kind: "external", agentId: "My Codex" } },
        { runtimes }
      )
    ).toEqual({
      handle: "codex",
      label: "My Codex",
      runtimeKind: "external",
      brandId: "codex-app-server",
    })
  })

  it("shows the provider that ran for an @claude answer", () => {
    const claude: TurnRoute = { ...codexRoute, target: CLAUDE, handle: "claude", label: "claude" }
    expect(
      buildRouteStamp(
        claude,
        { ok: true, runtimeRef: { kind: "builtin" } },
        {
          runtimes: [BUILTIN],
          providerId: "deepseek",
        }
      )
    ).toEqual({ handle: "claude", label: "Claude", runtimeKind: "builtin", brandId: "deepseek" })
    expect(
      buildRouteStamp(
        claude,
        { ok: true, runtimeRef: { kind: "builtin" } },
        { runtimes: [BUILTIN] }
      ).brandId
    ).toBe("anthropic")
  })

  it("names the member and carries its identity", () => {
    const t = team()
    const m = teammate()
    const route: TurnRoute = {
      target: { kind: "squadMember", squadId: "s1", teammateId: "tm-1" },
      handle: "critic",
      label: "Critic",
    }
    expect(
      buildRouteStamp(
        route,
        { ok: true, runtimeRef: { kind: "builtin" }, member: { team: t, teammate: m } },
        { runtimes: [BUILTIN], providerId: "anthropic" }
      )
    ).toEqual({
      handle: "critic",
      label: "Critic",
      runtimeKind: "builtin",
      brandId: "anthropic",
      teammateId: "tm-1",
      squadId: "s1",
    })
  })

  it("falls back to the typed label when the lane is no longer listed", () => {
    expect(
      buildRouteStamp(
        codexRoute,
        { ok: true, runtimeRef: { kind: "external", agentId: "gone" } },
        { runtimes: [BUILTIN] }
      )
    ).toEqual({ handle: "codex", label: "codex", runtimeKind: "external" })
  })
})

describe("routeCharacter", () => {
  it("answers as the member the Squad would dispatch, in no fixed directory", () => {
    const t = team({ config: { defaultModel: "team-model" } } as never)
    const m = teammate({ config: { systemPrompt: "You are the critic.", model: "critic-model" } })
    const character = routeCharacter({ team: t, teammate: m })
    expect(character).toMatchObject({
      id: "__teammate__:tm-1",
      name: "Critic",
      systemPrompt: "You are the critic.",
      model: "critic-model",
    })
    expect(character.workingDir).toBeUndefined()
  })

  it("falls back to the Squad's default model", () => {
    const t = team({ config: { defaultModel: "team-model" } } as never)
    expect(routeCharacter({ team: t, teammate: teammate() }).model).toBe("team-model")
  })
})
