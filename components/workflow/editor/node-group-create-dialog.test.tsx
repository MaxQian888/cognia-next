/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { DEFAULT_WORKFLOW_SETTINGS } from "@/types/workflow/visual"

const createNodeGroupFromSelection = jest.fn()
jest.mock("@/lib/workflow/node-groups/authoring", () => ({
  inferNodeGroupSelection: () => ({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [],
    interface: {
      inputs: [{ id: "input:a", label: "payload", required: true }],
      outputs: [{ id: "output:b", label: "result", required: false }],
    },
  }),
  createNodeGroupFromSelection: (...args: unknown[]) => createNodeGroupFromSelection(...args),
}))

import { NodeGroupCreateDialog } from "./node-group-create-dialog"

const store = createEditorStore({
  id: "wf_1",
  name: "Workflow",
  nodes: [],
  edges: [],
  settings: DEFAULT_WORKFLOW_SETTINGS,
  createdAt: 1,
  updatedAt: 1,
})

beforeEach(() => createNodeGroupFromSelection.mockReset())

it("shows the inferred boundary and saves only after explicit confirmation", async () => {
  createNodeGroupFromSelection.mockResolvedValue({ id: "review-chain", version: "1.0.0" })
  const onOpenChange = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <NodeGroupCreateDialog
        open
        onOpenChange={onOpenChange}
        store={store}
        selectedNodeIds={["a", "b"]}
      />
    </NextIntlClientProvider>
  )

  expect(screen.getByTestId("node-group-interface")).toHaveTextContent("payload · Required")
  expect(screen.getByTestId("node-group-interface")).toHaveTextContent("result")
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Review chain" } })
  fireEvent.change(screen.getByLabelText("Distribution"), { target: { value: "workspace" } })
  fireEvent.click(screen.getByRole("button", { name: "Create Node Group" }))

  await waitFor(() =>
    expect(createNodeGroupFromSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedNodeIds: ["a", "b"],
        name: "Review chain",
        version: "1.0.0",
        scope: "workspace",
      })
    )
  )
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
