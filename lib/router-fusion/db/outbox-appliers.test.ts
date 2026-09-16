/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
} from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import { createSession, getSession } from "@/lib/db/sessions"

import type { OutboxContext } from "./outbox"
import { accountDatabaseAppliers, usageRowFromOutbox } from "./outbox-appliers"
import { answerMessageId, inputMessageId } from "./session-transcript"
import type { FusionOutboxRow } from "./types"

/** The effects these appliers write read no content. */
const NO_ARTIFACTS: OutboxContext = {
  readArtifact: async () => {
    throw new Error("unexpected artifact read")
  },
}

function usageEffect(overrides: Record<string, unknown> = {}): FusionOutboxRow {
  return {
    effectId: "usage:attempt-1",
    runId: "run-1",
    kind: "usage_row",
    payload: {
      runId: "run-1",
      attemptId: "attempt-1",
      origin: "utility",
      sessionId: null,
      deploymentId: "openai:gpt-5-mini",
      providerId: "openai",
      modelId: "gpt-5-mini",
      costMicrousd: 12_345,
      costStatus: "actual",
      usage: {
        input_uncached_tokens: 900,
        input_cache_read_tokens: 100,
        input_cache_write_5m_tokens: 0,
        input_cache_write_1h_tokens: 0,
        output_tokens: 300,
        reasoning_tokens: 50,
        reasoning_included_in_output: true,
      },
      settledAt: 1_700_000_000_000,
      ...overrides,
    },
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: 1,
    appliedAt: null,
  }
}

describe("account database outbox appliers", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("maps a settled call onto one ledger-costed usage row", () => {
    expect(usageRowFromOutbox(usageEffect())).toMatchObject({
      messageId: "rf:run-1:attempt-1",
      sessionId: "rf:run-1",
      providerId: "openai",
      model: "gpt-5-mini",
      inputTokens: 1000,
      cacheReadTokens: 100,
      outputTokens: 300,
      reasoningTokens: 50,
      costUsd: 0.012345,
      costSource: "ledger",
      costKnown: true,
      surface: "memory",
    })
    // Reasoning reported beside output is added to it, never double counted.
    const beside = usageEffect({
      usage: { output_tokens: 300, reasoning_tokens: 50, reasoning_included_in_output: false },
    })
    expect(usageRowFromOutbox(beside)?.outputTokens).toBe(350)
  })

  it("[ACC:ISO-05] writes the usage row once however often the effect is replayed", async () => {
    await accountDatabaseAppliers.usage_row(usageEffect(), NO_ARTIFACTS)
    await accountDatabaseAppliers.usage_row(usageEffect(), NO_ARTIFACTS)
    const rows = await getDb().sessionUsage.where("sessionId").equals("rf:run-1").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].costUsd).toBeCloseTo(0.012345)
  })

  it("annotates a live execution run once and skips a missing or sealed one", async () => {
    const milestone: FusionOutboxRow = {
      ...usageEffect(),
      effectId: "milestone:run-1:terminal",
      kind: "execution_run_milestone",
      payload: {
        runId: "run-1",
        status: "succeeded",
        actionId: "direct_baseline",
        mode: "direct",
        spentMicrousd: 10,
      },
    }
    expect(await accountDatabaseAppliers.execution_run_milestone(milestone, NO_ARTIFACTS)).toBe(
      "skipped"
    )
    await createExecutionRun({
      id: "run-1",
      kind: "agent-turn",
      sourceId: "run-1",
      title: "Chat run",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    expect(await accountDatabaseAppliers.execution_run_milestone(milestone, NO_ARTIFACTS)).toBe(
      "applied"
    )
    expect(await accountDatabaseAppliers.execution_run_milestone(milestone, NO_ARTIFACTS)).toBe(
      "applied"
    )
    const events = await listExecutionRunEvents("run-1")
    expect(events.filter((e) => e.type === "milestone.created")).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ routerFusion: { actionId: "direct_baseline" } })
  })

  describe("session messages", () => {
    const artifacts: OutboxContext = {
      readArtifact: async (id) =>
        id === "input"
          ? JSON.stringify([{ role: "user", content: "what changed in 2025?" }])
          : id === "answer"
            ? "Tariffs rose to 4%."
            : null,
    }
    function sessionEffect(sessionId: string, payload: Record<string, unknown>): FusionOutboxRow {
      return {
        ...usageEffect(),
        effectId: `session:run-5:${String(payload.phase)}`,
        runId: "run-5",
        kind: "session_message",
        payload: { runId: "run-5", sessionId, ...payload },
      }
    }

    it("writes a gateway run's conversation into its session and moves the version once per write", async () => {
      const session = await createSession({
        title: "Gateway run",
        origin: { kind: "gateway-api", keyId: "key-a", keyName: "CI robot" },
      })
      const before = (await getSession(session.id))?.transcriptRevision ?? 0
      const input = sessionEffect(session.id, {
        phase: "input",
        inputArtifactId: "input",
        actorKeyName: "CI robot",
      })
      expect(await accountDatabaseAppliers.session_message(input, artifacts)).toBe("applied")
      expect(await accountDatabaseAppliers.session_message(input, artifacts)).toBe("skipped")
      const answer = sessionEffect(session.id, {
        phase: "answer",
        answerArtifactId: "answer",
        mode: "cascade",
      })
      expect(await accountDatabaseAppliers.session_message(answer, artifacts)).toBe("applied")

      const rows = await getDb().messages.where("sessionId").equals(session.id).sortBy("createdAt")
      expect(rows.map((row) => [row.id, row.role])).toEqual([
        [inputMessageId("run-5", 0), "user"],
        [answerMessageId("run-5"), "assistant"],
      ])
      expect(rows[1].parts).toEqual([{ type: "text", text: "Tariffs rose to 4%." }])
      expect((await getSession(session.id))?.transcriptRevision).toBe(before + 2)
    })
  })

  describe("execution run projection", () => {
    function projection(phase: string, extra: Record<string, unknown> = {}): FusionOutboxRow {
      return {
        ...usageEffect(),
        effectId: `projection:run-9:${phase}`,
        runId: "run-9",
        kind: "execution_run_projection",
        payload: {
          runId: "run-9",
          phase,
          origin: "gateway-api",
          title: "Summarise the release notes",
          sessionId: "session-9",
          actorKeyId: "key-a",
          actorKeyName: "CI robot",
          mode: "direct",
          actionId: "direct_baseline",
          createdAt: 1_700_000_000_000,
          ...extra,
        },
      }
    }

    it("creates the cockpit's run for work no local engine started", async () => {
      expect(
        await accountDatabaseAppliers.execution_run_projection(projection("queued"), NO_ARTIFACTS)
      ).toBe("applied")
      const run = await getExecutionRun("run-9")
      expect(run).toMatchObject({
        kind: "fusion",
        sourceId: "run-9",
        sessionId: "session-9",
        title: "Summarise the release notes",
        status: "queued",
        origin: "gateway-api",
        originActor: { keyId: "key-a", keyName: "CI robot" },
      })
      // No local engine wrote this run, so its whole history is these effects.
      expect(await listExecutionRunEvents("run-9")).toHaveLength(0)
    })

    it("advances it through the journal, exactly once per replayed effect", async () => {
      await accountDatabaseAppliers.execution_run_projection(projection("queued"), NO_ARTIFACTS)
      await accountDatabaseAppliers.execution_run_projection(projection("running"), NO_ARTIFACTS)
      await accountDatabaseAppliers.execution_run_projection(projection("running"), NO_ARTIFACTS)
      await accountDatabaseAppliers.execution_run_projection(
        projection("terminal", { status: "succeeded" }),
        NO_ARTIFACTS
      )
      const events = await listExecutionRunEvents("run-9")
      expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"])
      expect((await getExecutionRun("run-9"))?.status).toBe("completed")
    })

    it("names the failure code the ledger recorded", async () => {
      await accountDatabaseAppliers.execution_run_projection(projection("queued"), NO_ARTIFACTS)
      await accountDatabaseAppliers.execution_run_projection(
        projection("terminal", { status: "failed", errorCode: "BUDGET_EXCEEDED" }),
        NO_ARTIFACTS
      )
      const events = await listExecutionRunEvents("run-9")
      expect(events[0].type).toBe("run.failed")
      expect(events[0].payload).toMatchObject({
        routerFusion: { errorCode: "BUDGET_EXCEEDED", origin: "gateway-api" },
      })
    })

    it("skips an earlier phase that arrives after the run was sealed", async () => {
      // Two effects written in the same millisecond can drain out of order. A
      // sealed run refuses every further event, so retrying forever would be
      // the only other outcome.
      await accountDatabaseAppliers.execution_run_projection(
        projection("terminal", { status: "cancelled" }),
        NO_ARTIFACTS
      )
      expect(
        await accountDatabaseAppliers.execution_run_projection(projection("running"), NO_ARTIFACTS)
      ).toBe("skipped")
      expect((await getExecutionRun("run-9"))?.status).toBe("cancelled")
    })
  })
})
