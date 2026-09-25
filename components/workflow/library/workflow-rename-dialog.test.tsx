/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowRenameDialog } from "./workflow-rename-dialog"
import { createWorkflow, getWorkflow } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { WorkflowRow } from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
})

describe("WorkflowRenameDialog", () => {
  it("renames the workflow on save", async () => {
    const wf = await createWorkflow({ name: "Old name" })
    const onOpenChange = jest.fn()
    render(<WorkflowRenameDialog workflow={wf as WorkflowRow} open onOpenChange={onOpenChange} />)

    const input = await screen.findByTestId("workflow-rename-input")
    expect(input).toHaveValue("Old name")
    fireEvent.change(input, { target: { value: "Fresh name" } })
    fireEvent.click(screen.getByTestId("workflow-rename-submit"))

    await waitFor(async () => {
      expect((await getWorkflow(wf.id))?.name).toBe("Fresh name")
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("saves on Enter, but not on the Enter that confirms an IME candidate", async () => {
    const wf = await createWorkflow({ name: "Old name" })
    render(<WorkflowRenameDialog workflow={wf as WorkflowRow} open onOpenChange={jest.fn()} />)
    const input = await screen.findByTestId("workflow-rename-input")
    fireEvent.change(input, { target: { value: "新名字" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    await new Promise((r) => setTimeout(r, 20))
    expect((await getWorkflow(wf.id))?.name).toBe("Old name")
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(async () => expect((await getWorkflow(wf.id))?.name).toBe("新名字"))
  })

  it("does not render its body when closed", async () => {
    const wf = await createWorkflow({ name: "X" })
    render(
      <WorkflowRenameDialog workflow={wf as WorkflowRow} open={false} onOpenChange={jest.fn()} />
    )
    expect(screen.queryByTestId("workflow-rename-input")).not.toBeInTheDocument()
  })
})
