/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowDeleteDialog } from "./workflow-delete-dialog"
import { createWorkflow, getWorkflow } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  useWorkflowLibraryStore.setState({
    deleteDialogTarget: null,
    selection: new Set<string>(),
  })
})

describe("WorkflowDeleteDialog", () => {
  it("deletes the targeted workflows and clears the dialog", async () => {
    const a = await createWorkflow({ name: "A" })
    const b = await createWorkflow({ name: "B" })
    useWorkflowLibraryStore.setState({ deleteDialogTarget: { ids: [a.id, b.id] } })

    render(<WorkflowDeleteDialog />)
    fireEvent.click(await screen.findByTestId("workflow-delete-confirm"))

    await waitFor(async () => {
      expect(await getWorkflow(a.id)).toBeUndefined()
    })
    expect(await getWorkflow(b.id)).toBeUndefined()
    expect(useWorkflowLibraryStore.getState().deleteDialogTarget).toBeNull()
  })

  it("skips built-in workflows", async () => {
    const a = await createWorkflow({ name: "A" })
    const builtIn = await createWorkflow({ name: "Builtin" })
    await getDb().workflows.update(builtIn.id, { isBuiltIn: true })
    useWorkflowLibraryStore.setState({ deleteDialogTarget: { ids: [a.id, builtIn.id] } })

    render(<WorkflowDeleteDialog />)
    fireEvent.click(await screen.findByTestId("workflow-delete-confirm"))

    await waitFor(async () => {
      expect(await getWorkflow(a.id)).toBeUndefined()
    })
    // Built-in survives.
    expect(await getWorkflow(builtIn.id)).toBeDefined()
  })
})
