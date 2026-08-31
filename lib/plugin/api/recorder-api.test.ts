jest.mock("@/lib/skills/recording/recorder-availability", () => ({
  clearRecorderAvailability: jest.fn(),
  getRecorderAvailability: jest.fn(() => ({ available: true, pluginId: "plugin-a" })),
  setRecorderAvailability: jest.fn(),
  subscribeRecorderAvailability: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/skills/recording/recorder-client", () => ({
  onRecordEvent: jest.fn(() => jest.fn()),
  recordDeleteBundle: jest.fn(),
  recordInterrupt: jest.fn(),
  recordListCaptureTargets: jest.fn(),
  recordListRecoverable: jest.fn(),
  recordLoadBundle: jest.fn(),
  recordPause: jest.fn(),
  recordPreflight: jest.fn(),
  recordReadAsset: jest.fn(),
  recordResume: jest.fn(),
  recordStart: jest.fn(),
  recordStatus: jest.fn(),
  recordStop: jest.fn(),
  recordUndoLast: jest.fn(),
}))
jest.mock("@/stores/skills/recorder-store", () => ({
  openRecorder: jest.fn(),
  recorderStatusSnapshot: jest.fn(() => ({ recording: false, phase: "idle", stepCount: 0 })),
}))

import {
  clearRecorderAvailability,
  getRecorderAvailability,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { recordStatus } from "@/lib/skills/recording/recorder-client"
import { openRecorder } from "@/stores/skills/recorder-store"
import { createRecorderAPI } from "./recorder-api"

describe("createRecorderAPI", () => {
  beforeEach(() => jest.clearAllMocks())

  it("publishes ownership and only clears its own availability", () => {
    const dispose = createRecorderAPI("plugin-a").publishAvailability()
    expect(setRecorderAvailability).toHaveBeenCalledWith({ available: true, pluginId: "plugin-a" })
    dispose()
    expect(clearRecorderAvailability).toHaveBeenCalledTimes(1)

    jest.mocked(clearRecorderAvailability).mockClear()
    jest.mocked(getRecorderAvailability).mockReturnValue({ available: true, pluginId: "plugin-b" })
    dispose()
    expect(clearRecorderAvailability).not.toHaveBeenCalled()
  })

  it("delegates native and store operations", async () => {
    const api = createRecorderAPI("plugin-a")
    await api.status()
    api.open("plugin-command")
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(openRecorder).toHaveBeenCalledWith("plugin-command")
    expect(api.statusSnapshot()).toEqual({ recording: false, phase: "idle", stepCount: 0 })
  })
})
