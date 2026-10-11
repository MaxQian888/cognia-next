import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { mobileLayoutFromPreset } from "@/lib/glance/mobile-layout"
import { layoutFromPreset } from "@/lib/glance/presets"
import type {
  GlanceEntryId,
  GlanceLayoutEntry,
  GlanceMobileEntry,
  GlanceModuleId,
} from "@/types/glance/layout"

import type { GlancePluginCatalogEntry } from "@/lib/glance/snapshot"

import { defaultPluginSize, GlanceLayoutEditor } from "./glance-layout-editor"

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

function row(id: string) {
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

  describe("touch density (phone)", () => {
    it("uses short size labels and 44px-class targets", () => {
      renderEditor({ density: "touch" })
      const group = within(row("fleet")).getByRole("radiogroup", { name: "Size of Running" })
      expect(group).toHaveTextContent("SML")
      const standard = within(group).getByRole("radio", { name: "Standard" })
      expect(standard).toHaveTextContent("M")
      expect(standard).toHaveClass("h-9", "min-w-9")
      expect(screen.getByRole("button", { name: "Reorder Running" })).toHaveClass("size-10")
      expect(screen.getByRole("button", { name: "Hide Running" })).toHaveClass("size-10")
      expect(screen.getByRole("button", { name: "Add Recent" })).toHaveClass("h-10")
    })

    it("keeps the small targets at the compact density", () => {
      renderEditor({ density: "compact" })
      expect(screen.getByRole("button", { name: "Reorder Running" })).toHaveClass("size-6")
      expect(screen.getByRole("button", { name: "Add Recent" })).toHaveClass("h-6")
    })
  })

  describe("home pins (phone)", () => {
    // balanced on a phone: fleet, quick, usage, activity, recents pinned;
    // quota and agenda shown but not pinned; pet hidden.
    const MOBILE: GlanceMobileEntry[] = mobileLayoutFromPreset("balanced")

    function renderMobile(onToggle = jest.fn()) {
      const onChange = jest.fn()
      const isPinned = (id: GlanceEntryId) => MOBILE.find((entry) => entry.id === id)?.home === true
      render(
        <GlanceLayoutEditor
          entries={MOBILE}
          available={ALL}
          onChange={onChange}
          density="touch"
          home={{ isPinned, onToggle }}
        />
      )
      return { onChange, onToggle }
    }

    it("puts a pressed or unpressed home toggle on every shown row", () => {
      renderMobile()
      const shown = MOBILE.filter((entry) => !entry.hidden)
      for (const entry of shown) {
        const toggle = within(row(entry.id)).getByTestId(`glance-editor-home-${entry.id}`)
        expect(toggle).toHaveAttribute("aria-pressed", String(entry.home))
      }
      const fleet = screen.getByRole("button", { name: "Show Running on the home screen" })
      expect(fleet).toHaveAttribute("aria-pressed", "true")
      expect(fleet).toHaveAttribute("title", "On the home screen")
      const quota = screen.getByTestId("glance-editor-home-quota")
      expect(quota).toHaveAttribute("aria-pressed", "false")
      expect(quota).toHaveAttribute("title", "Not on the home screen")
      // A hidden module has no pin to show.
      expect(screen.queryByTestId("glance-editor-home-pet")).not.toBeInTheDocument()
      expect(screen.getAllByTestId(/^glance-editor-home-/)).toHaveLength(shown.length)
    })

    it("asks the caller to flip the pin and does not edit the entries itself", async () => {
      const user = userEvent.setup()
      const { onChange, onToggle } = renderMobile()
      await user.click(screen.getByTestId("glance-editor-home-fleet"))
      expect(onToggle).toHaveBeenLastCalledWith("fleet", false)
      await user.click(screen.getByTestId("glance-editor-home-quota"))
      expect(onToggle).toHaveBeenLastCalledWith("quota", true)
      expect(onToggle).toHaveBeenCalledTimes(2)
      expect(onChange).not.toHaveBeenCalled()
    })

    it("shows no home toggle without the home prop", () => {
      renderEditor({ entries: MOBILE, density: "touch" })
      expect(screen.queryByTestId(/^glance-editor-home-/)).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /on the home screen$/ })).not.toBeInTheDocument()
    })

    it("hands back entries with their extra fields intact", async () => {
      const user = userEvent.setup()
      const { onChange } = renderMobile()
      await user.click(screen.getByRole("button", { name: "Hide Usage" }))
      const hidden = onChange.mock.calls[0][0] as GlanceMobileEntry[]
      expect(hidden.find((e) => e.id === "usage")).toEqual(
        expect.objectContaining({ hidden: true, home: true })
      )
      // Every other entry comes back exactly as it went in, home pin included.
      for (const entry of MOBILE.filter((e) => e.id !== "usage")) {
        expect(hidden.find((e) => e.id === entry.id)).toEqual(entry)
      }

      await user.click(within(row("quota")).getByRole("radio", { name: "Expanded" }))
      const resized = onChange.mock.calls[1][0] as GlanceMobileEntry[]
      expect(resized.find((e) => e.id === "quota")).toEqual({
        id: "quota",
        size: "expanded",
        hidden: false,
        home: false,
      })
      expect(resized.every((e) => typeof e.home === "boolean")).toBe(true)

      await user.click(screen.getByRole("button", { name: "Add Pet" }))
      const added = onChange.mock.calls[2][0] as GlanceMobileEntry[]
      expect(added.find((e) => e.id === "pet")).toEqual(
        expect.objectContaining({ hidden: false, home: false })
      )
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

  describe("plugin modules (ADR-0225 §6)", () => {
    const CI: GlancePluginCatalogEntry = {
      id: "plugin:com.ci:status",
      pluginId: "com.ci",
      title: "Build status",
      icon: "GitBranch",
      sizes: ["compact", "expanded"],
      platforms: ["desktop", "mobile"],
    }
    const TODO: GlancePluginCatalogEntry = {
      id: "plugin:com.todo:today",
      pluginId: "com.todo",
      title: "Today",
      icon: null,
      sizes: ["standard"],
      platforms: ["desktop", "mobile"],
    }

    it("offers a running plugin module the layout has never placed, tagged as a plugin", () => {
      renderEditor({ plugins: [CI] })
      const item = screen.getByTestId("glance-editor-hidden-plugin:com.ci:status")
      expect(item).toHaveTextContent("Build status")
      expect(item).toHaveTextContent("Plugin")
    })

    it("adds it as a new shown entry at the end, at its default size", async () => {
      const user = userEvent.setup()
      const { onChange } = renderEditor({ plugins: [CI, TODO] })
      await user.click(screen.getByRole("button", { name: "Add Today" }))
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      const shown = next.filter((e) => !e.hidden)
      expect(shown.at(-1)).toEqual({ id: "plugin:com.todo:today", size: "standard", hidden: false })
    })

    it("builds the new entry with the caller's factory", async () => {
      const user = userEvent.setup()
      const makeEntry = jest.fn((id: string, size: string) => ({
        id,
        size,
        hidden: false,
        home: false,
      }))
      const { onChange } = renderEditor({
        plugins: [CI],
        makeEntry: makeEntry as never,
      })
      await user.click(screen.getByRole("button", { name: "Add Build status" }))
      expect(makeEntry).toHaveBeenCalledWith("plugin:com.ci:status", "compact")
      const added = (onChange.mock.calls[0][0] as GlanceMobileEntry[]).find((e) => e.id === CI.id)
      expect(added).toEqual({ id: CI.id, size: "compact", hidden: false, home: false })
    })

    it("shows a placed plugin module with its own sizes and resizes within them", async () => {
      const user = userEvent.setup()
      const entries = [...ENTRIES, { id: CI.id, size: "compact" as const, hidden: false }]
      const { onChange } = renderEditor({ plugins: [CI], entries })
      const ciRow = row(CI.id)
      expect(
        within(ciRow)
          .getAllByRole("radio")
          .map((r) => r.getAttribute("aria-label"))
      ).toEqual(["Compact", "Expanded"])
      await user.click(within(ciRow).getByRole("radio", { name: "Expanded" }))
      const next = onChange.mock.calls[0][0] as GlanceLayoutEntry[]
      expect(next.find((e) => e.id === CI.id)?.size).toBe("expanded")
    })

    it("lists a shown entry whose plugin is off, labelled and removable, without sizes or a pin", async () => {
      const user = userEvent.setup()
      const entries = [...ENTRIES, { id: CI.id, size: "compact" as const, hidden: false }]
      const { onChange } = renderEditor({
        entries,
        home: { isPinned: () => true, onToggle: jest.fn() },
      })
      const offRow = row(CI.id)
      expect(offRow).toHaveTextContent("Plugin off — Plugin module")
      expect(within(offRow).queryByRole("radio")).not.toBeInTheDocument()
      expect(within(offRow).queryByRole("button", { name: /home screen/ })).not.toBeInTheDocument()
      await user.click(within(offRow).getByRole("button", { name: /^Remove / }))
      expect(
        (onChange.mock.calls[0][0] as GlanceLayoutEntry[]).find((e) => e.id === CI.id)?.hidden
      ).toBe(true)
    })

    it("does not offer a hidden entry whose plugin is off", () => {
      const entries = [...ENTRIES, { id: CI.id, size: "compact" as const, hidden: true }]
      renderEditor({ entries })
      expect(screen.queryByTestId(`glance-editor-hidden-${CI.id}`)).not.toBeInTheDocument()
    })
  })
})

describe("defaultPluginSize", () => {
  it("starts at standard when the module has it, else its smallest", () => {
    expect(defaultPluginSize(["compact", "standard", "expanded"])).toBe("standard")
    expect(defaultPluginSize(["compact", "expanded"])).toBe("compact")
    expect(defaultPluginSize([])).toBe("standard")
  })
})
