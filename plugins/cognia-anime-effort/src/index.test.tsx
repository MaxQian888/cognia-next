/**
 * @jest-environment jsdom
 *
 * The control writes a reasoning tier onto the active session, which is a
 * setting the user cannot see the effect of until the next turn. So the three
 * things that can silently go wrong are pinned here: the tier it writes, the
 * context arriving after mount, and whether a failed write is reported as one.
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ExtensionProps } from "@cognia/plugin-sdk/extensions"

/**
 * The one seam a plugin is allowed to reach for the offered ladder, faked as a
 * pass-through so every test below still exercises the host's real composition.
 * Only the staleness test overrides it, because what belongs here is the half
 * this control owns (it re-reads when told), not the host's subscription, which
 * is pinned where it lives.
 */
let surfaceOverride: { levels: string[]; offered: string[]; external: boolean } | null = null
let wakeSurface: (() => void) | null = null
jest.mock("@cognia/plugin-sdk/api/effort-surface", () => {
  const actual = jest.requireActual("@cognia/plugin-sdk/api/effort-surface")
  return {
    effortSurfaceForSession: (session: unknown) =>
      surfaceOverride ?? actual.effortSurfaceForSession(session),
    subscribeEffortSurface: (_sessionId: unknown, listener: () => void) => {
      wakeSurface = listener
      return () => {
        wakeSurface = null
      }
    },
  }
})

import definition, { AnimeEffortControl } from "./index"

type Ctx = Parameters<NonNullable<typeof definition.activate>>[0]

/**
 * The slot hands every contribution its own `pluginId`, and the control needs
 * it: the panel portals out of the plugin root, so it has to re-stamp the CSS
 * scope attribute itself.
 */
const SLOT_PROPS = {
  pluginId: "cognia-anime-effort",
  extensionId: "cognia-anime-effort:chat.input.actions",
  formFactor: "row",
} as unknown as ExtensionProps

/**
 * The shape a real row has. The composer's model picker writes `model` and
 * `providerOverride`. `provider` is a plugin-compat shim nothing populates, and
 * a fixture that set it hid the fact that the control was reading the wrong
 * field entirely.
 */
const OPENAI_SURFACE = { model: "gpt-5", providerOverride: "openai" }

const updateSession = jest.fn(async () => undefined)
const showToast = jest.fn()
const logError = jest.fn()
let currentSession: Record<string, unknown> | null = {
  id: "s1",
  thinkingLevel: "medium",
  ...OPENAI_SURFACE,
}
let notifySessionChange: (() => void) | null = null

/**
 * Switch the active session the way the host does: the store row moves first,
 * then subscribers are told. `getCurrentSession` is the source of truth on both
 * sides, so a mock that only notified would not exercise the same path.
 */
function switchSession(next: Record<string, unknown> | null): void {
  currentSession = next
  notifySessionChange?.()
}

function context(): Ctx {
  return {
    session: {
      getCurrentSession: () => currentSession,
      onSessionChange: (handler: () => void) => {
        notifySessionChange = handler
        return () => {
          notifySessionChange = null
        }
      },
      updateSession,
    },
    i18n: {
      // Echo the key back, so an assertion names the key rather than a string
      // the manifest could quietly change.
      t: (key: string) => key,
      onLocaleChange: () => () => undefined,
    },
    ui: { showToast },
    logger: { error: logError, info: jest.fn() },
  } as unknown as Ctx
}

beforeEach(async () => {
  jest.clearAllMocks()
  surfaceOverride = null
  wakeSurface = null
  currentSession = { id: "s1", thinkingLevel: "medium", ...OPENAI_SURFACE }
  notifySessionChange = null
  await definition.activate?.(context())
})

afterEach(() => {
  definition.deactivate?.()
})

describe("AnimeEffortControl — the tier it writes", () => {
  it("writes both halves of the tier, from the host's own patch helper", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))
    await userEvent.click(screen.getByRole("radio", { name: /level\.high/ }))

    // `xhigh`/`high` rather than a hand-rolled pair: `effort` is what the SDK
    // receives, `thinkingLevel` is the tier identity it cannot express.
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s1", { effort: "high", thinkingLevel: "high" })
    )
  })

  it("sends no native effort for the standby tier", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))
    await userEvent.click(screen.getByRole("radio", { name: /level\.off/ }))

    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s1", { effort: undefined, thinkingLevel: "off" })
    )
  })

  it("maps the deepest tier onto the effort the SDK actually understands", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))
    await userEvent.click(screen.getByRole("radio", { name: /level\.ultracode/ }))

    // Ultracode's extra behaviour is the workflow-tool coupling, not a deeper
    // effort value, so it forwards `xhigh`.
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s1", {
        effort: "xhigh",
        thinkingLevel: "ultracode",
      })
    )
  })

  it("offers the tiers this session's surface can carry, plus the way back to default", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))

    // `off` heads the list and is not a depth; the rest are what the surface
    // publishes. Pinned rather than counted, so a narrowing regression names
    // the tier it lost.
    expect(screen.getAllByRole("radio").map((node) => node.getAttribute("data-level"))).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ])
  })

  it("does not offer a depth the session's model cannot carry", async () => {
    // A surface that folds everything above `high`. Offering Siege/Contingency
    // here would name a depth the request never sends.
    currentSession = {
      id: "s1",
      thinkingLevel: "low",
      providerOverride: "deepseek",
      model: "deepseek-reasoner",
    }
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))

    const offered = screen.getAllByRole("radio").map((node) => node.getAttribute("data-level"))
    expect(offered).not.toContain("max")
    expect(offered).not.toContain("ultracode")
  })

  it("folds a persisted tier the surface cannot honour down to the one it can", async () => {
    // The session keeps `max`; the dial must not advertise a depth this model
    // will drop. The stored choice is untouched and reapplies on a capable model.
    currentSession = {
      id: "s1",
      thinkingLevel: "max",
      providerOverride: "deepseek",
      model: "deepseek-reasoner",
    }
    render(<AnimeEffortControl {...SLOT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "control.aria" })).toHaveAttribute(
        "data-level",
        "high"
      )
    )
  })

  /**
   * The regression that made this control useless on every OpenAI-dialect
   * conversation: it read `session.provider`, which nothing populates, so the
   * protocol collapsed to anthropic, the anthropic family regexes missed
   * `gpt-5`, and the surface came back empty. The row below is the shape the
   * model picker actually writes.
   */
  it("reads the provider from the field the model picker actually writes", async () => {
    currentSession = {
      id: "s1",
      thinkingLevel: "medium",
      model: "gpt-5",
      providerOverride: "openai",
    }
    render(<AnimeEffortControl {...SLOT_PROPS} />)

    const trigger = screen.getByRole("button", { name: "control.aria" })
    expect(trigger).toBeEnabled()
    await userEvent.click(trigger)
    expect(screen.getAllByRole("radio").map((node) => node.getAttribute("data-level"))).toContain(
      "ultracode"
    )
  })

  /**
   * A model that does not reason at all has no depth to offer. Without the
   * host's capability gate the dial would list five tiers and write an effort
   * the model discards.
   */
  it("offers nothing on a model that does not reason", async () => {
    currentSession = {
      id: "s1",
      thinkingLevel: "medium",
      model: "deepseek-chat",
      providerOverride: "deepseek",
    }
    render(<AnimeEffortControl {...SLOT_PROPS} />)

    expect(screen.getByRole("button", { name: "control.unsupported" })).toBeDisabled()
  })

  it("scopes the portaled panel back into the plugin's own stylesheet root", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))

    // The panel portals to document.body, outside the slot wrapper that carries
    // the scope root, and the stylesheet is bound with `@scope`. Without this
    // attribute every rule below `.aef-panel` silently drops.
    const panel = document.querySelector(".aef-panel")
    expect(panel).toHaveAttribute("data-plugin-root", "cognia-anime-effort")
  })

  it("reads the session's tier, preferring the explicit level over the raw effort", async () => {
    // A row written before `thinkingLevel` existed carries only `effort`, and
    // must still render as its tier rather than falling back to standby.
    currentSession = { id: "s1", effort: "xhigh", ...OPENAI_SURFACE }
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "control.aria" })).toHaveAttribute(
        "data-level",
        "xhigh"
      )
    )
  })
})

describe("AnimeEffortControl — when the write fails", () => {
  it("says so instead of claiming the tier was set", async () => {
    // The host API awaits the Dexie write, so a rejection is the only signal
    // that the tier did not survive the reload. Reporting success here would
    // tell the user the opposite of what happened.
    updateSession.mockRejectedValueOnce(new Error("content cipher locked"))
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))
    await userEvent.click(screen.getByRole("radio", { name: /level\.high/ }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("panel.error", "error"))
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), "success")
    expect(logError).toHaveBeenCalled()
  })

  it("reports success only once the write has landed", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))
    await userEvent.click(screen.getByRole("radio", { name: /level\.high/ }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("panel.success", "success"))
  })
})

/**
 * Three of the four inputs to the offered ladder live in host stores, not on the
 * session row: the runtime lane, the app-level model/provider defaults behind an
 * unpinned session, and the hidden-tier preference. A control memoised on the
 * row alone therefore goes stale, and kept offering `xhigh`/`max`/`ultracode`
 * after the conversation moved to an external agent whose real ladder is
 * `low | medium | high`, writing a depth that agent folds away.
 */
describe("AnimeEffortControl — a ladder that changes underneath the row", () => {
  it("re-reads the surface when the host says the answer changed", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "control.aria" }))
    expect(screen.getAllByRole("radio").map((node) => node.getAttribute("data-level"))).toContain(
      "ultracode"
    )

    // The session row is deliberately untouched. Only the host's answer moved,
    // which is exactly what a lane change looks like from in here.
    const narrowed = ["low", "medium", "high"]
    surfaceOverride = { levels: narrowed, offered: narrowed, external: true }
    act(() => wakeSurface?.())

    await waitFor(() =>
      expect(screen.getAllByRole("radio").map((node) => node.getAttribute("data-level"))).toEqual([
        "off",
        "low",
        "medium",
        "high",
      ])
    )
  })

  it("releases the host subscription when the control unmounts", () => {
    const view = render(<AnimeEffortControl {...SLOT_PROPS} />)
    expect(wakeSurface).not.toBeNull()

    view.unmount()

    expect(wakeSurface).toBeNull()
  })
})

describe("AnimeEffortControl — a context that arrives late", () => {
  it("comes alive when the plugin activates after the control has mounted", async () => {
    definition.deactivate?.()
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    // No host context yet: the composer slot can mount this before the plugin
    // manager has run `activate`.
    expect(screen.getByRole("button", { name: "control.unavailable" })).toBeDisabled()

    await act(async () => {
      await definition.activate?.(context())
    })

    await waitFor(() => expect(screen.getByRole("button", { name: "control.aria" })).toBeEnabled())
  })

  it("goes inert again when the plugin deactivates under a mounted control", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "control.aria" })).toBeEnabled())

    act(() => definition.deactivate?.())

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "control.unavailable" })).toBeDisabled()
    )
  })

  it("follows the active session as the host switches it", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await waitFor(() => expect(notifySessionChange).not.toBeNull())

    act(() => switchSession({ id: "s2", thinkingLevel: "low", ...OPENAI_SURFACE }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "control.aria" })).toHaveAttribute(
        "data-level",
        "low"
      )
    )
  })
})
