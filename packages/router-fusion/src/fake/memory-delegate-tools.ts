/**
 * The worker's tool runtime for policy `delegate-work-1`, in memory, over a
 * {@link MemoryWorkspace} — for the offline delegate tests and the labelled
 * mock path. Like the host runtime:
 *
 * - a policy offers a fixed set of tools; anything else is refused with a code;
 * - arguments are validated; a repeat with the same canonical arguments at the
 *   same step and revision returns the stored receipt;
 * - a read returns content pinned by an evidence artifact; a refused path is
 *   refused, never read;
 * - `propose_patch` writes nothing: it authorizes the path under the
 *   workspace's rules, checks it is inside the context's write scope, and
 *   records the proposal.
 */

import { canonicalHash } from "../util/sha256"
import {
  DELEGATE_TOOL_NAMES,
  DELEGATE_WORK_POLICY,
  DELEGATE_WORK_TOOLS,
  DelegateToolArgs,
  normalizeDelegatePath,
  pathInScope,
  type DelegateToolContext,
  type DelegateToolRuntime,
} from "../workflows/delegate-ports"
import type { ToolDescriptor, ToolIntent, ToolReceipt } from "../workflows/ports"
import type { MemoryArtifactStore } from "./memory-artifacts"
import type { MemoryWorkspace } from "./memory-workspace"

export interface MemoryDelegateToolOptions {
  /** Tool names the policy does not offer (e.g. no `propose_patch`). */
  omit?: string[]
  /** Extra descriptors the policy offers, to prove the workflow ignores them. */
  extra?: ToolDescriptor[]
  retrievedAt?: string
  readMaxBytes?: number
  listLimit?: number
}

export class MemoryDelegateToolRuntime implements DelegateToolRuntime {
  readonly executed: Array<{
    intent: ToolIntent
    context: Omit<DelegateToolContext, "signal">
    receipt: ToolReceipt
  }> = []
  private readonly receipts = new Map<string, ToolReceipt>()

  constructor(
    private readonly workspace: MemoryWorkspace,
    private readonly store: MemoryArtifactStore,
    private readonly options: MemoryDelegateToolOptions = {}
  ) {}

  describe(policyId: string): ToolDescriptor[] {
    if (policyId !== DELEGATE_WORK_POLICY) return []
    const omit = new Set(this.options.omit ?? [])
    return [
      ...DELEGATE_WORK_TOOLS.filter((tool) => !omit.has(tool.name)),
      ...(this.options.extra ?? []),
    ]
  }

  async execute(intent: ToolIntent, context: DelegateToolContext): Promise<ToolReceipt> {
    const operationId = canonicalHash({
      step: context.logicalStepId,
      policy: context.policyId,
      tool: intent.name,
      args: intent.arguments,
      revision: context.revision,
    })
    const stored = this.receipts.get(operationId)
    if (stored) return { ...stored, toolCallId: intent.id }
    const receipt = await this.run(operationId, intent, context)
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

  private async run(
    operationId: string,
    intent: ToolIntent,
    context: DelegateToolContext
  ): Promise<ToolReceipt> {
    const offered = this.describe(context.policyId).find((tool) => tool.name === intent.name)
    if (!offered) return this.refused(operationId, intent, "TOOL_NOT_OFFERED")
    if (offered.toolClass === "external_write") {
      return this.refused(operationId, intent, "WRITE_NOT_PERMITTED")
    }
    switch (intent.name) {
      case DELEGATE_TOOL_NAMES.read: {
        const args = DelegateToolArgs.workspace_read.safeParse(intent.arguments)
        if (!args.success) return this.refused(operationId, intent, "INVALID_ARGUMENTS")
        const read = await this.workspace.readFile({
          path: args.data.path,
          revision: context.revision,
          maxBytes: this.options.readMaxBytes ?? 64_000,
        })
        if (!read.ok) {
          return read.code === "NOT_FOUND" || read.code === "REVISION_UNKNOWN"
            ? {
                operationId,
                toolCallId: intent.id,
                name: intent.name,
                status: "failed",
                evidence: [],
                summary: `${read.code}: ${read.message}`,
              }
            : this.refused(operationId, intent, read.code)
        }
        const artifact = await this.store.put(
          read.content,
          "text/plain",
          `runs/${context.runId}/evidence`
        )
        return {
          operationId,
          toolCallId: intent.id,
          name: intent.name,
          status: "succeeded",
          evidence: [
            {
              artifact_id: artifact.artifactId,
              content_sha256: artifact.contentSha256,
              locator: `workspace:${context.revision}:${args.data.path}`,
              retrieved_at: this.options.retrievedAt ?? "2026-09-19T00:00:00Z",
            },
          ],
          summary: read.truncated ? `${read.content}\n… (truncated)` : read.content,
        }
      }
      case DELEGATE_TOOL_NAMES.list: {
        const args = DelegateToolArgs.workspace_list.safeParse(intent.arguments)
        if (!args.success) return this.refused(operationId, intent, "INVALID_ARGUMENTS")
        const listed = await this.workspace.listFiles({
          prefix: args.data.prefix,
          revision: context.revision,
          limit: this.options.listLimit ?? 200,
        })
        if (!listed.ok) return this.refused(operationId, intent, listed.code)
        return {
          operationId,
          toolCallId: intent.id,
          name: intent.name,
          status: "succeeded",
          evidence: [],
          summary:
            listed.files.map((file) => file.path).join("\n") +
            (listed.truncated ? "\n… (more files)" : ""),
        }
      }
      case DELEGATE_TOOL_NAMES.proposePatch: {
        const args = DelegateToolArgs.propose_patch.safeParse(intent.arguments)
        if (!args.success) return this.refused(operationId, intent, "INVALID_ARGUMENTS")
        const normalized = normalizeDelegatePath(args.data.path)
        if (!normalized.ok) return this.refused(operationId, intent, normalized.code)
        const probe = await this.workspace.readFile({
          path: normalized.path,
          revision: context.revision,
          maxBytes: 1,
        })
        if (!probe.ok && probe.code !== "NOT_FOUND" && probe.code !== "CONTENT_SENSITIVE") {
          return this.refused(operationId, intent, probe.code)
        }
        if (!pathInScope(normalized.path, context.allowedPaths)) {
          return this.refused(operationId, intent, "PATH_OUT_OF_SCOPE")
        }
        const bytes =
          args.data.action === "write" ? new TextEncoder().encode(args.data.content).byteLength : 0
        return {
          operationId,
          toolCallId: intent.id,
          name: intent.name,
          status: "succeeded",
          evidence: [],
          summary:
            args.data.action === "write"
              ? `proposed: write ${normalized.path} (${bytes} bytes)`
              : `proposed: delete ${normalized.path}`,
        }
      }
      default:
        return this.refused(operationId, intent, "TOOL_NOT_IMPLEMENTED")
    }
  }
}
