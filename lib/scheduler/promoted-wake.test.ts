import { handlePromotedTaskWake } from "./promoted-wake"

function deps() {
  const selectTask = jest.fn()
  const initialize = jest.fn(async () => undefined)
  const run = jest.fn(async () => ({ id: "exec" }))
  const navigate = jest.fn()
  const warn = jest.fn()
  return {
    selectTask,
    initialize,
    run,
    navigate,
    warn,
    d: {
      navigate,
      warn,
      loadStore: async () => ({ selectTask, initialize }),
      loadRunner: async () => run,
    },
  }
}

describe("handlePromotedTaskWake", () => {
  it("selects the task and navigates without running when no token is present", async () => {
    const x = deps()
    await expect(handlePromotedTaskWake({ taskId: "t1" }, x.d)).resolves.toEqual({ ran: false })
    expect(x.selectTask).toHaveBeenCalledWith("t1")
    expect(x.navigate).toHaveBeenCalledWith("/scheduler")
    expect(x.initialize).not.toHaveBeenCalled()
    expect(x.run).not.toHaveBeenCalled()
  })

  it("initialises the store then runs the promoted task when a token is present", async () => {
    const x = deps()
    await expect(handlePromotedTaskWake({ taskId: "t1", runToken: "tok" }, x.d)).resolves.toEqual({
      ran: true,
    })
    expect(x.initialize).toHaveBeenCalledTimes(1)
    expect(x.run).toHaveBeenCalledWith("t1", "tok")
    expect(x.warn).not.toHaveBeenCalled()
  })

  it("logs and reports ran=false when the run fails", async () => {
    const x = deps()
    x.run.mockRejectedValueOnce(new Error("bad token"))
    await expect(handlePromotedTaskWake({ taskId: "t1", runToken: "tok" }, x.d)).resolves.toEqual({
      ran: false,
    })
    expect(x.warn).toHaveBeenCalledWith(
      "promoted task wake-up failed",
      expect.objectContaining({ taskId: "t1" })
    )
  })

  it("falls back to console.warn and the real module loaders", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const selectTask = jest.fn()
    const initialize = jest.fn(async () => {
      throw new Error("no db")
    })
    jest.doMock("@/stores/scheduler/scheduler-store", () => ({
      useSchedulerStore: { getState: () => ({ selectTask, initialize }) },
    }))
    const runPromotedTask = jest.fn()
    jest.doMock("@/lib/scheduler/task-scheduler", () => ({
      getTaskScheduler: () => ({ runPromotedTask }),
    }))
    const navigate = jest.fn()
    await expect(
      handlePromotedTaskWake({ taskId: "t2", runToken: "tok" }, { navigate })
    ).resolves.toEqual({ ran: false })
    expect(selectTask).toHaveBeenCalledWith("t2")
    expect(warnSpy).toHaveBeenCalled()
    expect(runPromotedTask).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    jest.dontMock("@/stores/scheduler/scheduler-store")
    jest.dontMock("@/lib/scheduler/task-scheduler")
  })
})
