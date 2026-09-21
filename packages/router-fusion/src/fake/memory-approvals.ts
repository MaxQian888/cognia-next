/**
 * An in-memory ApprovalPort for the offline delegate tests and the labelled
 * mock path. Decisions are keyed by the request digest, like the host's:
 * asking again returns what was decided, and a person's decision (`decide`)
 * is the only thing that changes one. A policy function stands in for a person
 * who answers at once; without one every request waits.
 */

import type {
  ApprovalPort,
  DelegateApprovalDecision,
  DelegateApprovalRequest,
} from "../workflows/delegate-ports"

type DecisionStatus = DelegateApprovalDecision["status"]

export class MemoryApprovalPort implements ApprovalPort {
  readonly requests: DelegateApprovalRequest[] = []
  private readonly decisions = new Map<
    string,
    { status: DecisionStatus; approvalId: string; reason: string | null }
  >()
  private seq = 0

  constructor(
    private readonly policy: (
      request: DelegateApprovalRequest
    ) => DecisionStatus | undefined = () => undefined
  ) {}

  async requestApproval(request: DelegateApprovalRequest): Promise<DelegateApprovalDecision> {
    this.requests.push(request)
    let decision = this.decisions.get(request.requestDigest)
    if (!decision) {
      decision = {
        status: this.policy(request) ?? "waiting",
        approvalId: `00000000-0000-4000-9000-${(++this.seq).toString(16).padStart(12, "0")}`,
        reason: null,
      }
      this.decisions.set(request.requestDigest, decision)
    }
    return decision.status === "denied"
      ? {
          status: "denied",
          approvalId: decision.approvalId,
          requestDigest: request.requestDigest,
          reason: decision.reason,
        }
      : {
          status: decision.status,
          approvalId: decision.approvalId,
          requestDigest: request.requestDigest,
        }
  }

  /** A person decides a waiting request. Only a recorded digest can be decided. */
  decide(requestDigest: string, status: "approved" | "denied", reason: string | null = null): void {
    const decision = this.decisions.get(requestDigest)
    if (!decision) throw new Error(`no approval request ${requestDigest}`)
    if (decision.status !== "waiting")
      throw new Error(`request ${requestDigest} is already ${decision.status}`)
    decision.status = status
    decision.reason = reason
  }

  statusOf(requestDigest: string): DecisionStatus | null {
    return this.decisions.get(requestDigest)?.status ?? null
  }
}
