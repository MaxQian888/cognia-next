import { awaitPending } from "../../shared/pending.ts"
// The approval round-trip both rails share once the ladder says "ask".
//
// The rail emits its own `permission_request` frame; this parks a waiter in
// the session's `pendingApprovals` map under the same request id. The host's
// `permission_response` handler removes the entry and calls `resolve` with the
// renderer's answer. If the turn aborts first, the waiter settles as denied so
// a renderer that never answers cannot hang the tool call.

/** The renderer's reply, as the host relays it (unvalidated). */
export interface ApprovalAnswer {
  behavior?: unknown
  message?: unknown
  updatedInput?: unknown
  [field: string]: unknown
}

/** Stored next to the resolver: the input, and whatever else the host needs to answer. */
export interface PendingApprovalEntry {
  /** The original tool input, handed back when the user approves it unmodified. */
  input: unknown
  [field: string]: unknown
}

/** What the host finds under a request id in `pendingApprovals`. */
export interface PendingApproval extends PendingApprovalEntry {
  resolve(answer: ApprovalAnswer): void
}

export interface ApprovalRequest {
  pendingApprovals: Map<string, PendingApproval>
  requestId: string
  entry: PendingApprovalEntry
  signal?: AbortSignal | null | undefined
  /** Runs when the turn aborts while the request waits, before it settles as denied. */
  onAbort?: () => void
  /** Sees every answer before the caller does, and may replace it. */
  review?: (answer: ApprovalAnswer) => ApprovalAnswer
}

export const ABORTED_ANSWER: Readonly<ApprovalAnswer> = { behavior: "deny", message: "aborted" }

/** Park a waiter for one permission request and resolve with the answer. */
export function awaitApproval(request: ApprovalRequest): Promise<ApprovalAnswer> {
  const { pendingApprovals, requestId, entry, signal, onAbort, review } = request
  let abortListener: (() => void) | undefined
  const promise = awaitPending(pendingApprovals, requestId, {
    extra: entry,
    mapAnswer: review,
    onSettled: () => {
      if (abortListener && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortListener)
      }
    },
  })
  if (signal) {
    abortListener = () => {
      const waiter = pendingApprovals.get(requestId)
      if (waiter) {
        pendingApprovals.delete(requestId)
        onAbort?.()
        waiter.resolve({ ...ABORTED_ANSWER })
      }
    }
    if (signal.aborted) abortListener()
    else if (typeof signal.addEventListener === "function")
      signal.addEventListener("abort", abortListener, { once: true })
  }
  return promise
}
