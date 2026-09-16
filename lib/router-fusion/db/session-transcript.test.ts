import type { ChatSession } from "@cognia/agent-config-types"

import type { OutboxContext } from "./outbox"
import {
  answerMessageId,
  applySessionMessage,
  inputMessageId,
  type SessionTranscriptDeps,
  type TranscriptMessage,
} from "./session-transcript"
import type { FusionOutboxRow } from "./types"

const INPUT = JSON.stringify([
  { role: "user", content: "first question" },
  { role: "user", content: "and a detail" },
])

function effect(payload: Record<string, unknown>): FusionOutboxRow {
  return {
    effectId: `session:run-1:${String(payload.phase)}`,
    runId: "run-1",
    kind: "session_message",
    payload: { runId: "run-1", sessionId: "s1", ...payload },
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: 1,
    appliedAt: null,
  }
}

function world(artifacts: Record<string, string> = { input: INPUT, answer: "the answer" }) {
  const rows = new Map<string, TranscriptMessage>()
  const commits: Array<{ sessionId: string; upserts: TranscriptMessage[] }> = []
  let sessionExists = true
  const deps: SessionTranscriptDeps = {
    getSession: async (id) => (sessionExists ? ({ id } as ChatSession) : undefined),
    getMessages: async (ids) => ids.map((id) => rows.get(id)),
    commit: async (sessionId, upserts) => {
      commits.push({ sessionId, upserts })
      for (const row of upserts) rows.set(row.id, row)
    },
  }
  const context: OutboxContext = { readArtifact: async (id) => artifacts[id] ?? null }
  return {
    deps,
    context,
    rows,
    commits,
    dropSession: () => {
      sessionExists = false
    },
  }
}

describe("applySessionMessage", () => {
  it("appends the caller's input as user turns that trigger none of the app's workflows", async () => {
    const w = world()
    const outcome = await applySessionMessage(
      effect({ phase: "input", inputArtifactId: "input", actorKeyName: "CI robot" }),
      w.context,
      w.deps
    )
    expect(outcome).toBe("applied")
    expect(w.commits).toHaveLength(1)
    expect(w.commits[0].sessionId).toBe("s1")
    expect(w.commits[0].upserts).toEqual([
      {
        id: inputMessageId("run-1", 0),
        role: "user",
        parts: [{ type: "text", text: "first question" }],
        metadata: {
          triggerWorkflows: false,
          routerFusion: { runId: "run-1", origin: "gateway-api", keyName: "CI robot" },
        },
      },
      expect.objectContaining({ id: inputMessageId("run-1", 1) }),
    ])
  })

  it("changes nothing on a replay, so the session version does not move", async () => {
    const w = world()
    const row = effect({ phase: "input", inputArtifactId: "input" })
    await applySessionMessage(row, w.context, w.deps)
    await expect(applySessionMessage(row, w.context, w.deps)).resolves.toBe("skipped")
    expect(w.commits).toHaveLength(1)
  })

  it("appends the verified answer as one assistant turn", async () => {
    const w = world()
    await expect(
      applySessionMessage(
        effect({ phase: "answer", answerArtifactId: "answer", mode: "panel" }),
        w.context,
        w.deps
      )
    ).resolves.toBe("applied")
    expect(w.rows.get(answerMessageId("run-1"))).toEqual({
      id: answerMessageId("run-1"),
      role: "assistant",
      parts: [{ type: "text", text: "the answer" }],
      metadata: { routerFusion: { runId: "run-1", mode: "panel" } },
    })
  })

  it("puts a chat fusion turn's run card summary where the message shell reads it", async () => {
    const w = world()
    const summary = {
      runId: "run-1",
      mode: "panel" as const,
      actionId: "panel_review",
      ruleId: "R1_explicit_mode",
      status: "succeeded",
      qualityStatus: "accepted",
      roles: { judge: "openai::gpt-5" },
      capMicrousd: 2_000_000,
      spentMicrousd: 1234,
      modelCalls: 5,
      costStatus: "actual",
      errorCode: null,
      timeline: {
        phases: [],
        calls: { started: 5, finished: 5, unknown: 0 },
        candidates: { members: 2, rejected: 0, evidenceRejected: 0 },
        judge: null,
        escalated: null,
        degraded: null,
        verification: { status: "passed", level: "mixed" },
        compactions: 0,
      },
    }
    await applySessionMessage(
      effect({
        phase: "answer",
        answerArtifactId: "answer",
        mode: "panel",
        origin: "chat",
        summary,
      }),
      w.context,
      w.deps
    )
    expect(w.rows.get(answerMessageId("run-1"))?.metadata).toEqual({
      routerFusion: { runId: "run-1", mode: "panel", origin: "chat" },
      run: { routerFusion: { fusion: summary } },
    })
  })

  it("marks a failed run's input and writes no answer for it", async () => {
    const w = world()
    await applySessionMessage(
      effect({ phase: "input", inputArtifactId: "input" }),
      w.context,
      w.deps
    )
    await expect(
      applySessionMessage(
        effect({
          phase: "marker",
          inputArtifactId: "input",
          status: "failed",
          errorCode: "VERIFICATION_FAILED",
        }),
        w.context,
        w.deps
      )
    ).resolves.toBe("applied")
    expect(w.rows.get(inputMessageId("run-1", 0))?.metadata.routerFusion).toMatchObject({
      runStatus: "failed",
      errorCode: "VERIFICATION_FAILED",
    })
    expect(w.rows.has(answerMessageId("run-1"))).toBe(false)
    expect([...w.rows.values()].every((row) => row.role === "user")).toBe(true)
  })

  it("never lets a late input effect wipe the marker", async () => {
    const w = world()
    await applySessionMessage(
      effect({ phase: "marker", inputArtifactId: "input", status: "cancelled" }),
      w.context,
      w.deps
    )
    await expect(
      applySessionMessage(effect({ phase: "input", inputArtifactId: "input" }), w.context, w.deps)
    ).resolves.toBe("skipped")
    expect(w.rows.get(inputMessageId("run-1", 0))?.metadata.routerFusion).toMatchObject({
      runStatus: "cancelled",
    })
  })

  it("skips a session the person deleted, and content whose window has passed", async () => {
    const gone = world()
    gone.dropSession()
    await expect(
      applySessionMessage(
        effect({ phase: "input", inputArtifactId: "input" }),
        gone.context,
        gone.deps
      )
    ).resolves.toBe("skipped")

    const expired = world({})
    await expect(
      applySessionMessage(
        effect({ phase: "answer", answerArtifactId: "answer" }),
        expired.context,
        expired.deps
      )
    ).resolves.toBe("skipped")
    await expect(
      applySessionMessage(
        effect({ phase: "input", inputArtifactId: "input" }),
        expired.context,
        expired.deps
      )
    ).resolves.toBe("skipped")
    expect(expired.commits).toEqual([])
  })

  it("skips a payload it cannot read rather than guessing", async () => {
    const w = world({ input: "not json", other: JSON.stringify({ role: "user" }) })
    for (const payload of [
      { phase: "input", inputArtifactId: "input" },
      { phase: "input", inputArtifactId: "other" },
      { phase: "teleport" },
      { phase: "input", inputArtifactId: "input", sessionId: "" },
    ]) {
      await expect(applySessionMessage(effect(payload), w.context, w.deps)).resolves.toBe("skipped")
    }
    expect(w.commits).toEqual([])
  })

  it("leaves an effect pending when the drain cannot read artifacts at all", async () => {
    const w = world()
    const blind: OutboxContext = {
      readArtifact: async () => {
        throw new Error("no artifact reader")
      },
    }
    await expect(
      applySessionMessage(effect({ phase: "input", inputArtifactId: "input" }), blind, w.deps)
    ).rejects.toThrow("no artifact reader")
  })
})
