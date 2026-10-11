/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"

jest.mock("@/hooks/glance/use-mobile-glance", () => ({ useMobileGlance: jest.fn() }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@/lib/capacitor/haptics", () => ({ selectionFeedback: jest.fn(async () => {}) }))

import type { GlanceContextValue, GlanceModuleOrigin } from "@/components/glance/glance-context"
import {
  useMobileGlance,
  type UseMobileGlanceOptions,
  type UseMobileGlanceResult,
} from "@/hooks/glance/use-mobile-glance"
import { DEFAULT_GLANCE_MOBILE_SETTINGS } from "@/lib/glance/mobile-layout"
import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceFleetSlice,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"
import type { GlanceEntryId, GlanceMobileEntry, GlanceModuleId } from "@/types/glance/layout"

import { MobileGlanceHome, speaksOnHome } from "./mobile-glance-home"
import { MobileGlanceProvider } from "./mobile-glance-provider"

const useMobileGlanceMock = useMobileGlance as jest.Mock

function makeFleet(overrides: Partial<GlanceFleetSlice> = {}): GlanceFleetSlice {
  return {
    updatedAt: 1_000,
    counts: { working: 0, awaiting: 0, failed: 0 },
    total: 0,
    rows: [],
    workflows: { running: 0, latest: null },
    ...overrides,
  }
}

function makeSnapshot(fleet: GlanceFleetSlice | null = null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 0,
    revision: 0,
    generatedAt: 1_000,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

const entry = (
  id: GlanceModuleId,
  home = true,
  hidden = false,
  size: GlanceMobileEntry["size"] = "compact"
): GlanceMobileEntry => ({ id, size, hidden, home })

function mockGlance({
  entries,
  shortcuts = ["newChat"],
  fleet = null,
  originOf = () => null,
}: {
  entries: GlanceMobileEntry[]
  shortcuts?: string[]
  fleet?: GlanceFleetSlice | null
  originOf?: (id: GlanceEntryId) => GlanceModuleOrigin | null
}) {
  const glance: GlanceContextValue = {
    snapshot: makeSnapshot(fleet),
    platform: "mobile",
    width: "standard",
    now: 1_000,
    send: jest.fn(async () => null),
    route: jest.fn(),
    originOf,
  }
  useMobileGlanceMock.mockReturnValue({
    settings: { ...DEFAULT_GLANCE_MOBILE_SETTINGS, entries, shortcuts },
    glance,
    originOf,
    remote: { status: "idle", snapshot: null, receivedAt: null, hostLabel: null },
    paired: false,
    supported: false,
    hostLayout: null,
    pluginCatalog: [],
    save: jest.fn(async () => null),
  } satisfies UseMobileGlanceResult)
}

const ACTIONS = { newChat: jest.fn(), search: jest.fn(), openSession: jest.fn(), editLayout: jest.fn() }

function renderHome(show = true) {
  return render(
    <MobileGlanceProvider actions={ACTIONS}>
      {show ? <MobileGlanceHome className="mt-2" /> : null}
    </MobileGlanceProvider>
  )
}

function lastOptions(): UseMobileGlanceOptions {
  return useMobileGlanceMock.mock.calls.at(-1)?.[0] as UseMobileGlanceOptions
}

function moduleIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("[data-glance-module]")).map(
    (el) => el.getAttribute("data-glance-module") as string
  )
}

beforeEach(() => useMobileGlanceMock.mockReset())

describe("MobileGlanceHome", () => {
  it("renders the visible home-pinned modules, in layout order, in one container", () => {
    mockGlance({
      entries: [
        entry("usage"),
        entry("quota", false),
        entry("quick", true, false, "standard"),
        entry("agenda", true, true),
        entry("recents"),
      ],
    })
    renderHome()
    const home = screen.getByTestId("mobile-glance-home")
    expect(home).toHaveClass("rounded-2xl", "border", "mt-2")
    expect(within(home).getAllByTestId("glance-stack")).toHaveLength(1)
    expect(moduleIds(home)).toEqual(["usage", "quick", "recents"])
  })

  it("registers itself as the home screen while mounted", () => {
    mockGlance({ entries: [entry("usage")] })
    const view = renderHome(false)
    expect(lastOptions().homeVisible).toBe(false)
    view.rerender(
      <MobileGlanceProvider actions={ACTIONS}>
        <MobileGlanceHome />
      </MobileGlanceProvider>
    )
    expect(lastOptions().homeVisible).toBe(true)
    view.rerender(<MobileGlanceProvider actions={ACTIONS}>{null}</MobileGlanceProvider>)
    expect(lastOptions().homeVisible).toBe(false)
  })

  it("stays registered even when it renders nothing, so the slices it waits on are built", () => {
    mockGlance({ entries: [entry("fleet")], fleet: makeFleet() })
    renderHome()
    expect(screen.queryByTestId("mobile-glance-home")).not.toBeInTheDocument()
    expect(lastOptions().homeVisible).toBe(true)
  })

  it("renders nothing when nothing pinned speaks", () => {
    mockGlance({ entries: [entry("fleet"), entry("quick")], shortcuts: [], fleet: makeFleet() })
    const { container } = renderHome()
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when nothing is pinned", () => {
    mockGlance({ entries: [entry("usage", false), entry("recents", false)] })
    const { container } = renderHome()
    expect(container).toBeEmptyDOMElement()
  })

  it("shows Fleet once something runs, and drops a quiet one beside a speaking module", () => {
    mockGlance({
      entries: [entry("fleet"), entry("usage")],
      fleet: makeFleet({ counts: { working: 2, awaiting: 0, failed: 0 } }),
    })
    const view = renderHome()
    expect(moduleIds(screen.getByTestId("mobile-glance-home"))).toEqual(["fleet", "usage"])

    mockGlance({ entries: [entry("fleet"), entry("usage")], fleet: makeFleet() })
    view.rerender(
      <MobileGlanceProvider actions={ACTIONS}>
        <MobileGlanceHome />
      </MobileGlanceProvider>
    )
    expect(moduleIds(screen.getByTestId("mobile-glance-home"))).toEqual(["usage"])
  })

  it("asks where each pinned module's data came from", () => {
    const originOf = jest.fn((id: GlanceEntryId): GlanceModuleOrigin | null =>
      id === "fleet" ? { kind: "unavailable", reason: "host-offline" } : null
    )
    mockGlance({
      entries: [entry("fleet"), entry("usage")],
      fleet: makeFleet({ counts: { working: 1, awaiting: 0, failed: 0 } }),
      originOf,
    })
    renderHome()
    expect(originOf).toHaveBeenCalledWith("fleet")
    // An unavailable Fleet is quiet on the home screen (the drawer says why).
    expect(moduleIds(screen.getByTestId("mobile-glance-home"))).toEqual(["usage"])
  })
})

describe("speaksOnHome", () => {
  const snapshot = (fleet: GlanceFleetSlice | null) => makeSnapshot(fleet)
  const fleetEntry = entry("fleet")

  describe("fleet", () => {
    it("is quiet when every count and running workflow is zero", () => {
      expect(speaksOnHome(fleetEntry, snapshot(makeFleet()), [], null)).toBe(false)
    })

    it("is quiet while the slice is null", () => {
      expect(speaksOnHome(fleetEntry, snapshot(null), [], null)).toBe(false)
    })

    it("is quiet when the desktop cannot supply it, even with work running", () => {
      const busy = makeFleet({ counts: { working: 3, awaiting: 1, failed: 1 } })
      expect(
        speaksOnHome(fleetEntry, snapshot(busy), [], { kind: "unavailable", reason: "host-offline" })
      ).toBe(false)
      expect(
        speaksOnHome(fleetEntry, snapshot(busy), [], {
          kind: "unavailable",
          reason: "host-unsupported",
        })
      ).toBe(false)
    })

    it.each([
      ["working", makeFleet({ counts: { working: 1, awaiting: 0, failed: 0 } })],
      ["awaiting", makeFleet({ counts: { working: 0, awaiting: 1, failed: 0 } })],
      ["failed", makeFleet({ counts: { working: 0, awaiting: 0, failed: 1 } })],
      ["running workflows", makeFleet({ workflows: { running: 2, latest: null } })],
    ])("speaks with %s", (_label, fleet) => {
      expect(speaksOnHome(fleetEntry, snapshot(fleet), [], null)).toBe(true)
    })

    it("speaks with a host reading", () => {
      const fleet = makeFleet({ workflows: { running: 1, latest: null } })
      expect(
        speaksOnHome(fleetEntry, snapshot(fleet), [], {
          kind: "host",
          host: "Mac",
          at: 1,
          live: false,
        })
      ).toBe(true)
    })
  })

  describe("quick", () => {
    it("is quiet with no shortcuts and speaks with any", () => {
      expect(speaksOnHome(entry("quick"), snapshot(null), [], null)).toBe(false)
      expect(speaksOnHome(entry("quick"), snapshot(null), ["search"], null)).toBe(true)
    })
  })

  it.each<GlanceModuleId>(["usage", "quota", "agenda", "activity", "recents", "pet"])(
    "always lets %s speak",
    (id) => {
      expect(speaksOnHome(entry(id), snapshot(null), [], null)).toBe(true)
      expect(
        speaksOnHome(entry(id), snapshot(null), [], { kind: "unavailable", reason: "host-offline" })
      ).toBe(true)
    }
  )
})
