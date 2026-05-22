/**
 * @jest-environment jsdom
 *
 * d3 ships ESM that Jest's CJS loader can't parse and the global
 * transformIgnorePatterns whitelist intentionally excludes it. We mock the
 * chainable subset used by D3ForceGraphRichOutput so the test focuses on the
 * one thing this change cares about: link / node / label paint colors flow
 * from the live appearance CSS vars (not hardcoded hex).
 */

// Build a chainable proxy that records every attribute call and lets us
// replay them per "kind" (link / circle / text) afterwards.
const recordedAttrs: Record<string, Array<[string, unknown]>> = {
  link: [],
  circle: [],
  text: [],
}
let currentKind: keyof typeof recordedAttrs = "link"

interface Chain {
  selectAll: (selector?: string) => Chain
  append: (tag: string) => Chain
  data: (rows?: unknown[]) => Chain
  enter: () => Chain
  attr: (name: string, value: unknown) => Chain
  text: (accessor?: unknown) => Chain
  on: (event: string, handler?: unknown) => Chain
  remove: () => Chain
}

function makeChainable(): Chain {
  const chain: Chain = {
    selectAll: () => chain,
    append: (tag: string) => {
      currentKind = tag === "line" ? "link" : tag === "circle" ? "circle" : "text"
      return chain
    },
    data: () => chain,
    enter: () => chain,
    attr: (name: string, value: unknown) => {
      recordedAttrs[currentKind].push([name, value])
      return chain
    },
    text: () => chain,
    on: () => chain,
    remove: () => chain,
  }
  return chain
}

interface SimChain {
  force: () => SimChain
  on: () => SimChain
  stop: () => void
}

jest.mock("d3", () => {
  const sim: SimChain = {
    force: () => sim,
    on: () => sim,
    stop: () => undefined,
  }
  return {
    select: () => {
      // Reset for each component render.
      recordedAttrs.link = []
      recordedAttrs.circle = []
      recordedAttrs.text = []
      return makeChainable()
    },
    forceSimulation: () => sim,
    forceLink: () => ({ id: () => ({ distance: () => undefined }) }),
    forceManyBody: () => ({ strength: () => undefined }),
    forceCenter: () => undefined,
  }
})

import { render } from "@testing-library/react"
import { D3ForceGraphRichOutput } from "./d3-force-graph-rich-output"

function allRecordedAttrValues(): unknown[] {
  return [...recordedAttrs.link, ...recordedAttrs.circle, ...recordedAttrs.text].map(
    ([, value]) => value
  )
}

describe("D3ForceGraphRichOutput", () => {
  it("paints links / nodes / labels through the live appearance CSS vars (no hardcoded hex)", () => {
    render(
      <D3ForceGraphRichOutput
        nodes={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
        edges={[{ source: "a", target: "b" }]}
      />
    )
    const values = allRecordedAttrValues()
    // The three semantic vars the component now flows through d3's attribute
    // calls — links / circles / labels respectively.
    expect(values).toContain("var(--muted-foreground)")
    expect(values).toContain("var(--primary)")
    expect(values).toContain("var(--primary-foreground)")
    // Regression guard against the previous hardcoded hex values.
    expect(values).not.toContain("#94a3b8")
    expect(values).not.toContain("#0ea5e9")
    expect(values).not.toContain("#fff")
  })

  it("renders without throwing when nodes and edges are empty", () => {
    expect(() => render(<D3ForceGraphRichOutput nodes={[]} edges={[]} />)).not.toThrow()
  })

  it("forwards the requested height to the SVG element", () => {
    const { container } = render(<D3ForceGraphRichOutput nodes={[]} edges={[]} height={240} />)
    const svg = container.querySelector("svg")
    expect(svg?.getAttribute("height")).toBe("240")
  })
})
