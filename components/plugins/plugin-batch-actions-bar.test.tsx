/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

const setPluginEnabledMock = jest.fn(async (_id: string, _enabled: boolean) => undefined)
const mockRows: PluginRow[] = [
  {
    id: "a",
    name: "A",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/",
    manifest: { id: "a" },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "b",
    name: "B",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/",
    manifest: { id: "b" },
    createdAt: 1,
    updatedAt: 1,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows)),
  setPluginEnabled: (id: string, enabled: boolean) => setPluginEnabledMock(id, enabled),
}))

import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { usePluginsStore } from "@/stores/plugins"

beforeEach(() => {
  setPluginEnabledMock.mockClear()
  usePluginsStore.setState({
    selection: new Set(["a", "b"]),
  })
})

describe("PluginBatchActionsBar", () => {
  it("returns null when selection is empty", () => {
    usePluginsStore.setState({ selection: new Set() })
    const { container } = render(<PluginBatchActionsBar />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the selected count", () => {
    render(<PluginBatchActionsBar />)
    expect(screen.getByText(/selected:2/)).toBeInTheDocument()
  })

  it("disable-all toggles every selected row", () => {
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByText("disableAll"))
    expect(setPluginEnabledMock).toHaveBeenCalledTimes(2)
    expect(setPluginEnabledMock).toHaveBeenCalledWith("a", false)
    expect(setPluginEnabledMock).toHaveBeenCalledWith("b", false)
  })

  it("clear-selection button empties the selection", () => {
    render(<PluginBatchActionsBar />)
    fireEvent.click(screen.getByLabelText("clearSelection"))
    expect(usePluginsStore.getState().selection.size).toBe(0)
  })
})
