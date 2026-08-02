import {
  RECOVERY_BOOT_COMMAND,
  RECOVERY_CHECKPOINT_COMMAND,
  RECOVERY_HEARTBEAT_COMMAND,
  RECOVERY_RETRY_COMMAND,
  RECOVERY_STATE_COMMAND,
  getRecoveryBoot,
  getRecoveryState,
  isSafeModeRuntimeAvailable,
  recordRecoveryCheckpoint,
  retryRecoverySubsystem,
  sendRecoveryHeartbeat,
} from "./recovery"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

const { invoke } = jest.requireMock("@tauri-apps/api/core") as { invoke: jest.Mock }
const { isTauri } = jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }

const STATE = {
  schemaVersion: 1,
  buildId: "build-1",
  mode: "safe",
  unhealthyStarts: [1, 2],
  checkpoints: [],
  rendererReload: {},
  childRestarts: {},
  disabledSubsystems: [],
  rendererAlive: false,
  audit: [],
}

describe("recovery IPC client", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    isTauri.mockReturnValue(true)
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("reads the boot decision over the registered command", async () => {
    invoke.mockResolvedValue({ requiresSafeShell: true, mode: "safe", buildId: "b" })
    await expect(getRecoveryBoot()).resolves.toMatchObject({ requiresSafeShell: true })
    expect(invoke).toHaveBeenCalledWith(RECOVERY_BOOT_COMMAND, undefined)
  })

  it("reads the full state over the registered command", async () => {
    invoke.mockResolvedValue(STATE)
    await expect(getRecoveryState()).resolves.toEqual(STATE)
    expect(invoke).toHaveBeenCalledWith(RECOVERY_STATE_COMMAND, undefined)
  })

  it("sends a checkpoint with its reason code", async () => {
    invoke.mockResolvedValue(STATE)
    await recordRecoveryCheckpoint("plugins", false, "plugins.probe_failed")
    expect(invoke).toHaveBeenCalledWith(RECOVERY_CHECKPOINT_COMMAND, {
      subsystem: "plugins",
      success: false,
      reasonCode: "plugins.probe_failed",
    })
  })

  it("sends an explicit null when a checkpoint has no reason code", async () => {
    invoke.mockResolvedValue(STATE)
    await recordRecoveryCheckpoint("database", true)
    expect(invoke).toHaveBeenCalledWith(RECOVERY_CHECKPOINT_COMMAND, {
      subsystem: "database",
      success: true,
      reasonCode: null,
    })
  })

  it("defaults the retry action to retry", async () => {
    invoke.mockResolvedValue(STATE)
    await retryRecoverySubsystem("sidecar")
    expect(invoke).toHaveBeenCalledWith(RECOVERY_RETRY_COMMAND, {
      subsystem: "sidecar",
      action: "retry",
    })
  })

  it("passes keep-disabled through", async () => {
    invoke.mockResolvedValue(STATE)
    await retryRecoverySubsystem("connectors", "keep-disabled")
    expect(invoke).toHaveBeenCalledWith(RECOVERY_RETRY_COMMAND, {
      subsystem: "connectors",
      action: "keep-disabled",
    })
  })

  it("sends heartbeats", async () => {
    invoke.mockResolvedValue(STATE)
    await sendRecoveryHeartbeat()
    expect(invoke).toHaveBeenCalledWith(RECOVERY_HEARTBEAT_COMMAND, undefined)
  })

  it("refuses an unknown subsystem without reaching IPC", async () => {
    await expect(recordRecoveryCheckpoint("renderer" as never, true)).resolves.toBeNull()
    await expect(retryRecoverySubsystem("renderer" as never)).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns null off-desktop instead of throwing", async () => {
    isTauri.mockReturnValue(false)
    await expect(getRecoveryBoot()).resolves.toBeNull()
    await expect(getRecoveryState()).resolves.toBeNull()
    await expect(sendRecoveryHeartbeat()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns null when the controller is unreachable rather than blocking boot", async () => {
    invoke.mockRejectedValue(new Error("command not found"))
    await expect(getRecoveryState()).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })

  describe("safe-mode availability", () => {
    it("is false off-desktop", async () => {
      isTauri.mockReturnValue(false)
      await expect(isSafeModeRuntimeAvailable()).resolves.toBe(false)
    })

    it("is false when the controller does not answer", async () => {
      invoke.mockRejectedValue(new Error("no controller"))
      await expect(isSafeModeRuntimeAvailable()).resolves.toBe(false)
    })

    it("is true only when the controller answers", async () => {
      invoke.mockResolvedValue({
        requiresSafeShell: false,
        mode: "normal",
        buildId: "b",
        previousSessionUnhealthy: false,
      })
      await expect(isSafeModeRuntimeAvailable()).resolves.toBe(true)
    })
  })
})
