import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/pet/reveal", () => ({ schedulePetWindowReveal: jest.fn(() => () => {}) }))
jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  closeTrayPanel: jest.fn().mockResolvedValue(true),
  onTrayPanelResult: jest.fn().mockResolvedValue(() => {}),
  onTrayPanelState: jest.fn().mockResolvedValue(() => {}),
  onTrayPanelVisibility: jest.fn(),
  requestTrayPanelState: jest.fn().mockResolvedValue(true),
  resizeTrayPanel: jest.fn().mockResolvedValue(true),
  runNativeTrayAction: jest.fn().mockResolvedValue(true),
  sendTrayPanelRequest: jest.fn().mockResolvedValue(true),
}))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
}))

import { showMainWindow } from "@/lib/tauri/pet-window"
import {
  closeTrayPanel,
  onTrayPanelVisibility,
  runNativeTrayAction,
  sendTrayPanelRequest,
} from "@/lib/tauri/tray-panel"
import { __resetTrayPanelStoreForTesting, useTrayPanelStore } from "@/lib/tray-panel/store"
import type { TrayPanelAction } from "@/lib/tray-panel/types"

import { TrayPanelView, seedValues } from "./tray-panel-view"

const sendRequestMock = sendTrayPanelRequest as jest.Mock
const runNativeMock = runNativeTrayAction as jest.Mock
const closeMock = closeTrayPanel as jest.Mock
const showMainWindowMock = showMainWindow as jest.Mock
const onVisibilityMock = onTrayPanelVisibility as jest.Mock
let visibilityHandler: ((shown: boolean) => void) | undefined

const delegate: TrayPanelAction = {
  id: "delegate",
  label: "Delegate",
  trigger: { kind: "submit" },
  fields: [{ kind: "textarea", id: "prompt", label: "Task", required: true, submitOnEnter: true }],
  effect: { kind: "delegate", prompt: "{{prompt}}", target: "newSession", autoSend: true },
}

const openApp: TrayPanelAction = {
  id: "openApp",
  label: "Open Cognia",
  trigger: { kind: "manual" },
  fields: [],
  effect: { kind: "native", action: "show" },
}

const withFields: TrayPanelAction = {
  id: "search",
  label: "Search",
  trigger: { kind: "manual" },
  fields: [{ kind: "text", id: "q", label: "Query", required: true }],
  effect: { kind: "slash", command: "search {{q}}" },
}

/**
 * Seed the catalogue. `hydrate` is stubbed out alongside it: the view calls it
 * on mount, and the real one would read the (empty) pref store and replace
 * these fixtures with the shipped defaults.
 */
function setActions(actions: TrayPanelAction[]) {
  useTrayPanelStore.setState({ actions, hydrated: true, hydrate: async () => {} })
}

beforeEach(() => {
  __resetTrayPanelStoreForTesting()
  sendRequestMock.mockClear().mockResolvedValue(true)
  runNativeMock.mockClear().mockResolvedValue(true)
  closeMock.mockClear().mockResolvedValue(true)
  showMainWindowMock.mockClear()
  visibilityHandler = undefined
  onVisibilityMock.mockReset().mockImplementation(async (handler: (shown: boolean) => void) => {
    visibilityHandler = handler
    return () => {}
  })
  // The view measures itself; jsdom has no ResizeObserver.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

describe("seedValues", () => {
  it("keys declared defaults by action id", () => {
    expect(seedValues([delegate, withFields])).toEqual({
      delegate: { prompt: "" },
      search: { q: "" },
    })
  })
})

describe("TrayPanelView", () => {
  it("renders the primary action's form and its own action list", async () => {
    setActions([delegate, openApp])
    render(<TrayPanelView />)

    expect(await screen.findByLabelText("Task")).toBeInTheDocument()
    expect(screen.getByTestId("tray-panel-action-openApp")).toBeInTheDocument()
    // The primary must not be duplicated into the secondary list.
    expect(screen.queryByTestId("tray-panel-action-delegate")).not.toBeInTheDocument()
  })

  it("delegates the typed prompt to the main window and dismisses", async () => {
    const user = userEvent.setup()
    setActions([delegate])
    render(<TrayPanelView />)

    await user.type(await screen.findByLabelText("Task"), "Fix the build")
    await user.click(screen.getByRole("button", { name: /Delegate/ }))

    await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(1))
    expect(sendRequestMock.mock.calls[0][0]).toMatchObject({
      actionId: "delegate",
      effect: { kind: "delegate", prompt: "Fix the build", target: "newSession", autoSend: true },
      focusMainWindow: true,
    })
    // Delegating raises the window from here so the feedback is instant.
    expect(showMainWindowMock).toHaveBeenCalled()
    await waitFor(() => expect(closeMock).toHaveBeenCalled())
  })

  it("submits on Enter inside the composer", async () => {
    const user = userEvent.setup()
    setActions([delegate])
    render(<TrayPanelView />)

    await user.type(await screen.findByLabelText("Task"), "Ship it{Enter}")
    await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(1))
  })

  it("blocks an empty required field and says why", async () => {
    const user = userEvent.setup()
    setActions([delegate])
    render(<TrayPanelView />)

    await user.click(await screen.findByRole("button", { name: /Delegate/ }))
    expect(sendRequestMock).not.toHaveBeenCalled()
    expect(await screen.findByText("errors.required")).toBeInTheDocument()
  })

  it("runs a native action through Rust without a main-window round trip", async () => {
    const user = userEvent.setup()
    setActions([openApp])
    render(<TrayPanelView />)

    await user.click(await screen.findByTestId("tray-panel-action-openApp"))
    await waitFor(() => expect(runNativeMock).toHaveBeenCalledWith("show"))
    expect(sendRequestMock).not.toHaveBeenCalled()
    await waitFor(() => expect(closeMock).toHaveBeenCalled())
  })

  it("expands an action that collects input instead of firing it", async () => {
    const user = userEvent.setup()
    setActions([withFields])
    render(<TrayPanelView />)

    const row = await screen.findByTestId("tray-panel-action-search")
    expect(row).toHaveAttribute("aria-expanded", "false")
    await user.click(row)

    expect(row).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByLabelText("Query")).toBeInTheDocument()
    expect(sendRequestMock).not.toHaveBeenCalled()
  })

  it("runs an expanded action with its collected values", async () => {
    const user = userEvent.setup()
    setActions([withFields])
    render(<TrayPanelView />)

    await user.click(await screen.findByTestId("tray-panel-action-search"))
    await user.type(screen.getByLabelText("Query"), "dexie")
    await user.click(screen.getByRole("button", { name: "run" }))

    await waitFor(() => expect(sendRequestMock).toHaveBeenCalled())
    expect(sendRequestMock.mock.calls[0][0].effect).toEqual({
      kind: "slash",
      line: "/search dexie",
    })
  })

  it("runs the action bound to a keyboard chord", async () => {
    const user = userEvent.setup()
    setActions([{ ...openApp, trigger: { kind: "hotkey", chord: "mod+n" } }])
    render(<TrayPanelView />)
    await screen.findByTestId("tray-panel-actions")

    await user.keyboard("{Meta>}n{/Meta}")
    await waitFor(() => expect(runNativeMock).toHaveBeenCalledWith("show"))
  })

  it("dismisses on Escape", async () => {
    const user = userEvent.setup()
    setActions([openApp])
    render(<TrayPanelView />)
    await screen.findByTestId("tray-panel-actions")

    await user.keyboard("{Escape}")
    await waitFor(() => expect(closeMock).toHaveBeenCalled())
  })

  it("surfaces a failed delivery rather than dismissing silently", async () => {
    const user = userEvent.setup()
    sendRequestMock.mockResolvedValue(false)
    setActions([delegate])
    render(<TrayPanelView />)

    await user.type(await screen.findByLabelText("Task"), "x")
    await user.click(screen.getByRole("button", { name: /Delegate/ }))

    expect(await screen.findByText("errors.deliveryFailed")).toBeInTheDocument()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it("hides a when-gated action until its predicate holds", async () => {
    setActions([{ ...openApp, when: "automation.running" }])
    render(<TrayPanelView />)

    expect(await screen.findByText("empty")).toBeInTheDocument()
  })

  it("shows an empty state when there is nothing to run", async () => {
    setActions([delegate])
    render(<TrayPanelView />)
    expect(await screen.findByText("empty")).toBeInTheDocument()
  })

  it("reloads persisted actions whenever the reused panel window is shown", async () => {
    const updated: TrayPanelAction = { ...openApp, id: "updated", label: "Updated action" }
    const hydrate = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce()
      .mockImplementationOnce(async () => {
        useTrayPanelStore.setState({ actions: [updated], hydrated: true })
      })
    useTrayPanelStore.setState({ actions: [openApp], hydrated: true, hydrate })
    render(<TrayPanelView />)

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(visibilityHandler).toBeDefined())
    expect(await screen.findByTestId("tray-panel-action-openApp")).toBeInTheDocument()

    await act(async () => {
      visibilityHandler?.(true)
    })

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId("tray-panel-action-updated")).toBeInTheDocument()
    expect(screen.queryByTestId("tray-panel-action-openApp")).not.toBeInTheDocument()
  })

  it("runs an open-triggered action once on every panel reveal", async () => {
    const openCommand: TrayPanelAction = {
      id: "refresh",
      label: "Refresh",
      trigger: { kind: "open" },
      fields: [],
      effect: { kind: "command", commandId: "refresh" },
    }
    const updatedCommand: TrayPanelAction = {
      ...openCommand,
      effect: { kind: "command", commandId: "refresh-updated" },
    }
    const hydrate = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce()
      .mockImplementationOnce(async () => {
        useTrayPanelStore.setState({ actions: [updatedCommand], hydrated: true })
      })
    useTrayPanelStore.setState({ actions: [openCommand], hydrated: true, hydrate })
    render(<TrayPanelView />)

    await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(1))
    expect(sendRequestMock.mock.calls[0][0].effect).toEqual({
      kind: "command",
      commandId: "refresh",
    })
    await waitFor(() => expect(visibilityHandler).toBeDefined())

    act(() => {
      visibilityHandler?.(true)
    })

    await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(2))
    expect(sendRequestMock.mock.calls[1][0].effect).toEqual({
      kind: "command",
      commandId: "refresh-updated",
    })
  })

  it("marks the page transparent while mounted", () => {
    setActions([openApp])
    const { unmount } = render(<TrayPanelView />)
    expect(document.documentElement.dataset.petOverlay).toBe("1")
    unmount()
    expect(document.documentElement.dataset.petOverlay).toBeUndefined()
  })
})
