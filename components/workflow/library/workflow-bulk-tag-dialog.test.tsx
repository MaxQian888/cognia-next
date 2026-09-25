/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowBulkTagDialog } from "./workflow-bulk-tag-dialog"
import { createWorkflow, getWorkflow } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  useWorkflowLibraryStore.setState({ tagDialogTarget: null, selection: new Set<string>() })
})

describe("WorkflowBulkTagDialog", () => {
  it("adds the tag to every targeted workflow", async () => {
    const a = await createWorkflow({ name: "A" })
    const b = await createWorkflow({ name: "B" })
    useWorkflowLibraryStore.setState({ tagDialogTarget: { ids: [a.id, b.id] } })

    render(<WorkflowBulkTagDialog />)
    fireEvent.change(await screen.findByTestId("workflow-bulk-tag-input"), {
      target: { value: "ops" },
    })
    fireEvent.click(screen.getByTestId("workflow-bulk-tag-submit"))

    await waitFor(async () => {
      expect((await getWorkflow(a.id))?.tags).toContain("ops")
    })
    expect((await getWorkflow(b.id))?.tags).toContain("ops")
    expect(useWorkflowLibraryStore.getState().tagDialogTarget).toBeNull()
  })

  it("applies on Enter, but not on the Enter that confirms an IME candidate", async () => {
    const a = await createWorkflow({ name: "A" })
    useWorkflowLibraryStore.setState({ tagDialogTarget: { ids: [a.id] } })
    render(<WorkflowBulkTagDialog />)
    const input = await screen.findByTestId("workflow-bulk-tag-input")
    fireEvent.change(input, { target: { value: "运维" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    await new Promise((r) => setTimeout(r, 20))
    expect((await getWorkflow(a.id))?.tags ?? []).not.toContain("运维")
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(async () => expect((await getWorkflow(a.id))?.tags).toContain("运维"))
  })
})
