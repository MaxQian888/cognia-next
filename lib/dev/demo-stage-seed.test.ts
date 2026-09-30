import {
  createStagedConversation,
  stampMessage,
  streamSteps,
  validateScript,
  withLastText,
  withPart,
  withPatchedPart,
  type StagedConversationDeps,
  type StagedConversationScript,
  type StagedMessage,
} from "./demo-stage-seed"

const user: StagedMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Fix the failing check." }],
}
const assistant: StagedMessage = { id: "a1", role: "assistant", parts: [] }

function makeDeps(overrides: Partial<StagedConversationDeps> = {}) {
  const persisted: StagedMessage[][] = []
  const published: StagedMessage[][] = []
  const sleeps: number[] = []
  const deps: StagedConversationDeps = {
    persist: jest.fn(async (_sessionId, upserts) => {
      persisted.push(upserts)
    }),
    publish: jest.fn((_sessionId, messages) => {
      published.push(messages)
    }),
    seedPlan: jest.fn(async () => "plan-1"),
    requestApproval: jest.fn(),
    createArtifact: jest.fn(() => "artifact-1"),
    sleep: jest.fn(async (ms: number) => {
      sleeps.push(ms)
    }),
    now: () => 1000,
    ...overrides,
  }
  return { deps, persisted, published, sleeps }
}

describe("streamSteps", () => {
  it("walks every prefix at the chunk stride and ends on the whole text", () => {
    expect(streamSteps("abcdefg", 3)).toEqual(["abc", "abcdef", "abcdefg"])
  })

  it("does not repeat the final frame when the length is a multiple of the chunk", () => {
    expect(streamSteps("abcdef", 3)).toEqual(["abc", "abcdef"])
  })

  it("yields one empty frame for empty text so the part still exists", () => {
    expect(streamSteps("")).toEqual([""])
  })

  it("rejects a chunk size that would never advance", () => {
    expect(() => streamSteps("abc", 0)).toThrow("positive integer")
    expect(() => streamSteps("abc", 1.5)).toThrow("positive integer")
  })
})

describe("transcript helpers", () => {
  it("withPart appends without mutating the input", () => {
    const before = [assistant]
    const after = withPart(before, "a1", { type: "text", text: "hi" })
    expect(after[0].parts).toEqual([{ type: "text", text: "hi" }])
    expect(before[0].parts).toEqual([])
  })

  it("withLastText replaces only the trailing text part", () => {
    const messages = withPart([assistant], "a1", { type: "text", text: "" })
    expect(withLastText(messages, "a1", "done")[0].parts).toEqual([{ type: "text", text: "done" }])
  })

  it("withLastText refuses a message that does not end on text", () => {
    const messages = withPart([assistant], "a1", { type: "tool-Read", toolCallId: "t1" })
    expect(() => withLastText(messages, "a1", "x")).toThrow("does not end on a text part")
  })

  it("withPatchedPart merges into the matching tool part only", () => {
    let messages = withPart([assistant], "a1", {
      type: "tool-Bash",
      toolCallId: "t1",
      state: "input-available",
    })
    messages = withPart(messages, "a1", { type: "tool-Read", toolCallId: "t2", state: "x" })
    const patched = withPatchedPart(messages, "a1", "t1", {
      state: "output-error",
      errorText: "1 failed",
    })
    expect(patched[0].parts[0]).toMatchObject({ state: "output-error", errorText: "1 failed" })
    expect(patched[0].parts[1]).toEqual({ type: "tool-Read", toolCallId: "t2", state: "x" })
  })

  it("withPatchedPart names the missing tool call", () => {
    expect(() => withPatchedPart([assistant], "a1", "nope", {})).toThrow("no tool part nope")
  })

  it("helpers name an unknown message", () => {
    expect(() => withPart([], "zz", {})).toThrow("no message zz")
  })

  it("stampMessage keeps existing metadata and adds session and time", () => {
    expect(stampMessage({ ...user, metadata: { model: "m" } }, "s1", 7).metadata).toEqual({
      model: "m",
      sessionId: "s1",
      createdAt: 7,
    })
  })
})

describe("validateScript", () => {
  it("rejects an empty script", () => {
    expect(() => validateScript({ title: "t", stages: [] })).toThrow("no stages")
  })

  it("rejects a stage that targets a message not appended yet", () => {
    expect(() =>
      validateScript({ title: "t", stages: [{ kind: "stream", messageId: "a1", text: "x" }] })
    ).toThrow("unknown a1")
  })

  it("rejects a patch of a tool call never added", () => {
    expect(() =>
      validateScript({
        title: "t",
        stages: [
          { kind: "append", message: assistant },
          { kind: "patchPart", messageId: "a1", toolCallId: "t9", patch: {} },
        ],
      })
    ).toThrow("unknown t9")
  })

  it("rejects an approval for a tool call never added", () => {
    expect(() =>
      validateScript({
        title: "t",
        stages: [{ kind: "approval", toolCallId: "t1", toolName: "Bash", input: {} }],
      })
    ).toThrow("unknown t1")
  })

  it("rejects duplicate message ids and empty plans", () => {
    expect(() =>
      validateScript({
        title: "t",
        stages: [
          { kind: "append", message: user },
          { kind: "append", message: user },
        ],
      })
    ).toThrow("duplicate id u1")
    expect(() =>
      validateScript({ title: "t", stages: [{ kind: "plan", title: "p", stepTitles: [] }] })
    ).toThrow("a plan needs steps")
  })
})

describe("createStagedConversation", () => {
  const script: StagedConversationScript = {
    title: "Demo",
    stages: [
      { kind: "append", message: user },
      { kind: "append", message: assistant },
      { kind: "stream", messageId: "a1", text: "Reading.", chunkSize: 4, intervalMs: 10 },
      {
        kind: "addPart",
        messageId: "a1",
        part: { type: "tool-Bash", toolCallId: "t1", state: "input-available", input: {} },
      },
      {
        kind: "patchPart",
        messageId: "a1",
        toolCallId: "t1",
        patch: { state: "output-error", errorText: "1 failed" },
      },
      { kind: "plan", title: "Release", stepTitles: ["Fix", "Verify"] },
      {
        kind: "artifact",
        messageId: "a1",
        title: "launch-notes.md",
        content: "# 2.4.0",
        artifactType: "document",
        language: "markdown",
      },
    ],
  }

  it("plays one stage per advance and reports completion on the last", async () => {
    const { deps } = makeDeps()
    const convo = createStagedConversation("s1", script, deps)
    expect(convo.stageCount).toBe(7)
    const results = []
    for (let i = 0; i < 7; i++) results.push(await convo.advance())
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(results.at(-1)?.done).toBe(true)
    expect(results.slice(0, -1).every((r) => !r.done)).toBe(true)
    expect(await convo.advance()).toEqual({ index: 6, done: true })
  })

  it("stamps appended messages with the session and increasing times", async () => {
    const { deps } = makeDeps()
    const convo = createStagedConversation("s1", script, deps)
    await convo.advance()
    await convo.advance()
    const [u, a] = convo.messages()
    expect(u.metadata).toEqual({ sessionId: "s1", createdAt: 1000 })
    expect(a.metadata).toEqual({ sessionId: "s1", createdAt: 1001 })
  })

  it("streams through the live store and persists only the final frame", async () => {
    const { deps, persisted, published, sleeps } = makeDeps()
    const convo = createStagedConversation("s1", script, deps)
    await convo.advance()
    await convo.advance()
    persisted.length = 0
    published.length = 0
    await convo.advance()
    const frames = published.map((m) => m[1].parts.at(-1)?.text)
    expect(frames).toEqual(["Read", "Reading."])
    expect(persisted).toHaveLength(1)
    expect(persisted[0][0].parts).toEqual([{ type: "text", text: "Reading." }])
    expect(sleeps).toEqual([10])
  })

  it("moves a tool part forward and persists only the changed message", async () => {
    const { deps, persisted } = makeDeps()
    const convo = createStagedConversation("s1", script, deps)
    for (let i = 0; i < 5; i++) await convo.advance()
    const tool = convo.messages()[1].parts.find((p) => p.toolCallId === "t1")
    expect(tool).toMatchObject({ state: "output-error", errorText: "1 failed" })
    expect(persisted.at(-1)?.map((m) => m.id)).toEqual(["a1"])
  })

  it("seeds the plan and the artifact through their dependencies", async () => {
    const { deps } = makeDeps()
    const convo = createStagedConversation("s1", script, deps)
    for (let i = 0; i < 7; i++) await convo.advance()
    expect(deps.seedPlan).toHaveBeenCalledWith({
      sessionId: "s1",
      title: "Release",
      planText: undefined,
      stepTitles: ["Fix", "Verify"],
    })
    expect(deps.createArtifact).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "a1",
      type: "document",
      title: "launch-notes.md",
      content: "# 2.4.0",
      language: "markdown",
    })
    expect(convo.messages()[1].parts.at(-1)).toEqual({
      type: "artifact",
      artifactId: "artifact-1",
      title: "launch-notes.md",
      kind: "document",
      defaultOpen: true,
    })
  })

  it("raises the approval against the tool call it names", async () => {
    const { deps } = makeDeps()
    const convo = createStagedConversation(
      "s1",
      {
        title: "t",
        stages: [
          {
            kind: "append",
            message: {
              id: "a1",
              role: "assistant",
              parts: [{ type: "tool-Bash", toolCallId: "push", state: "approval-requested" }],
            },
          },
          {
            kind: "approval",
            toolCallId: "push",
            toolName: "Bash",
            input: { command: "git push origin release/2.4.0" },
            title: "Push release/2.4.0",
          },
        ],
      },
      deps
    )
    await convo.advance()
    await expect(convo.advance()).resolves.toEqual({ index: 1, done: true })
    expect(deps.requestApproval).toHaveBeenCalledWith({
      sessionId: "s1",
      requestId: "demo-approval-push",
      toolUseID: "push",
      toolName: "Bash",
      input: { command: "git push origin release/2.4.0" },
      title: "Push release/2.4.0",
      description: undefined,
    })
  })

  it("refuses to interleave two stages", async () => {
    let release: () => void = () => {}
    const { deps } = makeDeps({
      persist: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      ),
    })
    const convo = createStagedConversation("s1", script, deps)
    const first = convo.advance()
    await expect(convo.advance()).rejects.toThrow("while a stage is playing")
    release()
    await expect(first).resolves.toEqual({ index: 0, done: false })
  })

  it("does not advance past a stage that failed", async () => {
    const { deps } = makeDeps({
      persist: jest.fn(async () => {
        throw new Error("disk full")
      }),
    })
    const convo = createStagedConversation("s1", script, deps)
    await expect(convo.advance()).rejects.toThrow("disk full")
    expect(convo.messages()).toEqual([])
    deps.persist = jest.fn(async () => undefined)
    // The failed stage replays cleanly: the retry reports index 0 and the
    // transcript holds the message once.
    await expect(convo.advance()).resolves.toEqual({ index: 0, done: false })
    expect(convo.messages().map((m) => m.id)).toEqual(["u1"])
  })

  it("rejects an invalid script up front", () => {
    const { deps } = makeDeps()
    expect(() => createStagedConversation("s1", { title: "t", stages: [] }, deps)).toThrow(
      "no stages"
    )
  })
})
