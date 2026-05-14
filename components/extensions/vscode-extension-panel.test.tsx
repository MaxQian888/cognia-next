import { render, screen } from "@testing-library/react"
import { act } from "react"
import {
  __resetWebviewBridgeForTesting,
  createWebviewPanel,
} from "@/lib/plugin/vscode-shim/webview-bridge"
import { VscodeExtensionPanel } from "./vscode-extension-panel"

describe("<VscodeExtensionPanel />", () => {
  beforeEach(() => {
    __resetWebviewBridgeForTesting()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders the empty state when no panels exist", () => {
    render(<VscodeExtensionPanel />)
    expect(screen.getByTestId("vscode-extension-panel-empty")).toBeInTheDocument()
  })

  it("renders an iframe header + iframe for a registered panel", async () => {
    const panel = createWebviewPanel({
      extensionId: "ext.cline",
      viewType: "cline.sidebar",
      title: "Cline",
      type: "view",
      hostSlot: "sidebar.left",
      options: { enableScripts: true },
      initialHtml: "<p>hi</p>",
    })
    render(<VscodeExtensionPanel slot="sidebar.left" />)
    // The polling-based panel list runs every 250ms; advance one tick so
    // the first listPanels() refresh fires.
    await act(async () => {
      jest.advanceTimersByTime(300)
    })
    expect(screen.getByTestId(`vscode-webview-${panel.panelId}`)).toBeInTheDocument()
    expect(screen.getByLabelText(/Close Cline/i)).toBeInTheDocument()
  })

  it("filters by slot so right-sidebar panels don't show in the left", async () => {
    const left = createWebviewPanel({
      extensionId: "ext.a",
      viewType: "a.view",
      title: "Left",
      type: "view",
      hostSlot: "sidebar.left",
      options: {},
      initialHtml: "",
    })
    const right = createWebviewPanel({
      extensionId: "ext.b",
      viewType: "b.view",
      title: "Right",
      type: "view",
      hostSlot: "sidebar.right",
      options: {},
      initialHtml: "",
    })
    render(<VscodeExtensionPanel slot="sidebar.left" />)
    await act(async () => {
      jest.advanceTimersByTime(300)
    })
    expect(screen.queryByTestId(`vscode-webview-${left.panelId}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`vscode-webview-${right.panelId}`)).not.toBeInTheDocument()
  })
})
