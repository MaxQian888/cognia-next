import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/glance/use-glance-sources", () => ({ useGlanceSources: jest.fn() }))
jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  closeTrayPanel: jest.fn().mockResolvedValue(true),
  runNativeTrayAction: jest.fn().mockResolvedValue(true),
  sendTrayPanelRequest: jest.fn().mockResolvedValue(true),
}))

import { placeholderSnapshot } from "@/components/tray-panel/tray-panel-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useGlanceSources, type GlanceSnapshotBody } from "@/hooks/glance/use-glance-sources"
import { DEFAULT_GLANCE_PANEL_SETTINGS, layoutFromPreset } from "@/lib/glance/presets"
import { closeTrayPanel, runNativeTrayAction, sendTrayPanelRequest } from "@/lib/tauri/tray-panel"
import { DEFAULT_TRAY_PANEL_ACTIONS } from "@/lib/tray-panel/defaults"
import type { GlancePanelSettings } from "@/types/glance/layout"

import { TrayPanelPreview } from "./tray-panel-preview"

const sourcesMock = useGlanceSources as jest.Mock

function bodyWith(config: Partial<GlancePanelSettings> = {}): GlanceSnapshotBody {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { version, epoch, revision, ...rest } = placeholderSnapshot()
  return {
    ...rest,
    config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, ...config },
    actions: DEFAULT_TRAY_PANEL_ACTIONS,
  }
}

function renderPreview(config: Partial<GlancePanelSettings> = {}) {
  sourcesMock.mockReturnValue({
    body: bodyWith(config),
    quota: {},
    refreshUsage: jest.fn(),
  })
  return render(
    <TooltipProvider>
      <TrayPanelPreview />
    </TooltipProvider>
  )
}

function card() {
  return screen.getByTestId("tray-panel-preview").querySelector("[data-width]") as HTMLElement
}

function moduleOrder() {
  return Array.from(card().querySelectorAll("[data-glance-module]")).map((el) =>
    el.getAttribute("data-glance-module")
  )
}

beforeEach(() => {
  sourcesMock.mockReset()
  ;(runNativeTrayAction as jest.Mock).mockClear()
  ;(sendTrayPanelRequest as jest.Mock).mockClear()
  ;(closeTrayPanel as jest.Mock).mockClear()
})

describe("TrayPanelPreview", () => {
  it("reads the sources actively but passively: no quota refresh, no login discovery", () => {
    renderPreview()
    expect(sourcesMock).toHaveBeenCalledWith(true, { passive: true })
  })

  it("captions what it shows", () => {
    renderPreview()
    expect(screen.getByText("Preview with your current data")).toBeInTheDocument()
  })

  it("renders the visible modules in layout order", () => {
    renderPreview({ preset: "usage-first", entries: layoutFromPreset("usage-first") })
    expect(moduleOrder()).toEqual(["usage", "quota", "activity", "fleet", "quick"])
  })

  it("follows an edited order and leaves hidden modules out", () => {
    const entries = layoutFromPreset("balanced").map((e) =>
      e.id === "usage" ? { ...e, hidden: true } : e
    )
    const [fleet, , ...rest] = entries
    renderPreview({ preset: "custom", entries: [...rest.slice(0, 3), fleet, ...rest.slice(3)] })
    const order = moduleOrder()
    expect(order).not.toContain("usage")
    expect(order).not.toContain("recents")
    expect(order.indexOf("fleet")).toBeGreaterThan(order.indexOf("quota"))
  })

  describe("size", () => {
    it.each([
      ["narrow", 320],
      ["standard", 380],
      ["wide", 460],
    ] as const)("uses the %s width (%i px)", (width, px) => {
      renderPreview({ width })
      expect(card()).toHaveAttribute("data-width", width)
      expect(card()).toHaveStyle({ width: `${px}px` })
    })

    it("caps its height at the configured max height", () => {
      renderPreview({ maxHeight: 300 })
      expect(card()).toHaveStyle({ maxHeight: "300px" })
    })
  })

  describe("delegate bar", () => {
    it("is shown when the config shows it, and the delegate is not among the quick actions", () => {
      renderPreview({ showDelegate: true })
      expect(screen.getByTestId("tray-panel-primary")).toBeInTheDocument()
      expect(screen.queryByTestId("tray-panel-action-trayPanel.delegate")).not.toBeInTheDocument()
    })

    it("is hidden otherwise, and the delegate action joins the quick actions", () => {
      renderPreview({ showDelegate: false })
      expect(screen.queryByTestId("tray-panel-primary")).not.toBeInTheDocument()
      expect(screen.getByTestId("tray-panel-action-trayPanel.delegate")).toBeInTheDocument()
    })

    it("sits inside the inert card, never focusing itself", () => {
      renderPreview({ showDelegate: true })
      const bar = screen.getByTestId("tray-panel-primary")
      expect(card()).toContainElement(bar)
      expect(bar.querySelector("textarea")).not.toHaveFocus()
    })
  })

  describe("inertness", () => {
    it("marks the whole card inert", () => {
      renderPreview()
      expect(card()).toHaveAttribute("inert")
    })

    it("keeps every control inside the inert card", () => {
      renderPreview()
      const root = screen.getByTestId("tray-panel-preview")
      const controls = root.querySelectorAll("button, input, textarea, select, a[href]")
      expect(controls.length).toBeGreaterThan(0)
      for (const control of controls) expect(card()).toContainElement(control as HTMLElement)
    })

    it("sends nothing to the panel's native or main-window channels on render", () => {
      renderPreview()
      expect(runNativeTrayAction).not.toHaveBeenCalled()
      expect(sendTrayPanelRequest).not.toHaveBeenCalled()
      expect(closeTrayPanel).not.toHaveBeenCalled()
    })
  })
})

describe("TrayPanelPreview clicks", () => {
  // jsdom does not implement `inert`: a browser drops pointer events aimed at an
  // inert subtree before any handler sees them. Emulate exactly that at the
  // document, and rely on the `inert` attribute assertion above for the real
  // thing. What this pins is that the card carries no other path to a send: with
  // the browser's inertness in place, a click on any control does nothing.
  const swallowInert = (event: Event) => {
    if ((event.target as Element).closest("[inert]")) event.stopPropagation()
  }

  beforeEach(() => {
    for (const type of ["click", "pointerdown", "mousedown", "keydown"]) {
      document.addEventListener(type, swallowInert, true)
    }
  })

  afterEach(() => {
    for (const type of ["click", "pointerdown", "mousedown", "keydown"]) {
      document.removeEventListener(type, swallowInert, true)
    }
  })

  it("sends nothing when a quick action is clicked", async () => {
    const user = userEvent.setup()
    renderPreview({ showDelegate: false })
    expect(card()).toHaveAttribute("inert")
    await user.click(screen.getByTestId("tray-panel-action-trayPanel.openApp"))
    await user.click(screen.getByTestId("tray-panel-action-trayPanel.newChat"))
    expect(runNativeTrayAction).not.toHaveBeenCalled()
    expect(sendTrayPanelRequest).not.toHaveBeenCalled()
    expect(closeTrayPanel).not.toHaveBeenCalled()
  })

  it("would have run the action without the emulated inertness (the check is not vacuous)", async () => {
    for (const type of ["click", "pointerdown", "mousedown", "keydown"]) {
      document.removeEventListener(type, swallowInert, true)
    }
    const user = userEvent.setup()
    renderPreview({ showDelegate: false })
    await user.click(screen.getByTestId("tray-panel-action-trayPanel.openApp"))
    expect(runNativeTrayAction).toHaveBeenCalledWith("show")
  })
})
