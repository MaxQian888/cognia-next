/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// jsdom has no layout: render every virtual row and record the count.
const virtualCounts: number[] = []
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualCounts.push(count)
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 20 })),
      getTotalSize: () => count * 20,
      measureElement: jest.fn(),
      scrollToIndex: jest.fn(),
    }
  },
}))

import { DiffPreview } from "./diff-preview"

function types() {
  return screen.getAllByTestId("line-diff-line").map((l) => l.getAttribute("data-type"))
}

beforeEach(() => {
  virtualCounts.length = 0
})

describe("DiffPreview", () => {
  it("diffs the two snippets line by line instead of listing both whole", () => {
    render(<DiffPreview oldText={"keep\nold\ntail"} newText={"keep\nnew\ntail"} />)
    expect(types()).toEqual(["unchanged", "removed", "added", "unchanged"])
  })

  it("shows a pure addition (write preview) as additions only", () => {
    render(<DiffPreview oldText="" newText={"line1\nline2"} />)
    expect(types()).toEqual(["added", "added"])
  })

  it("shows a pure removal as removals only", () => {
    render(<DiffPreview oldText="gone" newText="" />)
    expect(types()).toEqual(["removed"])
  })

  it("emphasises the changed run of an edited line", () => {
    render(<DiffPreview oldText="const a = 1" newText="const a = 2" />)
    const intraline = screen.getAllByTestId("line-diff-intraline")
    expect(intraline.map((n) => n.textContent)).toEqual(["1", "2"])
  })

  it("keeps a sign-only gutter: snippet line numbers would mislead", () => {
    render(<DiffPreview oldText="a" newText="b" />)
    expect(screen.getAllByTestId("line-diff-line")[0]).not.toHaveTextContent("1")
  })

  it("virtualizes a large payload instead of clamping it", () => {
    const newText = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join("\n")
    render(<DiffPreview oldText="" newText={newText} />)
    expect(virtualCounts.at(-1)).toBe(5000)
    expect(screen.getByTestId("diff-preview-lines")).toHaveAttribute("data-wrap", "true")
  })

  it("renders nothing for two empty payloads", () => {
    const { container } = render(<DiffPreview oldText="" newText="" />)
    expect(container).toBeEmptyDOMElement()
  })
})
