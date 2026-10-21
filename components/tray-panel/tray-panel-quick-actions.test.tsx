import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"

jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  closeTrayPanel: jest.fn().mockResolvedValue(true),
  runNativeTrayAction: jest.fn().mockResolvedValue(true),
  sendTrayPanelRequest: jest.fn().mockResolvedValue(true),
}))

import { GlanceProvider, type GlanceContextValue } from "@/components/glance/glance-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { runNativeTrayAction, sendTrayPanelRequest } from "@/lib/tauri/tray-panel"
import type { TrayPanelAction } from "@/lib/tray-panel/types"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { TrayPanelQuickActions, TrayPanelQuickActionsProvider } from "./tray-panel-quick-actions"
import { TrayPanelRunnerProvider, useTrayPanelRunnerState } from "./tray-panel-runner"
import { placeholderSnapshot } from "./tray-panel-view"

const nativeMock = runNativeTrayAction as jest.Mock
const sendMock = sendTrayPanelRequest as jest.Mock

const show: TrayPanelAction = {
  id: "show",
  label: "Open window",
  icon: "monitor",
  trigger: { kind: "hotkey", chord: "mod+o" },
  fields: [],
  effect: { kind: "native", action: "show" },
}

const search: TrayPanelAction = {
  id: "search",
  label: "Search",
  trigger: { kind: "manual" },
  fields: [{ kind: "text", id: "q", label: "Query", required: true }],
  effect: { kind: "slash", command: "search {{q}}" },
}

function Harness({
  actions,
  children,
}: {
  actions: readonly TrayPanelAction[] | null
  children: ReactNode
}) {
  const runner = useTrayPanelRunnerState(actions ?? [])
  return (
    <TrayPanelRunnerProvider runner={runner}>
      <TrayPanelQuickActionsProvider actions={actions}>{children}</TrayPanelQuickActionsProvider>
    </TrayPanelRunnerProvider>
  )
}

function renderModule(size: GlanceModuleSize, actions: readonly TrayPanelAction[] | null) {
  const route = jest.fn()
  const glance: GlanceContextValue = {
    snapshot: placeholderSnapshot(),
    platform: "desktop",
    width: "standard",
    now: 0,
    send: jest.fn().mockResolvedValue(null),
    route,
  }
  render(
    <TooltipProvider>
      <GlanceProvider value={glance}>
        <Harness actions={actions}>
          <TrayPanelQuickActions size={size} />
        </Harness>
      </GlanceProvider>
    </TooltipProvider>
  )
  return { route }
}

beforeEach(() => {
  nativeMock.mockReset().mockResolvedValue(true)
  sendMock.mockReset().mockResolvedValue(true)
})

describe("TrayPanelQuickActions", () => {
  describe("before the catalogue has arrived (actions = null)", () => {
    it.each(["compact", "standard"] as const)(
      "reads as loading at %s, not as an empty catalogue",
      (size) => {
        renderModule(size, null)
        expect(screen.getByText("Reading actions…")).toBeInTheDocument()
        expect(
          screen.queryByText("No actions yet — add one in Settings › Desktop.")
        ).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Edit actions" })).not.toBeInTheDocument()
        expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()
      }
    )

    it("shows the module title while loading", () => {
      renderModule("standard", null)
      expect(screen.getByRole("region", { name: "Quick" })).toBeInTheDocument()
    })
  })

  it.each(["compact", "standard"] as const)(
    "shows the empty state at %s with an edit link",
    async (size) => {
      const user = userEvent.setup()
      const { route } = renderModule(size, [])
      expect(
        screen.getByText("No actions yet — add one in Settings › Desktop.")
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Edit actions" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "tray-actions" })
    }
  )

  describe("compact", () => {
    it("keeps every action and its settings link available in a full toolbar", () => {
      const actions = Array.from({ length: 12 }, (_, i) => ({
        ...show,
        id: `action-${i}`,
        label: `Action ${i}`,
      }))
      renderModule("compact", actions)
      for (const action of actions)
        expect(screen.getByRole("button", { name: action.label })).toBeEnabled()
      expect(screen.getByRole("button", { name: "Edit actions" })).toBeEnabled()
    })

    it("renders an icon toolbar named by each action", () => {
      renderModule("compact", [show, search])
      const toolbar = screen.getByRole("toolbar", { name: "Quick" })
      expect(toolbar).toContainElement(screen.getByRole("button", { name: "Open window" }))
      expect(toolbar).toContainElement(screen.getByRole("button", { name: "Search" }))
    })

    it("falls back to initials for an action without a known icon", () => {
      renderModule("compact", [search])
      expect(screen.getByRole("button", { name: "Search" })).toHaveTextContent("Se")
    })

    it("runs an action without inputs on click", async () => {
      const user = userEvent.setup()
      renderModule("compact", [show])
      await user.click(screen.getByRole("button", { name: "Open window" }))
      await waitFor(() => expect(nativeMock).toHaveBeenCalledWith("show"))
    })

    it("opens the form of an action with inputs below the toolbar and toggles it", async () => {
      const user = userEvent.setup()
      renderModule("compact", [search])
      const button = screen.getByRole("button", { name: "Search" })
      expect(button).toHaveAttribute("aria-expanded", "false")

      await user.click(button)
      expect(button).toHaveAttribute("aria-expanded", "true")
      await user.type(screen.getByLabelText("Query"), "dexie")
      await user.click(screen.getByRole("button", { name: "Run" }))
      await waitFor(() =>
        expect(sendMock).toHaveBeenCalledWith(
          expect.objectContaining({ effect: { kind: "slash", line: "/search dexie" } })
        )
      )
    })

    it("collapses the form on a second click", async () => {
      const user = userEvent.setup()
      renderModule("compact", [search])
      const button = screen.getByRole("button", { name: "Search" })
      await user.click(button)
      await user.click(button)
      expect(screen.queryByLabelText("Query")).not.toBeInTheDocument()
    })
  })

  describe("standard", () => {
    it("lists every action with its hotkey", () => {
      renderModule("standard", [show, search])
      expect(screen.getByTestId("tray-panel-action-show")).toHaveTextContent("Open window")
      expect(screen.getByText("mod+o")).toBeInTheDocument()
      expect(screen.getByTestId("tray-panel-action-search")).toHaveAttribute(
        "data-glance-expand",
        "search"
      )
      expect(screen.getByTestId("tray-panel-action-show")).not.toHaveAttribute("data-glance-expand")
    })

    it("shows a validation error inside the open form", async () => {
      const user = userEvent.setup()
      renderModule("standard", [search])
      await user.click(screen.getByTestId("tray-panel-action-search"))
      await user.click(screen.getByRole("button", { name: "Run" }))
      expect(screen.getByText("Fill in the required fields first.")).toBeInTheDocument()
      expect(sendMock).not.toHaveBeenCalled()
    })

    it("submits the open form on Enter in a text field", async () => {
      const user = userEvent.setup()
      renderModule("standard", [search])
      await user.click(screen.getByTestId("tray-panel-action-search"))
      await user.type(screen.getByLabelText("Query"), "notes{Enter}")
      await waitFor(() => expect(sendMock).toHaveBeenCalled())
    })
  })
})
