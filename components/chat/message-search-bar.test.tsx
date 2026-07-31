/** @jest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import type { UIMessage } from "ai"
import { MessageSearchBar } from "./message-search-bar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const textMsg = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as unknown as UIMessage

const MESSAGES = [
  textMsg("m0", "deploy the worker"),
  textMsg("m1", "unrelated chatter"),
  textMsg("m2", "deploy again"),
  textMsg("m3", "and once more: deploy"),
]

function renderBar(overrides?: { messages?: UIMessage[] }) {
  const onJump = jest.fn()
  const onActiveHitChange = jest.fn()
  const onClose = jest.fn()
  const view = render(
    <MessageSearchBar
      messages={overrides?.messages ?? MESSAGES}
      onJump={onJump}
      onActiveHitChange={onActiveHitChange}
      onClose={onClose}
    />
  )
  return { onJump, onActiveHitChange, onClose, view }
}

const input = () => screen.getByRole("textbox", { name: "label" })
const type = (value: string) => fireEvent.change(input(), { target: { value } })
const count = () => screen.getByTestId("message-search-count").textContent

afterEach(() => cleanup())

describe("MessageSearchBar", () => {
  it("focuses the input on open so the shortcut alone is enough", () => {
    renderBar()
    expect(input()).toHaveFocus()
  })

  it("shows no readout until something is typed", () => {
    renderBar()
    expect(count()).toBe("")
  })

  it("reports the hit position and jumps to the first hit as you type", () => {
    const { onJump } = renderBar()
    type("deploy")
    expect(count()).toBe('position:{"current":1,"total":3}')
    expect(onJump).toHaveBeenCalledWith({ id: "m0", index: 0, count: 1 })
  })

  it("Enter advances to the next hit", () => {
    const { onJump } = renderBar()
    type("deploy")
    onJump.mockClear()
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(onJump).toHaveBeenCalledWith({ id: "m2", index: 2, count: 1 })
    expect(count()).toBe('position:{"current":2,"total":3}')
  })

  it("Enter wraps from the last hit back to the first", () => {
    const { onJump } = renderBar()
    type("deploy")
    fireEvent.keyDown(input(), { key: "Enter" })
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(count()).toBe('position:{"current":3,"total":3}')
    onJump.mockClear()
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(onJump).toHaveBeenCalledWith({ id: "m0", index: 0, count: 1 })
    expect(count()).toBe('position:{"current":1,"total":3}')
  })

  it("Shift+Enter steps backwards, wrapping to the last hit", () => {
    const { onJump } = renderBar()
    type("deploy")
    onJump.mockClear()
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true })
    expect(onJump).toHaveBeenCalledWith({ id: "m3", index: 3, count: 1 })
  })

  it("the next/prev buttons mirror the keyboard", () => {
    const { onJump } = renderBar()
    type("deploy")
    onJump.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "next" }))
    expect(onJump).toHaveBeenCalledWith({ id: "m2", index: 2, count: 1 })
    fireEvent.click(screen.getByRole("button", { name: "previous" }))
    expect(onJump).toHaveBeenLastCalledWith({ id: "m0", index: 0, count: 1 })
  })

  it("reports no matches and disables navigation", () => {
    renderBar()
    type("nothing-matches-this")
    expect(count()).toBe("noResults")
    expect(screen.getByRole("button", { name: "next" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "previous" })).toBeDisabled()
  })

  it("publishes the active hit id for the row highlight", () => {
    const { onActiveHitChange } = renderBar()
    type("deploy")
    expect(onActiveHitChange).toHaveBeenLastCalledWith("m0")
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(onActiveHitChange).toHaveBeenLastCalledWith("m2")
  })

  it("clears the active hit when the query stops matching", () => {
    const { onActiveHitChange } = renderBar()
    type("deploy")
    type("deployzzz")
    expect(onActiveHitChange).toHaveBeenLastCalledWith(null)
  })

  it("clears the highlight on unmount so no stale ring survives", () => {
    const { onActiveHitChange, view } = renderBar()
    type("deploy")
    onActiveHitChange.mockClear()
    view.unmount()
    expect(onActiveHitChange).toHaveBeenCalledWith(null)
  })

  it("Escape closes the bar", () => {
    const { onClose } = renderBar()
    fireEvent.keyDown(input(), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("the close button closes the bar", () => {
    const { onClose } = renderBar()
    fireEvent.click(screen.getByRole("button", { name: "close" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("does not jump on an empty conversation", () => {
    const { onJump } = renderBar({ messages: [] })
    type("deploy")
    expect(onJump).not.toHaveBeenCalled()
    expect(count()).toBe("noResults")
  })
})
