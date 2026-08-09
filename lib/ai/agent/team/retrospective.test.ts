import "fake-indexeddb/auto"

import { appendAgentTeamTrajectory } from "@/lib/db/agent-team-runtime"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createRetrospectiveService } from "./retrospective"

describe("AgentTeam retrospective learning", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("redacts trajectory content before model analysis and persists pending proposals", async () => {
    await appendAgentTeamTrajectory({
      runId: "run-1",
      childRunId: "child-1",
      kind: "child_failed",
      correlationId: "failure-1",
      payload: { error: "Contact alice@example.com about the timeout" },
      createdAt: 1,
    })
    const runModel = jest.fn(async (prompt: string) => {
      expect(prompt).not.toContain("alice@example.com")
      return {
        issueTimeline: [{ at: 1, summary: "Child timed out", childRunId: "child-1" }],
        proposals: [
          {
            kind: "prompt" as const,
            title: "Clarify timeout",
            before: "Run task",
            after: "Run task with a ten minute timeout",
          },
        ],
      }
    })
    const service = createRetrospectiveService({ now: () => 10, runModel })

    const result = await service.generate("run-1")

    expect(runModel).toHaveBeenCalledTimes(1)
    expect(result.status).toBe("pending_approval")
    expect(result.proposals[0]).toMatchObject({ status: "pending", kind: "prompt" })
    expect(result.contentHash).toMatch(/^sha256:/)
  })

  it("never applies learning until its proposal is explicitly approved", async () => {
    const service = createRetrospectiveService({
      now: () => 20,
      runModel: async () => ({
        issueTimeline: [],
        proposals: [{ kind: "environment", title: "Pin Node", after: "node=22" }],
      }),
    })
    const first = await service.generate("run-reject")
    const apply = jest.fn(async () => undefined)
    await service.resolveProposal(first.id, first.proposals[0]!.id, "rejected", apply)
    expect(apply).not.toHaveBeenCalled()

    const second = await service.generate("run-approve")
    await service.resolveProposal(second.id, second.proposals[0]!.id, "approved", apply)
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ after: "node=22" }))
    expect((await getDb().agentTeamRetrospectives.get(second.id))?.status).toBe("applied")
  })
})
