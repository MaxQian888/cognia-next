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
let connectionError: string | null
/** The catalogue the snapshot carries; `null` keeps the snapshot's own. */
let catalogue: TrayPanelAction[] | null
let receivedCount: number
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
    workflows: { running: 0, latest: null },
    rows: [],
  }
}

function snapshotWith(patch: Partial<GlanceSnapshotV1> = {}): GlanceSnapshotV1 {
  return { ...placeholderSnapshot(), epoch: 1, revision: 1, generatedAt: Date.now(), ...patch }
}

/**
 * Seed the catalogue the main window publishes. It rides in the snapshot, so
 * seeding it implies a snapshot has arrived.
 */
function setActions(actions: TrayPanelAction[]) {
  catalogue = actions
}

// One snapshot object per distinct input, like the real consumer's state: a
// fresh object every render would make every memo in the view churn.
let cached: {
  base: GlanceSnapshotV1 | null
  actions: TrayPanelAction[] | null
  out: GlanceSnapshotV1 | null
} | null = null
function currentSnapshot(): GlanceSnapshotV1 | null {
  if (cached && cached.base === glanceSnapshot && cached.actions === catalogue) return cached.out
  const base = glanceSnapshot ?? (catalogue ? snapshotWith() : null)
  const out = base && catalogue ? { ...base, actions: catalogue } : base
  cached = { base: glanceSnapshot, actions: catalogue, out }
  return out
}

beforeEach(() => {
  catalogue = null
  cached = null
  receivedCount = 0
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
  connectionError = null
  glanceSend = jest.fn().mockResolvedValue(null)
  consumerMock.mockReset().mockImplementation(() => {
    const snapshot = currentSnapshot()
    return {
      snapshot,
      receivedCount: snapshot ? Math.max(1, receivedCount) : receivedCount,
      connectionError,
      send: glanceSend,
    }
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
    const { rerender } = render(<TrayPanelView />)
    expect(await screen.findByTestId("tray-panel-updated")).toHaveTextContent("footer.connecting")

    glanceSnapshot = snapshotWith()
    rerender(<TrayPanelView />)
    expect(screen.getByTestId("tray-panel-updated")).toHaveTextContent(
      'footer.updated:{"when":"just now"}'
    )
  })

  it("explains a failed first connection instead of showing Connecting forever", async () => {
    connectionError = "errors.timeout"
    const { rerender } = render(<TrayPanelView />)
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.timeout")
    expect(screen.queryByText("footer.connecting")).not.toBeInTheDocument()
    connectionError = null
    glanceSnapshot = snapshotWith()
    rerender(<TrayPanelView />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
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
      await waitFor(() => expect(resizeMock).toHaveBeenCalledWith(476, 436))
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it("expands a clipped native window to the selected width", async () => {
    const width = jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280)
    const height = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(420)
    try {
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "standard" },
      })
      const { rerender } = render(<TrayPanelView />)
      await waitFor(() => expect(resizeMock).toHaveBeenCalledWith(396, 436))
      resizeMock.mockClear()
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "wide" },
      })
      rerender(<TrayPanelView />)
      await waitFor(() => expect(resizeMock).toHaveBeenCalledWith(476, 436))
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

  it("keeps the footer app label available at the narrow width", async () => {
    glanceSnapshot = snapshotWith({ config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "narrow" } })
    render(<TrayPanelView />)
    expect(await screen.findByRole("button", { name: "footer.openApp" })).toHaveTextContent(
      "footer.openApp"
    )
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

  it("renders the catalogue the newest snapshot carries", async () => {
    const updated: TrayPanelAction = { ...openApp, id: "updated", label: "Updated action" }
    setActions([openApp])
    const { rerender } = render(<TrayPanelView />)
    expect(await screen.findByTestId("tray-panel-action-openApp")).toBeInTheDocument()

    setActions([updated])
    rerender(<TrayPanelView />)
    expect(screen.getByTestId("tray-panel-action-updated")).toBeInTheDocument()
    expect(screen.queryByTestId("tray-panel-action-openApp")).not.toBeInTheDocument()
  })

  it("says the actions are loading, and offers no delegate bar, before the first snapshot", async () => {
    render(<TrayPanelView />)
    expect(await screen.findByText("quick.loading")).toBeInTheDocument()
    expect(screen.queryByTestId("tray-panel-primary")).not.toBeInTheDocument()
    expect(screen.queryByText("empty")).not.toBeInTheDocument()
  })

  it("moves the primary action into the quick actions while the delegate bar is hidden", async () => {
    glanceSnapshot = snapshotWith({
      config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, showDelegate: false },
    })
    setActions([delegate, openApp])
    render(<TrayPanelView />)
    expect(await screen.findByTestId("tray-panel-action-delegate")).toBeInTheDocument()
    expect(screen.queryByTestId("tray-panel-primary")).not.toBeInTheDocument()
  })

  it("clears a glance failure on the next reveal", async () => {
    const user = userEvent.setup()
    glanceSnapshot = snapshotWith({ fleet: fleet(1, 0) })
    glanceSend.mockResolvedValue("errors.timeout")
    setActions([openApp])
    render(<TrayPanelView />)
    await user.click(await screen.findByTestId("tray-panel-status"))
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.timeout")

    act(() => visibilityHandler?.(false))
    await act(async () => visibilityHandler?.(true))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("does not treat the first show event after mounting as a second reveal", async () => {
    const user = userEvent.setup()
    glanceSnapshot = snapshotWith({ fleet: fleet(1, 0) })
    glanceSend.mockResolvedValue("errors.timeout")
    setActions([openApp])
    render(<TrayPanelView />)
    await user.click(await screen.findByTestId("tray-panel-status"))
    expect(await screen.findByRole("alert")).toBeInTheDocument()

    await act(async () => visibilityHandler?.(true))
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  describe("open-triggered actions", () => {
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

    it("waits for the first snapshot, then runs once", async () => {
      const { rerender } = render(<TrayPanelView />)
      await act(async () => {})
      expect(sendRequestMock).not.toHaveBeenCalled()

      setActions([openCommand])
      rerender(<TrayPanelView />)
      await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(1))

      receivedCount = 2
      setActions([updatedCommand])
      rerender(<TrayPanelView />)
      await act(async () => {})
      expect(sendRequestMock).toHaveBeenCalledTimes(1)
    })

    it("runs again on every reveal, against the snapshot that arrives after it", async () => {
      setActions([openCommand])
      receivedCount = 1
      const { rerender } = render(<TrayPanelView />)
      await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(1))
      expect(sendRequestMock.mock.calls[0][0].effect).toEqual({
        kind: "command",
        commandId: "refresh",
      })

      act(() => visibilityHandler?.(false))
      act(() => visibilityHandler?.(true))
      await act(async () => {})
      // The snapshot held from before the reveal may predate a settings change.
      expect(sendRequestMock).toHaveBeenCalledTimes(1)

      receivedCount = 2
      setActions([updatedCommand])
      rerender(<TrayPanelView />)
      await waitFor(() => expect(sendRequestMock).toHaveBeenCalledTimes(2))
      expect(sendRequestMock.mock.calls[1][0].effect).toEqual({
        kind: "command",
        commandId: "refresh-updated",
      })
    })
  })

  describe("edit mode", () => {
    it("cannot be entered before the first snapshot", async () => {
      render(<TrayPanelView />)
      expect(await screen.findByTestId("tray-panel-edit")).toBeDisabled()
    })

    it("swaps the stack and the delegate bar for the editor until Done", async () => {
      const user = userEvent.setup()
      setActions([delegate, openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))

      expect(screen.getByTestId("tray-panel-edit-mode")).toBeInTheDocument()
      expect(screen.queryByTestId("tray-panel-primary")).not.toBeInTheDocument()
      expect(screen.queryByTestId("tray-panel-actions")).not.toBeInTheDocument()

      await user.click(screen.getByTestId("tray-panel-edit-done"))
      expect(screen.queryByTestId("tray-panel-edit-mode")).not.toBeInTheDocument()
      expect(screen.getByTestId("tray-panel-primary")).toBeInTheDocument()
    })

    it("sends a hidden module as the new layout and shows it at once", async () => {
      const user = userEvent.setup()
      setActions([openApp])
      const { container } = render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))
      await user.click(screen.getByRole("button", { name: /^hide:.*modules\.fleet\.label/ }))

      const sent = glanceSend.mock.calls.at(-1)?.[0] as {
        kind: string
        entries: { id: string; hidden: boolean }[]
      }
      expect(sent.kind).toBe("set-layout")
      expect(sent.entries.find((e) => e.id === "fleet")?.hidden).toBe(true)
      expect(screen.queryByTestId("glance-editor-row-fleet")).not.toBeInTheDocument()

      await user.click(screen.getByTestId("tray-panel-edit-done"))
      // Back on the stored config until the confirming snapshot lands.
      expect(container.querySelector('[data-glance-module="fleet"]')).toBeInTheDocument()
    })

    it("drops a failed edit back to the stored layout", async () => {
      const user = userEvent.setup()
      glanceSend.mockResolvedValue("errors.requestFailed")
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))
      await user.click(screen.getByRole("button", { name: /^hide:.*modules\.fleet\.label/ }))

      await waitFor(() => expect(screen.getByTestId("glance-editor-row-fleet")).toBeInTheDocument())
      expect(screen.getByRole("alert")).toHaveTextContent("errors.requestFailed")
    })

    it("hides the delegate bar and changes the width from the editor", async () => {
      const user = userEvent.setup()
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "standard" },
      })
      setActions([delegate, openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))

      await user.click(screen.getByRole("switch", { name: "delegate" }))
      expect(glanceSend).toHaveBeenCalledWith({ kind: "set-delegate-visible", visible: false })

      await user.click(screen.getByRole("radio", { name: /^widths\.wide/ }))
      expect(glanceSend).toHaveBeenCalledWith({ kind: "set-width", width: "wide" })
      expect(screen.getByTestId("tray-panel-card")).toHaveAttribute("data-width", "wide")
    })

    it("leaves edit mode on Escape without closing the panel", async () => {
      const user = userEvent.setup()
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))
      await user.keyboard("{Escape}")
      expect(screen.queryByTestId("tray-panel-edit-mode")).not.toBeInTheDocument()
      expect(closeMock).not.toHaveBeenCalled()
    })

    it("ignores chords while editing", async () => {
      const user = userEvent.setup()
      setActions([{ ...openApp, trigger: { kind: "hotkey", chord: "mod+n" } }])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))
      await user.keyboard("{Meta>}n{/Meta}")
      expect(runNativeMock).not.toHaveBeenCalled()
    })

    it("closes the editor on the next reveal", async () => {
      const user = userEvent.setup()
      setActions([openApp])
      render(<TrayPanelView />)
      await user.click(await screen.findByTestId("tray-panel-edit"))
      act(() => visibilityHandler?.(false))
      await act(async () => visibilityHandler?.(true))
      expect(screen.queryByTestId("tray-panel-edit-mode")).not.toBeInTheDocument()
    })
  })

  describe("preset switch", () => {
    it("names the current preset and applies another", async () => {
      const user = userEvent.setup()
      setActions([openApp])
      render(<TrayPanelView />)
      const trigger = await screen.findByRole("button", { name: /editor\.presetLabel/ })
      expect(trigger).toHaveTextContent("presets.balanced")

      await user.click(trigger)
      await user.click(await screen.findByRole("menuitem", { name: /presets\.minimal/ }))
      expect(glanceSend).toHaveBeenCalledWith({ kind: "apply-preset", preset: "minimal" })
    })

    it("says Custom once the layout was edited", async () => {
      glanceSnapshot = snapshotWith({
        config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, preset: "custom" },
      })
      setActions([openApp])
      render(<TrayPanelView />)
      expect(await screen.findByRole("button", { name: /editor\.presetLabel/ })).toHaveTextContent(
        "editor.custom"
      )
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
