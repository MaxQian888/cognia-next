/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import { useWorkbenchActivityShortcuts } from "./use-workbench-activity-shortcuts"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { APP_SHORTCUT_CATALOG } from "@/lib/shortcuts/app-catalog"
import {
  publishActiveContextPanels,
  resetActiveContextForTesting,
  setActiveContextForHost,
} from "@/lib/context-workbench/active-context"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { CONTEXT_ACTIVITY_RAIL_ORDER } from "@/types/context-workbench"

const SCOPE = "dock::artifact:a-1"

const ARTIFACT_RESOURCE = {
  kind: "artifact",
  id: "a-1",
  title: "A",
  capabilities: [],
} as never

/** Every shortcut this hook owns, in catalog order. */
const ACTIVITY_SHORTCUTS = APP_SHORTCUT_CATALOG.filter((d) =>
  d.id.startsWith("workbench.activity.")
)

function fire(id: string) {
  getAppRegistration(id)?.handler(new KeyboardEvent("keydown"))
}

beforeEach(() => {
  __resetAppRuntimeForTesting()
  resetActiveContextForTesting()
  useContextWorkbenchStore.setState({ layouts: {} })
})

describe("useWorkbenchActivityShortcuts", () => {
  it("registers one shortcut per canonical activity", () => {
    renderHook(() => useWorkbenchActivityShortcuts())
    // Every canonical activity gets a chord, and nothing else does.
    expect(ACTIVITY_SHORTCUTS).toHaveLength(CONTEXT_ACTIVITY_RAIL_ORDER.length)
    for (const descriptor of ACTIVITY_SHORTCUTS) {
      expect(getAppRegistration(descriptor.id)).toBeDefined()
    }
  })

  it("claims ctrl+1..7 and leaves ctrl+0 to zoom reset", () => {
    const chords = ACTIVITY_SHORTCUTS.map((d) => d.defaultChord)
    expect(chords).toEqual(["ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7"])
    expect(chords).not.toContain("ctrl+0")
  })

  it("unregisters on unmount", () => {
    const { unmount } = renderHook(() => useWorkbenchActivityShortcuts())
    unmount()
    for (const descriptor of ACTIVITY_SHORTCUTS) {
      expect(getAppRegistration(descriptor.id)).toBeUndefined()
    }
  })

  it("reveals the activity's panel in the workbench that is in front", () => {
    setActiveContextForHost(SCOPE, ARTIFACT_RESOURCE)
    publishActiveContextPanels(SCOPE, [
      { id: "preview", activity: "preview-run", labelKey: "artifacts.dock.preview" },
      { id: "workspace", activity: "workspace", labelKey: "artifacts.dock.workspace" },
    ])
    renderHook(() => useWorkbenchActivityShortcuts())

    fire("workbench.activity.workspace")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.activePanelId).toBe("workspace")

    fire("workbench.activity.previewRun")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.activePanelId).toBe("preview")
  })

  it("is inert for an activity the mounted workbench does not offer", () => {
    // The session face has no `comments`. Ctrl+4 must do nothing rather than
    // land on a neighbour — a fixed chord that means different panels on
    // different surfaces is worse than one that sometimes does nothing.
    setActiveContextForHost(SCOPE, ARTIFACT_RESOURCE)
    publishActiveContextPanels(SCOPE, [
      { id: "preview", activity: "preview-run", labelKey: "artifacts.dock.preview" },
    ])
    renderHook(() => useWorkbenchActivityShortcuts())

    fire("workbench.activity.previewRun")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.activePanelId).toBe("preview")

    fire("workbench.activity.comments")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.activePanelId).toBe("preview")
  })

  it("does nothing when no workbench is mounted", () => {
    renderHook(() => useWorkbenchActivityShortcuts())
    expect(() => fire("workbench.activity.ai")).not.toThrow()
    expect(useContextWorkbenchStore.getState().layouts).toEqual({})
  })
})
