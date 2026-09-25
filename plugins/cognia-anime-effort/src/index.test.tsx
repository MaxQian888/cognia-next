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
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

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

import definition, { AnimeEffortControl, ANIME_EFFORT_CSS, manifest } from "./index"
import manifestJson from "../plugin.json"

type Ctx = Parameters<typeof definition.activate>[0]

/**
 * Strings are the plugin's own English bundle. No host bundle is registered in
 * this harness, so every label below also proves the control never falls back
 * to a raw `level.high.name`-style key.
 */
const TRIGGER = { name: /^Mind intensity: / }
const UNAVAILABLE = "Open a conversation to adjust its mind intensity"

/**
 * The slot hands every contribution its own `pluginId`, and the control needs
 * it: the panel portals out of the plugin root, so it has to re-stamp the CSS
 * scope attribute itself.
 */
const SLOT_PROPS = {
  pluginId: "cognia-anime-effort",
  extensionId: "cognia-anime-effort:chat.input.effort",
  formFactor: "row",
} as unknown as ExtensionProps

/**
 * The shape a real row has. The composer's model picker writes `model` and
 * `providerOverride`. `provider` is a plugin-compat shim nothing populates, and
 * a fixture that set it hid the fact that the control was reading the wrong
 * field entirely.
 */
const OPENAI_SURFACE = { model: "gpt-5", providerOverride: "openai" }

const updateSession = jest.fn(async (_id: string, _patch: Record<string, unknown>) => undefined)
const showToast = jest.fn()
const logError = jest.fn()
let currentSession: Record<string, unknown> | null = {
  id: "s1",
  thinkingLevel: "medium",
  ...OPENAI_SURFACE,
}
let notifySessionChange: (() => void) | null = null
/** Rows reachable only by id — a composer that is not the focused session. */
const otherSessions: Record<string, Record<string, unknown>> = {}

/**
 * Switch the active session the way the host does: the store row moves first,
 * then subscribers are told. `getCurrentSession` is the source of truth on both
 * sides, so a mock that only notified would not exercise the same path.
 */
function switchSession(next: Record<string, unknown> | null): void {
  currentSession = next
  notifySessionChange?.()
}

/**
 * A fully mounted context (every namespace present, like the host's), with the
 * three members these tests steer. The control's strings deliberately do not
 * come from `ctx.i18n`: it can render before any context is published.
 */
function context(): Ctx {
  return createTestPluginContext({
    pluginId: manifestJson.id,
    overrides: {
      session: {
        getCurrentSession: () => currentSession,
        onSessionChange: (handler: () => void) => {
          notifySessionChange = handler
          return () => {
            notifySessionChange = null
          }
        },
        updateSession,
        getSession: async (id: string) => otherSessions[id] ?? null,
      },
      ui: { showToast },
      logger: { error: logError },
    },
  }).ctx
}

/** The context `activate` last received — `deactivate` gets the same one. */
let activeCtx: Ctx

beforeEach(async () => {
  jest.clearAllMocks()
  // `clearAllMocks` keeps implementations; a test that persists writes must not
  // leak that into the next one.
  updateSession.mockImplementation(async () => undefined)
  surfaceOverride = null
  wakeSurface = null
  currentSession = { id: "s1", thinkingLevel: "medium", ...OPENAI_SURFACE }
  notifySessionChange = null
  activeCtx = context()
  await definition.activate(activeCtx)
})

afterEach(() => {
  definition.deactivate?.(activeCtx)
})

describe("AnimeEffortControl — the tier it writes", () => {
  it("writes both halves of the tier, from the host's own patch helper", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))
    await userEvent.click(screen.getByRole("radio", { name: /Assault/ }))

    // `xhigh`/`high` rather than a hand-rolled pair: `effort` is what the SDK
    // receives, `thinkingLevel` is the tier identity it cannot express.
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s1", { effort: "high", thinkingLevel: "high" })
    )
  })

  it("sends no native effort for the standby tier", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))
    await userEvent.click(screen.getByRole("radio", { name: /Standby/ }))

    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s1", { effort: undefined, thinkingLevel: "off" })
    )
  })

  it("maps the deepest tier onto the effort the SDK actually understands", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))
    await userEvent.click(screen.getByRole("radio", { name: /Singularity/ }))

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
    await userEvent.click(screen.getByRole("button", TRIGGER))

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
    await userEvent.click(screen.getByRole("button", TRIGGER))

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
      expect(screen.getByRole("button", TRIGGER)).toHaveAttribute("data-level", "high")
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

    const trigger = screen.getByRole("button", TRIGGER)
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

    expect(
      screen.getByRole("button", { name: "This model has no reasoning-depth control" })
    ).toBeDisabled()
  })

  it("scopes the portaled panel back into the plugin's own stylesheet root", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))

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
      expect(screen.getByRole("button", TRIGGER)).toHaveAttribute("data-level", "xhigh")
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
    await userEvent.click(screen.getByRole("button", TRIGGER))
    await userEvent.click(screen.getByRole("radio", { name: /Assault/ }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Could not update the current conversation.", "error")
    )
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), "success")
    expect(logError).toHaveBeenCalled()
  })

  it("reports success only once the write has landed", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))
    await userEvent.click(screen.getByRole("radio", { name: /Assault/ }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Mind intensity set to Assault.", "success")
    )
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
    await userEvent.click(screen.getByRole("button", TRIGGER))
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
    definition.deactivate?.(activeCtx)
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    // No host context yet: the composer slot can mount this before the plugin
    // manager has run `activate`. The label is still words, not a raw key.
    expect(screen.getByRole("button", { name: UNAVAILABLE })).toBeDisabled()

    activeCtx = context()
    await act(async () => {
      await definition.activate(activeCtx)
    })

    await waitFor(() => expect(screen.getByRole("button", TRIGGER)).toBeEnabled())
  })

  it("goes inert again when the plugin deactivates under a mounted control", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await waitFor(() => expect(screen.getByRole("button", TRIGGER)).toBeEnabled())

    act(() => definition.deactivate?.(activeCtx))

    await waitFor(() => expect(screen.getByRole("button", { name: UNAVAILABLE })).toBeDisabled())
  })

  it("follows the active session as the host switches it", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await waitFor(() => expect(notifySessionChange).not.toBeNull())

    act(() => switchSession({ id: "s2", thinkingLevel: "low", ...OPENAI_SURFACE }))

    await waitFor(() =>
      expect(screen.getByRole("button", TRIGGER)).toHaveAttribute("data-level", "low")
    )
  })
})

describe("AnimeEffortControl — the box it is handed", () => {
  it("fills the granted surface and lets the label ellipsize under it", () => {
    // The host's surface is a fixed-width box (the manifest's declared band),
    // not a measurement — a content-sized trigger paints past its edge over
    // the next toolbar control, and a label without `min-width: 0` holds the
    // trigger open before it can reach the ellipsis. Both regressions have
    // shipped; pin the contract.
    expect(ANIME_EFFORT_CSS).toMatch(/\.aef-trigger\s*\{[^}]*\bwidth:\s*100%/)
    expect(ANIME_EFFORT_CSS).toMatch(/\.aef-trigger\s*\{[^}]*\bmin-width:\s*0/)
    expect(ANIME_EFFORT_CSS).toMatch(/\.aef-trigger-value\s*\{[^}]*\bmin-width:\s*0/)
  })
})

describe("AnimeEffortControl — keyboard", () => {
  it("is one tab stop, and the arrow keys move the checked tier", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))

    // Roving tabindex: only the checked tier is in the tab order.
    const tabbable = screen.getAllByRole("radio").filter((node) => node.tabIndex === 0)
    expect(tabbable.map((node) => node.getAttribute("data-level"))).toEqual(["medium"])

    screen.getByRole("radio", { name: /Patrol/ }).focus()
    await userEvent.keyboard("{ArrowDown}")

    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("s1", { effort: "high", thinkingLevel: "high" })
    )
    expect(screen.getByRole("radio", { name: /Assault/ })).toHaveFocus()
  })

  it("wraps with Up from the first tier and jumps with Home / End", async () => {
    currentSession = { id: "s1", thinkingLevel: "off", ...OPENAI_SURFACE }
    // Persist like the host does, so the next key starts from the new tier.
    updateSession.mockImplementation(async (_id, patch) => {
      switchSession({ ...currentSession, ...patch })
      return undefined
    })
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))

    screen.getByRole("radio", { name: /Standby/ }).focus()
    await userEvent.keyboard("{ArrowUp}")
    await waitFor(() =>
      expect(updateSession).toHaveBeenLastCalledWith("s1", {
        effort: "xhigh",
        thinkingLevel: "ultracode",
      })
    )
    expect(screen.getByRole("radio", { name: /Singularity/ })).toHaveFocus()

    await waitFor(() =>
      expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-busy", "false")
    )
    await userEvent.keyboard("{Home}")
    await waitFor(() =>
      expect(updateSession).toHaveBeenLastCalledWith("s1", {
        effort: undefined,
        thinkingLevel: "off",
      })
    )
    expect(screen.getByRole("radio", { name: /Standby/ })).toHaveFocus()
  })

  it("keeps focus and ignores further arrows while a write is in flight", async () => {
    let finish: () => void = () => undefined
    updateSession.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
        })
    )
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))

    screen.getByRole("radio", { name: /Patrol/ }).focus()
    await userEvent.keyboard("{ArrowDown}")
    const syncing = screen.getByRole("radio", { name: /Assault/ })

    // `aria-disabled`, not `disabled`: a disabled button would drop focus.
    await waitFor(() => expect(syncing).toHaveAttribute("aria-disabled", "true"))
    expect(syncing).toHaveFocus()
    expect(syncing.querySelector(".aef-state")).toHaveAttribute("data-syncing", "true")

    await userEvent.keyboard("{ArrowDown}")
    expect(updateSession).toHaveBeenCalledTimes(1)
    expect(syncing).toHaveFocus()

    await act(async () => finish())
    await waitFor(() => expect(syncing).not.toHaveAttribute("aria-disabled"))
    expect(syncing.querySelector(".aef-state")).toHaveAttribute("data-syncing", "false")
  })
})

describe("AnimeEffortControl — strings", () => {
  afterEach(() => {
    unregisterPluginI18n(manifestJson.id)
  })

  it("reads the host's registered bundle ahead of its own English fallback", async () => {
    registerPluginI18n({
      pluginId: manifestJson.id,
      messages: {
        en: {
          [`plugin.${manifestJson.id}.control.aria`]: "Dial set to {level}",
          [`plugin.${manifestJson.id}.level.medium.name`]: "Cruise",
        },
      },
    })
    render(<AnimeEffortControl {...SLOT_PROPS} />)

    expect(screen.getByRole("button", { name: "Dial set to Cruise" })).toBeEnabled()
  })

  it("never renders a raw message key", async () => {
    render(<AnimeEffortControl {...SLOT_PROPS} />)
    await userEvent.click(screen.getByRole("button", TRIGGER))

    expect(document.body.textContent).not.toMatch(/\b(?:level|panel|control)\.[a-z]+/)
  })
})

describe("AnimeEffortControl — stylesheet", () => {
  /** Every declaration inside one `@media (<query>) { … }` block. */
  function mediaBlock(query: string): string {
    const start = ANIME_EFFORT_CSS.indexOf(`@media (${query})`)
    if (start < 0) return ""
    let depth = 0
    for (let i = ANIME_EFFORT_CSS.indexOf("{", start); i < ANIME_EFFORT_CSS.length; i++) {
      if (ANIME_EFFORT_CSS[i] === "{") depth++
      if (ANIME_EFFORT_CSS[i] === "}" && --depth === 0) return ANIME_EFFORT_CSS.slice(start, i + 1)
    }
    return ""
  }

  it("sets no text below 11px", () => {
    const sizes = [
      ...ANIME_EFFORT_CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g),
      ...ANIME_EFFORT_CSS.matchAll(/font:\s*\d+\s+(\d+(?:\.\d+)?)px/g),
    ].map((match) => Number(match[1]))
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11)
  })

  it("scrolls the tier list inside a panel bounded by the space it has", () => {
    expect(ANIME_EFFORT_CSS).toMatch(
      /\.aef-panel\s*\{[^}]*max-height:[^;]*--radix-popover-content-available-height/
    )
    expect(ANIME_EFFORT_CSS).toMatch(/\.aef-levels\s*\{[^}]*overflow-y:\s*auto/)
    expect(ANIME_EFFORT_CSS).toMatch(/\.aef-levels\s*\{[^}]*min-height:\s*0/)
  })

  it("styles hover only where a pointer can hover", () => {
    const outside = ANIME_EFFORT_CSS.replace(mediaBlock("hover: hover"), "")
    expect(mediaBlock("hover: hover")).toContain(":hover")
    expect(outside).not.toContain(":hover")
  })

  it("animates only a write in flight, and never under reduced motion", () => {
    const motion = mediaBlock("prefers-reduced-motion: no-preference")
    expect(motion).toMatch(/\.aef-state\[data-syncing="true"\]\s*\{[^}]*animation:/)
    const outside = ANIME_EFFORT_CSS.replace(motion, "")
    expect(outside).not.toMatch(/\banimation:/)
  })
})

describe("cognia-anime-effort manifest", () => {
  it("is plugin.json itself, opt-in, and blocked where no composer exists", () => {
    expect(manifest).toBe(manifestJson)
    expect(definition.manifest).toBe(manifest)
    // Replacing the host's effort chip is a choice the user makes.
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifestJson.runtimeCompatibility.headless.availability).toBe("blocked")
    expect(validatePluginManifest(manifest).errors).toEqual([])
  })
})

describe("AnimeEffortControl — the slot context the composer passes", () => {
  it("goes inert while a reply streams, like the host chip it replaces", () => {
    render(
      <AnimeEffortControl
        {...SLOT_PROPS}
        context={{ sessionId: "s1", disabled: true, compact: false }}
      />
    )
    expect(screen.getByRole("button", TRIGGER)).toBeDisabled()
  })

  it("folds to a glyph with the toolbar, keeping the tier in its accessible name", () => {
    render(
      <AnimeEffortControl
        {...SLOT_PROPS}
        context={{ sessionId: "s1", disabled: false, compact: true }}
      />
    )
    const trigger = screen.getByRole("button", TRIGGER)
    expect(trigger).toHaveAttribute("data-compact", "true")
    expect(trigger).toHaveAccessibleName(/Mind intensity: /)
    expect(trigger.querySelector(".aef-trigger-value")).toBeNull()
  })

  it("writes to the composer's own session, not whichever one has focus", async () => {
    otherSessions.s2 = { id: "s2", thinkingLevel: "low", ...OPENAI_SURFACE }
    try {
      render(
        <AnimeEffortControl
          {...SLOT_PROPS}
          context={{ sessionId: "s2", disabled: false, compact: false }}
        />
      )
      await userEvent.click(await screen.findByRole("button", TRIGGER))
      await userEvent.click(screen.getByRole("radio", { name: /Assault/ }))
      await waitFor(() =>
        expect(updateSession).toHaveBeenCalledWith("s2", { effort: "high", thinkingLevel: "high" })
      )
      expect(updateSession).not.toHaveBeenCalledWith("s1", expect.anything())
    } finally {
      delete otherSessions.s2
    }
  })
})
