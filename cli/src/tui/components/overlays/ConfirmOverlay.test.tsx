import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { ConfirmOverlay } from "./ConfirmOverlay"

const longBody = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")

function fire(input: string, key: Record<string, boolean> = {}): void {
  act(() => __fireInput(input, key))
}

describe("ConfirmOverlay", () => {
  beforeEach(() => __resetInk())

  it("renders the title and a viewport window with the confirm/cancel footer", () => {
    const { container } = render(
      <ConfirmOverlay
        title="Overwrite?"
        body={longBody}
        format="text"
        onConfirm={() => {}}
        onCancel={() => {}}
        viewportRows={16}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Overwrite?")
    expect(text).toContain("line 1")
    expect(text).toContain("line 10")
    expect(text).not.toContain("line 11")
    expect(text).toContain("Enter confirm")
    expect(text).toContain("Esc cancel")
  })

  it("shares duplicate-heading suppression and preserves a different heading", () => {
    const props = {
      body: "# Review changes\n\n- Keep source intact",
      format: "markdown" as const,
      onConfirm: jest.fn(),
      onCancel: jest.fn(),
    }
    const { container, rerender } = render(<ConfirmOverlay {...props} title="Review changes" />)
    expect(container.textContent!.match(/Review changes/g)).toHaveLength(1)
    expect(container.textContent).toContain("Keep source intact")
    rerender(<ConfirmOverlay {...props} title="Confirm overwrite?" />)
    expect(container.textContent).toContain("Confirm overwrite?")
    expect(container.textContent).toContain("Review changes")
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it("keeps every navigation route available after heading suppression", () => {
    const { container } = render(
      <ConfirmOverlay
        title="Tools"
        body={"# Tools\n\n" + Array.from({ length: 30 }, (_, i) => `- tool_${i}`).join("\n")}
        format="markdown"
        viewportRows={10}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    fire("[<65;1;1M")
    expect(container.textContent).toContain("2–5 / 30")
    fire("[<64;1;1M")
    fire("[<0;1;1M")
    fire(" ")
    fire("b")
    fire("", { pageDown: true })
    fire("", { pageUp: true })
    fire("G")
    fire("g")
    fire("", { upArrow: true })
    expect(container.textContent).toContain("1–4 / 30")
    fire("x")
  })

  it("confirms on Enter", () => {
    const onConfirm = jest.fn()
    const onCancel = jest.fn()
    render(
      <ConfirmOverlay
        title="t"
        body={longBody}
        format="text"
        onConfirm={onConfirm}
        onCancel={onCancel}
        viewportRows={16}
      />
    )
    fire("", { return: true })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("cancels on Escape and q", () => {
    const onCancel = jest.fn()
    render(
      <ConfirmOverlay
        title="t"
        body={longBody}
        format="text"
        onConfirm={() => {}}
        onCancel={onCancel}
        viewportRows={16}
      />
    )
    fire("", { escape: true })
    fire("q")
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it("scrolls the body without confirming", () => {
    const onConfirm = jest.fn()
    const { container } = render(
      <ConfirmOverlay
        title="t"
        body={longBody}
        format="text"
        onConfirm={onConfirm}
        onCancel={() => {}}
        viewportRows={16}
      />
    )
    fire("", { downArrow: true })
    expect(container.textContent).toContain("line 11")
    fire("", { pageDown: true })
    fire("G")
    expect(container.textContent).toContain("line 100")
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("renders markdown bodies through the markdown renderer", () => {
    const { container } = render(
      <ConfirmOverlay
        title="t"
        body={"# Heading\n\nsome **bold** text"}
        format="markdown"
        onConfirm={() => {}}
        onCancel={() => {}}
        viewportRows={20}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Heading")
    expect(text).toContain("bold")
  })
})
