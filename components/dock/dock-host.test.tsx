/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type React from "react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

/**
 * dockview measures real boxes and mounts panels through its own portal
 * machinery, neither of which jsdom provides. The stub keeps the *contract*
 * this component depends on — a static component registry resolved by name, an
 * imperative api handed over on ready, and panel add/remove/serialise — so the
 * wiring under test is real while the layout engine is not.
 */
interface StubPanel {
  id: string
  component: string
  title?: string
  renderer?: string
}
const stub = {
  panels: [] as StubPanel[],
  layoutListeners: [] as Array<() => void>,
  fromJSONCalls: [] as unknown[],
  fromJSONThrows: false,
  cleared: 0,
  setActiveCalls: [] as string[],
  removed: [] as string[],
  disposedListeners: 0,
  activePanelListener: null as ((event: { panel?: { id: string } }) => void) | null,
  components: {} as Record<string, React.ComponentType<{ api: { id: string } }>>,
}

jest.mock("dockview-react", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    __esModule: true,
    DockviewReact: ({
      components,
      tabComponents,
      onReady,
    }: {
      components: Record<string, React.ComponentType<{ api: { id: string } }>>
      tabComponents: Record<string, React.ComponentType<{ api: { id: string } }>>
      onReady: (event: { api: unknown }) => void
    }) => {
      const readyRef = React.useRef(false)
      const [, force] = React.useReducer((n: number) => n + 1, 0)
      stub.components = components

      const api = React.useMemo(
        () => ({
          get panels() {
            return stub.panels.map((panel) => ({ ...panel, api: { id: panel.id } }))
          },
          getPanel: (id: string) => {
            const panel = stub.panels.find((p) => p.id === id)
            return panel
              ? { ...panel, api: { id, setActive: () => stub.setActiveCalls.push(id) } }
              : undefined
          },
          addPanel: (options: StubPanel) => {
            stub.panels.push(options)
            force()
          },
          removePanel: (panel: { id: string }) => {
            stub.removed.push(panel.id)
            stub.panels = stub.panels.filter((p) => p.id !== panel.id)
            force()
          },
          fromJSON: (data: unknown) => {
            stub.fromJSONCalls.push(data)
            if (stub.fromJSONThrows) throw new Error("bad layout")
          },
          toJSON: () => ({ serialised: true }),
          clear: () => {
            stub.cleared += 1
          },
          onDidActivePanelChange: (listener: (event: { panel?: { id: string } }) => void) => {
            stub.activePanelListener = listener
            return { dispose: () => undefined }
          },
          onDidLayoutChange: (listener: () => void) => {
            stub.layoutListeners.push(listener)
            return {
              dispose: () => {
                stub.disposedListeners += 1
                stub.layoutListeners = stub.layoutListeners.filter((l) => l !== listener)
              },
            }
          },
        }),
        []
      )

      React.useEffect(() => {
        if (readyRef.current) return
        readyRef.current = true
        onReady({ api })
      }, [api, onReady])

      const Content = components["dock-panel"]!
      const Tab = tabComponents["dock-tab"]!
      return (
        <div data-testid="dockview">
          {stub.panels.map((panel) => (
            <div key={panel.id} data-renderer={panel.renderer}>
              <Tab api={{ id: panel.id }} />
              <Content api={{ id: panel.id }} />
            </div>
          ))}
        </div>
      )
    },
  }
})

import { DockHost, type DockHostProps } from "./dock-host"
import { useDockLayoutStore } from "@/stores/dock/dock-layout-store"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import type { DockLayoutKey } from "@/types/dock/layout"
import type { DockPanelDefinition } from "@/types/dock/panel"

const layoutKey: DockLayoutKey = { accountId: "acc", host: "chat", contextId: "s1" }
const resource: ContextResource = { kind: "session", sessionId: "s1", capabilities: [] }

function definition(id: string, overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id,
    activity: "review",
    labelKey: `dock.panels.${id}`,
    label: id.toUpperCase(),
    appliesTo: () => true,
    renderer: (() => <div data-testid={`body-${id}`} />) as ContextPanelDefinition["renderer"],
    ...overrides,
  }
}

let idCounter = 0
function renderHost(overrides: Partial<DockHostProps> = {}) {
  const props: DockHostProps = {
    workbenchInstanceId: "wb-1",
    layoutKey,
    resource,
    panels: [definition("review")],
    createInstanceId: () => `i${++idCounter}`,
    ...overrides,
  }
  return render(<DockHost {...props} />)
}

/** Seed the store as if the user already had these tabs open. */
function seedInstances(
  instances: Array<{ id: string; panelId: string; kind?: "panel" | "plugin-surface" }>
) {
  useDockLayoutStore.getState().setInstances(
    layoutKey,
    instances.map((i) => ({
      instanceId: i.id,
      panelId: i.panelId,
      kind: i.kind ?? "panel",
      mode: "pinned" as const,
      dirty: false,
      activated: false,
    }))
  )
}

beforeEach(() => {
  idCounter = 0
  stub.panels = []
  stub.layoutListeners = []
  stub.fromJSONCalls = []
  stub.fromJSONThrows = false
  stub.cleared = 0
  stub.setActiveCalls = []
  stub.removed = []
  stub.disposedListeners = 0
  stub.activePanelListener = null
  stub.components = {}
  useDockLayoutStore.setState({ envelopes: {}, histories: {}, lastRejection: {} })
})

describe("DockHost", () => {
  it("renders the activity rail for the activities its panels declare", () => {
    renderHost({
      panels: [
        definition("review", { activity: "review" }),
        definition("chat", { activity: "ai" }),
      ],
    })
    expect(screen.getByTestId("dock-rail-review")).toBeInTheDocument()
    expect(screen.getByTestId("dock-rail-ai")).toBeInTheDocument()
    // An activity no panel declares must not get a dead rail button.
    expect(screen.queryByTestId("dock-rail-templates")).toBeNull()
  })

  it("opens a panel when its rail button is pressed", () => {
    renderHost()
    fireEvent.click(screen.getByTestId("dock-rail-review"))
    expect(useDockLayoutStore.getState().getLayout(layoutKey)?.instances).toHaveLength(1)
    expect(stub.panels.map((p) => p.id)).toEqual(["i1"])
    expect(screen.getByTestId("body-review")).toBeInTheDocument()
  })

  it("materialises the instances the store already holds", () => {
    seedInstances([{ id: "seed-1", panelId: "review" }])
    renderHost()
    expect(stub.panels.map((p) => p.id)).toEqual(["seed-1"])
    expect(screen.getByTestId("dock-tab-seed-1")).toBeInTheDocument()
  })

  it("keeps a stateful panel mounted in the background and unmounts an ephemeral one", () => {
    // The Context Workbench's `<Activity>` behaviour, which panels rely on to
    // keep scroll position and in-flight work.
    seedInstances([
      { id: "keep", panelId: "review" },
      { id: "drop", panelId: "ephemeral" },
    ])
    renderHost({
      panels: [definition("review"), definition("ephemeral", { retention: "ephemeral" })],
    })
    expect(stub.panels.find((p) => p.id === "keep")?.renderer).toBe("always")
    expect(stub.panels.find((p) => p.id === "drop")?.renderer).toBe("onlyWhenVisible")
  })

  it("restores a persisted grid through the sanitiser", () => {
    seedInstances([{ id: "seed-1", panelId: "review" }])
    useDockLayoutStore.getState().setGrid(layoutKey, {
      grid: {
        root: { type: "leaf", data: { id: "g1", views: ["seed-1", "ghost"] } },
        width: 100,
        height: 100,
        orientation: "HORIZONTAL",
      },
      panels: { "seed-1": { id: "seed-1", params: { evil: true } } },
    })

    renderHost()

    const restored = stub.fromJSONCalls[0] as {
      panels: Record<string, { params: unknown; contentComponent: string }>
    }
    expect(Object.keys(restored.panels)).toEqual(["seed-1"])
    expect(restored.panels["seed-1"]!.params).toEqual({})
    expect(restored.panels["seed-1"]!.contentComponent).toBe("dock-panel")
  })

  it("falls back to an empty layout when a restore throws", () => {
    // A grid can survive sanitisation and still be impossible for this
    // viewport; an unusable dock is worse than the default one.
    seedInstances([{ id: "seed-1", panelId: "review" }])
    useDockLayoutStore.getState().setGrid(layoutKey, {
      grid: {
        root: { type: "leaf", data: { id: "g1", views: ["seed-1"] } },
        width: 1,
        height: 1,
        orientation: "HORIZONTAL",
      },
      panels: {},
    })
    stub.fromJSONThrows = true
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})

    renderHost()

    expect(stub.cleared).toBe(1)
    expect(stub.panels.map((p) => p.id)).toEqual(["seed-1"])
    consoleError.mockRestore()
  })

  it("does not call fromJSON when there is nothing persisted", () => {
    renderHost()
    expect(stub.fromJSONCalls).toEqual([])
  })

  it("persists the grid once a layout change settles", () => {
    jest.useFakeTimers()
    try {
      seedInstances([{ id: "seed-1", panelId: "review" }])
      renderHost()
      const before = useDockLayoutStore.getState().getLayout(layoutKey)!.revision

      // A burst of dockview emissions — a drag — must produce exactly one write.
      for (let i = 0; i < 20; i += 1) stub.layoutListeners.forEach((listener) => listener())
      expect(useDockLayoutStore.getState().getLayout(layoutKey)!.revision).toBe(before)

      jest.advanceTimersByTime(300)
      const after = useDockLayoutStore.getState().getLayout(layoutKey)!
      expect(after.revision).toBe(before + 1)
      expect(after.grid).toEqual({ serialised: true })
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops listening to dockview when it unmounts", () => {
    const { unmount } = renderHost()
    expect(stub.layoutListeners).toHaveLength(1)
    unmount()
    expect(stub.disposedListeners).toBe(1)
    expect(stub.layoutListeners).toHaveLength(0)
  })

  it("activates a tab through dockview when it is selected", () => {
    seedInstances([{ id: "seed-1", panelId: "review" }])
    renderHost()
    fireEvent.click(screen.getByRole("tab", { name: "REVIEW" }))
    expect(stub.setActiveCalls).toEqual(["seed-1"])
  })

  it("removes the dockview panel only after the table let the instance go", () => {
    seedInstances([{ id: "seed-1", panelId: "review" }])
    renderHost({ confirmDiscard: () => false })
    useDockLayoutStore.getState().commit(layoutKey, {
      baseRevision: useDockLayoutStore.getState().getLayout(layoutKey)!.revision,
      label: "test.dirty",
      apply: (current) => ({
        ...current,
        instances: current.instances.map((i) => ({ ...i, dirty: true })),
      }),
    })

    fireEvent.click(screen.getByTestId("dock-tab-close-seed-1"))

    // The confirmation refused, so neither the table nor dockview dropped it.
    expect(useDockLayoutStore.getState().getLayout(layoutKey)?.instances).toHaveLength(1)
    expect(stub.removed).toEqual([])
  })

  it("removes the dockview panel when the close is allowed", () => {
    seedInstances([{ id: "seed-1", panelId: "review" }])
    renderHost()
    fireEvent.click(screen.getByTestId("dock-tab-close-seed-1"))
    expect(useDockLayoutStore.getState().getLayout(layoutKey)?.instances).toHaveLength(0)
    expect(stub.removed).toEqual(["seed-1"])
  })

  it("drops a dockview panel the instance table no longer knows about", () => {
    // The table is authoritative: a stale dockview panel must not survive.
    seedInstances([{ id: "seed-1", panelId: "review" }])
    const { rerender } = renderHost()
    expect(stub.panels.map((p) => p.id)).toEqual(["seed-1"])

    seedInstances([])
    rerender(
      <DockHost
        workbenchInstanceId="wb-1"
        layoutKey={layoutKey}
        resource={resource}
        panels={[definition("review")]}
      />
    )
    expect(stub.panels).toEqual([])
  })

  it("renders only the rail when collapsed, dropping the grid entirely", () => {
    // The body unmounts rather than hides — a native-surface panel's webview
    // lease is only released by an unmount (ADR-0098).
    seedInstances([{ id: "seed-1", panelId: "review" }])
    renderHost({ railOnly: true })
    expect(screen.getByTestId("dock-activity-rail")).toBeInTheDocument()
    expect(screen.queryByTestId("dock-grid")).toBeNull()
    expect(screen.queryByTestId("dockview")).toBeNull()
  })

  it("honours a host-supplied rail order", () => {
    renderHost({
      panels: [
        definition("review", { activity: "review" }),
        definition("chat", { activity: "ai" }),
      ],
      railOrder: ["ai", "review"],
    })
    const buttons = screen.getAllByRole("button")
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "dock-rail-ai",
      "dock-rail-review",
    ])
  })

  it("gives a rail button to the first panel of each activity", () => {
    renderHost({
      panels: [
        definition("review-a", { activity: "review", order: 10 }),
        definition("review-b", { activity: "review", order: 20 }),
      ],
    })
    fireEvent.click(screen.getByTestId("dock-rail-review"))
    const instances = useDockLayoutStore.getState().getLayout(layoutKey)!.instances
    expect(instances.map((i) => i.panelId)).toEqual(["review-a"])
  })

  it("renders a rail button for a plugin activity that has no built-in icon", () => {
    renderHost({
      panels: [definition("acme", { activity: "acme.custom", pluginId: "acme" })],
      railOrder: ["acme.custom"],
    })
    const button = screen.getByTestId("dock-rail-acme.custom")
    expect(button).toHaveTextContent("acme.custom")
    expect(button.querySelector("svg")).toBeNull()
  })

  it("tracks the active tab from dockview's own event", () => {
    seedInstances([
      { id: "a", panelId: "review" },
      { id: "b", panelId: "second" },
    ])
    renderHost({ panels: [definition("review"), definition("second")] })

    act(() => stub.activePanelListener?.({ panel: { id: "a" } }))
    fireEvent.click(screen.getByTestId("dock-rail-review"))
    expect(screen.getByTestId("dock-tab-a").querySelector('[role="tab"]')).toHaveAttribute(
      "aria-selected",
      "true"
    )

    act(() => stub.activePanelListener?.({}))
    fireEvent.click(screen.getByTestId("dock-rail-review"))
    // With nothing active, the last instance wins rather than leaving the strip
    // with no selected tab at all.
    expect(screen.getByTestId("dock-tab-b").querySelector('[role="tab"]')).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("throws a developer-facing error if a panel renders outside the host", () => {
    // The only way this surfaces is a dockview portal escaping the tree; a
    // silent blank panel would be far harder to diagnose.
    renderHost()
    const Panel = stub.components["dock-panel"]!
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Panel api={{ id: "i1" }} />)).toThrow(/outside a DockHost/)
    consoleError.mockRestore()
  })

  it("keeps the dock in sync when it reopens from rail-only", () => {
    seedInstances([{ id: "seed-1", panelId: "review" }])
    const { rerender } = renderHost({ railOnly: true })
    expect(stub.panels).toEqual([])

    rerender(
      <DockHost
        workbenchInstanceId="wb-1"
        layoutKey={layoutKey}
        resource={resource}
        panels={[definition("review")]}
        railOnly={false}
      />
    )
    expect(stub.panels.map((p) => p.id)).toEqual(["seed-1"])
  })

  it("drops a settled write whose dock is already gone", () => {
    jest.useFakeTimers()
    try {
      seedInstances([{ id: "seed-1", panelId: "review" }])
      const { unmount } = renderHost()
      const listeners = [...stub.layoutListeners]
      const before = useDockLayoutStore.getState().getLayout(layoutKey)!.revision
      unmount()
      listeners.forEach((listener) => listener())
      jest.advanceTimersByTime(300)
      expect(useDockLayoutStore.getState().getLayout(layoutKey)!.revision).toBe(before)
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows a placeholder for an instance whose panel disappeared", () => {
    seedInstances([{ id: "seed-1", panelId: "acme.notes", kind: "plugin-surface" }])
    renderHost({ panels: [definition("review")] })
    expect(screen.getByTestId("dock-panel-unavailable")).toHaveAttribute("data-reason", "plugin")
  })
})
