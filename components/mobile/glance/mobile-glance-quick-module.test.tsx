/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("./mobile-glance-provider", () => ({ useMobileGlanceContext: jest.fn() }))
jest.mock("next/navigation", () => ({ useRouter: jest.fn() }))
jest.mock("@/lib/capacitor/haptics", () => ({ selectionFeedback: jest.fn(async () => {}) }))

import { useRouter } from "next/navigation"
import { GlanceProvider, type GlanceContextValue } from "@/components/glance/glance-context"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { DEFAULT_GLANCE_MOBILE_SETTINGS } from "@/lib/glance/mobile-layout"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { MobileGlanceQuickModule } from "./mobile-glance-quick-module"
import { useMobileGlanceContext, type MobileGlanceShellActions } from "./mobile-glance-provider"

const useContextMock = useMobileGlanceContext as jest.Mock
const useRouterMock = useRouter as jest.Mock
const haptic = selectionFeedback as jest.Mock
const push = jest.fn()

function makeSnapshot(): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 0,
    revision: 0,
    generatedAt: 1_000,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

function setup(shortcuts: string[], size: GlanceModuleSize = "standard") {
  const actions: MobileGlanceShellActions = {
    newChat: jest.fn(),
    search: jest.fn(),
    openSession: jest.fn(),
    editLayout: jest.fn(),
  }
  useContextMock.mockReturnValue({
    settings: { ...DEFAULT_GLANCE_MOBILE_SETTINGS, shortcuts },
    actions,
  })
  const route = jest.fn<void, [GlanceRequestBody]>()
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(),
    platform: "mobile",
    width: "standard",
    now: 1_000,
    send: jest.fn(async () => null),
    route,
  }
  const view = render(
    <GlanceProvider value={value}>
      <MobileGlanceQuickModule size={size} />
    </GlanceProvider>
  )
  return { ...view, actions, route, user: userEvent.setup() }
}

function tileIds(): string[] {
  return screen
    .getAllByTestId(/^mobile-quick-action-/)
    .map((el) => el.getAttribute("data-testid")?.replace("mobile-quick-action-", "") ?? "")
}

beforeEach(() => {
  push.mockReset()
  haptic.mockClear()
  useRouterMock.mockReset().mockReturnValue({ push })
})

describe("MobileGlanceQuickModule", () => {
  describe("standard", () => {
    it("renders the layout's shortcuts in order as a labelled grid, skipping unknown ids", () => {
      setup(["workflows", "nope", "newChat", "me"])
      const section = screen.getByRole("region", { name: "Quick actions" })
      expect(section).toHaveAttribute("data-glance-module", "quick")
      expect(within(section).getByTestId("mobile-quick-actions")).toBeInTheDocument()
      expect(tileIds()).toEqual(["workflows", "newChat", "me"])
      expect(screen.getByTestId("mobile-quick-action-workflows")).toHaveTextContent("Workflows")
      expect(screen.getByTestId("mobile-quick-action-newChat")).toHaveTextContent("New chat")
      expect(screen.getByTestId("mobile-quick-action-me")).toHaveTextContent("Me")
    })

    it("starts a chat and opens search through the shell, with a haptic tick", async () => {
      const { actions, user } = setup(["newChat", "search"])
      await user.click(screen.getByTestId("mobile-quick-action-newChat"))
      expect(actions.newChat).toHaveBeenCalledTimes(1)
      await user.click(screen.getByTestId("mobile-quick-action-search"))
      expect(actions.search).toHaveBeenCalledTimes(1)
      expect(haptic).toHaveBeenCalledTimes(2)
      expect(push).not.toHaveBeenCalled()
    })

    it("pushes a route shortcut's page", async () => {
      const { actions, route, user } = setup(["fleet", "devices"])
      await user.click(screen.getByTestId("mobile-quick-action-devices"))
      expect(push).toHaveBeenCalledWith("/devices")
      await user.click(screen.getByTestId("mobile-quick-action-fleet"))
      expect(push).toHaveBeenLastCalledWith("/fleet")
      expect(actions.newChat).not.toHaveBeenCalled()
      expect(route).not.toHaveBeenCalled()
    })

    it("opens the shortcut editor from the header's Edit link", async () => {
      const { route, user } = setup(["newChat"])
      const edit = screen.getByRole("button", { name: "Edit shortcuts" })
      expect(edit).toHaveTextContent("Edit")
      await user.click(edit)
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "tray-actions" })
    })
  })

  describe("compact", () => {
    it("renders one row of icon buttons with accessible labels", () => {
      setup(["search", "inbox", "twin"], "compact")
      const section = screen.getByRole("region", { name: "Quick actions" })
      expect(within(section).getByText("Quick actions")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-quick-actions")).not.toBeInTheDocument()
      expect(tileIds()).toEqual(["search", "inbox", "twin"])
      const inbox = screen.getByRole("button", { name: "Inbox" })
      expect(inbox).toHaveAttribute("title", "Inbox")
      expect(inbox).toHaveAttribute("data-glance-nav")
      expect(inbox).toHaveTextContent("")
      expect(screen.getByRole("button", { name: "Digital twin" })).toBeInTheDocument()
      // No Edit link at this size: the layout editor is the way in.
      expect(screen.queryByRole("button", { name: "Edit shortcuts" })).not.toBeInTheDocument()
    })

    it("dispatches like the grid", async () => {
      const { actions, user } = setup(["search", "inbox"], "compact")
      await user.click(screen.getByRole("button", { name: "Search" }))
      expect(actions.search).toHaveBeenCalledTimes(1)
      await user.click(screen.getByRole("button", { name: "Inbox" }))
      expect(push).toHaveBeenCalledWith("/inbox")
    })
  })

  describe.each<GlanceModuleSize>(["standard", "compact"])("an empty list (%s)", (size) => {
    it("renders the no-shortcuts row, which opens the shortcut editor", async () => {
      const { route, user } = setup(["nope"], size)
      expect(screen.queryAllByTestId(/^mobile-quick-action-/)).toHaveLength(0)
      expect(screen.getByText("No shortcuts yet — tap to add some.")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Edit shortcuts" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "tray-actions" })
    })
  })
})
