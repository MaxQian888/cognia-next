/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { renderToString } from "react-dom/server"

import {
  __resetBootCapabilitiesForTesting,
  ensureBootCapability,
  markBootCapabilityReady,
} from "@/lib/boot/capabilities"
import {
  __resetBootProgressForTesting,
  beginBootMilestone,
  endBootMilestone,
  markBootIntroPlayed,
} from "@/lib/boot/boot-progress"

const mockNetwork = { connected: true, connectionType: "wifi" as const }
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: mockNetwork }),
}))

let mockPlatform = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
}))

jest.mock("@/lib/app-version", () => ({ APP_VERSION: "9.9.9-test" }))

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))

import { BootScreen, __resetBootScreenForTesting } from "./boot-screen"

const T = "loading.page."

function rows() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="boot-milestone"]'))
}

function fill(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="boot-bar-fill"]')!
}

describe("BootScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockNetwork.connected = true
    mockPlatform = "web"
    __resetBootProgressForTesting()
    __resetBootScreenForTesting()
    __resetBootCapabilitiesForTesting("main")
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("names the wait, the runtime and the build, and exposes step-based progress", () => {
    render(<BootScreen milestone="accounts" />)

    expect(screen.getByRole("heading", { name: `${T}title` })).toBeInTheDocument()
    expect(screen.getByText(`${T}description`)).toBeInTheDocument()
    expect(screen.getByText(`${T}platform.web`)).toBeInTheDocument()
    expect(screen.getByText(`${T}version:{"version":"9.9.9-test"}`)).toBeInTheDocument()

    const progress = screen.getByRole("progressbar", { name: `${T}progressLabel` })
    expect(progress).toHaveAttribute("aria-valuemin", "0")
    expect(progress).toHaveAttribute("aria-valuemax", "4")
    expect(progress).toHaveAttribute("aria-valuenow", "1")
    expect(progress).toHaveAttribute("aria-valuetext", `${T}milestones.accounts.label`)
    expect(screen.getByText(`${T}stepOf:{"current":1,"total":4}`)).toBeInTheDocument()
  })

  it("lists every step on a cold boot with the caller's own step live", () => {
    render(<BootScreen milestone="accounts" />)
    const list = screen.getByRole("list", { name: `${T}stepsLabel` })
    expect(list).toBeInTheDocument()

    const all = rows()
    expect(all.map((r) => r.dataset.milestone)).toEqual([
      "accounts",
      "preferences",
      "interface",
      "workspace",
    ])
    expect(all.map((r) => r.dataset.status)).toEqual(["active", "pending", "pending", "pending"])
    expect(all[0]).toHaveAttribute("aria-current", "step")
    expect(all[1]).not.toHaveAttribute("aria-current")
    // The live row explains what it is doing; pending rows stay quiet.
    expect(screen.getByText(`${T}milestones.accounts.detail`)).toBeInTheDocument()
    expect(screen.queryByText(`${T}milestones.preferences.detail`)).not.toBeInTheDocument()
    // Screen readers get a status word per row.
    expect(screen.getByText(`${T}statusActive`)).toBeInTheDocument()
    expect(screen.getAllByText(`${T}statusPending`)).toHaveLength(3)
  })

  it("shows the measured duration of steps that already finished", () => {
    // Timestamps sit just before "now" so the mount continues this sequence.
    const now = Date.now()
    beginBootMilestone("accounts", now - 500)
    endBootMilestone("accounts", now - 80)
    beginBootMilestone("preferences", now - 80)
    endBootMilestone("preferences", now - 60)
    render(<BootScreen milestone="interface" />)

    const all = rows()
    expect(all.map((r) => r.dataset.status)).toEqual(["done", "done", "active", "pending"])
    expect(screen.getByText(`${T}milestoneDuration:{"seconds":"0.4"}`)).toBeInTheDocument()
    // A 20ms step still reads as a tenth of a second, never "0.0s".
    expect(screen.getByText(`${T}milestoneDuration:{"seconds":"0.1"}`)).toBeInTheDocument()
    expect(screen.getAllByText(`${T}statusDone`)).toHaveLength(2)
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3")
  })

  it("omits the duration for a step that was passed over rather than measured", () => {
    const now = Date.now()
    beginBootMilestone("accounts", now - 200)
    endBootMilestone("accounts", now - 100)
    // preferences never mounted a loader
    render(<BootScreen milestone="interface" />)
    expect(screen.getAllByText(new RegExp(`${T}milestoneDuration`))).toHaveLength(1)
  })

  it("collapses to the single workspace step on a later route transition", () => {
    markBootIntroPlayed()
    render(<BootScreen milestone="workspace" />)
    expect(rows().map((r) => r.dataset.milestone)).toEqual(["workspace"])
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "1")
    expect(screen.getByText(`${T}stepOf:{"current":1,"total":1}`)).toBeInTheDocument()
    // The chrome the earlier (unlisted) steps stand for is real by now, so the
    // preview draws it settled rather than ghosted.
    const ghosted = document.querySelectorAll(
      '[data-slot="boot-preview-block"][data-settled="false"]'
    )
    expect(ghosted).toHaveLength(0)
  })

  it("ghosts the preview chrome for steps still ahead", () => {
    render(<BootScreen milestone="accounts" />)
    const settled = document.querySelectorAll(
      '[data-slot="boot-preview-block"][data-settled="true"]'
    )
    expect(settled).toHaveLength(0)
  })

  it("lets the caller override the heading and drop the description", () => {
    render(<BootScreen milestone="accounts" title="Custom" description={null} />)
    expect(screen.getByRole("heading", { name: "Custom" })).toBeInTheDocument()
    expect(screen.queryByText(`${T}description`)).not.toBeInTheDocument()
  })

  it("passes a custom description through", () => {
    render(<BootScreen milestone="accounts" description="Doing things" />)
    expect(screen.getByText("Doing things")).toBeInTheDocument()
  })

  describe("runtime capabilities", () => {
    it("lists requested runtimes under the live workspace step with their readiness", () => {
      __resetBootCapabilitiesForTesting("eager")
      markBootCapabilityReady("plugin-runtime")
      render(<BootScreen milestone="workspace" />)

      expect(screen.getByText(`${T}capabilitiesReady:{"ready":1,"total":6}`)).toBeInTheDocument()
      const chips = document.querySelectorAll<HTMLElement>('[data-slot="boot-capability"]')
      expect(chips).toHaveLength(6)
      const ready = Array.from(chips).filter((chip) => chip.dataset.ready === "true")
      expect(ready.map((chip) => chip.dataset.capability)).toEqual(["plugin-runtime"])
      expect(screen.getByText(`${T}capabilities.plugin-runtime`)).toBeInTheDocument()
      // The generic detail line yields to the runtime summary.
      expect(screen.queryByText(`${T}milestones.workspace.detail`)).not.toBeInTheDocument()
    })

    it("updates live as runtimes come up", () => {
      __resetBootCapabilitiesForTesting("main")
      render(<BootScreen milestone="workspace" />)
      expect(screen.getByText(`${T}capabilitiesReady:{"ready":0,"total":1}`)).toBeInTheDocument()
      act(() => {
        void ensureBootCapability("plugin-runtime")
      })
      expect(screen.getByText(`${T}capabilitiesReady:{"ready":0,"total":2}`)).toBeInTheDocument()
      act(() => {
        markBootCapabilityReady("core-chat")
      })
      expect(screen.getByText(`${T}capabilitiesReady:{"ready":1,"total":2}`)).toBeInTheDocument()
    })

    it("does not decorate the other steps with runtimes", () => {
      __resetBootCapabilitiesForTesting("eager")
      render(<BootScreen milestone="accounts" />)
      expect(document.querySelectorAll('[data-slot="boot-capability"]')).toHaveLength(0)
      expect(screen.getByText(`${T}milestones.accounts.detail`)).toBeInTheDocument()
    })
  })

  describe("progress fill", () => {
    it("mounts empty on the first mount and is moved to lean into the first step", () => {
      render(<BootScreen milestone="accounts" />)
      // React committed 0; the effect then moved the element to its target
      // (imperatively, so the CSS transition has a start value to run from).
      expect(Number(fill().style.getPropertyValue("--boot-fill"))).toBeCloseTo(0.85 / 4)
    })

    it("picks up from where the previous owner left it", () => {
      const first = render(<BootScreen milestone="accounts" />)
      first.unmount()

      const seen: string[] = []
      const original = CSSStyleDeclaration.prototype.setProperty
      const spy = jest
        .spyOn(CSSStyleDeclaration.prototype, "setProperty")
        .mockImplementation(function (this: CSSStyleDeclaration, name, value, priority) {
          if (name === "--boot-fill") seen.push(String(value))
          return original.call(this, name, value, priority)
        })
      render(<BootScreen milestone="preferences" />)
      spy.mockRestore()

      // Mounted at the previous target (React's inline style), then moved on
      // to its own by the effect.
      expect(seen.some((v) => Math.abs(Number(v) - 0.85 / 4) < 1e-6)).toBe(true)
      expect(Number(fill().style.getPropertyValue("--boot-fill"))).toBeCloseTo((1 + 0.85) / 4)
    })
  })

  describe("entrance", () => {
    it("plays the intro on the first mount of a page load only", () => {
      const first = render(<BootScreen milestone="accounts" />)
      expect(document.querySelector(".boot-screen__card--intro")).toBeInTheDocument()
      first.unmount()

      render(<BootScreen milestone="preferences" />)
      expect(document.querySelector(".boot-screen__card--intro")).not.toBeInTheDocument()
    })

    it("pops the check only on the step that just finished", () => {
      const now = Date.now()
      beginBootMilestone("accounts", now - 300)
      endBootMilestone("accounts", now - 200)
      beginBootMilestone("preferences", now - 200)
      endBootMilestone("preferences", now - 100)
      markBootIntroPlayed()
      render(<BootScreen milestone="interface" />)

      const popped = document.querySelectorAll(".boot-check")
      expect(popped).toHaveLength(1)
      expect(popped[0].closest('[data-slot="boot-milestone"]')).toHaveAttribute(
        "data-milestone",
        "preferences"
      )
    })

    it("pops nothing on the very first mount", () => {
      render(<BootScreen milestone="accounts" />)
      expect(document.querySelectorAll(".boot-check")).toHaveLength(0)
    })
  })

  describe("prolonged waits", () => {
    it("reassures with the elapsed time once the wait is long", () => {
      render(<BootScreen milestone="accounts" allowReload />)
      const status = screen.getByRole("status")
      expect(status).toHaveTextContent("")
      act(() => {
        jest.advanceTimersByTime(5000)
      })
      expect(status).toHaveTextContent(`loading.stillWorking:{"seconds":5}`)
      expect(screen.queryByRole("button", { name: `${T}reload` })).not.toBeInTheDocument()
    })

    it("counts from the sequence start across a hand-over, not from mount", () => {
      const first = render(<BootScreen milestone="accounts" allowReload />)
      act(() => {
        jest.advanceTimersByTime(4000)
      })
      first.unmount()
      render(<BootScreen milestone="preferences" allowReload />)
      act(() => {
        jest.advanceTimersByTime(1000)
      })
      // 4s under the first owner + 1s under the second: prolonged already.
      expect(screen.getByRole("status")).toHaveTextContent("loading.stillWorking")
    })

    it("blames the connection when a long wait is also offline", () => {
      mockNetwork.connected = false
      render(<BootScreen milestone="accounts" />)
      act(() => {
        jest.advanceTimersByTime(5000)
      })
      expect(screen.getByRole("status")).toHaveTextContent("loading.offline")
    })

    it("offers a reload once escalated, and only when allowed", () => {
      const first = render(<BootScreen milestone="accounts" />)
      act(() => {
        jest.advanceTimersByTime(16000)
      })
      // No way out was offered, so no escalation is shown.
      expect(screen.queryByRole("button", { name: `${T}reload` })).not.toBeInTheDocument()
      expect(screen.queryByText(`${T}reloadHint`)).not.toBeInTheDocument()
      first.unmount()

      __resetBootProgressForTesting()
      render(<BootScreen milestone="accounts" allowReload />)
      act(() => {
        jest.advanceTimersByTime(16000)
      })
      expect(screen.getByText(`${T}reloadHint`)).toBeInTheDocument()
      // jsdom locks `window.location.reload` (see lib/desktop/menu-actions.test.ts)
      // and logs a "not implemented" error through its virtual console when it
      // is called — assert the affordance is live and clicking it does not
      // throw, with that one expected report muted.
      const button = screen.getByRole("button", { name: `${T}reload` })
      expect(button).toBeEnabled()
      const muted = jest.spyOn(console, "error").mockImplementation(() => {})
      try {
        expect(() => fireEvent.click(button)).not.toThrow()
      } finally {
        muted.mockRestore()
      }
    })
  })

  it("labels the desktop runtime when running under Tauri", () => {
    mockPlatform = "tauri"
    render(<BootScreen milestone="accounts" />)
    expect(screen.getByText(`${T}platform.tauri`)).toBeInTheDocument()
  })

  it("server-renders the pristine timeline — the static export ships this markup", () => {
    // The account gate's loader is what the exported HTML contains before any
    // JS runs, so this must render on the server without effects, timers or
    // the DOM, and show the caller's step as live from the first paint.
    const html = renderToString(<BootScreen milestone="accounts" />)
    expect(html).toContain(`${T}title`)
    expect(html).toContain('data-status="active"')
    expect(html).toContain("boot-screen__card--intro")
    expect(html).toContain('aria-valuenow="1"')
    expect(html).toContain('aria-valuemax="4"')
    // No client-only state has leaked in: the fill mounts at zero.
    expect(html).toContain("--boot-fill:0")
  })

  it("marks the region busy and links its label to the heading", () => {
    render(<BootScreen milestone="accounts" />)
    const region = document.querySelector('section[aria-busy="true"]')!
    const labelledBy = region.getAttribute("aria-labelledby")!
    expect(document.getElementById(labelledBy)).toHaveTextContent(`${T}title`)
    expect(document.querySelector('[data-slot="boot-screen"]')).toHaveAttribute(
      "data-milestone",
      "accounts"
    )
  })
})
