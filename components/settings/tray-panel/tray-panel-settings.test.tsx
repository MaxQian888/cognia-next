import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useLocale: () => "en",
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/tauri/tray-panel", () => ({
  DEFAULT_TRAY_PANEL_CONFIG: { leftClick: "panel", width: 380, height: 460 },
  getTrayPanelConfig: jest.fn().mockResolvedValue({ leftClick: "panel", width: 380, height: 460 }),
  openTrayPanel: jest.fn().mockResolvedValue(true),
  setTrayLeftClickAction: jest.fn().mockResolvedValue(true),
}))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
}))
// The preview runs the glance source hooks (stores, live queries); it has its
// own test, so a stub keeps this one about the settings editor.
jest.mock("./tray-panel-preview", () => ({
  TrayPanelPreview: () =>
    jest
      .requireActual<typeof import("react")>("react")
      .createElement("div", { "data-testid": "tray-panel-preview-stub" }),
}))

import { isTauri } from "@/lib/tauri"
import { getTrayPanelConfig, openTrayPanel, setTrayLeftClickAction } from "@/lib/tauri/tray-panel"
import { DEFAULT_TRAY_PANEL_ACTIONS } from "@/lib/tray-panel/defaults"
import { toast } from "sonner"
import { withEditedEntries } from "@/lib/glance/layout-edit"
import { glancePluginModules } from "@/lib/glance/plugin-registry"
import {
  desktopEntriesFromMobile,
  mobileLayoutFromPreset,
  normalizeGlanceMobileSettings,
} from "@/lib/glance/mobile-layout"
import { DEFAULT_GLANCE_PANEL_SETTINGS, layoutFromPreset } from "@/lib/glance/presets"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { GlancePanelSettings } from "@/types/glance/layout"
import type { TrayPanelAction } from "@/lib/tray-panel/types"

import { TrayPanelSettings } from "./tray-panel-settings"

const isTauriMock = isTauri as jest.Mock
const getConfigMock = getTrayPanelConfig as jest.Mock
const setLeftClickMock = setTrayLeftClickAction as jest.Mock
const openPanelMock = openTrayPanel as jest.Mock

const custom = (id: string, patch: Partial<TrayPanelAction> = {}): TrayPanelAction => ({
  id,
  label: id,
  fields: [],
  trigger: { kind: "manual" },
  effect: { kind: "navigate", path: "/x" },
  ...patch,
})

const saveSettingsMock = jest.fn(async (_patch: Record<string, unknown>) => {})

// Seeding never drops the shipped built-ins: `resolveTrayPanelActions` folds
// any missing one back in, which would move the fixtures around.
let storedLayout: Partial<GlancePanelSettings> | undefined

function seedSettings(
  actions: TrayPanelAction[] | undefined,
  layout: Partial<GlancePanelSettings> | undefined = storedLayout
) {
  storedLayout = layout
  useSettingsStore.setState({
    settings: { trayPanelActions: actions, trayPanelLayout: layout } as never,
    save: saveSettingsMock as never,
  })
}

/** The shipped catalogue plus the given custom actions, at the end. */
function seed(...customs: TrayPanelAction[]) {
  seedSettings([...DEFAULT_TRAY_PANEL_ACTIONS, ...customs])
}

function seedLayout(layout: Partial<GlancePanelSettings> | undefined) {
  seedSettings(undefined, layout)
}

/** The catalogue of the latest `{ trayPanelActions }` write. */
function savedActions(): TrayPanelAction[] {
  const call = saveSettingsMock.mock.calls.findLast((c) => "trayPanelActions" in (c[0] as object))
  return (call?.[0] as { trayPanelActions: TrayPanelAction[] }).trayPanelActions
}

/** The layout of the latest `{ trayPanelLayout }` write. */
function savedLayout(): GlancePanelSettings {
  const call = saveSettingsMock.mock.calls.findLast((c) => "trayPanelLayout" in (c[0] as object))
  return (call?.[0] as { trayPanelLayout: GlancePanelSettings }).trayPanelLayout
}

beforeEach(() => {
  saveSettingsMock.mockClear()
  storedLayout = undefined
  seedSettings(undefined, undefined)
  isTauriMock.mockReset().mockReturnValue(true)
  getConfigMock.mockReset().mockResolvedValue({ leftClick: "panel", width: 380, height: 460 })
  setLeftClickMock.mockReset().mockResolvedValue(true)
  openPanelMock.mockReset().mockResolvedValue(true)
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "uuid-1" },
    configurable: true,
  })
})

describe("TrayPanelSettings", () => {
  it("degrades to a message in the browser build", () => {
    isTauriMock.mockReturnValue(false)
    render(<TrayPanelSettings />)
    expect(screen.getByText("desktopOnly")).toBeInTheDocument()
  })

  it("uses the card-free settings primitives, not a Card wrapper", () => {
    seed(custom("a"))
    const { container } = render(<TrayPanelSettings />)
    // `SettingsStack` declares the container query every field measures
    // against; a Card-based rewrite would lose it.
    expect(container.querySelector(".\\@container\\/settings-stack")).toBeTruthy()
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
  })

  it("shows the persisted left-click preference", async () => {
    getConfigMock.mockResolvedValue({ leftClick: "none", width: 380, height: 460 })
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "behavior.leftClick" })).toHaveTextContent(
        "behavior.leftClickOptions.none"
      )
    )
  })

  it("persists a changed left-click preference natively", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("combobox", { name: "behavior.leftClick" }))
    await user.click(await screen.findByRole("option", { name: "behavior.leftClickOptions.none" }))

    expect(setLeftClickMock).toHaveBeenCalledWith("none")
  })

  it("opens the panel from the preview button", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: /behavior.previewAction/ }))
    expect(openPanelMock).toHaveBeenCalled()
  })

  it("lists every action with its trigger and effect summary", () => {
    seed(custom("a", { effect: { kind: "slash", command: "clear" } }))
    render(<TrayPanelSettings />)

    const row = screen.getByTestId("tray-panel-row-a")
    expect(within(row).getByText("editor.triggers.manual")).toBeInTheDocument()
    expect(within(row).getByText("/clear")).toBeInTheDocument()
  })

  it("lists the shipped catalogue when none is stored", () => {
    render(<TrayPanelSettings />)
    for (const action of DEFAULT_TRAY_PANEL_ACTIONS) {
      expect(screen.getByTestId(`tray-panel-row-${action.id}`)).toBeInTheDocument()
    }
  })

  it("folds a built-in missing from the stored catalogue back into the list", () => {
    seedSettings([custom("a")])
    render(<TrayPanelSettings />)
    expect(screen.getByTestId("tray-panel-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("tray-panel-row-trayPanel.delegate")).toBeInTheDocument()
  })

  it("writes the whole catalogue back to settings on an edit", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)
    await user.click(
      within(screen.getByTestId("tray-panel-row-a")).getByRole("button", { name: "actions.hide" })
    )
    expect(saveSettingsMock).toHaveBeenCalledTimes(1)
    expect(savedActions()).toHaveLength(DEFAULT_TRAY_PANEL_ACTIONS.length + 1)
  })

  it("shows a hidden action as hidden and offers to show it again", async () => {
    const user = userEvent.setup()
    seedSettings([...DEFAULT_TRAY_PANEL_ACTIONS, custom("a", { hidden: true })])
    render(<TrayPanelSettings />)
    const row = screen.getByTestId("tray-panel-row-a")
    expect(row).toHaveClass("opacity-50")
    await user.click(within(row).getByRole("button", { name: "actions.show" }))
    expect(savedActions().find((x) => x.id === "a")?.hidden).toBe(false)
  })

  it("hides a built-in instead of deleting it", () => {
    seed(custom("a"))
    render(<TrayPanelSettings />)
    expect(
      within(screen.getByTestId("tray-panel-row-trayPanel.settings")).getByRole("button", {
        name: "actions.remove",
      })
    ).toBeDisabled()
  })

  it("saves an action edited through the editor", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)
    await user.click(
      within(screen.getByTestId("tray-panel-row-a")).getByRole("button", { name: "actions.edit" })
    )
    const label = await screen.findByLabelText("label", { selector: "#tp-label" })
    await user.clear(label)
    await user.type(label, "Renamed")
    await user.click(await screen.findByRole("button", { name: "save" }))
    expect(savedActions().find((x) => x.id === "a")?.label).toBe("Renamed")
  })

  it("reorders an action", async () => {
    const user = userEvent.setup()
    seed(custom("a"), custom("b"))
    render(<TrayPanelSettings />)

    const row = screen.getByTestId("tray-panel-row-b")
    await user.click(within(row).getByRole("button", { name: "actions.moveUp" }))
    expect(saveSettingsMock).toHaveBeenCalledTimes(1)
    expect(savedActions().map((x) => x.id)).toEqual([
      ...DEFAULT_TRAY_PANEL_ACTIONS.map((x) => x.id),
      "b",
      "a",
    ])
  })

  it("disables the move buttons at the ends", () => {
    seed(custom("a"), custom("b"))
    render(<TrayPanelSettings />)

    expect(
      within(screen.getByTestId("tray-panel-row-trayPanel.delegate")).getByRole("button", {
        name: "actions.moveUp",
      })
    ).toBeDisabled()
    expect(
      within(screen.getByTestId("tray-panel-row-b")).getByRole("button", {
        name: "actions.moveDown",
      })
    ).toBeDisabled()
  })

  it("toggles an action's visibility", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await user.click(
      within(screen.getByTestId("tray-panel-row-a")).getByRole("button", { name: "actions.hide" })
    )
    expect(savedActions().find((x) => x.id === "a")?.hidden).toBe(true)
  })

  it("removes a custom action", async () => {
    const user = userEvent.setup()
    seed(custom("a"), custom("b"))
    render(<TrayPanelSettings />)

    const row = screen.getByTestId("tray-panel-row-a")
    await user.click(within(row).getByRole("button", { name: "actions.remove" }))
    expect(savedActions().map((x) => x.id)).toEqual([
      ...DEFAULT_TRAY_PANEL_ACTIONS.map((x) => x.id),
      "b",
    ])
  })

  it("refuses to delete a built-in", () => {
    seed(custom("a"))
    render(<TrayPanelSettings />)

    const row = screen.getByTestId("tray-panel-row-trayPanel.newChat")
    expect(within(row).getByRole("button", { name: "actions.remove" })).toBeDisabled()
    expect(within(row).getByText("actions.builtIn")).toBeInTheDocument()
    // A custom action is removable and carries no built-in badge.
    const customRow = screen.getByTestId("tray-panel-row-a")
    expect(within(customRow).getByRole("button", { name: "actions.remove" })).toBeEnabled()
    expect(within(customRow).queryByText("actions.builtIn")).not.toBeInTheDocument()
  })

  it("adds a new action through the editor", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: /actions.add/ }))
    // The editor opens seeded with a blank draft, which cannot be saved yet.
    expect(await screen.findByRole("button", { name: "save" })).toBeDisabled()
  })

  it("opens the editor for an existing action", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await user.click(
      within(screen.getByTestId("tray-panel-row-a")).getByRole("button", { name: "actions.edit" })
    )
    expect(await screen.findByLabelText("label", { selector: "#tp-label" })).toHaveValue("a")
  })

  it("restores the shipped catalogue", async () => {
    const user = userEvent.setup()
    seed(custom("a"))
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: /actions.reset/ }))
    expect(saveSettingsMock).toHaveBeenCalledWith({ trayPanelActions: DEFAULT_TRAY_PANEL_ACTIONS })
  })

  describe("modules", () => {
    const row = (id: string) => screen.getByTestId(`glance-editor-row-${id}`)

    it("renders the layout editor with the preview beside it", () => {
      render(<TrayPanelSettings />)
      expect(screen.getByText("modules.title")).toBeInTheDocument()
      expect(screen.getByTestId("glance-layout-editor")).toBeInTheDocument()
      expect(screen.getByTestId("tray-panel-preview-stub")).toBeInTheDocument()
      // Desktop modules, quick included, in the shipped balanced order.
      expect(
        screen
          .getAllByTestId(/^glance-editor-row-/)
          .map((el) => el.getAttribute("data-testid")?.replace("glance-editor-row-", ""))
      ).toEqual(["fleet", "usage", "quota", "agenda", "activity", "quick"])
    })

    it("offers the desktop's running plugin modules in the add list", () => {
      glancePluginModules.register("test.settings", { id: "ci", title: "CI status" })
      glancePluginModules.register("test.settings", {
        id: "phone",
        title: "Phone only",
        platforms: ["mobile"],
      })
      try {
        render(<TrayPanelSettings />)
        expect(
          screen.getByTestId("glance-editor-hidden-plugin:test.settings:ci")
        ).toHaveTextContent("CI status")
        expect(
          screen.queryByTestId("glance-editor-hidden-plugin:test.settings:phone")
        ).not.toBeInTheDocument()
      } finally {
        glancePluginModules.unregisterAllByPlugin("test.settings")
      }
    })

    it("hides a module and saves the layout as custom", async () => {
      const user = userEvent.setup()
      render(<TrayPanelSettings />)
      await user.click(
        within(row("usage")).getByRole("button", { name: 'hide:{"module":"modules.usage.label"}' })
      )
      expect(saveSettingsMock).toHaveBeenCalledTimes(1)
      const saved = savedLayout()
      expect(saved).toEqual({
        ...DEFAULT_GLANCE_PANEL_SETTINGS,
        preset: "custom",
        entries: [
          { id: "fleet", size: "standard", hidden: false },
          { id: "quota", size: "standard", hidden: false },
          { id: "agenda", size: "compact", hidden: false },
          { id: "activity", size: "standard", hidden: false },
          { id: "quick", size: "compact", hidden: false },
          { id: "usage", size: "standard", hidden: true },
          { id: "recents", size: "compact", hidden: true },
          { id: "pet", size: "compact", hidden: true },
        ],
      })
    })

    it("saves a size change as custom", async () => {
      const user = userEvent.setup()
      render(<TrayPanelSettings />)
      await user.click(within(row("fleet")).getByRole("radio", { name: "expanded" }))
      const saved = savedLayout()
      expect(saved.preset).toBe("custom")
      expect(saved.entries[0]).toEqual({ id: "fleet", size: "expanded", hidden: false })
    })

    it("adds a hidden module back and saves it as shown", async () => {
      const user = userEvent.setup()
      render(<TrayPanelSettings />)
      await user.click(
        screen.getByRole("button", { name: 'addModule:{"module":"modules.recents.label"}' })
      )
      const saved = savedLayout()
      expect(saved.preset).toBe("custom")
      expect(saved.entries.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
        "fleet",
        "usage",
        "quota",
        "agenda",
        "activity",
        "quick",
        "recents",
      ])
    })

    it("keeps width, height, scope and options through a layout edit", async () => {
      const user = userEvent.setup()
      seedLayout({
        ...DEFAULT_GLANCE_PANEL_SETTINGS,
        width: "wide",
        maxHeight: 500,
        scope: "workspace",
      })
      render(<TrayPanelSettings />)
      await user.click(
        within(row("fleet")).getByRole("button", { name: 'hide:{"module":"modules.fleet.label"}' })
      )
      expect(savedLayout()).toEqual(
        expect.objectContaining({ width: "wide", maxHeight: 500, scope: "workspace" })
      )
    })

    it("shows the current preset on the preset menu", () => {
      render(<TrayPanelSettings />)
      expect(
        screen.getByRole("button", { name: 'editor.presetLabel:{"preset":"presets.balanced"}' })
      ).toBeInTheDocument()
    })

    it("shows Custom for an edited layout", () => {
      seedLayout({ ...DEFAULT_GLANCE_PANEL_SETTINGS, preset: "custom" })
      render(<TrayPanelSettings />)
      expect(
        screen.getByRole("button", { name: 'editor.presetLabel:{"preset":"editor.custom"}' })
      ).toBeInTheDocument()
    })

    it("applies a preset: its id and its entries, keeping the panel options", async () => {
      const user = userEvent.setup()
      seedLayout({ ...DEFAULT_GLANCE_PANEL_SETTINGS, preset: "custom", width: "narrow" })
      render(<TrayPanelSettings />)
      await user.click(
        screen.getByRole("button", { name: 'editor.presetLabel:{"preset":"editor.custom"}' })
      )
      await user.click(await screen.findByRole("menuitem", { name: "presets.usageFirst" }))
      expect(saveSettingsMock).toHaveBeenCalledTimes(1)
      expect(savedLayout()).toEqual({
        ...DEFAULT_GLANCE_PANEL_SETTINGS,
        width: "narrow",
        preset: "usage-first",
        entries: layoutFromPreset("usage-first"),
      })
    })

    it("saves the delegate switch", async () => {
      const user = userEvent.setup()
      render(<TrayPanelSettings />)
      const toggle = screen.getByRole("switch", { name: "modules.delegate" })
      expect(toggle).toBeChecked()
      await user.click(toggle)
      expect(savedLayout()).toEqual(expect.objectContaining({ showDelegate: false }))
    })

    it("does not mark the layout custom for a delegate change", async () => {
      const user = userEvent.setup()
      render(<TrayPanelSettings />)
      await user.click(screen.getByRole("switch", { name: "modules.delegate" }))
      expect(savedLayout().preset).toBe("balanced")
    })

    it("disables the autofocus switch while the delegate bar is hidden", () => {
      seedLayout({ ...DEFAULT_GLANCE_PANEL_SETTINGS, showDelegate: false, autofocusDelegate: true })
      render(<TrayPanelSettings />)
      expect(screen.getByRole("switch", { name: "modules.delegate" })).not.toBeChecked()
      expect(screen.getByRole("switch", { name: "layout.autofocus" })).toBeDisabled()
    })

    it("enables the autofocus switch while the delegate bar is shown", () => {
      render(<TrayPanelSettings />)
      expect(screen.getByRole("switch", { name: "layout.autofocus" })).toBeEnabled()
    })

    describe("copy the phone's layout (ADR-0225 §10)", () => {
      const toastSuccess = toast.success as jest.Mock

      beforeEach(() => toastSuccess.mockClear())

      function seedPhone(mobileGlanceLayout: unknown) {
        useSettingsStore.setState({
          settings: { trayPanelLayout: storedLayout, mobileGlanceLayout } as never,
          save: saveSettingsMock as never,
        })
      }

      it("is disabled and says why while no phone has saved a layout", async () => {
        const user = userEvent.setup()
        render(<TrayPanelSettings />)
        const button = screen.getByRole("button", { name: "modules.copyPhone" })
        expect(button).toBeDisabled()
        expect(button).toHaveTextContent("modules.copyPhoneAction")
        expect(screen.getByText("modules.copyPhoneNone")).toBeInTheDocument()
        expect(screen.queryByText("modules.copyPhoneHint")).not.toBeInTheDocument()
        await user.click(button)
        expect(saveSettingsMock).not.toHaveBeenCalled()
        expect(toastSuccess).not.toHaveBeenCalled()
      })

      it("copies the phone's modules, order and sizes into the tray layout", async () => {
        const user = userEvent.setup()
        const phone = {
          version: 1,
          preset: "agent-ops",
          entries: mobileLayoutFromPreset("agent-ops"),
          scope: "workspace",
          shortcuts: ["search"],
        }
        storedLayout = { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "wide", maxHeight: 520 }
        seedPhone(phone)
        render(<TrayPanelSettings />)
        expect(screen.getByText("modules.copyPhoneHint")).toBeInTheDocument()
        expect(screen.queryByText("modules.copyPhoneNone")).not.toBeInTheDocument()

        await user.click(screen.getByRole("button", { name: "modules.copyPhone" }))

        const expected = withEditedEntries(
          { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "wide", maxHeight: 520 },
          desktopEntriesFromMobile(normalizeGlanceMobileSettings(phone).entries)
        )
        expect(savedLayout()).toEqual(expected)
        // The phone's order and sizes, its home pins and shortcuts left behind,
        // and the panel's own geometry kept.
        const saved = savedLayout()
        expect(saved.entries.filter((e) => !e.hidden).map((e) => [e.id, e.size])).toEqual([
          ["fleet", "expanded"],
          ["agenda", "standard"],
          ["recents", "standard"],
          ["quick", "standard"],
          ["quota", "compact"],
        ])
        expect(saved.entries.every((e) => !("home" in e))).toBe(true)
        expect(saved.preset).toBe("custom")
        expect(saved.width).toBe("wide")
        expect(saved.maxHeight).toBe(520)
        expect(saved.scope).toBe(DEFAULT_GLANCE_PANEL_SETTINGS.scope)
        expect(toastSuccess).toHaveBeenCalledWith("modules.copiedPhone")
      })

      it("repairs a malformed stored phone layout before copying it", async () => {
        const user = userEvent.setup()
        seedPhone({ entries: [{ id: "usage", size: "expanded" }, { id: "nope" }] })
        render(<TrayPanelSettings />)
        await user.click(screen.getByRole("button", { name: "modules.copyPhone" }))
        const shown = savedLayout().entries.filter((e) => !e.hidden)
        expect(shown).toEqual([{ id: "usage", size: "expanded", hidden: false }])
        expect(toastSuccess).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe("panel layout", () => {
    it("shows the shipped layout when none is stored", () => {
      seed(custom("a"))
      render(<TrayPanelSettings />)
      expect(screen.getByRole("combobox", { name: "layout.width" })).toHaveTextContent(
        'layout.widthOptions.standard:{"px":380}'
      )
      expect(screen.getByRole("combobox", { name: "layout.scope" })).toHaveTextContent(
        "layout.scopeOptions.all"
      )
      expect(screen.getByRole("slider", { name: "layout.maxHeight" })).toHaveAttribute(
        "aria-valuenow",
        String(DEFAULT_GLANCE_PANEL_SETTINGS.maxHeight)
      )
      expect(screen.getByRole("switch", { name: "layout.autofocus" })).not.toBeChecked()
    })

    it("reads a stored layout through the normalizer", () => {
      seedLayout({
        ...DEFAULT_GLANCE_PANEL_SETTINGS,
        width: "wide",
        maxHeight: 99999,
        scope: "workspace",
      })
      seed(custom("a"))
      render(<TrayPanelSettings />)
      expect(screen.getByRole("combobox", { name: "layout.width" })).toHaveTextContent(
        "layout.widthOptions.wide"
      )
      expect(screen.getByRole("combobox", { name: "layout.scope" })).toHaveTextContent(
        "layout.scopeOptions.workspace"
      )
      expect(screen.getByText('layout.px:{"px":860}')).toBeInTheDocument()
    })

    it("saves a width change into the whole layout", async () => {
      const user = userEvent.setup()
      seed(custom("a"))
      render(<TrayPanelSettings />)
      await user.click(screen.getByRole("combobox", { name: "layout.width" }))
      await user.click(await screen.findByRole("option", { name: /layout\.widthOptions\.narrow/ }))
      expect(saveSettingsMock).toHaveBeenCalledWith({
        trayPanelLayout: { ...DEFAULT_GLANCE_PANEL_SETTINGS, width: "narrow" },
      })
    })

    it("saves the scope", async () => {
      const user = userEvent.setup()
      seed(custom("a"))
      render(<TrayPanelSettings />)
      await user.click(screen.getByRole("combobox", { name: "layout.scope" }))
      await user.click(await screen.findByRole("option", { name: "layout.scopeOptions.workspace" }))
      expect(saveSettingsMock).toHaveBeenCalledWith({
        trayPanelLayout: expect.objectContaining({ scope: "workspace" }),
      })
    })

    it("saves the autofocus switch", async () => {
      const user = userEvent.setup()
      seed(custom("a"))
      render(<TrayPanelSettings />)
      await user.click(screen.getByRole("switch", { name: "layout.autofocus" }))
      expect(saveSettingsMock).toHaveBeenCalledWith({
        trayPanelLayout: expect.objectContaining({ autofocusDelegate: true }),
      })
    })

    it("moves the max height locally and writes once on commit", async () => {
      const user = userEvent.setup()
      seed(custom("a"))
      render(<TrayPanelSettings />)
      const slider = screen.getByRole("slider", { name: "layout.maxHeight" })
      slider.focus()
      await user.keyboard("{ArrowRight}")
      expect(saveSettingsMock).toHaveBeenCalledTimes(1)
      expect(saveSettingsMock).toHaveBeenCalledWith({
        trayPanelLayout: expect.objectContaining({
          maxHeight: DEFAULT_GLANCE_PANEL_SETTINGS.maxHeight + 10,
        }),
      })
    })
  })
})
