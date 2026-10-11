/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceRecentsSlice,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GlanceRecentsModule } from "./glance-recents-module"

const NOW = 1_700_000_000_000

function makeRecents(rows: GlanceRecentsSlice["rows"]): GlanceRecentsSlice {
  return { updatedAt: NOW, rows }
}

const ROWS = [
  { id: "s1", title: "Plan the release", updatedAt: NOW - 60_000 },
  { id: "s2", title: "Debug the build", updatedAt: NOW - 3_600_000 },
  { id: "s3", title: "Write the changelog", updatedAt: NOW - 86_400_000 },
]

function makeSnapshot(recents: GlanceRecentsSlice | null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents,
    pet: null,
  }
}

function setup(recents: GlanceRecentsSlice | null, size: "compact" | "standard" = "standard") {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(async () => null)
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(recents),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route,
  }
  const utils = render(
    <GlanceProvider value={value}>
      <GlanceRecentsModule size={size} />
    </GlanceProvider>
  )
  return { ...utils, route, send, user: userEvent.setup() }
}

describe("GlanceRecentsModule", () => {
  it.each(["compact", "standard"] as const)(
    "shows a loading line while the slice is null (%s)",
    (size) => {
      setup(null, size)
      expect(screen.getByText("Reading conversations…")).toBeInTheDocument()
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
    }
  )

  it("shows an empty state in compact with no button", () => {
    setup(makeRecents([]), "compact")
    expect(screen.getByText("No recent conversations")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("shows an empty state in standard with no row buttons", () => {
    setup(makeRecents([]))
    expect(screen.getByText("No recent conversations")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("compact shows only the first conversation and routes open-session", async () => {
    const { route, user } = setup(makeRecents(ROWS), "compact")
    expect(screen.getByText("Plan the release")).toBeInTheDocument()
    expect(screen.queryByText("Debug the build")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Resume “Plan the release”" }))
    expect(route).toHaveBeenCalledWith({ kind: "open-session", sessionId: "s1" })
  })

  it("standard lists every row and each routes open-session with its id", async () => {
    const { route, user } = setup(makeRecents(ROWS))
    expect(screen.getAllByRole("button")).toHaveLength(3)
    await user.click(screen.getByRole("button", { name: "Resume “Debug the build”" }))
    expect(route).toHaveBeenLastCalledWith({ kind: "open-session", sessionId: "s2" })
    await user.click(screen.getByRole("button", { name: "Resume “Write the changelog”" }))
    expect(route).toHaveBeenLastCalledWith({ kind: "open-session", sessionId: "s3" })
  })

  it("never sends an action, only routes", async () => {
    const { send, user } = setup(makeRecents(ROWS))
    for (const button of screen.getAllByRole("button")) await user.click(button)
    expect(send).not.toHaveBeenCalled()
  })
})
