/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"

// The tabs are tested on their own; here, only whether the rail shows.
jest.mock("./vscode-extension-panel", () => {
  const actual = jest.requireActual("./vscode-extension-panel")
  return { ...actual, VscodeExtensionPanel: () => <div data-testid="mock-webview-panel" /> }
})

import {
  __resetWebviewBridgeForTesting,
  addWebview,
  DEFAULT_WEBVIEW_OPTIONS,
  removeWebview,
} from "@/lib/plugin/vscode-shim/webview-bridge"

import { VscodeExtensionHostBar } from "./vscode-extension-host-bar"

beforeEach(() => __resetWebviewBridgeForTesting())

describe("VscodeExtensionHostBar", () => {
  it("takes no room until an extension shows a webview, and goes when it closes", () => {
    const { container } = render(<VscodeExtensionHostBar className="w-72" />)
    expect(container).toBeEmptyDOMElement()
    act(() => {
      addWebview(
        {
          handle: "p1",
          pluginId: "acme.ext",
          kind: "panel",
          viewType: "acme.preview",
          title: "Preview",
          html: "",
          options: DEFAULT_WEBVIEW_OPTIONS,
        },
        { select: true }
      )
    })
    expect(screen.getByTestId("vscode-extension-host-bar")).toHaveClass("w-72")
    expect(screen.getByTestId("mock-webview-panel")).toBeInTheDocument()
    act(() => {
      removeWebview("p1")
    })
    expect(container).toBeEmptyDOMElement()
  })
})
