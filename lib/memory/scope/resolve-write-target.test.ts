const mockAudit = jest.fn()
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...args: unknown[]) => mockAudit(...args),
}))
jest.mock("@/lib/db/project-scope", () => ({
  resolveSessionProjectId: jest.fn(async () => "proj-from-session"),
  resolveScopeProjectId: jest.fn(async () => "proj-active"),
}))

import type { ResolvedAgentMemoryPolicy } from "@/lib/memory/agent-policy"
import type { MemoryScope } from "@/types/memory/memory"
import { auditMemoryScopeRefusal, resolveMemoryWriteTarget } from "./resolve-write-target"

function policy(writableScopes: MemoryScope[]): ResolvedAgentMemoryPolicy {
  return {
    canRecall: true,
    canCreate: writableScopes.length > 0,
    canUpdate: writableScopes.length > 0,
    canForget: writableScopes.length > 0,
    canAutoLearn: true,
    readableScopes: ["global", "workspace", "character", "agent"],
    writableScopes,
    recallReason: "allowed",
    learnReason: "allowed",
  }
}

const ALL: MemoryScope[] = ["global", "workspace", "character", "agent"]

beforeEach(() => {
  jest.clearAllMocks()
  mockAudit.mockResolvedValue(undefined)
})

describe("resolveMemoryWriteTarget", () => {
  it("always carries a non-empty projectId for a workspace target", async () => {
    // The bug this module exists for: a workspace row with no projectId is
    // invisible to every reader, forever.
    const target = await resolveMemoryWriteTarget({
      requested: "workspace",
      policy: policy(ALL),
      session: null,
    })
    expect(target).toEqual({
      ok: true,
      scope: "workspace",
      projectId: "proj-active",
      scopeRationale: "caller_explicit",
    })
  })

  it("prefers the session's own project over the active one", async () => {
    const target = await resolveMemoryWriteTarget({
      requested: "workspace",
      policy: policy(ALL),
      session: { id: "s1", projectId: "proj-session" },
    })
    expect(target).toMatchObject({ ok: true, projectId: "proj-from-session" })
  })

  it("uses a satisfiable configured default and records that the setting chose it", async () => {
    const target = await resolveMemoryWriteTarget({
      configured: "character",
      policy: policy(ALL),
      session: { id: "s1", characterId: "c1" },
    })
    expect(target).toEqual({
      ok: true,
      scope: "character",
      characterId: "c1",
      scopeRationale: "user_configured_default",
    })
  })

  it("falls to the session workspace when the configured scope lacks its id", async () => {
    const target = await resolveMemoryWriteTarget({
      configured: "character",
      policy: policy(ALL),
      session: { id: "s1" },
    })
    expect(target).toEqual({
      ok: true,
      scope: "workspace",
      projectId: "proj-from-session",
      scopeRationale: "session_workspace",
    })
  })

  it("does not claim the setting mattered when it agrees with the fallback", async () => {
    const target = await resolveMemoryWriteTarget({
      configured: "workspace",
      policy: policy(ALL),
      session: { id: "s1" },
    })
    expect(target).toMatchObject({ scope: "workspace", scopeRationale: "session_workspace" })
  })

  it("falls all the way to global when workspace is not writable", async () => {
    const target = await resolveMemoryWriteTarget({
      configured: "agent",
      policy: policy(["global"]),
      session: { id: "s1" },
    })
    expect(target).toEqual({ ok: true, scope: "global", scopeRationale: "global_fallback" })
  })

  it("refuses an explicit pick outside the policy instead of widening it", async () => {
    // Widening here would silently relocate a fact the user deliberately filed.
    const target = await resolveMemoryWriteTarget({
      requested: "workspace",
      configured: "global",
      policy: policy(["global"]),
      session: { id: "s1" },
    })
    expect(target).toEqual({ ok: false, reason: "scope_denied", attempted: ["workspace"] })
  })

  it("pins a project claim to workspace and ignores the configured default", async () => {
    const target = await resolveMemoryWriteTarget({
      pin: "workspace",
      configured: "global",
      policy: policy(ALL),
      session: { id: "s1" },
    })
    expect(target).toMatchObject({
      ok: true,
      scope: "workspace",
      scopeRationale: "caller_explicit",
    })
  })

  it("refuses with the whole attempted ladder when nothing is writable", async () => {
    const target = await resolveMemoryWriteTarget({
      configured: "agent",
      policy: policy([]),
      agentId: "a1",
      session: { id: "s1" },
    })
    expect(target).toEqual({
      ok: false,
      reason: "scope_denied",
      attempted: ["agent", "workspace", "global"],
    })
  })

  it("honours the update operation when resolving policy", async () => {
    const readOnly = { ...policy(ALL), canUpdate: false }
    await expect(
      resolveMemoryWriteTarget({ policy: readOnly, operation: "update", session: { id: "s1" } })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      resolveMemoryWriteTarget({ policy: readOnly, operation: "create", session: { id: "s1" } })
    ).resolves.toMatchObject({ ok: true })
  })

  it("resolves the project id at most once across both ladder passes", async () => {
    const resolveProjectId = jest.fn(async () => "proj-x")
    await resolveMemoryWriteTarget({
      configured: "workspace",
      policy: policy(ALL),
      session: { id: "s1" },
      resolveProjectId,
    })
    expect(resolveProjectId).toHaveBeenCalledTimes(1)
  })

  it("requires an agentId before it will pick the agent scope", async () => {
    await expect(
      resolveMemoryWriteTarget({ configured: "agent", policy: policy(ALL), session: { id: "s1" } })
    ).resolves.toMatchObject({ scope: "workspace" })
    await expect(
      resolveMemoryWriteTarget({
        configured: "agent",
        policy: policy(ALL),
        agentId: "twin:a1",
        session: { id: "s1" },
      })
    ).resolves.toMatchObject({ scope: "agent", agentId: "twin:a1" })
  })
})

describe("auditMemoryScopeRefusal", () => {
  it("writes one content-free ledger row naming the surface and the ladder", async () => {
    await auditMemoryScopeRefusal({
      sessionId: "s1",
      attempted: ["workspace", "global"],
      surface: "remember",
    })
    expect(mockAudit).toHaveBeenCalledWith({
      action: "learn-denied",
      sessionId: "s1",
      reason: "agent_scope_policy",
      metadata: { attempted: "workspace,global", surface: "remember" },
    })
  })

  it("never rejects when the ledger write fails", async () => {
    mockAudit.mockRejectedValueOnce(new Error("db down"))
    await expect(
      auditMemoryScopeRefusal({ attempted: ["global"], surface: "cli" })
    ).resolves.toBeUndefined()
  })
})
