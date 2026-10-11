/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const registerEditorMock = jest.fn()
jest.mock("./mobile-glance-provider", () => ({
  useMobileGlanceContext: jest.fn(),
  useRegisterGlanceEditor: () => registerEditorMock(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { pinnedLayout } from "@/hooks/glance/use-mobile-glance"
import {
  pinEntryHome,
  withEditedMobileEntries,
  withMobilePreset,
  withShortcuts,
} from "@/lib/glance/layout-edit"
import {
  DEFAULT_GLANCE_MOBILE_SETTINGS,
  mobileEntriesFromDesktop,
} from "@/lib/glance/mobile-layout"
import { layoutFromPreset } from "@/lib/glance/presets"
import { glanceModulesFor } from "@/lib/glance/registry"
import type { GlancePluginCatalogEntry, GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceMobileSettings } from "@/types/glance/layout"

import { MobileGlanceEditor } from "./mobile-glance-editor"
import { useMobileGlanceContext } from "./mobile-glance-provider"

const useContextMock = useMobileGlanceContext as jest.Mock
const toastSuccess = toast.success as jest.Mock
const toastError = toast.error as jest.Mock

const SETTINGS: GlanceMobileSettings = DEFAULT_GLANCE_MOBILE_SETTINGS
const HOST_LAYOUT: NonNullable<GlanceSnapshotV1["hostLayout"]> = {
  preset: "agent-ops",
  entries: layoutFromPreset("agent-ops"),
} as NonNullable<GlanceSnapshotV1["hostLayout"]>

function setup({
  paired = false,
  hostLayout = null,
  saveResult = null,
  settings = SETTINGS,
  pluginCatalog = [],
}: {
  paired?: boolean
  hostLayout?: GlanceSnapshotV1["hostLayout"] | null
  saveResult?: string | null
  settings?: GlanceMobileSettings
  pluginCatalog?: GlancePluginCatalogEntry[]
} = {}) {
  const save = jest.fn<Promise<string | null>, [GlanceMobileSettings]>(async () => saveResult)
  useContextMock.mockReturnValue({ settings, save, paired, hostLayout, pluginCatalog })
  const view = render(<MobileGlanceEditor />)
  return { ...view, save, user: userEvent.setup() }
}

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("MobileGlanceEditor", () => {
  it("renders the preset switch, the layout editor at touch size and the shortcuts", () => {
    setup()
    expect(screen.getByTestId("mobile-glance-editor")).toBeInTheDocument()
    expect(screen.getByText("Preset")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preset: Balanced" })).toBeInTheDocument()
    expect(screen.getByTestId("glance-layout-editor")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reorder Running" })).toHaveClass("size-10")
    expect(screen.getByRole("heading", { name: "Shortcuts" })).toBeInTheDocument()
    expect(screen.getByTestId("mobile-shortcuts-editor")).toBeInTheDocument()
    // Only modules a phone can show are listed.
    const listed = screen
      .getAllByTestId(/^glance-editor-(row|hidden)-/)
      .map((el) => el.getAttribute("data-testid")?.replace(/^glance-editor-(row|hidden)-/, ""))
    for (const id of listed) expect(glanceModulesFor("mobile")).toContain(id)
  })

  it("applies a preset through save", async () => {
    const { save, user } = setup()
    await user.click(screen.getByRole("button", { name: "Preset: Balanced" }))
    await user.click(await screen.findByRole("menuitem", { name: "Minimal" }))
    expect(save).toHaveBeenCalledWith(withMobilePreset(SETTINGS, "minimal"))
  })

  it("saves a layout edit with withEditedMobileEntries", async () => {
    const { save, user } = setup()
    await user.click(screen.getByRole("button", { name: "Hide Usage" }))
    expect(save).toHaveBeenCalledTimes(1)
    const next = save.mock.calls[0][0]
    const edited = SETTINGS.entries.map((e) => (e.id === "usage" ? { ...e, hidden: true } : e))
    expect(next).toEqual(withEditedMobileEntries(SETTINGS, next.entries))
    expect(next.preset).toBe("custom")
    expect(next.entries.find((e) => e.id === "usage")?.hidden).toBe(true)
    expect(next.entries.filter((e) => !e.hidden).map((e) => e.id)).toEqual(
      edited.filter((e) => !e.hidden).map((e) => e.id)
    )
  })

  it("shows each module's home pin and saves a toggle as pinnedLayout", async () => {
    const { save, user } = setup()
    // balanced: fleet pinned, quota shown but not pinned.
    expect(screen.getByTestId("glance-editor-home-fleet")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("glance-editor-home-quota")).toHaveAttribute("aria-pressed", "false")
    await user.click(screen.getByTestId("glance-editor-home-quota"))
    expect(save).toHaveBeenLastCalledWith(pinnedLayout(SETTINGS, "quota", true))
    expect(save.mock.calls.at(-1)?.[0]).toEqual(
      withEditedMobileEntries(
        SETTINGS,
        pinEntryHome(SETTINGS.entries, "quota", true, glanceModulesFor("mobile"))
      )
    )
    await user.click(screen.getByTestId("glance-editor-home-fleet"))
    expect(save).toHaveBeenLastCalledWith(pinnedLayout(SETTINGS, "fleet", false))
  })

  it("saves a shortcut change with withShortcuts", async () => {
    const { save, user } = setup()
    await user.click(screen.getByRole("button", { name: "Remove Search" }))
    expect(save).toHaveBeenCalledWith(
      withShortcuts(
        SETTINGS,
        SETTINGS.shortcuts.filter((id) => id !== "search")
      )
    )
  })

  it("toasts the error key a save resolves to", async () => {
    const { user } = setup({ saveResult: "errors.requestFailed" })
    await user.click(screen.getByRole("button", { name: "Remove Search" }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Cognia couldn't do that."))
  })

  it("toasts nothing for a save that succeeds", async () => {
    const { save, user } = setup()
    await user.click(screen.getByRole("button", { name: "Remove Search" }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    await Promise.resolve()
    expect(toastError).not.toHaveBeenCalled()
  })

  describe("use desktop layout", () => {
    it("is absent on a phone that is not paired", () => {
      setup({ paired: false, hostLayout: HOST_LAYOUT })
      expect(screen.queryByTestId("mobile-glance-copy-desktop")).not.toBeInTheDocument()
      expect(screen.queryByTestId("mobile-glance-copy-hint")).not.toBeInTheDocument()
    })

    it("is disabled with a hint while no desktop layout was received", async () => {
      const { save, user } = setup({ paired: true, hostLayout: null })
      const button = screen.getByRole("button", { name: "Use desktop layout" })
      expect(button).toBeDisabled()
      const hint = screen.getByTestId("mobile-glance-copy-hint")
      expect(hint).toHaveTextContent(
        "Open Glance while your desktop is connected to copy its layout."
      )
      expect(button).toHaveAttribute("aria-describedby", hint.id)
      await user.click(button)
      expect(save).not.toHaveBeenCalled()
    })

    it("copies the desktop's entries, keeping the phone's pins, and toasts", async () => {
      const { save, user } = setup({ paired: true, hostLayout: HOST_LAYOUT })
      expect(screen.queryByTestId("mobile-glance-copy-hint")).not.toBeInTheDocument()
      const button = screen.getByRole("button", { name: "Use desktop layout" })
      expect(button).toBeEnabled()
      expect(button).not.toHaveAttribute("aria-describedby")
      await user.click(button)
      expect(save).toHaveBeenCalledWith(
        withEditedMobileEntries(
          SETTINGS,
          mobileEntriesFromDesktop(HOST_LAYOUT.entries, SETTINGS.entries)
        )
      )
      expect(toastSuccess).toHaveBeenCalledWith("Copied your desktop's layout.")
    })
  })

  it("keeps two editors' hints apart", () => {
    useContextMock.mockReturnValue({
      settings: SETTINGS,
      save: jest.fn(async () => null),
      paired: true,
      hostLayout: null,
      pluginCatalog: [],
    })
    render(
      <>
        <MobileGlanceEditor />
        <MobileGlanceEditor />
      </>
    )
    const hints = screen.getAllByTestId("mobile-glance-copy-hint").map((h) => h.id)
    expect(new Set(hints).size).toBe(2)
    for (const editor of screen.getAllByTestId("mobile-glance-editor")) {
      const button = within(editor).getByRole("button", { name: "Use desktop layout" })
      const hint = within(editor).getByTestId("mobile-glance-copy-hint")
      expect(button).toHaveAttribute("aria-describedby", hint.id)
    }
  })

  describe("plugin modules", () => {
    const CI: GlancePluginCatalogEntry = {
      id: "plugin:com.ci:status",
      pluginId: "com.ci",
      title: "CI",
      icon: null,
      sizes: ["compact"],
      platforms: ["mobile"],
    }

    it("registers itself so a paired phone asks for the desktop's catalogue", () => {
      registerEditorMock.mockClear()
      setup()
      expect(registerEditorMock).toHaveBeenCalled()
    })

    it("adds a catalogue module shown in the drawer and off the home screen", async () => {
      const { save, user } = setup({ pluginCatalog: [CI] })
      await user.click(screen.getByRole("button", { name: "Add CI" }))
      const saved = save.mock.calls.at(-1)![0]
      expect(saved.entries.find((e) => e.id === CI.id)).toEqual({
        id: CI.id,
        size: "compact",
        hidden: false,
        home: false,
      })
    })

    it("pins a shown plugin module to the home screen", async () => {
      const settings = withEditedMobileEntries(SETTINGS, [
        ...SETTINGS.entries,
        { id: CI.id, size: "compact", hidden: false, home: false },
      ])
      const { save, user } = setup({ settings, pluginCatalog: [CI] })
      await user.click(screen.getByTestId(`glance-editor-home-${CI.id}`))
      expect(save).toHaveBeenLastCalledWith(pinnedLayout(settings, CI.id, true, [CI.id]))
    })
  })
})
