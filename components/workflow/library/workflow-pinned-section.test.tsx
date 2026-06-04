/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import type { WorkflowRow } from "@/types/workflow/visual"

jest.mock("./workflow-card", () => ({
  WorkflowCard: ({ workflow }: { workflow: WorkflowRow }) => (
    <div data-testid={`pinned-card-${workflow.id}`}>{workflow.name}</div>
  ),
}))
jest.mock("./workflow-row", () => ({
  WorkflowRow: ({ workflow }: { workflow: WorkflowRow }) => (
    <div data-testid={`pinned-row-${workflow.id}`}>{workflow.name}</div>
  ),
}))

import { WorkflowPinnedSection } from "./workflow-pinned-section"
import { createWorkflow } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  useSettingsStore.setState({ settings: { pinnedWorkflowIds: [] } as never })
  useWorkflowLibraryStore.setState({ viewMode: "grid" })
})

describe("WorkflowPinnedSection", () => {
  it("renders nothing when there are no pins", () => {
    const { container } = render(<WorkflowPinnedSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders without looping when settings lack pinnedWorkflowIds entirely", () => {
    // Regression: the selector used to default to a fresh `[]` per snapshot,
    // which useSyncExternalStore treats as a changed store value — infinite
    // re-render ("Maximum update depth exceeded") crashing /workflows.
    useSettingsStore.setState({ settings: {} as never })
    const { container } = render(<WorkflowPinnedSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders pinned workflows as cards in grid mode", async () => {
    const wf = await createWorkflow({ name: "Pinned one" })
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: [wf.id] } as never })
    render(<WorkflowPinnedSection />)
    expect(await screen.findByTestId(`pinned-card-${wf.id}`)).toBeInTheDocument()
  })

  it("renders pinned workflows as rows in list mode", async () => {
    const wf = await createWorkflow({ name: "Pinned one" })
    useSettingsStore.setState({ settings: { pinnedWorkflowIds: [wf.id] } as never })
    useWorkflowLibraryStore.setState({ viewMode: "list" })
    render(<WorkflowPinnedSection />)
    await waitFor(() => {
      expect(screen.getByTestId(`pinned-row-${wf.id}`)).toBeInTheDocument()
    })
  })
})
