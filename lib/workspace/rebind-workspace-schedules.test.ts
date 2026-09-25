import {
  rebindWorkspaceSchedules,
  type RebindWorkspaceSchedulesDeps,
} from "./rebind-workspace-schedules"

function deps(tasks: { id: string; projectId?: string }[]) {
  const updateTask = jest.fn<Promise<unknown>, [string, { projectId?: string | null }]>(
    async () => null
  )
  const listTasks = jest.fn(async () => tasks)
  return { listTasks, updateTask } satisfies RebindWorkspaceSchedulesDeps
}

describe("rebindWorkspaceSchedules", () => {
  it("moves every schedule the workspace owns to the fallback", async () => {
    const d = deps([
      { id: "a", projectId: "p_gone" },
      { id: "b", projectId: "p_gone" },
    ])

    await expect(rebindWorkspaceSchedules("p_gone", "project-default", d)).resolves.toBe(2)

    expect(d.listTasks).toHaveBeenCalledWith("p_gone")
    expect(d.updateTask.mock.calls).toEqual([
      ["a", { projectId: "project-default" }],
      ["b", { projectId: "project-default" }],
    ])
  })

  it("unbinds instead when there is no destination", async () => {
    const d = deps([{ id: "a", projectId: "p_gone" }])

    await rebindWorkspaceSchedules("p_gone", null, d)

    expect(d.updateTask).toHaveBeenCalledWith("a", { projectId: null })
  })

  it("leaves unbound schedules alone: they already belong everywhere", async () => {
    // `getTasksByProject` returns the unattributed rows too.
    const d = deps([{ id: "unbound" }, { id: "owned", projectId: "p_gone" }])

    await expect(rebindWorkspaceSchedules("p_gone", "project-default", d)).resolves.toBe(1)

    expect(d.updateTask).toHaveBeenCalledTimes(1)
    expect(d.updateTask).toHaveBeenCalledWith("owned", { projectId: "project-default" })
  })

  it("drops a frozen execution binding that names the removed workspace", async () => {
    const binding = { location: "local", projectId: "p_gone", projectRoot: "/repo" }
    const d = deps([
      { id: "bound", projectId: "p_gone", payload: { prompt: "hi", executionContext: binding } },
      {
        id: "elsewhere",
        projectId: "p_gone",
        payload: { prompt: "hi", executionContext: { ...binding, projectId: "p_other" } },
      },
      { id: "plain", projectId: "p_gone", payload: { prompt: "hi" } },
    ] as never)

    await rebindWorkspaceSchedules("p_gone", "project-default", d)

    expect(d.updateTask.mock.calls).toEqual([
      ["bound", { projectId: "project-default", payload: { executionContext: undefined } }],
      ["elsewhere", { projectId: "project-default" }],
      ["plain", { projectId: "project-default" }],
    ])
  })

  it("stops at the first failed write so the removal can be retried", async () => {
    const d = deps([
      { id: "a", projectId: "p_gone" },
      { id: "b", projectId: "p_gone" },
    ])
    d.updateTask.mockRejectedValueOnce(new Error("db closed"))

    await expect(rebindWorkspaceSchedules("p_gone", null, d)).rejects.toThrow("db closed")
    expect(d.updateTask).toHaveBeenCalledTimes(1)
  })
})
