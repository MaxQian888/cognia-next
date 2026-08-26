/** @jest-environment jsdom */

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  SETTINGS_LIST_DETAIL_COLLAPSE,
  SETTINGS_PANE_TIERS,
  SettingsMasterDetail,
  densityForWidth,
  useSettingsPaneDensity,
} from "./settings-master-detail"

function Harness({ initialKey = "a" }: { initialKey?: string }) {
  const [active, setActive] = useState(initialKey)
  return (
    <>
      <SettingsMasterDetail
        nav={(slot) => (
          <div data-testid={`nav-${slot}`}>
            <button onClick={() => setActive("b")}>navigate from {slot}</button>
          </div>
        )}
        navTitle="Sections"
        mobileTriggerLabel="Open sections"
        activeKey={active}
        activeLabel={`panel ${active}`}
        navWidth={320}
        triggerTestId="pane-trigger"
      >
        <div data-testid="detail">detail</div>
      </SettingsMasterDetail>
    </>
  )
}

describe("densityForWidth", () => {
  it("treats an unmeasured pane as the widest tier", () => {
    // `useElementWidth` returns 0 before the ref is attached; degrading to a
    // mobile shape on that would flash a Sheet trigger on every desktop mount.
    expect(densityForWidth(0)).toBe("full")
  })

  it("steps down one tier at each boundary", () => {
    expect(densityForWidth(SETTINGS_PANE_TIERS.full)).toBe("full")
    expect(densityForWidth(SETTINGS_PANE_TIERS.full - 1)).toBe("compact")
    expect(densityForWidth(SETTINGS_PANE_TIERS.compact)).toBe("compact")
    expect(densityForWidth(SETTINGS_PANE_TIERS.compact - 1)).toBe("icon")
    expect(densityForWidth(SETTINGS_PANE_TIERS.icon)).toBe("icon")
    expect(densityForWidth(SETTINGS_PANE_TIERS.icon - 1)).toBe("sheet")
  })

  it("puts the tiers in ascending order", () => {
    // The CSS below duplicates these numbers as `@[Npx]/settings-pane`
    // variants; reordering them here without reordering the class string
    // would give a 52px rail that still renders descriptions.
    expect(SETTINGS_PANE_TIERS.icon).toBeLessThan(SETTINGS_PANE_TIERS.compact)
    expect(SETTINGS_PANE_TIERS.compact).toBeLessThan(SETTINGS_PANE_TIERS.full)
  })

  /**
   * The gate the constants were exported FOR.
   *
   * Tailwind cannot interpolate a variant, so every place a tier actually takes
   * effect re-spells it as a literal `@[Npx]/settings-pane`. `densityForWidth`
   * — which decides the hover titles and Appearance's preview default — reads
   * the constants instead. Nothing but this test stops the two from drifting:
   * moving `SETTINGS_PANE_TIERS.icon` to 480 would leave every `@[440px]` rule
   * behind, and the rail would be 52px wide while its rows still rendered
   * descriptions.
   */
  it("uses no pane container query that is not a declared tier", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    // The whole settings tree: `@container/settings-pane` is declared in this
    // module and every pane that queries it lives under here.
    const settingsRoot = path.join(__dirname, "..")

    const declared = new Set(
      [...Object.values(SETTINGS_PANE_TIERS), SETTINGS_LIST_DETAIL_COLLAPSE].map(String)
    )

    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) files.push(full)
      }
    }
    await walk(settingsRoot)

    const offenders: string[] = []
    let scanned = 0
    for (const file of files) {
      const source = await fs.readFile(file, "utf8")
      for (const match of source.matchAll(/@\[(\d+)px\]\/settings-pane/g)) {
        scanned += 1
        if (!declared.has(match[1])) {
          offenders.push(`${path.relative(settingsRoot, file)}: @[${match[1]}px]`)
        }
      }
    }
    // A sweep that matched nothing would pass vacuously.
    expect(scanned).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})

describe("SettingsMasterDetail", () => {
  it("renders the rail nav and the detail, and holds the drawer shut", () => {
    render(<Harness />)
    expect(screen.getByTestId("nav-rail")).toBeInTheDocument()
    expect(screen.getByTestId("detail")).toBeInTheDocument()
    expect(screen.queryByTestId("nav-sheet")).not.toBeInTheDocument()
  })

  it("sizes the full tier from the section's own rail width", () => {
    const { container } = render(<Harness />)
    const grid = container.querySelector<HTMLElement>("[style*='--settings-rail-w']")
    expect(grid?.style.getPropertyValue("--settings-rail-w")).toBe("320px")
    expect(grid?.className).toContain("@[860px]/settings-pane:grid-cols-[var(--settings-rail-w)")
  })

  it("scopes the tiers to the pane, not the viewport", () => {
    // The whole point of the rewrite: this pane is the window minus the app
    // rail minus the settings sidebar, so a `md:` breakpoint fires ~330px too
    // early. Any `md:grid-cols` creeping back in is the old bug returning.
    const { container } = render(<Harness />)
    const pane = container.querySelector<HTMLElement>(".\\@container\\/settings-pane")
    expect(pane).not.toBeNull()
    const grid = container.querySelector<HTMLElement>("[style*='--settings-rail-w']")
    expect(grid?.className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):grid-cols/)
  })

  it("keeps every row label in the accessible tree at the icon tier", () => {
    // The narrow tiers hide text with `sr-only`, never `hidden`: the glyph is
    // all that is painted but the row still announces its full name.
    const rail = render(<Harness />).container.querySelector<HTMLElement>(
      "[data-testid='settings-master-rail']"
    )
    expect(rail?.className).toContain("[&_[data-nav-text]]:sr-only")
    expect(rail?.className).toContain("[&_[data-nav-desc]]:sr-only")
    expect(rail?.className).not.toContain("[&_[data-nav-text]]:hidden")
    expect(rail?.className).not.toContain("[&_[data-nav-desc]]:hidden")
    expect(rail?.className).toContain("@[620px]/settings-pane:[&_[data-nav-text]]:not-sr-only")
    // The description is the one thing the compact tier still withholds.
    expect(rail?.className).not.toContain("@[620px]/settings-pane:[&_[data-nav-desc]]:not-sr-only")
    expect(rail?.className).toContain("@[860px]/settings-pane:[&_[data-nav-desc]]:not-sr-only")
  })

  it("opens the drawer with a second nav instance", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId("pane-trigger"))
    expect(await screen.findByTestId("nav-sheet")).toBeInTheDocument()
  })

  it("closes the drawer when the active panel changes", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId("pane-trigger"))
    expect(await screen.findByTestId("nav-sheet")).toBeInTheDocument()

    // Selecting inside the drawer dismisses it. The rule lives on the frame,
    // keyed off the active panel, rather than in each section's `onSelect` —
    // which is where it used to be missed for anything that navigated without
    // going through a nav row.
    await user.click(screen.getByRole("button", { name: "navigate from sheet" }))
    await screen.findByText("panel b")
    expect(screen.queryByTestId("nav-sheet")).not.toBeInTheDocument()
  })
})

describe("useSettingsPaneDensity", () => {
  it("reports the widest tier outside a pane", () => {
    // Panels also render on their own routes (`/me/logs`), where there is no
    // frame to measure and nothing should degrade.
    const Probe = () => <span>{useSettingsPaneDensity()}</span>
    render(<Probe />)
    expect(screen.getByText("full")).toBeInTheDocument()
  })

  it("publishes the frame's density to the rail nav", () => {
    const Probe = () => <span data-testid="probe">{useSettingsPaneDensity()}</span>
    render(
      <SettingsMasterDetail
        nav={() => <Probe />}
        navTitle="Sections"
        mobileTriggerLabel="Open"
        activeKey="a"
      >
        <div />
      </SettingsMasterDetail>
    )
    // jsdom measures 0, the unmeasured sentinel.
    expect(screen.getByTestId("probe")).toHaveTextContent("full")
  })

  // The rail is CSS-hidden at the drawer tier, never unmounted, so both navs
  // are live at once. Most sections return the SAME node for both slots, which
  // used to put one `layoutId` on two mounted pills; each slot now sits in its
  // own `LayoutGroup`, so a shared id is namespaced apart instead of fighting.
  it("keeps the two nav slots in separate layout namespaces", async () => {
    const user = userEvent.setup()
    const nav = <div data-testid="shared-nav">shared</div>
    render(
      <SettingsMasterDetail
        nav={() => nav}
        navTitle="Sections"
        mobileTriggerLabel="Open"
        activeKey="a"
        triggerTestId="pane-trigger"
      >
        <div />
      </SettingsMasterDetail>
    )
    await user.click(screen.getByTestId("pane-trigger"))
    // Both instances mounted from one node — the case the namespacing exists for.
    expect(screen.getAllByTestId("shared-nav")).toHaveLength(2)
  })
})
