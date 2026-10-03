/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"

const mockPrepare = jest.fn()
const mockReceive = jest.fn()
const mockUpdateTheme = jest.fn()
const mockDispose = jest.fn()
const mockVisibility = jest.fn()
let posted: Array<Record<string, unknown>> = []
let post: ((envelope: Record<string, unknown>) => void) | null = null
jest.mock("@/lib/plugin/vscode-shim/webview-handlers", () => ({
  prepareWebviewFrame: (handle: string) => mockPrepare(handle),
  connectWebviewFrame: (
    _handle: string,
    _prepared: unknown,
    poster: (envelope: Record<string, unknown>) => void
  ) => {
    post = poster
    return { receive: mockReceive, updateTheme: mockUpdateTheme, dispose: mockDispose }
  },
  reportWebviewVisibility: (handle: string, visible: boolean) => mockVisibility(handle, visible),
}))

import {
  DEFAULT_WEBVIEW_OPTIONS,
  type VscodeWebviewRecord,
} from "@/lib/plugin/vscode-shim/webview-bridge"

import { VscodeWebviewFrame } from "./vscode-webview-frame"

const webview: VscodeWebviewRecord = {
  handle: "p1",
  pluginId: "acme.ext",
  kind: "panel",
  viewType: "acme.preview",
  title: "Preview",
  html: "<p>x</p>",
  options: DEFAULT_WEBVIEW_OPTIONS,
  revision: 0,
  state: undefined,
  resolved: true,
}

const wrap = (record: VscodeWebviewRecord, shown = true) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <VscodeWebviewFrame webview={record} shown={shown} />
  </NextIntlClientProvider>
)

beforeEach(() => {
  jest.clearAllMocks()
  posted = []
  post = null
})

it("loads, then runs the prepared document in a sandbox without same-origin", async () => {
  mockPrepare.mockResolvedValue({ srcDoc: "<p>doc</p>", sandbox: "allow-scripts", scripts: [] })
  const view = render(wrap(webview))
  expect(screen.getByTestId("vscode-webview-loading")).toHaveTextContent("Loading Preview…")
  const frame = await waitFor(() => screen.getByTitle("Preview") as HTMLIFrameElement)
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
  expect(frame.getAttribute("srcdoc")).toBe("<p>doc</p>")
  expect(mockPrepare).toHaveBeenCalledWith("p1")

  // Envelopes go into this frame; only this frame's messages are taken.
  const target = jest.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => undefined)
  post!({ kind: "x" })
  expect(target).toHaveBeenCalledWith({ kind: "x" }, "*")
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: "from-frame", source: frame.contentWindow })
    )
    window.dispatchEvent(new MessageEvent("message", { data: "elsewhere", source: window }))
  })
  expect(mockReceive.mock.calls).toEqual([["from-frame"]])

  act(() => {
    document.documentElement.classList.add("dark")
  })
  await waitFor(() => expect(mockUpdateTheme).toHaveBeenCalled())
  document.documentElement.classList.remove("dark")

  expect(mockVisibility).toHaveBeenLastCalledWith("p1", true)
  view.rerender(wrap(webview, false))
  expect(mockVisibility).toHaveBeenLastCalledWith("p1", false)

  // New html: a new document, a new connection.
  mockPrepare.mockResolvedValue({ srcDoc: "<p>two</p>", sandbox: "", scripts: [] })
  view.rerender(wrap({ ...webview, revision: 1 }))
  await waitFor(() => expect(screen.getByTitle("Preview")).toHaveAttribute("srcdoc", "<p>two</p>"))
  expect(mockDispose).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(mockDispose).toHaveBeenCalledTimes(2)
  expect(mockVisibility).toHaveBeenLastCalledWith("p1", false)
})

it("says when the webview could not be shown", async () => {
  mockPrepare.mockRejectedValue(new Error("gone"))
  render(wrap(webview))
  expect(await screen.findByTestId("vscode-webview-failed")).toHaveTextContent(
    "Preview could not be shown. Its extension's log has the details."
  )
  expect(posted).toEqual([])
})
