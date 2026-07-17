import { Workflow as WorkflowIcon } from "lucide-react"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"
import { getNodeIcon } from "./node-icons"

describe("node icons", () => {
  it("maps the chained-workflow trigger to the Workflow icon", () => {
    expect(getNodeIcon("trigger.workflow.completed")).toBe(WorkflowIcon)
  })

  it("returns an icon component for every declared node kind (fallback included)", () => {
    for (const kind of WORKFLOW_NODE_KINDS) {
      expect(typeof getNodeIcon(kind)).not.toBe("undefined")
    }
  })
})
