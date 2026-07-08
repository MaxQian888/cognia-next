import "fake-indexeddb/auto"
import { importHandoffSession } from "./import-handoff-session"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import type { ChatSession } from "@/lib/claude/types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("importHandoffSession", () => {
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
    expect(session.branchSeed?.content).toMatch(/User: fix the bug/)
    expect(session.branchSeed?.content).toMatch(/Assistant: fixed it in foo\.ts/)
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

  it("is idempotent — a repeat handoff overwrites the row but preserves createdAt", async () => {
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
    expect(second.id).toBe("s_cli_3")
    expect(second.createdAt).toBe(1) // preserved from the first handoff
    expect(second.updatedAt).toBe(2)
    const stored = await getSession("s_cli_3")
    expect(stored?.title).toBe("Second")
    const msgs = await listMessages("s_cli_3")
    expect(msgs).toHaveLength(1)
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
