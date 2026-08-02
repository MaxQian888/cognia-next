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
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

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

/**
 * The rail groups `inspector`, `problems` and `settings` under one `inspect`
 * activity, so the rail button's badge is the sum of every panel's badge in
 * that group. Tests that care about one panel's count therefore park the
 * others at zero rather than reading a per-panel badge that no longer exists.
 */
function inspectRailButton(): HTMLElement {
  return screen.getByRole("button", { name: "Inspector" })
}

describe("RightSidebar", () => {
  beforeEach(() => {
    mockInspectorMountEffect.mockReset()
    window.localStorage.clear()
    useContextWorkbenchStore.setState({ layouts: {}, sessionOverrides: {} })
  })

  it("renders the shared activity rail and opens on Chat with an empty selection", async () => {
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_context", name: "Context" },
    })
    harness(store)

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()
  })

  it("opts the workbench into the sidebar background scope", () => {
    const store = makeFakeStore({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      baseWorkflow: { id: "wf_background", name: "Background" },
    })
    harness(store)

    expect(screen.getByTestId("context-workbench")).toHaveAttribute("data-bg-target", "sidebar")
  })

  it("does not remount a retained panel when its mount effect updates workflow metadata", () => {
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

    await user.click(inspectRailButton())
    await user.click(screen.getByRole("tab", { name: "Problems" }))
    expect(await screen.findByTestId("mock-problems-tab")).toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    expect(await screen.findByTestId("mock-settings-tab")).toBeInTheDocument()
  })

  it("uses mobile Sheet semantics without desktop layout controls", async () => {
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

  describe("inspector auto-reveal (0 → ≥1 edge trigger)", () => {
    it("reveals the Inspector on the 0 → 1 transition", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      act(() => setSelectionCount(store, 1))
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()
    })

    it("does NOT re-trigger on internal selection growth (1 → 2) once a panel is pinned", async () => {
      const user = userEvent.setup()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)

      // 0 → 1 reveals the inspector (auto).
      act(() => setSelectionCount(store, 1))
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()

      // The user moves back to Chat while a node is still selected. A rail
      // click is an explicit choice, so `smartReveal` records it as pinned.
      await user.click(screen.getByRole("button", { name: "Chat" }))
      expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()

      // Selection grows 1 → 2 (shift-click). The auto-reveal only fires on
      // 0 → ≥1, and a pinned panel would decline it anyway.
      act(() => setSelectionCount(store, 2))
      expect(screen.getByTestId("mock-chat-tab")).toBeInTheDocument()
    })

    it("still reveals on every 0 → 1 cycle while nothing is pinned", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)

      act(() => setSelectionCount(store, 1))
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()

      // Clearing is not a signal to go back to chat.
      act(() => setSelectionCount(store, 0))
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()

      // Re-firing the edge must not throw on a stale prev ref.
      act(() => setSelectionCount(store, 1))
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()
    })
  })

  describe("edge selection routing", () => {
    it("reveals the Inspector and renders the EdgeInspector when only edges are selected", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      act(() => setEdgeSelectionCount(store, 1))
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

  describe("retained chat panel", () => {
    it("keeps the chat panel mounted but inert once another panel is revealed", async () => {
      const user = userEvent.setup()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
      })
      harness(store)
      expect(await screen.findByTestId("mock-chat-tab")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Templates" }))
      expect(await screen.findByTestId("mock-templates-tab")).toBeInTheDocument()

      // `retention: "stateful"` keeps the panel behind `<Activity mode="hidden">`
      // so an in-flight conversation survives the switch …
      const chatPanel = document.getElementById("context-workbench-panel-chat")
      expect(chatPanel).not.toBeNull()
      // … but it must not be reachable by pointer, focus or a11y while hidden,
      // or the retained panel would keep answering clicks aimed at the one in
      // front of it.
      expect(chatPanel).toHaveAttribute("aria-hidden", "true")
      expect(chatPanel).toHaveAttribute("inert")
    })
  })

  describe("rail badges", () => {
    it("shows no badge on the inspect group when the workflow is clean and nothing is selected", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 0, warningCount: 0, infoCount: 0 },
      })
      harness(store)
      expect(inspectRailButton()).toHaveTextContent(/^$/)
    })

    it("sums the diagnostics onto the inspect group's badge", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 2, warningCount: 3, infoCount: 0 },
      })
      harness(store)
      // inspector (0 selected) + problems (2 + 3) + settings (0).
      expect(inspectRailButton()).toHaveTextContent("5")
    })

    it("counts the selection alongside the diagnostics", () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        diagnostics: { errorCount: 0, warningCount: 4, infoCount: 0 },
      })
      harness(store)
      act(() => setSelectionCount(store, 1))
      // inspector (1 selected) + problems (0 + 4).
      expect(inspectRailButton()).toHaveTextContent("5")
    })
  })

  describe("problems-panel signal", () => {
    it("reveals the Problems panel and clears the signal when requestedProblemsPanel is set", async () => {
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
      expect(await screen.findByTestId("mock-problems-tab")).toBeInTheDocument()
      expect(clearRequestedProblemsPanel).toHaveBeenCalled()
    })
  })

  describe("inspector-panel signal", () => {
    it("reveals the Inspector over a pinned panel and clears the signal", async () => {
      const user = userEvent.setup()
      const clearRequestedInspectorPanel = jest.fn()
      const store = makeFakeStore({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        baseWorkflow: { id: "wf_a", name: "Demo" },
        clearRequestedInspectorPanel,
      })
      harness(store)

      // Pin Runs manually — a plain selection change would now be swallowed.
      await user.click(screen.getByRole("button", { name: "Runs" }))
      expect(await screen.findByTestId("mock-runs-tab")).toBeInTheDocument()

      // The explicit configure gesture fires the store signal, which outranks
      // the pin.
      act(() => {
        ;(store as unknown as { setState: (s: Partial<FakeState>) => void }).setState({
          selectedNodeIds: ["n1"],
          requestedInspectorPanel: true,
        })
      })
      expect(screen.getByTestId("mock-inspector-panel")).toBeInTheDocument()
      expect(clearRequestedInspectorPanel).toHaveBeenCalled()
    })
  })

  describe("memo", () => {
    it("is wrapped in React.memo so parent re-renders with identical props don't re-run the inner tree", () => {
      // We can't directly observe React's bail-out, but we can confirm the
      // exported component is a memo wrapper by inspecting its type marker.
      // React tags memoized components with $$typeof === Symbol.for('react.memo').
      const memoMarker = Symbol.for("react.memo")
      expect((RightSidebar as { $$typeof?: symbol }).$$typeof).toBe(memoMarker)
    })
  })
})
