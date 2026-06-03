/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

const getSettingsMock = jest.fn()
const saveSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
  saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { isTauri } from "@/lib/tauri"

import { CcswitchSyncTab } from "./sync-tab"

const mIsTauri = isTauri as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
  mIsTauri.mockReturnValue(true)
  getSettingsMock.mockResolvedValue({
    id: "singleton",
    ccswitchSync: {
      enabled: true,
      watchDb: true,
      defaultPropagation: ["claude-code"],
    },
    alwaysAllowTools: [],
    builtinTools: {},
  })
})

describe("CcswitchSyncTab", () => {
  it("renders the loaded settings", async () => {
    render(<CcswitchSyncTab />)
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled())
    // Both toggles plus the propagation checkbox should render.
    const switches = await screen.findAllByRole("switch")
    expect(switches).toHaveLength(2)
    // The agent label appears as text in the propagation row.
    expect(screen.getByText("agents.claude-code")).toBeInTheDocument()
  })

  it("clicking Save persists the current state", async () => {
    saveSettingsMock.mockResolvedValue({})
    render(<CcswitchSyncTab />)
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled())
    // Wait for the loaded state — Save button only renders after `loaded`.
    const saveBtn = await screen.findByRole("button", { name: "sync.save" })
    fireEvent.click(saveBtn)
    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalled())
    expect(saveSettingsMock.mock.calls[0][0].ccswitchSync).toEqual({
      enabled: true,
      watchDb: true,
      defaultPropagation: ["claude-code"],
    })
  })

  it("toggling watchDb off and saving persists the new value", async () => {
    saveSettingsMock.mockResolvedValue({})
    render(<CcswitchSyncTab />)
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled())
    const switches = await screen.findAllByRole("switch")
    // Order: [enabled, watchDb] — watchDb is the second toggle.
    fireEvent.click(switches[1])
    fireEvent.click(screen.getByRole("button", { name: "sync.save" }))
    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalled())
    expect(saveSettingsMock.mock.calls[0][0].ccswitchSync.watchDb).toBe(false)
  })

  it("loads and persists a manual data dir (trimmed)", async () => {
    saveSettingsMock.mockResolvedValue({})
    getSettingsMock.mockResolvedValue({
      id: "singleton",
      ccswitchSync: {
        enabled: true,
        watchDb: true,
        defaultPropagation: [],
        manualDataDir: "~/cc-data",
      },
      alwaysAllowTools: [],
      builtinTools: {},
    })
    render(<CcswitchSyncTab />)
    const input = (await screen.findByLabelText("sync.manualDirLabel")) as HTMLInputElement
    expect(input.value).toBe("~/cc-data")
    fireEvent.change(input, { target: { value: "  ~/elsewhere  " } })
    fireEvent.click(screen.getByRole("button", { name: "sync.save" }))
    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalled())
    expect(saveSettingsMock.mock.calls[0][0].ccswitchSync.manualDataDir).toBe("~/elsewhere")
  })

  it("clearing the manual data dir persists undefined", async () => {
    saveSettingsMock.mockResolvedValue({})
    getSettingsMock.mockResolvedValue({
      id: "singleton",
      ccswitchSync: {
        enabled: true,
        watchDb: true,
        defaultPropagation: [],
        manualDataDir: "~/cc-data",
      },
      alwaysAllowTools: [],
      builtinTools: {},
    })
    render(<CcswitchSyncTab />)
    await screen.findByLabelText("sync.manualDirLabel")
    fireEvent.click(screen.getByRole("button", { name: "sync.manualDirClear" }))
    fireEvent.click(screen.getByRole("button", { name: "sync.save" }))
    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalled())
    expect(saveSettingsMock.mock.calls[0][0].ccswitchSync.manualDataDir).toBeUndefined()
  })

  it("renders a web-mode banner when not in Tauri and skips the settings read", async () => {
    mIsTauri.mockReturnValue(false)
    render(<CcswitchSyncTab />)
    expect(await screen.findByText("overview.webModeBody")).toBeInTheDocument()
    // Give the gated effect a tick to (not) run.
    await new Promise((r) => setTimeout(r, 10))
    expect(getSettingsMock).not.toHaveBeenCalled()
  })
})
