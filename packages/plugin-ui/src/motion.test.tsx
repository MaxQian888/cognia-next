import { act, render, renderHook, screen } from "@testing-library/react"

import { Collapse, Fade, SlideUp, Stagger, motionTokens, useMotionPrefs } from "./motion"
import { MOBILE_DURATION, MOBILE_EASE, STAGGER_CHILD, STAGGER_CONTAINER } from "./motion-tokens"

/**
 * The repo-wide `motion/react` stub folds `animate` into inline style and drops
 * everything else, which cannot answer the questions that matter here: *which*
 * targets and *which* transition the facade computed, and whether it reached
 * for a motion component at all. So this suite substitutes a recording stub —
 * the props are the contract between the facade and the library.
 */
interface MotionRender {
  tag: string
  props: Record<string, unknown>
}

const mockMotionRenders: MotionRender[] = []

jest.mock("motion/react", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  // Props the real library consumes itself; everything else is a DOM attribute.
  const animationProps = new Set(["initial", "animate", "exit", "variants", "transition"])
  const cache = new Map<string, unknown>()
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    motion: new Proxy(
      {},
      {
        get(_target, prop) {
          const tag = String(prop)
          let component = cache.get(tag)
          if (!component) {
            component = (props: Record<string, unknown>) => {
              mockMotionRenders.push({ tag, props })
              const domProps: Record<string, unknown> = {}
              for (const [key, value] of Object.entries(props)) {
                if (!animationProps.has(key)) domProps[key] = value
              }
              return react.createElement(tag, domProps)
            }
            cache.set(tag, component)
          }
          return component
        },
      }
    ),
  }
})

const root = () => document.documentElement
const originalMatchMedia = window.matchMedia

afterEach(() => {
  mockMotionRenders.length = 0
  root().className = ""
  root().removeAttribute("style")
  window.matchMedia = originalMatchMedia
})

function setDurationScale(value: string) {
  root().style.setProperty("--motion-duration-scale", value)
}

function reduceViaSettings() {
  root().classList.add("reduce-motion")
}

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

function renderOf(slot: string): MotionRender | undefined {
  return mockMotionRenders.find((entry) => entry.props["data-slot"] === slot)
}

describe("motionTokens", () => {
  it("re-exports the host's values rather than a copy of them", () => {
    // Identity, not equality: a copied literal is exactly how a plugin's
    // animation would silently drift from the host's after a token edit.
    expect(motionTokens.ease).toBe(MOBILE_EASE)
    expect(motionTokens.duration).toBe(MOBILE_DURATION)
    expect(motionTokens.stagger.interval).toBe(
      (STAGGER_CONTAINER.animate as { transition: { staggerChildren: number } }).transition
        .staggerChildren
    )
  })
})

describe("useMotionPrefs", () => {
  it("defaults to full-speed animation when the host has published nothing", () => {
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current).toEqual({ durationScale: 1, reduced: false })
  })

  it("reads the duration scale the host applied to <html>", () => {
    setDurationScale("1.5")
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current.durationScale).toBe(1.5)
  })

  it("falls back to 1 for an unparseable scale", () => {
    setDurationScale("brisk")
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current.durationScale).toBe(1)
  })

  it("reports reduced when the in-app toggle set the class", () => {
    reduceViaSettings()
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current.reduced).toBe(true)
  })

  it("reports reduced from the OS hint alone", () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current.reduced).toBe(true)
  })

  it("assumes the defaults where there is no styled document to read", () => {
    // Server rendering and the pre-hydration pass have no computed style; the
    // hook has to answer rather than throw inside a plugin's first render.
    const original = window.getComputedStyle
    // @ts-expect-error — simulate an environment without the API.
    delete window.getComputedStyle
    try {
      const { result } = renderHook(() => useMotionPrefs())
      expect(result.current).toEqual({ durationScale: 1, reduced: false })
    } finally {
      window.getComputedStyle = original
    }
  })

  it("keeps animating when matchMedia is only partially implemented", () => {
    window.matchMedia = (() => {
      throw new Error("not implemented")
    }) as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current.reduced).toBe(false)
  })

  it("returns a stable snapshot across re-renders", () => {
    const { result, rerender } = renderHook(() => useMotionPrefs())
    const first = result.current
    rerender()
    // A fresh object per read would loop useSyncExternalStore forever.
    expect(result.current).toBe(first)
  })

  it("follows the preference changing after mount", async () => {
    const { result } = renderHook(() => useMotionPrefs())
    expect(result.current.reduced).toBe(false)
    await act(async () => {
      reduceViaSettings()
    })
    expect(result.current.reduced).toBe(true)
  })
})

describe("animated surfaces", () => {
  it("Fade renders its children and nothing of its own", () => {
    const { container } = render(
      <Fade>
        <button type="button">Run</button>
      </Fade>
    )
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument()
    // Every label a plugin sees has to come from the plugin.
    expect(container.textContent).toBe("Run")
  })

  it("Fade animates opacity on the token curve", () => {
    render(
      <Fade>
        <button type="button">Run</button>
      </Fade>
    )
    const fade = renderOf("fade")
    expect(fade?.tag).toBe("div")
    expect(fade?.props.initial).toEqual({ opacity: 0 })
    expect(fade?.props.animate).toEqual({ opacity: 1 })
    expect(fade?.props.exit).toEqual({ opacity: 0 })
    expect(fade?.props.transition).toEqual({
      duration: MOBILE_DURATION.normal,
      ease: MOBILE_EASE,
    })
  })

  it("Fade drops its content when show is false", () => {
    render(
      <Fade show={false}>
        <button type="button">Run</button>
      </Fade>
    )
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument()
  })

  it("honours the duration key", () => {
    render(<Fade duration="slow">body</Fade>)
    expect(renderOf("fade")?.props.transition).toMatchObject({ duration: MOBILE_DURATION.slow })
  })

  it("scales every duration by the user's speed setting", () => {
    setDurationScale("2")
    render(<Fade>body</Fade>)
    const transition = renderOf("fade")?.props.transition as { duration: number }
    expect(transition.duration).toBeCloseTo(MOBILE_DURATION.normal * 2, 5)
  })

  it("SlideUp rises the same 8px a staggered row does", () => {
    render(<SlideUp>body</SlideUp>)
    expect(renderOf("slide-up")?.props.variants).toBe(STAGGER_CHILD)
  })

  it("SlideUp drops its content when show is false", () => {
    render(
      <SlideUp show={false}>
        <button type="button">Row</button>
      </SlideUp>
    )
    expect(screen.queryByRole("button", { name: "Row" })).not.toBeInTheDocument()
  })

  it("Stagger paces its children off the shared container variants", () => {
    render(
      <Stagger>
        <button type="button">One</button>
        <button type="button">Two</button>
      </Stagger>
    )
    expect(renderOf("stagger")?.props.variants).toBe(STAGGER_CONTAINER)
    const items = mockMotionRenders.filter((entry) => entry.props["data-slot"] === "stagger-item")
    expect(items).toHaveLength(2)
    expect(items[0].props.variants).toBe(STAGGER_CHILD)
    expect(screen.getByRole("button", { name: "Two" })).toBeInTheDocument()
  })

  it("Collapse animates height under a clip", () => {
    render(<Collapse>body</Collapse>)
    const collapse = renderOf("collapse")
    expect(collapse?.props.initial).toEqual({ height: 0, opacity: 0 })
    expect(collapse?.props.animate).toEqual({ height: "auto", opacity: 1 })
    expect(collapse?.props.style).toMatchObject({ overflow: "hidden" })
  })

  it("Collapse keeps a caller's positioning styles alongside the clip", () => {
    render(<Collapse style={{ maxWidth: 240 }}>body</Collapse>)
    expect(renderOf("collapse")?.props.style).toEqual({ overflow: "hidden", maxWidth: 240 })
  })

  it("Collapse renders nothing while collapsed", () => {
    render(
      <Collapse show={false}>
        <button type="button">Body</button>
      </Collapse>
    )
    expect(screen.queryByRole("button", { name: "Body" })).not.toBeInTheDocument()
  })

  it("forwards accessibility props to the animated element", () => {
    render(
      <Fade role="region" aria-label="Results">
        body
      </Fade>
    )
    expect(screen.getByRole("region", { name: "Results" })).toHaveAttribute("data-slot", "fade")
  })
})

/**
 * Reduced motion is the whole reason the facade exists rather than a re-export
 * of `motion`: a plugin gets the behaviour without opting in. "No animation"
 * here means no motion component was constructed at all — not a zero-duration
 * one — while the rendered structure stays identical so layout doesn't shift
 * with an accessibility setting.
 */
describe("reduced motion", () => {
  beforeEach(reduceViaSettings)

  it("Fade renders a plain element", () => {
    render(
      <Fade>
        <button type="button">Run</button>
      </Fade>
    )
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument()
    expect(mockMotionRenders).toHaveLength(0)
  })

  it("Fade still respects show", () => {
    render(
      <Fade show={false}>
        <button type="button">Run</button>
      </Fade>
    )
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument()
  })

  it("SlideUp renders a plain element", () => {
    render(<SlideUp aria-label="Row" role="region" />)
    expect(screen.getByRole("region", { name: "Row" })).toHaveAttribute("data-slot", "slide-up")
    expect(mockMotionRenders).toHaveLength(0)
  })

  it("Stagger keeps one wrapper per child so layout is unchanged", () => {
    const { container } = render(
      <Stagger>
        <button type="button">One</button>
        <button type="button">Two</button>
      </Stagger>
    )
    expect(container.querySelectorAll("[data-slot='stagger-item']")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "One" })).toBeInTheDocument()
    expect(mockMotionRenders).toHaveLength(0)
  })

  it("Collapse shows or hides without animating", () => {
    const { rerender } = render(
      <Collapse show>
        <button type="button">Body</button>
      </Collapse>
    )
    expect(screen.getByRole("button", { name: "Body" })).toBeInTheDocument()
    rerender(
      <Collapse show={false}>
        <button type="button">Body</button>
      </Collapse>
    )
    expect(screen.queryByRole("button", { name: "Body" })).not.toBeInTheDocument()
    expect(mockMotionRenders).toHaveLength(0)
  })
})
