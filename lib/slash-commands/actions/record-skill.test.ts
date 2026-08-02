const isTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"

import { runRecordSkillCommand } from "./record-skill"

beforeEach(() => {
  isTauri.mockReturnValue(true)
  __resetRecorderAvailabilityForTesting()
  useRecorderStore.getState().reset()
})

describe("runRecordSkillCommand", () => {
  it("opens the same global recorder every other entry point uses", async () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    await expect(runRecordSkillCommand()).resolves.toEqual({ opened: true })
    expect(useRecorderStore.getState().phase).toBe("setup")
    expect(useRecorderStore.getState().sheetOpen).toBe(true)
  })

  it("reattaches to a running session rather than starting a second one", async () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    const store = useRecorderStore.getState()
    store.dispatch({ type: "OPEN", source: "toolbar" })
    store.dispatch({ type: "PREFLIGHT_START" })
    store.dispatch({ type: "PREFLIGHT_OK" })
    store.dispatch({
      type: "NATIVE_STARTED",
      recordingId: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
      startedAt: 1,
      scope: { kind: "desktop" },
      limits: { maxDurationMs: 1, maxSteps: 1, maxBundleBytes: 1, maxGlobalBytes: 1 },
    })
    store.setUi({ sheetOpen: false })

    await runRecordSkillCommand()
    expect(useRecorderStore.getState().phase).toBe("recording")
    expect(useRecorderStore.getState().sheetOpen).toBe(true)
  })

  it("reports the web shell separately from a disabled plugin", async () => {
    // The two call for different things from the user; collapsing them into one
    // message sends half of them to the wrong place.
    isTauri.mockReturnValue(false)
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    await expect(runRecordSkillCommand()).resolves.toEqual({
      opened: false,
      reason: "desktopOnly",
    })
    expect(useRecorderStore.getState().phase).toBe("idle")
  })

  it("reports a disabled plugin on desktop", async () => {
    await expect(runRecordSkillCommand()).resolves.toEqual({
      opened: false,
      reason: "pluginDisabled",
    })
    expect(useRecorderStore.getState().phase).toBe("idle")
  })

  it("checks the shell before the plugin, so the web answer is never wrong", async () => {
    isTauri.mockReturnValue(false)
    await expect(runRecordSkillCommand()).resolves.toMatchObject({ reason: "desktopOnly" })
  })
})
