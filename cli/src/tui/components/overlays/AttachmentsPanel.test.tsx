import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AttachmentsPanel, type AttachmentRow } from "./AttachmentsPanel"
import { absoluteTopLeft } from "../../input/element-position"

jest.mock("../../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const rows: AttachmentRow[] = [
  { label: "[Image 1]", path: "/tmp/a.png", exists: true },
  { label: "[Image 2]", path: "/tmp/b.png", exists: false },
]

function wrap(props: Partial<React.ComponentProps<typeof AttachmentsPanel>> = {}) {
  const cb = { onRemove: jest.fn(), onOpen: jest.fn(), onCancel: jest.fn() }
  const result = render(<AttachmentsPanel rows={rows} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("AttachmentsPanel", () => {
  beforeEach(() => __resetInk())

  it("lists every attachment with its label, path and a missing badge", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("Image attachments")
    expect(text).toContain("[Image 1]")
    expect(text).toContain("/tmp/a.png")
    expect(text).toContain("[Image 2]")
    expect(text).toContain("missing")
    expect(text).toContain("d remove")
  })

  it("renders the empty state when the draft holds no attachments", () => {
    const text = wrap({ rows: [] }).container.textContent ?? ""
    expect(text).toContain("no image attachments")
    expect(text).toContain("0")
  })

  it("moves the selection with ↑/↓ and removes the highlighted row on d", () => {
    const { onRemove } = wrap()
    key("d")
    expect(onRemove).toHaveBeenCalledWith(["[Image 1]"])
    key("", { downArrow: true })
    key("d")
    expect(onRemove).toHaveBeenLastCalledWith(["[Image 2]"])
    key("", { upArrow: true })
    key("d")
    expect(onRemove).toHaveBeenLastCalledWith(["[Image 1]"])
  })

  it("removes the highlighted row on backspace and clears all on c", () => {
    const { onRemove } = wrap()
    key("", { backspace: true })
    expect(onRemove).toHaveBeenCalledWith(["[Image 1]"])
    key("c")
    expect(onRemove).toHaveBeenCalledWith(["[Image 1]", "[Image 2]"])
  })

  it("opens the highlighted image on Enter and closes on Esc", () => {
    const { onOpen, onCancel } = wrap()
    key("", { downArrow: true })
    key("", { return: true })
    expect(onOpen).toHaveBeenCalledWith("/tmp/b.png")
    key("", { escape: true })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("swallows ordinary keys without touching the composer", () => {
    const cb = { onRemove: jest.fn(), onOpen: jest.fn(), onCancel: jest.fn() }
    render(<AttachmentsPanel rows={rows} {...cb} />)
    key("x")
    key("", { leftArrow: true })
    expect(cb.onRemove).not.toHaveBeenCalled()
    expect(cb.onOpen).not.toHaveBeenCalled()
    expect(cb.onCancel).not.toHaveBeenCalled()
  })

  it("stays quiet while inactive", () => {
    const { onCancel } = wrap({ isActive: false })
    key("", { escape: true })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("clamps the selection when the row list shrinks under it", () => {
    const cb = { onRemove: jest.fn(), onOpen: jest.fn(), onCancel: jest.fn() }
    const { rerender } = render(<AttachmentsPanel rows={rows} {...cb} />)
    key("", { downArrow: true })
    // The selected row was removed upstream — index clamps, next d hits row 0.
    rerender(<AttachmentsPanel rows={[rows[0]]} {...cb} />)
    key("d")
    expect(cb.onRemove).toHaveBeenLastCalledWith(["[Image 1]"])
  })
})
