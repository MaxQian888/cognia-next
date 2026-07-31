import { RustDaemonTimingDriver } from "./rust-daemon-driver"
import { armTask, disarmTask, listenTaskDue } from "../daemon-bridge"

jest.mock("../daemon-bridge", () => ({
  armTask: jest.fn().mockResolvedValue(undefined),
  disarmTask: jest.fn().mockResolvedValue(undefined),
  listenTaskDue: jest.fn(),
}))

const mockedArm = armTask as jest.MockedFunction<typeof armTask>
const mockedDisarm = disarmTask as jest.MockedFunction<typeof disarmTask>
const mockedListen = listenTaskDue as jest.MockedFunction<typeof listenTaskDue>

describe("RustDaemonTimingDriver", () => {
  let driver: RustDaemonTimingDriver
  let emit: (taskId: string, firedAtMs: number) => void
  const unlisten = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    mockedListen.mockImplementation(async (handler) => {
      emit = (taskId, firedAtMs) => handler({ taskId, firedAtMs })
      return unlisten
    })
    driver = new RustDaemonTimingDriver()
  })

  it("does not support leader election (single native authority)", () => {
    expect(driver.supportsLeaderElection).toBe(false)
  })

  it("arm pushes to the daemon and disarm removes", async () => {
    await driver.arm("task_1", 1700000000000)
    expect(mockedArm).toHaveBeenCalledWith("task_1", 1700000000000)
    await driver.disarm("task_1")
    expect(mockedDisarm).toHaveBeenCalledWith("task_1")
  })

  it("serializes disarm behind an in-flight arm for the same task", async () => {
    let resolveArm!: () => void
    mockedArm.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveArm = resolve
        })
    )

    const arm = driver.arm("task_1", 1700000000000)
    const disarm = driver.disarm("task_1")
    await Promise.resolve()
    await Promise.resolve()
    expect(mockedDisarm).not.toHaveBeenCalled()

    resolveArm()
    await Promise.all([arm, disarm])
    expect(mockedDisarm).toHaveBeenCalledWith("task_1")
  })

  it("disarms every daemon entry when stopped", async () => {
    await driver.arm("task_1", 1700000000000)
    await driver.arm("task_2", 1700000001000)

    driver.stop()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockedDisarm).toHaveBeenCalledWith("task_1")
    expect(mockedDisarm).toHaveBeenCalledWith("task_2")
  })

  it("reports the armed slot (not the daemon's fired-at) on due", async () => {
    const due = jest.fn()
    driver.onDue(due)
    await driver.start()

    driver.arm("task_1", 1700000000000)
    // Daemon fires with a slightly-later actual instant.
    emit("task_1", 1700000000050)

    expect(due).toHaveBeenCalledWith("task_1", 1700000000000)
  })

  it("falls back to the daemon's fired-at when no armed slot is known", async () => {
    const due = jest.fn()
    driver.onDue(due)
    await driver.start()

    emit("unknown_task", 1700000000099)
    expect(due).toHaveBeenCalledWith("unknown_task", 1700000000099)
  })

  it("start is idempotent and stop unlistens", async () => {
    await driver.start()
    await driver.start()
    expect(mockedListen).toHaveBeenCalledTimes(1)
    driver.stop()
    expect(unlisten).toHaveBeenCalled()
  })

  it("shares one listener registration across concurrent starts", async () => {
    await Promise.all([driver.start(), driver.start()])
    expect(mockedListen).toHaveBeenCalledTimes(1)
  })

  it("cancels a listener that finishes starting after stop", async () => {
    const due = jest.fn()
    let resolveListen!: (stop: () => void) => void
    mockedListen.mockImplementationOnce(
      (handler) =>
        new Promise((resolve) => {
          emit = (taskId, firedAtMs) => handler({ taskId, firedAtMs })
          resolveListen = resolve
        })
    )
    driver.onDue(due)

    const startPromise = driver.start()
    driver.stop()
    resolveListen(unlisten)
    await startPromise

    expect(unlisten).toHaveBeenCalledTimes(1)
    emit("stale-task", 1700000000099)
    expect(due).not.toHaveBeenCalled()
  })

  it("can start cleanly after an in-flight start was stopped", async () => {
    let resolveFirstListen!: (stop: () => void) => void
    mockedListen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstListen = resolve
        })
    )

    const firstStart = driver.start()
    driver.stop()
    resolveFirstListen(unlisten)
    await firstStart
    await driver.start()

    expect(mockedListen).toHaveBeenCalledTimes(2)
  })
})
