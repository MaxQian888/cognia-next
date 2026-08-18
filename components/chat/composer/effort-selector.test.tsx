/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { EffortSelector } from "./effort-selector"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { updateSession } from "@/lib/db/sessions"

// The selector persists the tier through the Dexie sessions table.
jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
}))
const mockedUpdateSession = updateSession as unknown as jest.Mock

// Settings drive both the model/provider fallbacks and the presentation mode.
let mockSettings: Partial<AppSettings> | null = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: Partial<AppSettings> | null }) => T) =>
    selector({ settings: mockSettings }),
}))

// The offered ladder now depends on WHICH RAIL runs the turn (`./effort-surface`),
// so the runtime is an input to every assertion below. Pinned to the built-in
// Claude rail here; the external rail has its own describe block.
let mockRuntime: "claude-sdk" | "external" = "claude-sdk"
jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: <T,>(selector: (s: { runtime: string }) => T) =>
    selector({ runtime: mockRuntime }),
}))

// `useElementWidth` measures a real DOMRect, which jsdom always reports as 0.
// Drive the responsive band explicitly instead.
let mockWidth = 0
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => mockWidth,
}))

// `jest.setup.ts` mocks next-intl against the real `i18n/messages/en.json`, so
// these assertions double as proof that every key this component reads actually
// exists — a missing one resolves to the raw dotted key and fails the match.
const ULTRACODE_DESCRIPTION = "Maximum-but-one reasoning plus the dynamic workflow tools."

function renderSelector(
  session: ChatSession | null,
  opts: { disabled?: boolean; mode?: "slider" | "list" } = {}
) {
  return render(<EffortSelector session={session} disabled={opts.disabled} mode={opts.mode} />)
}

// Effort-capable model (Sonnet 4.6 matches ANTHROPIC_EFFORT_FAMILIES).
const capableSession: ChatSession = {
  id: "ses_1",
  title: "t",
  kind: "direct",
  model: "claude-sonnet-4-6",
  providerOverride: "anthropic",
  effort: "high",
  thinkingLevel: "high",
  createdAt: 0,
  updatedAt: 0,
}

/**
 * jsdom has no `PointerEvent`, so RTL's `fireEvent.pointerDown(el, {clientX})`
 * builds a bare `Event` and drops the coordinate. `MouseEvent` DOES carry
 * `clientX` and React dispatches purely by type, so this delivers a real
 * position to the pointer handlers.
 */
function pointerEvent(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
}

/** Give the track a real geometry so pointer ratios are meaningful in jsdom. */
function stubTrackRect(width = 100, left = 0): HTMLElement {
  const track = screen.getByTestId("effort-track")
  track.getBoundingClientRect = () => ({ left, width, top: 0, height: 24 }) as DOMRect
  return track
}

beforeEach(() => {
  mockedUpdateSession.mockClear()
  mockedUpdateSession.mockImplementation(async () => undefined)
  mockSettings = null
  mockWidth = 0
  mockRuntime = "claude-sdk"
})

describe("self-gating", () => {
  it("renders nothing when there is no session", () => {
    const { container } = renderSelector(null)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the active model does not support effort", () => {
    const { container } = renderSelector({ ...capableSession, model: "claude-sonnet-4-5" })
    expect(container).toBeEmptyDOMElement()
  })

  it("falls back to the app default model when the session carries none", () => {
    // Session without a model + an effort-capable app default ⇒ still rendered.
    mockSettings = { defaultModel: "claude-opus-4-8", defaultProvider: "anthropic" }
    renderSelector({ ...capableSession, model: undefined, providerOverride: undefined })
    expect(screen.getByTestId("effort-selector-section")).toBeInTheDocument()
  })
})

describe("provider adaptation", () => {
  const onModel = (model: string, providerOverride: string): ChatSession => ({
    ...capableSession,
    model,
    providerOverride,
  })

  it("offers Anthropic's full ladder including ultracode", () => {
    mockWidth = 360
    renderSelector(capableSession, { mode: "list" })
    const names = screen.getAllByRole("radio").map((el) => el.textContent ?? "")
    expect(names.some((n) => n.startsWith("Max"))).toBe(true)
    expect(names.some((n) => n.startsWith("Ultracode"))).toBe(true)
  })

  it("hides max on OpenAI-native, which folds it to xhigh anyway", () => {
    mockWidth = 360
    renderSelector(onModel("gpt-5", "openai"), { mode: "list" })
    const names = screen.getAllByRole("radio").map((el) => el.textContent ?? "")
    expect(names.some((n) => n.startsWith("Extra"))).toBe(true)
    expect(names.some((n) => n.startsWith("Max"))).toBe(false)
    // xhigh survives to the wire there, so the composite tier is still honest.
    expect(names.some((n) => n.startsWith("Ultracode"))).toBe(true)
  })

  it("collapses a generic gateway to the three tiers it distinguishes", () => {
    mockWidth = 360
    renderSelector(onModel("deepseek-reasoner", "deepseek"), { mode: "list" })
    const names = screen.getAllByRole("radio").map((el) => el.textContent ?? "")
    // Auto + low/medium/high, and nothing above: the channel folds xhigh AND
    // max onto `high`, so offering them would be three controls with one effect.
    expect(names).toHaveLength(4)
    expect(names.some((n) => n.startsWith("Extra"))).toBe(false)
    expect(names.some((n) => n.startsWith("Ultracode"))).toBe(false)
  })

  it("draws one tick per offered tier, not per ladder entry", () => {
    const { container } = renderSelector(onModel("deepseek-reasoner", "deepseek"))
    // 3 offered tiers ⇒ 3 ticks, plus the marker. (There is no progress fill:
    // the redesigned track carries position through the marker and the tick
    // scale alone, so a fourth kind of span would be a fourth thing to read.)
    expect(container.querySelectorAll("[data-testid='effort-track'] > span")).toHaveLength(4)
    expect(screen.getByTestId("effort-track")).toHaveAttribute("aria-valuemax", "2")
  })

  it("displays a persisted tier the active model cannot honour as what will be sent", () => {
    // `max` on a gateway really goes out as `high`; showing `max` would
    // misreport the turn. The session row is left alone.
    renderSelector({ ...onModel("deepseek-reasoner", "deepseek"), thinkingLevel: "max" })
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
    expect(mockedUpdateSession).not.toHaveBeenCalled()
  })

  it("keeps the slider ends addressable on a narrowed ladder", () => {
    renderSelector(onModel("deepseek-reasoner", "deepseek"))
    fireEvent.keyDown(screen.getByTestId("effort-track"), { key: "End" })
    // "End" lands on the last OFFERED tier, not on the ladder's `ultracode`.
    expect(mockedUpdateSession).toHaveBeenLastCalledWith("ses_1", {
      effort: "high",
      thinkingLevel: "high",
    })
  })
})

describe("tier presentation", () => {
  // The control used to print the raw wire value — "xhigh", "ultracode" — which
  // is a parameter name, not a choice a user can weigh. The ladder now reads as
  // a ladder.
  it("labels tiers by display name rather than wire value", () => {
    mockWidth = 360
    renderSelector(capableSession, { mode: "list" })
    const names = screen.getAllByRole("radio").map((el) => el.textContent ?? "")
    expect(names.some((n) => n.startsWith("Extra"))).toBe(true)
    expect(names.some((n) => n.startsWith("xhigh"))).toBe(false)
  })

  it("heads the card with the caption and the live tier", () => {
    renderSelector(capableSession)
    expect(screen.getByText("Effort")).toBeInTheDocument()
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
  })

  // Ultracode is not just the deepest step — it also arms the dynamic-workflow
  // tools — so the track says so before the label is read.
  it("textures the track only on the ultracode tier", () => {
    const { unmount } = renderSelector(capableSession)
    expect(screen.queryByTestId("effort-track-ultra")).toBeNull()
    expect(screen.getByTestId("effort-track")).not.toHaveAttribute("data-ultra")
    unmount()

    renderSelector({ ...capableSession, effort: "xhigh", thinkingLevel: "ultracode" })
    expect(screen.getByTestId("effort-track-ultra")).toBeInTheDocument()
    expect(screen.getByTestId("effort-track")).toHaveAttribute("data-ultra", "true")
    expect(screen.getByTestId("effort-selector-value").className).toContain("text-effort-ultra")
  })

  it("renders the standalone card variant without the in-popover divider", () => {
    const { container } = render(<EffortSelector session={capableSession} variant="card" />)
    const root = screen.getByTestId("effort-selector-section")
    expect(root).toHaveAttribute("data-variant", "card")
    expect(root.className).not.toContain("border-t")
    expect(container).not.toBeEmptyDOMElement()
  })
})

describe("external agent rail", () => {
  // The agent brings its own model, so the session's model describes a runtime
  // that will not execute the turn.
  it("offers the generic ladder even when the session model rejects effort", () => {
    mockRuntime = "external"
    mockWidth = 360
    renderSelector({ ...capableSession, model: "claude-sonnet-4-5" }, { mode: "list" })
    const names = screen.getAllByRole("radio").map((el) => el.textContent ?? "")
    expect(names).toHaveLength(4) // Auto + low/medium/high
    expect(names.some((n) => n.startsWith("Ultracode"))).toBe(false)
  })

  it("explains that the agent folds the level onto its own ladder", () => {
    mockRuntime = "external"
    renderSelector(capableSession)
    // The hint text differs per rail; assert the control picked the external one.
    expect(screen.getByLabelText("About thinking levels")).toBeInTheDocument()
  })
})

describe("hidden-tier preference", () => {
  it("drops the tiers the user chose not to see", () => {
    mockWidth = 360
    mockSettings = { composerBehavior: { hiddenEffortTiers: ["low", "max", "ultracode"] } }
    renderSelector(capableSession, { mode: "list" })
    const names = screen.getAllByRole("radio").map((el) => el.textContent ?? "")
    expect(names.some((n) => n.startsWith("Ultracode"))).toBe(false)
    expect(names.some((n) => n.startsWith("Max"))).toBe(false)
    expect(names.some((n) => n.startsWith("Medium"))).toBe(true)
    // "Auto" survives every preference: it is the way back to the model default.
    expect(names.some((n) => n.startsWith("Auto"))).toBe(true)
  })

  it("keeps a session on a hidden tier running, showing the nearest visible one", () => {
    // Hiding is presentation. The row is not rewritten, so the depth the user
    // picked before hiding still goes out.
    mockSettings = { composerBehavior: { hiddenEffortTiers: ["max"] } }
    renderSelector({ ...capableSession, effort: "max", thinkingLevel: "max" })
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Extra")
    expect(mockedUpdateSession).not.toHaveBeenCalled()
  })
})

describe("presentation mode", () => {
  it("defaults to the slider when the user has expressed no preference", () => {
    renderSelector(capableSession)
    expect(screen.getByTestId("effort-selector-section")).toHaveAttribute("data-mode", "slider")
    expect(screen.getByTestId("effort-track")).toBeInTheDocument()
  })

  it("renders the list when the preference asks for it", () => {
    mockSettings = { composerBehavior: { effortSelectorMode: "list" } }
    renderSelector(capableSession)
    expect(screen.getByTestId("effort-selector-section")).toHaveAttribute("data-mode", "list")
    expect(screen.queryByTestId("effort-track")).not.toBeInTheDocument()
    expect(screen.getByRole("radiogroup", { name: "Thinking level" })).toBeInTheDocument()
  })

  it("lets an explicit prop override the preference", () => {
    mockSettings = { composerBehavior: { effortSelectorMode: "list" } }
    renderSelector(capableSession, { mode: "slider" })
    expect(screen.getByTestId("effort-track")).toBeInTheDocument()
  })

  it("shows the same current tier in both modes", () => {
    const { unmount } = renderSelector(capableSession, { mode: "slider" })
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
    unmount()
    renderSelector(capableSession, { mode: "list" })
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
  })
})

describe("persistence", () => {
  it("writes effort and thinkingLevel together for a plain tier", () => {
    renderSelector(capableSession, { mode: "list" })
    fireEvent.click(screen.getByRole("radio", { name: /^Max/ }))
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: "max",
      thinkingLevel: "max",
    })
  })

  it("stores ultracode as xhigh effort under its own tier", () => {
    // The whole reason `thinkingLevel` exists: the SDK never sees "ultracode",
    // but the tier has to survive a round-trip so the workflow-tool coupling in
    // `resolveSendOptions` can key on it.
    renderSelector(capableSession, { mode: "list" })
    fireEvent.click(screen.getByRole("radio", { name: /^Ultracode/ }))
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
  })

  it("clears effort but records the choice when 'Auto' is picked", () => {
    renderSelector(capableSession, { mode: "list" })
    fireEvent.click(screen.getByRole("radio", { name: /^Auto/ }))
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: undefined,
      thinkingLevel: "off",
    })
  })

  it("updates the displayed tier optimistically, before the session prop changes", () => {
    renderSelector(capableSession, { mode: "list" })
    fireEvent.click(screen.getByRole("radio", { name: /^Max/ }))
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Max")
  })

  it("reverts the optimistic tier when the write fails", async () => {
    mockedUpdateSession.mockRejectedValueOnce(new Error("write failed"))
    renderSelector(capableSession, { mode: "list" }) // persisted tier: "high"
    fireEvent.click(screen.getByRole("radio", { name: /^Max/ }))
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Max")
    // …then back to the persisted tier, so the control never misrepresents
    // what the DB actually holds.
    await waitFor(() =>
      expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
    )
  })

  it("clears the optimistic overlay when the session changes", () => {
    const { rerender } = renderSelector(capableSession, { mode: "list" })
    fireEvent.click(screen.getByRole("radio", { name: /^Max/ }))
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Max")
    rerender(
      <EffortSelector
        session={{ ...capableSession, id: "ses_2", effort: "low", thinkingLevel: "low" }}
        mode="list"
      />
    )
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Low")
  })

  it("derives the tier from effort alone on rows written before thinkingLevel existed", () => {
    renderSelector({ ...capableSession, thinkingLevel: undefined, effort: "medium" })
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Medium")
  })
})

describe("slider interaction", () => {
  it("jumps to the tier under a click on the track", () => {
    renderSelector(capableSession)
    const track = stubTrackRect()
    fireEvent(track, pointerEvent("pointerdown", 100)) // far right ⇒ last tier
    fireEvent.pointerUp(track)
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
  })

  it("writes once per drag, not once per tier crossed", () => {
    renderSelector(capableSession)
    const track = stubTrackRect()
    fireEvent(track, pointerEvent("pointerdown", 0))
    fireEvent(track, pointerEvent("pointermove", 40))
    fireEvent(track, pointerEvent("pointermove", 80))
    // The tier under the pointer is previewed the whole way…
    expect(mockedUpdateSession).not.toHaveBeenCalled()
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("Max")
    fireEvent.pointerUp(track)
    // …and committed exactly once on release.
    expect(mockedUpdateSession).toHaveBeenCalledTimes(1)
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: "max",
      thinkingLevel: "max",
    })
  })

  it("still selects when the browser refuses to capture the pointer", () => {
    // WebKit throws NotFoundError from `setPointerCapture` when the pointer is
    // already gone. Capture is an enhancement — losing it must not swallow the
    // click that carried it.
    renderSelector(capableSession)
    const track = stubTrackRect()
    Object.defineProperty(track, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("NotFoundError")
      },
    })
    fireEvent(track, pointerEvent("pointerdown", 100))
    fireEvent.pointerUp(track)
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
  })

  it("ignores pointer movement that is not part of a drag", () => {
    renderSelector(capableSession)
    const track = stubTrackRect()
    fireEvent(track, pointerEvent("pointermove", 100))
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
  })

  it("abandons a drag on pointer cancel without a second write", () => {
    renderSelector(capableSession)
    const track = stubTrackRect()
    fireEvent(track, pointerEvent("pointerdown", 0))
    fireEvent.pointerCancel(track)
    fireEvent.pointerUp(track)
    expect(mockedUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("steps and jumps with the CLI's keyboard map", () => {
    renderSelector(capableSession) // "high" ⇒ index 2
    const track = screen.getByTestId("effort-track")

    fireEvent.keyDown(track, { key: "ArrowRight" })
    expect(mockedUpdateSession).toHaveBeenLastCalledWith("ses_1", {
      effort: "xhigh",
      thinkingLevel: "xhigh",
    })

    fireEvent.keyDown(track, { key: "Home" })
    expect(mockedUpdateSession).toHaveBeenLastCalledWith("ses_1", {
      effort: "low",
      thinkingLevel: "low",
    })

    fireEvent.keyDown(track, { key: "End" })
    expect(mockedUpdateSession).toHaveBeenLastCalledWith("ses_1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })

    fireEvent.keyDown(track, { key: "2" })
    expect(mockedUpdateSession).toHaveBeenLastCalledWith("ses_1", {
      effort: "medium",
      thinkingLevel: "medium",
    })

    fireEvent.keyDown(track, { key: "0" })
    expect(mockedUpdateSession).toHaveBeenLastCalledWith("ses_1", {
      effort: undefined,
      thinkingLevel: "off",
    })
  })

  it("leaves unrelated keys to the popover", () => {
    renderSelector(capableSession)
    fireEvent.keyDown(screen.getByTestId("effort-track"), { key: "Escape" })
    expect(mockedUpdateSession).not.toHaveBeenCalled()
  })

  it("hides the marker and reports the tier through aria while on 'Auto'", () => {
    renderSelector({ ...capableSession, effort: undefined, thinkingLevel: "off" })
    const track = screen.getByTestId("effort-track")
    expect(track).toHaveAttribute("aria-valuetext", "Auto")
    // "off" is not a position on the track, so `aria-valuenow` parks at the fast
    // end and `aria-valuetext` carries the real state.
    expect(track).toHaveAttribute("aria-valuenow", "0")
    expect(screen.queryByTestId("effort-track-marker")).not.toBeInTheDocument()
    expect(screen.getByTestId("effort-auto-toggle")).toHaveAttribute("aria-pressed", "true")
  })

  it("selects a tier from its label under the track", () => {
    mockWidth = 360
    renderSelector(capableSession)
    fireEvent.click(screen.getByRole("button", { name: "Medium" }))
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", {
      effort: "medium",
      thinkingLevel: "medium",
    })
  })
})

describe("responsive layout", () => {
  it("labels every tier under the track when there is room", () => {
    mockWidth = 360
    renderSelector(capableSession)
    expect(screen.getByTestId("effort-selector-section")).toHaveAttribute("data-layout", "wide")
    expect(screen.getByRole("button", { name: "Ultracode" })).toBeInTheDocument()
  })

  it("drops the tier labels in a narrow container", () => {
    mockWidth = 240
    renderSelector(capableSession)
    expect(screen.getByTestId("effort-selector-section")).toHaveAttribute("data-layout", "compact")
    expect(screen.queryByRole("button", { name: "Ultracode" })).not.toBeInTheDocument()
    // The track and the current tier survive — only the scale is dropped.
    expect(screen.getByTestId("effort-track")).toBeInTheDocument()
    expect(screen.getByTestId("effort-selector-value")).toHaveTextContent("High")
  })

  it("drops the per-row descriptions in a narrow list", () => {
    mockWidth = 240
    renderSelector(capableSession, { mode: "list" })
    expect(screen.queryByText(ULTRACODE_DESCRIPTION)).not.toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /^Ultracode/ })).toBeInTheDocument()
  })

  it("keeps the per-row descriptions when there is room", () => {
    mockWidth = 360
    renderSelector(capableSession, { mode: "list" })
    expect(screen.getByText(ULTRACODE_DESCRIPTION)).toBeInTheDocument()
  })
})

describe("streaming", () => {
  it("blocks every slider affordance while a turn is in flight", () => {
    mockWidth = 360
    renderSelector(capableSession, { disabled: true })
    const track = stubTrackRect()
    expect(track).toHaveAttribute("aria-disabled", "true")
    expect(track).toHaveAttribute("tabindex", "-1")

    fireEvent.keyDown(track, { key: "ArrowRight" })
    fireEvent(track, pointerEvent("pointerdown", 100))
    fireEvent.pointerUp(track)
    expect(mockedUpdateSession).not.toHaveBeenCalled()

    expect(screen.getByRole("button", { name: "Ultracode" })).toBeDisabled()
    expect(screen.getByTestId("effort-auto-toggle")).toBeDisabled()
  })

  it("disables every list row while a turn is in flight", () => {
    renderSelector(capableSession, { disabled: true, mode: "list" })
    for (const row of screen.getAllByRole("radio")) {
      expect(row).toBeDisabled()
    }
  })
})
