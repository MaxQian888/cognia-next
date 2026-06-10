import "fake-indexeddb/auto"
import { importHandoffSession } from "./import-handoff-session"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"

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

  it("is idempotent — a repeat handoff overwrites the row", async () => {
    await importHandoffSession({
      sessionId: "s_cli_3",
      messages: [{ role: "user", content: "first" }],
      now: 1,
    })
    await importHandoffSession({
      sessionId: "s_cli_3",
      title: "Second",
      messages: [{ role: "user", content: "second" }],
      now: 2,
    })
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
