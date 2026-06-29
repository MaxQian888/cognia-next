/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import MobilePluginsPage from "./page"

interface PluginRow {
  id: string
  name?: string
  version?: string
  enabled?: boolean
}

const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)
const updateMock = jest.fn(async (..._args: unknown[]): Promise<void> => undefined)

// The PluginsPanel reads from `useLiveQuery(() => getDb().plugins.toArray())`.
// Drive both from a single module-level fixture that tests can reassign.
let pluginRows: PluginRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => pluginRows,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    plugins: {
      toArray: async () => pluginRows,
      update: (...args: unknown[]) => updateMock(...args),
    },
  }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

beforeEach(() => {
  jest.clearAllMocks()
  pluginRows = [
    { id: "clipboard-history", name: "Clipboard History", version: "1.2.0", enabled: true },
    { id: "screenshot", name: "Screenshot", enabled: false },
  ]
})

describe("MobilePluginsPage", () => {
  it("renders the shell and a row per installed plugin", () => {
    render(<MobilePluginsPage />)
    expect(screen.getByTestId("mobile-plugins-page")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-row-clipboard-history")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-row-screenshot")).toBeInTheDocument()
  })

  it("reflects each plugin's persisted enabled state", () => {
    render(<MobilePluginsPage />)
    expect(screen.getByTestId("plugin-switch-clipboard-history")).toBeChecked()
    expect(screen.getByTestId("plugin-switch-screenshot")).not.toBeChecked()
  })

  it("enqueues a plugin_set_enabled job when a plugin is toggled", async () => {
    render(<MobilePluginsPage />)
    fireEvent.click(screen.getByTestId("plugin-switch-screenshot"))
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled())
    expect(updateMock).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({ enabled: true })
    )
    const job = enqueueMock.mock.calls[0][0] as { command: string; payload: unknown }
    expect(job.command).toBe("plugin_set_enabled")
    expect(job.payload).toEqual(expect.objectContaining({ id: "screenshot", enabled: true }))
  })

  it("shows the empty state when no plugins are installed", () => {
    pluginRows = []
    render(<MobilePluginsPage />)
    expect(screen.getByTestId("mobile-plugins-page")).toBeInTheDocument()
    expect(screen.queryByTestId("plugins-panel")).toBeNull()
  })
})
