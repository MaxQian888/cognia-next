/** @jest-environment jsdom */
/**
 * Tests for A2UI Store
 */

import { act } from "@testing-library/react"
import {
  __resetA2UISurfacePersistenceForTesting,
  flushA2UISurfacePersistence,
  hydrateA2UISurfaceCache,
  useA2UIStore,
  selectSurface,
  selectActiveSurface,
  selectSurfaceComponents,
  selectSurfaceDataModel,
  selectIsSurfaceLoading,
  selectSurfaceError,
  selectEventHistory,
  selectRecentEvents,
} from "./a2ui-store"

const mockListDurableSurfaces = jest.fn()
const mockUpsertDurableSurface = jest.fn()
const mockDeleteDurableSurface = jest.fn()

jest.mock("@/lib/db/a2ui-surfaces", () => ({
  listSurfaces: (...args: unknown[]) => mockListDurableSurfaces(...args),
  upsertSurface: (...args: unknown[]) => mockUpsertDurableSurface(...args),
  deleteSurface: (...args: unknown[]) => mockDeleteDurableSurface(...args),
}))

const mockSettingsState: { settings: { a2uiPersistenceLimit?: number } } = {
  settings: { a2uiPersistenceLimit: 20 },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
}))

// Mock dependencies
jest.mock("@/lib/a2ui/parser", () => ({
  isCreateSurfaceMessage: (msg: { type: string }) => msg.type === "createSurface",
  isUpdateComponentsMessage: (msg: { type: string }) => msg.type === "updateComponents",
  isUpdateDataModelMessage: (msg: { type: string }) => msg.type === "dataModelUpdate",
  isDeleteSurfaceMessage: (msg: { type: string }) => msg.type === "deleteSurface",
  isSurfaceReadyMessage: (msg: { type: string }) => msg.type === "surfaceReady",
  isConnectorActionMessage: (msg: { type: string }) => msg.type === "connectorAction",
}))

jest.mock("@/lib/a2ui/data-model", () => ({
  setValueByPath: jest.fn((obj, path, value) => {
    const result = { ...obj }
    const segments = path.split("/").filter(Boolean)
    let current = result
    for (let i = 0; i < segments.length - 1; i++) {
      current[segments[i]] = current[segments[i]] || {}
      current = current[segments[i]]
    }
    current[segments[segments.length - 1]] = value
    return result
  }),
  getValueByPath: jest.fn((obj, path) => {
    const segments = path.split("/").filter(Boolean)
    let current = obj
    for (const segment of segments) {
      if (current && typeof current === "object") {
        current = current[segment]
      } else {
        return undefined
      }
    }
    return current
  }),
  deepMerge: jest.fn((target, source) => ({ ...target, ...source })),
  deepClone: jest.fn((obj) => JSON.parse(JSON.stringify(obj))),
}))

jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: { emitAction: jest.fn(), emitDataChange: jest.fn() },
  createUserAction: jest.fn((surfaceId, action, componentId, data) => ({
    type: "user_action",
    surfaceId,
    action,
    componentId,
    data,
    timestamp: Date.now(),
  })),
  createDataModelChange: jest.fn((surfaceId, path, value) => ({
    type: "data_model_change",
    surfaceId,
    path,
    value,
    timestamp: Date.now(),
  })),
}))

describe("useA2UIStore", () => {
  beforeEach(() => {
    __resetA2UISurfacePersistenceForTesting()
    mockListDurableSurfaces.mockReset().mockResolvedValue([])
    mockUpsertDurableSurface.mockReset().mockResolvedValue(undefined)
    mockDeleteDurableSurface.mockReset().mockResolvedValue(undefined)
    localStorage.clear()
    mockSettingsState.settings.a2uiPersistenceLimit = 20
    act(() => {
      useA2UIStore.getState().reset()
    })
  })

  describe("Dexie surface persistence", () => {
    const durableSurface = (id: string, updatedAt: number, title = id) => ({
      id,
      type: "panel" as const,
      title,
      components: { root: { id: "root", component: "Text", text: title } },
      dataModel: { title },
      rootId: "root",
      createdAt: 1,
      updatedAt,
    })

    it("hydrates from Dexie and merges by updatedAt with local state winning ties", async () => {
      mockListDurableSurfaces.mockResolvedValue([
        durableSurface("durable-newer", 10, "Dexie"),
        durableSurface("tie", 20, "Dexie tie"),
      ])
      useA2UIStore.setState({
        surfaces: {
          "durable-newer": { ...durableSurface("durable-newer", 5, "Local old"), ready: true },
          tie: { ...durableSurface("tie", 20, "Local tie"), ready: true },
        },
      })

      await expect(hydrateA2UISurfaceCache()).resolves.toBe(true)

      expect(useA2UIStore.getState().surfaces["durable-newer"].title).toBe("Dexie")
      expect(useA2UIStore.getState().surfaces.tie.title).toBe("Local tie")
    })

    it("caps hydrated ready surfaces to the configured LRU size", async () => {
      mockListDurableSurfaces.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => durableSurface(`surface-${index}`, index))
      )

      await hydrateA2UISurfaceCache()

      const ids = Object.keys(useA2UIStore.getState().surfaces)
      expect(ids).toHaveLength(20)
      expect(ids).toContain("surface-24")
      expect(ids).not.toContain("surface-0")
    })

    it("synchronizes ready writes and deletes after hydration", async () => {
      await hydrateA2UISurfaceCache()
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "panel")
        useA2UIStore
          .getState()
          .updateComponents("surface-1", [
            { id: "root", component: "Text", text: "Durable" } as never,
          ])
        useA2UIStore.getState().setSurfaceReady("surface-1")
      })
      await flushA2UISurfacePersistence()
      expect(mockUpsertDurableSurface).toHaveBeenCalledWith(
        expect.objectContaining({ id: "surface-1", type: "panel" })
      )

      act(() => useA2UIStore.getState().deleteSurface("surface-1"))
      await flushA2UISurfacePersistence()
      expect(mockDeleteDurableSurface).toHaveBeenCalledWith("surface-1")
    })

    it("keeps inline surfaces ephemeral", async () => {
      await hydrateA2UISurfaceCache()
      act(() => {
        useA2UIStore.getState().createSurface("inline-1", "inline")
        useA2UIStore
          .getState()
          .updateComponents("inline-1", [
            { id: "root", component: "Text", text: "Ephemeral" } as never,
          ])
        useA2UIStore.getState().setSurfaceReady("inline-1")
      })
      await flushA2UISurfacePersistence()
      expect(mockUpsertDurableSurface).not.toHaveBeenCalled()

      useA2UIStore.getState().flushPersistence()
      const persisted = JSON.parse(localStorage.getItem("cognia-a2ui-surfaces") || "{}")
      expect(persisted.state?.surfaces?.["inline-1"]).toBeUndefined()
    })

    it("degrades to local-only operation when Dexie hydration fails", async () => {
      mockListDurableSurfaces.mockRejectedValue(new Error("IndexedDB unavailable"))
      await expect(hydrateA2UISurfaceCache()).resolves.toBe(false)

      act(() => {
        useA2UIStore.getState().createSurface("local-only", "panel")
        useA2UIStore
          .getState()
          .updateComponents("local-only", [
            { id: "root", component: "Text", text: "Local" } as never,
          ])
        useA2UIStore.getState().setSurfaceReady("local-only")
      })
      await flushA2UISurfacePersistence()
      expect(useA2UIStore.getState().surfaces["local-only"]).toBeDefined()
      expect(mockUpsertDurableSurface).not.toHaveBeenCalled()
    })
  })

  describe("initial state", () => {
    it("has correct initial state", () => {
      const state = useA2UIStore.getState()
      expect(state.surfaces).toEqual({})
      expect(state.activeSurfaceId).toBeNull()
      expect(state.eventHistory).toEqual([])
    })
  })

  describe("createSurface", () => {
    it("should create a new surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog", { title: "Test" })
      })
      const state = useA2UIStore.getState()
      expect(state.surfaces["surface-1"]).toBeDefined()
      expect(state.surfaces["surface-1"].type).toBe("dialog")
      expect(state.activeSurfaceId).toBe("surface-1")
    })
  })

  describe("deleteSurface", () => {
    it("should delete a surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().deleteSurface("surface-1")
      })
      expect(useA2UIStore.getState().surfaces["surface-1"]).toBeUndefined()
    })

    it("should clear streaming state for deleted surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setSurfaceStreaming("surface-1", true)
        useA2UIStore.getState().deleteSurface("surface-1")
      })

      expect(useA2UIStore.getState().streamingSurfaces["surface-1"]).toBeUndefined()
    })
  })

  describe("updateComponents", () => {
    it("should update components on a surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore
          .getState()
          .updateComponents("surface-1", [
            { id: "comp-1", type: "Button", props: { label: "Click" } } as never,
          ])
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].components["comp-1"]).toBeDefined()
    })
  })

  describe("component-tree mutations", () => {
    beforeEach(() => {
      useA2UIStore.setState({
        surfaces: {
          "surface-1": {
            id: "surface-1",
            type: "inline",
            components: {
              root: {
                id: "root",
                component: "Column",
                children: ["group", "overlay", "trigger"],
              },
              group: { id: "group", component: "Card", children: ["child"] },
              child: { id: "child", component: "Text", text: "Child" },
              overlay: {
                id: "overlay",
                component: "Popover",
                trigger: "trigger",
                children: ["overlay-content"],
              } as never,
              trigger: { id: "trigger", component: "Button", text: "Open", action: "open" },
              "overlay-content": {
                id: "overlay-content",
                component: "Text",
                text: "Content",
              },
            },
            dataModel: {},
            rootId: "root",
            createdAt: 1,
            updatedAt: 1,
            ready: true,
          },
        },
        undoStacks: {},
        redoStacks: {},
      })
    })

    it("deletes a complete subtree and restores it through undo", () => {
      let removed = false
      act(() => {
        removed = useA2UIStore.getState().removeComponent("surface-1", "group")
      })

      expect(removed).toBe(true)
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect(updated.components.group).toBeUndefined()
      expect(updated.components.child).toBeUndefined()
      expect((updated.components.root as { children: string[] }).children).toEqual([
        "overlay",
        "trigger",
      ])
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => {
        useA2UIStore.getState().undo("surface-1")
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].components.group).toBeDefined()
      expect(useA2UIStore.getState().surfaces["surface-1"].components.child).toBeDefined()
    })

    it("cascades deletion through required trigger references", () => {
      let removed = false
      act(() => {
        removed = useA2UIStore.getState().removeComponent("surface-1", "trigger")
      })

      expect(removed).toBe(true)
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect(updated.components.trigger).toBeUndefined()
      expect(updated.components.overlay).toBeUndefined()
      expect(updated.components["overlay-content"]).toBeUndefined()
      expect((updated.components.root as { children: string[] }).children).toEqual(["group"])
    })

    it("rejects deleting the root component", () => {
      let removed = true
      act(() => {
        removed = useA2UIStore.getState().removeComponent("surface-1", "root")
      })
      expect(removed).toBe(false)
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toBeUndefined()
    })

    it("duplicates a subtree with collision-safe ids and remapped child references", () => {
      useA2UIStore.setState((state) => ({
        surfaces: {
          ...state.surfaces,
          "surface-1": {
            ...state.surfaces["surface-1"],
            components: {
              ...state.surfaces["surface-1"].components,
              "group-copy": {
                id: "group-copy",
                component: "Text",
                text: "Existing collision",
              },
            },
          },
        },
      }))

      let duplicateId: string | null = null
      act(() => {
        duplicateId = useA2UIStore.getState().duplicateComponent("surface-1", "group")
      })

      expect(duplicateId).toBe("group-copy-2")
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect((updated.components.root as { children: string[] }).children).toEqual([
        "group",
        "group-copy-2",
        "overlay",
        "trigger",
      ])
      expect(updated.components["group-copy-2"]).toMatchObject({
        id: "group-copy-2",
        children: ["child-copy"],
      })
      expect(updated.components["child-copy"]).toMatchObject({
        id: "child-copy",
        component: "Text",
      })
      expect(updated.components["group-copy-2"]).not.toBe(updated.components.group)
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => {
        useA2UIStore.getState().undo("surface-1")
      })
      expect(
        useA2UIStore.getState().surfaces["surface-1"].components["group-copy-2"]
      ).toBeUndefined()
    })

    it("rejects duplicating the root or a component attached only through a required slot", () => {
      expect(useA2UIStore.getState().duplicateComponent("surface-1", "root")).toBeNull()
      useA2UIStore.setState((state) => ({
        surfaces: {
          ...state.surfaces,
          "surface-1": {
            ...state.surfaces["surface-1"],
            components: {
              ...state.surfaces["surface-1"].components,
              root: {
                id: "root",
                component: "Popover",
                trigger: "trigger",
                children: ["group"],
              } as never,
            },
          },
        },
      }))

      expect(useA2UIStore.getState().duplicateComponent("surface-1", "trigger")).toBeNull()
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toBeUndefined()
    })

    it("adds a component at an explicit collection placement and restores through undo", () => {
      let added = false
      act(() => {
        added = useA2UIStore
          .getState()
          .addComponent(
            "surface-1",
            { id: "inserted", component: "Text", text: "Inserted" },
            { parentId: "root", slotId: "/children", index: 1 }
          )
      })

      expect(added).toBe(true)
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect(updated.components.inserted).toMatchObject({ component: "Text", text: "Inserted" })
      expect((updated.components.root as { children: string[] }).children).toEqual([
        "group",
        "inserted",
        "overlay",
        "trigger",
      ])
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => useA2UIStore.getState().undo("surface-1"))
      expect(useA2UIStore.getState().surfaces["surface-1"].components.inserted).toBeUndefined()
    })

    it("adds a complete referenced subtree as one undoable transaction", () => {
      let added = false
      act(() => {
        added = useA2UIStore.getState().addComponentSubtree(
          "surface-1",
          [
            {
              id: "new-popover",
              component: "Popover",
              trigger: "new-trigger",
              children: ["new-content"],
            } as never,
            {
              id: "new-trigger",
              component: "Button",
              text: "Open",
              action: "open",
            },
            { id: "new-content", component: "Text", text: "Content" },
          ],
          "new-popover",
          { parentId: "root", slotId: "/children", index: 1 }
        )
      })

      expect(added).toBe(true)
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect((updated.components.root as { children: string[] }).children).toEqual([
        "group",
        "new-popover",
        "overlay",
        "trigger",
      ])
      expect(updated.components["new-popover"]).toMatchObject({
        trigger: "new-trigger",
        children: ["new-content"],
      })
      expect(updated.components["new-trigger"]).toBeDefined()
      expect(updated.components["new-content"]).toBeDefined()
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => useA2UIStore.getState().undo("surface-1"))
      expect(
        useA2UIStore.getState().surfaces["surface-1"].components["new-popover"]
      ).toBeUndefined()
      expect(
        useA2UIStore.getState().surfaces["surface-1"].components["new-trigger"]
      ).toBeUndefined()
      expect(
        useA2UIStore.getState().surfaces["surface-1"].components["new-content"]
      ).toBeUndefined()
    })

    it("rejects malformed component subtrees without partial insertion", () => {
      const add = (components: never[], rootId: string, slotId = "/children") =>
        useA2UIStore.getState().addComponentSubtree("surface-1", components, rootId, {
          parentId: "root",
          slotId,
        })

      expect(
        add(
          [
            { id: "duplicate", component: "Text", text: "A" },
            { id: "duplicate", component: "Text", text: "B" },
          ] as never[],
          "duplicate"
        )
      ).toBe(false)
      expect(add([{ id: "group", component: "Text", text: "Collision" }] as never[], "group")).toBe(
        false
      )
      expect(
        add([{ id: "not-root", component: "Text", text: "Detached" }] as never[], "missing")
      ).toBe(false)
      expect(
        add(
          [{ id: "missing-ref-root", component: "Column", children: ["missing"] }] as never[],
          "missing-ref-root"
        )
      ).toBe(false)
      expect(
        add(
          [
            { id: "bundle-root", component: "Column", children: [] },
            { id: "detached", component: "Text", text: "Detached" },
          ] as never[],
          "bundle-root"
        )
      ).toBe(false)
      expect(
        add(
          [
            { id: "cycle-a", component: "Column", children: ["cycle-b"] },
            { id: "cycle-b", component: "Column", children: ["cycle-a"] },
          ] as never[],
          "cycle-a"
        )
      ).toBe(false)
      expect(
        add(
          [{ id: "parent-cycle", component: "Column", children: ["root"] }] as never[],
          "parent-cycle"
        )
      ).toBe(false)
      expect(
        add(
          [{ id: "stale-root", component: "Text", text: "Stale" }] as never[],
          "stale-root",
          "/footer"
        )
      ).toBe(false)

      const current = useA2UIStore.getState()
      expect(current.surfaces["surface-1"].components["bundle-root"]).toBeUndefined()
      expect(current.surfaces["surface-1"].components["cycle-a"]).toBeUndefined()
      expect(current.surfaces["surface-1"].components["parent-cycle"]).toBeUndefined()
      expect(current.undoStacks["surface-1"]).toBeUndefined()
    })

    it("wraps a leaf surface root with an inserted subtree and restores the original root", () => {
      useA2UIStore.setState((state) => ({
        surfaces: {
          ...state.surfaces,
          "surface-1": {
            ...state.surfaces["surface-1"],
            rootId: "child",
            components: {
              child: state.surfaces["surface-1"].components.child,
              "root-layout": { id: "root-layout", component: "Text", text: "Collision" },
            },
          },
        },
      }))

      let added = false
      act(() => {
        added = useA2UIStore
          .getState()
          .addComponentSubtreeToRoot(
            "surface-1",
            [{ id: "new-card", component: "Card", children: [] }],
            "new-card"
          )
      })

      expect(added).toBe(true)
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect(updated.rootId).toBe("root-layout-2")
      expect(updated.components["root-layout-2"]).toMatchObject({
        component: "Column",
        children: ["child", "new-card"],
      })
      expect(updated.components["new-card"]).toBeDefined()
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => useA2UIStore.getState().undo("surface-1"))
      const restored = useA2UIStore.getState().surfaces["surface-1"]
      expect(restored.rootId).toBe("child")
      expect(restored.components["root-layout-2"]).toBeUndefined()
      expect(restored.components["new-card"]).toBeUndefined()
    })

    it("rejects additions with missing references, cycles, duplicate ids, or stale slots", () => {
      const add = (component: never, slotId = "/children") =>
        useA2UIStore.getState().addComponent("surface-1", component, { parentId: "root", slotId })

      expect(
        add({ id: "missing-ref", component: "Column", children: ["does-not-exist"] } as never)
      ).toBe(false)
      expect(add({ id: "cycle", component: "Column", children: ["root"] } as never)).toBe(false)
      expect(add({ id: "group", component: "Text", text: "Duplicate" } as never)).toBe(false)
      expect(
        add({ id: "stale-slot", component: "Text", text: "Stale" } as never, "/tabs/9/children")
      ).toBe(false)

      const current = useA2UIStore.getState()
      expect(current.surfaces["surface-1"].components["missing-ref"]).toBeUndefined()
      expect(current.surfaces["surface-1"].components.cycle).toBeUndefined()
      expect(current.surfaces["surface-1"].components["stale-slot"]).toBeUndefined()
      expect(current.undoStacks["surface-1"]).toBeUndefined()
    })

    it("moves a component between collection slots and restores through undo", () => {
      let moved = false
      act(() => {
        moved = useA2UIStore.getState().moveComponent("surface-1", "child", {
          parentId: "root",
          slotId: "/children",
          index: 1,
        })
      })

      expect(moved).toBe(true)
      const updated = useA2UIStore.getState().surfaces["surface-1"]
      expect((updated.components.group as { children: string[] }).children).toEqual([])
      expect((updated.components.root as { children: string[] }).children).toEqual([
        "group",
        "child",
        "overlay",
        "trigger",
      ])
      expect(updated.components.child).toBeDefined()
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => useA2UIStore.getState().undo("surface-1"))
      const restored = useA2UIStore.getState().surfaces["surface-1"]
      expect((restored.components.group as { children: string[] }).children).toEqual(["child"])
      expect((restored.components.root as { children: string[] }).children).toEqual([
        "group",
        "overlay",
        "trigger",
      ])
    })

    it("rejects root, descendant, missing, and stale-slot move targets atomically", () => {
      const move = (componentId: string, parentId: string, slotId = "/children") =>
        useA2UIStore.getState().moveComponent("surface-1", componentId, { parentId, slotId })

      expect(move("root", "group")).toBe(false)
      expect(move("group", "child")).toBe(false)
      expect(move("missing", "root")).toBe(false)
      expect(move("child", "missing")).toBe(false)
      expect(move("child", "root", "/tabs/9/children")).toBe(false)

      const current = useA2UIStore.getState()
      expect(
        (current.surfaces["surface-1"].components.group as { children: string[] }).children
      ).toEqual(["child"])
      expect(current.undoStacks["surface-1"]).toBeUndefined()
    })

    it("reorders within a slot by final index and ignores an exact no-op", () => {
      let moved = false
      act(() => {
        moved = useA2UIStore.getState().moveComponent("surface-1", "group", {
          parentId: "root",
          slotId: "/children",
          index: 2,
        })
      })

      expect(moved).toBe(true)
      expect(
        (
          useA2UIStore.getState().surfaces["surface-1"].components.root as {
            children: string[]
          }
        ).children
      ).toEqual(["overlay", "trigger", "group"])
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      const updatedAt = useA2UIStore.getState().surfaces["surface-1"].updatedAt
      act(() => {
        moved = useA2UIStore.getState().moveComponent("surface-1", "group", {
          parentId: "root",
          slotId: "/children",
          index: 2,
        })
      })

      expect(moved).toBe(false)
      expect(useA2UIStore.getState().surfaces["surface-1"].updatedAt).toBe(updatedAt)
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)
    })
  })

  describe("replaceSurfaceContent", () => {
    it("replaces the complete tree atomically and restores the previous root on undo", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "inline")
        useA2UIStore.getState().updateComponents("surface-1", [
          { id: "old-root", component: "Column", children: ["old-child"] },
          { id: "old-child", component: "Text", text: "Before" },
        ])
        useA2UIStore.getState().updateDataModel("surface-1", { value: "before" }, false)
        useA2UIStore.setState((state) => ({
          surfaces: {
            ...state.surfaces,
            "surface-1": { ...state.surfaces["surface-1"], rootId: "old-root" },
          },
        }))
      })

      act(() => {
        useA2UIStore.getState().replaceSurfaceContent(
          "surface-1",
          [
            { id: "root", component: "Column", children: ["new-child"] },
            { id: "new-child", component: "Text", text: "After" },
          ],
          { value: "after" },
          "root"
        )
      })

      const replaced = useA2UIStore.getState().surfaces["surface-1"]
      expect(replaced.rootId).toBe("root")
      expect(Object.keys(replaced.components)).toEqual(["root", "new-child"])
      expect(replaced.dataModel).toEqual({ value: "after" })
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(3)

      act(() => {
        useA2UIStore.getState().undo("surface-1")
      })

      const restored = useA2UIStore.getState().surfaces["surface-1"]
      expect(restored.rootId).toBe("old-root")
      expect(Object.keys(restored.components)).toEqual(["old-root", "old-child"])
      expect(restored.dataModel).toEqual({ value: "before" })
    })
  })

  describe("restoreSurface", () => {
    it("restores a complete persisted surface without creating undo history", () => {
      let restored = false
      act(() => {
        restored = useA2UIStore.getState().restoreSurface({
          id: "saved-app",
          type: "inline",
          title: "Saved App",
          components: {
            "saved-root": { id: "saved-root", component: "Column", children: ["saved-text"] },
            "saved-text": { id: "saved-text", component: "Text", text: "Durable" },
          },
          dataModel: { persisted: true },
          rootId: "saved-root",
          createdAt: 10,
          updatedAt: 20,
          ready: true,
        })
      })

      expect(restored).toBe(true)
      expect(useA2UIStore.getState().surfaces["saved-app"]).toMatchObject({
        rootId: "saved-root",
        dataModel: { persisted: true },
        ready: true,
      })
      expect(useA2UIStore.getState().undoStacks["saved-app"]).toBeUndefined()
      expect(useA2UIStore.getState().redoStacks["saved-app"]).toBeUndefined()
    })
  })

  describe("updateDataModel", () => {
    it("should update data model", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().updateDataModel("surface-1", { name: "John" })
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].dataModel.name).toBe("John")
    })
  })

  describe("setSurfaceReady", () => {
    it("should set surface as ready", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setSurfaceReady("surface-1")
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].ready).toBe(true)
    })
  })

  describe("setError", () => {
    it("should set error for surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setError("surface-1", "Error")
      })
      expect(useA2UIStore.getState().errors["surface-1"]).toBe("Error")
    })
  })

  describe("emitAction", () => {
    it("should add action to event history", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().emitAction("surface-1", "click", "button-1")
      })
      expect(useA2UIStore.getState().eventHistory).toHaveLength(1)
    })
  })

  describe("single-notification transactions", () => {
    it("fires exactly one store notification per mutating action", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })

      const listener = jest.fn()
      const unsubscribe = useA2UIStore.subscribe(listener)

      act(() => {
        useA2UIStore
          .getState()
          .updateComponents("surface-1", [
            { id: "comp-1", type: "Button", props: { label: "Click" } } as never,
          ])
      })
      expect(listener).toHaveBeenCalledTimes(1)

      act(() => {
        useA2UIStore.getState().updateDataModel("surface-1", { name: "John" })
      })
      expect(listener).toHaveBeenCalledTimes(2)

      act(() => {
        useA2UIStore.getState().setDataValue("surface-1", "/name", "Jane")
      })
      expect(listener).toHaveBeenCalledTimes(3)

      unsubscribe()
    })

    it("records undo snapshot and event history inside the same transaction", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().updateDataModel("surface-1", { name: "John" })
      })
      expect(useA2UIStore.getState().undoStacks["surface-1"]).toHaveLength(1)

      act(() => {
        useA2UIStore.getState().setDataValue("surface-1", "/name", "Jane")
      })
      expect(useA2UIStore.getState().eventHistory).toHaveLength(1)
      expect(useA2UIStore.getState().surfaces["surface-1"].dataModel.name).toBe("Jane")
    })
  })

  describe("processMessage: connectorAction", () => {
    it("injects an IM callback as a userAction (value carries the action id)", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().processMessage({
          type: "connectorAction",
          surfaceId: "surface-1",
          componentId: "approve-btn",
          actionType: "button",
          value: "approve",
          platform: "slack",
          triggerId: "t1",
          conversationKey: "ck",
          payload: { note: "ok" },
        })
      })
      const history = useA2UIStore.getState().eventHistory
      expect(history).toHaveLength(1)
      const event = history[0] as {
        action: string
        componentId: string
        data: Record<string, unknown>
      }
      expect(event.action).toBe("approve")
      expect(event.componentId).toBe("approve-btn")
      expect(event.data).toMatchObject({
        source: "connector",
        actionType: "button",
        value: "approve",
        platform: "slack",
        triggerId: "t1",
        conversationKey: "ck",
        payload: { note: "ok" },
      })
    })

    it("falls back to actionType when value is empty (submit/dismiss) and tolerates no componentId", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().processMessage({
          type: "connectorAction",
          surfaceId: "surface-1",
          actionType: "dismiss",
        })
      })
      const event = useA2UIStore.getState().eventHistory[0] as {
        action: string
        componentId: string
        data: Record<string, unknown>
      }
      expect(event.action).toBe("dismiss")
      expect(event.componentId).toBe("")
      expect(event.data).toEqual({ source: "connector", actionType: "dismiss" })
    })
  })

  describe("selectors", () => {
    it("should select surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectSurface("surface-1")(useA2UIStore.getState())).toBeDefined()
    })

    it("should select active surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectActiveSurface(useA2UIStore.getState())).toBeDefined()
    })

    it("should select surface components", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectSurfaceComponents("surface-1")(useA2UIStore.getState())).toEqual({})
    })

    it("should select surface data model", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectSurfaceDataModel("surface-1")(useA2UIStore.getState())).toEqual({})
    })

    it("should select surface loading state", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setSurfaceLoading("surface-1", true)
      })
      expect(selectIsSurfaceLoading("surface-1")(useA2UIStore.getState())).toBe(true)
    })

    it("should select surface error", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setError("surface-1", "Test error")
      })
      expect(selectSurfaceError("surface-1")(useA2UIStore.getState())).toBe("Test error")
    })

    it("should select event history", () => {
      expect(selectEventHistory(useA2UIStore.getState())).toEqual([])
    })

    it("should select recent events", () => {
      expect(selectRecentEvents(5)(useA2UIStore.getState())).toEqual([])
    })
  })

  describe("reset", () => {
    it("should reset to initial state", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().reset()
      })
      expect(useA2UIStore.getState().surfaces).toEqual({})
      expect(useA2UIStore.getState().activeSurfaceId).toBeNull()
    })
  })

  describe("processMessageStream", () => {
    it("should clear streaming flags even when message processing throws", async () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.setState({
          processMessage: () => {
            throw new Error("stream failure")
          },
        } as Partial<ReturnType<typeof useA2UIStore.getState>>)
      })

      await expect(
        useA2UIStore
          .getState()
          .processMessageStream(
            [{ type: "updateComponents", surfaceId: "surface-1", components: [] }],
            0
          )
      ).rejects.toThrow("stream failure")

      expect(useA2UIStore.getState().streamingSurfaces["surface-1"]).toBeUndefined()
    })
  })

  describe("persist rehydrate normalization", () => {
    it("should normalize metadata-only surface to non-ready state", async () => {
      localStorage.setItem(
        "cognia-a2ui-surfaces",
        JSON.stringify({
          state: {
            surfaces: {
              "surface-meta": {
                id: "surface-meta",
                type: "panel",
                rootId: "root",
                createdAt: 1,
                updatedAt: 2,
                ready: true,
              },
            },
            activeSurfaceId: "surface-meta",
          },
          version: 2,
        })
      )

      await act(async () => {
        await (
          useA2UIStore as unknown as { persist: { rehydrate: () => Promise<void> } }
        ).persist.rehydrate()
      })

      const surface = useA2UIStore.getState().surfaces["surface-meta"]
      expect(surface).toBeDefined()
      expect(surface.ready).toBe(false)
      expect(surface.components).toEqual({})
      expect(useA2UIStore.getState().activeSurfaceId).toBe("surface-meta")
    })
  })

  describe("persist round-trip (surface survives reload)", () => {
    it("honors the configured LRU surface limit", () => {
      mockSettingsState.settings.a2uiPersistenceLimit = 5

      act(() => {
        for (let index = 0; index < 7; index += 1) {
          const surfaceId = `surface-${index}`
          useA2UIStore.getState().createSurface(surfaceId, "panel")
          useA2UIStore
            .getState()
            .updateComponents(surfaceId, [
              { id: `root-${index}`, component: "Text", text: String(index) },
            ])
          useA2UIStore.getState().setSurfaceReady(surfaceId)
        }
      })

      const raw = localStorage.getItem("cognia-a2ui-surfaces")
      expect(raw).toBeTruthy()
      expect(Object.keys(JSON.parse(raw as string).state.surfaces)).toHaveLength(5)
    })

    it("rewrites durable state immediately when the persistence limit changes", () => {
      act(() => {
        for (let index = 0; index < 7; index += 1) {
          const surfaceId = `surface-${index}`
          useA2UIStore.getState().createSurface(surfaceId, "panel")
          useA2UIStore
            .getState()
            .updateComponents(surfaceId, [
              { id: `root-${index}`, component: "Text", text: String(index) },
            ])
          useA2UIStore.getState().setSurfaceReady(surfaceId)
        }
      })

      expect(
        Object.keys(
          JSON.parse(localStorage.getItem("cognia-a2ui-surfaces") as string).state.surfaces
        )
      ).toHaveLength(7)

      mockSettingsState.settings.a2uiPersistenceLimit = 5
      act(() => useA2UIStore.getState().flushPersistence())

      expect(
        Object.keys(
          JSON.parse(localStorage.getItem("cognia-a2ui-surfaces") as string).state.surfaces
        )
      ).toHaveLength(5)
    })

    it("persists the component tree + data model, not just metadata", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "panel", { title: "Calc" })
        useA2UIStore
          .getState()
          .updateComponents("surface-1", [
            { id: "root", component: "Button", text: "1", action: "input_1" } as never,
          ])
        useA2UIStore.getState().updateDataModel("surface-1", { display: "0" })
        useA2UIStore.getState().setSurfaceReady("surface-1")
      })

      // partialize output is the ONLY durable copy — it must carry the heavy
      // data, otherwise the surface rehydrates empty and never becomes ready.
      const raw = localStorage.getItem("cognia-a2ui-surfaces")
      expect(raw).toBeTruthy()
      const persistedSurface = JSON.parse(raw as string).state.surfaces["surface-1"]
      expect(persistedSurface.components.root).toBeDefined()
      expect(persistedSurface.dataModel.display).toBe("0")
      expect(persistedSurface.ready).toBe(true)
    })

    it("rehydrates a full surface back to a ready, renderable state", async () => {
      localStorage.setItem(
        "cognia-a2ui-surfaces",
        JSON.stringify({
          state: {
            surfaces: {
              "surface-full": {
                id: "surface-full",
                type: "panel",
                rootId: "root",
                components: { root: { id: "root", component: "Button", text: "1" } },
                dataModel: { display: "0" },
                createdAt: 1,
                updatedAt: 2,
                ready: true,
              },
            },
            activeSurfaceId: "surface-full",
          },
          version: 3,
        })
      )

      await act(async () => {
        await (
          useA2UIStore as unknown as { persist: { rehydrate: () => Promise<void> } }
        ).persist.rehydrate()
      })

      const surface = useA2UIStore.getState().surfaces["surface-full"]
      expect(surface).toBeDefined()
      expect(surface.ready).toBe(true)
      expect(surface.components.root).toBeDefined()
      expect(surface.dataModel.display).toBe("0")
      expect(useA2UIStore.getState().activeSurfaceId).toBe("surface-full")
    })
  })
})
