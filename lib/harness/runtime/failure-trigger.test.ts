import type { AppSettings, Character } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { makeRun } from "../test-fixtures"
import {
  enqueueRunForFailure,
  type FailedTurnContext,
  type FailureTriggerDeps,
} from "./failure-trigger"
import { HarnessStartError, type StartHarnessRunInput } from "./start"

const NOW = 10_000_000_000

function settings(startMode = "background"): AppSettings {
  return { harnessEvolution: { enabled: true, startMode } } as unknown as AppSettings
}

function setup(over: Partial<FailureTriggerDeps> = {}) {
  const started: StartHarnessRunInput[] = []
  const deps: FailureTriggerDeps = {
    getSettings: async () => settings(),
    resolveCharacter: async (id) => ({ id, name: "Analyst" }) as Character,
    listRuns: async () => [],
    start: async (input) => {
      started.push(input)
      return { created: true, run: makeRun({ id: `run-${started.length}` }) }
    },
    now: () => NOW,
    ...over,
  }
  return { deps, started }
}

const turn: FailedTurnContext = {
  sessionId: "sess-1",
  characterId: "agent-1",
  projectId: "proj-1",
  workingDirectory: "/repo",
  diagnostic: { code: "budgetExhausted" },
  prompt: "Summarise the CSV files into report.md",
  messageId: "m-1",
}

describe("enqueueRunForFailure", () => {
  it("queues a background run replaying the failed request in its repository", async () => {
    const { deps, started } = setup()
    expect(await enqueueRunForFailure(turn, deps)).toEqual({
      kind: "enqueued",
      runId: "run-1",
      created: true,
    })
    expect(started).toEqual([
      {
        characterId: "agent-1",
        trigger: "background",
        sessionId: "sess-1",
        projectId: "proj-1",
        task: expect.objectContaining({
          prompt: turn.prompt,
          isolation: "git",
          git: { sourceRoot: "/repo", projectId: "proj-1" },
          source: { kind: "session", sessionId: "sess-1", messageId: "m-1" },
        }),
      },
    ])
  })

  it("falls back to a scratch directory when the folder is not a repository", async () => {
    let calls = 0
    const { deps, started } = setup({
      start: async (input) => {
        calls += 1
        started.push(input)
        if (calls === 1) throw new HarnessStartError("no-commit", "no commit")
        return { created: true, run: makeRun({ id: "run-2" }) }
      },
    })
    expect(await enqueueRunForFailure(turn, deps)).toMatchObject({
      kind: "enqueued",
      runId: "run-2",
    })
    expect(started[1].task).toMatchObject({ isolation: "files" })
    expect(started[1].task.git).toBeUndefined()

    const other = setup({
      start: async () => {
        throw new Error("fatal: not a git repository")
      },
    })
    // The scratch retry also fails here, and that error surfaces.
    await expect(enqueueRunForFailure(turn, other.deps)).rejects.toThrow(/not a git repository/)
  })

  it("does not retry refusals about the run itself", async () => {
    const { deps, started } = setup({
      start: async (input) => {
        started.push(input)
        throw new HarnessStartError("model-unavailable", "no model")
      },
    })
    await expect(enqueueRunForFailure(turn, deps)).rejects.toMatchObject({
      code: "model-unavailable",
    })
    expect(started).toHaveLength(1)
  })

  it("skips with the reason when the failure or settings do not call for a run", async () => {
    const offerOnly = setup({ getSettings: async () => settings("failure-triggered") })
    expect(await enqueueRunForFailure(turn, offerOnly.deps)).toEqual({
      kind: "skipped",
      reason: "offer",
    })
    const infra = setup()
    expect(
      await enqueueRunForFailure({ ...turn, diagnostic: { code: "rateLimited" } }, infra.deps)
    ).toEqual({ kind: "skipped", reason: "not-harness-failure" })
    const noAgent = setup({ resolveCharacter: async () => undefined })
    expect(await enqueueRunForFailure(turn, noAgent.deps)).toEqual({
      kind: "skipped",
      reason: "unsupported-agent",
    })
    const recent: HarnessEvolutionRun[] = [
      makeRun({
        trigger: "background",
        createdAt: NOW - 1000,
        sessionId: "other",
        status: "completed",
      }),
    ]
    const cooled = setup({ listRuns: async () => recent })
    expect(await enqueueRunForFailure(turn, cooled.deps)).toEqual({
      kind: "skipped",
      reason: "cooldown",
    })
    expect(offerOnly.started.length + infra.started.length + cooled.started.length).toBe(0)
  })
})
