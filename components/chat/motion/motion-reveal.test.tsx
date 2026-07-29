/**
 * @jest-environment jsdom
 */

import { render, renderHook } from "@testing-library/react"

import {
  MotionCollapse,
  MotionPopover,
  MotionReveal,
  MotionSelectionIndicator,
  MotionStatusSwap,
  useFlowMotion,
} from "./motion-reveal"
import { useSettingsStore } from "@/stores/settings/settings-store"

describe("useFlowMotion", () => {
  it("reads reduce + speed from settings", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1.5 } } as never })
    const { result } = renderHook(() => useFlowMotion())
    expect(result.current).toEqual({ reduce: true, speed: 1.5 })
  })

  it("defaults to no-reduce + default speed when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useFlowMotion())
    expect(result.current.reduce).toBe(false)
    expect(result.current.speed).toBe(1)
  })
})

describe("MotionReveal", () => {
  it("renders a bare fragment (no wrapper) when reduced and no className", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container } = render(
      <MotionReveal>
        <span data-testid="child">hi</span>
      </MotionReveal>
    )
    // First child is the span itself, not a wrapping div.
    expect((container.firstChild as HTMLElement)?.tagName).toBe("SPAN")
  })

  it("wraps in a plain div when reduced but a className is given", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container } = render(
      <MotionReveal className="x">
        <span>hi</span>
      </MotionReveal>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.tagName).toBe("DIV")
    expect(wrapper.className).toBe("x")
  })

  it("renders an animated wrapper when motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { getByTestId, container } = render(
      <MotionReveal index={2}>
        <span data-testid="child">hi</span>
      </MotionReveal>
    )
    expect(getByTestId("child")).toBeTruthy()
    // motion.div produces a wrapping div element.
    expect((container.firstChild as HTMLElement)?.tagName).toBe("DIV")
  })

  it("renders children unwrapped when disabled and no className", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { container } = render(
      <MotionReveal disabled>
        <span data-testid="child">hi</span>
      </MotionReveal>
    )
    expect((container.firstChild as HTMLElement)?.tagName).toBe("SPAN")
  })
})

describe("MotionCollapse", () => {
  it("renders children in a plain div when open and reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { getByTestId } = render(
      <MotionCollapse open>
        <span data-testid="body">x</span>
      </MotionCollapse>
    )
    expect(getByTestId("body")).toBeTruthy()
  })

  it("renders nothing when closed and reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { queryByTestId } = render(
      <MotionCollapse open={false}>
        <span data-testid="body">x</span>
      </MotionCollapse>
    )
    expect(queryByTestId("body")).toBeNull()
  })

  it("renders the body when open and motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { getByTestId } = render(
      <MotionCollapse open>
        <span data-testid="body">x</span>
      </MotionCollapse>
    )
    expect(getByTestId("body")).toBeTruthy()
  })
})

describe("MotionStatusSwap", () => {
  it("wraps children in a plain span when reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container, getByTestId } = render(
      <MotionStatusSwap swapKey="a">
        <i data-testid="glyph" />
      </MotionStatusSwap>
    )
    expect((container.firstChild as HTMLElement)?.tagName).toBe("SPAN")
    expect(getByTestId("glyph")).toBeTruthy()
  })

  it("renders the glyph when motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { getByTestId } = render(
      <MotionStatusSwap swapKey="b">
        <i data-testid="glyph" />
      </MotionStatusSwap>
    )
    expect(getByTestId("glyph")).toBeTruthy()
  })
})

describe("MotionPopover", () => {
  it("renders a plain positioned div when open and reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container, getByTestId } = render(
      <MotionPopover open className="pop" style={{ left: 4, top: 8 }}>
        <span data-testid="body">x</span>
      </MotionPopover>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.tagName).toBe("DIV")
    expect(wrapper.className).toBe("pop")
    expect(wrapper.style.left).toBe("4px")
    expect(getByTestId("body")).toBeTruthy()
  })

  it("renders nothing when closed and reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { queryByTestId } = render(
      <MotionPopover open={false}>
        <span data-testid="body">x</span>
      </MotionPopover>
    )
    expect(queryByTestId("body")).toBeNull()
  })

  it("renders nothing when closed and motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { queryByTestId } = render(
      <MotionPopover open={false}>
        <span data-testid="body">x</span>
      </MotionPopover>
    )
    expect(queryByTestId("body")).toBeNull()
  })

  it("renders the body in an animated wrapper when open and motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { container, getByTestId } = render(
      <MotionPopover open from={{ opacity: 0, x: "100%" }}>
        <span data-testid="body">x</span>
      </MotionPopover>
    )
    expect((container.firstChild as HTMLElement)?.tagName).toBe("DIV")
    expect(getByTestId("body")).toBeTruthy()
  })
})

describe("MotionSelectionIndicator", () => {
  const setReduce = (reduce: boolean) =>
    useSettingsStore.setState({ settings: { motion: { reduce, speed: 1 } } as never })

  it("renders nothing for an unselected item", () => {
    setReduce(false)
    const { container } = render(
      <MotionSelectionIndicator groupId="g" active={false} className="tint" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a decorative layer for the selected item", () => {
    setReduce(false)
    const { container } = render(<MotionSelectionIndicator groupId="g" active className="tint" />)
    const span = container.querySelector("span")
    expect(span).toHaveClass("tint")
    // Purely visual — it must never reach the accessibility tree, or every
    // selected rail button would gain a phantom child.
    expect(span).toHaveAttribute("aria-hidden", "true")
  })

  it("drops the shared-layout mechanism entirely under reduced motion", () => {
    // `layoutId` IS the animation here, so reduced motion has to render a plain
    // span. A motion element left mounted would still project between items.
    setReduce(true)
    const { container } = render(<MotionSelectionIndicator groupId="g" active className="tint" />)
    const span = container.querySelector("span")!
    expect(span).toHaveClass("tint")
    expect(span.getAttribute("style")).toBeNull()
  })
})
