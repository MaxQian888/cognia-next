import { render } from "@testing-library/react"
import { IDLE_SIZE } from "@web/lib/magnetism"
import { MAGNETIC_ATTR, PointerCompanion } from "./pointer-companion"

const originalMatchMedia = window.matchMedia

function stub({ fine, reduced }: { fine: boolean; reduced: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : fine,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

/**
 * `Event.target` is read-only, so the event is dispatched *on the element* and
 * allowed to bubble to the window listener — which is also how it behaves in a
 * real browser.
 */
function movePointer(x: number, y: number, on: Element = document.body) {
  const event = new Event("pointermove", { bubbles: true })
  Object.assign(event, { clientX: x, clientY: y })
  on.dispatchEvent(event)
}

afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe("PointerCompanion", () => {
  it("renders on a fine pointer with motion allowed", () => {
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    expect(getByTestId("pointer-companion")).toBeInTheDocument()
  })

  it("renders nothing on a coarse pointer", () => {
    // A touch screen has no pointer to follow, and the ring would sit under the
    // user's own thumb.
    stub({ fine: false, reduced: false })
    const { queryByTestId } = render(<PointerCompanion />)
    expect(queryByTestId("pointer-companion")).toBeNull()
  })

  it("renders nothing under prefers-reduced-motion", () => {
    // Continuous rAF motion: the globals.css belt collapses animation-duration,
    // which does nothing to a rAF loop, so this has to opt out itself.
    stub({ fine: true, reduced: true })
    const { queryByTestId } = render(<PointerCompanion />)
    expect(queryByTestId("pointer-companion")).toBeNull()
  })

  it("never hides the native cursor", () => {
    // The whole design constraint: OS pointer enlargement, high-contrast
    // pointers and user-chosen cursors are assistive settings. `cursor: none`
    // would silently disable all three.
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")
    expect(ring.className).not.toMatch(/cursor-none/)
    expect(document.body.style.cursor).not.toBe("none")
    expect(document.documentElement.style.cursor).not.toBe("none")
  })

  it("sights the target with corner brackets rather than tracing an outline", () => {
    // A closed 1px rectangle around every control reads as a selection box, and
    // at hairline weight just looks like a stray border. Corners read as a
    // viewfinder — the same vocabulary as the brand mark's registration ticks.
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")
    expect(ring.className).not.toMatch(/\bborder\b/)
    const corners = ring.querySelectorAll("span")
    expect(corners).toHaveLength(4)
    // Each bracket draws exactly two sides, so the four never close into a box.
    for (const corner of corners) {
      const sides = ["border-l", "border-r", "border-t", "border-b"].filter((side) =>
        corner.className.split(/\s+/).includes(side)
      )
      expect(sides).toHaveLength(2)
    }
  })

  it("can never intercept a click", () => {
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    expect(getByTestId("pointer-companion")).toHaveClass("pointer-events-none")
  })

  it("is hidden from assistive technology", () => {
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    expect(getByTestId("pointer-companion")).toHaveAttribute("aria-hidden", "true")
  })

  it("starts invisible until the pointer is seen", () => {
    // Otherwise the ring flashes in the top-left corner on every load.
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    expect(getByTestId("pointer-companion")).toHaveClass("opacity-0")
  })

  it("follows the pointer without re-rendering React", () => {
    stub({ fine: true, reduced: false })
    const raf = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(1)
    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")

    movePointer(120, 80)
    // A state update per frame would re-render the subtree sixty times a
    // second; the loop writes straight to the node instead.
    expect(raf).toHaveBeenCalled()
    expect(ring.style.opacity).toBe("1")
    raf.mockRestore()
  })

  it("hides again when the pointer leaves the document", () => {
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")
    movePointer(10, 10)
    expect(ring.style.opacity).toBe("1")
    document.dispatchEvent(new Event("pointerleave"))
    expect(ring.style.opacity).toBe("0")
  })

  it("hides when the window loses focus", () => {
    stub({ fine: true, reduced: false })
    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")
    movePointer(10, 10)
    window.dispatchEvent(new Event("blur"))
    expect(ring.style.opacity).toBe("0")
  })

  it("removes every listener on unmount", () => {
    stub({ fine: true, reduced: false })
    const remove = jest.spyOn(window, "removeEventListener")
    const { unmount } = render(<PointerCompanion />)
    unmount()
    const events = remove.mock.calls.map(([type]) => type)
    expect(events).toContain("pointermove")
    expect(events).toContain("blur")
    remove.mockRestore()
  })

  it("exports the attribute that marks a latchable control", () => {
    expect(MAGNETIC_ATTR).toBe("data-magnetic")
  })

  it("writes the latched geometry straight to the node", () => {
    // jsdom never runs a rAF callback on its own, so the draw loop is stepped
    // by hand here. Without this the whole loop — the part that actually moves
    // anything — is untested.
    stub({ fine: true, reduced: false })
    const frames: FrameRequestCallback[] = []
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const control = document.createElement("button")
    control.setAttribute("data-magnetic", "")
    control.getBoundingClientRect = () =>
      ({ left: 100, top: 200, width: 180, height: 48 }) as DOMRect
    document.body.appendChild(control)

    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")

    movePointer(190, 224, control)
    // Several frames so the easing converges rather than landing mid-flight.
    for (let i = 0; i < 120; i += 1) frames.splice(0).forEach((frame) => frame(0))

    expect(ring.style.transform).toMatch(/^translate3d\(/)
    expect(Number.parseFloat(ring.style.width)).toBeCloseTo(190, 0)
    expect(Number.parseFloat(ring.style.height)).toBeCloseTo(58, 0)

    control.remove()
    jest.restoreAllMocks()
  })

  it("returns to its idle size once nothing is under the pointer", () => {
    stub({ fine: true, reduced: false })
    const frames: FrameRequestCallback[] = []
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const { getByTestId } = render(<PointerCompanion />)
    const ring = getByTestId("pointer-companion")

    movePointer(400, 400)
    for (let i = 0; i < 120; i += 1) frames.splice(0).forEach((frame) => frame(0))

    expect(Number.parseFloat(ring.style.width)).toBeCloseTo(IDLE_SIZE, 0)
    jest.restoreAllMocks()
  })

  it("stops scheduling frames once it has caught up", () => {
    // A permanent rAF loop on an idle page is a battery cost with nothing to
    // show for it.
    stub({ fine: true, reduced: false })
    const frames: FrameRequestCallback[] = []
    const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    render(<PointerCompanion />)
    movePointer(400, 400)
    for (let i = 0; i < 200; i += 1) frames.splice(0).forEach((frame) => frame(0))

    const settledAt = raf.mock.calls.length
    frames.splice(0).forEach((frame) => frame(0))
    expect(raf.mock.calls.length).toBe(settledAt)
    jest.restoreAllMocks()
  })

  it("no-ops where matchMedia does not exist", () => {
    // @ts-expect-error deliberately removing the API
    window.matchMedia = undefined
    const { queryByTestId } = render(<PointerCompanion />)
    expect(queryByTestId("pointer-companion")).toBeNull()
  })

  it("survives a pointer event whose target cannot be walked", () => {
    // An event dispatched on `window` has no element target, so the magnet
    // lookup has nothing to call `closest` on. It must degrade to "no magnet"
    // rather than throwing inside a passive listener.
    stub({ fine: true, reduced: false })
    jest.spyOn(window, "requestAnimationFrame").mockReturnValue(1)
    const { getByTestId } = render(<PointerCompanion />)

    const event = new Event("pointermove")
    Object.assign(event, { clientX: 5, clientY: 5 })
    expect(() => window.dispatchEvent(event)).not.toThrow()
    expect(getByTestId("pointer-companion").style.opacity).toBe("1")
    jest.restoreAllMocks()
  })
})
