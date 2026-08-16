import { act, fireEvent, render, screen, within } from "@testing-library/react"

import {
  __resetBootProgressForTesting,
  beginBootMilestone,
  endBootMilestone,
  getBootProgressSnapshot,
} from "@/lib/boot/boot-progress"
import {
  __resetMobileBootForTesting,
  beginMobileBootStage,
  endMobileBootStage,
  getMobileBootSnapshot,
  markMobileBootIntroPlayed,
  markMobileBootSettled,
  skipMobileBootStagesAfter,
} from "@/lib/boot/mobile-boot-stages"
import { ESCALATED_AT_MS, PROLONGED_AT_MS } from "@/hooks/ui/use-loading-phase"
import { APP_VERSION } from "@/lib/app-version"

import { __resetMobileBootScreenForTesting, MobileBootScreen } from "./mobile-boot-screen"

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: mockNetwork }),
}))
let mockNetwork = { connected: true, connectionType: "wifi" }

const rowStatuses = () =>
  screen
    .getAllByRole("listitem")
    .filter((li) => li.getAttribute("data-slot") === "mobile-boot-row")
    .map((li) => `${li.getAttribute("data-row")}:${li.getAttribute("data-status")}`)

describe("<MobileBootScreen />", () => {
  beforeEach(() => {
    __resetBootProgressForTesting()
    __resetMobileBootForTesting()
    __resetMobileBootScreenForTesting()
    mockNetwork = { connected: true, connectionType: "wifi" }
    jest.useFakeTimers()
  })

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers()
    })
    jest.useRealTimers()
  })

  it("renders the splash overlay with the brand mark, wordmark and the full timeline", () => {
    render(<MobileBootScreen milestone={null} />)

    const root = screen.getByTestId("app-splash")
    expect(root).toHaveAttribute("data-layout", "boot")
    expect(root).toHaveAttribute("data-state", "running")
    expect(root).toHaveClass("mboot--boot", "mboot--intro")
    expect(screen.getByRole("status", { name: "Starting cognia" })).toBe(root)
    expect(screen.getByText("cognia")).toHaveClass("mboot__wordmark")
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Getting things ready")

    // Coin reuses the shared PWA icon; decoration is aria-hidden.
    const logo = root.querySelector(".mboot__logo") as HTMLElement
    expect(logo.style.backgroundImage).toContain("/icons/icon-512.png")
    for (const sel of [".mboot__ring", ".mboot__halo", ".mboot__orbit--a", ".mboot__aurora--a"]) {
      expect(root.querySelector(sel)).toHaveAttribute("aria-hidden", "true")
    }

    // The overlay mounts inside the gates: milestones behind it, stages pending.
    expect(rowStatuses()).toEqual([
      "accounts:done",
      "preferences:done",
      "bridge:pending",
      "companion:pending",
      "host:pending",
      "sync:pending",
    ])
    expect(screen.getByRole("list", { name: "Startup steps" })).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Startup progress" })).toHaveAttribute(
      "aria-valuenow",
      "2"
    )
    expect(screen.getByText("2 of 6")).toBeInTheDocument()
    expect(screen.getByText(`Mobile · v${APP_VERSION}`)).toBeInTheDocument()
    // The overlay never registers a milestone of its own.
    expect(getBootProgressSnapshot().active).toBeNull()
    expect(getMobileBootSnapshot().introPlayed).toBe(true)
  })

  it("follows the Capacitor stages live: spinner, detail, outcome chips, durations, settled mark", () => {
    render(<MobileBootScreen milestone={null} />)

    act(() => {
      beginMobileBootStage("bridge", 1000)
    })
    const bridge = screen.getByRole("listitem", { current: "step" })
    expect(bridge).toHaveAttribute("data-row", "bridge")
    expect(within(bridge).getByText("Waking the native bridge")).toBeInTheDocument()
    expect(within(bridge).getByText("Registering the Capacitor plugins")).toBeInTheDocument()
    expect(within(bridge).getByText("In progress")).toHaveClass("sr-only")
    expect(bridge.querySelector(".animate-spin")).not.toBeNull()

    act(() => {
      endMobileBootStage("bridge", { detail: "registered" }, 1060)
      beginMobileBootStage("companion", 1060)
      endMobileBootStage("companion", { detail: "paired" }, 1300)
      beginMobileBootStage("host", 1300)
    })
    expect(rowStatuses().slice(2)).toEqual([
      "bridge:done",
      "companion:done",
      "host:active",
      "sync:pending",
    ])
    const chips = screen.getAllByText((_, el) => el?.getAttribute("data-slot") === "mobile-boot-outcome")
    expect(chips.map((c) => c.textContent)).toEqual(["Native", "Paired"])
    expect(chips[1]).toHaveAttribute("data-tone", "good")
    expect(screen.getByText("0.1s")).toBeInTheDocument()
    expect(screen.getByText("0.2s")).toBeInTheDocument()
    const host = screen.getByRole("listitem", { current: "step" })
    expect(host).toHaveAttribute("data-row", "host")
    expect(within(host).getByText("Reaching your desktop")).toBeInTheDocument()

    act(() => {
      endMobileBootStage("host", { status: "failed", detail: "offline" }, 4000)
      skipMobileBootStagesAfter("host", 4000)
      markMobileBootSettled()
    })
    const root = screen.getByTestId("app-splash")
    expect(root).toHaveAttribute("data-state", "settled")
    expect(root).toHaveClass("mboot--settled")
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ready")
    expect(rowStatuses().slice(4)).toEqual(["host:failed", "sync:skipped"])
    const offlineChip = screen.getByText("Offline")
    expect(offlineChip).toHaveAttribute("data-tone", "warn")
    expect(screen.getByText("Not needed")).toHaveAttribute("data-tone", "muted")
    expect(screen.getByText("Failed")).toHaveClass("sr-only")
    expect(screen.getByText("Skipped")).toHaveClass("sr-only")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "6")
  })

  it("plays the exit when leaving", () => {
    const { rerender } = render(<MobileBootScreen milestone={null} />)
    rerender(<MobileBootScreen milestone={null} leaving />)
    const root = screen.getByTestId("app-splash")
    expect(root).toHaveClass("mboot--leaving")
    expect(root).toHaveAttribute("data-state", "leaving")
  })

  it("as a cold-boot gate it owns its milestone and paints the splash canvas", () => {
    render(<MobileBootScreen milestone="accounts" allowReload />)
    expect(getBootProgressSnapshot().active).toBe("accounts")

    const root = document.querySelector('[data-slot="mobile-boot"]') as HTMLElement
    expect(root).toHaveAttribute("data-layout", "boot")
    expect(root).toHaveClass("mboot--boot", "z-30")
    expect(root).not.toHaveAttribute("data-testid")
    expect(root).toHaveAttribute("aria-busy", "true")
    // Labelled by its heading, not a status role — the gate is the page.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Getting things ready")
    expect(root.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading").id)
    expect(rowStatuses()[0]).toBe("accounts:active")
    // A gate under the native splash is not yet counted as seen.
    expect(getMobileBootSnapshot().introPlayed).toBe(false)
  })

  it("renders the compact in-flow layout for a route transition", () => {
    beginBootMilestone("workspace", 5000)
    render(<MobileBootScreen milestone="workspace" />)
    const root = document.querySelector('[data-slot="mobile-boot"]') as HTMLElement
    expect(root).toHaveAttribute("data-layout", "route")
    expect(root).toHaveClass("mboot--route")
    expect(root).not.toHaveClass("mboot--boot")
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Loading this page")
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    expect(root.querySelector(".mboot__aurora")).toBeNull()
    expect(root.querySelector(".mboot__orbit")).toBeNull()
    expect(root.querySelector(".mboot__wordmark")).toBeNull()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Loading the view")
  })

  it("moves the progress fill and remembers it across mounts", () => {
    const { unmount } = render(<MobileBootScreen milestone={null} />)
    const fill = () => document.querySelector('[data-slot="mobile-boot-fill"]') as HTMLElement
    // First mount starts from zero and is then driven to its target.
    expect(fill().style.getPropertyValue("--mboot-fill")).toBe(String(2 / 6))
    act(() => {
      beginMobileBootStage("bridge", 1)
      endMobileBootStage("bridge", { detail: "registered" }, 2)
    })
    expect(fill().style.getPropertyValue("--mboot-fill")).toBe(String(3 / 6))
    unmount()
    // The next owner's bar picks up where this one left off.
    render(<MobileBootScreen milestone={null} />)
    expect(fill().style.getPropertyValue("--mboot-fill")).toBe(String(3 / 6))
  })

  it("does not replay the entrance once the intro has been seen", () => {
    markMobileBootIntroPlayed()
    render(<MobileBootScreen milestone={null} />)
    expect(screen.getByTestId("app-splash")).not.toHaveClass("mboot--intro")
  })

  it("pops the check on the row that just finished, not on rows ticked at mount", () => {
    markMobileBootIntroPlayed()
    render(<MobileBootScreen milestone={null} />)
    act(() => {
      beginMobileBootStage("bridge", 1)
      endMobileBootStage("bridge", { detail: "registered" }, 2)
    })
    const rows = screen
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("data-slot") === "mobile-boot-row")
    expect(rows[2].querySelector(".mboot__check--pop")).not.toBeNull()
    expect(rows[1].querySelector(".mboot__check--pop")).toBeNull()
  })

  it("reassures once prolonged, names the network when offline, and offers a reload only when escalated on a gate", () => {
    beginBootMilestone("accounts", 0)
    endBootMilestone("accounts", 10)
    render(<MobileBootScreen milestone="preferences" allowReload />)
    expect(screen.queryByText(/Still working/)).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(PROLONGED_AT_MS + 1000)
    })
    expect(screen.getByText(/Still working/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reload app" })).not.toBeInTheDocument()

    mockNetwork = { connected: false, connectionType: "none" }
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(screen.getByText(/You're offline/)).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(ESCALATED_AT_MS)
    })
    expect(screen.getByText(/Taking longer than expected/)).toBeInTheDocument()
    // jsdom locks `window.location.reload` and reports "not implemented" through
    // its virtual console when it is called — assert the affordance is live and
    // clicking it does not throw, with that one expected report muted.
    const button = screen.getByRole("button", { name: "Reload app" })
    expect(button).toBeEnabled()
    const muted = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => fireEvent.click(button)).not.toThrow()
    } finally {
      muted.mockRestore()
    }
  })

  it("the overlay never escalates to a reload — it has its own ceiling", () => {
    render(<MobileBootScreen milestone={null} allowReload />)
    act(() => {
      jest.advanceTimersByTime(ESCALATED_AT_MS + 2000)
    })
    expect(screen.getByText(/Still working/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reload app" })).not.toBeInTheDocument()
  })
})
