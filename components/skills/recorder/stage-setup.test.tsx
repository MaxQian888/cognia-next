/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordListCaptureTargets: jest.fn(),
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { recordListCaptureTargets } from "@/lib/skills/recording/recorder-client"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { CaptureTarget, RecordPreflight } from "@/lib/skills/recording/types"

import { StageSetup } from "./stage-setup"

const listTargets = recordListCaptureTargets as jest.MockedFunction<typeof recordListCaptureTargets>

function target(patch: Partial<CaptureTarget> = {}): CaptureTarget {
  return {
    windowId: 1,
    processId: 10,
    appName: "Safari",
    title: "Invoices",
    focused: false,
    minimized: false,
    ...patch,
  }
}

function preflight(patch: Partial<RecordPreflight> = {}): RecordPreflight {
  return {
    ready: true,
    blockers: [],
    platform: "macos",
    platformSupported: true,
    pluginInstalled: true,
    pluginEnabled: true,
    granted: [],
    missingGrants: [],
    automationEnabled: true,
    killSwitchEngaged: false,
    alreadyRecording: false,
    accessibility: "ok",
    inputMonitoring: "ok",
    screenRecording: "ok",
    uiAutomation: "notApplicable",
    ocrBackends: ["apple-vision"],
    ocrAvailable: true,
    storage: { usedBytes: 0, globalLimitBytes: 1, bundleLimitBytes: 1 },
    openBundles: 0,
    ...patch,
  }
}

function renderSetup(props: Partial<React.ComponentProps<typeof StageSetup>> = {}) {
  const onScopeKindChange = jest.fn()
  const onRetryPreflight = jest.fn()
  const onTargetChange = jest.fn()
  render(
    <StageSetup
      scopeKind="desktop"
      onScopeKindChange={onScopeKindChange}
      target={null}
      onTargetChange={onTargetChange}
      onRetryPreflight={onRetryPreflight}
      {...props}
    />
  )
  return { onScopeKindChange, onRetryPreflight, onTargetChange }
}

beforeEach(() => {
  useRecorderStore.getState().reset()
  listTargets.mockReset()
  listTargets.mockResolvedValue([])
})

describe("scope choice", () => {
  it("offers all three scopes side by side, not behind an advanced toggle", () => {
    renderSetup()
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(3)
    expect(screen.getByText("setup.scopeWindow")).toBeInTheDocument()
    expect(screen.getByText("setup.scopeApplication")).toBeInTheDocument()
    expect(screen.getByText("setup.scopeDesktop")).toBeInTheDocument()
  })

  it("marks the current scope as checked", async () => {
    renderSetup({ scopeKind: "window" })
    await waitFor(() => expect(listTargets).toHaveBeenCalled())
    const checked = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true")
    expect(checked).toHaveLength(1)
    expect(checked[0]).toHaveTextContent("setup.scopeWindow")
  })

  it("says what whole-desktop capture means", () => {
    // The most capable option is also the most invasive; it is the one that has
    // to explain itself.
    renderSetup()
    expect(screen.getByText("setup.scopeDesktopHint")).toBeInTheDocument()
  })

  it("reports a scope change to the caller", async () => {
    const { onScopeKindChange } = renderSetup()
    await userEvent.click(screen.getByText("setup.scopeApplication"))
    expect(onScopeKindChange).toHaveBeenCalledWith("application")
  })
})

describe("capture target", () => {
  it("is not asked for at desktop scope", () => {
    renderSetup({ scopeKind: "desktop" })
    expect(listTargets).not.toHaveBeenCalled()
    expect(screen.queryByText("setup.targetWindow")).not.toBeInTheDocument()
  })

  it("lists the open windows for a window scope", async () => {
    listTargets.mockResolvedValue([
      target({ windowId: 1, appName: "Safari", title: "Invoices" }),
      target({ windowId: 2, appName: "Zed", title: "main.rs" }),
    ])
    renderSetup({ scopeKind: "window" })
    expect(await screen.findByText("Safari")).toBeInTheDocument()
    expect(screen.getByText("Zed")).toBeInTheDocument()
    expect(screen.getByText("Invoices")).toBeInTheDocument()
  })

  it("preselects the focused window so the common case is one click", async () => {
    const focused = target({ windowId: 2, appName: "Zed", focused: true })
    listTargets.mockResolvedValue([target({ windowId: 1 }), focused])
    const { onTargetChange } = renderSetup({ scopeKind: "window" })
    await waitFor(() => expect(onTargetChange).toHaveBeenCalledWith(focused))
  })

  it("clears the selection when the list cannot be read", async () => {
    // Failing closed matters: a null target disables Start, where a silent
    // fallback would have recorded the whole desktop instead.
    listTargets.mockRejectedValue(new Error("ipc down"))
    const { onTargetChange } = renderSetup({ scopeKind: "window" })
    expect(await screen.findByText("setup.targetFailed")).toBeInTheDocument()
    expect(onTargetChange).toHaveBeenCalledWith(null)
  })

  it("says so when nothing else is open", async () => {
    listTargets.mockResolvedValue([])
    renderSetup({ scopeKind: "application" })
    expect(await screen.findByText("setup.targetEmpty")).toBeInTheDocument()
  })

  it("reports the picked target to the caller", async () => {
    const zed = target({ windowId: 2, appName: "Zed", title: "main.rs" })
    listTargets.mockResolvedValue([target({ windowId: 1, focused: true }), zed])
    const { onTargetChange } = renderSetup({ scopeKind: "window" })
    await screen.findByText("Zed")
    onTargetChange.mockClear()
    await userEvent.click(screen.getByText("Zed"))
    expect(onTargetChange).toHaveBeenCalledWith(zed)
  })

  it("hides the per-window title under application scope", async () => {
    // Application scope follows every window of the app, so a single window's
    // title would describe less than what is actually captured.
    listTargets.mockResolvedValue([target({ appName: "Safari", title: "Invoices" })])
    renderSetup({ scopeKind: "application" })
    expect(await screen.findByText("Safari")).toBeInTheDocument()
    expect(screen.queryByText("Invoices")).not.toBeInTheDocument()
  })

  it("flags a minimized window rather than silently recording nothing", async () => {
    listTargets.mockResolvedValue([target({ minimized: true })])
    renderSetup({ scopeKind: "window" })
    expect(await screen.findByText("setup.targetMinimized")).toBeInTheDocument()
  })

  it("re-enumerates on refresh, because the desktop moves on", async () => {
    listTargets.mockResolvedValue([target()])
    renderSetup({ scopeKind: "window" })
    await screen.findByText("Safari")
    await userEvent.click(screen.getByRole("button", { name: /setup\.targetRefresh/ }))
    await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(2))
  })
})

describe("screenshot option", () => {
  it("is on by default and writes the user's choice to the store", async () => {
    renderSetup()
    const toggle = screen.getByRole("switch")
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(useRecorderStore.getState().options.captureScreenshots).toBe(false)
  })
})

describe("preflight", () => {
  it("shows progress while checking", () => {
    useRecorderStore.getState().dispatch({ type: "OPEN", source: "toolbar" })
    useRecorderStore.getState().dispatch({ type: "PREFLIGHT_START" })
    renderSetup()
    expect(screen.getByText("preflight.checking")).toBeInTheDocument()
  })

  it("lists every blocker and offers a retry", async () => {
    // "Permission denied" with no action has told the user nothing they can use.
    useRecorderStore
      .getState()
      .setPreflight(preflight({ ready: false, blockers: ["killSwitchEngaged", "pluginDisabled"] }))
    const { onRetryPreflight } = renderSetup()

    expect(screen.getByText(/preflight\.blocker\.killSwitchEngaged/)).toBeInTheDocument()
    expect(screen.getByText(/preflight\.blocker\.pluginDisabled/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "preflight.retry" }))
    expect(onRetryPreflight).toHaveBeenCalled()
  })

  it("splits a blocker's detail out of its code so the copy can name it", () => {
    useRecorderStore
      .getState()
      .setPreflight(preflight({ ready: false, blockers: ["grantMissing:native:screen"] }))
    renderSetup()
    expect(screen.getByText(/preflight\.blocker\.grantMissing.*native:screen/)).toBeInTheDocument()
  })

  it("says so when local OCR is unavailable, without blocking the recording", () => {
    // Windows reports no OCR backend today; that is honest, not a failure.
    useRecorderStore.getState().setPreflight(preflight({ ocrAvailable: false, ocrBackends: [] }))
    renderSetup()
    expect(screen.getByText("preflight.ocrUnavailable")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "preflight.retry" })).not.toBeInTheDocument()
  })

  it("shows nothing when the check passed cleanly", () => {
    useRecorderStore.getState().setPreflight(preflight())
    renderSetup()
    expect(screen.queryByText("preflight.ocrUnavailable")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "preflight.retry" })).not.toBeInTheDocument()
  })

  it("surfaces a transport error that produced no report at all", () => {
    useRecorderStore.getState().dispatch({ type: "OPEN", source: "toolbar" })
    useRecorderStore.getState().dispatch({ type: "PREFLIGHT_START" })
    useRecorderStore.getState().dispatch({
      type: "PREFLIGHT_FAIL",
      error: { code: "preflightFailed", detail: "ipc down", retriable: true },
    })
    renderSetup()
    expect(screen.getByText(/preflight\.blocker\.preflightFailed.*ipc down/)).toBeInTheDocument()
  })
})

describe("consent", () => {
  it("says up front that starting will ask for permission", () => {
    renderSetup()
    expect(screen.getByText("setup.consentNote")).toBeInTheDocument()
  })
})
