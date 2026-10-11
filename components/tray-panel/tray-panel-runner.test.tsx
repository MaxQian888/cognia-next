import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  closeTrayPanel: jest.fn().mockResolvedValue(true),
  runNativeTrayAction: jest.fn().mockResolvedValue(true),
  sendTrayPanelRequest: jest.fn().mockResolvedValue(true),
}))

import { showMainWindow } from "@/lib/tauri/pet-window"
import { closeTrayPanel, runNativeTrayAction, sendTrayPanelRequest } from "@/lib/tauri/tray-panel"
import type { TrayPanelAction } from "@/lib/tray-panel/types"

import {
  TrayPanelRunnerProvider,
  seedValues,
  useTrayPanelRunner,
  useTrayPanelRunnerState,
  type TrayPanelRunner,
} from "./tray-panel-runner"

const sendMock = sendTrayPanelRequest as jest.Mock
const nativeMock = runNativeTrayAction as jest.Mock
const closeMock = closeTrayPanel as jest.Mock
const showMock = showMainWindow as jest.Mock

const delegate: TrayPanelAction = {
  id: "delegate",
  label: "Delegate",
  trigger: { kind: "submit" },
  fields: [
    { kind: "textarea", id: "prompt", label: "Task", required: true, defaultValue: "draft" },
  ],
  effect: { kind: "delegate", prompt: "{{prompt}}", target: "newSession", autoSend: true },
}

const native: TrayPanelAction = {
  id: "show",
  label: "Open",
  trigger: { kind: "manual" },
  fields: [],
  effect: { kind: "native", action: "show" },
}

const slash: TrayPanelAction = {
  id: "search",
  label: "Search",
  trigger: { kind: "manual" },
  fields: [{ kind: "text", id: "q", label: "Query" }],
  effect: { kind: "slash", command: "search {{nope}}" },
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(true)
  nativeMock.mockReset().mockResolvedValue(true)
  closeMock.mockReset().mockResolvedValue(true)
  showMock.mockReset()
})

function setup(actions: readonly TrayPanelAction[]) {
  return renderHook(({ list }) => useTrayPanelRunnerState(list), {
    initialProps: { list: actions },
  })
}

describe("seedValues", () => {
  it("seeds declared defaults per action", () => {
    expect(seedValues([delegate, native])).toEqual({ delegate: { prompt: "draft" }, show: {} })
  })
})

describe("useTrayPanelRunnerState", () => {
  it("layers typed values over the declared defaults", () => {
    const { result } = setup([delegate])
    expect(result.current.valuesFor("delegate")).toEqual({ prompt: "draft" })
    act(() => result.current.setFieldValue("delegate", "prompt", "Ship it"))
    expect(result.current.valuesFor("delegate")).toEqual({ prompt: "Ship it" })
    expect(result.current.valuesFor("missing")).toEqual({})
  })

  it("re-derives defaults when the catalogue changes", () => {
    const { result, rerender } = setup([delegate])
    const edited: TrayPanelAction = {
      ...delegate,
      fields: [{ kind: "textarea", id: "brief", label: "Brief", defaultValue: "new" }],
    }
    rerender({ list: [edited] })
    expect(result.current.valuesFor("delegate")).toEqual({ brief: "new" })
  })

  it("flags an empty required field, expands its form, and sends nothing", async () => {
    const { result } = setup([delegate])
    act(() => result.current.setFieldValue("delegate", "prompt", ""))
    await act(() => result.current.run(delegate))

    expect(sendMock).not.toHaveBeenCalled()
    expect(result.current.invalidFields("delegate")).toEqual(new Set(["prompt"]))
    expect(result.current.errorMessage("delegate")).toBe("errors.required")
    expect(result.current.expandedId).toBe("delegate")
  })

  it("names an unknown placeholder", async () => {
    const { result } = setup([slash])
    await act(() => result.current.run(slash))
    expect(result.current.errorMessage("search")).toBe('errors.unknownPlaceholder:{"ids":"nope"}')
    expect(result.current.invalidFields("search").size).toBe(0)
  })

  it("clears the errors once the action resolves", async () => {
    const { result } = setup([delegate])
    act(() => result.current.setFieldValue("delegate", "prompt", ""))
    await act(() => result.current.run(delegate))
    act(() => result.current.setFieldValue("delegate", "prompt", "fixed"))
    await act(() => result.current.run(delegate))
    expect(result.current.errorMessage("delegate")).toBeNull()
    expect(result.current.invalidFields("delegate").size).toBe(0)
  })

  it("runs a native action in Rust and dismisses", async () => {
    const { result } = setup([native])
    await act(() => result.current.run(native))
    expect(nativeMock).toHaveBeenCalledWith("show")
    expect(sendMock).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
    expect(result.current.busyId).toBeNull()
  })

  it("keeps the panel open when a native action fails", async () => {
    nativeMock.mockResolvedValue(false)
    const { result } = setup([native])
    await act(() => result.current.run(native))
    expect(result.current.failure).toBe("errors.runFailed")
    expect(closeMock).not.toHaveBeenCalled()
  })

  it("hands a resolved action to the main window, raising it first", async () => {
    const { result } = setup([delegate])
    await act(() => result.current.run(delegate))
    expect(showMock).toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "delegate",
        effect: expect.objectContaining({ prompt: "draft" }),
      })
    )
    expect(closeMock).toHaveBeenCalled()
    // Busy until the main window settles it.
    expect(result.current.busyId).toBe("delegate")
  })

  it("says so when the main window cannot be reached", async () => {
    sendMock.mockResolvedValue(false)
    const { result } = setup([delegate])
    await act(() => result.current.run(delegate))
    expect(result.current.failure).toBe("errors.deliveryFailed")
    expect(result.current.busyId).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it("settles a reported outcome", async () => {
    const { result } = setup([delegate])
    await act(() => result.current.run(delegate))
    act(() => result.current.settle(true))
    expect(result.current.busyId).toBeNull()
    expect(result.current.failure).toBeNull()

    act(() => result.current.settle(false, "Scheduler is locked"))
    expect(result.current.failure).toBe("Scheduler is locked")
    act(() => result.current.settle(false))
    expect(result.current.failure).toBe("errors.runFailed")
  })

  it("drops everything transient on reset", async () => {
    const { result } = setup([delegate])
    act(() => {
      result.current.setFieldValue("delegate", "prompt", "")
      result.current.setExpandedId("delegate")
    })
    await act(() => result.current.run(delegate))
    act(() => result.current.settle(false, "boom"))
    act(() => result.current.reset())

    expect(result.current.valuesFor("delegate")).toEqual({ prompt: "draft" })
    expect(result.current.expandedId).toBeNull()
    expect(result.current.errorMessage("delegate")).toBeNull()
    expect(result.current.failure).toBeNull()
    expect(result.current.busyId).toBeNull()
  })
})

describe("useTrayPanelRunner", () => {
  it("throws outside the provider", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    expect(() => renderHook(() => useTrayPanelRunner())).toThrow(/TrayPanelRunnerProvider/)
    spy.mockRestore()
  })

  it("returns the provided runner", () => {
    const runner = { busyId: "x" } as unknown as TrayPanelRunner
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TrayPanelRunnerProvider runner={runner}>{children}</TrayPanelRunnerProvider>
    )
    const { result } = renderHook(() => useTrayPanelRunner(), { wrapper })
    expect(result.current).toBe(runner)
  })
})
