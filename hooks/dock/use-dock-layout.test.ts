/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useDockLayout } from "./use-dock-layout"
import { useDockLayoutStore } from "@/stores/dock/dock-layout-store"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import type { DockLayoutKey } from "@/types/dock/layout"
import type { DockPanelDefinition } from "@/types/dock/panel"

const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

const key: DockLayoutKey = { accountId: "acc", host: "chat", contextId: "s1" }
const resource: ContextResource = { kind: "session", sessionId: "s1", capabilities: [] }

function definition(id: string, overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id,
    activity: "inspect",
    labelKey: `dock.panels.${id}`,
    appliesTo: () => true,
    renderer,
    ...overrides,
  }
}

let idCounter = 0
function setup(
  panels: DockPanelDefinition[] = [definition("review"), definition("preview")],
  options: Partial<Parameters<typeof useDockLayout>[0]> = {}
) {
  return renderHook(() =>
    useDockLayout({
      layoutKey: key,
      resource,
      panels,
      createInstanceId: () => `i${++idCounter}`,
      ...options,
    })
  )
}

beforeEach(() => {
  idCounter = 0
  useDockLayoutStore.setState({ envelopes: {}, histories: {}, lastRejection: {} })
})

describe("useDockLayout", () => {
  it("resolves the host's panels in rail order", () => {
    const { result } = setup([
      definition("inspect-panel", { activity: "inspect" }),
      definition("review-panel", { activity: "review" }),
    ])
    expect(result.current.panels.map((p) => p.definition.id)).toEqual([
      "review-panel",
      "inspect-panel",
    ])
    expect(result.current.panelsById.get("review-panel")).toBeDefined()
  })

  it("opens a panel on reveal and persists it as one transaction", () => {
    const { result } = setup()
    let outcome: unknown
    act(() => {
      outcome = result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    expect(outcome).toEqual({
      kind: "opened",
      instanceId: "i1",
      focused: true,
      evictedInstanceId: null,
    })
    expect(result.current.instances).toHaveLength(1)
    expect(result.current.revision).toBe(1)
  })

  it("reuses an open instance rather than stacking a second tab", () => {
    const { result } = setup()
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    expect(result.current.instances).toHaveLength(1)
  })

  it("does not commit anything for a reveal it cannot serve", () => {
    const { result } = setup()
    let outcome: unknown
    act(() => {
      outcome = result.current.reveal({ panelId: "ghost", source: "user", focus: "focus" })
    })
    expect(outcome).toMatchObject({ kind: "unavailable" })
    expect(result.current.revision).toBe(0)
  })

  it("badges instead of opening when the layout is pinned", () => {
    const { result, rerender } = setup(undefined, { userPinned: false })
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    rerender()

    // Re-render the hook with the layout pinned.
    const pinned = renderHook(() =>
      useDockLayout({
        layoutKey: key,
        resource,
        panels: [definition("review")],
        userPinned: true,
        createInstanceId: () => `p${++idCounter}`,
      })
    )
    act(() => {
      pinned.result.current.reveal({ panelId: "review", source: "automatic", focus: "focus" })
    })
    expect(pinned.result.current.instances[0]?.unread).toBe(1)
  })

  it("pins the preview slot", () => {
    const { result } = setup()
    act(() => {
      result.current.reveal({
        panelId: "review",
        source: "user",
        focus: "focus",
        mode: "preview",
      })
    })
    expect(result.current.instances[0]?.mode).toBe("preview")
    act(() => result.current.pin("i1"))
    expect(result.current.instances[0]?.mode).toBe("pinned")
  })

  it("closes a clean tab without asking", () => {
    const confirmDiscard = jest.fn(() => true)
    const { result } = setup(undefined, { confirmDiscard })
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    let closed = false
    act(() => {
      closed = result.current.close("i1")
    })
    expect(closed).toBe(true)
    expect(confirmDiscard).not.toHaveBeenCalled()
    expect(result.current.instances).toHaveLength(0)
  })

  it("asks before discarding unsaved work and honours a cancel", () => {
    // dockview removes panels synchronously, so this is the last point at which
    // the close can still be stopped.
    const confirmDiscard = jest.fn(() => false)
    const { result } = setup(undefined, { confirmDiscard })
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    act(() => result.current.setDirty("i1", true))

    let closed = true
    act(() => {
      closed = result.current.close("i1")
    })
    expect(closed).toBe(false)
    expect(confirmDiscard).toHaveBeenCalledWith([expect.objectContaining({ instanceId: "i1" })])
    expect(result.current.instances).toHaveLength(1)
  })

  it("closes a dirty tab once the user confirms", () => {
    const { result } = setup(undefined, { confirmDiscard: () => true })
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    act(() => result.current.setDirty("i1", true))
    act(() => {
      result.current.close("i1")
    })
    expect(result.current.instances).toHaveLength(0)
  })

  it("closes a dirty tab when the host offers no confirmation at all", () => {
    const { result } = setup()
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    act(() => result.current.setDirty("i1", true))
    act(() => {
      result.current.close("i1")
    })
    expect(result.current.instances).toHaveLength(0)
  })

  it("marks an instance activated exactly once", () => {
    const { result } = setup()
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    const before = result.current.revision
    act(() => result.current.markActivated("i1"))
    expect(result.current.instances[0]?.activated).toBe(true)
    const after = result.current.revision

    act(() => result.current.markActivated("i1"))
    expect(result.current.revision).toBe(after)
    expect(after).toBeGreaterThan(before)
  })

  it("skips a dirty write that changes nothing", () => {
    const { result } = setup()
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    const before = result.current.revision
    act(() => result.current.setDirty("i1", false))
    expect(result.current.revision).toBe(before)
  })

  it("drops instances whose panel stopped resolving and reports them", () => {
    const { result } = setup([definition("review"), definition("acme.notes", { pluginId: "acme" })])
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
      result.current.reveal({ panelId: "acme.notes", source: "user", focus: "focus" })
    })
    expect(result.current.instances).toHaveLength(2)

    const shrunk = renderHook(() =>
      useDockLayout({ layoutKey: key, resource, panels: [definition("review")] })
    )
    let dropped: unknown
    act(() => {
      dropped = shrunk.result.current.reconcile()
    })
    expect(dropped).toEqual([expect.objectContaining({ panelId: "acme.notes" })])
    expect(shrunk.result.current.instances.map((i) => i.panelId)).toEqual(["review"])
  })

  it("reconciles to a no-op when every panel still resolves", () => {
    const { result } = setup()
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    const before = result.current.revision
    let dropped: unknown
    act(() => {
      dropped = result.current.reconcile()
    })
    expect(dropped).toEqual([])
    expect(result.current.revision).toBe(before)
  })

  it("picks up a plugin panel registered after the hook mounted", () => {
    const { result } = setup([definition("review")])
    expect(result.current.panelsById.has("acme.late")).toBe(false)

    let dispose = () => {}
    act(() => {
      dispose = contextPanelRegistry.register(definition("acme.late", { pluginId: "acme" }))
    })
    expect(result.current.panelsById.has("acme.late")).toBe(true)

    act(() => dispose())
    expect(result.current.panelsById.has("acme.late")).toBe(false)
  })

  it("exposes undo and redo over structural changes only", () => {
    const { result } = setup()
    expect(result.current.canUndo).toBe(false)

    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    expect(result.current.canUndo).toBe(true)

    act(() => {
      result.current.undo()
    })
    expect(result.current.instances).toHaveLength(0)
    expect(result.current.canRedo).toBe(true)

    act(() => {
      result.current.redo()
    })
    expect(result.current.instances).toHaveLength(1)
  })

  it("mints an instance id without an injected factory", () => {
    const { result } = renderHook(() =>
      useDockLayout({ layoutKey: key, resource, panels: [definition("review")] })
    )
    act(() => {
      result.current.reveal({ panelId: "review", source: "user", focus: "focus" })
    })
    expect(result.current.instances[0]?.instanceId).toMatch(/^dock-/)
  })
})
