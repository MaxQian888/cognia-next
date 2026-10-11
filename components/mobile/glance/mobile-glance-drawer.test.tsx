/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("./mobile-glance-provider", () => ({ useMobileGlanceContext: jest.fn() }))
jest.mock("./mobile-glance-editor", () => ({
  MobileGlanceEditor: () => <div data-testid="mobile-glance-editor-stub" />,
}))
jest.mock("@/hooks/ui/use-back-dismiss", () => ({ useBackDismiss: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@/lib/capacitor/haptics", () => ({ selectionFeedback: jest.fn(async () => {}) }))
// The scope menu reads the active workspace's name, nothing else.
jest.mock("@/stores/project/project-store", () => {
  const state: { projects: { id: string; name: string }[]; activeProjectId: string | null } = {
    projects: [],
    activeProjectId: null,
  }
  return {
    __state: state,
    useProjectStore: <T,>(selector: (s: typeof state) => T): T => selector(state),
  }
})

import { toast } from "sonner"
import type { GlanceContextValue } from "@/components/glance/glance-context"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { withMobilePreset } from "@/lib/glance/layout-edit"
import { DEFAULT_GLANCE_MOBILE_SETTINGS } from "@/lib/glance/mobile-layout"
import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlancePhoneState, GlancePhoneStatus } from "@/lib/glance/remote/phone-store"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import * as projectStoreModule from "@/stores/project/project-store"
import type { GlanceMobileEntry, GlanceMobileSettings } from "@/types/glance/layout"

import { glanceSourceKey, MobileGlanceDrawer } from "./mobile-glance-drawer"
import { useMobileGlanceContext } from "./mobile-glance-provider"

const useContextMock = useMobileGlanceContext as jest.Mock
const useBackDismissMock = useBackDismiss as jest.Mock
const toastError = toast.error as jest.Mock
const projectState = (
  projectStoreModule as unknown as {
    __state: { projects: { id: string; name: string }[]; activeProjectId: string | null }
  }
).__state

const GENERATED_AT = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

function makeSnapshot(): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 0,
    revision: 0,
    generatedAt: GENERATED_AT,
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

const ENTRIES: GlanceMobileEntry[] = [
  { id: "recents", size: "compact", hidden: false, home: true },
  { id: "usage", size: "compact", hidden: false, home: false },
  { id: "pet", size: "standard", hidden: true, home: false },
  { id: "quick", size: "standard", hidden: false, home: true },
  { id: "agenda", size: "compact", hidden: false, home: false },
]

interface Arrange {
  open?: boolean
  entries?: GlanceMobileEntry[]
  scope?: GlanceMobileSettings["scope"]
  paired?: boolean
  supported?: boolean | null
  remote?: Partial<GlancePhoneState>
  send?: (body: GlanceRequestBody) => Promise<string | null>
  save?: jest.Mock<Promise<string | null>, [GlanceMobileSettings]>
}

/**
 * Render the drawer under a harness that owns `drawerOpen`, so closing the
 * drawer really closes it and the reopen button opens it again.
 */
function setup(options: Arrange = {}) {
  const settings: GlanceMobileSettings = {
    ...DEFAULT_GLANCE_MOBILE_SETTINGS,
    entries: options.entries ?? ENTRIES,
    scope: options.scope ?? "all",
    shortcuts: ["newChat"],
  }
  const send = jest.fn(options.send ?? (async () => null))
  const save = options.save ?? jest.fn(async () => null)
  const glance: GlanceContextValue = {
    snapshot: makeSnapshot(),
    platform: "mobile",
    width: "standard",
    now: GENERATED_AT + 60_000,
    send,
    route: jest.fn(),
    originOf: () => null,
  }
  const remote: GlancePhoneState = {
    status: "idle",
    snapshot: null,
    receivedAt: null,
    hostLabel: null,
    ...options.remote,
  }
  const setDrawerOpenSpy = jest.fn<void, [boolean]>()

  function Harness() {
    const [open, setOpen] = useState(options.open ?? true)
    useContextMock.mockImplementation(() => ({
      drawerOpen: open,
      setDrawerOpen: (next: boolean) => {
        setDrawerOpenSpy(next)
        setOpen(next)
      },
      settings,
      glance,
      remote,
      paired: options.paired ?? false,
      supported: options.supported !== undefined ? options.supported : options.paired === true,
      save,
    }))
    return (
      <>
        <button type="button" data-testid="reopen" onClick={() => setOpen(true)} />
        <MobileGlanceDrawer />
      </>
    )
  }

  const view = render(<Harness />)
  return { ...view, settings, send, save, setDrawerOpenSpy, user: userEvent.setup() }
}

function moduleIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("[data-glance-module]")).map(
    (el) => el.getAttribute("data-glance-module") as string
  )
}

// vaul reads the drawer's computed `transform` on pointer release to decide
// whether a press was a drag. jsdom computes none, and vaul calls `.match` on
// it, so report the identity transform a real browser would.
const realGetComputedStyle = window.getComputedStyle.bind(window)
let computedStyleSpy: jest.SpyInstance
beforeAll(() => {
  computedStyleSpy = jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element: Element, pseudo?: string | null) => {
      const style = realGetComputedStyle(element, pseudo)
      if (!style.transform) {
        Object.defineProperty(style, "transform", { value: "none", configurable: true })
      }
      return style
    })
})
afterAll(() => computedStyleSpy.mockRestore())

beforeEach(() => {
  useContextMock.mockReset()
  useBackDismissMock.mockReset()
  toastError.mockClear()
  projectState.projects = []
  projectState.activeProjectId = null
})

describe("glanceSourceKey", () => {
  it("says this phone when not paired, whatever the link reports", () => {
    expect(glanceSourceKey(false, false, "idle")).toBe("source.device")
    expect(glanceSourceKey(false, null, "live")).toBe("source.device")
  })

  it("says unsupported when the desktop does not serve glance", () => {
    expect(glanceSourceKey(true, false, "live")).toBe("source.unsupported")
    expect(glanceSourceKey(true, true, "unsupported")).toBe("source.unsupported")
    expect(glanceSourceKey(true, null, "unsupported")).toBe("source.unsupported")
  })

  it("says pending while the desktop's manifest has not arrived", () => {
    expect(glanceSourceKey(true, null, "live")).toBe("source.pending")
    expect(glanceSourceKey(true, null, "connecting")).toBe("source.pending")
  })

  it.each<[GlancePhoneStatus, string]>([
    ["live", "source.live"],
    ["offline", "source.offline"],
    ["unavailable", "source.unavailable"],
    ["connecting", "source.connecting"],
    ["idle", "source.connecting"],
  ])("maps a supported link's %s status to %s", (status, key) => {
    expect(glanceSourceKey(true, true, status)).toBe(key)
  })
})

describe("MobileGlanceDrawer", () => {
  it("renders nothing while closed", () => {
    setup({ open: false })
    expect(screen.queryByTestId("mobile-glance-drawer")).not.toBeInTheDocument()
    expect(useBackDismissMock).toHaveBeenLastCalledWith(false, expect.any(Function))
  })

  it("renders every visible module, in layout order, in one stack", () => {
    setup()
    const drawer = screen.getByTestId("mobile-glance-drawer")
    expect(within(drawer).getByText("Glance")).toBeInTheDocument()
    expect(within(drawer).getAllByTestId("glance-stack")).toHaveLength(1)
    // Home pins do not matter in the drawer; hidden modules do.
    expect(moduleIds(within(drawer).getByTestId("glance-stack"))).toEqual([
      "recents",
      "usage",
      "quick",
      "agenda",
    ])
  })

  it("arms Android back while open, and back closes the drawer", () => {
    const { setDrawerOpenSpy } = setup()
    expect(useBackDismissMock).toHaveBeenLastCalledWith(true, expect.any(Function))
    const dismiss = useBackDismissMock.mock.calls.at(-1)?.[1] as () => void
    act(() => dismiss())
    expect(setDrawerOpenSpy).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId("mobile-glance-drawer")).not.toBeInTheDocument()
  })

  describe("source line", () => {
    it("says the data is this phone's own when not paired", () => {
      setup()
      expect(screen.getByTestId("mobile-glance-source")).toHaveTextContent("On this phone")
      expect(screen.getByTestId("mobile-glance-source")).not.toHaveClass("text-warning")
    })

    it("names the live desktop", () => {
      setup({ paired: true, remote: { status: "live", hostLabel: "MacBook" } })
      expect(screen.getByTestId("mobile-glance-source")).toHaveTextContent("From MacBook")
      expect(screen.getByTestId("mobile-glance-source")).not.toHaveClass("text-warning")
    })

    it("falls back to 'your desktop' without a host label, and warns off the live link", () => {
      setup({ paired: true, remote: { status: "offline", hostLabel: null } })
      const source = screen.getByTestId("mobile-glance-source")
      expect(source).toHaveTextContent("your desktop is offline — showing the last reading")
      expect(source).toHaveClass("text-warning")
    })

    it("says when the desktop's manifest is still on its way", () => {
      setup({ paired: true, supported: null, remote: { status: "connecting", hostLabel: "Mini" } })
      expect(screen.getByTestId("mobile-glance-source")).toHaveTextContent(
        "Checking what Mini shares…"
      )
    })
  })

  describe("refresh", () => {
    it("asks for a refresh and shows a spinner while it is pending", async () => {
      let resolve: (value: string | null) => void = () => {}
      const pending = new Promise<string | null>((r) => {
        resolve = r
      })
      const { send, user } = setup({ send: () => pending })
      const button = screen.getByRole("button", { name: "Refresh" })
      expect(button.querySelector(".animate-spin")).toBeNull()
      await user.click(button)
      expect(send).toHaveBeenCalledWith({ kind: "refresh" })
      expect(button).toBeDisabled()
      expect(button.querySelector(".animate-spin")).not.toBeNull()
      await act(async () => resolve(null))
      expect(button).toBeEnabled()
      expect(button.querySelector(".animate-spin")).toBeNull()
      expect(toastError).not.toHaveBeenCalled()
    })

    it("toasts the error a refresh resolves to", async () => {
      const { user } = setup({ send: async () => "errors.hostUnreachable" })
      await user.click(screen.getByRole("button", { name: "Refresh" }))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't reach your desktop."))
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled()
    })
  })

  describe("scope", () => {
    it("offers All and disables the workspace option without an open workspace", async () => {
      const { save, user } = setup()
      const trigger = screen.getByRole("button", { name: "Show data for" })
      expect(trigger).toHaveTextContent("All")
      await user.click(trigger)
      const none = await screen.findByRole("menuitem", { name: "No workspace open" })
      expect(none).toHaveAttribute("aria-disabled", "true")
      expect(
        screen.getByText("Quota and other account-wide figures are never filtered by workspace.")
      ).toBeInTheDocument()
      // Picking the scope already in force saves nothing.
      await user.click(screen.getByRole("menuitem", { name: "All" }))
      expect(save).not.toHaveBeenCalled()
    })

    it("saves the workspace scope, keeping the rest of the layout", async () => {
      projectState.projects = [{ id: "p1", name: "Acme" }]
      projectState.activeProjectId = "p1"
      const { save, settings, user } = setup()
      await user.click(screen.getByRole("button", { name: "Show data for" }))
      await user.click(await screen.findByRole("menuitem", { name: "Current workspace · Acme" }))
      expect(save).toHaveBeenCalledWith({ ...settings, scope: "workspace" })
    })

    it("shows the workspace's name while scoped to it, and saves All back", async () => {
      projectState.projects = [{ id: "p1", name: "Acme" }]
      projectState.activeProjectId = "p1"
      const { save, settings, user } = setup({ scope: "workspace" })
      const trigger = screen.getByRole("button", { name: "Show data for" })
      expect(trigger).toHaveTextContent("Acme")
      await user.click(trigger)
      await user.click(await screen.findByRole("menuitem", { name: "All" }))
      expect(save).toHaveBeenCalledWith({ ...settings, scope: "all" })
    })

    it("toasts a failed scope save", async () => {
      projectState.projects = [{ id: "p1", name: "Acme" }]
      projectState.activeProjectId = "p1"
      const save = jest.fn(async (_next: GlanceMobileSettings) => "errors.requestFailed")
      const { user } = setup({ save })
      await user.click(screen.getByRole("button", { name: "Show data for" }))
      await user.click(await screen.findByRole("menuitem", { name: "Current workspace · Acme" }))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Cognia couldn't do that."))
    })
  })

  describe("edit mode", () => {
    it("swaps the stack for the layout editor in place, and Done returns", async () => {
      const { user } = setup()
      const edit = screen.getByTestId("mobile-glance-edit")
      expect(edit).toHaveTextContent("Edit")
      await user.click(edit)
      expect(screen.getByTestId("mobile-glance-editor-stub")).toBeInTheDocument()
      expect(screen.queryByTestId("glance-stack")).not.toBeInTheDocument()
      // The header's scope and refresh, and the footer's preset switch, step aside.
      expect(screen.queryByRole("button", { name: "Show data for" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^Preset: / })).not.toBeInTheDocument()
      expect(screen.getByTestId("mobile-glance-drawer")).toBeInTheDocument()

      await user.click(screen.getByTestId("mobile-glance-edit"))
      expect(screen.getByTestId("mobile-glance-edit")).toHaveTextContent("Edit")
      expect(screen.queryByTestId("mobile-glance-editor-stub")).not.toBeInTheDocument()
      expect(screen.getByTestId("glance-stack")).toBeInTheDocument()
    })

    it("labels the edit button Done while editing", async () => {
      const { user } = setup()
      await user.click(screen.getByTestId("mobile-glance-edit"))
      expect(screen.getByTestId("mobile-glance-edit")).toHaveTextContent("Done")
    })

    it("leaves edit mode when Android back closes the drawer", async () => {
      const { user } = setup()
      await user.click(screen.getByTestId("mobile-glance-edit"))
      expect(screen.getByTestId("mobile-glance-editor-stub")).toBeInTheDocument()
      const dismiss = useBackDismissMock.mock.calls.at(-1)?.[1] as () => void
      act(() => dismiss())
      await waitFor(() =>
        expect(screen.queryByTestId("mobile-glance-drawer")).not.toBeInTheDocument()
      )
      await user.click(screen.getByTestId("reopen"))
      expect(await screen.findByTestId("glance-stack")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-glance-editor-stub")).not.toBeInTheDocument()
    })

    it("leaves edit mode when the drawer closes", async () => {
      const { setDrawerOpenSpy, user } = setup()
      await user.click(screen.getByTestId("mobile-glance-edit"))
      expect(screen.getByTestId("mobile-glance-editor-stub")).toBeInTheDocument()
      await user.keyboard("{Escape}")
      await waitFor(() =>
        expect(screen.queryByTestId("mobile-glance-drawer")).not.toBeInTheDocument()
      )
      expect(setDrawerOpenSpy).toHaveBeenCalledWith(false)
      await user.click(screen.getByTestId("reopen"))
      expect(await screen.findByTestId("glance-stack")).toBeInTheDocument()
      expect(screen.queryByTestId("mobile-glance-editor-stub")).not.toBeInTheDocument()
    })
  })

  it("applies a preset from the footer through withMobilePreset", async () => {
    const { save, settings, user } = setup()
    await user.click(screen.getByRole("button", { name: "Preset: Balanced" }))
    await user.click(await screen.findByRole("menuitem", { name: "Agent ops" }))
    expect(save).toHaveBeenCalledWith(withMobilePreset(settings, "agent-ops"))
  })

  describe("updated label", () => {
    it("dates a standalone phone's reading by its own build", () => {
      setup({ remote: { receivedAt: 5 } })
      expect(screen.getByTestId("mobile-glance-updated")).toHaveTextContent(
        `Updated ${iso(GENERATED_AT)}`
      )
    })

    it("dates a paired phone's reading by when the desktop's arrived", () => {
      const received = GENERATED_AT - 30_000
      setup({ paired: true, remote: { status: "live", receivedAt: received, hostLabel: "Mac" } })
      expect(screen.getByTestId("mobile-glance-updated")).toHaveTextContent(
        `Updated ${iso(received)}`
      )
    })

    it("says connecting while a paired phone has no reading yet", () => {
      setup({ paired: true, remote: { status: "connecting", receivedAt: null } })
      expect(screen.getByTestId("mobile-glance-updated")).toHaveTextContent("Connecting…")
    })
  })

  it("offers to add modules when nothing is shown, which opens the editor", async () => {
    const { user } = setup({
      entries: ENTRIES.map((entry) => ({ ...entry, hidden: true })),
    })
    expect(screen.getByText("Nothing is shown in Glance.")).toBeInTheDocument()
    expect(screen.queryByTestId("glance-stack")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Add modules" }))
    expect(screen.getByTestId("mobile-glance-editor-stub")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-glance-edit")).toHaveTextContent("Done")
  })
})
