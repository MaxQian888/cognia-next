import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { RuntimeTab } from "./runtime-tab"

const load = jest.fn(async () => undefined)
const save = jest.fn(async () => undefined)
const flushPersistence = jest.fn()
const getRegisteredCatalogIds = jest.fn(() => ["cognia-standard-v1", "plugin-catalog"])
const storeState = {
  loaded: true,
  settings: {
    a2uiDefaultEnabled: false,
    a2uiDefaultCatalogId: "productivity",
    a2uiDefaultHostStrategy: "native" as const,
    a2uiDefaultTheme: "inherit" as const,
    a2uiPersistenceLimit: 20,
  },
  load,
  save,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: { flushPersistence: typeof flushPersistence }) => unknown) =>
    selector({ flushPersistence }),
}))
jest.mock("@/lib/a2ui/catalog", () => ({
  DEFAULT_CATALOG_ID: "cognia-standard-v1",
  getRegisteredCatalogIds: () => getRegisteredCatalogIds(),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

describe("RuntimeTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    storeState.loaded = true
    storeState.settings.a2uiDefaultEnabled = false
    save.mockResolvedValue(undefined)
  })

  it("shows registered catalog ids and falls back from a legacy category setting", () => {
    render(<RuntimeTab />)

    expect(screen.getByLabelText("Default catalog")).toHaveTextContent("Cognia Standard Catalog")
    expect(screen.queryByText("productivity")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Default catalog"))
    expect(screen.getByRole("option", { name: "plugin-catalog" })).toBeInTheDocument()
  })

  it("loads the shared settings store when needed", () => {
    storeState.loaded = false

    render(<RuntimeTab />)

    expect(screen.getByText("Loading…")).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("reports save failures and re-enables the controls", async () => {
    save.mockRejectedValueOnce(new Error("disk full"))
    render(<RuntimeTab />)

    const enabledSwitch = screen.getByRole("switch", { name: "Enable A2UI by default" })
    fireEvent.click(enabledSwitch)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to save: disk full"))
    expect(enabledSwitch).toBeEnabled()
  })

  it("flushes the persisted surface LRU after committing a new limit", async () => {
    render(<RuntimeTab />)

    const slider = screen.getByRole("slider", { name: "LRU limit" })
    fireEvent.keyDown(slider, { key: "ArrowRight" })
    fireEvent.keyUp(slider, { key: "ArrowRight" })

    await waitFor(() => expect(save).toHaveBeenCalledWith({ a2uiPersistenceLimit: 21 }))
    expect(flushPersistence).toHaveBeenCalledTimes(1)
  })
})
