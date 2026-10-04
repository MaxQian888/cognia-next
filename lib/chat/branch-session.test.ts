import {
  branchSessionAtMessage,
  branchTitle,
  renderBranchSeed,
  renderTranscript,
  BRANCH_SEED_MAX_CHARS,
} from "./branch-session"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listMessages, persistMessages, rowToUIMessage } from "@/lib/db/messages"
import { emptyWorkingSet, mutateSessionWorkingSet } from "./working-set"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

function uiMsg(
  id: string,
  role: UIMessage["role"],
  text: string,
  meta?: Record<string, unknown>
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    ...(meta ? { metadata: meta } : {}),
  } as UIMessage
}

async function seedSource(overrides: Partial<ChatSession> = {}): Promise<ChatSession> {
  const now = Date.now()
  const session: ChatSession = {
    id: "src1",
    title: "Original",
    kind: "direct",
    model: "claude-x",
    systemPrompt: "be nice",
    messageDisplayOverride: { preset: "inspector" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  await getDb().sessions.put(session)
  return session
}

const visible = (): UIMessage[] => [
  uiMsg("u1", "user", "first question"),
  uiMsg("a1", "assistant", "first answer"),
  uiMsg("u2", "user", "second question"),
  uiMsg("a2", "assistant", "second answer"),
]

afterAll(dbFixture.dispose)

describe("branch working set policy", () => {
  it("inherits historical state without future mutations and keeps child mutations independent", async () => {
    await seedSource()
    const messages = visible()
    await persistMessages("src1", messages.slice(0, 2))
    const historical = await mutateSessionWorkingSet({
      sessionId: "src1",
      expectedRevision: 0,
      action: "upsert",
      entry: { id: "choice", kind: "decision", summary: "First choice", origin: "user" },
    })
    await persistMessages("src1", messages)
    await mutateSessionWorkingSet({
      sessionId: "src1",
      expectedRevision: 1,
      action: "remove",
      entryId: "choice",
    })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: messages,
      messageId: "a1",
      mode: "direct",
    })
    expect(child.workingSet).toEqual(historical)
    await mutateSessionWorkingSet({
      sessionId: child.id,
      expectedRevision: 1,
      action: "remove",
      entryId: "choice",
    })
    expect((await getDb().messages.get("a1"))?.workingSetSnapshot).toEqual(historical)
    const current = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: messages,
      messageId: "a1",
      mode: "summary",
      summaryText: "Summary",
      workingSetPolicy: "current",
    })
    expect(current.workingSet?.revision).toBe(2)
    expect(current.workingSet?.entries).toEqual([])
    const fresh = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: messages,
      messageId: "a1",
      mode: "direct",
      workingSetPolicy: "initial",
    })
    expect(fresh.workingSet?.revision).toBe(0)
  })

  it("rejects unavailable historical state rather than silently copying current state", async () => {
    await seedSource()
    await mutateSessionWorkingSet({
      sessionId: "src1",
      expectedRevision: 0,
      action: "upsert",
      entry: { kind: "fact", summary: "Legacy state", origin: "user" },
    })
    await expect(
      branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "a1",
        mode: "direct",
      })
    ).rejects.toThrow(/historical working set/i)
    expect(await getDb().sessions.count()).toBe(1)
  })

  it("uses the last selected historical boundary and preserves earlier snapshots in a branch of a branch", async () => {
    await seedSource()
    const messages = visible()
    await persistMessages("src1", messages.slice(0, 2))
    const first = await mutateSessionWorkingSet({
      sessionId: "src1",
      expectedRevision: 0,
      action: "upsert",
      entry: { id: "choice", kind: "decision", summary: "First decision", origin: "user" },
    })
    await persistMessages("src1", messages)
    await mutateSessionWorkingSet({
      sessionId: "src1",
      expectedRevision: 1,
      action: "remove",
      entryId: "choice",
    })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: messages,
      messageId: "a2",
      pickedMessageIds: ["u1", "a1"],
      mode: "direct",
    })
    expect(child.workingSet).toEqual(first)
    const copied = await listMessages(child.id)
    expect((await getDb().messages.get(copied[0].id))?.workingSetSnapshot?.revision).toBe(0)
    await persistMessages(
      child.id,
      copied.map((message) => ({ ...message }))
    )
    const grandchild = await branchSessionAtMessage({
      sourceId: child.id,
      visibleMessages: copied,
      messageId: copied[0].id,
      mode: "direct",
    })
    expect(grandchild.workingSet?.revision).toBe(0)
    expect(grandchild.workingSet?.entries).toEqual([])
  })

  it.each(["current", "initial"] as const)(
    "records the %s policy at a summary branch's new boundary",
    async (workingSetPolicy) => {
      await seedSource()
      const messages = visible()
      await persistMessages("src1", messages)
      const state = await mutateSessionWorkingSet({
        sessionId: "src1",
        expectedRevision: 0,
        action: "upsert",
        entry: { kind: "fact", summary: "Current state", origin: "user" },
      })
      const child = await branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: messages,
        messageId: "a1",
        mode: "summary",
        summaryText: "A summary",
        workingSetPolicy,
      })
      const copied = await listMessages(child.id)
      const expectedRevision = workingSetPolicy === "current" ? state.revision : 0
      expect(child.workingSet?.revision).toBe(expectedRevision)
      expect((await getDb().messages.get(copied[0].id))?.workingSetSnapshot).toEqual(
        child.workingSet
      )
      const grandchild = await branchSessionAtMessage({
        sourceId: child.id,
        visibleMessages: copied,
        messageId: copied[0].id,
        mode: "direct",
      })
      expect(grandchild.workingSet).toEqual(child.workingSet)
    }
  )

  it("removes the child and copied transcript if restoring its historical snapshots fails", async () => {
    await seedSource()
    const messages = visible()
    await persistMessages("src1", messages)
    const update = jest
      .spyOn(getDb().messages, "update")
      .mockRejectedValueOnce(new Error("snapshot write failed"))
    try {
      await expect(
        branchSessionAtMessage({
          sourceId: "src1",
          visibleMessages: messages,
          messageId: "a1",
          mode: "direct",
        })
      ).rejects.toThrow("snapshot write failed")
    } finally {
      update.mockRestore()
    }
    expect((await getDb().sessions.toArray()).map((session) => session.id)).toEqual(["src1"])
    expect(
      (await getDb().messages.toArray()).every((message) => message.sessionId === "src1")
    ).toBe(true)
    expect(await listMessages("src1")).toHaveLength(4)
  })
})

describe("renderTranscript", () => {
  it("labels roles and skips empty turns", () => {
    const empty = { id: "x", role: "assistant", parts: [{ type: "tool" }] } as unknown as UIMessage
    expect(renderTranscript([uiMsg("u", "user", "hi"), empty])).toBe("User: hi")
  })
})

describe("branchSessionAtMessage — validation", () => {
  it("throws when the source session is missing", async () => {
    await expect(
      branchSessionAtMessage({
        sourceId: "nope",
        visibleMessages: [],
        messageId: "x",
        mode: "direct",
      })
    ).rejects.toThrow(/not found/)
  })

  it("throws when the cut-off message is not visible", async () => {
    await seedSource()
    await expect(
      branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "ghost",
        mode: "direct",
      })
    ).rejects.toThrow(/not in the visible thread/)
  })

  it("throws when summary mode has no summary text", async () => {
    await seedSource()
    await expect(
      branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "a2",
        mode: "summary",
      })
    ).rejects.toThrow(/requires summaryText/)
  })
})

describe("branchTitle", () => {
  it("does not stack suffixes when branching a branch", () => {
    expect(branchTitle("Refactor plan")).toBe("Refactor plan (branch)")
    expect(branchTitle("Refactor plan (branch)")).toBe("Refactor plan (branch 2)")
    expect(branchTitle("Refactor plan (branch 2)")).toBe("Refactor plan (branch 3)")
  })

  it("leaves a title that merely mentions the word alone", () => {
    expect(branchTitle("How to branch in git")).toBe("How to branch in git (branch)")
  })
})

describe("renderBranchSeed", () => {
  // `branchSeed.content` is the one seed stored on a `sessions` ROW, which the
  // sidebar reads in full on every render via `listScopedSessions().toArray()`.
  // Unbounded, a mid-conversation branch of a long thread wrote a multi-megabyte
  // string onto the sidebar's hot path.
  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => uiMsg(`m${i}`, "user", "x".repeat(500)))

  it("passes a short thread through untouched", () => {
    const { content, truncated } = renderBranchSeed(visible())
    expect(truncated).toBe(false)
    expect(content).toContain("first question")
  })

  it("trims from the OLDEST end so the turns nearest the branch point survive", () => {
    const messages = [
      uiMsg("old", "user", "y".repeat(30_000)),
      uiMsg("recent", "assistant", "the answer just before the branch"),
    ]
    const { content, truncated } = renderBranchSeed(messages)
    expect(truncated).toBe(true)
    expect(content).toContain("the answer just before the branch")
    expect(content.length).toBeLessThanOrEqual(BRANCH_SEED_MAX_CHARS)
  })

  it("drops whole messages rather than cutting one mid-sentence", () => {
    const { content } = renderBranchSeed(long(200))
    expect(content.length).toBeLessThanOrEqual(BRANCH_SEED_MAX_CHARS)
    // Every surviving line is a complete rendered turn.
    for (const line of content.split("\n\n")) expect(line.startsWith("User: ")).toBe(true)
  })

  it("truncates a single over-budget message rather than dropping it", () => {
    const { content, truncated } = renderBranchSeed([uiMsg("only", "user", "z".repeat(40_000))])
    expect(truncated).toBe(true)
    expect(content.length).toBe(BRANCH_SEED_MAX_CHARS)
  })
})

describe("branchSessionAtMessage — embedded sources", () => {
  // Branching a sidechat used to mint a `resource-workbench` row with no
  // `visibility` and no `surfaceBinding` — filtered out of the conversation
  // rail, global search, plugin enumeration and export by `isEmbeddedSession`,
  // and renderable by no workbench because nothing bound it. A ghost row.
  it.each(["resource-workbench", "subagent", "workflow-editor"] as const)(
    "normalises a %s parent into a standalone conversation",
    async (kind) => {
      await seedSource({
        kind,
        visibility: "embedded",
        surfaceBinding: { kind: "session", sessionId: "main-1" },
        surfaceBindingKey: "session:main-1",
      })
      const child = await branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "a1",
        mode: "direct",
      })

      expect(child.kind).toBe("direct")
      expect(child.visibility).toBeUndefined()
      expect(child.surfaceBinding).toBeUndefined()
      expect(child.surfaceBindingKey).toBeUndefined()
    }
  )

  it("leaves a team parent's kind alone", async () => {
    await seedSource({ kind: "team", teamId: "t1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.kind).toBe("team")
    expect(child.teamId).toBe("t1")
  })

  it("carries the parent's Squad binding onto the branch", async () => {
    // A branch continues the same conversation, so it continues to run on the
    // same executor. Dropping this would silently demote the branch to the
    // default executor with nothing on screen to say so.
    await seedSource({ squadId: "squad-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.squadId).toBe("squad-1")
  })

  it("leaves the Squad binding absent when the parent has none", async () => {
    await seedSource({})
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.squadId).toBeUndefined()
  })
})

describe("branchSessionAtMessage — workspace scoping", () => {
  // A branch written without a projectId is not merely mis-scoped: the sidebar
  // reads `[projectId+updatedAt]`, and Dexie omits any row whose key path
  // contains `undefined` from a compound index — so the branch was absent
  // entirely, from the first reload onward.
  // That the stamped row is actually reachable through `[projectId+updatedAt]`
  // is proven end-to-end against the production schema in
  // `lib/db/schema.test.ts` ("v131 upgrade rescues orphaned branch + sidechat
  // rows into the scoped index"); repeating the range query here only re-pays
  // the full-schema open this suite already does per test.
  it("inherits the parent's workspace", async () => {
    await seedSource({ projectId: "proj-parent" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })

    expect(child.projectId).toBe("proj-parent")
    expect((await getDb().sessions.get(child.id))?.projectId).toBe("proj-parent")
  })

  it("copies the parent's workspace even when another one is active", async () => {
    // Branching a conversation that lives in another workspace files the branch
    // beside its parent, not wherever the UI happens to be pointing.
    await getDb().settings.put({ id: "singleton", activeProjectId: "proj-elsewhere" } as never)
    await seedSource({ projectId: "proj-parent" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.projectId).toBe("proj-parent")
  })

  it("falls back to the active workspace when the parent predates the v131 backfill", async () => {
    await getDb().settings.put({ id: "singleton", activeProjectId: "proj-active" } as never)
    await seedSource({ projectId: undefined })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.projectId).toBe("proj-active")
  })
})

describe("branchSessionAtMessage — direct", () => {
  it("copies the truncated thread and inherits config + lineage", async () => {
    await seedSource()
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.id).not.toBe("src1")
    expect(child.parentSessionId).toBe("src1")
    expect(child.branchedFromMessageId).toBe("a1")
    expect(child.branchKind).toBe("direct")
    expect(child.model).toBe("claude-x")
    expect(child.systemPrompt).toBe("be nice")
    expect(child.messageDisplayOverride).toEqual({ preset: "inspector" })
    expect(child.title).toBe("Original (branch)")

    const msgs = await listMessages(child.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    // Fresh ids, not the source ids.
    expect(msgs.map((m) => m.id)).not.toContain("u1")
  })

  it("carries the parent's sandbox tier so isolation cannot silently drop", async () => {
    // Regression. `buildChildRow` carried `sandboxEnabled` and
    // `computerUseTarget` but not `sandboxTier`, so a child of a `microvm`
    // conversation re-resolved its tier from `AppSettings.sandboxTier` at send
    // time and could quietly run on `os`. Asserted on the field directly, not
    // through a partial `toMatchObject` — a missing column is invisible to one.
    await seedSource({ sandboxEnabled: true, sandboxTier: "microvm" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.sandboxTier).toBe("microvm")
    expect(child.sandboxEnabled).toBe(true)
  })

  it("keeps each agent's model choice but never the parent's gateway tasks", async () => {
    // A task's native history belongs to one conversation: two rows resuming
    // it would interleave two threads, and deleting either would delete both.
    const externalAgentModels = {
      kimi: {
        kind: "cognia" as const,
        binding: { providerId: "plugin:kimi:subscription", modelId: "kimi-k3" },
      },
      codex: { kind: "native" as const, modelId: "gpt-5.5" },
    }
    const link = { agentId: "kimi", sessionId: "cognia-gateway:task-1:native" }
    await seedSource({
      externalAgentModels,
      externalAgentSession: link,
      externalAgentGatewaySessions: [link],
    })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(child.externalAgentModels).toEqual(externalAgentModels)
    expect(child.externalAgentSession).toBeUndefined()
    expect(child.externalAgentGatewaySessions).toBeUndefined()
  })

  it("mid-conversation branch stores a transcript seed and does not SDK-fork", async () => {
    await seedSource({ sdkSessionId: "sdk-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1", // not the tail
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.kind).toBe("transcript")
    expect(child.branchSeed?.content).toContain("User: first question")
    expect(child.branchSeed?.content).toContain("Assistant: first answer")
  })

  it("tail branch with an SDK session uses SDK fork instead of a seed", async () => {
    await seedSource({
      sdkSessionId: "sdk-1",
      sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
    })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2", // tail
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBe("sdk-1")
    expect(child.sdkSessionStorage).toEqual({ backend: "host-sqlite", workspace: "/original" })
    expect(child.branchSeed).toBeUndefined()
  })

  it("tail branch without an SDK session falls back to a transcript seed", async () => {
    await seedSource() // no sdkSessionId
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2",
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.kind).toBe("transcript")
  })

  it("does not fork retained SDK history after a destructive transcript mutation", async () => {
    await seedSource({ sdkSessionId: "stale-sdk", runtimeTranscriptInvalidated: "changed" })
    const messages = visible()
    await persistMessages("src1", messages)
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: messages,
      messageId: "a2",
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.content).toContain("second answer")
    expect(child.runtimeTranscriptInvalidated).toBeUndefined()
  })

  it("rebuilds the selected sibling instead of forking the runtime's later alternative", async () => {
    await seedSource({ sdkSessionId: "latest-sdk", activeBranchByGroup: { answer: "selected" } })
    const question = uiMsg("question", "user", "Question")
    const selected = uiMsg("selected", "assistant", "Selected answer", {
      branchGroupId: "answer",
      branchIndex: 0,
    })
    const later = uiMsg("later", "assistant", "Hidden later answer", {
      branchGroupId: "answer",
      branchIndex: 1,
    })
    await persistMessages("src1", [question, selected, later])
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: [question, selected],
      messageId: "selected",
      mode: "direct",
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.content).toContain("Selected answer")
    expect(child.branchSeed?.content).not.toContain("Hidden later answer")
  })

  it("strips regeneration-branch metadata from the copied messages", async () => {
    await seedSource()
    const withBranch: UIMessage[] = [
      uiMsg("u1", "user", "q"),
      uiMsg("a1", "assistant", "ans", {
        branchGroupId: "g",
        branchIndex: 1,
        branchOwnerId: "u1",
        senderId: "c1",
      }),
    ]
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: withBranch,
      messageId: "a1",
      mode: "direct",
    })
    const msgs = await listMessages(child.id)
    const meta = msgs[1].metadata as Record<string, unknown> | undefined
    expect(meta?.branchGroupId).toBeUndefined()
    expect(meta?.branchIndex).toBeUndefined()
    expect(meta?.branchOwnerId).toBeUndefined()
    // senderId is preserved (round-trips via the messages column).
    expect(meta?.senderId).toBe("c1")
  })
})

describe("branchSessionAtMessage — summary", () => {
  it("seeds a single summary message and a summary branchSeed", async () => {
    await seedSource({ sdkSessionId: "sdk-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2",
      mode: "summary",
      summaryText: "We discussed two questions.",
    })
    expect(child.branchKind).toBe("summary")
    // Summary branches never SDK-fork (context is the summary).
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed).toEqual({ kind: "summary", content: "We discussed two questions." })

    const msgs = await listMessages(child.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("assistant")
    expect((msgs[0].metadata as Record<string, unknown>).branchSummary).toBe(true)
  })
})

describe("branchSessionAtMessage — cherry-pick", () => {
  it("carries only the selected messages", async () => {
    await seedSource()
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2",
      mode: "direct",
      pickedMessageIds: ["a1", "a2"],
    })
    const msgs = await listMessages(child.id)
    expect(msgs).toHaveLength(2)
    expect(msgs.map((m) => extractPlainText(m.parts))).toEqual(["first answer", "second answer"])
  })

  it("cannot smuggle in content from after the branch point", async () => {
    // Ids outside the kept prefix are ignored — a selection is a narrowing of
    // the prefix, never a widening of it.
    await seedSource()
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "u2",
      mode: "direct",
      pickedMessageIds: ["u1", "a2"],
    })
    const msgs = await listMessages(child.id)
    expect(msgs.map((m) => extractPlainText(m.parts))).toEqual(["first question"])
  })

  it("never reuses the SDK fork, even when the cut-off is the tail", async () => {
    // The fork reproduces the parent's context in FULL — the opposite of a
    // cherry-pick. The child would show two messages while the model
    // remembered everything.
    await seedSource({ sdkSessionId: "sdk-1" })
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a2",
      mode: "direct",
      pickedMessageIds: ["u1", "a2"],
    })
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    expect(child.branchSeed?.kind).toBe("transcript")
    // The seed reflects the SELECTION, not the whole prefix.
    expect(child.branchSeed?.content).toContain("first question")
    expect(child.branchSeed?.content).not.toContain("first answer")
  })

  it("rejects a selection that keeps nothing", async () => {
    await seedSource()
    await expect(
      branchSessionAtMessage({
        sourceId: "src1",
        visibleMessages: visible(),
        messageId: "a2",
        mode: "direct",
        pickedMessageIds: ["nope"],
      })
    ).rejects.toThrow(/nothing selected/)
  })

  it("falls back to the whole prefix when no selection is given", async () => {
    await seedSource()
    const child = await branchSessionAtMessage({
      sourceId: "src1",
      visibleMessages: visible(),
      messageId: "a1",
      mode: "direct",
    })
    expect(await listMessages(child.id)).toHaveLength(2)
  })
})

describe("complete host branch snapshots", () => {
  it("copies authoritative domain state and each historical boundary without changing the mirror", async () => {
    const mirror = await seedSource()
    await persistMessages(mirror.id, [uiMsg("a2", "assistant", "mirror tail")])
    const originalMirror = await getDb().sessions.get(mirror.id)
    const first = { ...emptyWorkingSet(), revision: 1, updatedAt: 1 }
    const current = { ...emptyWorkingSet(), revision: 2, updatedAt: 2 }
    const messages = visible().map((message, index) => ({
      id: message.id,
      sessionId: mirror.id,
      role: message.role,
      parts: message.parts,
      createdAt: index + 1,
      workingSetSnapshot: first,
    }))
    const session = {
      ...mirror,
      sdkSessionId: "host-sdk",
      workingSet: current,
      title: "Host title",
    }
    const sourceSnapshot = { session, messages, assertCurrent: jest.fn() }
    const child = await branchSessionAtMessage({
      sourceId: mirror.id,
      visibleMessages: messages.map(rowToUIMessage),
      messageId: "a2",
      mode: "direct",
      workingSetPolicy: "current",
      sourceSnapshot,
    })
    expect(child.workingSet).toEqual(current)
    expect(child.title).toBe("Host title (branch)")
    expect(child.forkedFromSdkSessionId).toBeUndefined()
    const copied = await getDb().messages.where("sessionId").equals(child.id).sortBy("createdAt")
    expect(copied).toHaveLength(4)
    expect(copied[0].workingSetSnapshot).toEqual(first)
    expect(copied[3].workingSetSnapshot).toEqual(current)
    expect(await getDb().sessions.get(mirror.id)).toEqual(originalMirror)
    expect(await listMessages(mirror.id)).toHaveLength(1)
  })

  it("rejects a source snapshot that does not include the requested visible rows", async () => {
    const source = await seedSource()
    await expect(
      branchSessionAtMessage({
        sourceId: source.id,
        visibleMessages: visible(),
        messageId: "a2",
        mode: "direct",
        workingSetPolicy: "current",
        sourceSnapshot: { session: source, messages: [], assertCurrent: jest.fn() },
      })
    ).rejects.toThrow("incomplete source snapshot")
    expect(await getDb().sessions.count()).toBe(1)
  })
})
