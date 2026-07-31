/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { create } from "zustand"
import { temporal } from "zundo"
import type { EditorStore } from "@/lib/workflow/editor/store"

const mockInspectorMountEffect = jest.fn()

// Mock the three lazy-loaded tabs + the eagerly-imported InspectorPanel so
// the test focuses on the sidebar's own tab-switch + memo behaviour without
// loading the chat / templates / changelog dependency graphs.
jest.mock("./chat-tab", () => ({
  WorkflowEditorChatTab: () => <div data-testid="mock-chat-tab" />,
}))
jest.mock("./templates-tab", () => ({
  TemplatesTab: () => <div data-testid="mock-templates-tab" />,
}))
jest.mock("./changelog-tab", () => ({
  ChangelogTab: () => <div data-testid="mock-changelog-tab" />,
}))
jest.mock("./problems-tab", () => ({
  ProblemsTab: () => <div data-testid="mock-problems-tab" />,
}))
jest.mock("./runs-tab", () => ({
  RunsTab: () => <div data-testid="mock-runs-tab" />,
}))
jest.mock("./settings-tab", () => ({
  SettingsTab: () => <div data-testid="mock-settings-tab" />,
}))
jest.mock("@/components/context-workbench/context-comments-panel", () => ({
  ContextCommentsPanel: ({ anchor }: { anchor?: { kind: string } }) => (
    <div data-testid="mock-comments-panel" data-anchor-kind={anchor?.kind} />
  ),
}))
jest.mock("../inspector-panel", () => ({
  InspectorPanel: ({ useStore }: { useStore: EditorStore }) => {
    const { useEffect } = jest.requireActual<typeof import("react")>("react")
    useEffect(() => {
      mockInspectorMountEffect(useStore)
    }, [useStore])
    return <div data-testid="mock-inspector-panel" />
  },
}))
jest.mock("../edge-inspector", () => ({
  EdgeInspector: () => <div data-testid="mock-edge-inspector" />,
}))

// Mock useWorkflowEditorSession (referenced transitively through any chat
// surface) so the chat-tab mock doesn't pull in chat plumbing.
jest.mock("@/hooks/chat/use-workflow-editor-session", () => ({
  useWorkflowEditorSession: () => ({ session: null, loading: false }),
}))

// Imported after the mocks so the real module resolves them.
import { RightSidebar } from "./index"

const MESSAGES = {
  contextWorkbench: {
    actions: {
      collapse: "Collapse",
      focus: "Focus",
      narrow: "Narrow",
      pin: "Pin",
      retry: "Retry",
      unpin: "Unpin",
      wide: "Wide",
    },
    panelError: "Panel unavailable",
    panelErrorDescription: "Panel crashed",
  },
  workflowEditor: {
    rightSidebar: {
      tabs: {
        chat: "Chat",
        inspector: "Inspector",
        problems: "Problems",
        runs: "Runs",
        templates: "Templates",
        settings: "Settings",
        changelog: "Changelog",
      },
      chatLoading: "Loading…",
    },
  },
}

interface FakeState {
  nodes: []
  edges: []
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  baseWorkflow: { id: string; name: string }
  diagnostics?: { errorCount: number; warningCount: number; infoCount: number }
  requestedProblemsPanel?: boolean
  clearRequestedProblemsPanel?: () => void
  requestedInspectorPanel?: boolean
  clearRequestedInspectorPanel?: () => void
}

function makeFakeStore(
  initial: Omit<FakeState, "nodes" | "edges"> & Partial<Pick<FakeState, "nodes" | "edges">>
): EditorStore {
  // Build a minimal real Zustand store with zundo so the production
  // `useShallow` selector path is exercised verbatim.
  const useStore = create<FakeState>()(
    temporal(() => ({ nodes: [], edges: [], ...initial }), { limit: 1 })
  ) as unknown as EditorStore
  return useStore
}

function setSelectionCount(useStore: EditorStore, count: number) {
  const ids = Array.from({ length: count }, (_, i) => `n${i + 1}`)
  // The mock store accepts any partial — we cast to bypass the production
  // store's typed setter (which isn't wired in the fixture).
  ;(useStore as unknown as { setState: (s: Partial<FakeState>) => void }).setState({
    selectedNodeIds: ids,
  })
}

function setEdgeSelectionCount(useStore: EditorStore, count: number) {
  const ids = Array.from({ length: count }, (_, i) => `e${i + 1}`)
  ;(useStore as unknown as { setState: (s: Partial<FakeState>) => void }).setState({
    selectedEdgeIds: ids,
  })
}

function harness(
  useStore: EditorStore,
  placement?: React.ComponentProps<typeof RightSidebar>["placement"]
) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never} timeZone="UTC">
      <RightSidebar useStore={useStore} placement={placement} />
    </NextIntlClientProvider>
  )
}

describe("RightSidebar", () => {
  beforeEach(() => {
    mockInspectorMountEffect.mockReset()
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ workflow: false })
    )
  })

  it("uses the shared activity rail and preserves smart Inspector switching when enabled", async () => {
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ workflow: true })
    )
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_context", name: "Context" },
    })
    harness(store)

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()
    act(() => setSelectionCount(store, 1))
    expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()
  })

  it("does not remount a retained panel when its mount effect updates workflow metadata", () => {
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ workflow: true })
    )
    const store = makeFakeStore({
      selectedNodeIds: ["n1"],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_mount_effect", name: "Mount effect" },
    })
    mockInspectorMountEffect.mockImplementation((mountedStore: EditorStore) => {
      const current = mountedStore.getState().baseWorkflow
      ;(mountedStore as unknown as { setState: (s: Partial<FakeState>) => void }).setState({
        baseWorkflow: { ...current, name: `${current.name}!` },
      })
    })
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)

    harness(store)

    expect(
      consoleError.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes("Maximum update depth exceeded"))
      )
    ).toBe(false)
    expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()
    expect(mockInspectorMountEffect).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it("renders every workflow panel through a stable runtime-backed component", async () => {
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ workflow: true })
    )
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_all_panels", name: "All panels" },
    })
    const user = userEvent.setup()
    harness(store)

    await screen.findByTestId("mock-chat-tab")
    await user.click(screen.getByRole("button", { name: "Runs" }))
    expect(await screen.findByTestId("mock-runs-tab")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Changes" }))
    expect(await screen.findByTestId("mock-changelog-tab")).toBeInTheDocument()

    act(() => setSelectionCount(store, 1))
    await user.click(screen.getByRole("button", { name: "Comments" }))
    expect(screen.getByTestId("mock-comments-panel")).toHaveAttribute(
      "data-anchor-kind",
      "workflow-node"
    )
    act(() => {
      setSelectionCount(store, 0)
      setEdgeSelectionCount(store, 1)
    })
    expect(screen.getByTestId("mock-comments-panel")).toHaveAttribute(
      "data-anchor-kind",
      "workflow-edge"
    )

    await user.click(screen.getByRole("button", { name: "Templates" }))
    expect(await screen.findByTestId("mock-templates-tab")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Inspector" }))
    await user.click(screen.getByRole("tab", { name: "Problems" }))
    expect(await screen.findByTestId("mock-problems-tab")).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    expect(await screen.findByTestId("mock-settings-tab")).toBeInTheDocument()
  })

  it("opts the shared workbench into the sidebar background scope", () => {
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ workflow: true })
    )
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_background", name: "Background" },
    })
    harness(store)

    expect(screen.getByTestId("context-workbench")).toHaveAttribute("data-bg-target", "sidebar")
  })

  it("opts the legacy workflow sidebar into the sidebar background scope", () => {
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_legacy_background", name: "Background" },
    })
    harness(store)

    expect(screen.getByTestId("workflow-right-sidebar")).toHaveAttribute(
      "data-bg-target",
      "sidebar"
    )
  })

  it("uses mobile Sheet semantics without desktop layout controls", async () => {
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ workflow: true })
    )
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_mobile", name: "Mobile" },
    })
    harness(store, "mobile-sheet")

    expect(screen.getByTestId("context-workbench")).toHaveAttribute(
      "data-placement",
      "mobile-sheet"
    )
    expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Narrow" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Wide" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument()
  })

  describe("tab auto-switch (0 → ≥1 edge trigger)", () => {
    it("starts on Chat when selection is empty", async () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      const chatTrigger = screen.getByTestId("workflow-right-sidebar-tab-chat")
      expect(chatTrigger).toHaveAttribute("data-state", "active")
      // Chat tab is lazy-loaded → wait for the Suspense fallback to swap in
      // the mocked module.
      expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()
    })

    it("auto-switches to Inspector on the 0 → 1 transition", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      act(() => setSelectionCount(store, 1))
      const inspectorTrigger = screen.getByTestId("workflow-right-sidebar-tab-inspector")
      expect(inspectorTrigger).toHaveAttribute("data-state", "active")
    })

    it("does NOT re-trigger on internal selection growth (1 → 2)", async () => {
      const user = userEvent.setup()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)

      // 0 → 1 flips us to inspector (auto).
      act(() => setSelectionCount(store, 1))
      const inspectorTrigger = screen.getByTestId("workflow-right-sidebar-tab-inspector")
      expect(inspectorTrigger).toHaveAttribute("data-state", "active")

      // User manually moves to Chat while still having a node selected.
      const chatTrigger = screen.getByTestId("workflow-right-sidebar-tab-chat")
      await user.click(chatTrigger)
      expect(chatTrigger).toHaveAttribute("data-state", "active")

      // Selection grows 1 → 2 (e.g. shift-click). MUST stay on the
      // user's pinned Chat tab — the auto-switch only fires on 0 → ≥1.
      act(() => setSelectionCount(store, 2))
      expect(chatTrigger).toHaveAttribute("data-state", "active")
      expect(inspectorTrigger).not.toHaveAttribute("data-state", "active")
    })

    it("still auto-switches on every 0 → 1 cycle when chat was never explicitly pinned", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      const inspectorTrigger = screen.getByTestId("workflow-right-sidebar-tab-inspector")

      // 0 → 1: switches to inspector.
      act(() => setSelectionCount(store, 1))
      expect(inspectorTrigger).toHaveAttribute("data-state", "active")

      // 1 → 0: clear selection (stays on inspector by spec — clearing is
      // not a signal to switch back to chat).
      act(() => setSelectionCount(store, 0))
      expect(inspectorTrigger).toHaveAttribute("data-state", "active")

      // 0 → 1 again: still pre-pin, so the edge re-fires and we stay on
      // inspector (already there). The key behaviour under test: this
      // path still runs without erroring on a stale prev ref.
      act(() => setSelectionCount(store, 1))
      expect(inspectorTrigger).toHaveAttribute("data-state", "active")
    })
  })

  describe("edge selection routing", () => {
    it("auto-switches to Inspector and renders the EdgeInspector when only edges are selected", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      act(() => setEdgeSelectionCount(store, 1))
      const inspectorTrigger = screen.getByTestId("workflow-right-sidebar-tab-inspector")
      expect(inspectorTrigger).toHaveAttribute("data-state", "active")
      expect(screen.getByTestId("mock-edge-inspector")).toBeInTheDocument()
      expect(screen.queryByTestId("mock-inspector-panel")).toBeNull()
    })

    it("prefers the node InspectorPanel when both nodes and edges are selected", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      act(() => {
        setSelectionCount(store, 1)
        setEdgeSelectionCount(store, 2)
      })
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()
      expect(screen.queryByTestId("mock-edge-inspector")).toBeNull()
    })
  })

  describe("force-mounted chat panel layout", () => {
    it("removes the chat panel from layout when another tab is active", async () => {
      const user = userEvent.setup()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      // Chat starts active and lazy-mounts.
      expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()

      await user.click(screen.getByTestId("workflow-right-sidebar-tab-templates"))

      // The chat panel stays mounted (forceMount + Activity caching) …
      const chatPanel = screen.getByTestId("workflow-right-sidebar-panel-chat")
      expect(chatPanel).toHaveAttribute("data-state", "inactive")
      expect(screen.getByTestId("mock-chat-tab")).toBeInTheDocument()
      // … but MUST be display-noned while inactive. Radix never sets the
      // `hidden` attr on force-mounted panels, so without this class the
      // empty chat panel keeps its `flex-1` share of the column and the
      // active tab's content gets squeezed into the bottom half.
      expect(chatPanel.className).toMatch(/data-\[state=inactive\]:hidden/)
    })
  })

  describe("problems tab badge", () => {
    it("renders the Problems tab with no badge when the workflow is clean", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 0, warningCount: 0, infoCount: 0 },
      })
      harness(store)
      expect(screen.getByTestId("workflow-right-sidebar-tab-problems")).toBeInTheDocument()
      expect(screen.queryByTestId("workflow-problems-badge-error")).toBeNull()
      expect(screen.queryByTestId("workflow-problems-badge-warning")).toBeNull()
    })

    it("shows the error badge with the error count when errors exist", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 2, warningCount: 3, infoCount: 0 },
      })
      harness(store)
      expect(screen.getByTestId("workflow-problems-badge-error")).toHaveTextContent("2")
      // Error badge takes precedence over the warning badge.
      expect(screen.queryByTestId("workflow-problems-badge-warning")).toBeNull()
    })

    it("shows the warning badge when only warnings exist", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 0, warningCount: 4, infoCount: 0 },
      })
      harness(store)
      expect(screen.getByTestId("workflow-problems-badge-warning")).toHaveTextContent("4")
    })
  })

  describe("problems-panel signal", () => {
    it("switches to the Problems tab and clears the signal when requestedProblemsPanel is set", () => {
      const clearRequestedProblemsPanel = jest.fn()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 1, warningCount: 0, infoCount: 0 },
        requestedProblemsPanel: true,
        clearRequestedProblemsPanel,
      })
      harness(store)
      expect(screen.getByTestId("workflow-right-sidebar-tab-problems")).toHaveAttribute(
        "data-state",
        "active"
      )
      expect(clearRequestedProblemsPanel).toHaveBeenCalled()
    })
  })

  describe("inspector-panel signal", () => {
    it("switches to the Inspector tab over a pinned tab and clears the signal", async () => {
      const user = userEvent.setup()
      const clearRequestedInspectorPanel = jest.fn()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        clearRequestedInspectorPanel,
      })
      harness(store)

      // Pin the Runs tab manually — a plain selection would now be swallowed.
      await user.click(screen.getByTestId("workflow-right-sidebar-tab-runs"))
      expect(screen.getByTestId("workflow-right-sidebar-tab-runs")).toHaveAttribute(
        "data-state",
        "active"
      )

      // Explicit configure gesture fires the store signal.
      act(() => {
        ;(store as unknown as { setState: (s: Partial<FakeState>) => void }).setState({
          selectedNodeIds: ["n1"],
          requestedInspectorPanel: true,
        })
      })
      expect(screen.getByTestId("workflow-right-sidebar-tab-inspector")).toHaveAttribute(
        "data-state",
        "active"
      )
      expect(clearRequestedInspectorPanel).toHaveBeenCalled()
    })
  })

  describe("memo", () => {
    it("is wrapped in React.memo so parent re-renders with identical props don't re-run the inner tree", () => {
      // We can't directly observe React's bail-out, but we can confirm
      // the exported component is a memo wrapper by inspecting its
      // type marker. React tags memoized components with $$typeof
      // === Symbol.for('react.memo').
      const memoMarker = Symbol.for("react.memo")
      expect((RightSidebar as { $$typeof?: symbol }).$$typeof).toBe(memoMarker)
    })
  })
})
