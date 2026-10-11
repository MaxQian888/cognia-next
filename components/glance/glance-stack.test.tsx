/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceLayoutEntry } from "@/types/glance/layout"

import { GlanceProvider, type GlanceContextValue } from "./glance-context"
import { DEFAULT_GLANCE_RENDERERS, GlanceStack, type GlanceModuleRenderer } from "./glance-stack"

function makeSnapshot(): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: 1_000,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    // Every slice is null so each default module renders its loading line.
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

function renderStack(
  entries: readonly GlanceLayoutEntry[],
  renderers?: Parameters<typeof GlanceStack>[0]["renderers"]
) {
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(),
    platform: "desktop",
    width: "standard",
    now: 5_000,
    send: jest.fn(async () => null),
    route: jest.fn(),
  }
  return render(
    <GlanceProvider value={value}>
      <GlanceStack entries={entries} renderers={renderers} />
    </GlanceProvider>
  )
}

function renderedModuleIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-glance-module]")).map(
    (el) => el.getAttribute("data-glance-module") as string
  )
}

describe("GlanceStack", () => {
  it("has a default renderer for every module except quick", () => {
    expect(Object.keys(DEFAULT_GLANCE_RENDERERS).sort()).toEqual(
      ["activity", "agenda", "fleet", "pet", "quota", "recents", "usage"].sort()
    )
    expect(DEFAULT_GLANCE_RENDERERS.quick).toBeUndefined()
  })

  it("renders the visible entries in layout order", () => {
    const { container } = renderStack([
      { id: "usage", size: "compact", hidden: false },
      { id: "fleet", size: "compact", hidden: false },
      { id: "recents", size: "compact", hidden: false },
    ])
    expect(screen.getByTestId("glance-stack")).toBeInTheDocument()
    expect(renderedModuleIds(container)).toEqual(["usage", "fleet", "recents"])
  })

  it("skips hidden entries", () => {
    const { container } = renderStack([
      { id: "fleet", size: "compact", hidden: false },
      { id: "usage", size: "compact", hidden: true },
      { id: "pet", size: "compact", hidden: false },
    ])
    expect(renderedModuleIds(container)).toEqual(["fleet", "pet"])
  })

  it("skips a module that has no renderer (quick without a host renderer)", () => {
    const { container } = renderStack([
      { id: "quick", size: "standard", hidden: false },
      { id: "fleet", size: "compact", hidden: false },
    ])
    expect(renderedModuleIds(container)).toEqual(["fleet"])
  })

  it("renders nothing inside an empty stack", () => {
    renderStack([])
    expect(screen.getByTestId("glance-stack")).toBeEmptyDOMElement()
  })

  it("lets a host renderer supply a module the defaults lack", () => {
    const Quick: GlanceModuleRenderer = ({ size }) => (
      <div data-testid="quick">{`quick:${size}`}</div>
    )
    const { container } = renderStack(
      [
        { id: "fleet", size: "compact", hidden: false },
        { id: "quick", size: "standard", hidden: false },
      ],
      { quick: Quick }
    )
    expect(screen.getByTestId("quick")).toHaveTextContent("quick:standard")
    expect(renderedModuleIds(container)).toEqual(["fleet"])
  })

  it("lets a host renderer override a default module", () => {
    const Custom: GlanceModuleRenderer = () => <div data-testid="custom-fleet" />
    const { container } = renderStack([{ id: "fleet", size: "compact", hidden: false }], {
      fleet: Custom,
    })
    expect(screen.getByTestId("custom-fleet")).toBeInTheDocument()
    expect(renderedModuleIds(container)).toEqual([])
  })

  it("passes the effective size, degrading an unsupported size", () => {
    const seen: Record<string, string> = {}
    const Spy =
      (id: string): GlanceModuleRenderer =>
      ({ size }) => {
        seen[id] = size
        return null
      }
    renderStack(
      [
        { id: "pet", size: "expanded", hidden: false },
        { id: "fleet", size: "expanded", hidden: false },
        { id: "agenda", size: "compact", hidden: false },
      ],
      { pet: Spy("pet"), fleet: Spy("fleet"), agenda: Spy("agenda") }
    )
    // pet tops out at standard; fleet supports expanded; agenda keeps compact.
    expect(seen).toEqual({ pet: "standard", fleet: "expanded", agenda: "compact" })
  })
})
