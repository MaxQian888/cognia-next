/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const startSeededSession = jest.fn(async (_input: unknown) => ({ sessionId: "s_new" }))
jest.mock("@/lib/plugin/api/session-seed", () => ({
  startSeededSession: (input: unknown) => startSeededSession(input),
}))

import type { ChatSession } from "@cognia/agent-config-types"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { getSession } from "@/lib/db/sessions"
import "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function run(kind: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
    projectId: "proj1",
    ...extra,
  } as unknown as StepExecutionContext)
}

async function seedSession(over: Partial<ChatSession> = {}): Promise<ChatSession> {
  const { getDb } = await import("@/lib/db/schema")
  const row = {
    id: "sess1",
    title: "One",
    projectId: "proj1",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as ChatSession
  await getDb().sessions.put(row)
  return row
}

beforeEach(async () => {
  jest.clearAllMocks()
  startSeededSession.mockResolvedValue({ sessionId: "s_new" })
  const { getDb } = await import("@/lib/db/schema")
  await getDb().sessions.clear()
  await getDb().messages.clear()
})

describe("registration", () => {
  it.each([
    "action.session.create",
    "action.session.get",
    "action.session.list",
    "action.session.appendMessage",
    "action.session.update",
    "action.session.archive",
    "action.session.export",
  ])("registers %s", (kind) => {
    expect(getExecutor(kind as never, 1)).toBeDefined()
  })

  it("registers no delete node, because that is the user's call and not a graph's", () => {
    expect(getExecutor("action.session.delete" as never, 1)).toBeUndefined()
  })
})

describe("action.session.create", () => {
  it("goes through startSeededSession, not createSession", async () => {
    // `createSession` writes the row and skips workspace attribution from the
    // store, execution-context materialization and the session.created event.
    // A conversation a workflow started has to be the same kind of object.
    await run("action.session.create", { title: "T" })
    expect(startSeededSession).toHaveBeenCalledTimes(1)
  })

  it("does not steal focus by default, and stamps the run's workspace", async () => {
    await run("action.session.create", { title: "T" })
    expect(startSeededSession.mock.calls[0][0]).toMatchObject({
      title: "T",
      projectId: "proj1",
      activate: false,
    })
  })

  it("lets an explicit workspace win over the run's", async () => {
    await run("action.session.create", { projectId: "other" })
    expect(startSeededSession.mock.calls[0][0]).toMatchObject({ projectId: "other" })
  })

  it("passes a seed message through", async () => {
    await run("action.session.create", { seedUserMessage: "hello" })
    expect(startSeededSession.mock.calls[0][0]).toMatchObject({ seedUserMessage: "hello" })
  })

  it("is not retryable, because a retry strands an empty conversation", () => {
    expect(getExecutor("action.session.create" as never, 1)!.retryable).toBe(false)
  })

  it("still answers when the row cannot be read back", async () => {
    const out = (await run("action.session.create", { title: "T" })).output as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ sessionId: "s_new" })
  })
})

describe("addressing a session this Host does not hold", () => {
  it.each([
    "action.session.get",
    "action.session.appendMessage",
    "action.session.update",
    "action.session.archive",
    "action.session.export",
  ])("%s refuses rather than writing optimistically", async (kind) => {
    // ADR-0116 makes live session state host-authoritative, so a step must not
    // compete with another Host's turn state.
    await expect(run(kind, { sessionId: "nope", text: "x", title: "t" })).rejects.toThrow(
      /does not hold session nope/
    )
  })

  it.each(["action.session.get", "action.session.update"])("%s requires a sessionId", async (k) => {
    await expect(run(k, {})).rejects.toThrow(/requires 'sessionId'/)
  })
})

describe("action.session.get", () => {
  it("returns the summary without messages by default", async () => {
    await seedSession()
    await persistMessages("sess1", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as never)
    const out = (await run("action.session.get", { sessionId: "sess1" })).output as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ sessionId: "sess1", title: "One", messageCount: 0 })
  })

  it("returns the most recent messages and says when it truncated", async () => {
    await seedSession()
    await persistMessages("sess1", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "two" }] },
      { id: "m3", role: "user", parts: [{ type: "text", text: "three" }] },
    ] as never)
    const out = (await run("action.session.get", { sessionId: "sess1", messageLimit: 2 }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ messageCount: 2, totalMessageCount: 3, truncated: true })
    expect((out.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["two", "three"])
  })
})

describe("action.session.list", () => {
  it("scopes to the run's workspace and hides archived rows by default", async () => {
    await seedSession({ id: "a" })
    await seedSession({ id: "b", archivedAt: 5 })
    const out = (await run("action.session.list", {})).output as {
      sessions: Array<{ sessionId: string }>
    }
    expect(out.sessions.map((s) => s.sessionId)).toEqual(["a"])
  })

  it("keeps embedded sessions out, the same as every other enumeration", async () => {
    await seedSession({ id: "a" })
    await seedSession({ id: "embedded", visibility: "embedded" } as Partial<ChatSession>)
    const out = (await run("action.session.list", {})).output as {
      sessions: Array<{ sessionId: string }>
    }
    expect(out.sessions.map((s) => s.sessionId)).toEqual(["a"])
  })

  it("caps the page and reports the full count", async () => {
    for (const id of ["a", "b", "c"]) await seedSession({ id })
    const out = (await run("action.session.list", { limit: 2 })).output as Record<string, unknown>
    expect(out).toMatchObject({ sessionCount: 2, totalCount: 3, truncated: true })
  })
})

describe("action.session.appendMessage", () => {
  it("appends rather than replacing the transcript", async () => {
    // `persistMessages` is `replaceSessionTranscript`. Handing it one message
    // would delete the conversation, which is why the node reads first.
    await seedSession()
    await persistMessages("sess1", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "first" }] },
    ] as never)

    await run("action.session.appendMessage", { sessionId: "sess1", text: "second" })

    const messages = await listMessages("sess1")
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.id)).toEqual(["m1", "msg_wf_run1_s1"])
  })

  it("uses a deterministic id so a replayed step does not write a second copy", async () => {
    await seedSession()
    await run("action.session.appendMessage", { sessionId: "sess1", text: "x" })
    await run("action.session.appendMessage", { sessionId: "sess1", text: "x again" })
    const messages = await listMessages("sess1")
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe("msg_wf_run1_s1")
  })

  it("says a user message did not start a turn", async () => {
    await seedSession()
    const out = (await run("action.session.appendMessage", { sessionId: "sess1", text: "x" }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ role: "user", deliveryDeferred: true })

    const assistant = (
      await run("action.session.appendMessage", {
        sessionId: "sess1",
        text: "x",
        role: "assistant",
      })
    ).output as Record<string, unknown>
    expect(assistant).toMatchObject({ role: "assistant", deliveryDeferred: false })
  })

  it("requires text", async () => {
    await seedSession()
    await expect(run("action.session.appendMessage", { sessionId: "sess1" })).rejects.toThrow(
      /requires 'text'/
    )
  })
})

describe("action.session.update", () => {
  it("renames and opts the conversation out of auto-titling", async () => {
    await seedSession({ titleAuto: true })
    await run("action.session.update", { sessionId: "sess1", title: "Renamed" })
    const row = await getSession("sess1")
    expect(row).toMatchObject({ title: "Renamed", titleAuto: false })
  })

  it("pins and files", async () => {
    await seedSession()
    await run("action.session.update", { sessionId: "sess1", pinned: true, folderId: "f1" })
    expect(await getSession("sess1")).toMatchObject({ pinned: true, folderId: "f1" })
  })

  it("refuses a patch with nothing in it", async () => {
    await seedSession()
    await expect(run("action.session.update", { sessionId: "sess1" })).rejects.toThrow(
      /at least one of 'title', 'pinned' or 'folderId'/
    )
  })
})

describe("action.session.archive", () => {
  it("archives and unarchives", async () => {
    await seedSession()
    await run("action.session.archive", { sessionId: "sess1" })
    expect((await getSession("sess1"))?.archivedAt).toBeDefined()
    await run("action.session.archive", { sessionId: "sess1", archived: false })
    expect((await getSession("sess1"))?.archivedAt).toBeUndefined()
  })
})

describe("action.session.export", () => {
  it("renders markdown without importing anything under components/", async () => {
    await seedSession({ title: "Chat" })
    await persistMessages("sess1", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "question" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "answer" }] },
    ] as never)
    const out = (await run("action.session.export", { sessionId: "sess1" })).output as Record<
      string,
      unknown
    >
    expect(out.format).toBe("markdown")
    expect(out.content).toContain("# Chat")
    expect(out.content).toContain("## user")
    expect(out.content).toContain("answer")
    expect(out).toMatchObject({ messageCount: 2 })
  })

  it("renders json when asked", async () => {
    await seedSession()
    await persistMessages("sess1", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "q" }] },
    ] as never)
    const out = (await run("action.session.export", { sessionId: "sess1", format: "json" }))
      .output as { content: string }
    const parsed = JSON.parse(out.content)
    expect(parsed.messages).toEqual([{ id: "m1", role: "user", text: "q" }])
  })
})
