import { act, render, screen } from "@testing-library/react"
import { pickActive, useSectionProgress } from "./use-section-progress"

const ORDER = ["hero", "task", "workbench", "trust"] as const

describe("pickActive", () => {
  it("picks the only intersecting section", () => {
    const observations = [
      { id: "hero", isIntersecting: false, ratio: 0 },
      { id: "task", isIntersecting: true, ratio: 0.5 },
    ]
    expect(pickActive(observations, ORDER, "hero")).toBe("task")
  })

  it("holds the previous choice when nothing is in the band", () => {
    // Between two sections the rail must not blank out — the reader has not
    // left the section they were reading, the band is just in a gap.
    expect(pickActive([{ id: "task", isIntersecting: false, ratio: 0 }], ORDER, "task")).toBe(
      "task"
    )
    expect(pickActive([], ORDER, "workbench")).toBe("workbench")
  })

  it("breaks a tie toward the earlier section in document order", () => {
    // Scrolling down puts two neighbours in the band at once. Preferring the
    // later one would move the marker ahead of the heading being read.
    const observations = [
      { id: "workbench", isIntersecting: true, ratio: 0.4 },
      { id: "task", isIntersecting: true, ratio: 0.6 },
    ]
    expect(pickActive(observations, ORDER, "hero")).toBe("task")
  })

  it("ignores an intersecting entry with a zero ratio", () => {
    const observations = [
      { id: "task", isIntersecting: true, ratio: 0 },
      { id: "workbench", isIntersecting: true, ratio: 0.2 },
    ]
    expect(pickActive(observations, ORDER, "hero")).toBe("workbench")
  })

  it("tolerates an id that is not in the order list", () => {
    const observations = [{ id: "stranger", isIntersecting: true, ratio: 0.9 }]
    expect(pickActive(observations, ORDER, "hero")).toBe("stranger")
  })
})

function Probe({
  createObserver,
}: {
  createObserver?: Parameters<typeof useSectionProgress>[0]["createObserver"]
}) {
  const active = useSectionProgress({ sections: ORDER, createObserver })
  return <span data-testid="active">{active}</span>
}

describe("useSectionProgress", () => {
  beforeEach(() => {
    document.body.innerHTML = ORDER.map((id) => `<section id="${id}"></section>`).join("")
  })

  it("starts on the first section", () => {
    render(<Probe />)
    expect(screen.getByTestId("active")).toHaveTextContent("hero")
  })

  it("follows the observer into a later section", () => {
    // The repo's jsdom IntersectionObserver stub never invokes its callback, so
    // the factory is injected and fired by hand.
    let fire: IntersectionObserverCallback | null = null
    const createObserver = (cb: IntersectionObserverCallback) => {
      fire = cb
      return { observe: () => {}, disconnect: () => {} } as unknown as IntersectionObserver
    }

    render(<Probe createObserver={createObserver} />)
    expect(screen.getByTestId("active")).toHaveTextContent("hero")

    act(() => {
      fire?.(
        [
          { target: { id: "workbench" }, isIntersecting: true, intersectionRatio: 0.7 },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver
      )
    })
    expect(screen.getByTestId("active")).toHaveTextContent("workbench")
  })

  it("observes the middle band rather than the viewport edges", () => {
    let options: IntersectionObserverInit | undefined
    const createObserver = (_cb: IntersectionObserverCallback, opts: IntersectionObserverInit) => {
      options = opts
      return { observe: () => {}, disconnect: () => {} } as unknown as IntersectionObserver
    }
    render(<Probe createObserver={createObserver} />)
    expect(options?.rootMargin).toBe("-45% 0px -45% 0px")
  })

  it("does nothing when none of the sections are on the page", () => {
    document.body.innerHTML = ""
    const createObserver = jest.fn()
    render(<Probe createObserver={createObserver as never} />)
    expect(createObserver).not.toHaveBeenCalled()
    expect(screen.getByTestId("active")).toHaveTextContent("hero")
  })
})
