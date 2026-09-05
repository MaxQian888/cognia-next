/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import type { HTMLAttributes, ReactNode } from "react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"

let reduced: boolean | null = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => true,
  motion: {
    div: ({ children, className }: HTMLAttributes<HTMLDivElement>) => (
      <div className={className}>{children}</div>
    ),
    p: ({ children, className }: { children: ReactNode; className?: string }) => (
      <p className={className}>{children}</p>
    ),
  },
}))

import { HERO_PHASE_DELAYS, HeroWorkbench } from "./hero-workbench"

const workbench = en.reconstruction.workbench

function renderWorkbench() {
  return render(
    <HeroWorkbench
      copy={en.reconstruction}
      alt={en.home.hero.stageAlt}
      caption={en.home.hero.stageCaption}
    />
  )
}

describe("HeroWorkbench", () => {
  beforeEach(() => {
    reduced = false
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("exposes one description and hides the depicted chrome, like a screenshot would", () => {
    renderWorkbench()
    expect(screen.getByRole("img", { name: en.home.hero.stageAlt })).toBeInTheDocument()
    expect(screen.queryByRole("list")).toBeNull()
  })

  it("says it is a reconstruction, under the caption", () => {
    renderWorkbench()
    expect(screen.getByText(en.home.hero.stageCaption)).toBeInTheDocument()
    expect(screen.getByText(en.reconstruction.note)).toBeInTheDocument()
  })

  it("opens on the request alone and stops on the approval checkpoint", () => {
    const { container } = renderWorkbench()
    expect(screen.getByText(workbench.userTurn)).toBeInTheDocument()
    expect(screen.queryByText(workbench.statusLine)).toBeNull()
    expect(container.querySelector("figure")).toHaveAttribute("data-phase", "0")

    act(() => {
      jest.advanceTimersByTime(HERO_PHASE_DELAYS.reduce((sum, delay) => sum + delay, 0))
    })
    expect(screen.getByText(workbench.statusLine)).toBeInTheDocument()
    expect(container.querySelector("figure")).toHaveAttribute("data-phase", "4")

    // One pass, then it holds. A loop would keep undoing the halt.
    act(() => jest.advanceTimersByTime(60_000))
    expect(container.querySelector("figure")).toHaveAttribute("data-phase", "4")
  })

  it("renders the finished state immediately under reduced motion", () => {
    reduced = true
    const { container } = renderWorkbench()
    expect(screen.getByText(workbench.statusLine)).toBeInTheDocument()
    expect(screen.getByText(DEMO_TASK.diff.lines[0].text.trim())).toBeInTheDocument()
    expect(container.querySelector("figure")).toHaveAttribute("data-phase", "4")
    expect(container.querySelector('[class*="fade-through"]')).toBeNull()
  })

  it("carries the signal border around the frame", () => {
    const { container } = renderWorkbench()
    expect(container.querySelector('[data-slot="border-beam"]')).toBeInTheDocument()
  })
})
