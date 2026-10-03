/**
 * @jest-environment jsdom
 */

const mockSend = jest.fn()
const mockDismiss = jest.fn()
jest.mock("@/lib/plugin/vscode-shim/window-handlers", () => ({
  sendQuickInputEvent: (...args: unknown[]) => mockSend(...args),
  dismissQuickInput: (...args: unknown[]) => mockDismiss(...args),
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"
import {
  __resetVscodeWindowForTesting,
  closeQuickInputSession,
  getQuickInputSession,
  openQuickInputSession,
  updateQuickInputSession,
  type QuickInputState,
} from "@/lib/plugin/vscode-shim/window-ui-store"

import { VscodeQuickInput } from "./vscode-quick-input"

beforeAll(() => {
  // cmdk scrolls the active item into view.
  Element.prototype.scrollIntoView = jest.fn()
})

beforeEach(() => {
  __resetVscodeWindowForTesting()
  mockSend.mockClear()
  mockDismiss.mockClear()
})

function show(kind: "pick" | "input", state: QuickInputState) {
  openQuickInputSession({ sessionId: "s", pluginId: "ext.a", kind, state })
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TooltipProvider>
        <VscodeQuickInput modalId="m" onClose={() => {}} args={{ sessionId: "s" }} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

const events = () => mockSend.mock.calls.map((call) => call[2])

it("filters as the user types and accepts the chosen item", async () => {
  const user = userEvent.setup()
  show("pick", {
    title: "Pick a file",
    step: 1,
    totalSteps: 2,
    items: [
      { label: "alpha.ts", description: "src" },
      { label: "beta.ts" },
      { label: "", separator: true },
    ],
  })
  expect(screen.getByText("Pick a file")).toBeInTheDocument()
  expect(screen.getByText("1 of 2")).toBeInTheDocument()
  await user.type(screen.getByRole("combobox"), "bt")
  expect(screen.queryByText("alpha.ts")).not.toBeInTheDocument()
  expect(events()).toContainEqual({ type: "value", value: "bt" })
  await user.click(screen.getByText("beta.ts"))
  expect(events().at(-1)).toEqual({ type: "accept", selected: [1] })
})

it("shows the extension's updates while open", () => {
  show("pick", { items: [{ label: "one" }], busy: false })
  act(() => {
    updateQuickInputSession("s", { items: [{ label: "two" }], busy: true })
  })
  expect(screen.getByText("two")).toBeInTheDocument()
  expect(screen.getByLabelText("Working…")).toBeInTheDocument()
})

it("multi-select toggles items and accepts with OK", async () => {
  const user = userEvent.setup()
  show("pick", {
    canSelectMany: true,
    items: [{ label: "a" }, { label: "b" }],
    selectedIndices: [1],
  })
  expect(screen.getByText("1 selected")).toBeInTheDocument()
  await user.click(screen.getByText("a"))
  expect(events()).toContainEqual({ type: "selection", indices: [1, 0] })
  expect(getQuickInputSession("s")?.state.selectedIndices).toEqual([1, 0])
  await user.click(screen.getByRole("button", { name: "OK" }))
  expect(events().at(-1)).toEqual({ type: "accept" })
})

it("item and title buttons report which was pressed", async () => {
  const user = userEvent.setup()
  show("pick", {
    buttons: [{ icon: "refresh", tooltip: "Reload" }],
    items: [{ label: "a", buttons: [{ icon: "trash", tooltip: "Remove" }] }],
  })
  await user.click(screen.getByRole("button", { name: "Reload" }))
  await user.click(screen.getByRole("button", { name: "Remove" }))
  expect(events()).toEqual(
    expect.arrayContaining([
      { type: "button", index: 0 },
      { type: "itemButton", item: 0, button: 0 },
    ])
  )
})

it("input box: password, validation and accept", async () => {
  const user = userEvent.setup()
  show("input", { prompt: "Token", password: true, value: "" })
  const input = screen.getByLabelText("Token")
  expect(input).toHaveAttribute("type", "password")
  await user.type(input, "x")
  expect(events()).toContainEqual({ type: "value", value: "x" })
  act(() => {
    updateQuickInputSession("s", { validationMessage: { message: "Too short", severity: 3 } })
  })
  expect(screen.getByRole("alert")).toHaveTextContent("Too short")
  expect(input).toHaveAttribute("aria-invalid", "true")
  await user.type(input, "{Enter}")
  expect(events().at(-1)).toEqual({ type: "accept" })
})

it("unmounting while open is a dismissal; closing by the extension is not", () => {
  const first = show("input", {})
  first.unmount()
  expect(mockDismiss).toHaveBeenCalledWith("s")

  mockDismiss.mockClear()
  const second = show("input", {})
  act(() => {
    closeQuickInputSession("s")
  })
  second.unmount()
  expect(mockDismiss).not.toHaveBeenCalled()
})
