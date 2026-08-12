const callMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => callMock(...args) },
}))

import { projectManagedFleetSession, removeManagedFleetSession } from "./managed-session-projection"

describe("managed Fleet session projection", () => {
  beforeEach(() => callMock.mockReset())

  it("projects lineage without prompts, credentials, or local paths", async () => {
    callMock.mockResolvedValue(undefined)
    await projectManagedFleetSession({
      sessionId: "remote-1",
      hostRef: "device:worker-a",
      status: "working",
      agentTeamId: "team-1",
      agentTeamRunId: "run-1",
      agentTeamChildRunId: "child-1",
      executionRunId: "execution:team:run-1",
      model: "test-model",
    })
    expect(callMock).toHaveBeenCalledWith("fleet_project_managed_session", {
      input: expect.objectContaining({
        sessionId: "remote-1",
        hostRef: "device:worker-a",
        agentTeamChildRunId: "child-1",
      }),
    })
    expect(JSON.stringify(callMock.mock.calls[0])).not.toMatch(/prompt|credential|\/repo/)
  })

  it("removes only the named projection", async () => {
    callMock.mockResolvedValue(true)
    await expect(removeManagedFleetSession("remote-1")).resolves.toBe(true)
    expect(callMock).toHaveBeenCalledWith("fleet_remove_managed_session", {
      sessionId: "remote-1",
    })
  })
})
