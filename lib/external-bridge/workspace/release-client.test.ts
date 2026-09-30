import { releaseBridgeClient, type ReleaseClientDeps } from "./release-client"

function deps(over: Partial<ReleaseClientDeps> = {}): jest.Mocked<ReleaseClientDeps> {
  return {
    listJobs: jest.fn(async () => [
      { id: "j1", status: "running" },
      { id: "j2", status: "exited" },
      { id: "j3", status: "running" },
    ]),
    killJob: jest.fn(async () => undefined),
    dropGrant: jest.fn(async () => undefined),
    ...over,
  } as jest.Mocked<ReleaseClientDeps>
}

describe("releaseBridgeClient", () => {
  it("stops the client's running jobs and drops its grant, keyed by caller id", async () => {
    const d = deps()
    expect(await releaseBridgeClient("cli-1", d)).toEqual({ stoppedJobs: 2, failedJobs: 0 })
    expect(d.listJobs).toHaveBeenCalledWith("mcp:cli-1")
    expect(d.killJob.mock.calls.map(([id]) => id)).toEqual(["j1", "j3"])
    expect(d.dropGrant).toHaveBeenCalledWith("mcp:cli-1")
  })

  it("reports kills that failed and still drops the grant", async () => {
    const d = deps({
      killJob: jest.fn(async (id: string) => {
        if (id === "j1") throw new Error("gone")
      }),
    })
    expect(await releaseBridgeClient("cli-1", d)).toEqual({ stoppedJobs: 1, failedJobs: 1 })
    expect(d.dropGrant).toHaveBeenCalled()
  })
})
