/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"

const mockClose = jest.fn()
jest.mock("@/lib/plugin/vscode-shim/webview-handlers", () => ({
  closeWebview: (handle: string) => mockClose(handle),
}))
// Frames are tested on their own; here, which ones the tabs keep.
jest.mock("./vscode-webview-frame", () => ({
  VscodeWebviewFrame: ({ webview, shown }: { webview: { handle: string }; shown: boolean }) => (
    <div data-testid={`frame-${webview.handle}`} data-shown={shown} />
  ),
}))

import {
  __resetWebviewBridgeForTesting,
  addWebview,
  DEFAULT_WEBVIEW_OPTIONS,
  getSelectedWebview,
  updateWebview,
  type VscodeWebviewRecord,
} from "@/lib/plugin/vscode-shim/webview-bridge"

import { VscodeExtensionPanel } from "./vscode-extension-panel"

const wrap = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VscodeExtensionPanel />
    </NextIntlClientProvider>
  )

function add(handle: string, extra: Partial<VscodeWebviewRecord> = {}, select = false): void {
  act(() => {
    addWebview(
      {
        handle,
        pluginId: "acme.ext",
        kind: "panel",
        viewType: `acme.${handle}`,
        title: handle.toUpperCase(),
        html: "",
        options: DEFAULT_WEBVIEW_OPTIONS,
        ...extra,
      },
      { select }
    )
  })
}

beforeEach(() => {
  __resetWebviewBridgeForTesting()
  mockClose.mockClear()
})

it("says so when no extension shows a webview", () => {
  wrap()
  expect(screen.getByTestId("vscode-extension-panel-empty")).toHaveTextContent(
    "No VS Code extension is showing a webview."
  )
})

it("shows one tab at a time, keeping hidden frames only when asked to", async () => {
  const user = userEvent.setup()
  wrap()
  add("one", {}, true)
  add("two", { options: { ...DEFAULT_WEBVIEW_OPTIONS, retainContextWhenHidden: true } })
  add("three")
  expect(screen.getByRole("tablist", { name: "Extension webviews" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "ONE" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByTestId("frame-one")).toHaveAttribute("data-shown", "true")
  // Retained even while hidden; the third is not mounted until shown.
  expect(screen.getByTestId("frame-two")).toHaveAttribute("data-shown", "false")
  expect(screen.queryByTestId("frame-three")).toBeNull()
  await user.click(screen.getByRole("tab", { name: "THREE" }))
  expect(getSelectedWebview()).toBe("three")
  expect(screen.getByTestId("frame-three")).toHaveAttribute("data-shown", "true")
  expect(screen.queryByTestId("frame-one")).toBeNull()
})

it("closes panels, not views, and shows a view only once its provider is asked", async () => {
  const user = userEvent.setup()
  wrap()
  add("panel", {}, true)
  add("view", { kind: "view", token: "t", resolved: false, description: "2 items" })
  await user.click(screen.getByRole("button", { name: "Close PANEL" }))
  expect(mockClose).toHaveBeenCalledWith("panel")
  expect(screen.queryByRole("button", { name: "Close VIEW" })).toBeNull()
  expect(screen.getByText("2 items")).toBeInTheDocument()
  await user.click(screen.getByRole("tab", { name: /VIEW/ }))
  expect(screen.queryByTestId("frame-view")).toBeNull()
  act(() => {
    updateWebview("view", { resolved: true, badge: { value: 4, tooltip: "Four" } })
  })
  expect(screen.getByTestId("frame-view")).toBeInTheDocument()
  expect(screen.getByTitle("Four")).toHaveTextContent("4")
  expect(screen.getByRole("tab", { name: /VIEW/ })).toHaveAttribute(
    "title",
    "VIEW — 2 items — From acme.ext"
  )
})
