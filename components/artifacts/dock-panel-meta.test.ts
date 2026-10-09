/** @jest-environment jsdom */
import { DOCK_SESSION_PANEL_META, NEW_TAB_PANEL_ID } from "./dock-panel-meta"
import { AgentTeamIcon } from "@/components/mobile/mobile-spot-icon"
import {
  NEW_TAB_PANEL_ID as NEW_TAB_PANEL_ID_FROM_LIB,
  SESSION_ARTIFACT_LIST_PANEL_ID,
} from "@/lib/artifacts/session-workbench-scope-key"
import { SIDECHAT_PANEL_ID } from "@/lib/tasks/spawn-task-core"

// Every session panel's label, icon and width against its live definition is
// pinned in `chat-dock-panels.test.tsx`, which mounts the definitions; this
// file only holds the table's own identities.
describe("DOCK_SESSION_PANEL_META", () => {
  it("keeps the Squad tab in the shared anime style", () => {
    expect(DOCK_SESSION_PANEL_META["squad-context"].icon).toBe(AgentTeamIcon)
  })
  it("re-exports the New Tab page's id from the one place it is declared", () => {
    expect(NEW_TAB_PANEL_ID).toBe(NEW_TAB_PANEL_ID_FROM_LIB)
    expect(DOCK_SESSION_PANEL_META[NEW_TAB_PANEL_ID]).toMatchObject({
      labelKey: "contextWorkbench.newTab.title",
    })
  })

  it("keys the panels by the ids their own modules export", () => {
    expect(DOCK_SESSION_PANEL_META[SESSION_ARTIFACT_LIST_PANEL_ID]).toBeDefined()
    expect(DOCK_SESSION_PANEL_META[SIDECHAT_PANEL_ID]).toBeDefined()
  })

  it("marks the panels that want a wide dock", () => {
    const wide = Object.entries(DOCK_SESSION_PANEL_META)
      .filter(([, meta]) => meta.preferredMode === "wide")
      .map(([id]) => id)
      .sort()
    expect(wide).toEqual(["browser", "project-overview", "workspace"])
  })
})
