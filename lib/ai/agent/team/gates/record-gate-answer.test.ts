import { recordSquadGateAnswer, type RecordGateAnswerDeps } from "./record-gate-answer"
import type { ExecutionRun } from "@/types/execution/run"

function deps(over: Partial<RecordGateAnswerDeps> = {}) {
  const commit = jest.fn(
    async (
      _sessionId: string,
      _delta: Parameters<NonNullable<RecordGateAnswerDeps["commit"]>>[1]
    ) => undefined
  )
  const appendToStore = jest.fn(
    (
      _sessionId: string,
      _message: Parameters<NonNullable<RecordGateAnswerDeps["appendToStore"]>>[1]
    ) => undefined
  )
  return {
    commit,
    appendToStore,
    all: {
      loadRun: async () => ({ id: "r", sessionId: "s1" }) as unknown as ExecutionRun,
      commit,
      appendToStore,
      newId: () => "msg-1",
      ...over,
    } satisfies RecordGateAnswerDeps,
  }
}

const INPUT = {
  runId: "execution:team:run_1",
  gateType: "budget",
  decision: "approved" as const,
  title: "Budget exceeded",
  answeredAt: 1000,
}

describe("recordSquadGateAnswer", () => {
  it("writes the decision into the run's conversation", async () => {
    const d = deps()
    await expect(recordSquadGateAnswer(INPUT, d.all)).resolves.toBe("s1")

    expect(d.commit).toHaveBeenCalledWith("s1", {
      upserts: [
        expect.objectContaining({
          id: "msg-1",
          role: "assistant",
          parts: [
            {
              type: "squad-gate",
              runId: "execution:team:run_1",
              gateType: "budget",
              decision: "approved",
              title: "Budget exceeded",
              answeredAt: 1000,
            },
          ],
        }),
      ],
    })
    expect(d.appendToStore).toHaveBeenCalledWith("s1", expect.objectContaining({ id: "msg-1" }))
  })

  it("persists as a single-message delta, never a whole-transcript write", async () => {
    // The chat controller owns the full list; a second writer replacing it
    // would race whatever turn is in flight.
    const d = deps()
    await recordSquadGateAnswer(INPUT, d.all)
    const [, delta] = d.commit.mock.calls[0]!
    expect(delta.upserts).toHaveLength(1)
  })

  it("does nothing for a run with no conversation", async () => {
    // Scheduled runs, IM runs and workflow nodes have nowhere to write.
    const d = deps({ loadRun: async () => ({ id: "r" }) as unknown as ExecutionRun })
    await expect(recordSquadGateAnswer(INPUT, d.all)).resolves.toBeNull()
    expect(d.commit).not.toHaveBeenCalled()
  })

  it("does nothing when the run is gone", async () => {
    const d = deps({ loadRun: async () => undefined })
    await expect(recordSquadGateAnswer(INPUT, d.all)).resolves.toBeNull()
    expect(d.commit).not.toHaveBeenCalled()
  })

  it("does nothing without a run id", async () => {
    const d = deps()
    await expect(recordSquadGateAnswer({ ...INPUT, runId: "  " }, d.all)).resolves.toBeNull()
    await expect(recordSquadGateAnswer({ ...INPUT, runId: undefined }, d.all)).resolves.toBeNull()
    expect(d.commit).not.toHaveBeenCalled()
  })

  it("never throws when the write fails — the gate must still resolve", async () => {
    // Losing the answer would be far worse than losing the note.
    const d = deps({
      commit: async () => {
        throw new Error("dexie down")
      },
    })
    await expect(recordSquadGateAnswer(INPUT, d.all)).resolves.toBeNull()
  })

  it("never throws when the run lookup fails", async () => {
    const d = deps({
      loadRun: async () => {
        throw new Error("closed")
      },
    })
    await expect(recordSquadGateAnswer(INPUT, d.all)).resolves.toBeNull()
  })

  it("records a rejection and a dismissal distinctly", async () => {
    for (const decision of ["rejected", "dismissed"] as const) {
      const d = deps()
      await recordSquadGateAnswer({ ...INPUT, decision }, d.all)
      const [, delta] = d.commit.mock.calls[0]!
      expect(delta.upserts?.[0]).toMatchObject({
        parts: [expect.objectContaining({ decision })],
      })
    }
  })
})
