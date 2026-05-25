/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowCreateDialog } from "./workflow-create-dialog"
import { listWorkflowsInFolder } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
})

describe("WorkflowCreateDialog", () => {
  it("creates a workflow in the given parent folder", async () => {
    const onOpenChange = jest.fn()
    render(<WorkflowCreateDialog open onOpenChange={onOpenChange} parentFolderId="wff_x" />)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My flow" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(async () => {
      const inFolder = await listWorkflowsInFolder("wff_x")
      expect(inFolder.map((w) => w.name)).toContain("My flow")
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes on cancel without creating anything", async () => {
    const onOpenChange = jest.fn()
    render(<WorkflowCreateDialog open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
