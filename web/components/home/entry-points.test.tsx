import { act, render, screen, within } from "@testing-library/react"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ReactNode } from "react"
import { DEMO_TASK } from "@web/content/demo-task"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"

let reduced = false
let inView = true
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => inView,
  motion: {
    div: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}))

import { CAPTURE_SHORTCUT, CLI_RESUME_COMMAND, EntryPoints, HANDOFF_STEP_MS } from "./entry-points"

function renderEntries(locale: "en" | "zh" = "en") {
  const copy = locale === "en" ? en : zh
  return render(
    <EntryPoints copy={copy.home.entryPoints} reconstruction={copy.reconstruction} index={5} />
  )
}

describe("EntryPoints", () => {
  beforeEach(() => {
    reduced = false
    inView = true
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders the five stations in handoff order, each with a role and a body", () => {
    renderEntries()
    const items = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-station"))
    expect(items.map((li) => li.getAttribute("data-station"))).toEqual([
      "desktop",
      "mobile",
      "im",
      "cli",
      "browser",
    ])
    for (const station of en.home.entryPoints.stations) {
      expect(screen.getByText(station.role)).toBeInTheDocument()
      expect(screen.getByText(station.body)).toBeInTheDocument()
    }
    expect(screen.getByText("05")).toBeInTheDocument()
  })

  it("walks the marker forward one station at a time and stops at the last", () => {
    const { container } = renderEntries()
    const handoff = container.querySelector('[data-slot="handoff"]') as HTMLElement
    expect(handoff).toHaveAttribute("data-phase", "0")
    expect(container.querySelector('[data-slot="handoff-marker"]')).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(HANDOFF_STEP_MS)
    })
    expect(handoff).toHaveAttribute("data-phase", "1")

    act(() => {
      jest.advanceTimersByTime(HANDOFF_STEP_MS * 10)
    })
    expect(handoff).toHaveAttribute("data-phase", "4")
    expect(container.querySelectorAll("[data-reached]")).toHaveLength(5)
  })

  it("renders every station complete under reduced motion, with no travelling marker", () => {
    reduced = true
    const { container } = renderEntries()
    expect(container.querySelector('[data-slot="handoff"]')).toHaveAttribute("data-phase", "4")
    expect(container.querySelector('[data-slot="handoff-marker"]')).toBeNull()
    expect(container.querySelectorAll("[data-reached]")).toHaveLength(5)
  })

  it("does not start until the section is on screen", () => {
    inView = false
    const { container } = renderEntries()
    act(() => {
      jest.advanceTimersByTime(HANDOFF_STEP_MS * 10)
    })
    // Off screen and motion allowed: the finished state is shown, not a run
    // the reader would miss.
    expect(container.querySelector('[data-slot="handoff"]')).toHaveAttribute("data-phase", "4")
    expect(container.querySelector('[data-slot="handoff-marker"]')).toBeNull()
  })

  it("rebuilds every surface from the one demo task", () => {
    const { container } = renderEntries()
    const desktop = within(container.querySelector('[data-station="desktop"]') as HTMLElement)
    expect(desktop.getByText(DEMO_TASK.repository)).toBeInTheDocument()
    expect(desktop.getByText(en.reconstruction.workbench.userTurn)).toBeInTheDocument()

    const mobile = within(container.querySelector('[data-station="mobile"]') as HTMLElement)
    expect(mobile.getByText(DEMO_TASK.approval.command)).toBeInTheDocument()
    expect(mobile.getByText(DEMO_TASK.approval.target)).toBeInTheDocument()
    expect(mobile.getByText(en.reconstruction.artifacts.approval.approveLabel)).toBeInTheDocument()

    const im = within(container.querySelector('[data-station="im"]') as HTMLElement)
    expect(im.getByText(String(DEMO_TASK.diff.filesChanged))).toBeInTheDocument()
    expect(im.getByText(DEMO_TASK.artifact.file)).toBeInTheDocument()

    const cli = within(container.querySelector('[data-station="cli"]') as HTMLElement)
    expect(cli.getByText(CLI_RESUME_COMMAND)).toBeInTheDocument()
    expect(cli.getByText(DEMO_TASK.test.command)).toBeInTheDocument()

    const browser = within(container.querySelector('[data-station="browser"]') as HTMLElement)
    expect(browser.getByText(CAPTURE_SHORTCUT)).toBeInTheDocument()
  })

  it("labels the frames as reconstructions and describes the sequence once for assistive technology", () => {
    renderEntries()
    expect(screen.getByText(`${en.reconstruction.label}.`)).toBeInTheDocument()
    expect(screen.getByText(en.home.entryPoints.sequenceLabel)).toHaveClass("sr-only")
  })

  it("lists one chat platform per adapter directory in the repository", () => {
    // The channel strip is copy, so it can drift from the code. Pin it to the
    // adapter directories: a platform added or removed there is a failure here.
    const adapters = readdirSync(join(__dirname, "../../../lib/connectors/adapters"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    expect(en.home.entryPoints.channels).toHaveLength(adapters.length)
    expect(zh.home.entryPoints.channels).toHaveLength(adapters.length)
  })

  it("quotes the resume command and the capture shortcut from their defining modules", () => {
    const args = readFileSync(join(__dirname, "../../../cli/src/cli/args.ts"), "utf8")
    expect(args).toContain('"continue"')
    const wxt = readFileSync(join(__dirname, "../../../browser-extension/wxt.config.ts"), "utf8")
    expect(wxt).toContain(CAPTURE_SHORTCUT)
  })

  it("renders the Chinese copy", () => {
    renderEntries("zh")
    expect(screen.getByText(zh.home.entryPoints.title)).toBeInTheDocument()
    for (const channel of zh.home.entryPoints.channels) {
      expect(screen.getByText(channel)).toBeInTheDocument()
    }
  })
})
