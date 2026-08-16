/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

const countSessions = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ countSessions: () => countSessions() }))

const detectPlatform = jest.fn(() => "tauri")
jest.mock("@/lib/platform/detect", () => ({ detectPlatform: () => detectPlatform() }))

const save = jest.fn().mockResolvedValue(undefined)
let storeState: { loaded: boolean; settings: AppSettings | null } = {
  loaded: false,
  settings: null,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => ({ ...storeState, save }) }
  ),
}))

import { useOnboardingGate } from "./use-onboarding-gate"

const settingsOf = (patch: Partial<AppSettings> = {}): AppSettings =>
  ({ id: "singleton", ...patch }) as AppSettings

beforeEach(() => {
  countSessions.mockReset().mockResolvedValue(0)
  save.mockClear()
  detectPlatform.mockReturnValue("tauri")
  storeState = { loaded: false, settings: null }
})

describe("useOnboardingGate", () => {
  it("stays resolving until settings hydrate", async () => {
    const { result } = renderHook(() => useOnboardingGate())
    expect(result.current.status).toBe("resolving")
    // Acting now would make a long-time user look like a fresh install.
    expect(countSessions).not.toHaveBeenCalled()
  })

  it("enters the flow on a fresh install", async () => {
    storeState = { loaded: true, settings: settingsOf() }
    const { result } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("enter"))
  })

  it("skips for a long-time user who has chats but no progress record", async () => {
    countSessions.mockResolvedValue(4)
    storeState = { loaded: true, settings: settingsOf() }
    const { result } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("skip"))
  })

  it("skips once onboarding is recorded complete", async () => {
    storeState = {
      loaded: true,
      settings: settingsOf({
        onboardingProgress: { version: 1, path: "completed", completedAt: "2026-08-01T00:00:00Z" },
      }),
    }
    const { result } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("skip"))
  })

  it("migrates a legacy dismissal exactly once and skips", async () => {
    storeState = {
      loaded: true,
      settings: settingsOf({ onboardingDismissedAt: "2026-05-18T00:00:00.000Z" }),
    }
    const { result } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("skip"))
    expect(save).toHaveBeenCalledWith({
      onboardingProgress: expect.objectContaining({ path: "legacy_dismissed" }),
    })
  })

  it("releases a latched enter verdict the moment the flow records a skip", async () => {
    storeState = { loaded: true, settings: settingsOf() }
    const { result, rerender } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("enter"))

    // The flow's Skip writes `skippedAt` and then navigates home. The boot
    // verdict is latched, so without a live settlement read the gate would
    // still say "enter" and bounce the user straight back into the flow.
    storeState = {
      loaded: true,
      settings: settingsOf({
        onboardingProgress: {
          version: 1,
          path: "provider_skipped",
          lastStep: "provider",
          skippedAt: "2026-08-16T00:00:00.000Z",
        },
      }),
    }
    rerender()
    expect(result.current.status).toBe("skip")
    // Still a one-shot count: settlement is read from settings, not re-probed.
    expect(countSessions).toHaveBeenCalledTimes(1)
  })

  it("releases a latched enter verdict once the first run completes", async () => {
    storeState = { loaded: true, settings: settingsOf() }
    const { result, rerender } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("enter"))
    storeState = {
      loaded: true,
      settings: settingsOf({
        onboardingProgress: {
          version: 1,
          path: "completed",
          completedAt: "2026-08-16T00:00:00.000Z",
        },
      }),
    }
    rerender()
    expect(result.current.status).toBe("skip")
  })

  it("does not let a settled record pre-empt the resolving state", () => {
    // Hydrated but not yet counted: the verdict must still come from the
    // effect, so the legacy-migration write and the count both get to run.
    storeState = {
      loaded: true,
      settings: settingsOf({
        onboardingProgress: { version: 1, path: "completed", completedAt: "2026-08-01T00:00:00Z" },
      }),
    }
    const { result } = renderHook(() => useOnboardingGate())
    expect(result.current.status).toBe("resolving")
  })

  it("treats a failed session count as an existing install rather than trapping the user", async () => {
    countSessions.mockRejectedValue(new Error("dexie down"))
    storeState = { loaded: true, settings: settingsOf() }
    const { result } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.status).toBe("skip"))
  })

  it("resolves the shell from the platform and the mobile runtime mode", async () => {
    detectPlatform.mockReturnValue("mobile")
    storeState = { loaded: true, settings: settingsOf({ mobileRuntimeMode: "paired" }) }
    const { result } = renderHook(() => useOnboardingGate())
    await waitFor(() => expect(result.current.shell).toBe("mobile-paired"))
  })
})
