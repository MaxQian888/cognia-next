/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceFleetRow,
  type GlanceFleetSlice,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"
import type { GlanceRequestBody } from "@/lib/glance/requests"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GlanceFleetModule } from "./glance-fleet-module"

const NOW = 1_700_000_000_000

function makeSnapshot(fleet: GlanceFleetSlice | null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
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

function makeRow(id: string, overrides: Partial<GlanceFleetRow> = {}): GlanceFleetRow {
  return {
    id,
    title: `Task ${id}`,
    agent: "claude-code",
    agentLabel: null,
    state: "working",
    statusKey: null,
    startedAt: NOW - 120_000,
    updatedAt: NOW - 60_000,
    waitingSince: null,
    ...overrides,
  }
}

function makeFleet(overrides: Partial<GlanceFleetSlice> = {}): GlanceFleetSlice {
  const rows = overrides.rows ?? [makeRow("a")]
  return {
    updatedAt: NOW,
    counts: { working: 1, awaiting: 0, failed: 0 },
    total: rows.length,
    rows,
    ...overrides,
  }
}

function setup(fleet: GlanceFleetSlice | null, size: "compact" | "standard" | "expanded") {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(async () => null)
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(fleet),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route,
  }
  const wrap = (children: ReactNode) => <GlanceProvider value={value}>{children}</GlanceProvider>
  const utils = render(wrap(<GlanceFleetModule size={size} />))
  return { ...utils, route, send, user: userEvent.setup() }
}

const FORBIDDEN_CONTROL = /approve|deny|allow|stop|reject|批准|拒绝|停止/i

describe("GlanceFleetModule", () => {
  it("shows a loading line while the fleet slice is null", () => {
    setup(null, "standard")
    expect(screen.getByText("Reading tasks…")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  describe("compact", () => {
    it("shows only the running count when nothing awaits or fails", () => {
      setup(makeFleet({ counts: { working: 2, awaiting: 0, failed: 0 } }), "compact")
      expect(screen.getByText("2 running")).toBeInTheDocument()
      expect(screen.queryByText(/awaiting/)).not.toBeInTheDocument()
      expect(screen.queryByText(/failed/)).not.toBeInTheDocument()
    })

    it("adds awaiting and failed counts when present", () => {
      setup(makeFleet({ counts: { working: 1, awaiting: 3, failed: 2 } }), "compact")
      expect(screen.getByText("1 running")).toBeInTheDocument()
      expect(screen.getByText("3 awaiting")).toBeInTheDocument()
      expect(screen.getByText("2 failed")).toBeInTheDocument()
    })

    it("routes to Agent Fleet when clicked", async () => {
      const { route, user } = setup(makeFleet(), "compact")
      await user.click(screen.getByRole("button", { name: "Open Agent Fleet" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-fleet" })
    })
  })

  describe("standard", () => {
    it("shows the three counts in a stats strip", () => {
      setup(makeFleet({ counts: { working: 4, awaiting: 2, failed: 1 } }), "standard")
      const section = screen.getByRole("region", { name: "Running" })
      expect(within(section).getByText("Awaiting", { selector: "span.block" })).toBeInTheDocument()
      expect(within(section).getByText("4")).toBeInTheDocument()
      expect(within(section).getByText("2")).toBeInTheDocument()
      expect(within(section).getByText("1")).toBeInTheDocument()
      expect(within(section).getByText("Read-only · act in Fleet")).toBeInTheDocument()
    })

    it.each([
      ["Running", "working"],
      ["Awaiting", "awaiting"],
      ["Failed", "failed"],
    ] as const)("routes the %s stat with the %s filter", async (label, filter) => {
      const { route, user } = setup(
        makeFleet({ counts: { working: 1, awaiting: 1, failed: 1 } }),
        "standard"
      )
      await user.click(
        screen.getByRole("button", { name: `Open Agent Fleet at a task that is ${label}` })
      )
      expect(route).toHaveBeenCalledWith({ kind: "open-fleet", filter })
    })

    it("routes a row click with its rowId", async () => {
      const { route, user } = setup(
        makeFleet({
          rows: [makeRow("one", { title: "Fix login" }), makeRow("two", { title: "Write docs" })],
        }),
        "standard"
      )
      await user.click(screen.getByRole("button", { name: "Open “Write docs” in Agent Fleet" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-fleet", rowId: "two" })
    })

    it("routes from the header Fleet link", async () => {
      const { route, user } = setup(makeFleet(), "standard")
      await user.click(screen.getByRole("button", { name: "Open Agent Fleet" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-fleet" })
    })

    it("caps rows at three and shows an N more row routing to the fleet", async () => {
      const rows = Array.from({ length: 8 }, (_, i) => makeRow(`r${i}`))
      const { route, user } = setup(makeFleet({ rows, total: 10 }), "standard")
      expect(screen.getAllByTestId(/^glance-fleet-row-/)).toHaveLength(3)
      const more = screen.getByText("7 more tasks")
      await user.click(more)
      expect(route).toHaveBeenCalledWith({ kind: "open-fleet" })
    })

    it("does not show a more row when every task is listed", () => {
      setup(makeFleet({ rows: [makeRow("a"), makeRow("b")], total: 2 }), "standard")
      expect(screen.queryByText(/more tasks?/)).not.toBeInTheDocument()
    })

    it("shows the empty state when there are no rows", () => {
      setup(
        makeFleet({ rows: [], total: 0, counts: { working: 0, awaiting: 0, failed: 0 } }),
        "standard"
      )
      expect(screen.getByText("Nothing running")).toBeInTheDocument()
      expect(screen.queryAllByTestId(/^glance-fleet-row-/)).toHaveLength(0)
    })

    it("tags awaiting, failed and stale rows", () => {
      setup(
        makeFleet({
          rows: [
            makeRow("w", { state: "awaiting", waitingSince: NOW - 30_000 }),
            makeRow("f", { state: "failed" }),
            makeRow("s", { state: "stale" }),
          ],
          counts: { working: 0, awaiting: 1, failed: 1 },
        }),
        "standard"
      )
      expect(
        within(screen.getByTestId("glance-fleet-row-w")).getByText("Awaiting")
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId("glance-fleet-row-f")).getByText("Failed")
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId("glance-fleet-row-s")).getByText("Stale")
      ).toBeInTheDocument()
    })

    it("names the agent from its translation, its configured label, or its raw id", () => {
      setup(
        makeFleet({
          rows: [
            makeRow("known", { agent: "claude-code" }),
            makeRow("label", { agent: "acme", agentLabel: "Acme Bot" }),
            makeRow("raw", { agent: "mystery-agent" }),
            makeRow("none", { agent: null }),
          ],
          total: 4,
        }),
        "expanded"
      )
      expect(
        within(screen.getByTestId("glance-fleet-row-known")).getByText(/^Claude Code · /)
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId("glance-fleet-row-label")).getByText(/^Acme Bot · /)
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId("glance-fleet-row-raw")).getByText(/^mystery-agent · /)
      ).toBeInTheDocument()
      const none = within(screen.getByTestId("glance-fleet-row-none")).getAllByText(/./)
      expect(none.some((el) => / · /.test(el.textContent ?? ""))).toBe(false)
    })
  })

  describe("expanded", () => {
    it("lists up to six rows", () => {
      const rows = Array.from({ length: 8 }, (_, i) => makeRow(`r${i}`))
      setup(makeFleet({ rows, total: 8 }), "expanded")
      expect(screen.getAllByTestId(/^glance-fleet-row-/)).toHaveLength(6)
      expect(screen.getByText("2 more tasks")).toBeInTheDocument()
    })
  })

  describe("read-only contract (ADR-0225 section 1)", () => {
    it.each(["compact", "standard", "expanded"] as const)(
      "exposes no approve, deny, allow, reject or stop control at %s size",
      (size) => {
        const rows = [
          makeRow("await", {
            title: "Ship release",
            state: "awaiting",
            waitingSince: NOW - 90_000,
          }),
          makeRow("fail", { title: "Run migration", state: "failed" }),
          makeRow("work", { title: "Refactor store", state: "working" }),
        ]
        const { container } = setup(
          makeFleet({ rows, total: 3, counts: { working: 1, awaiting: 1, failed: 1 } }),
          size
        )
        for (const role of ["button", "link", "menuitem", "switch", "checkbox", "radio"] as const) {
          expect(screen.queryByRole(role, { name: FORBIDDEN_CONTROL })).not.toBeInTheDocument()
        }
        // No control hides its name behind an aria-label either.
        for (const el of Array.from(
          container.querySelectorAll("[aria-label], button, a, [role=button]")
        )) {
          const name = el.getAttribute("aria-label") ?? el.textContent ?? ""
          expect(name).not.toMatch(FORBIDDEN_CONTROL)
        }
        expect(container.textContent ?? "").not.toMatch(FORBIDDEN_CONTROL)
      }
    )

    it("only ever routes to Agent Fleet, never sends an action", async () => {
      const rows = [makeRow("await", { state: "awaiting", waitingSince: NOW - 1_000 })]
      const { route, send, user } = setup(
        makeFleet({ rows, counts: { working: 0, awaiting: 1, failed: 0 } }),
        "expanded"
      )
      for (const button of screen.getAllByRole("button")) await user.click(button)
      expect(send).not.toHaveBeenCalled()
      for (const [body] of route.mock.calls) expect(body.kind).toBe("open-fleet")
    })
  })
})
