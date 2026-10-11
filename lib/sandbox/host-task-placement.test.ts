import { resolveHostTaskPlacement, type HostTaskPlacementSources } from "./host-task-placement"

function sources(overrides: Partial<HostTaskPlacementSources> = {}) {
  const selection = jest.fn(async () => ({ runtime: undefined }))
  return {
    sources: { isHost: () => true, selection, ...overrides } as HostTaskPlacementSources,
    selection,
  }
}

describe("resolveHostTaskPlacement", () => {
  it("overrides nothing on a host that is not always-on", async () => {
    const { sources: s, selection } = sources({ isHost: () => false })
    await expect(resolveHostTaskPlacement({ projectId: "p1" }, s)).resolves.toEqual({
      kind: "not-a-host",
    })
    expect(selection).not.toHaveBeenCalled()
  })

  it("puts every turn on an always-on host in a container by default", async () => {
    const { sources: s } = sources()
    await expect(resolveHostTaskPlacement({ projectId: "p1" }, s)).resolves.toEqual({
      kind: "container",
    })
    // A turn with no project, or no session at all, is no exception.
    await expect(resolveHostTaskPlacement({}, s)).resolves.toEqual({ kind: "container" })
    await expect(resolveHostTaskPlacement(null, s)).resolves.toEqual({ kind: "container" })
  })

  it("honours a project's opt-out to host processes, read from its session environment", async () => {
    const { sources: s, selection } = sources({
      selection: jest.fn(async () => ({
        runtime: { source: { kind: "auto" }, hostProcess: true, updatedAt: 1 } as const,
      })),
    })
    await expect(
      resolveHostTaskPlacement(
        {
          projectId: "legacy",
          executionContext: { projectId: "p1", environmentId: "env-1" } as never,
        },
        s
      )
    ).resolves.toEqual({ kind: "host-process", projectId: "p1" })
    expect(s.selection).toHaveBeenCalledWith("p1", "env-1")
    expect(selection).not.toHaveBeenCalled()
  })

  it("keeps a turn in a container when the selection cannot be read", async () => {
    const { sources: s } = sources({
      selection: jest.fn(async () => {
        throw new Error("vault locked")
      }),
    })
    await expect(resolveHostTaskPlacement({ projectId: "p1" }, s)).resolves.toEqual({
      kind: "container",
    })
  })

  it("does not treat an explicit `false` as an opt-out", async () => {
    const { sources: s } = sources({
      selection: jest.fn(async () => ({
        runtime: { source: { kind: "auto" }, hostProcess: false, updatedAt: 1 } as const,
      })),
    })
    await expect(resolveHostTaskPlacement({ projectId: "p1" }, s)).resolves.toEqual({
      kind: "container",
    })
  })
})
