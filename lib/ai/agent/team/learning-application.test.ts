const updateTeam = jest.fn()

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: {
    getState: () => ({
      teams: { "team-1": { id: "team-1", config: { runtimeVersion: "durable-v2" } } },
      updateTeam,
    }),
  },
}))

jest.mock("@/lib/db/project-environments", () => ({
  getProjectEnvironmentVersion: jest.fn(),
  createProjectEnvironmentVersion: jest.fn(),
}))

jest.mock("./shared-memory-orchestrator", () => ({ publishEntry: jest.fn() }))

import { applyApprovedLearningProposal } from "./learning-application"

describe("approved AgentTeam learning application", () => {
  beforeEach(() => updateTeam.mockClear())

  it("refuses to apply a pending proposal", async () => {
    await expect(
      applyApprovedLearningProposal("team-1", {
        id: "proposal-1",
        kind: "prompt",
        title: "Improve prompt",
        after: "New prompt",
        status: "pending",
      })
    ).rejects.toThrow(/requires approval/)
    expect(updateTeam).not.toHaveBeenCalled()
  })

  it("versions approved prompt changes through the team config", async () => {
    await applyApprovedLearningProposal("team-1", {
      id: "proposal-2",
      kind: "prompt",
      title: "Improve prompt",
      before: "Old prompt",
      after: "New prompt",
      status: "approved",
    })
    expect(updateTeam).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({
        config: expect.objectContaining({ defaultSystemPrompt: "New prompt" }),
      })
    )
  })
})
