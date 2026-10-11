import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => {
  const t = Object.assign(
    (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    { has: () => true }
  )
  return {
    useTranslations: () => t,
    useFormatter: () => ({
      relativeTime: () => "just now",
      number: (value: number) => String(value),
      dateTime: () => "date",
    }),
  }
})

jest.mock("@/lib/pet/reveal", () => ({ schedulePetWindowReveal: jest.fn(() => () => {}) }))
jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  closeTrayPanel: jest.fn().mockResolvedValue(true),
  onTrayPanelResult: jest.fn(),
  onTrayPanelVisibility: jest.fn(),
  resizeTrayPanel: jest.fn().mockResolvedValue(true),
  runNativeTrayAction: jest.fn().mockResolvedValue(true),
  sendTrayPanelRequest: jest.fn().mockResolvedValue(true),
}))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/hooks/glance/use-glance-consumer", () => ({ useGlanceConsumer: jest.fn() }))

import { TooltipProvider } from "@/components/ui/tooltip"
import { useGlanceConsumer } from "@/hooks/glance/use-glance-consumer"
import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceFleetSlice, GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { showMainWindow } from "@/lib/tauri/pet-window"
import {
  closeTrayPanel,
  onTrayPanelResult,
  onTrayPanelVisibility,
  resizeTrayPanel,
  runNativeTrayAction,
  sendTrayPanelRequest,
} from "@/lib/tauri/tray-panel"
import { __resetTrayPanelStoreForTesting, useTrayPanelStore } from "@/lib/tray-panel/store"
import type { TrayPanelAction } from "@/lib/tray-panel/types"
import { GLANCE_MAX_HEIGHT_MAX, GLANCE_WIDTH_PX } from "@/types/glance/layout"

import { seedValues } from "./tray-panel-runner"
import {
  TRAY_PANEL_CONSUMER,
  TRAY_PANEL_WINDOW_LABEL,
  TrayPanelView,
  placeholderSnapshot,
  trayPanelStatus,
} from "./tray-panel-view"

const consumerMock = useGlanceConsumer as jest.Mock
const sendRequestMock = sendTrayPanelRequest as jest.Mock
const runNativeMock = runNativeTrayAction as jest.Mock
const closeMock = closeTrayPanel as jest.Mock
const resizeMock = resizeTrayPanel as jest.Mock
const showMainWindowMock = showMainWindow as jest.Mock
const onVisibilityMock = onTrayPanelVisibility as jest.Mock
const onResultMock = onTrayPanelResult as jest.Mock
let visibilityHandler: ((shown: boolean) => void) | undefined
let resultHandler: ((result: { ok: boolean; error?: string }) => void) | undefined
let glanceSnapshot: GlanceSnapshotV1 | null
let glanceSend: jest.Mock<Promise<string | null>, [unknown]>

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

/** The app runtime mounts a TooltipProvider above every route; mirror it. */
function render(ui: React.ReactElement) {
  return rtlRender(ui, { wrapper: TooltipProvider })
}

function fleet(working: number, awaiting: number): GlanceFleetSlice {
  return {
    updatedAt: 1,
    counts: { working, awaiting, failed: 0 },
    total: working + awaiting,
    rows: [],
  }
}

function snapshotWith(patch: Partial<GlanceSnapshotV1> = {}): GlanceSnapshotV1 {
  return { ...placeholderSnapshot(), epoch: 1, revision: 1, generatedAt: Date.now(), ...patch }
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
  resizeMock.mockClear().mockResolvedValue(true)
  showMainWindowMock.mockClear()
  visibilityHandler = undefined
  resultHandler = undefined
  onVisibilityMock.mockReset().mockImplementation(async (handler: (shown: boolean) => void) => {
    visibilityHandler = handler
    return () => {}
  })
  onResultMock.mockReset().mockImplementation(async (handler: typeof resultHandler) => {
    resultHandler = handler
    return () => {}
  })
  glanceSnapshot = null
  glanceSend = jest.fn().mockResolvedValue(null)
  consumerMock
    .mockReset()
    .mockImplementation(() => ({ snapshot: glanceSnapshot, send: glanceSend }))
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

describe("placeholderSnapshot", () => {
  it("is the shipped layout with every slice still loading", () => {
    const snap = placeholderSnapshot()
    expect(snap.config).toEqual(DEFAULT_GLANCE_PANEL_SETTINGS)
    expect(snap.epoch).toBe(0)
    expect(snap.revision).toBe(0)
    for (const slice of [
      "fleet",
      "usage",
      "quota",
      "agenda",
      "activity",
      "recents",
      "pet",
    ] as const) {
      expect(snap[slice]).toBeNull()
    }
  })
})

describe("trayPanelStatus", () => {
  it("is idle with nothing going on", () => {
    expect(trayPanelStatus(snapshotWith())).toEqual({ kind: "idle" })
  })

  it("prefers the Fleet counts", () => {
    expect(trayPanelStatus(snapshotWith({ fleet: fleet(2, 0) }))).toEqual({
      kind: "running",
      running: 2,
    })
    expect(trayPanelStatus(snapshotWith({ fleet: fleet(2, 1) }))).toEqual({
      kind: "awaiting",
      running: 2,
      awaiting: 1,
    })
  })

  it("falls back to the tray state without a Fleet slice", () => {
    const base = placeholderSnapshot().when
    const when = { ...base, chat: { ...base.chat, activeCount: 3, awaitingApproval: true } }
    expect(trayPanelStatus(snapshotWith({ when }))).toEqual({
      kind: "awaiting",
      running: 3,
      awaiting: 1,
    })
  })

  it("puts a running automation above everything", () => {
    const base = placeholderSnapshot().when
    const when = { ...base, automation: { ...base.automation, running: true } }
    expect(trayPanelStatus(snapshotWith({ when, fleet: fleet(1, 1) }))).toEqual({
      kind: "automation",
    })
  })
})

describe("TrayPanelView", () => {
  it("holds a glance lease under its own consumer and window label", async () => {
    setActions([openApp])
    render(<TrayPanelView />)
    await screen.findByTestId("tray-panel-card")
    expect(consumerMock).toHaveBeenLastCalledWith(
      TRAY_PANEL_CONSUMER,
      TRAY_PANEL_WINDOW_LABEL,
      true
    )
  })

  it("ends the lease when the panel is hidden and renews it on the next reveal", async () => {
    setActions([openApp])
    render(<TrayPanelView />)
    await waitFor(() => expect(visibilityHandler).toBeDefined())

    act(() => visibilityHandler?.(false))
    expect(consumerMock).toHaveBeenLastCalledWith(
      TRAY_PANEL_CONSUMER,
      TRAY_PANEL_WINDOW_LABEL,
      false
    )

    await act(async () => visibilityHandler?.(true))
    expect(consumerMock).toHaveBeenLastCalledWith(
      TRAY_PANEL_CONSUMER,
      TRAY_PANEL_WINDOW_LABEL,
      true
    )
  })

  it("says it is connecting until the first snapshot, then how fresh it is", async () => {
    setActions([openApp])
    const { rerender } = render(<TrayPanelView />)
    expect(await screen.findByTestId("tray-panel-updated")).toHaveTextContent("footer.connecting")

    glanceSnapshot = snapshotWith()
    rerender(<TrayPanelView />)
    expect(screen.getByTestId("tray-panel-updated")).toHaveTextContent(
      'footer.updated:{"when":"just now"}'
    )
  })

  it("sizes the card from the stored width and max height", async () => {
    glanceSnapshot = snapshotWith({
      config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "wide", maxHeight: 500 },
    })
    setActions([openApp])
    render(<TrayPanelView />)
    const card = await screen.findByTestId("tray-panel-card")
    expect(card).toHaveAttribute("data-width", "wide")
    expect(card.style.width).toBe(`${GLANCE_WIDTH_PX.wide}px`)
    expect(card.style.maxHeight).toBe("500px")
  })

  it("renders only the visible modules of the stored layout, in order", async () => {
    glanceSnapshot = snapshotWith({
      config: {
        ...DEFAULT_GLANCE_PANEL_SETTINGS,
        entries: [
          { id: "quota", size: "standard", hidden: false },
          { id: "fleet", size: "standard", hidden: false },
          { id: "usage", size: "standard", hidden: true },
        ],
      },
    })
    setActions([openApp])
    const { container } = render(<TrayPanelView />)
    await screen.findByTestId("tray-panel-card")
    const ids = [...container.querySelectorAll("[data-glance-module]")].map((el) =>
      el.getAttribute("data-glance-module")
    )
    expect(ids).toEqual(["quota", "fleet"])
  })

  it("fits the native window to the card without repositioning it", async () => {
    setActions([openApp])
    const width = jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(380)
    const height = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(420)
    try {
      render(<TrayPanelView />)
      await waitFor(() => expect(resizeMock).toHaveBeenCalledWith(396, 436))
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  describe("header", () => {
    it("routes the status pill to the waiting tasks in Fleet and steps aside", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({ fleet: fleet(2, 1) })
      setActions([openApp])
      render(<TrayPanelView />)

      const pill = await screen.findByTestId("tray-panel-status")
      expect(pill).toHaveTextContent('status.awaiting:{"running":2,"awaiting":1}')
      await user.click(pill)

      expect(glanceSend).toHaveBeenCalledWith({ kind: "open-fleet", filter: "awaiting" })
      await waitFor(() => expect(closeMock).toHaveBeenCalled())
    })

    it("uses the short status at the narrow width", async () => {
      glanceSnapshot = snapshotWith({
        fleet: fleet(2, 1),
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "narrow" },
      })
      setActions([openApp])
      render(<TrayPanelView />)
      expect(await screen.findByTestId("tray-panel-status")).toHaveTextContent(
        "status.awaitingShort"
      )
    })

    it("routes a running pill to Fleet without a filter", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({ fleet: fleet(3, 0) })
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-status"))
      expect(glanceSend).toHaveBeenCalledWith({ kind: "open-fleet" })
    })

    it("disables the pill when idle", async () => {
      glanceSnapshot = snapshotWith()
      setActions([openApp])
      render(<TrayPanelView />)
      const pill = await screen.findByTestId("tray-panel-status")
      expect(pill).toBeDisabled()
      expect(pill).toHaveTextContent("status.idle")
    })

    it("stays open and says why when a route fails", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({ fleet: fleet(1, 0) })
      glanceSend.mockResolvedValue("errors.deliveryFailed")
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-status"))

      expect(await screen.findByRole("alert")).toHaveTextContent("errors.deliveryFailed")
      expect(closeMock).not.toHaveBeenCalled()
    })

    it("asks the main window to refresh every slice", async () => {
      const user = userEvent.setup()
      let finish: (value: string | null) => void = () => {}
      glanceSend.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
      setActions([openApp])
      render(<TrayPanelView />)

      const button = await screen.findByRole("button", { name: "refresh" })
      await user.click(button)
      expect(glanceSend).toHaveBeenCalledWith({ kind: "refresh" })
      expect(button).toBeDisabled()

      await act(async () => finish(null))
      expect(button).not.toBeDisabled()
    })

    it("opens settings through the native action", async () => {
      const user = userEvent.setup()
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByRole("button", { name: "openSettings" }))
      await waitFor(() => expect(runNativeMock).toHaveBeenCalledWith("settings"))
    })

    it("closes from the close button", async () => {
      const user = userEvent.setup()
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByRole("button", { name: "dismiss" }))
      expect(closeMock).toHaveBeenCalled()
    })

    it("switches the scope to the open workspace", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({ workspace: { id: "p1", name: "Atlas" } })
      setActions([openApp])
      render(<TrayPanelView />)

      await user.click(await screen.findByRole("button", { name: "scope.label" }))
      await user.click(await screen.findByRole("menuitem", { name: /scope\.workspace/ }))
      expect(glanceSend).toHaveBeenCalledWith({ kind: "set-scope", scope: "workspace" })
    })

    it("does not re-send the scope already in effect", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({ workspace: { id: "p1", name: "Atlas" } })
      setActions([openApp])
      render(<TrayPanelView />)

      await user.click(await screen.findByRole("button", { name: "scope.label" }))
      await user.click(await screen.findByRole("menuitem", { name: /scope\.all/ }))
      expect(glanceSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "set-scope" }))
    })

    it("shows the workspace name while scoped to it", async () => {
      glanceSnapshot = snapshotWith({
        workspace: { id: "p1", name: "Atlas" },
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, scope: "workspace" },
      })
      setActions([openApp])
      render(<TrayPanelView />)
      expect(await screen.findByRole("button", { name: "scope.label" })).toHaveTextContent("Atlas")
    })

    it("cannot scope to a workspace when none is open", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({ workspace: null })
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByRole("button", { name: "scope.label" }))
      expect(await screen.findByRole("menuitem", { name: /scope\.noWorkspace/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })
  })

  describe("resize grip", () => {
    it("steps the max height with the arrow keys", async () => {
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, maxHeight: 600 },
      })
      setActions([openApp])
      render(<TrayPanelView />)
      const grip = await screen.findByTestId("tray-panel-resize")
      expect(grip).toHaveAttribute("aria-valuenow", "600")

      fireEvent.keyDown(grip, { key: "ArrowDown" })
      expect(glanceSend).toHaveBeenLastCalledWith({ kind: "set-max-height", maxHeight: 640 })
      fireEvent.keyDown(grip, { key: "ArrowUp" })
      expect(glanceSend).toHaveBeenLastCalledWith({ kind: "set-max-height", maxHeight: 560 })
    })

    it("clamps the stepped height to the allowed range", async () => {
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, maxHeight: GLANCE_MAX_HEIGHT_MAX },
      })
      setActions([openApp])
      render(<TrayPanelView />)
      fireEvent.keyDown(await screen.findByTestId("tray-panel-resize"), { key: "ArrowDown" })
      expect(glanceSend).toHaveBeenLastCalledWith({
        kind: "set-max-height",
        maxHeight: GLANCE_MAX_HEIGHT_MAX,
      })
    })

    it("does not dismiss the panel on the grip's own arrow keys", async () => {
      setActions([openApp])
      render(<TrayPanelView />)
      const grip = await screen.findByTestId("tray-panel-resize")
      fireEvent.keyDown(grip, { key: "ArrowUp" })
      expect(closeMock).not.toHaveBeenCalled()
    })

    it("commits a dragged height once the pointer is released", async () => {
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, maxHeight: 600 },
      })
      setActions([openApp])
      render(<TrayPanelView />)
      const card = await screen.findByTestId("tray-panel-card")
      jest.spyOn(card, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect)
      const grip = screen.getByTestId("tray-panel-resize")
      grip.setPointerCapture = jest.fn()

      fireEvent.pointerDown(grip, { clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(grip, { clientY: 160, pointerId: 1 })
      expect(card.style.maxHeight).toBe("460px")
      fireEvent.pointerUp(grip, { pointerId: 1 })

      await waitFor(() =>
        expect(glanceSend).toHaveBeenCalledWith({ kind: "set-max-height", maxHeight: 460 })
      )
    })
  })

  describe("keyboard", () => {
    // jsdom lays nothing out, so every element reads as hidden; treat
    // attached elements as visible for the arrow-key walk.
    let offsetParent: jest.SpyInstance
    beforeEach(() => {
      offsetParent = jest
        .spyOn(HTMLElement.prototype, "offsetParent", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.parentElement
        })
      HTMLElement.prototype.scrollIntoView = jest.fn()
    })
    afterEach(() => offsetParent.mockRestore())

    it("walks the rows with the arrow keys", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({
        config: {
          ...DEFAULT_GLANCE_PANEL_SETTINGS,
          entries: [{ id: "quick", size: "standard", hidden: false }],
        },
      })
      setActions([openApp, withFields])
      render(<TrayPanelView />)
      const first = await screen.findByTestId("tray-panel-action-openApp")
      const second = screen.getByTestId("tray-panel-action-search")

      await user.keyboard("{ArrowDown}")
      expect(first).toHaveFocus()
      await user.keyboard("{ArrowDown}")
      expect(second).toHaveFocus()
      await user.keyboard("{ArrowDown}")
      expect(second).toHaveFocus()
      await user.keyboard("{ArrowUp}")
      expect(first).toHaveFocus()
    })

    it("opens and closes an expandable row with → and ←", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({
        config: {
          ...DEFAULT_GLANCE_PANEL_SETTINGS,
          entries: [{ id: "quick", size: "standard", hidden: false }],
        },
      })
      setActions([withFields])
      render(<TrayPanelView />)
      const row = await screen.findByTestId("tray-panel-action-search")
      row.focus()

      await user.keyboard("{ArrowRight}")
      expect(row).toHaveAttribute("aria-expanded", "true")
      row.focus()
      await user.keyboard("{ArrowLeft}")
      expect(row).toHaveAttribute("aria-expanded", "false")
    })
  })

  it("renders the delegate bar and keeps the primary out of the quick actions", async () => {
    setActions([delegate, openApp])
    render(<TrayPanelView />)

    expect(await screen.findByLabelText("Task")).toBeInTheDocument()
    expect(screen.getByTestId("tray-panel-action-openApp")).toBeInTheDocument()
    expect(screen.queryByTestId("tray-panel-action-delegate")).not.toBeInTheDocument()
  })

  it("focuses the delegate bar on open when autofocus is on", async () => {
    glanceSnapshot = snapshotWith({
      config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, autofocusDelegate: true },
    })
    setActions([delegate])
    render(<TrayPanelView />)
    await waitFor(() => expect(screen.getByLabelText("Task")).toHaveFocus())
  })

  it("leaves focus alone when autofocus is off", async () => {
    glanceSnapshot = snapshotWith({
      config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, autofocusDelegate: false },
    })
    setActions([delegate])
    render(<TrayPanelView />)
    expect(await screen.findByLabelText("Task")).not.toHaveFocus()
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

  it("keeps an empty required prompt from being sent", async () => {
    setActions([delegate])
    render(<TrayPanelView />)
    expect(await screen.findByRole("button", { name: /Delegate/ })).toBeDisabled()
    expect(sendRequestMock).not.toHaveBeenCalled()
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

  it("opens the app from the footer", async () => {
    const user = userEvent.setup()
    setActions([delegate])
    render(<TrayPanelView />)
    await user.click(await screen.findByRole("button", { name: "footer.openApp" }))
    await waitFor(() => expect(runNativeMock).toHaveBeenCalledWith("show"))
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

  it("blocks an expanded action with an empty required field and says why", async () => {
    const user = userEvent.setup()
    setActions([withFields])
    render(<TrayPanelView />)

    await user.click(await screen.findByTestId("tray-panel-action-search"))
    await user.click(screen.getByRole("button", { name: "run" }))
    expect(sendRequestMock).not.toHaveBeenCalled()
    expect(await screen.findByText("errors.required")).toBeInTheDocument()
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

    expect(await screen.findByRole("alert")).toHaveTextContent("errors.deliveryFailed")
    expect(closeMock).not.toHaveBeenCalled()
  })

  it("shows a failure the main window reports back", async () => {
    setActions([openApp])
    render(<TrayPanelView />)
    await waitFor(() => expect(resultHandler).toBeDefined())

    act(() => resultHandler?.({ ok: false, error: "Scheduler is locked" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Scheduler is locked")
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

  it("clears a glance failure on the next reveal", async () => {
    const user = userEvent.setup()
    glanceSnapshot = snapshotWith({ fleet: fleet(1, 0) })
    glanceSend.mockResolvedValue("errors.timeout")
    setActions([openApp])
    render(<TrayPanelView />)
    await user.click(await screen.findByTestId("tray-panel-status"))
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.timeout")

    await act(async () => visibilityHandler?.(true))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
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
