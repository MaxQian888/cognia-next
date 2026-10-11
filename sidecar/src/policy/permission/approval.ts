import { awaitPending } from "../../shared/pending.ts"
// The approval round-trip both rails share once the ladder says "ask".
//
// The rail emits its own `permission_request` frame; this parks a waiter in
// the session's `pendingApprovals` map under the same request id. The host's
// `permission_response` handler removes the entry and calls `resolve` with the
// renderer's answer. If the turn aborts first, the waiter settles as denied so
// a renderer that never answers cannot hang the tool call.
//
// An unattended run also sets a TTL (`SendOptions.approvalTtlMs`, ADR-0224
// A7). Its host parks the request for a person, and a host that dies while it
// waits can never answer; the TTL settles the waiter as denied instead of
// leaving the turn parked forever. An interactive turn sets none and waits for
// its user as before.

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
  /** Deny the request when no answer arrives within this many ms. */
  ttlMs?: number | undefined
  /** Runs when the TTL fires, before the request settles as denied. */
  onTimeout?: () => void
}

export const ABORTED_ANSWER: Readonly<ApprovalAnswer> = { behavior: "deny", message: "aborted" }

/** What a request that outlived its TTL settles as. The model reads the message. */
export const TIMED_OUT_ANSWER: Readonly<ApprovalAnswer> = {
  behavior: "deny",
  message: "denied: nobody approved this tool call before the approval timed out",
}

/** Park a waiter for one permission request and resolve with the answer. */
export function awaitApproval(request: ApprovalRequest): Promise<ApprovalAnswer> {
  const { pendingApprovals, requestId, entry, signal, onAbort, review, ttlMs, onTimeout } = request
  let abortListener: (() => void) | undefined
  const timed = ttlMs !== undefined && ttlMs > 0
  const promise = awaitPending(pendingApprovals, requestId, {
    extra: entry,
    mapAnswer: review,
    ...(timed
      ? {
          timeoutMs: ttlMs,
          // A parked approval must not keep the process alive on its own.
          ref: false,
          onTimeout: () => {
            onTimeout?.()
            return { ...TIMED_OUT_ANSWER }
          },
        }
      : {}),
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
