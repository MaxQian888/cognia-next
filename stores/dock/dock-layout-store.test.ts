/**
 * @jest-environment jsdom
 */
import {
  createEmptyDockLayout,
  DOCK_LAYOUT_LIMIT,
  DOCK_LAYOUT_MAX_AGE_MS,
  pruneDockLayouts,
  useDockLayoutStore,
} from "./dock-layout-store"
import { dockLayoutKeyOf, type DockLayoutEnvelope, type DockLayoutKey } from "@/types/dock/layout"

const key: DockLayoutKey = { accountId: "acc", host: "chat", contextId: "s1" }
const otherKey: DockLayoutKey = { accountId: "acc", host: "chat", contextId: "s2" }

const read = () => useDockLayoutStore.getState().getLayout(key)!

beforeEach(() => {
  useDockLayoutStore.setState({ envelopes: {}, histories: {}, lastRejection: {} })
})

describe("ensureLayout", () => {
  it("creates a default layout once and returns the same one after", () => {
    const first = useDockLayoutStore.getState().ensureLayout(key)
    expect(first.revision).toBe(0)
    expect(first.shell.edge).toBe("right")
    expect(useDockLayoutStore.getState().ensureLayout(key)).toBe(first)
  })

  it("keeps layouts for different contexts apart", () => {
    useDockLayoutStore.getState().ensureLayout(key)
    useDockLayoutStore.getState().setShellSize(key, 55)
    useDockLayoutStore.getState().ensureLayout(otherKey)
    expect(useDockLayoutStore.getState().getLayout(otherKey)?.shell.sizePercent).toBe(34)
  })
})

describe("adoptLayout", () => {
  it("seeds a layout that does not exist yet", () => {
    const seeded: DockLayoutEnvelope = {
      ...createEmptyDockLayout(key, 500),
      migratedFrom: "context-workbench-v1",
      shell: { edge: "right", sizePercent: 42, collapsed: false, railOnly: true },
    }
    expect(useDockLayoutStore.getState().adoptLayout(seeded)).toBe(true)
    expect(read().migratedFrom).toBe("context-workbench-v1")
  })

  it("refuses to overwrite a layout the user already has", () => {
    // The migration is one-way and one-shot; re-running it must not clobber
    // whatever the user has arranged since.
    useDockLayoutStore.getState().ensureLayout(key)
    useDockLayoutStore.getState().setShellSize(key, 60)
    const adopted = useDockLayoutStore
      .getState()
      .adoptLayout({ ...createEmptyDockLayout(key, 1), migratedFrom: "legacy" })
    expect(adopted).toBe(false)
    expect(read().shell.sizePercent).toBe(60)
    expect(read().migratedFrom).toBeUndefined()
  })
})

describe("mutations", () => {
  it("bumps the revision on every accepted commit", () => {
    useDockLayoutStore.getState().ensureLayout(key)
    useDockLayoutStore.getState().setShellSize(key, 40)
    expect(read().revision).toBe(1)
    useDockLayoutStore.getState().setShellCollapsed(key, false)
    expect(read().revision).toBe(2)
  })

  it("clamps a shell size the host could not render", () => {
    useDockLayoutStore.getState().setShellSize(key, 500)
    expect(read().shell.sizePercent).toBe(70)
    useDockLayoutStore.getState().setShellSize(key, -10)
    expect(read().shell.sizePercent).toBe(15)
    useDockLayoutStore.getState().setShellSize(key, Number.NaN)
    expect(read().shell.sizePercent).toBe(34)
  })

  it("stores the grid opaquely and the instance table beside it", () => {
    useDockLayoutStore.getState().setGrid(key, { grid: { root: {} }, activeGroup: "g1" })
    useDockLayoutStore.getState().setInstances(key, [
      {
        instanceId: "i1",
        panelId: "review",
        kind: "panel",
        mode: "pinned",
        dirty: false,
        activated: true,
      },
    ])
    expect(read().grid).toEqual({ grid: { root: {} }, activeGroup: "g1" })
    expect(read().instances).toHaveLength(1)
  })

  it("keeps railOnly unless it is explicitly changed", () => {
    useDockLayoutStore.getState().setShellCollapsed(key, true)
    expect(read().shell.railOnly).toBe(true)
    useDockLayoutStore.getState().setShellCollapsed(key, true, false)
    expect(read().shell.railOnly).toBe(false)
  })

  it("moves the dock to another edge", () => {
    useDockLayoutStore.getState().setShellEdge(key, "bottom")
    expect(read().shell.edge).toBe("bottom")
  })

  it("rejects a commit computed against a stale revision", () => {
    useDockLayoutStore.getState().ensureLayout(key)
    useDockLayoutStore.getState().setShellSize(key, 40)
    const accepted = useDockLayoutStore.getState().commit(key, {
      baseRevision: 0,
      label: "stale",
      apply: (current) => ({ ...current, shell: { ...current.shell, sizePercent: 99 } }),
    })
    expect(accepted).toBe(false)
    expect(read().shell.sizePercent).toBe(40)
    expect(useDockLayoutStore.getState().lastRejection[dockLayoutKeyOf(key)]).toBe("stale-revision")
  })
})

describe("undo / redo", () => {
  it("steps back and forward through structural changes only", () => {
    useDockLayoutStore.getState().ensureLayout(key)
    // A resize is incidental; it must not become an undo step.
    useDockLayoutStore.getState().setShellSize(key, 40)
    expect(useDockLayoutStore.getState().canUndo(key)).toBe(false)

    useDockLayoutStore.getState().setShellEdge(key, "left")
    expect(useDockLayoutStore.getState().canUndo(key)).toBe(true)

    expect(useDockLayoutStore.getState().undo(key)).toBe(true)
    expect(read().shell.edge).toBe("right")
    expect(useDockLayoutStore.getState().canRedo(key)).toBe(true)

    expect(useDockLayoutStore.getState().redo(key)).toBe(true)
    expect(read().shell.edge).toBe("left")
  })

  it("reports nothing to step through for an unknown layout", () => {
    expect(useDockLayoutStore.getState().undo(key)).toBe(false)
    expect(useDockLayoutStore.getState().redo(key)).toBe(false)
    expect(useDockLayoutStore.getState().canUndo(key)).toBe(false)
    expect(useDockLayoutStore.getState().canRedo(key)).toBe(false)
  })

  it("returns false when the stack is empty but the layout exists", () => {
    useDockLayoutStore.getState().ensureLayout(key)
    expect(useDockLayoutStore.getState().undo(key)).toBe(false)
    expect(useDockLayoutStore.getState().redo(key)).toBe(false)
  })
})

describe("removeLayout / resetLayout", () => {
  it("drops a layout with its history and rejection record", () => {
    useDockLayoutStore.getState().setShellEdge(key, "bottom")
    useDockLayoutStore.getState().commit(key, {
      baseRevision: 99,
      label: "stale",
      apply: (c) => c,
    })
    useDockLayoutStore.getState().removeLayout(key)
    const state = useDockLayoutStore.getState()
    expect(state.getLayout(key)).toBeUndefined()
    expect(state.histories[dockLayoutKeyOf(key)]).toBeUndefined()
    expect(state.lastRejection[dockLayoutKeyOf(key)]).toBeUndefined()
  })

  it("resets to defaults while keeping the revision moving forward", () => {
    useDockLayoutStore.getState().setShellEdge(key, "bottom")
    useDockLayoutStore.getState().setGrid(key, { a: 1 })
    const before = read().revision
    useDockLayoutStore.getState().resetLayout(key)
    expect(read().shell.edge).toBe("right")
    expect(read().grid).toBeNull()
    expect(read().revision).toBeGreaterThan(before)
  })
})

describe("pruneDockLayouts", () => {
  const envelope = (id: string, updatedAt: number): [string, DockLayoutEnvelope] => [
    id,
    { ...createEmptyDockLayout({ ...key, contextId: id }, updatedAt) },
  ]

  it("drops layouts older than the retention window", () => {
    const now = 1_000_000_000
    const pruned = pruneDockLayouts(
      Object.fromEntries([
        envelope("fresh", now - 1000),
        envelope("stale", now - DOCK_LAYOUT_MAX_AGE_MS - 1),
      ]),
      now
    )
    expect(Object.keys(pruned)).toEqual(["fresh"])
  })

  it("keeps the most recently used layouts when over the limit", () => {
    const now = 1_000_000_000
    const entries = Array.from({ length: DOCK_LAYOUT_LIMIT + 5 }, (_, i) =>
      envelope(`ctx-${i}`, now - i)
    )
    const pruned = pruneDockLayouts(Object.fromEntries(entries), now)
    expect(Object.keys(pruned)).toHaveLength(DOCK_LAYOUT_LIMIT)
    expect(pruned["ctx-0"]).toBeDefined()
    expect(pruned[`ctx-${DOCK_LAYOUT_LIMIT + 4}`]).toBeUndefined()
  })

  it("leaves a small set untouched", () => {
    const now = 1_000_000_000
    const pruned = pruneDockLayouts(Object.fromEntries([envelope("a", now)]), now)
    expect(Object.keys(pruned)).toEqual(["a"])
  })
})

describe("persistence boundary", () => {
  it("persists only pruned envelopes, never the in-session history", () => {
    const options = (
      useDockLayoutStore as unknown as {
        persist: {
          getOptions: () => {
            partialize: (s: unknown) => unknown
            merge: (persisted: unknown, current: unknown) => { envelopes: unknown }
          }
        }
      }
    ).persist.getOptions()

    useDockLayoutStore.getState().setShellEdge(key, "bottom")
    const persisted = options.partialize(useDockLayoutStore.getState()) as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual(["envelopes"])
  })

  it("rehydrates through the same prune, and tolerates an absent payload", () => {
    const options = (
      useDockLayoutStore as unknown as {
        persist: {
          getOptions: () => {
            merge: (persisted: unknown, current: unknown) => { envelopes: Record<string, unknown> }
          }
        }
      }
    ).persist.getOptions()
    const current = useDockLayoutStore.getState()

    const stale = createEmptyDockLayout(key, Date.now() - DOCK_LAYOUT_MAX_AGE_MS - 1)
    const merged = options.merge({ envelopes: { [dockLayoutKeyOf(key)]: stale } }, current)
    expect(merged.envelopes).toEqual({})

    // A first run, or a cleared storage slot, must not throw.
    expect(options.merge(undefined, current).envelopes).toEqual({})
    expect(options.merge({}, current).envelopes).toEqual({})
  })
})
