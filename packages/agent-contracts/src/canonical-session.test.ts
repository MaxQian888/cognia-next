import {
  computeSequenceDigest,
  fidelityRank,
  isCanonicalSession,
  SESSION_FIDELITY_LEVELS,
  validateCanonicalSession,
  type CanonicalSession,
  type CanonicalTurn,
} from "./canonical-session"

function turns(): CanonicalTurn[] {
  return [
    { turnId: "t1", role: "user", text: "hello" },
    {
      turnId: "t2",
      role: "assistant",
      text: "hi",
      toolCalls: [{ callId: "c1", toolName: "Read", resultText: "ok" }],
    },
  ]
}

function validSession(): CanonicalSession {
  const seq = turns()
  return {
    header: {
      canonicalVersion: 1,
      canonicalSessionId: "cs-1",
      sourceRuntime: "claude-code",
      runtimeBinding: { nativeSessionId: "sdk-abc" },
      title: "T",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:01.000Z",
      turnCount: seq.length,
      importFidelity: "structured",
      sequenceDigest: computeSequenceDigest(seq),
    },
    turns: seq,
    permissions: [{ requestId: "p1", toolName: "Bash", decision: "deny" }],
    checkpoints: [{ checkpointId: "cp1", afterTurnId: "t1" }],
  }
}

describe("fidelity scale", () => {
  it("ranks the five levels monotonically, native-exact highest", () => {
    const ranks = SESSION_FIDELITY_LEVELS.map(fidelityRank)
    expect(ranks).toEqual([4, 3, 2, 1, 0])
    expect(fidelityRank("native-exact")).toBeGreaterThan(fidelityRank("contextual"))
    expect(fidelityRank("unsupported")).toBe(0)
  })
})

describe("computeSequenceDigest", () => {
  it("is deterministic and content-sensitive, ignoring volatile fields", () => {
    const a = computeSequenceDigest(turns())
    const b = computeSequenceDigest(turns().map((t) => ({ ...t, at: "2099-01-01T00:00:00Z" })))
    expect(a).toBe(b)
    const mutated = turns()
    mutated[1].text = "different"
    expect(computeSequenceDigest(mutated)).not.toBe(a)
    const extraTool = turns()
    extraTool[1].toolCalls = [...(extraTool[1].toolCalls ?? []), { callId: "c2", toolName: "Edit" }]
    expect(computeSequenceDigest(extraTool)).not.toBe(a)
  })

  it("changes when structured tool results or rich content change", () => {
    const base = turns()
    base[1].toolCalls![0] = {
      ...base[1].toolCalls![0],
      status: "completed",
      resultText: "first",
    }
    const changed = structuredClone(base)
    changed[1].toolCalls![0].resultText = "second"
    expect(computeSequenceDigest(changed)).not.toBe(computeSequenceDigest(base))

    const withFile = structuredClone(base)
    withFile[1].parts = [
      {
        type: "file",
        name: "report.md",
        uri: "artifact://session/report.md",
        digest: "sha256:one",
      },
    ]
    const changedFile = structuredClone(withFile)
    changedFile[1].parts![0] = {
      type: "file",
      name: "report.md",
      uri: "artifact://session/report.md",
      digest: "sha256:two",
    }
    expect(computeSequenceDigest(changedFile)).not.toBe(computeSequenceDigest(withFile))
  })
})

describe("validateCanonicalSession", () => {
  it("accepts a fully-populated valid session", () => {
    expect(validateCanonicalSession(validSession())).toEqual([])
    expect(isCanonicalSession(validSession())).toBe(true)
  })

  it("accepts additive lineage, lifecycle, task, plan and recorded-event snapshots", () => {
    const rich = validSession()
    rich.header.runtimeBinding = {
      nativeSessionId: "sdk-abc",
      presetId: "claude-code",
      cwd: "/repo",
      resumeMethod: "protocol",
      verifiedAt: "2026-08-29T00:00:00.000Z",
    }
    rich.header.lineage = {
      kind: "background",
      parentCanonicalSessionId: "parent-1",
      parentNativeSessionId: "native-parent-1",
      parentToolCallId: "tool-1",
      taskId: "task-1",
      rootCanonicalSessionId: "root-1",
    }
    rich.header.lifecycle = {
      status: "waiting",
      background: true,
      startedAt: "2026-08-29T00:00:00.000Z",
    }
    rich.turns[1] = {
      ...rich.turns[1],
      reasoning: "checked the repository",
      model: "claude-opus-5",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, reasoningTokens: 1 },
      parts: [{ type: "custom", customType: "plan", summary: "Implement safely" }],
      toolCalls: [
        {
          callId: "c1",
          toolName: "Read",
          status: "completed",
          resultText: "ok",
          startedAt: "2026-08-29T00:00:01.000Z",
          endedAt: "2026-08-29T00:00:02.000Z",
          parentToolCallId: "parent-tool",
          taskId: "task-1",
          attachments: [{ type: "file", name: "result.txt", uri: "artifact://session/result.txt" }],
        },
      ],
    }
    rich.header.sequenceDigest = computeSequenceDigest(rich.turns)
    rich.tasks = [
      {
        taskId: "task-1",
        description: "Inspect current implementation",
        status: "waiting",
        background: true,
        dependencies: ["task-0"],
        childCanonicalSessionId: "child-1",
      },
    ]
    rich.plans = [{ planId: "plan-1", status: "active", steps: ["inspect", "implement"] }]
    rich.goals = [{ goalId: "goal-1", description: "Preserve history", status: "active" }]
    rich.history = [
      { historyId: "h-1", kind: "rewind", at: "2026-08-29T00:00:03.000Z", toTurnId: "t1" },
    ]
    rich.interAgentMessages = [
      {
        messageId: "iam-1",
        fromSessionId: "child-1",
        toSessionId: "parent-1",
        text: "done",
      },
    ]
    rich.recordedEvents = [
      {
        eventId: "event-1",
        sequence: 0,
        at: "2026-08-29T00:00:04.000Z",
        event: {
          kind: "task",
          phase: "updated",
          taskId: "task-1",
          status: "paused",
          backgrounded: true,
        },
      },
    ]

    expect(validateCanonicalSession(rich)).toEqual([])
  })

  it("rejects malformed additive lifecycle and relationship fields", () => {
    const bad = validSession()
    bad.header.lineage = { kind: "subagent", parentCanonicalSessionId: "" }
    bad.header.lifecycle = { status: "sleeping" as never }
    bad.tasks = [{ taskId: "", status: "running" }]
    bad.recordedEvents = [
      { eventId: "", sequence: -1, event: { kind: "task-inventory", tasks: [] } },
    ]

    expect(validateCanonicalSession(bad)).toEqual(
      expect.arrayContaining([
        "header.lineage.parentCanonicalSessionId must be non-empty when present",
        "header.lifecycle.status is invalid",
        "tasks[0].taskId is required",
        "recordedEvents[0].eventId is required",
        "recordedEvents[0].sequence must be a non-negative integer",
      ])
    )
  })

  it("rejects header/turn/permission violations with named errors", () => {
    expect(validateCanonicalSession(null)).toEqual(["canonical session must be an object"])
    const errors = validateCanonicalSession({ turns: "nope" })
    expect(errors).toEqual(expect.arrayContaining(["header is required", "turns must be an array"]))

    const bad = validSession()
    ;(bad.header as { importFidelity: string }).importFidelity = "perfect"
    ;(bad.turns[0] as { role: string }).role = "narrator"
    ;(bad.permissions![0] as { decision: string }).decision = "maybe"
    const badErrors = validateCanonicalSession(bad)
    expect(badErrors).toEqual(
      expect.arrayContaining([
        "header.importFidelity must be a known fidelity level",
        "turns[0].role is invalid",
        "permissions[0].decision is invalid",
      ])
    )
  })

  it("covers partial-header and malformed-turn edges", () => {
    const noDigest = validSession() as unknown as { header: Record<string, unknown> }
    delete noDigest.header.sequenceDigest
    expect(validateCanonicalSession(noDigest)).toContain("header.sequenceDigest is required")

    const noId = validSession() as unknown as { header: Record<string, unknown> }
    noId.header.canonicalSessionId = ""
    noId.header.sourceRuntime = ""
    expect(validateCanonicalSession(noId)).toEqual(
      expect.arrayContaining([
        "header.canonicalSessionId is required",
        "header.sourceRuntime is required",
      ])
    )

    const badTurn = validSession()
    ;(badTurn.turns[0] as { turnId: string }).turnId = ""
    ;(badTurn.turns[1] as { text: unknown }).text = 42
    expect(validateCanonicalSession(badTurn)).toEqual(
      expect.arrayContaining(["turns[0].turnId is required", "turns[1].text must be a string"])
    )

    const badPermission = validSession()
    ;(badPermission.permissions as unknown[]) = [null, { requestId: "" }]
    expect(validateCanonicalSession(badPermission)).toEqual(
      expect.arrayContaining([
        "permissions[0].requestId is required",
        "permissions[1].requestId is required",
      ])
    )
  })

  it("pins header integrity: turnCount and sequenceDigest must match the turns", () => {
    const wrongCount = validSession()
    wrongCount.header.turnCount = 99
    expect(validateCanonicalSession(wrongCount)).toContain(
      "header.turnCount disagrees with turns.length"
    )

    const tampered = validSession()
    tampered.turns[0].text = "tampered"
    expect(validateCanonicalSession(tampered)).toContain(
      "header.sequenceDigest disagrees with the turn sequence"
    )
  })
})
