import "./index"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

const PATTERN_KINDS: WorkflowNodeKind[] = [
  "pattern.multi-modal-sweep",
  "pattern.loop-until-dry",
  "pattern.adversarial-verify",
  "pattern.judge-panel",
  "pattern.completeness-critic",
  "pattern.synthesize",
]

describe("ultracode pattern registration", () => {
  it.each(PATTERN_KINDS)("registers %s as a non-retryable v1 executor", (kind) => {
    const reg = getExecutor(kind, 1)
    expect(reg).toBeDefined()
    expect(reg?.retryable).toBe(false)
    expect(typeof reg?.execute).toBe("function")
  })
})
