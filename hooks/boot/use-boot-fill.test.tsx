/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"
import { useRef, type CSSProperties } from "react"

import { __resetBootFillForTesting, initialBootFill, rememberBootFill } from "@/lib/boot/boot-fill"

import { useBootFill, type BootFillOptions } from "./use-boot-fill"

type Props = Omit<BootFillOptions, "property" | "snapMs">

function Fill(props: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { initialFill } = useBootFill(ref, { ...props, property: "--fill", snapMs: 400 })
  return <div ref={ref} data-testid="fill" style={{ "--fill": initialFill } as CSSProperties} />
}

function value(): number {
  return Number(
    document.querySelector<HTMLElement>('[data-testid="fill"]')!.style.getPropertyValue("--fill")
  )
}

function fillEl(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="fill"]')!
}

describe("useBootFill", () => {
  beforeEach(() => {
    __resetBootFillForTesting()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("creeps straight to the target when there is no boundary to tick", () => {
    render(<Fill sequence={1} boundary={0} target={0.2} />)
    expect(value()).toBeCloseTo(0.2)
    expect(fillEl()).toHaveAttribute("data-creep", "true")
  })

  it("snaps to the boundary on the short transition, then creeps", () => {
    rememberBootFill(1, 0.2)
    render(<Fill sequence={1} boundary={0.25} target={0.46} />)
    expect(value()).toBeCloseTo(0.25)
    expect(fillEl()).not.toHaveAttribute("data-creep")
    act(() => {
      jest.advanceTimersByTime(400)
    })
    expect(value()).toBeCloseTo(0.46)
    expect(fillEl()).toHaveAttribute("data-creep", "true")
  })

  it("places a hand-over at the remembered position with its transition suppressed", () => {
    rememberBootFill(1, 0.3)
    const transitions: string[] = []
    const original = CSSStyleDeclaration.prototype.setProperty
    const spy = jest
      .spyOn(CSSStyleDeclaration.prototype, "setProperty")
      .mockImplementation(function (this: CSSStyleDeclaration, name, next, priority) {
        if (name === "--fill") transitions.push(`${this.transition}|${String(next)}`)
        return original.call(this, name, next, priority)
      })
    try {
      render(<Fill sequence={1} boundary={0.25} target={0.46} />)
    } finally {
      spy.mockRestore()
    }
    // React's inline style, then the placement — made with transitions off.
    expect(transitions.slice(0, 2)).toEqual(["|0.3", "none|0.3"])
    // The transition is restored once the placement is committed.
    expect(fillEl().style.transition).toBe("")
  })

  it("remembers where the bar stood when the owner unmounts", () => {
    const view = render(<Fill sequence={1} boundary={0} target={0.2} />)
    view.unmount()
    expect(initialBootFill(1)).toBeCloseTo(0.2)
  })

  it("never moves backwards when the boundary falls behind the bar", () => {
    const view = render(<Fill sequence={1} boundary={0} target={0.6} />)
    view.rerender(<Fill sequence={1} boundary={0.25} target={0.4} />)
    act(() => {
      jest.advanceTimersByTime(400)
    })
    expect(value()).toBeCloseTo(0.6)
  })

  it("opens a new sequence at zero", () => {
    rememberBootFill(1, 0.95)
    const seen: number[] = []
    const original = CSSStyleDeclaration.prototype.setProperty
    const spy = jest
      .spyOn(CSSStyleDeclaration.prototype, "setProperty")
      .mockImplementation(function (this: CSSStyleDeclaration, name, next, priority) {
        if (name === "--fill") seen.push(Number(next))
        return original.call(this, name, next, priority)
      })
    try {
      render(<Fill sequence={2} boundary={0} target={0.85} />)
    } finally {
      spy.mockRestore()
    }
    // Inline style and placement both empty — the old sequence's 0.95 never shows.
    expect(seen.slice(0, 2)).toEqual([0, 0])
    expect(value()).toBeCloseTo(0.85)
  })

  it("cancels a pending creep when the step changes again", () => {
    rememberBootFill(1, 0.2)
    const view = render(<Fill sequence={1} boundary={0.25} target={0.46} />)
    view.rerender(<Fill sequence={1} boundary={0.5} target={0.71} />)
    act(() => {
      jest.advanceTimersByTime(400)
    })
    expect(value()).toBeCloseTo(0.71)
  })
})
