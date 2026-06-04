/**
 * @jest-environment jsdom
 *
 * Tests for the surface-filtered quick-action hook: registry subscription,
 * surface filtering, and `when`-expression gating against the tray state
 * snapshot.
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { usePluginQuickActions } from "./use-plugin-quick-actions"
import {
  __resetQuickActionsForTesting,
  registerQuickAction,
} from "@/lib/plugin/registries/quick-action-registry"
import { __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"
import { defaultSnapshot } from "@/lib/tray/sync"

// The real snapshot hook reads the chat store + Dexie — stub it with the
// canonical default snapshot so the test controls the `when` inputs.
const snapshot = { ...defaultSnapshot(), goal: { active: true, paused: false } }
jest.mock("@/lib/tray/state-snapshot", () => ({
  useTrayStateSnapshot: () => snapshot,
}))

afterEach(() => {
  __resetQuickActionsForTesting()
  __resetCommandRegistryForTesting()
})

describe("usePluginQuickActions", () => {
  it("returns only actions targeting the requested surface", () => {
    registerQuickAction("plug-a", { id: "p", title: "P", run: () => {}, surfaces: ["palette"] })
    registerQuickAction("plug-a", { id: "c", title: "C", run: () => {}, surfaces: ["composer"] })

    const { result } = renderHook(() => usePluginQuickActions("palette"))

    expect(result.current.map((a) => a.id)).toEqual(["p"])
  })

  it("hides actions whose when-expression evaluates false (and malformed ones)", () => {
    registerQuickAction("plug-a", {
      id: "visible",
      title: "Visible",
      run: () => {},
      when: "goal.active",
    })
    registerQuickAction("plug-a", {
      id: "hidden",
      title: "Hidden",
      run: () => {},
      when: "goal.paused",
    })
    registerQuickAction("plug-a", {
      id: "broken",
      title: "Broken",
      run: () => {},
      when: "goal.active &&",
    })

    const { result } = renderHook(() => usePluginQuickActions("palette"))

    expect(result.current.map((a) => a.id)).toEqual(["visible"])
  })

  it("re-renders when the registry mutates", async () => {
    const { result } = renderHook(() => usePluginQuickActions("composer"))
    expect(result.current).toHaveLength(0)

    act(() => {
      registerQuickAction("plug-a", { id: "late", title: "Late", run: () => {} })
    })

    await waitFor(() => {
      expect(result.current.map((a) => a.id)).toEqual(["late"])
    })
  })
})
