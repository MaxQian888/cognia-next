import { render, screen } from "@testing-library/react"

let reduced = false
const groupProps: Array<Record<string, unknown>> = []
const itemProps: Array<Record<string, unknown>> = []

jest.mock("motion/react", () => {
  // One cached component per tag, mirroring the real proxy. If this minted a
  // new type per render the subtree would remount, which is the exact hazard
  // `reveal-group.tsx` avoids by indexing `motion[tag]` over `motion.create`.
  const cache = new Map<string, unknown>()
  const make = (tag: string) => {
    const Component = ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
    }) => {
      // The group carries `variants.visible.transition`; items carry `variants.hidden`.
      const record = props as Record<string, unknown>
      const variants = record.variants as { hidden?: Record<string, unknown> } | undefined
      if (variants && "opacity" in (variants.hidden ?? {})) itemProps.push(record)
      else if (variants) groupProps.push(record)
      const Tag = tag as "div"
      return (
        <Tag className={className} data-motion={tag}>
          {children}
        </Tag>
      )
    }
    return Component
  }
  return {
    useReducedMotion: () => reduced,
    motion: new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (!cache.has(prop)) cache.set(prop, make(prop))
          return cache.get(prop)
        },
      }
    ),
  }
})

import { RevealGroup, RevealItem } from "./reveal-group"

describe("RevealGroup", () => {
  beforeEach(() => {
    reduced = false
    groupProps.length = 0
    itemProps.length = 0
  })

  it("renders its children", () => {
    render(
      <RevealGroup>
        <RevealItem>cell</RevealItem>
      </RevealGroup>
    )
    expect(screen.getByText("cell")).toBeInTheDocument()
  })

  it("preserves list semantics rather than wrapping grids in divs", () => {
    render(
      <RevealGroup as="ul">
        <RevealItem as="li">one</RevealItem>
        <RevealItem as="li">two</RevealItem>
      </RevealGroup>
    )
    expect(screen.getByRole("list")).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })

  it("staggers its children", () => {
    render(
      <RevealGroup stagger={0.06}>
        <RevealItem>a</RevealItem>
      </RevealGroup>
    )
    const visible = (groupProps[0].variants as { visible: { transition: Record<string, number> } })
      .visible
    expect(visible.transition.staggerChildren).toBe(0.06)
  })

  it("caps the cascade so a nine-cell grid does not trail half a second", () => {
    // The last item must still start within the budget, or the grid reads as
    // the page struggling rather than as a considered sequence.
    render(
      <RevealGroup stagger={0.06} count={9}>
        <RevealItem>a</RevealItem>
      </RevealGroup>
    )
    const visible = (groupProps[0].variants as { visible: { transition: Record<string, number> } })
      .visible
    const stagger = visible.transition.staggerChildren
    expect(stagger).toBeLessThan(0.06)
    expect(stagger * 8).toBeLessThanOrEqual(0.32)
  })

  it("leaves a small group's stagger alone", () => {
    render(
      <RevealGroup stagger={0.06} count={4}>
        <RevealItem>a</RevealItem>
      </RevealGroup>
    )
    const visible = (groupProps[0].variants as { visible: { transition: Record<string, number> } })
      .visible
    expect(visible.transition.staggerChildren).toBe(0.06)
  })

  it("animates once, so scrolling back does not replay it", () => {
    render(
      <RevealGroup>
        <RevealItem>a</RevealItem>
      </RevealGroup>
    )
    expect(groupProps[0].viewport).toMatchObject({ once: true })
  })

  it("moves items on opacity and transform only, per the spec's performance rule", () => {
    render(
      <RevealGroup>
        <RevealItem>a</RevealItem>
      </RevealGroup>
    )
    expect(itemProps[0].variants).toEqual({
      hidden: { opacity: 0, y: 10 },
      visible: { opacity: 1, y: 0 },
    })
  })

  it("marks animated items for the CSS reduced-motion safety net", () => {
    render(
      <RevealGroup>
        <RevealItem>cell</RevealItem>
      </RevealGroup>
    )
    expect(itemProps[0]["data-reveal-item"]).toBe("")
  })

  it("mounts no motion component at all under reduced motion", () => {
    reduced = true
    const { container } = render(
      <RevealGroup as="ul" className="grid">
        <RevealItem as="li">cell</RevealItem>
      </RevealGroup>
    )
    expect(container.querySelector("[data-motion]")).toBeNull()
    expect(screen.getByText("cell")).toBeInTheDocument()
    // Layout must not shift between the two modes.
    expect(container.querySelector("ul.grid")).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
  })

  it("keeps the layout class in the animated mode too", () => {
    const { container } = render(
      <RevealGroup className="grid gap-px">
        <RevealItem className="cell">a</RevealItem>
      </RevealGroup>
    )
    expect(container.querySelector(".grid.gap-px")).toBeInTheDocument()
    expect(container.querySelector(".cell")).toBeInTheDocument()
  })
})
