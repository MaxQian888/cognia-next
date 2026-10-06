import { readOmpSession, summarizeOmpSession, detectOmpSessions } from "./history"
const host = { redactText: (text: string) => text.replaceAll("private@example.com", "[email]") }
const header = {
  type: "session",
  version: 3,
  id: "s",
  timestamp: "2026-10-06T00:00:00Z",
  cwd: "/work",
}
const entry = (id: string, parentId: string | null, message: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-06T00:00:01Z",
  message,
})
const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n")
it("keeps OMP title slots, native session identity and alternate branches", () => {
  const content = jsonl(
    { type: "title", v: 1, title: "Current title" },
    { ...header, parentSession: "parent-id" },
    entry("u", null, { role: "user", content: "hello" }),
    entry("old", "u", { role: "assistant", content: "old" }),
    entry("new", "u", { role: "assistant", content: "new" })
  )
  const result = readOmpSession(content, "file", host)
  expect(result.session.title).toBe("Current title")
  expect(result.session.parentNativeSessionId).toBe("parent-id")
  expect(result.session.messages.at(-1)?.parts).toEqual([{ type: "text", text: "new" }])
  expect(result.branches[0].leafId).toBe("old")
  expect(result.branches[0].session.relationKind).toBe("branch")
  expect(summarizeOmpSession(content, "file")?.messageCount).toBe(2)
})
it("preserves tools, inline images and per-turn usage without inventing blob bytes", () => {
  const content = jsonl(
    header,
    entry("a", null, {
      role: "assistant",
      model: "model",
      usage: { input: 2, output: 3, cacheRead: 4, cost: { total: 0.1 } },
      content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "x" } }],
    }),
    entry("b", "a", {
      role: "toolResult",
      toolCallId: "t",
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "image", data: "blob:sha256:" + "a".repeat(64), mimeType: "image/png" },
      ],
    })
  )
  const { session } = readOmpSession(content, "file", host)
  expect(session.messages[0].usage).toMatchObject({
    inputTokens: 2,
    outputTokens: 3,
    cacheReadInputTokens: 4,
    totalCostUsd: 0.1,
  })
  expect(session.messages[0].parts[0]).toMatchObject({
    name: "read",
    result: { ok: true, output: "ok" },
  })
  expect(session.messages[0].parts).toContainEqual({
    type: "file",
    mediaType: "image/png",
    url: "data:image/png;base64,abc",
  })
  expect(session.losses.some((loss) => loss.path.includes("blob"))).toBe(true)
  expect(JSON.stringify(session)).not.toContain("base64,blob:")
})
it("rebuilds goal and latest canonical todo state, retains unknown data as redacted diagnostics", () => {
  const content =
    jsonl(
      header,
      {
        type: "mode_change",
        id: "g",
        parentId: null,
        mode: "goal",
        data: {
          goal: { id: "goal", objective: "Ship", status: "active", tokensUsed: 10, updatedAt: 0 },
        },
      },
      {
        type: "custom",
        id: "t",
        parentId: "g",
        customType: "user_todo_edit",
        data: {
          phases: [
            {
              name: "Build",
              tasks: [{ id: "one", content: "Test", status: "in_progress", blocker: "pending" }],
            },
          ],
        },
      },
      {
        type: "future",
        id: "f",
        parentId: "t",
        data: { email: "private@example.com", apiKey: "secret" },
      }
    ) + "\n{broken"
  const { session } = readOmpSession(content, "file", host)
  expect(session.goals[0]).toMatchObject({ goalId: "goal", description: "Ship", status: "active" })
  expect(session.tasks[0]).toMatchObject({ description: "Test", status: "running" })
  expect(session.plans[0].steps).toEqual(["Test"])
  expect(JSON.stringify(session.recordedEvents)).not.toContain("private@example.com")
  expect(JSON.stringify(session.recordedEvents)).not.toContain('"secret"')
  expect(session.losses.some((loss) => loss.path === "lines")).toBe(true)
})
it("rejects foreign formats and future session versions instead of silently parsing them", () => {
  expect(() => readOmpSession(jsonl({ ...header, version: 99 }), "x", host)).toThrow(/version/i)
  expect(() => readOmpSession(jsonl({ type: "other" }), "x", host)).toThrow(/session/i)
  expect(
    detectOmpSessions([
      { path: "/home/.pi/agent/sessions/x.jsonl", name: "x.jsonl", content: jsonl(header) },
    ])
  ).toBe("no")
  expect(
    detectOmpSessions([
      { path: "/home/.omp/agent/sessions/x.jsonl", name: "x.jsonl", content: jsonl(header) },
    ])
  ).toBe("match")
  expect(
    detectOmpSessions([{ path: "/export/x.jsonl", name: "x.jsonl", content: jsonl(header) }])
  ).toBe("maybe")
})
it("handles cycles, missing parents and legacy linear records deterministically", () => {
  const cycle = jsonl(
    header,
    entry("a", "b", { role: "user", content: "a" }),
    entry("b", "a", { role: "assistant", content: "b" })
  )
  expect(readOmpSession(cycle, "f", host).session.losses.length).toBeGreaterThan(0)
  const legacy = jsonl(
    { ...header, version: 1 },
    { type: "message", message: { role: "user", content: "legacy" } }
  )
  expect(readOmpSession(legacy, "f", host).session.messages[0].createdAt).toBe(
    Date.parse(header.timestamp)
  )
})

it.each([
  ["complete", "completed"],
  ["dropped", "cancelled"],
  ["paused", "blocked"],
  ["budget-limited", "blocked"],
])("maps native goal status %s to %s", (native, canonical) => {
  const { session } = readOmpSession(
    jsonl(header, {
      type: "mode_change",
      id: "g",
      data: { goal: { id: "g", objective: "ship", status: native } },
    }),
    "x",
    host
  )
  expect(session.goals[0].status).toBe(canonical)
})
it("keeps mentioned files, direct execution images, provider metadata, and blocked todos", () => {
  const { session } = readOmpSession(
    jsonl(
      header,
      entry("f", null, { role: "fileMention", files: [{ path: "/x", content: "file bytes" }] }),
      entry("b", "f", {
        role: "bashExecution",
        command: "print",
        output: "bad",
        exitCode: -1,
        images: [{ type: "image", data: "abc" }],
      }),
      entry("a", "b", {
        role: "assistant",
        content: [{ type: "text", text: "hi", signature: "provider-only" }],
        providerPayload: { private: "private@example.com" },
      }),
      {
        type: "custom",
        id: "t",
        parentId: "a",
        customType: "user_todo_edit",
        data: { phases: [{ name: "p", tasks: [{ content: "Wait", status: "blocked" }] }] },
      }
    ),
    "x",
    host
  )
  expect(session.messages[0].parts[0]).toEqual({ type: "text", text: "file bytes" })
  expect(session.messages[1].parts[0]).toMatchObject({ result: { ok: false } })
  expect(session.messages[1].parts[1]).toMatchObject({ type: "file" })
  expect(session.tasks[0].status).toBe("waiting")
  expect(JSON.stringify(session.recordedEvents)).toContain("[email]")
  expect(JSON.stringify(session.recordedEvents)).toContain("provider-only")
})
it("resolves external image references only from supplied blob bytes", () => {
  const ref = "blob:sha256:" + "f".repeat(64)
  const { session } = readOmpSession(
    jsonl(header, entry("i", null, { role: "user", content: [{ type: "image", data: ref }] })),
    "x",
    host,
    { blobs: new Map([[ref, { data: "aGVsbG8=", mimeType: "image/jpeg" }]]) }
  )
  expect(session.messages[0].parts).toEqual([
    { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,aGVsbG8=" },
  ])
})
it("takes file order rather than skewed timestamps when selecting the active branch", () => {
  const content = jsonl(
    header,
    entry("u", null, { role: "user", content: "hello" }),
    { ...entry("old", "u", { role: "assistant", content: "old" }), timestamp: "2099-01-01" },
    entry("new", "u", { role: "assistant", content: "new" })
  )
  expect(readOmpSession(content, "x", host).session.messages.at(-1)?.parts).toEqual([
    { type: "text", text: "new" },
  ])
})

it("retains custom/hook details and unmapped usage metadata through the redacted diagnostic host", () => {
  const content = jsonl(
    header,
    entry("c", null, {
      role: "custom",
      content: "context",
      details: { email: "private@example.com", state: "CUSTOM_STATE" },
    }),
    entry("h", "c", { role: "hookMessage", content: "hook", details: { state: "HOOK_STATE" } }),
    entry("u", "h", {
      role: "assistant",
      content: "answer",
      usage: { input: 1, output: 2, premiumRequests: 3, orchestration: { input: 4 } },
    })
  )
  const { session } = readOmpSession(content, "x", host)
  const diagnostics = JSON.stringify(session.recordedEvents)
  expect(diagnostics).toContain("CUSTOM_STATE")
  expect(diagnostics).toContain("HOOK_STATE")
  expect(diagnostics).toContain("premiumRequests")
  expect(diagnostics).toContain("orchestration")
  expect(diagnostics).not.toContain("private@example.com")
  expect(session.losses.length).toBeGreaterThan(0)
})
it("reports detached records in mixed-ID and disconnected cyclic graphs", () => {
  const { session } = readOmpSession(
    jsonl(
      header,
      entry("u", null, { role: "user", content: "main" }),
      entry("a", "b", { role: "assistant", content: "CYCLE_A" }),
      entry("b", "a", { role: "assistant", content: "CYCLE_B" }),
      { type: "message", message: { role: "assistant", content: "UNLINKED private@example.com" } }
    ),
    "x",
    host
  )
  expect(session.messages).toHaveLength(1)
  const diagnostics = JSON.stringify(session.recordedEvents)
  expect(diagnostics).toContain("CYCLE_A")
  expect(diagnostics).toContain("CYCLE_B")
  expect(diagnostics).toContain("UNLINKED [email]")
  expect(session.losses.filter((loss) => loss.path === "entries.tree.detached")).toHaveLength(1)
})
it("does not silently discard model-usage errors or custom attribution", () => {
  const { session } = readOmpSession(
    jsonl(
      header,
      {
        type: "custom_message",
        id: "c",
        parentId: null,
        content: "user skill",
        attribution: "user",
        display: true,
      },
      {
        type: "model_usage",
        id: "u",
        parentId: "c",
        model: "m",
        purpose: "title",
        usage: { input: 1, output: 0 },
        stopReason: "error",
        errorMessage: "MODEL_FAILURE",
      }
    ),
    "x",
    host
  )
  expect(JSON.stringify(session)).toContain('"attribution":"user"')
  expect(JSON.stringify(session.recordedEvents)).toContain("MODEL_FAILURE")
})
