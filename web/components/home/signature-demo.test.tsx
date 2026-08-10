import { fireEvent, render, screen } from "@testing-library/react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { SignatureDemo } from "./signature-demo"

let reduced = false
jest.mock("motion/react", () => ({ useReducedMotion: () => reduced }))

describe("SignatureDemo", () => {
  beforeEach(() => {
    reduced = false
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it("states the single task the whole page follows", () => {
    const { container } = render(
      <SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />
    )
    expect(screen.getByText(en.home.signature.task)).toBeInTheDocument()
    expect(container.querySelector("#task")).toHaveClass("bg-surface", "text-ink")
    expect(container.querySelector("#task")).not.toHaveClass("bg-stage")
  })

  it("lists all six rail states", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    const stepper = screen.getByRole("list", { name: en.home.signature.stepperLabel })
    expect(stepper.querySelectorAll("li")).toHaveLength(6)
  })

  it("opens on the first step", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(
      screen.getByRole("heading", { name: en.home.signature.steps[0].headline })
    ).toBeInTheDocument()
  })

  it("marks the active rail entry for assistive technology", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    const current = screen.getByRole("button", {
      name: new RegExp(en.home.signature.steps[0].rail),
    })
    expect(current).toHaveAttribute("aria-current", "step")
  })

  it("advances and rewinds from the controls", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(screen.getByRole("button", { name: en.home.signature.nextLabel }))
    expect(
      screen.getByRole("heading", { name: en.home.signature.steps[1].headline })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: en.home.signature.previousLabel }))
    expect(
      screen.getByRole("heading", { name: en.home.signature.steps[0].headline })
    ).toBeInTheDocument()
  })

  it("jumps straight to a step from the rail", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[4].rail) })
    )
    expect(
      screen.getByRole("heading", { name: en.home.signature.steps[4].headline })
    ).toBeInTheDocument()
  })

  it("disables Previous at the start and Next at the end", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.getByRole("button", { name: en.home.signature.previousLabel })).toBeDisabled()
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[5].rail) })
    )
    expect(screen.getByRole("button", { name: en.home.signature.nextLabel })).toBeDisabled()
  })

  it("announces position politely rather than silently", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.getByText("Step 1 of 6")).toHaveAttribute("aria-live", "polite")
  })

  it("offers a pause control while playing", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.getByRole("button", { name: en.home.signature.pauseLabel })).toBeInTheDocument()
  })

  it("states every step with words, not only a colour", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[3].rail) })
    )
    expect(screen.getByText(en.home.signature.steps[3].status)).toBeInTheDocument()
  })

  it("shows the repository context as a read list, not as a sentence about one", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.getByText(DEMO_TASK.repository)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.files[0].path)).toBeInTheDocument()
  })

  it("shows the change as a real diff on the Action step", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[2].rail) })
    )
    for (const line of DEMO_TASK.diff.lines) {
      expect(screen.getByText(line.text.trim())).toBeInTheDocument()
    }
  })

  it("shows the permission checkpoint's action, target and scope on the Approval step", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[3].rail) })
    )
    expect(screen.getByText(DEMO_TASK.approval.command)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.approval.target)).toBeInTheDocument()
    for (const line of en.reconstruction.artifacts.approval.scope) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
  })

  it("shows the check output on the Test step", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[4].rail) })
    )
    expect(screen.getByText(DEMO_TASK.test.command)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.test.lines[2].name)).toBeInTheDocument()
  })

  it("shows the artifact as a file on the Artifact step", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[5].rail) })
    )
    expect(screen.getAllByText(DEMO_TASK.artifact.file).length).toBeGreaterThan(0)
  })

  it("offers no dead control inside the depicted checkpoint", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en.home.signature.steps[3].rail) })
    )
    // Only the rail's own controls are buttons; Approve and Deny are depictions.
    expect(
      screen.queryByRole("button", { name: en.reconstruction.artifacts.approval.approveLabel })
    ).toBeNull()
  })
})

describe("SignatureDemo when scroll-pinned", () => {
  const originalMatchMedia = window.matchMedia
  const scrollTo = jest.fn()

  beforeEach(() => {
    reduced = false
    scrollTo.mockClear()
    Object.defineProperty(window, "scrollTo", { value: scrollTo, writable: true })
    // The hook pins only above `lg`; the shared jsdom stub reports no match.
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it("keeps the pinned journey compact enough that each step does not strand a viewport", () => {
    const { container } = render(
      <SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />
    )
    const wrapper = container.querySelector<HTMLElement>("[style*='dvh']")
    expect(wrapper).toBeInTheDocument()
    // 100dvh first step + 45dvh × (steps-1) subsequent steps
    const steps = en.home.signature.steps.length
    const expectedDvh = 100 + (steps - 1) * 45 // 325 for 6 steps
    expect(wrapper?.style.height).toBe(`calc(${expectedDvh}dvh)`)
  })

  it("centres intrinsic content inside a full-height pinned viewport", () => {
    const { container } = render(
      <SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />
    )
    const viewport = container.querySelector("#task [data-pinned-viewport]")
    const stage = container.querySelector("#task [data-pinned-stage]")
    expect(viewport).toHaveClass(
      "sticky",
      "top-16",
      "flex",
      "h-[calc(100dvh-4rem)]",
      "items-center"
    )
    expect(stage).toHaveClass("w-full")
    expect(stage).not.toHaveClass("h-[min(46rem,calc(100dvh-5rem))]")
    expect(stage).not.toHaveClass("h-[calc(100dvh-5rem)]")
    expect(container.querySelector("#task .bg-graphite")).not.toHaveClass("h-full")
    expect(container.querySelector("#task .signature-stage")).toBeInTheDocument()
  })

  it("keeps the task summary with the controls instead of pinning it to the viewport floor", () => {
    const { container } = render(
      <SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />
    )
    const summary = container.querySelector("#task [data-pinned-task-summary]")
    expect(summary).toHaveClass("mt-8")
    expect(summary).not.toHaveClass("mt-auto")
  })

  it("does not mount cursor overlays inside the interactive artifact", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.queryByRole("region", { name: en.home.lensLabel })).toBeNull()
  })

  it("does not re-enable cursor overlays in the compact tall-screen layout", () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia

    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.queryByRole("region", { name: en.home.lensLabel })).toBeNull()
  })

  it("drops autoplay, because the reader is already driving", () => {
    // A play button that fights the scroll position is a control that visibly
    // does nothing.
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.queryByRole("button", { name: en.home.signature.playLabel })).toBeNull()
    expect(screen.queryByRole("button", { name: en.home.signature.pauseLabel })).toBeNull()
  })

  it("scrolls instead of setting state when a rail entry is chosen", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(screen.getByRole("button", { name: /Approval/i }))
    // Scroll position stays the single source of truth: setting the index
    // directly would desynchronise the rail from the page on the next scroll.
    expect(scrollTo).toHaveBeenCalled()
  })

  it("keeps Previous and Next, wired to scroll", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    fireEvent.click(screen.getByRole("button", { name: en.home.signature.nextLabel }))
    expect(scrollTo).toHaveBeenCalled()
  })

  it("still disables Previous on the first step", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.getByRole("button", { name: en.home.signature.previousLabel })).toBeDisabled()
  })

  it("keeps every step reachable by keyboard", () => {
    // The pin must not cost keyboard operability (spec §8) — the rail entries
    // are still buttons, not scroll-only affordances.
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    const rail = screen.getByRole("list", { name: en.home.signature.stepperLabel })
    const buttons = rail.querySelectorAll("button")
    expect(buttons).toHaveLength(en.home.signature.steps.length)
    for (const button of buttons) expect(button).not.toBeDisabled()
  })
})

describe("SignatureDemo under reduced motion", () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    reduced = true
    // Even on a wide viewport, reduced motion must win: spec §6.3 forbids pin,
    // scrub and autoplay outright.
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it("renders no scroll travel at all", () => {
    const { container } = render(
      <SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />
    )
    expect(container.querySelector("[style*='vh']")).toBeNull()
  })

  it("renders every state at once as a static stepper", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    for (const step of en.home.signature.steps) {
      expect(screen.getByRole("heading", { name: step.headline })).toBeInTheDocument()
    }
  })

  it("drops the playback controls, which have nothing to control", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.queryByRole("button", { name: en.home.signature.playLabel })).toBeNull()
    expect(screen.queryByRole("button", { name: en.home.signature.pauseLabel })).toBeNull()
  })

  it("keeps the task and the content order unchanged", () => {
    render(<SignatureDemo copy={en.home.signature} reconstruction={en.reconstruction} />)
    expect(screen.getByText(en.home.signature.task)).toBeInTheDocument()
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(en.home.signature.steps.map((s) => s.headline))
  })

  it("integrates the file tree and animated activity as complete static fallbacks", () => {
    render(
      <SignatureDemo
        copy={en.home.signature}
        reconstruction={en.reconstruction}
        fileTreeLabel={en.home.fileTreeLabel}
      />
    )

    expect(screen.getByRole("region", { name: en.home.fileTreeLabel })).toBeInTheDocument()
    expect(
      screen.getByRole("list", { name: en.reconstruction.artifacts.test.heading })
    ).toBeInTheDocument()
  })
})

describe("SignatureDemo localisation", () => {
  it("renders the Chinese task and states", () => {
    reduced = true
    render(<SignatureDemo copy={zh.home.signature} reconstruction={zh.reconstruction} />)
    expect(screen.getByText(zh.home.signature.task)).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: zh.home.signature.steps[0].headline })
    ).toBeInTheDocument()
  })
})
