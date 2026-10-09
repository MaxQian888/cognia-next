import type { AgentBuilderSessionState, ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import {
  AGENT_BUILDER_SESSION_KIND,
  AgentBuilderSessionError,
  createAgentFromBuilder,
  emptyBuilderState,
  ensureSetupBuilderSession,
  isAgentBuilderSession,
  isPristineBuilderSession,
  listBuilderDrafts,
  markBuilderCreated,
  writeBuilderDraft,
  type EnsureSetupSessionDeps,
} from "./builder-session"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().sessions.clear()
  await getDb().messages.clear()
  await getDb().characters.clear()
})
afterAll(dbFixture.dispose)

function state(overrides: Partial<AgentBuilderSessionState> = {}): AgentBuilderSessionState {
  return { ...emptyBuilderState(1000), ...overrides }
}

async function putSession(id: string, overrides: Partial<ChatSession> = {}): Promise<ChatSession> {
  const row = {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    kind: AGENT_BUILDER_SESSION_KIND,
    agentBuilder: state(),
    ...overrides,
  } as ChatSession
  await getDb().sessions.put(row)
  return row
}

async function putMessage(sessionId: string, id = `${sessionId}-m1`) {
  await getDb().messages.put({ id, sessionId, role: "user", createdAt: 1 } as never)
}

describe("isAgentBuilderSession", () => {
  it("is true only for the agent-builder kind", () => {
    expect(isAgentBuilderSession({ kind: "agent-builder" })).toBe(true)
    expect(isAgentBuilderSession({ kind: undefined })).toBe(false)
    expect(isAgentBuilderSession({ kind: "chat" as never })).toBe(false)
    expect(isAgentBuilderSession(undefined)).toBe(false)
    expect(isAgentBuilderSession(null)).toBe(false)
  })
})

describe("emptyBuilderState", () => {
  it("is a revision-0 drafting state edited by the user at the given time", () => {
    expect(emptyBuilderState(42)).toEqual({
      draft: {},
      revision: 0,
      editedBy: "user",
      status: "drafting",
      updatedAt: 42,
    })
  })
})

describe("isPristineBuilderSession", () => {
  it("is true for a drafting builder with an empty draft and no messages", async () => {
    expect(await isPristineBuilderSession(await putSession("s1"))).toBe(true)
  })

  it("is false for a session of another kind", async () => {
    const session = await putSession("s1", { kind: undefined })
    expect(await isPristineBuilderSession(session)).toBe(false)
  })

  it("is false when the draft state is missing (a row synced from another device)", async () => {
    const session = await putSession("s1", { agentBuilder: undefined })
    expect(await isPristineBuilderSession(session)).toBe(false)
  })

  it("is false once created", async () => {
    const session = await putSession("s1", { agentBuilder: state({ status: "created" }) })
    expect(await isPristineBuilderSession(session)).toBe(false)
  })

  it("is false when the draft has content", async () => {
    const session = await putSession("s1", { agentBuilder: state({ draft: { name: "X" } }) })
    expect(await isPristineBuilderSession(session)).toBe(false)
  })

  it("is false when the session has messages, true again for a different session without any", async () => {
    const withMessage = await putSession("s1")
    await putMessage("s1")
    expect(await isPristineBuilderSession(withMessage)).toBe(false)
    expect(await isPristineBuilderSession(await putSession("s2"))).toBe(true)
  })
})

describe("listBuilderDrafts", () => {
  it("returns nothing when there are no builder sessions", async () => {
    await putSession("chat", { kind: undefined, agentBuilder: undefined })
    expect(await listBuilderDrafts()).toEqual([])
  })

  it("lists unfinished drafts newest-edited first", async () => {
    await putSession("old", { agentBuilder: state({ draft: { name: "Old" }, updatedAt: 10 }) })
    await putSession("new", { agentBuilder: state({ draft: { name: "New" }, updatedAt: 30 }) })
    await putSession("mid", { agentBuilder: state({ draft: { name: "Mid" }, updatedAt: 20 }) })
    expect((await listBuilderDrafts()).map((s) => s.id)).toEqual(["new", "mid", "old"])
  })

  it("includes a draft with messages but no fields, excludes pristine ones", async () => {
    await putSession("talked")
    await putMessage("talked")
    await putSession("pristine")
    expect((await listBuilderDrafts()).map((s) => s.id)).toEqual(["talked"])
  })

  it("excludes created, archived and state-less builder rows", async () => {
    await putSession("created", {
      agentBuilder: state({ draft: { name: "A" }, status: "created" }),
    })
    await putSession("archived", {
      agentBuilder: state({ draft: { name: "A" } }),
      archivedAt: 5,
    })
    await putSession("synced", { agentBuilder: undefined })
    await putSession("live", { agentBuilder: state({ draft: { name: "A" } }) })
    expect((await listBuilderDrafts()).map((s) => s.id)).toEqual(["live"])
  })

  it("treats a missing updatedAt-bearing state as oldest-sort safe", async () => {
    await putSession("a", { agentBuilder: state({ draft: { name: "A" }, updatedAt: 0 }) })
    await putSession("b", { agentBuilder: state({ draft: { name: "B" }, updatedAt: 1 }) })
    expect((await listBuilderDrafts()).map((s) => s.id)).toEqual(["b", "a"])
  })
})

describe("ensureSetupBuilderSession", () => {
  function makeDeps(): EnsureSetupSessionDeps & { startSession: jest.Mock } {
    let n = 0
    const startSession = jest.fn(async (input: { title: string }) => {
      n += 1
      return putSession(`new-${n}`, {
        title: input.title,
        kind: AGENT_BUILDER_SESSION_KIND,
        agentBuilder: undefined,
        visibility: "standard",
      } as Partial<ChatSession>)
    })
    return { startSession, now: () => 777 }
  }

  it("creates an embedded, pristine builder session through the single new-chat path", async () => {
    const deps = makeDeps()
    const session = await ensureSetupBuilderSession("Build with AI", deps)
    expect(deps.startSession).toHaveBeenCalledWith({
      title: "Build with AI",
      kind: "agent-builder",
      activate: false,
      rememberChoice: false,
    })
    expect(session.agentBuilder).toEqual(emptyBuilderState(777))
    expect(session).toMatchObject({ visibility: "embedded", titleAuto: false })

    const stored = await getDb().sessions.get(session.id)
    expect(stored).toMatchObject({
      visibility: "embedded",
      titleAuto: false,
      agentBuilder: emptyBuilderState(777),
    })
  })

  it("reuses an existing pristine session instead of minting another", async () => {
    await putSession("used", { agentBuilder: state({ draft: { name: "Has content" } }) })
    await putSession("free")
    const deps = makeDeps()
    const session = await ensureSetupBuilderSession("t", deps)
    expect(session.id).toBe("free")
    expect(deps.startSession).not.toHaveBeenCalled()
  })

  it("does not reuse a session that has a message, and creates a new one", async () => {
    await putSession("talked")
    await putMessage("talked")
    const deps = makeDeps()
    const session = await ensureSetupBuilderSession("t", deps)
    expect(session.id).toBe("new-1")
    expect(deps.startSession).toHaveBeenCalledTimes(1)
  })

  it("shares one in-flight call between concurrent callers", async () => {
    const deps = makeDeps()
    const first = ensureSetupBuilderSession("t", deps)
    const second = ensureSetupBuilderSession("t", deps)
    expect(second).toBe(first)
    const [a, b] = await Promise.all([first, second])
    expect(a.id).toBe(b.id)
    expect(deps.startSession).toHaveBeenCalledTimes(1)
    expect(await getDb().sessions.where("kind").equals("agent-builder").count()).toBe(1)
  })

  it("releases the in-flight slot once settled so a later call finds the pristine session", async () => {
    const deps = makeDeps()
    const first = await ensureSetupBuilderSession("t", deps)
    const second = await ensureSetupBuilderSession("t", deps)
    expect(second.id).toBe(first.id)
    expect(deps.startSession).toHaveBeenCalledTimes(1)
  })

  it("releases the in-flight slot after a failure so the next call can retry", async () => {
    const failing: EnsureSetupSessionDeps = {
      startSession: jest.fn(async () => {
        throw new Error("no workspace")
      }),
      now: () => 1,
    }
    await expect(ensureSetupBuilderSession("t", failing)).rejects.toThrow("no workspace")
    const deps = makeDeps()
    const session = await ensureSetupBuilderSession("t", deps)
    expect(session.id).toBe("new-1")
  })
})

describe("AgentBuilderSessionError", () => {
  it("carries a code, message and name", () => {
    const error = new AgentBuilderSessionError("invalid-draft", "nope")
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("invalid-draft")
    expect(error.message).toBe("nope")
    expect(error.name).toBe("AgentBuilderSessionError")
  })
})

describe("writeBuilderDraft", () => {
  it("applies the update, bumps the revision, tags the writer and persists", async () => {
    await putSession("s1", { agentBuilder: state({ draft: { name: "A" }, revision: 3 }) })
    const update = jest.fn((draft) => ({ ...draft, description: "d" }))
    const before = Date.now()
    const next = await writeBuilderDraft("s1", update, "agent")
    expect(update).toHaveBeenCalledWith({ name: "A" })
    expect(next).toMatchObject({
      draft: { name: "A", description: "d" },
      revision: 4,
      editedBy: "agent",
      status: "drafting",
    })
    expect(next.updatedAt).toBeGreaterThanOrEqual(before)

    const stored = await getDb().sessions.get("s1")
    expect(stored?.agentBuilder).toEqual(next)
    expect(stored?.updatedAt).toBe(next.updatedAt)
  })

  it("records the user as editor when the panel writes", async () => {
    await putSession("s1", { agentBuilder: state({ editedBy: "agent" }) })
    const next = await writeBuilderDraft("s1", (d) => ({ ...d, name: "U" }), "user")
    expect(next.editedBy).toBe("user")
    expect(next.revision).toBe(1)
  })

  it("drops a person's edit made before a builder write that has landed since", async () => {
    await putSession("s1", {
      agentBuilder: state({ draft: { name: "Builder" }, revision: 5, editedBy: "agent" }),
    })
    const next = await writeBuilderDraft("s1", (d) => ({ ...d, name: "Stale" }), "user", {
      baseRevision: 4,
    })
    expect(next).toMatchObject({ draft: { name: "Builder" }, revision: 5, editedBy: "agent" })
    expect((await getDb().sessions.get("s1"))?.agentBuilder?.draft.name).toBe("Builder")
  })

  it("writes a person's edit made on the latest revision, or after only their own writes", async () => {
    await putSession("s1", { agentBuilder: state({ revision: 5, editedBy: "agent" }) })
    const onLatest = await writeBuilderDraft("s1", (d) => ({ ...d, name: "A" }), "user", {
      baseRevision: 5,
    })
    expect(onLatest).toMatchObject({ draft: { name: "A" }, revision: 6, editedBy: "user" })
    // Revision 6 is the person's own echo, so an edit still based on 5 is not stale.
    const afterOwnEcho = await writeBuilderDraft("s1", (d) => ({ ...d, name: "AB" }), "user", {
      baseRevision: 5,
    })
    expect(afterOwnEcho).toMatchObject({ draft: { name: "AB" }, revision: 7 })
  })

  it("serialises overlapping writes so no revision or field is lost", async () => {
    await putSession("s1")
    await Promise.all([
      writeBuilderDraft("s1", (d) => ({ ...d, name: "N" }), "agent"),
      writeBuilderDraft("s1", (d) => ({ ...d, description: "D" }), "user"),
    ])
    const stored = await getDb().sessions.get("s1")
    expect(stored?.agentBuilder?.revision).toBe(2)
    expect(stored?.agentBuilder?.draft).toEqual({ name: "N", description: "D" })
  })

  it("refuses a missing session with not-a-builder", async () => {
    await expect(writeBuilderDraft("ghost", (d) => d, "agent")).rejects.toMatchObject({
      name: "AgentBuilderSessionError",
      code: "not-a-builder",
    })
  })

  it("refuses a session of another kind and one without draft state", async () => {
    await putSession("chat", { kind: undefined })
    await putSession("bare", { agentBuilder: undefined })
    await expect(writeBuilderDraft("chat", (d) => d, "agent")).rejects.toMatchObject({
      code: "not-a-builder",
    })
    await expect(writeBuilderDraft("bare", (d) => d, "agent")).rejects.toMatchObject({
      code: "not-a-builder",
    })
  })

  it("refuses a draft that was already created and leaves it untouched", async () => {
    const created = state({ status: "created", createdCharacterId: "c1", draft: { name: "A" } })
    await putSession("s1", { agentBuilder: created })
    const update = jest.fn((d) => d)
    await expect(writeBuilderDraft("s1", update, "agent")).rejects.toMatchObject({
      code: "already-created",
    })
    expect(update).not.toHaveBeenCalled()
    expect((await getDb().sessions.get("s1"))?.agentBuilder).toEqual(created)
  })

  it("refuses a session frozen by a handoff before consulting the draft", async () => {
    await putSession("s1", {
      handoffLock: { ticketId: "t1", state: "frozen", at: 1 },
    })
    const update = jest.fn((d) => d)
    await expect(writeBuilderDraft("s1", update, "agent")).rejects.toBeInstanceOf(
      SessionHandoffLockedError
    )
    expect(update).not.toHaveBeenCalled()
    expect((await getDb().sessions.get("s1"))?.agentBuilder?.revision).toBe(0)
  })

  it("rolls back when the update callback throws", async () => {
    await putSession("s1", { agentBuilder: state({ draft: { name: "A" } }) })
    await expect(
      writeBuilderDraft(
        "s1",
        () => {
          throw new Error("bad patch")
        },
        "agent"
      )
    ).rejects.toThrow("bad patch")
    const stored = await getDb().sessions.get("s1")
    expect(stored?.agentBuilder).toMatchObject({ revision: 0, draft: { name: "A" } })
  })
})

describe("createAgentFromBuilder", () => {
  it("rejects a missing, non-builder or state-less session with not-a-builder", async () => {
    await putSession("chat", { kind: undefined })
    await putSession("bare", { agentBuilder: undefined })
    for (const id of ["ghost", "chat", "bare"]) {
      await expect(createAgentFromBuilder(id)).rejects.toMatchObject({ code: "not-a-builder" })
    }
  })

  it("rejects an already-created draft without creating a second agent", async () => {
    await putSession("s1", {
      agentBuilder: state({
        status: "created",
        createdCharacterId: "c1",
        draft: { name: "A", systemPrompt: "x" },
      }),
    })
    await expect(createAgentFromBuilder("s1")).rejects.toMatchObject({ code: "already-created" })
    expect(await getDb().characters.count()).toBe(0)
  })

  it.each([
    ["no name", {}, "nameRequired"],
    ["no instructions", { name: "A" }, "systemPromptRequired"],
    [
      "bad max turns",
      { name: "A", systemPrompt: "x", executionPolicy: { maxTurns: 500 } },
      "maxTurnsInvalid",
    ],
  ])("rejects an invalid draft (%s) naming the issue code", async (_label, draft, code) => {
    await putSession("s1", { agentBuilder: state({ draft }) })
    const error = await createAgentFromBuilder("s1").catch((e) => e)
    expect(error).toBeInstanceOf(AgentBuilderSessionError)
    expect(error.code).toBe("invalid-draft")
    expect(error.message).toBe(`The draft is not ready: ${code}.`)
    expect(await getDb().characters.count()).toBe(0)
    expect((await getDb().sessions.get("s1"))?.agentBuilder?.status).toBe("drafting")
  })

  it("creates the character from the draft and marks the session created", async () => {
    await putSession("s1", {
      agentBuilder: state({
        draft: {
          name: "  Reviewer  ",
          description: "Reviews PRs",
          avatarEmoji: "🔍",
          systemPrompt: "You review code.",
          skillIds: ["sk1"],
          runtime: { kind: "external", agentId: "codex" } as never,
        },
      }),
    })
    const character = await createAgentFromBuilder("s1")
    expect(character).toMatchObject({
      name: "Reviewer",
      description: "Reviews PRs",
      avatarEmoji: "🔍",
      systemPrompt: "You review code.",
      skillIds: ["sk1"],
      runtime: { kind: "external", agentId: "codex" },
    })
    expect(await getDb().characters.get(character.id)).toMatchObject({ name: "Reviewer" })

    const state1 = (await getDb().sessions.get("s1"))?.agentBuilder
    expect(state1).toMatchObject({ status: "created", createdCharacterId: character.id })
    expect(state1?.draft.name).toBe("  Reviewer  ")
  })

  it("cannot be run twice for the same session", async () => {
    await putSession("s1", { agentBuilder: state({ draft: { name: "A", systemPrompt: "x" } }) })
    await createAgentFromBuilder("s1")
    await expect(createAgentFromBuilder("s1")).rejects.toMatchObject({ code: "already-created" })
    expect(await getDb().characters.count()).toBe(1)
  })
})

describe("markBuilderCreated", () => {
  it("flips the status, records the character and keeps the rest of the state", async () => {
    await putSession("s1", {
      agentBuilder: state({ draft: { name: "A" }, revision: 5, editedBy: "agent" }),
    })
    await markBuilderCreated("s1", "char-9")
    const stored = (await getDb().sessions.get("s1"))?.agentBuilder
    expect(stored).toMatchObject({
      status: "created",
      createdCharacterId: "char-9",
      draft: { name: "A" },
      revision: 5,
      editedBy: "agent",
    })
    expect(stored?.updatedAt).toBeGreaterThan(1000)
  })

  it("does nothing for a missing session or one without draft state", async () => {
    await putSession("bare", { agentBuilder: undefined })
    await expect(markBuilderCreated("ghost", "c")).resolves.toBeUndefined()
    await expect(markBuilderCreated("bare", "c")).resolves.toBeUndefined()
    expect((await getDb().sessions.get("bare"))?.agentBuilder).toBeUndefined()
    expect(await getDb().sessions.get("ghost")).toBeUndefined()
  })
})
