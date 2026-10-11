/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceAgendaSlice,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GlanceAgendaModule } from "./glance-agenda-module"

const NOW = 1_700_000_000_000

function makeAgenda(overrides: Partial<GlanceAgendaSlice> = {}): GlanceAgendaSlice {
  return {
    updatedAt: NOW,
    schedulerLocal: true,
    nextRun: { itemId: "task-42", name: "Nightly backup", at: NOW + 3_600_000 },
    lastOutcome: null,
    unread: 3,
    latestUnreadTitle: "Build finished",
    connectivity: { state: "paired", connected: 2, total: 3, lastContactAt: NOW - 120_000 },
    ...overrides,
  }
}

function makeSnapshot(agenda: GlanceAgendaSlice | null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    fleet: null,
    usage: null,
    quota: null,
    agenda,
    activity: null,
    recents: null,
    pet: null,
  }
}

function setup(agenda: GlanceAgendaSlice | null, size: "compact" | "standard" = "standard") {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(async () => null)
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(agenda),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route,
  }
  const utils = render(
    <GlanceProvider value={value}>
      <GlanceAgendaModule size={size} />
    </GlanceProvider>
  )
  return { ...utils, route, send, user: userEvent.setup() }
}

describe("GlanceAgendaModule", () => {
  it("shows a static loading row while the agenda slice is null", () => {
    setup(null)
    expect(screen.getByText("Reading…")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  describe("compact", () => {
    it("renders three buttons routing to scheduler (with item id), notifications and connectivity", async () => {
      const { route, user } = setup(makeAgenda(), "compact")
      const section = screen.getByRole("region", { name: "Schedule · notifications · connection" })
      expect(within(section).getAllByRole("button")).toHaveLength(3)

      await user.click(screen.getByRole("button", { name: "Open scheduled tasks" }))
      expect(route).toHaveBeenLastCalledWith({
        kind: "open-owner",
        owner: "scheduler",
        itemId: "task-42",
      })
      await user.click(screen.getByRole("button", { name: "Open notifications" }))
      expect(route).toHaveBeenLastCalledWith({ kind: "open-owner", owner: "notifications" })
      await user.click(screen.getByRole("button", { name: "Open connection settings" }))
      expect(route).toHaveBeenLastCalledWith({ kind: "open-owner", owner: "connectivity" })
    })

    it("routes to the scheduler without an item id when nothing is scheduled", async () => {
      const { route, user } = setup(makeAgenda({ nextRun: null }), "compact")
      expect(screen.getByText("Nothing scheduled")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Open scheduled tasks" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "scheduler" })
    })

    it("summarises unread and connectivity in the strip", () => {
      setup(makeAgenda(), "compact")
      expect(screen.getByText("3 unread")).toBeInTheDocument()
      expect(screen.getByText("2/3 devices connected")).toBeInTheDocument()
      expect(screen.getByText(/^Next .* Nightly backup$/)).toBeInTheDocument()
    })
  })

  describe("standard", () => {
    it("renders a row each for the schedule, notifications and connectivity", () => {
      setup(makeAgenda())
      expect(screen.getByText(/^Next .* Nightly backup$/)).toBeInTheDocument()
      expect(screen.getByText("3 unread")).toBeInTheDocument()
      expect(screen.getByText("Build finished")).toBeInTheDocument()
      expect(screen.getByText("2/3 devices connected")).toBeInTheDocument()
      expect(screen.getAllByRole("button")).toHaveLength(3)
    })

    it("routes each row to its owner", async () => {
      const { route, user } = setup(makeAgenda())
      await user.click(screen.getByRole("button", { name: "Open scheduled tasks" }))
      expect(route).toHaveBeenLastCalledWith({
        kind: "open-owner",
        owner: "scheduler",
        itemId: "task-42",
      })
      await user.click(screen.getByRole("button", { name: "Open notifications" }))
      expect(route).toHaveBeenLastCalledWith({ kind: "open-owner", owner: "notifications" })
      await user.click(screen.getByRole("button", { name: "Open connection settings" }))
      expect(route).toHaveBeenLastCalledWith({ kind: "open-owner", owner: "connectivity" })
    })

    it("says no unread when the count is zero and omits the latest title", () => {
      setup(makeAgenda({ unread: 0, latestUnreadTitle: null }))
      expect(screen.getByText("No unread")).toBeInTheDocument()
      expect(screen.queryByText("Build finished")).not.toBeInTheDocument()
    })

    it("says nothing is scheduled when there is no next run", () => {
      setup(makeAgenda({ nextRun: null }))
      expect(screen.getByText("Nothing scheduled")).toBeInTheDocument()
    })

    it("says scheduled tasks run elsewhere when the scheduler is not local", () => {
      setup(makeAgenda({ schedulerLocal: false, nextRun: null }))
      expect(screen.getByText("Scheduled tasks run on another host")).toBeInTheDocument()
      expect(screen.queryByText("Nothing scheduled")).not.toBeInTheDocument()
    })

    it("prefers the remote-host text over a stale next run when the scheduler is not local", () => {
      setup(makeAgenda({ schedulerLocal: false }))
      expect(screen.getByText("Scheduled tasks run on another host")).toBeInTheDocument()
      expect(screen.queryByText(/Nightly backup/)).not.toBeInTheDocument()
    })

    it.each([
      ["offline", "Offline"],
      ["remote", "Steering a remote host"],
      ["unpaired", "No devices paired"],
    ] as const)("renders the %s connectivity state", (state, text) => {
      setup(makeAgenda({ connectivity: { state, connected: 0, total: 0, lastContactAt: null } }))
      expect(screen.getByText(text)).toBeInTheDocument()
    })

    it("renders paired counts and the last contact", () => {
      setup(
        makeAgenda({
          connectivity: { state: "paired", connected: 0, total: 4, lastContactAt: NOW - 5_000 },
        })
      )
      expect(screen.getByText("0/4 devices connected")).toBeInTheDocument()
      expect(screen.getByText(/^seen /)).toBeInTheDocument()
    })

    it("omits the last contact when unpaired or never contacted", () => {
      const { unmount } = setup(
        makeAgenda({
          connectivity: { state: "paired", connected: 1, total: 1, lastContactAt: null },
        })
      )
      expect(screen.queryByText(/^seen /)).not.toBeInTheDocument()
      unmount()
      setup(
        makeAgenda({
          connectivity: { state: "unpaired", connected: 0, total: 0, lastContactAt: NOW },
        })
      )
      expect(screen.queryByText(/^seen /)).not.toBeInTheDocument()
    })

    it("omits the last-outcome tag when there has been no run", () => {
      setup(makeAgenda({ lastOutcome: null }))
      expect(screen.queryByText("Last run OK")).not.toBeInTheDocument()
      expect(screen.queryByText("Last run failed")).not.toBeInTheDocument()
    })

    it("tags a successful last run as OK with its details in the title", () => {
      setup(makeAgenda({ lastOutcome: { ok: true, at: NOW - 60_000, name: "Digest" } }))
      const tag = screen.getByText("Last run OK")
      expect(tag).toHaveClass("text-success")
      expect(tag.getAttribute("title")).toMatch(/^Digest, /)
    })

    it("tags a failed last run", () => {
      setup(makeAgenda({ lastOutcome: { ok: false, at: NOW - 60_000, name: "Digest" } }))
      expect(screen.getByText("Last run failed")).toHaveClass("text-destructive")
    })
  })
})
