import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { layoutFromPreset } from "@/lib/glance/presets"
import type { GlanceLayoutEntry, GlanceModuleId } from "@/types/glance/layout"

import { GlanceLayoutEditor } from "./glance-layout-editor"

// balanced: fleet, usage, quota, agenda, activity, quick shown; recents, pet hidden.
const ENTRIES = layoutFromPreset("balanced")
const ALL: readonly GlanceModuleId[] = [
  "fleet",
  "usage",
  "quota",
  "agenda",
  "activity",
  "quick",
  "recents",
  "pet",
]
const NO_QUICK = ALL.filter((id) => id !== "quick")

const ROW_HEIGHT = 40

function renderEditor(
  props: Partial<React.ComponentProps<typeof GlanceLayoutEditor>> & {
    entries?: readonly GlanceLayoutEntry[]
  } = {}
) {
  const onChange = jest.fn()
  const view = render(
    <GlanceLayoutEditor entries={ENTRIES} available={ALL} onChange={onChange} {...props} />
  )
  return { onChange, ...view }
}

function row(id: GlanceModuleId) {
  return screen.getByTestId(`glance-editor-row-${id}`)
}

function shownIds() {
  return screen
    .getAllByTestId(/^glance-editor-row-/)
    .map((el) => el.getAttribute("data-testid")?.replace("glance-editor-row-", ""))
}

describe("GlanceLayoutEditor", () => {
  it("lists the shown modules in order, each with a reorder grip", () => {
    renderEditor()
    expect(shownIds()).toEqual(["fleet", "usage", "quota", "agenda", "activity", "quick"])
    expect(screen.getByRole("button", { name: "Reorder Running" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reorder Usage" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reorder Quick actions" })).toBeInTheDocument()
  })

  it("lists hidden modules under Add modules, not among the shown ones", () => {
    renderEditor()
    expect(screen.getByRole("heading", { name: "Shown" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Add modules" })).toBeInTheDocument()
    expect(screen.getByTestId("glance-editor-hidden-recents")).toBeInTheDocument()
    expect(screen.getByTestId("glance-editor-hidden-pet")).toBeInTheDocument()
    expect(screen.queryByTestId("glance-editor-row-recents")).not.toBeInTheDocument()
    expect(screen.queryByTestId("glance-editor-hidden-fleet")).not.toBeInTheDocument()
  })

  describe("sizes", () => {
    it("shows a size toggle for modules with several sizes, with the current one pressed", () => {
      renderEditor()
      const group = within(row("fleet")).getByRole("radiogroup", { name: "Size of Running" })
      expect(within(group).getByRole("radio", { name: "Standard" })).toBeChecked()
      expect(within(group).getByRole("radio", { name: "Compact" })).not.toBeChecked()
      expect(within(group).getByRole("radio", { name: "Expanded" })).not.toBeChecked()
      // The modules with three sizes offer all three; agenda only two.
      const agenda = within(row("agenda")).getByRole("radiogroup", {
        name: "Size of Schedule · notifications · connection",
      })
      expect(within(agenda).getAllByRole("radio")).toHaveLength(2)
      expect(within(agenda).getByRole("radio", { name: "Compact" })).toBeChecked()
    })

    it("resizes the entry when another size is picked", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      await user.click(within(row("fleet")).getByRole("radio", { name: "Expanded" }))
      expect(onChange).toHaveBeenCalledTimes(1)
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      expect(next.find((e) => e.id === "fleet")).toEqual({
        id: "fleet",
        size: "expanded",
        hidden: false,
      })
      // Nothing else moved.
      expect(next.map((e) => e.id)).toEqual(ENTRIES.map((e) => e.id))
      expect(next.find((e) => e.id === "usage")).toEqual(ENTRIES.find((e) => e.id === "usage"))
    })

    it("does nothing when the pressed size is pressed again", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      await user.click(within(row("fleet")).getByRole("radio", { name: "Standard" }))
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  describe("hide and add", () => {
    it("hides a module", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      await user.click(screen.getByRole("button", { name: "Hide Usage" }))
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      expect(next.find((e) => e.id === "usage")?.hidden).toBe(true)
      expect(next.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
        "fleet",
        "quota",
        "agenda",
        "activity",
        "quick",
      ])
    })

    it("adds a hidden module at the end of the shown ones", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      await user.click(screen.getByRole("button", { name: "Add Recent" }))
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      expect(next.find((e) => e.id === "recents")?.hidden).toBe(false)
      expect(next.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
        "fleet",
        "usage",
        "quota",
        "agenda",
        "activity",
        "quick",
        "recents",
      ])
    })

    it("neither lists nor offers a module that is not available", () => {
      // A hidden-but-unavailable module (quick hidden, surface lacks it)...
      const entries = ENTRIES.map((e) => (e.id === "quick" ? { ...e, hidden: true } : e))
      renderEditor({ entries, available: NO_QUICK })
      expect(screen.queryByTestId("glance-editor-hidden-quick")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Add Quick actions" })).not.toBeInTheDocument()
      // ...and a shown-but-unavailable one is not listed as a row either.
      expect(screen.queryByTestId("glance-editor-row-quick")).not.toBeInTheDocument()
      renderEditor({ available: NO_QUICK })
      expect(screen.queryByTestId("glance-editor-row-quick")).not.toBeInTheDocument()
    })
  })

  describe("empty states", () => {
    it("says so when nothing is shown", () => {
      const entries = ENTRIES.map((e) => ({ ...e, hidden: true }))
      renderEditor({ entries })
      expect(screen.getByText("Nothing is shown — add a module below.")).toBeInTheDocument()
      expect(screen.queryByTestId(/^glance-editor-row-/)).not.toBeInTheDocument()
      expect(screen.getAllByRole("button", { name: /^Add / })).toHaveLength(ALL.length)
    })

    it("says so when every module is shown", () => {
      const entries = ENTRIES.map((e) => ({ ...e, hidden: false }))
      renderEditor({ entries })
      expect(screen.getByText("Every module is shown.")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument()
    })

    it("treats a list of only unavailable modules as empty", () => {
      renderEditor({ available: [] })
      expect(screen.getByText("Nothing is shown — add a module below.")).toBeInTheDocument()
      expect(screen.getByText("Every module is shown.")).toBeInTheDocument()
    })
  })

  describe("density", () => {
    it("uses the full size names when comfortable", () => {
      renderEditor({ density: "comfortable" })
      const group = within(row("fleet")).getByRole("radiogroup", { name: "Size of Running" })
      expect(group).toHaveTextContent("CompactStandardExpanded")
    })

    it("uses short size labels when compact, keeping the full names as aria-labels", () => {
      renderEditor({ density: "compact" })
      const group = within(row("fleet")).getByRole("radiogroup", { name: "Size of Running" })
      expect(group).toHaveTextContent("SML")
      expect(within(group).getByRole("radio", { name: "Compact" })).toHaveTextContent("S")
      expect(within(group).getByRole("radio", { name: "Standard" })).toHaveTextContent("M")
      expect(within(group).getByRole("radio", { name: "Expanded" })).toHaveTextContent("L")
    })
  })

  it("gives two editors on one page distinct heading ids", () => {
    render(
      <>
        <GlanceLayoutEditor entries={ENTRIES} available={ALL} onChange={jest.fn()} />
        <GlanceLayoutEditor entries={ENTRIES} available={ALL} onChange={jest.fn()} />
      </>
    )
    const ids = screen.getAllByRole("heading", { name: "Shown" }).map((h) => h.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    const addIds = screen.getAllByRole("heading", { name: "Add modules" }).map((h) => h.id)
    expect(new Set([...ids, ...addIds]).size).toBe(4)
    // Each section is labelled by its own heading.
    for (const section of screen.getAllByRole("region")) {
      const labelledBy = section.getAttribute("aria-labelledby")
      expect(document.getElementById(labelledBy as string)).not.toBeNull()
    }
  })

  describe("keyboard reorder", () => {
    // jsdom has no layout: dnd-kit measures rows with getBoundingClientRect and
    // sortableKeyboardCoordinates picks the neighbour by position. Lay the rows
    // out as a 40px-tall column so "ArrowDown" lands on the next row.
    let rectSpy: jest.SpyInstance

    beforeEach(() => {
      rectSpy = jest
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const id = this.getAttribute("data-testid") ?? ""
          let top = 0
          if (id.startsWith("glance-editor-row-")) {
            const siblings = Array.from(this.parentElement?.children ?? [])
            top = siblings.indexOf(this) * ROW_HEIGHT
          }
          return {
            x: 0,
            y: top,
            top,
            left: 0,
            right: 300,
            bottom: top + ROW_HEIGHT,
            width: 300,
            height: ROW_HEIGHT,
            toJSON: () => ({}),
          }
        })
    })

    afterEach(() => rectSpy.mockRestore())

    it("moves a module down with Space, ArrowDown, Space on its grip", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      screen.getByRole("button", { name: "Reorder Running" }).focus()
      await user.keyboard(" ")
      await user.keyboard("{ArrowDown}")
      await user.keyboard(" ")
      expect(onChange).toHaveBeenCalledTimes(1)
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      expect(next.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
        "usage",
        "fleet",
        "quota",
        "agenda",
        "activity",
        "quick",
      ])
      // Hidden modules stay after the shown ones.
      expect(next.slice(-2).map((e) => e.id)).toEqual(["recents", "pet"])
    })

    it("moves a module up with ArrowUp", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      screen.getByRole("button", { name: "Reorder Usage" }).focus()
      await user.keyboard(" ")
      await user.keyboard("{ArrowUp}")
      await user.keyboard(" ")
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      expect(next.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
        "usage",
        "fleet",
        "quota",
        "agenda",
        "activity",
        "quick",
      ])
    })

    it("changes nothing when the pick-up is cancelled with Escape", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      screen.getByRole("button", { name: "Reorder Running" }).focus()
      await user.keyboard(" ")
      await user.keyboard("{ArrowDown}")
      await user.keyboard("{Escape}")
      expect(onChange).not.toHaveBeenCalled()
    })

    it("changes nothing when dropped where it started", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor()
      screen.getByRole("button", { name: "Reorder Running" }).focus()
      await user.keyboard(" ")
      await user.keyboard(" ")
      expect(onChange).not.toHaveBeenCalled()
    })
  })
})
