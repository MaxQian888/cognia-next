/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import { PatternGrid } from "./pattern-grid"
import { MAX_PATTERN_LENGTH, MIN_PATTERN_LENGTH } from "@/lib/accounts/quick-unlock/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

function tap(...indices: number[]): void {
  for (const index of indices) {
    fireEvent.click(screen.getByTestId(`pattern-node-${index}`))
  }
}

/** Node centres in the 0..100 viewBox, matching the component's layout. */
const CENTRES = [
  [20, 20],
  [50, 20],
  [80, 20],
  [20, 50],
  [50, 50],
  [80, 50],
  [20, 80],
  [50, 80],
  [80, 80],
]

/** Give the surface a real box so the pointer maths resolves in jsdom. */
function stubSurfaceBox(): HTMLElement {
  const surface = screen.getByTestId("pattern-surface")
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect
  ;(surface as HTMLElement & { setPointerCapture: (id: number) => void }).setPointerCapture =
    () => {}
  return surface
}

function drawThrough(surface: HTMLElement, indices: number[]): void {
  const [firstX, firstY] = CENTRES[indices[0]]
  fireEvent.pointerDown(surface, { clientX: firstX, clientY: firstY, pointerId: 1 })
  for (const index of indices.slice(1)) {
    const [x, y] = CENTRES[index]
    fireEvent.pointerMove(surface, { clientX: x, clientY: y, pointerId: 1 })
  }
  fireEvent.pointerUp(surface, { pointerId: 1 })
}

describe("PatternGrid", () => {
  it("commits a pattern of at least the minimum length", () => {
    const onSubmit = jest.fn()
    render(<PatternGrid onSubmit={onSubmit} />)
    tap(0, 3, 4, 5, 8)
    fireEvent.click(screen.getByTestId("pattern-submit"))
    expect(onSubmit).toHaveBeenCalledWith([0, 3, 4, 5, 8])
  })

  it("refuses to submit below the minimum", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    tap(0, 3, 4)
    expect(screen.getByTestId("pattern-submit")).toBeDisabled()
  })

  it("is fully drawable with the keyboard", () => {
    // A pattern lock that can only be dragged locks out anyone who cannot
    // drag, which is not an acceptable way to gate someone's own account.
    const onSubmit = jest.fn()
    render(<PatternGrid onSubmit={onSubmit} />)
    for (let i = 0; i < MIN_PATTERN_LENGTH; i += 1) {
      screen.getByTestId(`pattern-node-${i}`).focus()
      fireEvent.click(document.activeElement as HTMLElement)
    }
    fireEvent.click(screen.getByTestId("pattern-submit"))
    expect(onSubmit).toHaveBeenCalledWith([0, 1, 2, 3, 4])
  })

  it("records the order a node was touched in", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    tap(4, 0, 8)
    expect(screen.getByTestId("pattern-node-4")).toHaveTextContent("1")
    expect(screen.getByTestId("pattern-node-0")).toHaveTextContent("2")
    expect(screen.getByTestId("pattern-node-8")).toHaveTextContent("3")
  })

  it("skips a node already in the stroke instead of restarting", () => {
    // Crossing back over a node is a normal thing a finger does.
    const onSubmit = jest.fn()
    render(<PatternGrid onSubmit={onSubmit} />)
    tap(0, 3, 4, 3, 5, 8)
    fireEvent.click(screen.getByTestId("pattern-submit"))
    expect(onSubmit).toHaveBeenCalledWith([0, 3, 4, 5, 8])
  })

  it("stops at the grid size", () => {
    const onSubmit = jest.fn()
    render(<PatternGrid onSubmit={jest.fn()} />)
    render(<PatternGrid onSubmit={onSubmit} testIdPrefix="p2" />)
    for (let i = 0; i < 9; i += 1) {
      fireEvent.click(screen.getByTestId(`p2-node-${i}`))
    }
    fireEvent.click(screen.getByTestId("p2-submit"))
    expect(onSubmit.mock.calls[0][0]).toHaveLength(MAX_PATTERN_LENGTH)
  })

  it("marks selected nodes for assistive technology", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    tap(0)
    expect(screen.getByTestId("pattern-node-0")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("pattern-node-1")).toHaveAttribute("aria-pressed", "false")
  })

  it("draws a connecting segment between consecutive nodes", () => {
    const { container } = render(<PatternGrid onSubmit={jest.fn()} />)
    tap(0, 4, 8)
    expect(container.querySelectorAll("line")).toHaveLength(2)
  })

  it("clears the stroke", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    tap(0, 3, 4)
    fireEvent.click(screen.getByTestId("pattern-clear"))
    expect(screen.getByTestId("pattern-node-0")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("pattern-clear")).toBeDisabled()
  })

  it("collects nodes from a pointer drag", () => {
    const onSubmit = jest.fn()
    render(<PatternGrid onSubmit={onSubmit} />)
    drawThrough(stubSurfaceBox(), [0, 4, 8, 5, 2])
    fireEvent.click(screen.getByTestId("pattern-submit"))
    expect(onSubmit).toHaveBeenCalledWith([0, 4, 8, 5, 2])
  })

  it("starts a fresh stroke on a new press", () => {
    const onSubmit = jest.fn()
    render(<PatternGrid onSubmit={onSubmit} />)
    const surface = stubSurfaceBox()
    drawThrough(surface, [0, 1, 2])
    drawThrough(surface, [6, 7, 8, 5, 2])
    fireEvent.click(screen.getByTestId("pattern-submit"))
    expect(onSubmit).toHaveBeenCalledWith([6, 7, 8, 5, 2])
  })

  it("ignores pointer movement that is not on a node", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    const surface = stubSurfaceBox()
    fireEvent.pointerDown(surface, { clientX: 35, clientY: 35, pointerId: 1 })
    expect(screen.getByTestId("pattern-node-0")).toHaveAttribute("aria-pressed", "false")
  })

  it("ignores movement when no stroke is in progress", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    const surface = stubSurfaceBox()
    fireEvent.pointerMove(surface, { clientX: 20, clientY: 20, pointerId: 1 })
    expect(screen.getByTestId("pattern-node-0")).toHaveAttribute("aria-pressed", "false")
  })

  it("blocks input while disabled", () => {
    render(<PatternGrid onSubmit={jest.fn()} disabled />)
    tap(0, 3, 4, 5, 8)
    expect(screen.getByTestId("pattern-node-0")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("pattern-submit")).toBeDisabled()
  })

  it("announces an error and prefers it over the progress line", () => {
    render(<PatternGrid onSubmit={jest.fn()} error="wrong pattern" />)
    expect(screen.getByRole("alert")).toHaveTextContent("wrong pattern")
    expect(screen.queryByText(/progress/)).not.toBeInTheDocument()
  })

  it("clears the stroke after a submit", () => {
    render(<PatternGrid onSubmit={jest.fn()} />)
    tap(0, 3, 4, 5, 8)
    fireEvent.click(screen.getByTestId("pattern-submit"))
    expect(screen.getByTestId("pattern-node-0")).toHaveAttribute("aria-pressed", "false")
  })
})
