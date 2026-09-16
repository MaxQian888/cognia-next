/**
 * An in-memory ToolRuntime for the offline tests and the labelled mock path.
 *
 * It behaves like the host runtime where it matters: a policy offers a fixed
 * set of read-only tools, anything else is refused with a code, a repeated
 * request with the same canonical arguments returns the stored receipt, and a
 * successful read stores its content as an artifact of the run and returns a
 * content-pinned evidence reference.
 */

import { canonicalHash } from "../util/sha256"
import type {
  ToolContext,
  ToolDescriptor,
  ToolIntent,
  ToolReceipt,
  ToolRuntime,
} from "../workflows/ports"
import type { MemoryArtifactStore } from "./memory-artifacts"

export interface MemoryToolPolicy {
  tools: ToolDescriptor[]
  /** Content a read tool returns, by its arguments; undefined is "nothing found". */
  read: (
    name: string,
    args: Record<string, unknown>
  ) => { locator: string; content: string } | undefined
}

export class MemoryToolRuntime implements ToolRuntime {
  readonly executed: Array<{
    intent: ToolIntent
    context: Omit<ToolContext, "signal">
    receipt: ToolReceipt
  }> = []
  private readonly receipts = new Map<string, ToolReceipt>()

  constructor(
    private readonly store: MemoryArtifactStore,
    private readonly policies: Record<string, MemoryToolPolicy>,
    private readonly retrievedAt = "2026-09-16T00:00:00Z"
  ) {}

  describe(policyId: string): ToolDescriptor[] {
    return this.policies[policyId]?.tools ?? []
  }

  async execute(intent: ToolIntent, context: ToolContext): Promise<ToolReceipt> {
    const operationId = canonicalHash({
      step: context.logicalStepId,
      policy: context.policyId,
      tool: intent.name,
      args: intent.arguments,
    })
    const stored = this.receipts.get(operationId)
    if (stored) return { ...stored, toolCallId: intent.id }
    const policy = this.policies[context.policyId]
    const descriptor = policy?.tools.find((tool) => tool.name === intent.name)
    let receipt: ToolReceipt
    if (!policy || !descriptor) {
      receipt = this.refused(operationId, intent, "TOOL_NOT_OFFERED")
    } else if (descriptor.toolClass !== "read_only") {
      receipt = this.refused(operationId, intent, "WRITE_NOT_PERMITTED")
    } else {
      const found = policy.read(intent.name, intent.arguments)
      if (!found) {
        receipt = {
          operationId,
          toolCallId: intent.id,
          name: intent.name,
          status: "failed",
          evidence: [],
          summary: "nothing found",
        }
      } else {
        const artifact = await this.store.put(
          found.content,
          "text/plain",
          `runs/${context.runId}/evidence`
        )
        receipt = {
          operationId,
          toolCallId: intent.id,
          name: intent.name,
          status: "succeeded",
          evidence: [
            {
              artifact_id: artifact.artifactId,
              content_sha256: artifact.contentSha256,
              locator: found.locator,
              retrieved_at: this.retrievedAt,
            },
          ],
          summary: found.content,
        }
      }
    }
    this.receipts.set(operationId, receipt)
    const { signal: _signal, ...rest } = context
    this.executed.push({ intent, context: rest, receipt })
    return receipt
  }

  private refused(operationId: string, intent: ToolIntent, code: string): ToolReceipt {
    return {
      operationId,
      toolCallId: intent.id,
      name: intent.name,
      status: "refused",
      refusalCode: code,
      evidence: [],
      summary: `refused: ${code}`,
    }
  }
}
