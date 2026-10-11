/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceWidthStep } from "@/types/glance/layout"

import { GlanceProvider, type GlanceContextValue, type GlancePlatform } from "./glance-context"
import {
  GlanceCompactSection,
  GlanceDot,
  GlanceLinkButton,
  GlanceMeter,
  GlanceRow,
  GlanceSection,
  GlanceSparkline,
  GlanceStats,
  GlanceTag,
} from "./glance-primitives"

function makeSnapshot(): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: 1_000,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

function renderGlance(
  ui: ReactNode,
  options: { platform?: GlancePlatform; width?: GlanceWidthStep } = {}
) {
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(),
    platform: options.platform ?? "desktop",
    width: options.width ?? "standard",
    now: 5_000,
    send: jest.fn(async () => null),
    route: jest.fn(),
  }
  return render(<GlanceProvider value={value}>{ui}</GlanceProvider>)
}

describe("GlanceSection", () => {
  it("renders title, meta and aside inside a labelled module section", () => {
    renderGlance(
      <GlanceSection
        moduleId="usage"
        title="Usage"
        meta={<span>meta-text</span>}
        aside={<button type="button">aside-action</button>}
      >
        <p>body</p>
      </GlanceSection>
    )
    const section = screen.getByRole("region", { name: "Usage" })
    expect(section).toHaveAttribute("data-glance-module", "usage")
    expect(within(section).getByRole("heading", { name: "Usage" })).toBeInTheDocument()
    expect(within(section).getByText("meta-text")).toBeInTheDocument()
    expect(within(section).getByRole("button", { name: "aside-action" })).toBeInTheDocument()
    expect(within(section).getByText("body")).toBeInTheDocument()
  })

  it("omits meta and aside wrappers when they are not given", () => {
    renderGlance(
      <GlanceSection moduleId="fleet" title="Running">
        <p>body</p>
      </GlanceSection>
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Running" }).parentElement?.children).toHaveLength(2)
  })

  it("uses roomier padding on mobile", () => {
    renderGlance(
      <GlanceSection moduleId="fleet" title="Running">
        x
      </GlanceSection>,
      { platform: "mobile" }
    )
    expect(screen.getByRole("region", { name: "Running" })).toHaveClass("px-5")
  })
})

describe("GlanceCompactSection", () => {
  it("is a navigable button only when onClick is given", async () => {
    const user = userEvent.setup()
    const onClick = jest.fn()
    renderGlance(
      <GlanceCompactSection moduleId="usage" title="Usage" label="Open usage" onClick={onClick}>
        <span>12k</span>
      </GlanceCompactSection>
    )
    const button = screen.getByRole("button", { name: "Open usage" })
    expect(button).toHaveAttribute("data-glance-nav")
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("renders a static row without button semantics when there is no onClick", () => {
    renderGlance(
      <GlanceCompactSection moduleId="usage" title="Usage">
        <span>Reading…</span>
      </GlanceCompactSection>
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(document.querySelector("[data-glance-nav]")).toBeNull()
    expect(screen.getByText("Reading…")).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Usage" })).toHaveAttribute(
      "data-glance-module",
      "usage"
    )
  })

  it("renders trailing content next to the body", () => {
    renderGlance(
      <GlanceCompactSection moduleId="quota" title="Quota" trailing={<span>trail</span>}>
        body
      </GlanceCompactSection>
    )
    expect(screen.getByText("trail")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })
})

describe("GlanceRow", () => {
  it("renders a static div when there is no onClick", () => {
    renderGlance(
      <GlanceRow testId="row" sub="2m" leading={<i>lead</i>} trailing={<b>trail</b>}>
        Title
      </GlanceRow>
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    const row = screen.getByTestId("row")
    expect(row.tagName).toBe("DIV")
    expect(within(row).getByText("Title")).toBeInTheDocument()
    expect(within(row).getByText("2m")).toBeInTheDocument()
    expect(within(row).getByText("lead")).toBeInTheDocument()
    expect(within(row).getByText("trail")).toBeInTheDocument()
  })

  it("renders a button that fires onClick and is a nav target", async () => {
    const user = userEvent.setup()
    const onClick = jest.fn()
    renderGlance(
      <GlanceRow label="Open thing" onClick={onClick}>
        Thing
      </GlanceRow>
    )
    const button = screen.getByRole("button", { name: "Open thing" })
    expect(button).toHaveAttribute("data-glance-nav")
    expect(button).not.toHaveAttribute("aria-expanded")
    expect(button).not.toHaveAttribute("data-glance-expand")
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("exposes aria-expanded and data-glance-expand for an expandable row", () => {
    const { rerender } = renderGlance(
      <GlanceRow expanded={false} expandKey="openai:acct" onClick={jest.fn()}>
        Provider
      </GlanceRow>
    )
    const button = screen.getByRole("button", { name: "Provider" })
    expect(button).toHaveAttribute("aria-expanded", "false")
    expect(button).toHaveAttribute("data-glance-expand", "openai:acct")

    rerender(
      <GlanceProvider
        value={{
          snapshot: makeSnapshot(),
          platform: "desktop",
          width: "standard",
          now: 0,
          send: jest.fn(async () => null),
          route: jest.fn(),
        }}
      >
        <GlanceRow expanded expandKey="openai:acct" onClick={jest.fn()}>
          Provider
        </GlanceRow>
      </GlanceProvider>
    )
    expect(screen.getByRole("button", { name: "Provider" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  })

  it("does not render a button for an expanded flag without onClick", () => {
    renderGlance(<GlanceRow expanded>Static</GlanceRow>)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})

describe("GlanceStats", () => {
  const stats = [
    { key: "a", label: "Alpha", value: "1", sub: "sub-a" },
    { key: "b", label: "Beta", value: "2" },
  ]

  it("lays stats out in a horizontal grid by default", () => {
    const { container } = renderGlance(<GlanceStats stats={stats} />)
    const grid = container.firstElementChild as HTMLElement
    expect(grid).not.toHaveClass("grid-cols-1")
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))")
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("sub-a")).toBeInTheDocument()
  })

  it("stacks stats into label / value lines at the narrow desktop width", () => {
    const { container } = renderGlance(<GlanceStats stats={stats} />, { width: "narrow" })
    const grid = container.firstElementChild as HTMLElement
    expect(grid).toHaveClass("grid-cols-1")
    expect(grid.style.gridTemplateColumns).toBe("")
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("keeps a row at the narrow width when keepRow is set", () => {
    const { container } = renderGlance(<GlanceStats stats={stats} keepRow />, { width: "narrow" })
    const grid = container.firstElementChild as HTMLElement
    expect(grid).not.toHaveClass("grid-cols-1")
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))")
  })

  it("never stacks on mobile even at the narrow width", () => {
    const { container } = renderGlance(<GlanceStats stats={stats} />, {
      width: "narrow",
      platform: "mobile",
    })
    expect((container.firstElementChild as HTMLElement).style.gridTemplateColumns).toBe(
      "repeat(2, minmax(0, 1fr))"
    )
  })

  it.each<GlanceWidthStep>(["standard", "narrow"])(
    "renders a clickable stat as a button that calls onClick (%s width)",
    async (width) => {
      const user = userEvent.setup()
      const onClick = jest.fn()
      renderGlance(
        <GlanceStats
          stats={[
            { key: "a", label: "Alpha", value: "1", onClick, actionLabel: "Open alpha" },
            { key: "b", label: "Beta", value: "2" },
          ]}
        />,
        { width }
      )
      const button = screen.getByRole("button", { name: "Open alpha" })
      expect(button).toHaveAttribute("data-glance-nav")
      await user.click(button)
      expect(onClick).toHaveBeenCalledTimes(1)
      expect(screen.getAllByRole("button")).toHaveLength(1)
    }
  )

  it("renders the stat value in a tone class", () => {
    renderGlance(<GlanceStats stats={[{ key: "a", label: "Alpha", value: "9", tone: "crit" }]} />)
    expect(screen.getByText("9")).toHaveClass("text-destructive")
  })
})

describe("GlanceMeter", () => {
  it("exposes a meter with the rounded value", () => {
    renderGlance(<GlanceMeter pct={42.4} severity="ok" label="Usage" />)
    const meter = screen.getByRole("meter", { name: "Usage" })
    expect(meter).toHaveAttribute("aria-valuenow", "42")
    expect(meter).toHaveAttribute("aria-valuemin", "0")
    expect(meter).toHaveAttribute("aria-valuemax", "100")
  })

  it("clamps values above 100 and below 0", () => {
    const { rerender } = renderGlance(<GlanceMeter pct={250} severity="crit" label="Over" />)
    expect(screen.getByRole("meter", { name: "Over" })).toHaveAttribute("aria-valuenow", "100")
    expect((screen.getByRole("meter").firstElementChild as HTMLElement).style.width).toBe("100%")
    rerender(
      <GlanceProvider
        value={{
          snapshot: makeSnapshot(),
          platform: "desktop",
          width: "standard",
          now: 0,
          send: jest.fn(async () => null),
          route: jest.fn(),
        }}
      >
        <GlanceMeter pct={-30} severity="ok" label="Under" />
      </GlanceProvider>
    )
    expect(screen.getByRole("meter", { name: "Under" })).toHaveAttribute("aria-valuenow", "0")
    expect((screen.getByRole("meter").firstElementChild as HTMLElement).style.width).toBe("0%")
  })

  it.each([
    ["crit", "bg-destructive"],
    ["warn", "bg-warning"],
    ["muted", "bg-muted-foreground/40"],
    ["ok", "bg-foreground/70"],
  ] as const)("colours the %s severity fill", (severity, className) => {
    renderGlance(<GlanceMeter pct={50} severity={severity} label="M" />)
    expect(screen.getByRole("meter").firstElementChild).toHaveClass(className)
  })
})

describe("GlanceSparkline", () => {
  it("returns nothing for fewer than two values", () => {
    const { container, rerender } = renderGlance(<GlanceSparkline values={[]} label="Trend" />)
    expect(container).toBeEmptyDOMElement()
    rerender(
      <GlanceProvider
        value={{
          snapshot: makeSnapshot(),
          platform: "desktop",
          width: "standard",
          now: 0,
          send: jest.fn(async () => null),
          route: jest.fn(),
        }}
      >
        <GlanceSparkline values={[5]} label="Trend" />
      </GlanceProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("draws one polyline point per value", () => {
    renderGlance(<GlanceSparkline values={[1, 3, 2, 5]} label="Trend" />)
    const svg = screen.getByRole("img", { name: "Trend" })
    const points = svg.querySelector("polyline")?.getAttribute("points") ?? ""
    expect(points.split(" ")).toHaveLength(4)
  })

  it("draws a flat line when every value is equal", () => {
    renderGlance(<GlanceSparkline values={[4, 4, 4]} height={22} label="Flat" />)
    const points =
      screen.getByRole("img", { name: "Flat" }).querySelector("polyline")?.getAttribute("points") ??
      ""
    const ys = points.split(" ").map((p) => p.split(",")[1])
    expect(new Set(ys).size).toBe(1)
    expect(ys.every((y) => Number.isFinite(Number(y)))).toBe(true)
  })

  it("honours width and height", () => {
    renderGlance(<GlanceSparkline values={[1, 2]} width={48} height={16} label="Small" />)
    const svg = screen.getByRole("img", { name: "Small" })
    expect(svg).toHaveAttribute("width", "48")
    expect(svg).toHaveAttribute("height", "16")
    expect(svg).toHaveAttribute("viewBox", "0 0 48 16")
  })
})

describe("GlanceTag", () => {
  it.each([
    ["neutral", "text-muted-foreground"],
    ["warn", "text-warning"],
    ["crit", "text-destructive"],
    ["ok", "text-success"],
  ] as const)("applies the %s tone", (tone, className) => {
    renderGlance(<GlanceTag tone={tone}>tag</GlanceTag>)
    expect(screen.getByText("tag")).toHaveClass(className)
  })

  it("defaults to neutral and forwards the title", () => {
    renderGlance(<GlanceTag title="hint">tag</GlanceTag>)
    expect(screen.getByText("tag")).toHaveClass("text-muted-foreground")
    expect(screen.getByText("tag")).toHaveAttribute("title", "hint")
  })
})

describe("GlanceDot", () => {
  it("is decorative and has no pulse by default", () => {
    const { container } = renderGlance(<GlanceDot tone="ok" />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot).toHaveAttribute("aria-hidden", "true")
    expect(dot.children).toHaveLength(1)
    expect(dot.firstElementChild).toHaveClass("bg-success")
  })

  it("adds a ping ring when pulse is set", () => {
    const { container } = renderGlance(<GlanceDot tone="err" pulse />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.children).toHaveLength(2)
    expect(dot.firstElementChild).toHaveClass("animate-ping", "bg-destructive")
  })
})

describe("GlanceLinkButton", () => {
  it("renders a button that fires onClick with an optional accessible name", async () => {
    const user = userEvent.setup()
    const onClick = jest.fn()
    renderGlance(
      <GlanceLinkButton label="Open the thing" onClick={onClick}>
        Open
      </GlanceLinkButton>
    )
    await user.click(screen.getByRole("button", { name: "Open the thing" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
