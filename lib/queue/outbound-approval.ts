/**
 * The approval gate for the durable outbound queue.
 *
 * `authorize_approval` (`src-tauri/src/companion_api/remote_execution.rs`)
 * refuses any `approval: "interactive"` command that arrives without a valid
 * `adminLease`. The queue dispatched every job with `transport.call` bare, so
 * from a paired browser or phone each of those answered
 * `interactive_approval_required` and the job retried its way to nothing.
 *
 * `host_state_submit` is one of them, and it is how a chat turn's user message
 * reaches the Host. The visible symptom was a composer that cleared on Enter
 * and then did nothing at all: no turn, no message, no error, because the
 * queue records a delivery failure rather than surfacing one.
 *
 * # Why the lease is minted here and not at enqueue
 *
 * A lease is short-lived and device-bound. The queue is durable and may hold a
 * job across a reload, a network outage, or an overnight sleep, so a token
 * written into the row would be expired by the time anything sent it, and
 * `remote-host-configs.ts` states the same rule for its own writes. Minting at
 * dispatch is the only point where the token's lifetime covers the call.
 *
 * # Why a shell with local authority skips it
 *
 * Same gate the task-workspace and git planes use: no client target means this
 * process IS the host, the command dispatches in-process, and asking it for a
 * lease would fail a call that needs none.
 *
 * # Why this is a gate and not something that happens inside the dispatch
 *
 * Minting used to sit inside the dispatcher, between the queue and
 * `transport.call`. Two things followed from that, and both were wrong.
 *
 * A drain is not a user action. The runner kicks on mount, on a network
 * reconnect, on a runtime-snapshot change and on any pending row, so a job left
 * over from before asked the host for host-admin authority with nobody at the
 * keyboard, which is exactly what `issueHostAdminLease` tells callers not to do.
 *
 * And a host waiting on a human answered `REMOTE_CONSENT_REQUIRED`, which
 * reached the queue as an ordinary delivery failure: attempts incremented, the
 * backoff grew, and the row deadlettered while a person was still being asked.
 * The user's message went quiet again, one layer further down.
 *
 * As a pre-flight the answer is "not yet" instead of "failed". The runner
 * releases the claim and leaves the row pending at its place in the channel, so
 * nothing is spent and nothing is lost, and {@link outboundConsentCode} gives
 * the surfaces something honest to show while the approver decides. One
 * confirmation buys a bounded window covering every interactive queue command,
 * for the same reason `lib/connectors/credential-lease.ts` does it: ten prompts
 * in a row trains people to approve without reading.
 */

import { MOBILE_OUTBOUND_COMMANDS } from "@/lib/db/mobile-outbound-types"
import { HostConsentRequiredError, issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

export interface OutboundApprovalDeps {
  getRuntimeSnapshot?: typeof getRuntimeSnapshot
  getCommandDescriptor?: typeof getCommandDescriptor
  issueAdminLease?: typeof issueHostAdminLease
  getActiveScope?: typeof getActiveRuntimeTargetContext
  now?: () => number
}

const defaults: Required<OutboundApprovalDeps> = {
  getRuntimeSnapshot,
  getCommandDescriptor,
  issueAdminLease: issueHostAdminLease,
  getActiveScope: getActiveRuntimeTargetContext,
  now: () => Date.now(),
}

/** Whether a queued command may go out right now, and under what. */
export type OutboundApprovalState =
  /** This shell has local authority, or the host does not gate this command. */
  | "not-required"
  /** A live lease is installed and will ride along with the dispatch. */
  | "held"
  /** The host is waiting on a human, or refused. The row must stay pending. */
  | "blocked"

/** Renew this far before expiry so a lease cannot lapse mid-drain. */
export const EXPIRY_SKEW_MS = 30_000

/** How long a refusal stops the runner asking again on every kick. */
export const DENIED_COOLDOWN_MS = 30_000

/** Stands in for a pending approval whose host named no code. */
export const PENDING_NO_CODE = "pending"

/**
 * The scope a cached lease belongs to.
 *
 * A lease is bound to one device AND one host. This module cached a single
 * module-global token, so after a target switch the next drain read Host A's
 * live lease as a cache hit and offered it to Host B — a credential minted for
 * one host handed to another, which Host B refuses anyway. The refusal
 * cooldown had the same shape in reverse: Host A saying "not yet" muted the ask
 * for a Host B that had never been asked.
 *
 * Every cached field below is therefore stamped with the runtime scope it was
 * taken under, and the scope IS the account + target + routing generation
 * triple `runtime-target-context` already publishes. A re-pair bumps the
 * generation without changing the ids, which is exactly the case a
 * two-field key would have missed.
 */
let scopeKey: string | null = null
let token: string | null = null
let expiresAt = 0
let deniedUntil = 0
let inFlight: Promise<OutboundApprovalState> | null = null
let consentCode: string | null = null
/**
 * Bumped on every discard. An in-flight request captures it, so a lease that
 * arrives after a scope change or a sign-out is dropped instead of installed
 * against whatever is active by then.
 */
let epoch = 0

/** No scope installed. Its own key, never equal to a real one. */
const UNSCOPED_KEY = "\u0000unscoped"

function scopeKeyOf(deps: Required<OutboundApprovalDeps>): string {
  const scope = deps.getActiveScope()
  if (!scope) return UNSCOPED_KEY
  return `${scope.accountId}\u0000${scope.targetId}\u0000${scope.routingGeneration}`
}

const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A broken subscriber must never break the drain.
    }
  }
}

/**
 * Watch the approval state. Fires whenever a lease is taken, lost, or the host
 * starts or stops waiting on a human, so a banner can re-read
 * {@link outboundConsentCode} and the runner can kick.
 */
export function subscribeOutboundApproval(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * How many surfaces are reporting the pending approval inline right now.
 *
 * A frozen row is only recoverable if somebody is told about it, and the inline
 * surface is the mobile shell's `OfflineBanner`, which no other shell mounts. A
 * paired desktop browser hits the same gate and had nothing on screen at all,
 * so the runner falls back to a toast. This counter is what keeps the two from
 * reporting the same wait twice.
 */
let inlineReporters = 0

/**
 * Declare that this surface shows the pending approval in its own chrome, for
 * as long as the returned function is uncalled. Idempotent on release.
 */
export function registerOutboundApprovalReporter(): () => void {
  inlineReporters += 1
  let released = false
  return () => {
    if (released) return
    released = true
    inlineReporters -= 1
  }
}

/** Whether some surface already reports the wait without a toast. */
export function hasOutboundApprovalReporter(): boolean {
  return inlineReporters > 0
}

/**
 * The code identifying the approval the host is waiting on, or null when it is
 * not waiting on one.
 *
 * {@link PENDING_NO_CODE} stands in for a host that asked for consent without
 * naming a code (one older than ADR-0153), so "an approval is pending" stays
 * distinguishable from "the request was refused outright".
 */
export function outboundConsentCode(): string | null {
  return consentCode
}

/**
 * Drop the cached lease and the refusal cooldown so the next
 * {@link ensureOutboundApproval} asks the host again.
 *
 * Called when an approval is answered out of band, and on sign-out or unpair
 * paths that end this device's standing with the host.
 */
export function clearOutboundApproval(): void {
  discardCache()
  scopeKey = null
  const wasWaiting = consentCode !== null
  consentCode = null
  if (wasWaiting) announce()
}

/** Drop every cached answer and invalidate any request still in flight. */
function discardCache(): void {
  token = null
  expiresAt = 0
  deniedUntil = 0
  inFlight = null
  epoch += 1
}

/**
 * Point the cache at `key`, discarding anything held for a different scope.
 *
 * The discard covers the lease, the refusal cooldown, the pending-consent code
 * AND any request still in flight: all four are answers from a host that is no
 * longer the one being dispatched to.
 */
function alignScope(key: string): void {
  if (scopeKey === key) return
  discardCache()
  scopeKey = key
  const wasWaiting = consentCode !== null
  consentCode = null
  if (wasWaiting) announce()
}

/** Every queued command the host gates behind an interactive approval. */
export function interactiveOutboundCommands(overrides: OutboundApprovalDeps = {}): string[] {
  const deps = { ...defaults, ...overrides }
  return MOBILE_OUTBOUND_COMMANDS.filter(
    (command) => deps.getCommandDescriptor(command)?.approval === "interactive"
  )
}

function requiresApproval(command: string, deps: Required<OutboundApprovalDeps>): boolean {
  if (deps.getCommandDescriptor(command)?.approval !== "interactive") return false
  const target = deps.getRuntimeSnapshot().target
  return target?.kind === "companion"
}

/**
 * Pre-flight one queued row. Safe to call on every drain pass: it is a cache
 * hit while the current lease is live, and a no-op for a command or a shell
 * that needs none.
 *
 * `"blocked"` is a pause, never a failure. The caller must leave the row
 * pending rather than record an attempt against it.
 */
export async function ensureOutboundApproval(
  command: string,
  overrides: OutboundApprovalDeps = {}
): Promise<OutboundApprovalState> {
  const deps = { ...defaults, ...overrides }
  if (!requiresApproval(command, deps)) return "not-required"

  const askedScopeKey = scopeKeyOf(deps)
  alignScope(askedScopeKey)

  const now = deps.now()
  if (token && now < expiresAt - EXPIRY_SKEW_MS) return "held"
  if (now < deniedUntil) return "blocked"
  if (inFlight) return inFlight

  // The scope this ask belongs to. A lease that comes back after the scope
  // moved is an answer from a host nobody is dispatching to any more, so it is
  // dropped rather than installed — otherwise a slow approval on Host A would
  // land as Host B's lease the moment the user switched. Both the epoch and the
  // live scope key are checked: a discard bumps the epoch, but a scope that
  // simply moved while nothing else called in leaves the epoch untouched.
  const askedUnder = epoch
  const stillCurrent = (): boolean => epoch === askedUnder && scopeKeyOf(deps) === askedScopeKey
  inFlight = (async (): Promise<OutboundApprovalState> => {
    try {
      const lease = await deps.issueAdminLease(interactiveOutboundCommands(overrides))
      if (!stillCurrent()) return "blocked"
      // A host that answers with an already-expired window is answering "no"
      // in a shape the cache would otherwise read as "yes, briefly".
      if (!lease?.token || lease.expiresAt <= deps.now()) {
        token = null
        expiresAt = 0
        deniedUntil = deps.now() + DENIED_COOLDOWN_MS
        consentCode = null
        return "blocked"
      }
      token = lease.token
      expiresAt = lease.expiresAt
      deniedUntil = 0
      consentCode = null
      return "held"
    } catch (error) {
      if (!stillCurrent()) return "blocked"
      // Denied, unreachable, or waiting on a human. Only the last is worth
      // telling apart: it is a state that ends by itself, and the code is what
      // an approver needs in order to answer from another device or a console.
      consentCode =
        error instanceof HostConsentRequiredError ? (error.consentCode ?? PENDING_NO_CODE) : null
      token = null
      expiresAt = 0
      deniedUntil = deps.now() + DENIED_COOLDOWN_MS
      return "blocked"
    } finally {
      // Only clear the slot this ask owns: after a discard the field may
      // already hold a newer request taken under the current scope.
      if (epoch === askedUnder) inFlight = null
      announce()
    }
  })()

  return inFlight
}

/**
 * Return the payload this job should actually be sent with.
 *
 * Attaches the lease {@link ensureOutboundApproval} already took. It never
 * mints one: a drain that reaches dispatch has passed the gate, and minting
 * here would put the background request back exactly where it was.
 *
 * Unchanged for every command the host does not gate, so a new queued command
 * cannot pay for a lease it has no use for.
 */
export function withOutboundApproval(
  command: string,
  payload: Record<string, unknown> | undefined,
  overrides: OutboundApprovalDeps = {}
): Record<string, unknown> | undefined {
  const deps = { ...defaults, ...overrides }
  if (!requiresApproval(command, deps)) return payload
  // A token minted for another host is worse than no token: the dispatch is
  // refused either way, and attaching it hands one host a credential issued by
  // another. The scope can move between the pre-flight and the dispatch, so
  // this is checked here and not only in {@link ensureOutboundApproval}.
  if (!token || scopeKeyOf(deps) !== scopeKey) return payload
  return { ...(payload ?? {}), adminLease: token }
}

/** Test seam: reset module state without asserting on the transport. */
export function __resetOutboundApprovalForTests(): void {
  listeners.clear()
  inlineReporters = 0
  clearOutboundApproval()
}
