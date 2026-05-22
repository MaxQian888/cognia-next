/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

const listPanelsMock = jest.fn(() => [] as Array<Record<string, unknown>>)

jest.mock("@/lib/plugin/vscode-shim/webview-bridge", () => ({
  listPanels: () => listPanelsMock(),
}))

// The inner panel is mocked — we're testing the host bar's visibility
// gating, not its internals.
jest.mock("./vscode-extension-panel", () => ({
  VscodeExtensionPanel: () => <div data-testid="mock-webview-panel" />,
}))

import { VscodeExtensionHostBar } from "./vscode-extension-host-bar"

beforeEach(() => {
  jest.useFakeTimers()
  listPanelsMock.mockReturnValue([])
})

afterEach(() => {
  jest.useRealTimers()
})

describe("VscodeExtensionHostBar", () => {
  it("renders null when no extension has registered a webview", () => {
    const { container } = render(<VscodeExtensionHostBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the webview sub-panel when a webview is registered", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar" }])
    render(<VscodeExtensionHostBar />)
    expect(screen.getByTestId("vscode-extension-host-bar")).toBeInTheDocument()
    expect(screen.getByTestId("vscode-extension-host-bar-webviews")).toBeInTheDocument()
  })

  it("respects the webviewSlot filter", () => {
    listPanelsMock.mockReturnValue([
      { panelId: "p1", hostSlot: "sidebar.left" },
      { panelId: "p2", hostSlot: "panel.bottom" },
    ])
    render(<VscodeExtensionHostBar webviewSlot="panel.bottom" />)
    expect(screen.getByTestId("vscode-extension-host-bar")).toBeInTheDocument()
  })

  it("returns null when webviewSlot filter rules every panel out", () => {
    listPanelsMock.mockReturnValue([{ panelId: "p1", hostSlot: "sidebar.left" }])
    const { container } = render(<VscodeExtensionHostBar webviewSlot="panel.bottom" />)
    expect(container).toBeEmptyDOMElement()
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
