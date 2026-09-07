import type { ApprovalDecision, ApprovalRequest, PendingApproval } from "@cognia/agent-config-types"
import { safeToolActivityMetadata, sanitizeActivityLabel } from "@/lib/execution/run-activity"
import type { CollabClient } from "./client"

export interface SharedApprovalBridgeOptions {
  client: Pick<
    CollabClient,
    "createSessionApproval" | "listSessionApprovals" | "resolveSessionApproval"
  >
  orgId: string
  sessionId: string
  runId: string
  isCurrent(): boolean
  verifyExecution(): Promise<void>
  deliver(approval: PendingApproval, decision: "allow" | "deny"): Promise<void>
  now?: () => number
}

interface Entry {
  local: PendingApproval
  remote: Promise<ApprovalRequest>
  consumed: boolean
  notified: boolean
}

/** A server decision authorizes one existing tool waiter; it never restarts a tool. */
export class SharedApprovalBridge {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  constructor(private readonly options: SharedApprovalBridgeOptions) {
    this.now = options.now ?? Date.now
  }

  private assertCurrent(): void {
    if (!this.options.isCurrent()) throw new Error("Shared execution lease is unavailable")
  }

  private ensure(local: PendingApproval): Entry {
    this.assertCurrent()
    const prior = this.entries.get(local.requestId)
    if (prior) return prior
    if (local.status === "interrupted")
      throw new Error("Interrupted tool approval cannot be replayed")
    const metadata = safeToolActivityMetadata(local.toolName, local.input)
    const action = sanitizeActivityLabel(local.title ?? local.displayName, metadata.toolName, 240)
    const entry: Entry = {
      local,
      consumed: false,
      notified: false,
      remote: this.options.client.createSessionApproval(
        this.options.orgId,
        this.options.sessionId,
        {
          runId: this.options.runId,
          action,
          risk:
            metadata.category === "read" || metadata.category === "search" ? "ordinary" : "high",
          expiresAt: this.now() + 10 * 60_000,
          operationId: `tool-approval:${this.options.runId}:${local.requestId}`,
        }
      ),
    }
    this.entries.set(local.requestId, entry)
    // A failed create is retryable with the same server operation identity.
    void entry.remote.catch(() => {
      if (this.entries.get(local.requestId) === entry) this.entries.delete(local.requestId)
    })
    return entry
  }

  async sync(pending: readonly PendingApproval[]): Promise<void> {
    this.assertCurrent()
    const live = pending.filter((approval) => approval.status !== "interrupted")
    await Promise.all(live.map((approval) => this.ensure(approval).remote))
    if (!live.length) return
    this.assertCurrent()
    const resolutions = await this.options.client.listSessionApprovals(
      this.options.orgId,
      this.options.sessionId
    )
    this.assertCurrent()
    for (const local of live) {
      const entry = this.entries.get(local.requestId)!
      if (entry.consumed || entry.notified) continue
      const original = await entry.remote
      const resolution = resolutions.find(
        (row) => row.id === original.id && row.runId === this.options.runId
      )
      if (!resolution) continue
      const expired = resolution.expiresAt <= this.now()
      if (resolution.status === "pending" && !expired) continue
      entry.notified = true
      try {
        await this.options.deliver(
          local,
          resolution.status === "approved" && !expired ? "allow" : "deny"
        )
      } catch (error) {
        // Before consumption no runtime decision was dispatched; after it,
        // delivery may have triggered a side effect and cannot be replayed.
        if (!entry.consumed) entry.notified = false
        throw error
      }
    }
  }

  /** Null means this waiter already received a decision; an uncertain tool is never auto-replayed. */
  async authorize(
    local: PendingApproval,
    decision: ApprovalDecision
  ): Promise<"allow" | "deny" | null> {
    const entry = this.ensure(local)
    if (entry.consumed) return null
    const original = await entry.remote
    this.assertCurrent()
    const rows = await this.options.client.listSessionApprovals(
      this.options.orgId,
      this.options.sessionId
    )
    let resolution = rows.find((row) => row.id === original.id && row.runId === this.options.runId)
    this.assertCurrent()
    if (!resolution) throw new Error("Shared approval is unavailable")
    if (resolution.status === "pending" && resolution.expiresAt > this.now()) {
      resolution = await this.options.client.resolveSessionApproval(
        this.options.orgId,
        this.options.sessionId,
        resolution.id,
        {
          status: decision === "deny" ? "denied" : "approved",
          baseRevision: resolution.revision,
        }
      )
    }
    this.assertCurrent()
    if (entry.consumed) return null
    const allowed =
      decision !== "deny" && resolution.status === "approved" && resolution.expiresAt > this.now()
    if (allowed) await this.options.verifyExecution()
    this.assertCurrent()
    if (entry.consumed) return null
    entry.consumed = true
    return allowed ? "allow" : "deny"
  }
}
