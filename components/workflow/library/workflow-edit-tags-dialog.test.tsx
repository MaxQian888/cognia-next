/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowEditTagsDialog, parseTags } from "./workflow-edit-tags-dialog"
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

describe("parseTags", () => {
  it("trims, drops empties, and de-duplicates", () => {
    expect(parseTags(" ops , ops, , billing ")).toEqual(["ops", "billing"])
    expect(parseTags("")).toEqual([])
  })
})

describe("WorkflowEditTagsDialog", () => {
  it("writes the parsed tags on save", async () => {
    const wf = await createWorkflow({ name: "X", tags: ["old"] })
    const onOpenChange = jest.fn()
    render(<WorkflowEditTagsDialog workflow={wf as WorkflowRow} open onOpenChange={onOpenChange} />)

    const input = await screen.findByTestId("workflow-tags-input")
    expect(input).toHaveValue("old")
    fireEvent.change(input, { target: { value: "ops, billing, ops" } })
    fireEvent.click(screen.getByTestId("workflow-tags-submit"))

    await waitFor(async () => {
      expect((await getWorkflow(wf.id))?.tags).toEqual(["ops", "billing"])
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("saves on Enter, but not on the Enter that confirms an IME candidate", async () => {
    const wf = await createWorkflow({ name: "X", tags: ["old"] })
    render(<WorkflowEditTagsDialog workflow={wf as WorkflowRow} open onOpenChange={jest.fn()} />)
    const input = await screen.findByTestId("workflow-tags-input")
    fireEvent.change(input, { target: { value: "运维" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    await new Promise((r) => setTimeout(r, 20))
    expect((await getWorkflow(wf.id))?.tags).toEqual(["old"])
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(async () => expect((await getWorkflow(wf.id))?.tags).toEqual(["运维"]))
  })
})
