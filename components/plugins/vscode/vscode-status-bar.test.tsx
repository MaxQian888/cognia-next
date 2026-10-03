/**
 * @jest-environment jsdom
 */

const mockExecute = jest.fn(async () => undefined)
jest.mock("@/lib/plugin/commands/registry", () => ({
  executeCommandWithOptions: (...args: unknown[]) => mockExecute(...(args as [])),
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import {
  __resetVscodeWindowForTesting,
  setStatusBarItem,
  setStatusBarMessage,
  startProgress,
} from "@/lib/plugin/vscode-shim/window-ui-store"

import { VscodeStatusBarEntries } from "./vscode-status-bar"

const wrap = (alignment: 1 | 2) =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VscodeStatusBarEntries pluginId="ext.a" alignment={alignment} />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  __resetVscodeWindowForTesting()
  mockExecute.mockClear()
})

it("renders nothing until the extension shows something", () => {
  const { container } = wrap(1)
  expect(container).toBeEmptyDOMElement()
})

it("shows items, messages and progress, and runs an item's command", async () => {
  const user = userEvent.setup()
  setStatusBarItem("ext.a", "i", {
    id: "x",
    alignment: 1,
    visible: true,
    text: "$(check) Ready",
    tooltip: "All good",
    command: { command: "ext.a.status", arguments: [1] },
    backgroundColor: "theme:statusBarItem.errorBackground",
  })
  setStatusBarMessage("ext.a", "m", "Saving…")
  startProgress({
    handle: "p",
    pluginId: "ext.a",
    location: "statusBar",
    title: "Index",
    cancellable: false,
  })
  wrap(1)
  expect(screen.getByText("Saving…")).toBeInTheDocument()
  expect(screen.getByText("Index")).toBeInTheDocument()
  const button = screen.getByRole("button", { name: "Ready" })
  expect(button).toHaveAttribute("title", "All good")
  expect(button.className).toContain("bg-destructive")
  await user.click(button)
  expect(mockExecute).toHaveBeenCalledWith("ext.a.status", { origin: "user" }, 1)
})

it("keeps to its side and follows updates", () => {
  setStatusBarItem("ext.a", "i", {
    id: "x",
    alignment: 2,
    visible: true,
    text: "Right",
    color: "#f00",
  })
  wrap(2)
  expect(screen.getByText("Right").closest("span[aria-label]")).toHaveStyle({ color: "#f00" })
  act(() =>
    setStatusBarItem("ext.a", "i", { id: "x", alignment: 2, visible: false, text: "Right" })
  )
  expect(screen.queryByText("Right")).not.toBeInTheDocument()
})
