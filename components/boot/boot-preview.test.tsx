/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

import { BootPreview, type BootPreviewSettled } from "./boot-preview"

const nothing: BootPreviewSettled = {
  accounts: false,
  preferences: false,
  interface: false,
  workspace: false,
}

function blocks(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="boot-preview-block"]'))
}

describe("BootPreview", () => {
  it("is decorative and hidden from assistive tech", () => {
    const { container } = render(<BootPreview settled={nothing} />)
    const root = container.querySelector('[data-slot="boot-preview"]')
    expect(root).toHaveAttribute("aria-hidden", "true")
  })

  it("starts fully ghosted when nothing has completed", () => {
    const { container } = render(<BootPreview settled={nothing} />)
    const all = blocks(container)
    expect(all.length).toBeGreaterThan(0)
    for (const block of all) expect(block).toHaveAttribute("data-settled", "false")
  })

  it("settles the avatar with the account read and nothing else", () => {
    const { container } = render(<BootPreview settled={{ ...nothing, accounts: true }} />)
    const settled = blocks(container).filter((b) => b.dataset.settled === "true")
    expect(settled).toHaveLength(1)
    expect(settled[0].className).toContain("rounded-full")
    expect(settled[0].className).toContain("border-success")
  })

  it("settles the window controls and header line with preferences", () => {
    const { container } = render(<BootPreview settled={{ ...nothing, preferences: true }} />)
    const settled = blocks(container).filter((b) => b.dataset.settled === "true")
    // three window dots + the header line
    expect(settled).toHaveLength(4)
  })

  it("settles the rail icons and composer with the interface", () => {
    const { container } = render(<BootPreview settled={{ ...nothing, interface: true }} />)
    const settled = blocks(container).filter((b) => b.dataset.settled === "true")
    // three rail icons + the composer
    expect(settled).toHaveLength(4)
  })

  it("keeps the content area as breathing skeletons regardless of progress", () => {
    const { container } = render(
      <BootPreview
        settled={{ accounts: true, preferences: true, interface: true, workspace: true }}
      />
    )
    // Content that only arrives with the workspace never pretends to be there.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(4)
    const ghosted = blocks(container).filter((b) => b.dataset.settled === "false")
    expect(ghosted).toHaveLength(0)
  })

  it("staggers each block through its --boot-i order", () => {
    const { container } = render(<BootPreview settled={nothing} />)
    const orders = blocks(container).map((b) => b.style.getPropertyValue("--boot-i"))
    expect(orders.every((value) => value !== "")).toBe(true)
  })

  it("accepts a className on the pane", () => {
    const { container } = render(<BootPreview settled={nothing} className="extra" />)
    expect(container.querySelector('[data-slot="boot-preview"]')).toHaveClass("extra")
  })
})
