import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

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

import { isTauri } from "@/lib/tauri"
import { getTrayPanelConfig, openTrayPanel, setTrayLeftClickAction } from "@/lib/tauri/tray-panel"
import { DEFAULT_TRAY_PANEL_ACTIONS } from "@/lib/tray-panel/defaults"
import { __resetTrayPanelStoreForTesting, useTrayPanelStore } from "@/lib/tray-panel/store"
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

function seed(actions: TrayPanelAction[]) {
  // `hydrate` is stubbed alongside the fixtures: the real one reads the (empty)
  // pref store on mount and would replace them with the shipped defaults.
  useTrayPanelStore.setState({ actions, hydrated: true, hydrate: async () => {} })
}

beforeEach(() => {
  __resetTrayPanelStoreForTesting()
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
    seed([custom("a")])
    const { container } = render(<TrayPanelSettings />)
    // `SettingsStack` declares the container query every field measures
    // against; a Card-based rewrite would lose it.
    expect(container.querySelector(".\\@container\\/settings-stack")).toBeTruthy()
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
  })

  it("shows the persisted left-click preference", async () => {
    getConfigMock.mockResolvedValue({ leftClick: "none", width: 380, height: 460 })
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "behavior.leftClick" })).toHaveTextContent(
        "behavior.leftClickOptions.none"
      )
    )
  })

  it("persists a changed left-click preference natively", async () => {
    const user = userEvent.setup()
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("combobox", { name: "behavior.leftClick" }))
    await user.click(await screen.findByRole("option", { name: "behavior.leftClickOptions.none" }))

    expect(setLeftClickMock).toHaveBeenCalledWith("none")
  })

  it("opens the panel from the preview button", async () => {
    const user = userEvent.setup()
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: /behavior.previewAction/ }))
    expect(openPanelMock).toHaveBeenCalled()
  })

  it("lists every action with its trigger and effect summary", () => {
    seed([custom("a", { effect: { kind: "slash", command: "clear" } })])
    render(<TrayPanelSettings />)

    expect(screen.getByTestId("tray-panel-row-a")).toBeInTheDocument()
    expect(screen.getByText("editor.triggers.manual")).toBeInTheDocument()
    expect(screen.getByText("/clear")).toBeInTheDocument()
  })

  it("reorders an action", async () => {
    const user = userEvent.setup()
    seed([custom("a"), custom("b")])
    render(<TrayPanelSettings />)

    const row = screen.getByTestId("tray-panel-row-b")
    await user.click(within(row).getByRole("button", { name: "actions.moveUp" }))
    expect(useTrayPanelStore.getState().actions.map((x) => x.id)).toEqual(["b", "a"])
  })

  it("disables the move buttons at the ends", () => {
    seed([custom("a"), custom("b")])
    render(<TrayPanelSettings />)

    expect(
      within(screen.getByTestId("tray-panel-row-a")).getByRole("button", { name: "actions.moveUp" })
    ).toBeDisabled()
    expect(
      within(screen.getByTestId("tray-panel-row-b")).getByRole("button", {
        name: "actions.moveDown",
      })
    ).toBeDisabled()
  })

  it("toggles an action's visibility", async () => {
    const user = userEvent.setup()
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: "actions.hide" }))
    expect(useTrayPanelStore.getState().actions[0].hidden).toBe(true)
  })

  it("removes a custom action", async () => {
    const user = userEvent.setup()
    seed([custom("a"), custom("b")])
    render(<TrayPanelSettings />)

    const row = screen.getByTestId("tray-panel-row-a")
    await user.click(within(row).getByRole("button", { name: "actions.remove" }))
    expect(useTrayPanelStore.getState().actions.map((x) => x.id)).toEqual(["b"])
  })

  it("refuses to delete a built-in", () => {
    seed([custom("a", { builtIn: true })])
    render(<TrayPanelSettings />)

    expect(screen.getByRole("button", { name: "actions.remove" })).toBeDisabled()
    expect(screen.getByText("actions.builtIn")).toBeInTheDocument()
  })

  it("adds a new action through the editor", async () => {
    const user = userEvent.setup()
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: /actions.add/ }))
    // The editor opens seeded with a blank draft, which cannot be saved yet.
    expect(await screen.findByRole("button", { name: "save" })).toBeDisabled()
  })

  it("opens the editor for an existing action", async () => {
    const user = userEvent.setup()
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: "actions.edit" }))
    expect(await screen.findByLabelText("label", { selector: "#tp-label" })).toHaveValue("a")
  })

  it("restores the shipped catalogue", async () => {
    const user = userEvent.setup()
    seed([custom("a")])
    render(<TrayPanelSettings />)

    await user.click(screen.getByRole("button", { name: /actions.reset/ }))
    expect(useTrayPanelStore.getState().actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
  })
})
