/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { UIMessage } from "ai"
import { BranchMessagePicker, previewOf } from "./branch-message-picker"

const messages = {
  chat: {
    branch: {
      pick: {
        label: "Carry {count} selected",
        all: "Select all",
        none: "Clear",
        roleUser: "You",
        roleAssistant: "Assistant",
      },
    },
  },
}

const msg = (id: string, role: UIMessage["role"], text: string): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage

const thread = [
  msg("u1", "user", "first question"),
  msg("a1", "assistant", "first answer"),
  msg("a2", "assistant", "second answer"),
]

function renderPicker(selected: string[], onChange = jest.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BranchMessagePicker messages={thread} selected={new Set(selected)} onChange={onChange} />
    </NextIntlClientProvider>
  )
  return onChange
}

describe("previewOf", () => {
  it("collapses whitespace", () => {
    expect(previewOf(msg("m", "user", "  a   b\nc "))).toBe("a b c")
  })

  it("elides a long message", () => {
    const p = previewOf(msg("m", "user", "x".repeat(200)))
    expect(p.endsWith("…")).toBe(true)
    expect(p.length).toBeLessThanOrEqual(91)
  })

  it("returns empty for a tool-only turn", () => {
    expect(previewOf({ id: "m", role: "assistant", parts: [{ type: "tool" }] } as never)).toBe("")
  })
})

describe("BranchMessagePicker", () => {
  it("shows one row per message with a role prefix", () => {
    renderPicker([])
    expect(screen.getAllByRole("checkbox")).toHaveLength(3)
    expect(screen.getByText("first question")).toBeInTheDocument()
    expect(screen.getAllByText("Assistant")).toHaveLength(2)
  })

  it("omits tool-only turns, which would render as an empty row", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BranchMessagePicker
          messages={[
            msg("u1", "user", "kept"),
            { id: "t1", role: "assistant", parts: [] } as never,
          ]}
          selected={new Set()}
          onChange={jest.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
  })

  it("toggles a single message without disturbing the rest", () => {
    const onChange = renderPicker(["u1", "a1"])
    fireEvent.click(screen.getAllByRole("checkbox")[1])
    expect([...onChange.mock.calls[0][0]]).toEqual(["u1"])
  })

  it("selects all when some are unchecked", () => {
    const onChange = renderPicker(["u1"])
    fireEvent.click(screen.getByRole("button", { name: "Select all" }))
    expect([...onChange.mock.calls[0][0]].sort()).toEqual(["a1", "a2", "u1"])
  })

  it("clears when everything is already checked", () => {
    const onChange = renderPicker(["u1", "a1", "a2"])
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect([...onChange.mock.calls[0][0]]).toEqual([])
  })

  it("renders nothing when there is nothing pickable", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BranchMessagePicker messages={[]} selected={new Set()} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(container.firstChild).toBeNull()
  })
})
