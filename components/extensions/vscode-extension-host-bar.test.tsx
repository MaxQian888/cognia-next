/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

const listPanelsMock = jest.fn(() => [] as Array<Record<string, unknown>>)
const listTerminalsMock = jest.fn(() => [] as Array<Record<string, unknown>>)

jest.mock("@/lib/plugin/vscode-shim/webview-bridge", () => ({
  listPanels: () => listPanelsMock(),
}))

jest.mock("@/lib/plugin/vscode-shim/terminal-bridge", () => ({
  listTerminals: () => listTerminalsMock(),
}))

// Both inner panels are mocked — we're testing the host bar's
// visibility gating, not their internals.
jest.mock("./vscode-extension-panel", () => ({
  VscodeExtensionPanel: () => <div data-testid="mock-webview-panel" />,
}))
jest.mock("./vscode-terminal-panel", () => ({
  VscodeTerminalPanel: () => <div data-testid="mock-terminal-panel" />,
}))

import { VscodeExtensionHostBar } from "./vscode-extension-host-bar"

beforeEach(() => {
  jest.useFakeTimers()
  listPanelsMock.mockReturnValue([])
  listTerminalsMock.mockReturnValue([])
})

afterEach(() => {
  jest.useRealTimers()
})

describe("VscodeExtensionHostBar", () => {
  it("renders null when no extension has registered a surface", () => {
    const { container } = render(<VscodeExtensionHostBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the webview sub-panel when a webview is registered", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    render(<VscodeExtensionHostBar />)
    expect(screen.getByTestId("vscode-extension-host-bar")).toBeInTheDocument()
    expect(screen.getByTestId("vscode-extension-host-bar-webviews")).toBeInTheDocument()
    expect(screen.queryByTestId("vscode-extension-host-bar-terminal")).not.toBeInTheDocument()
  })

  it("renders the terminal sub-panel when a terminal is registered", () => {
    listTerminalsMock.mockReturnValue([{ terminalId: "t1" }])
    render(<VscodeExtensionHostBar />)
    expect(screen.getByTestId("vscode-extension-host-bar")).toBeInTheDocument()
    expect(screen.getByTestId("vscode-extension-host-bar-terminal")).toBeInTheDocument()
    expect(screen.queryByTestId("vscode-extension-host-bar-webviews")).not.toBeInTheDocument()
  })

  it("renders both when both are registered", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    listTerminalsMock.mockReturnValue([{ terminalId: "t1" }])
    render(<VscodeExtensionHostBar />)
    expect(screen.getByTestId("vscode-extension-host-bar-webviews")).toBeInTheDocument()
    expect(screen.getByTestId("vscode-extension-host-bar-terminal")).toBeInTheDocument()
  })

  it("respects the webviewSlot filter", () => {
    listPanelsMock.mockReturnValue([
      { panelId: "p1", hostSlot: "sidebar" },
      { panelId: "p2", hostSlot: "panel" },
    ])
    render(<VscodeExtensionHostBar webviewSlot="panel" />)
    expect(screen.getByTestId("vscode-extension-host-bar")).toBeInTheDocument()
  })

  it("returns null when webviewSlot filter rules every panel out", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    const { container } = render(<VscodeExtensionHostBar webviewSlot="activityBar" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("respects hideTerminal", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    listTerminalsMock.mockReturnValue([{ terminalId: "t1" }])
    render(<VscodeExtensionHostBar hideTerminal />)
    expect(screen.queryByTestId("vscode-extension-host-bar-terminal")).not.toBeInTheDocument()
  })

  it("respects hideWebviews", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    listTerminalsMock.mockReturnValue([{ terminalId: "t1" }])
    render(<VscodeExtensionHostBar hideWebviews />)
    expect(screen.queryByTestId("vscode-extension-host-bar-webviews")).not.toBeInTheDocument()
  })

  it("re-evaluates visibility when a new panel registers (poll tick)", () => {
    const { rerender } = render(<VscodeExtensionHostBar />)
    expect(document.querySelector("[data-testid='vscode-extension-host-bar']")).toBeNull()

    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    act(() => {
      jest.advanceTimersByTime(250)
    })
    rerender(<VscodeExtensionHostBar />)
    expect(screen.getByTestId("vscode-extension-host-bar")).toBeInTheDocument()
  })
})
