/** @jest-environment jsdom */
import { importHandoffSession, canonicalTurnToHandoffMessage } from "./import-handoff-session"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import type { ChatSession } from "@cognia/agent-config-types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

afterAll(dbFixture.dispose)

describe("importHandoffSession", () => {
  it("persists historical goals in the seed without restoring historical permissions", async () => {
    const state = {
      goals: [{ goalId: "g", description: "Do not deploy", status: "active" }],
      permissions: [{ requestId: "p", toolName: "shell", decision: "allow" }],
    }
    const session = await importHandoffSession({
      sessionId: "state",
      messages: [{ role: "user", content: "Continue" }],
      historicalState: state as never,
    })
    expect(session.importCanonicalState?.goals).toEqual(state.goals)
    expect(session.importCanonicalState?.permissions).toBeUndefined()
    expect(session.branchSeed?.content).toContain("Do not deploy")
    expect(session.branchSeed?.content).not.toContain('"decision":"allow"')
  })

  it("keeps a completed tool error as failed historical evidence", () => {
    const message = canonicalTurnToHandoffMessage({
      turnId: "failed",
      role: "assistant",
      text: "",
      toolCalls: [
        {
          callId: "call",
          toolName: "test",
          status: "completed",
          isError: true,
          resultText: "Tests failed",
        },
      ],
    })
    expect(message.parts).toContainEqual(
      expect.objectContaining({
        toolCallId: "call",
        state: "output-error",
        errorText: "Tests failed",
      })
    )
  })

  it("imports structured turns and the target lock atomically, with stable scoped message ids", async () => {
    const message = canonicalTurnToHandoffMessage({
      turnId: "turn",
      role: "assistant",
      text: "Answer",
      reasoning: "Why",
      parts: [
        { type: "file", uri: "cognia-media:hash", name: "image.png", mediaType: "image/png" },
      ],
      toolCalls: [
        { callId: "complete", toolName: "read", status: "completed", resultText: "contents" },
        { callId: "pending", toolName: "write", status: "running" },
      ],
    })
    const params = {
      sessionId: "handoff",
      handoffSource: "thread-handoff" as const,
      messages: [message],
      handoffLock: { ticketId: "ticket", state: "frozen" as const, targetHostRef: "phone", at: 1 },
      now: 1,
    }
    await importHandoffSession(params)
    await importHandoffSession(params)
    const rows = await listMessages("handoff")
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("handoff:turn")
    expect(rows[0].parts).toEqual(
      expect.arrayContaining([
        { type: "reasoning", text: "Why", state: "done" },
        expect.objectContaining({ type: "file", url: "cognia-media:hash" }),
        expect.objectContaining({
          toolCallId: "complete",
          state: "output-available",
          output: "contents",
        }),
        expect.objectContaining({ toolCallId: "pending", state: "output-error" }),
      ])
    )
    expect((await getSession("handoff"))?.handoffLock?.ticketId).toBe("ticket")
    expect(await getDb().messageMediaRefs.get(["handoff:turn", "hash"])).toBeDefined()
  })

  it("refuses a locked handoff target collision without making a second writable copy", async () => {
    await getDb().sessions.put({ id: "native", title: "Original", createdAt: 1, updatedAt: 1 })
    const before = await getDb().sessions.count()
    await expect(
      importHandoffSession({
        sessionId: "native",
        handoffSource: "thread-handoff",
        messages: [],
        handoffLock: { ticketId: "ticket", state: "frozen", targetHostRef: "target", at: 1 },
      })
    ).rejects.toThrow("thread_handoff_target_session_collision")
    expect(await getDb().sessions.count()).toBe(before)
    expect((await getSession("native"))?.title).toBe("Original")
  })

  it("creates a continuable session from a CLI transcript", async () => {
    const session = await importHandoffSession({
      sessionId: "s_cli_1",
      title: "Fix the bug",
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "fixed it in foo.ts" },
      ],
      meta: { provider: "anthropic", model: "claude-x", cwd: "/proj" },
      now: 1000,
    })

    expect(session.id).toBe("s_cli_1")
    expect(session.title).toBe("Fix the bug")
    expect(session.kind).toBe("direct")
    expect(session.providerOverride).toBe("anthropic")
    expect(session.model).toBe("claude-x")
    expect(session.workingDir).toBe("/proj")
    // Context for the first in-app send is seeded as a transcript (no sdkSessionId).
    expect(session.branchSeed?.kind).toBe("transcript")
    expect(session.branchSeed?.content).toContain("fix the bug")
    expect(session.branchSeed?.content).toContain("fixed it in foo.ts")
    // Tagged as a CLI handoff and stamped with a workspace (else invisible in
    // the scoped chat sidebar).
    expect(session.handoffSource).toBe("cli")
    expect(session.projectId).toBe(DEFAULT_PROJECT_ID)
  })

  it("stamps the active workspace so the row lists in the scoped sidebar", async () => {
    const session = await importHandoffSession({
      sessionId: "s_scope",
      messages: [{ role: "user", content: "x" }],
      now: 1,
    })
    expect(session.projectId).toBe(DEFAULT_PROJECT_ID)
    // Reachable through the workspace-scoped listing, not just the unscoped one.
    const { listScopedSessions } = await import("@/lib/db/sessions")
    const scoped = await listScopedSessions(DEFAULT_PROJECT_ID)
    expect(scoped.map((s) => s.id)).toContain("s_scope")
  })

  it("honours an explicit projectId", async () => {
    const session = await importHandoffSession({
      sessionId: "s_scope2",
      projectId: "project-x",
      messages: [{ role: "user", content: "x" }],
      now: 1,
    })
    expect(session.projectId).toBe("project-x")
  })

  it("diverts to a fresh id instead of clobbering a native session with the same id", async () => {
    // A native (non-handoff) desktop session already owns this id.
    await getDb().sessions.put({
      id: "s_dupe",
      projectId: DEFAULT_PROJECT_ID,
      title: "My native chat",
      createdAt: 1,
      updatedAt: 1,
    } as ChatSession)

    const created = await importHandoffSession({
      sessionId: "s_dupe",
      messages: [{ role: "user", content: "from cli" }],
      now: 5,
    })

    // New row minted; the native row is left completely intact.
    expect(created.id).not.toBe("s_dupe")
    expect(created.id).toMatch(/^s_/)
    expect(created.handoffSource).toBe("cli")
    const native = await getSession("s_dupe")
    expect(native?.title).toBe("My native chat")
    expect(native?.handoffSource).toBeUndefined()
    // The CLI transcript landed on the new id, not the native session.
    expect(await listMessages("s_dupe")).toHaveLength(0)
    expect(await listMessages(created.id)).toHaveLength(1)
  })

  it("still diverts when the colliding native session is handoff-locked", async () => {
    // The lock belongs to an unrelated ADR-0103 transfer. This import never
    // writes to that row — it mints a new one — so the lock is none of its
    // business, and checking writability before the diversion turned a
    // handled collision into a hard failure.
    await getDb().sessions.put({
      id: "s_locked",
      projectId: DEFAULT_PROJECT_ID,
      title: "Native chat mid-handoff",
      createdAt: 1,
      updatedAt: 1,
      handoffLock: {
        ticketId: "ticket-9",
        state: "frozen",
        targetHostRef: "phone-1",
        at: 2,
      },
    } as ChatSession)

    const created = await importHandoffSession({
      sessionId: "s_locked",
      messages: [{ role: "user", content: "from cli" }],
      now: 5,
    })

    expect(created.id).not.toBe("s_locked")
    const native = await getSession("s_locked")
    expect(native?.title).toBe("Native chat mid-handoff")
    expect(native?.handoffLock?.ticketId).toBe("ticket-9")
    expect(await listMessages("s_locked")).toHaveLength(0)
    expect(await listMessages(created.id)).toHaveLength(1)
  })

  it("refuses an overwrite-in-place re-handoff while the row is handoff-locked", async () => {
    // The other half of the guard: this path DOES write to the existing row.
    await getDb().sessions.put({
      id: "s_relock",
      projectId: DEFAULT_PROJECT_ID,
      title: "Prior handoff",
      handoffSource: "cli",
      createdAt: 1,
      updatedAt: 1,
      handoffLock: {
        ticketId: "ticket-7",
        state: "frozen",
        targetHostRef: "phone-1",
        at: 2,
      },
    } as ChatSession)

    await expect(
      importHandoffSession({
        sessionId: "s_relock",
        messages: [{ role: "user", content: "from cli" }],
        now: 5,
      })
    ).rejects.toMatchObject({ code: "session_handoff_locked" })
  })

  it("persists the transcript as visible messages and stores the row", async () => {
    await importHandoffSession({
      sessionId: "s_cli_2",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      now: 2000,
    })

    const stored = await getSession("s_cli_2")
    expect(stored?.title).toBe("Handoff from CLI") // default title

    const msgs = await listMessages("s_cli_2")
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("forks changed snapshots instead of replacing desktop history", async () => {
    const first = await importHandoffSession({
      sessionId: "s_cli_3",
      messages: [{ role: "user", content: "first" }],
      now: 1,
    })
    expect(first.createdAt).toBe(1)
    const second = await importHandoffSession({
      sessionId: "s_cli_3",
      title: "Second",
      messages: [{ role: "user", content: "second" }],
      now: 2,
    })
    // Same id (idempotent re-handoff, not a native collision), content replaced.
    expect(second.id).not.toBe("s_cli_3")
    expect(second.createdAt).toBe(2) // preserved from the first handoff
    expect(second.updatedAt).toBe(2)
    const stored = await getSession("s_cli_3")
    expect(stored?.title).toBe("Handoff from CLI")
    const msgs = await listMessages("s_cli_3")
    expect(msgs).toHaveLength(1)
  })

  it("retries reopen the actual collision-diverted import without overwriting continuation", async () => {
    await getDb().sessions.put({ id: "source", title: "Native", createdAt: 1, updatedAt: 1 })
    const params = {
      sessionId: "source",
      messages: [{ role: "user" as const, content: "source prompt" }],
    }
    const first = await importHandoffSession(params)
    await getDb().sessions.update(first.id, { title: "Continued locally" })
    const second = await importHandoffSession(params)
    expect(second.id).toBe(first.id)
    expect(second.title).toBe("Continued locally")
    expect(await getDb().sessions.count()).toBe(2)
  })

  it("serializes concurrent retries into one durable receipt", async () => {
    const params = { sessionId: "concurrent", messages: [{ role: "user" as const, content: "x" }] }
    const results = await Promise.all([importHandoffSession(params), importHandoffSession(params)])
    expect(results[0].id).toBe(results[1].id)
    expect(await getDb().sessions.count()).toBe(1)
  })

  it("rolls back the session and receipt if message persistence fails", async () => {
    const spy = jest
      .spyOn(getDb().messages, "bulkPut")
      .mockRejectedValueOnce(new Error("quota exceeded"))
    try {
      await expect(
        importHandoffSession({ sessionId: "rollback", messages: [{ role: "user", content: "x" }] })
      ).rejects.toThrow("quota exceeded")
      expect(await getDb().sessions.get("rollback")).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it("rejects malformed parts before creating a session", async () => {
    await expect(
      importHandoffSession({
        sessionId: "bad",
        messages: [{ role: "assistant", content: "x", parts: [null] as never }],
      })
    ).rejects.toThrow("invalid messages")
    expect(await getDb().sessions.count()).toBe(0)
  })

  it("omits branchSeed when the transcript renders empty", async () => {
    const session = await importHandoffSession({
      sessionId: "s_cli_4",
      messages: [],
      now: 1,
    })
    expect(session.branchSeed).toBeUndefined()
  })

  it("rejects a missing sessionId", async () => {
    await expect(
      importHandoffSession({ sessionId: "", messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/sessionId is required/)
  })
})
