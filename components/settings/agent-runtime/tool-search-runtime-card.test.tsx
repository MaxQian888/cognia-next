/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${Object.values(vals).join(",")}` : key,
}))

const saveMock = jest.fn()
let mockSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockSettings, save: saveMock }),
}))

import { ToolSearchRuntimeCard } from "./tool-search-runtime-card"

beforeEach(() => {
  saveMock.mockReset()
  mockSettings = {}
})

describe("ToolSearchRuntimeCard", () => {
  it("renders the enable toggle and hides editors when disabled", () => {
    render(<ToolSearchRuntimeCard />)
    expect(screen.getByText("enableLabel")).toBeInTheDocument()
    expect(screen.queryByTestId("tool-search-servers")).not.toBeInTheDocument()
  })

  it("toggling enable persists { enabled: true }", () => {
    render(<ToolSearchRuntimeCard />)
    fireEvent.click(screen.getByRole("switch"))
    expect(saveMock).toHaveBeenCalledWith({ toolSearchRuntime: { enabled: true } })
  })

  it("shows both list editors when enabled", () => {
    mockSettings = { toolSearchRuntime: { enabled: true } }
    render(<ToolSearchRuntimeCard />)
    expect(screen.getByTestId("tool-search-servers")).toBeInTheDocument()
    expect(screen.getByTestId("tool-search-tools")).toBeInTheDocument()
  })

  it("adding a server persists the merged config", () => {
    mockSettings = { toolSearchRuntime: { enabled: true } }
    render(<ToolSearchRuntimeCard />)
    const serversBlock = screen.getByTestId("tool-search-servers")
    const input = serversBlock.querySelector("input")!
    fireEvent.change(input, { target: { value: "cognia-tools" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(saveMock).toHaveBeenCalledWith({
      toolSearchRuntime: { enabled: true, alwaysLoadServers: ["cognia-tools"] },
    })
  })

  it("removing a pinned tool persists the reduced list", () => {
    mockSettings = { toolSearchRuntime: { enabled: true, alwaysLoadTools: ["read_file"] } }
    render(<ToolSearchRuntimeCard />)
    // removeAria passthrough → "removeAria:read_file"
    fireEvent.click(screen.getByLabelText("removeAria:read_file"))
    expect(saveMock).toHaveBeenCalledWith({
      toolSearchRuntime: { enabled: true, alwaysLoadTools: [] },
    })
  })

  it("does not add duplicate or empty values", () => {
    mockSettings = { toolSearchRuntime: { enabled: true, alwaysLoadServers: ["x"] } }
    render(<ToolSearchRuntimeCard />)
    const input = screen.getByTestId("tool-search-servers").querySelector("input")!
    fireEvent.change(input, { target: { value: "x" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(saveMock).not.toHaveBeenCalled()
  })
})
