import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen } from "@testing-library/react"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"
import { RICH_BLOCK_ACTIONS_HOVER_CLASS, RichBlockFrame } from "./rich-block-frame"

describe("RichBlockFrame", () => {
  it("draws the shared frame with a header bar, label, meta and actions", () => {
    const { container } = render(
      <RichBlockFrame
        kind="table"
        icon={<svg data-testid="icon" />}
        label="Table"
        meta="3 rows"
        actions={<button type="button">copy</button>}
      >
        <p>body</p>
      </RichBlockFrame>
    )
    const frame = container.firstElementChild as HTMLElement
    expect(frame).toHaveAttribute("data-rich-block", "table")
    expect(frame).toHaveClass("not-typeset", "rounded-lg", "border", "my-(--rich-block-gap)")
    const header = frame.querySelector("[data-rich-block-header]")!
    expect(header).toHaveClass("h-8")
    expect(header).toHaveTextContent("Table")
    expect(header).toHaveTextContent("3 rows")
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute("aria-hidden")
    expect(frame.querySelector("[data-rich-block-body]")).toHaveTextContent("body")
  })

  it("exposes the header hooks the blockBorder / blockHeader CSS relies on", () => {
    // jsdom applies no stylesheet, so pin both halves of the contract: the
    // DOM hooks here, and the selectors in globals.css that consume them.
    const { container } = render(
      <RichBlockFrame
        kind="chart"
        icon={<svg />}
        label="Chart"
        meta="Bar"
        actions={<button type="button">copy</button>}
      >
        body
      </RichBlockFrame>
    )
    const header = container.querySelector("[data-rich-block-header]")!
    expect(header.querySelectorAll("[data-rich-block-title]")).toHaveLength(3)
    const actions = header.querySelector("[data-rich-block-actions]")!
    expect(actions).toContainElement(screen.getByRole("button", { name: "copy" }))
    expect(actions).toHaveAttribute("data-message-rich-control")

    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8")
    for (const selector of [
      '[data-block-border="off"] :is([data-rich-block], [data-streamdown="code-block"])',
      '[data-block-header="off"] [data-rich-block-header] {',
      '[data-block-header="off"] [data-rich-block-title]',
      '[data-block-header="off"] [data-streamdown="code-block-header"]',
      ':is([data-rich-block-actions], [data-streamdown="code-block-actions"])',
      // Headers off: the floating toolbar is hover-only even under `always`.
      '[data-block-header="off"] [data-rich-block-header] [data-rich-block-actions],',
      "opacity: 0 !important;",
    ]) {
      expect(css).toContain(selector)
    }
  })

  it("follows the shared hover-reveal policy with its own named group", () => {
    render(
      <RichBlockFrame kind="code" label="ts" actions={<button type="button">copy</button>}>
        x
      </RichBlockFrame>
    )
    const toolbar = screen.getByRole("button", { name: "copy" }).parentElement!
    expect(toolbar).toHaveAttribute("data-message-rich-control")
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.groupBase) {
      expect(toolbar).toHaveClass(variant)
    }
    expect(toolbar).toHaveClass(RICH_BLOCK_ACTIONS_HOVER_CLASS)
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(toolbar).not.toHaveClass(forbidden)
    }
  })

  it("floats the actions over the body in overlay mode and drops the bar", () => {
    const { container } = render(
      <RichBlockFrame kind="math" header="overlay" actions={<button type="button">copy</button>}>
        formula
      </RichBlockFrame>
    )
    expect(container.querySelector("[data-rich-block-header]")).toBeNull()
    const toolbar = screen.getByRole("button", { name: "copy" }).parentElement!
    expect(toolbar).toHaveClass("absolute")
    expect(toolbar).toHaveAttribute("data-message-rich-control")
  })

  it("renders no chrome at all with header none", () => {
    const { container } = render(
      <RichBlockFrame kind="audio" header="none" actions={<button type="button">x</button>}>
        player
      </RichBlockFrame>
    )
    expect(container.querySelector("[data-rich-block-header]")).toBeNull()
    expect(container.querySelector("[data-message-rich-control]")).toBeNull()
  })

  it("packs a compact frame and renders a footer", () => {
    const { container } = render(
      <RichBlockFrame kind="code" compact label="ts" footer={<div>more</div>}>
        x
      </RichBlockFrame>
    )
    const frame = container.firstElementChild as HTMLElement
    expect(frame).toHaveClass("my-1", "rounded-md")
    expect(frame.querySelector("[data-rich-block-header]")).toHaveClass("h-7")
    expect(frame).toHaveTextContent("more")
  })
})
