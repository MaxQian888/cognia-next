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

  it("arm pushes to the daemon and disarm removes", () => {
    driver.arm("task_1", 1700000000000)
    expect(mockedArm).toHaveBeenCalledWith("task_1", 1700000000000)
    driver.disarm("task_1")
    expect(mockedDisarm).toHaveBeenCalledWith("task_1")
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
})
