/**
 * @jest-environment jsdom
 */
import { createRef } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("motion/react", () => jest.requireActual("../../__mocks__/motion-react.js"))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    number: (value: number, opts?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", opts).format(value),
  }),
}))

import { SelectionToolbarCapsule, type SelectionToolbarPhase } from "./selection-toolbar-capsule"
import { resolveVisibleActions } from "./selection-toolbar-actions"
import type { SelectionToolbarGeometryHandles } from "./use-selection-toolbar-geometry"

function makeGeometry(placement: "above" | "below" = "above"): SelectionToolbarGeometryHandles {
  return {
    shellRef: createRef<HTMLDivElement>(),
    capsuleRef: createRef<HTMLDivElement>(),
    panelRef: createRef<HTMLElement>(),
    ghostRef: createRef<HTMLDivElement>(),
    placement,
    measured: true,
    remeasure: jest.fn(),
  }
}

function renderCapsule(
  overrides: Partial<React.ComponentProps<typeof SelectionToolbarCapsule>> = {}
) {
  const props: React.ComponentProps<typeof SelectionToolbarCapsule> = {
    geometry: makeGeometry(),
    // The stable six — what a selection with no contextual match earns.
    actions: resolveVisibleActions({ types: [], candidate: {}, contextualEnabled: true }),
    phase: { kind: "idle" } as SelectionToolbarPhase,
    hovered: null,
    onHoverChange: jest.fn(),
    onAction: jest.fn(),
    onStopSpeech: jest.fn(),
    chords: {
      "selection.copy": "alt+shift+1",
      "selection.speak": "alt+shift+6",
    },
    isMac: true,
    targetLocale: "zh-CN",
    localeOpen: false,
    onLocaleOpenChange: jest.fn(),
    onLocaleSelect: jest.fn(),
    truncated: false,
    reduceMotion: false,
    ...overrides,
  }
  return { ...render(<SelectionToolbarCapsule {...props} />), props }
}

/** The live capsule, excluding the off-screen measuring ghost. */
function capsule() {
  return screen.getByTestId("selection-toolbar-capsule")
}

describe("SelectionToolbarCapsule", () => {
  it("renders all six actions as icon buttons named by their label", () => {
    renderCapsule()
    for (const name of ["copy", "explain", "translate", "ask", "remember", "speak"]) {
      expect(within(capsule()).getByRole("button", { name })).toBeInTheDocument()
    }
  })

  it("advertises the bound chord on the button for assistive tech", () => {
    renderCapsule()
    expect(within(capsule()).getByRole("button", { name: "copy" })).toHaveAttribute(
      "aria-keyshortcuts",
      "alt+shift+1"
    )
  })

  it("shows the label and chord only for the hovered action", () => {
    const { rerender, props } = renderCapsule()
    // Collapsed: the ghost holds the text, the live capsule does not.
    expect(within(capsule()).queryByText("⌥⇧1")).not.toBeInTheDocument()

    rerender(<SelectionToolbarCapsule {...props} hovered="copy" />)
    expect(within(capsule()).getByText("⌥⇧1")).toBeInTheDocument()
  })

  it("reports pointer enter and leave so the idle countdown can be frozen", () => {
    const onHoverChange = jest.fn()
    renderCapsule({ onHoverChange })
    const button = within(capsule()).getByRole("button", { name: "remember" })
    fireEvent.pointerEnter(button.parentElement!)
    expect(onHoverChange).toHaveBeenCalledWith("remember")
    fireEvent.pointerLeave(button.parentElement!)
    expect(onHoverChange).toHaveBeenCalledWith(null)
  })

  it("dispatches the clicked action", () => {
    const onAction = jest.fn()
    renderCapsule({ onAction })
    fireEvent.click(within(capsule()).getByRole("button", { name: "speak" }))
    expect(onAction).toHaveBeenCalledWith("speak")
  })

  it("disables every button while an action is pending, so it cannot be double-fired", () => {
    renderCapsule({ phase: { kind: "pending", action: "remember" } })
    for (const name of ["copy", "remember", "speak"]) {
      expect(within(capsule()).getByRole("button", { name })).toBeDisabled()
    }
  })

  it("swaps the acting icon for a checkmark on success", () => {
    const { container } = renderCapsule({ phase: { kind: "ok", action: "copy" } })
    // lucide renders its name onto the svg class list.
    expect(container.querySelector(".lucide-check")).toBeInTheDocument()
  })

  it("replaces the action row with an alert when the write was refused", () => {
    renderCapsule({
      phase: { kind: "error", action: "remember", reason: "含敏感信息，未存入记忆" },
    })
    expect(screen.getByRole("alert")).toHaveTextContent("含敏感信息，未存入记忆")
    expect(within(capsule()).queryByRole("button", { name: "copy" })).not.toBeInTheDocument()
  })

  it("morphs into a transport while speaking and can stop it", () => {
    const onStopSpeech = jest.fn()
    renderCapsule({ phase: { kind: "speaking", progress: 0.42 }, onStopSpeech })
    expect(within(capsule()).queryByRole("button", { name: "copy" })).not.toBeInTheDocument()
    const stop = within(capsule()).getByRole("button", { name: "stopSpeaking" })
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42")
    fireEvent.click(stop)
    expect(onStopSpeech).toHaveBeenCalledTimes(1)
  })

  it("omits the percentage when the provider reports no duration", () => {
    renderCapsule({ phase: { kind: "speaking" } })
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
  })

  it("marks truncated selections with a theme token rather than a hard-coded colour", () => {
    renderCapsule({ truncated: true })
    const badge = within(capsule()).getByText("truncated")
    expect(badge).toHaveClass("text-warning")
  })

  it("opens the locale list only on request and marks the current target", () => {
    const { rerender, props } = renderCapsule()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()

    rerender(<SelectionToolbarCapsule {...props} localeOpen />)
    const options = within(screen.getByRole("listbox")).getAllByRole("option")
    expect(options).toHaveLength(7)
    expect(screen.getByRole("option", { name: /zh-CN/ })).toHaveAttribute("aria-selected", "true")
  })

  it("selects a locale from the list", () => {
    const onLocaleSelect = jest.fn()
    renderCapsule({ localeOpen: true, onLocaleSelect })
    fireEvent.click(screen.getByRole("option", { name: /languages.ja/ }))
    expect(onLocaleSelect).toHaveBeenCalledWith("ja")
  })

  it("toggles the locale list from the chevron next to translate", () => {
    const onLocaleOpenChange = jest.fn()
    renderCapsule({ onLocaleOpenChange })
    fireEvent.click(within(capsule()).getByRole("button", { name: "chooseLanguage" }))
    expect(onLocaleOpenChange).toHaveBeenCalledWith(true)
  })

  it("grows the animation out of the selection, flipping origin with the placement", () => {
    const { rerender, props } = renderCapsule()
    expect(capsule()).toHaveStyle({ transformOrigin: "bottom center" })
    expect(capsule()).toHaveAttribute("data-placement", "above")

    rerender(<SelectionToolbarCapsule {...props} geometry={makeGeometry("below")} />)
    expect(capsule()).toHaveStyle({ transformOrigin: "top center" })
  })

  it("renders one measuring ghost row per action, so every hover width is covered", () => {
    const { container } = renderCapsule()
    const ghost = container.querySelector("[aria-hidden]")
    expect(ghost?.children).toHaveLength(6)
  })

  it("falls back to the collapsed row when no chord is bound", () => {
    renderCapsule({ chords: {}, hovered: "copy" })
    expect(within(capsule()).getByRole("button", { name: "copy" })).not.toHaveAttribute(
      "aria-keyshortcuts"
    )
    expect(within(capsule()).queryByText("⌥⇧1")).not.toBeInTheDocument()
  })

  it("writes chords in platform style off macOS", () => {
    renderCapsule({ isMac: false, hovered: "copy" })
    expect(within(capsule()).getByText("Alt+Shift+1")).toBeInTheDocument()
  })
})

/**
 * The language list replaced a Radix DropdownMenu, which gave roving focus,
 * arrow keys and Escape for free. Rust focuses the window while the list is
 * open, so the keyboard genuinely reaches it — these pin the behaviour that
 * would otherwise have been silently dropped.
 */
describe("SelectionToolbarCapsule language list keyboard access", () => {
  const options = () => within(screen.getByRole("listbox")).getAllByRole("option")

  it("lands focus on the current target when it opens", () => {
    renderCapsule({ localeOpen: true, targetLocale: "ja" })
    expect(screen.getByRole("option", { name: /languages.ja/ })).toHaveFocus()
  })

  it("moves down and up with the arrow keys", () => {
    renderCapsule({ localeOpen: true, targetLocale: "zh-CN" })
    const list = screen.getByRole("listbox")
    expect(options()[0]).toHaveFocus()

    fireEvent.keyDown(list, { key: "ArrowDown" })
    expect(options()[1]).toHaveFocus()
    fireEvent.keyDown(list, { key: "ArrowUp" })
    expect(options()[0]).toHaveFocus()
  })

  it("wraps around at both ends", () => {
    renderCapsule({ localeOpen: true, targetLocale: "zh-CN" })
    const list = screen.getByRole("listbox")
    fireEvent.keyDown(list, { key: "ArrowUp" })
    expect(options()[options().length - 1]).toHaveFocus()
    fireEvent.keyDown(list, { key: "ArrowDown" })
    expect(options()[0]).toHaveFocus()
  })

  it("jumps to the ends with Home and End", () => {
    renderCapsule({ localeOpen: true, targetLocale: "ja" })
    const list = screen.getByRole("listbox")
    fireEvent.keyDown(list, { key: "End" })
    expect(options()[options().length - 1]).toHaveFocus()
    fireEvent.keyDown(list, { key: "Home" })
    expect(options()[0]).toHaveFocus()
  })

  it("closes on Escape without dismissing the whole toolbar", () => {
    const onLocaleOpenChange = jest.fn()
    renderCapsule({ localeOpen: true, onLocaleOpenChange })
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
    expect(onLocaleOpenChange).toHaveBeenCalledWith(false)
  })

  it("leaves other keys to the browser", () => {
    const onLocaleOpenChange = jest.fn()
    renderCapsule({ localeOpen: true, onLocaleOpenChange })
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "a" })
    expect(onLocaleOpenChange).not.toHaveBeenCalled()
    expect(options()[0]).toHaveFocus()
  })

  it("exposes one tab stop for the whole list", () => {
    renderCapsule({ localeOpen: true, targetLocale: "ja" })
    const tabbable = options().filter((option) => option.getAttribute("tabindex") === "0")
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toHaveAccessibleName(expect.stringContaining("languages.ja"))
  })
})

/**
 * Every animated prop in this file is a `reduceMotion ? … : …` ternary, so the
 * accessibility path is a second full rendering of the component — not a detail
 * worth trusting to inspection.
 */
describe("SelectionToolbarCapsule under reduced motion", () => {
  const reduced = { reduceMotion: true } as const

  it("still renders every action", () => {
    renderCapsule(reduced)
    for (const name of ["copy", "explain", "translate", "ask", "remember", "speak"]) {
      expect(within(capsule()).getByRole("button", { name })).toBeInTheDocument()
    }
  })

  it("still expands the hovered label", () => {
    renderCapsule({ ...reduced, hovered: "copy" })
    expect(within(capsule()).getByText("copy")).toBeInTheDocument()
  })

  it("still shows the success checkmark", () => {
    const { container } = renderCapsule({ ...reduced, phase: { kind: "ok", action: "copy" } })
    expect(container.querySelector(".lucide-check")).toBeInTheDocument()
  })

  it("still surfaces the error alert", () => {
    renderCapsule({ ...reduced, phase: { kind: "error", action: "remember", reason: "nope" } })
    expect(screen.getByRole("alert")).toHaveTextContent("nope")
  })

  it("still renders the transport, with static bars instead of a loop", () => {
    renderCapsule({ ...reduced, phase: { kind: "speaking", progress: 0.1 } })
    expect(within(capsule()).getByRole("button", { name: "stopSpeaking" })).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "10")
  })

  it("still opens the locale list", () => {
    renderCapsule({ ...reduced, localeOpen: true })
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(7)
  })

  it("still flips the transform origin with the placement", () => {
    renderCapsule({ ...reduced, geometry: makeGeometry("below") })
    expect(capsule()).toHaveStyle({ transformOrigin: "top center" })
  })
})
