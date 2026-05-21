/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { create } from "zustand"
import { temporal } from "zundo"
import type { EditorStore } from "@/lib/workflow/editor/store"

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
jest.mock("../inspector-panel", () => ({
  InspectorPanel: () => <div data-testid="mock-inspector-panel" />,
}))

// Mock useWorkflowEditorSession (referenced transitively through any chat
// surface) so the chat-tab mock doesn't pull in chat plumbing.
jest.mock("@/hooks/chat/use-workflow-editor-session", () => ({
  useWorkflowEditorSession: () => ({ session: null, loading: false }),
}))

// Imported after the mocks so the real module resolves them.
import { RightSidebar } from "./index"

const MESSAGES = {
  workflowEditor: {
    rightSidebar: {
      tabs: {
        chat: "Chat",
        inspector: "Inspector",
        templates: "Templates",
        changelog: "Changelog",
      },
      chatLoading: "Loading…",
    },
  },
}

interface FakeState {
  selectedNodeIds: string[]
  baseWorkflow: { id: string; name: string }
}

function makeFakeStore(initial: FakeState): EditorStore {
  // Build a minimal real Zustand store with zundo so the production
  // `useShallow` selector path is exercised verbatim.
  const useStore = create<FakeState>()(
    temporal(() => initial, { limit: 1 })
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

function harness(useStore: EditorStore) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never} timeZone="UTC">
      <RightSidebar useStore={useStore} />
    </NextIntlClientProvider>
  )
}

describe("RightSidebar", () => {
  describe("tab auto-switch (0 → ≥1 edge trigger)", () => {
    it("starts on Chat when selection is empty", async () => {
      const store = makeFakeStore({
        selectedNodeIds: [],
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
