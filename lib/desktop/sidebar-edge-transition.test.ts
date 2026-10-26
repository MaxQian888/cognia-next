/** @jest-environment jsdom */

import { act } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import type { AppSettings } from "@cognia/agent-config-types"
import { runSidebarGesture } from "./sidebar-edge-transition"

interface TransitionStub {
  ready: Promise<void>
  finished: Promise<void>
  skipTransition: jest.Mock
  resolve: () => void
}

let stubs: TransitionStub[] = []

function installViewTransition(): jest.Mock {
  stubs = []
  const start = jest.fn((update: () => void) => {
    let resolve = () => {}
    const finished = new Promise<void>((r) => {
      resolve = r
    })
    const stub: TransitionStub = {
      ready: Promise.resolve(),
      finished,
      skipTransition: jest.fn(),
      resolve,
    }
    stubs.push(stub)
    update()
    return stub
  })
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start })
  return start
}

function rect(px: number): DOMRect {
  return { width: px } as DOMRect
}

function buildShellRow(): {
  aside: HTMLElement
  rail: HTMLElement
  workspace: HTMLElement
  chat: HTMLElement
  group: HTMLElement
  dockPanel: HTMLElement
  outlets: Record<"start" | "center" | "end", HTMLElement>
} {
  const aside = document.createElement("aside")
  aside.id = "conversation-sidebar"
  const rail = document.createElement("aside")
  rail.setAttribute("data-variant", "rail")
  const workspace = document.createElement("div")
  workspace.setAttribute("data-testid", "artifact-workspace-dock")
  const group = document.createElement("div")
  const chat = document.createElement("div")
  chat.id = "artifact-chat"
  chat.setAttribute("data-panel", "")
  const dockPanel = document.createElement("div")
  dockPanel.setAttribute("data-panel", "")
  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-testid", "artifact-dock-wrapper")
  dockPanel.appendChild(wrapper)
  group.append(chat, dockPanel)
  workspace.appendChild(group)
  const outlets = {
    start: document.createElement("div"),
    center: document.createElement("div"),
    end: document.createElement("div"),
  }
  outlets.start.setAttribute("data-title-bar-outlet", "start")
  outlets.center.setAttribute("data-title-bar-outlet", "center")
  outlets.end.setAttribute("data-title-bar-outlet", "end")
  document.body.append(aside, rail, workspace, outlets.start, outlets.center, outlets.end)
  return { aside, rail, workspace, chat, group, dockPanel, outlets }
}

beforeEach(() => {
  stubs = []
  document.body.innerHTML = ""
  delete document.documentElement.dataset.shellEdge
  act(() =>
    useShellColumnsStore.setState({
      widths: { rail: 0, sidebar: 0, dock: 0 },
      targets: { rail: null, sidebar: null, dock: null },
    })
  )
})

afterEach(async () => {
  stubs.forEach((stub) => stub.resolve())
  await Promise.resolve()
  await Promise.resolve()
  Reflect.deleteProperty(document, "startViewTransition")
  document.documentElement.style.viewTransitionName = ""
  delete document.documentElement.dataset.shellEdge
  act(() => useSettingsStore.setState({ settings: null }))
})

describe("runSidebarGesture", () => {
  it("applies directly when the shell row is not mounted", () => {
    const apply = jest.fn()
    runSidebarGesture(apply, 0)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("captures the whole row in one transition and publishes the dock's settled width", async () => {
    const { aside, rail, workspace, chat, group, dockPanel, outlets } = buildShellRow()
    installViewTransition()
    // Collapsing: the 256px aside folds away, the group widens by the same
    // amount, and the dock — a fixed percentage of that group — settles
    // proportionally wider. The store commit lands after the callback, so the
    // settled width is computed, not measured.
    jest.spyOn(aside, "getBoundingClientRect").mockReturnValue(rect(256))
    jest.spyOn(group, "getBoundingClientRect").mockReturnValue(rect(1184))
    jest.spyOn(dockPanel, "getBoundingClientRect").mockReturnValue(rect(384))
    const apply = jest.fn()

    runSidebarGesture(apply, 0)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(aside.style.viewTransitionName).toBe("cognia-shell-sidebar")
    expect(rail.style.viewTransitionName).toBe("cognia-shell-rail")
    expect(workspace.style.viewTransitionName).toBe("cognia-shell-workspace")
    expect(chat.style.viewTransitionName).toBe("cognia-shell-chat")
    expect(outlets.start.style.viewTransitionName).toBe("cognia-shell-outlet-start")
    expect(outlets.center.style.viewTransitionName).toBe("cognia-shell-outlet-center")
    expect(outlets.end.style.viewTransitionName).toBe("cognia-shell-outlet-end")
    expect(document.documentElement.style.viewTransitionName).toBe("none")
    // 384/1184 of the grown 1440px group.
    expect(useShellColumnsStore.getState().targets.dock).toBeCloseTo((384 / 1184) * 1440, 5)

    stubs[0].resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(aside.style.viewTransitionName).toBe("")
    expect(chat.style.viewTransitionName).toBe("")
    expect(useShellColumnsStore.getState().targets.dock).toBeNull()
  })

  it("captures one bounded chat pane regardless of the number of messages", () => {
    const { chat } = buildShellRow()
    const log = document.createElement("div")
    log.setAttribute("role", "log")
    log.style.cssText = "height: 600px; overflow: auto"
    const messages = Array.from({ length: 1000 }, () => document.createElement("article"))
    log.append(...messages)
    chat.append(log)
    installViewTransition()

    runSidebarGesture(jest.fn(), 256)

    expect(chat.style.viewTransitionName).toBe("cognia-shell-chat")
    expect(log.style.viewTransitionName).toBeFalsy()
    expect(messages.every((message) => !message.style.viewTransitionName)).toBe(true)
  })

  it("captures both summary hosts separately from the moving reading column", async () => {
    const { chat } = buildShellRow()
    const summaries = [document.createElement("div"), document.createElement("div")]
    summaries.forEach((summary) => {
      summary.setAttribute("data-testid", "session-summary-stage-host")
      chat.append(summary)
    })
    installViewTransition()

    runSidebarGesture(jest.fn(), 256)

    expect(summaries[0].style.viewTransitionName).toBe("cognia-shell-summary")
    expect(summaries[1].style.viewTransitionName).toBe("cognia-shell-summary-secondary")
    stubs[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(summaries.every((summary) => !summary.style.viewTransitionName)).toBe(true)
  })

  it("shrinks the published dock target by the same share when expanding", () => {
    const { aside, group, dockPanel } = buildShellRow()
    installViewTransition()
    // Expanding: the aside is at 0 and grows to 256, so the group loses that.
    jest.spyOn(aside, "getBoundingClientRect").mockReturnValue(rect(0))
    jest.spyOn(group, "getBoundingClientRect").mockReturnValue(rect(1440))
    jest.spyOn(dockPanel, "getBoundingClientRect").mockReturnValue(rect(467))

    runSidebarGesture(jest.fn(), 256)

    // 467/1440 of the shrunk 1184px group.
    expect(useShellColumnsStore.getState().targets.dock).toBeCloseTo((467 / 1440) * 1184, 5)
  })

  it("keeps a pixel-sized dock at its width — the rail does not scale with the row", () => {
    const { aside, group, dockPanel } = buildShellRow()
    dockPanel.setAttribute("data-size", "48px")
    installViewTransition()
    jest.spyOn(aside, "getBoundingClientRect").mockReturnValue(rect(256))
    jest.spyOn(group, "getBoundingClientRect").mockReturnValue(rect(1184))
    jest.spyOn(dockPanel, "getBoundingClientRect").mockReturnValue(rect(48))

    runSidebarGesture(jest.fn(), 0)

    expect(useShellColumnsStore.getState().targets.dock).toBe(48)
  })

  it("mirrors the persisted sidebar edge for the capture rules", () => {
    buildShellRow()
    installViewTransition()
    act(() => useSettingsStore.setState({ settings: { sidebarSide: "right" } as AppSettings }))

    runSidebarGesture(jest.fn(), 0)

    expect(document.documentElement.dataset.shellEdge).toBe("right")
  })

  it("publishes no dock target when the dock panel cannot be found", () => {
    buildShellRow()
    document.querySelector('[data-testid="artifact-dock-wrapper"]')?.remove()
    installViewTransition()

    runSidebarGesture(jest.fn(), 0)

    expect(useShellColumnsStore.getState().targets.dock).toBeNull()
  })

  it("keeps the workspace transition available when the chat pane is absent", () => {
    const { workspace, chat } = buildShellRow()
    chat.remove()
    const start = installViewTransition()
    const apply = jest.fn()

    runSidebarGesture(apply, 0)

    expect(start).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(workspace.style.viewTransitionName).toBe("cognia-shell-workspace")
  })

  it("takes the instant path when no View Transition support exists", () => {
    const { aside } = buildShellRow()
    const apply = jest.fn()

    runSidebarGesture(apply, 0)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(aside.style.viewTransitionName).toBe("")
    expect(useShellColumnsStore.getState().targets.dock).toBeNull()
  })
})
